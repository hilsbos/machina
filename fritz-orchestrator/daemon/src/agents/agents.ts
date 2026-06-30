import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import * as registry from '../core/registry.js';
import * as github from '../github/github.js';
import * as lifecycle from '../core/lifecycle.js';
import * as agentComms from './agent-comms.js';
import { trackAgentMessage } from '../telegram/message-tracker.js';
import { bootAgent } from './boot.js';
import { parseAgentSession, formatSessionForTelegram } from './session-parser.js';
import { archiveAgentLogs, getArchivedLog, stripBuildArtifacts } from './log-archive.js';
import { AGENT_IMAGE_VARIANTS } from '../types.js';
import type { BootOptions, AgentRole, AgentImageVariant } from '../types.js';
import { getRoleTtl, getRoleModel, getDefaultChatTtl, getMaxParallelAgents, getDaemonConfig, getTeamsConfig } from './fritz-config.js';
import { refreshIssuesCache } from '../github/github-graphql.js';
import { clearFocus } from './focus.js';
import { parseClaudeVersion } from './version-utils.js';
import { logEvent } from '../core/event-log.js';

// ============================================================================
// CONSTANTS
// ============================================================================

// Prefix for all agent container names (e.g., fritz-agent-implement-42)
const AGENT_CONTAINER_PREFIX = 'fritz-agent-';

// Environment variable names whose values must be redacted in log output
const SECRET_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'FRITZ_API_TOKEN',
];

/**
 * Redact secret environment variable values from a docker command string.
 * Replaces `-e VAR=value` with `-e VAR=***` for any variable in SECRET_ENV_VARS.
 */
export function redactDockerCmd(cmd: string): string {
  let redacted = cmd;
  for (const varName of SECRET_ENV_VARS) {
    // Match -e VAR=<value> where value continues until the next whitespace or end of string
    const pattern = new RegExp(`(-e ${varName}=)\\S+`, 'g');
    redacted = redacted.replace(pattern, '$1***');
  }
  return redacted;
}

// Track issue numbers currently being booted (claimed on GitHub but not yet
// registered in local registry). The watchdog checks this to avoid false
// orphan detection during the boot window (claim → clone → register).
const pendingClaims = new Set<number>();

/** Check if an issue is currently being booted (claimed but not yet registered). */
export function isBootInProgress(issue: number): boolean {
  return pendingClaims.has(issue);
}

// Track agent names currently being stopped by stopAgentDocker. The exit
// watcher callback checks this to bail out instead of double-processing
// (replaces the old early-deregistration guard for issue #252).
const stoppingAgents = new Set<string>();

// ============================================================================
// IMAGE SELECTION: Choose the right agent image based on issue labels
// ============================================================================

// Map GitHub issue labels to image variants
// To add a new variant: just add the label mapping here
// Uses fritz.lang: prefix (daemon-owned labels use fritz.* prefix)
export const LANG_PREFIX = 'fritz.lang:';
export const LABEL_TO_VARIANT: Record<string, AgentImageVariant> = {
  [`${LANG_PREFIX}java`]: 'java',
  [`${LANG_PREFIX}cpp`]: 'cpp',
  [`${LANG_PREFIX}kali`]: 'kali',
  [`${LANG_PREFIX}rust`]: 'rust',
};

// Derive image name from variant (uses DOCKER_IMAGE config)
// base → fritz-agent, java → fritz-agent-java, cpp → fritz-agent-cpp
function getImageName(variant: AgentImageVariant): string {
  return variant === 'base'
    ? config.dockerImage
    : `${config.dockerImage}-${variant}`;
}

// Derive Dockerfile name from variant
// base → Dockerfile.agent, java → Dockerfile.agent.java
function getDockerfileName(variant: AgentImageVariant): string {
  return variant === 'base'
    ? 'Dockerfile.agent'
    : `Dockerfile.agent.${variant}`;
}

// Find variant from image name (reverse lookup)
function getVariantFromImageName(imageName: string): AgentImageVariant | undefined {
  return AGENT_IMAGE_VARIANTS.find(v => getImageName(v) === imageName);
}

// Determine language variant string for an agent (null = base/no language override)
function getLangVariant(options: BootOptions): string | null {
  if (options.imageVariant && options.imageVariant !== 'base') {
    return options.imageVariant;
  }
  if (options.issue) {
    const labels = github.getIssueLabels(options.issue);
    const langLabel = labels.find(l => l in LABEL_TO_VARIANT);
    if (langLabel) return langLabel.replace(LANG_PREFIX, '');
  }
  return null;
}

// Determine which Docker image to use for an agent
function selectAgentImage(options: BootOptions): string {
  // Explicit variant override from boot options
  if (options.imageVariant) {
    const image = getImageName(options.imageVariant);
    console.log(`   Image selected via boot option: ${image}`);
    return image;
  }

  // Check issue labels for language hints
  if (options.issue) {
    const labels = github.getIssueLabels(options.issue);
    const langLabels = labels.filter(l => l in LABEL_TO_VARIANT);

    if (langLabels.length > 1) {
      console.warn(`   ⚠ Multiple language labels found: ${langLabels.join(', ')}. Using first: ${langLabels[0]}`);
    }

    if (langLabels.length > 0) {
      const variant = LABEL_TO_VARIANT[langLabels[0]];
      const image = getImageName(variant);
      console.log(`   Image selected via label "${langLabels[0]}": ${image}`);
      return image;
    }
  }

  // Default: use base image
  const image = getImageName('base');
  console.log(`   Image selected: ${image} (default)`);
  return image;
}

// ============================================================================
// DOCKER MODE: Spawn agents as Docker containers
// ============================================================================

// Track active exit watchers for Docker containers
const dockerExitWatchers: Map<string, ChildProcess> = new Map();

// Watch for container exit and cleanup immediately
function watchContainerExit(name: string, containerName: string): void {
  const agent = registry.getAgent(name);
  if (!agent) return;

  console.log(`👁️ [docker] Watching for ${containerName} exit`);

  // Use 'docker wait' which blocks until container stops
  const watcher = spawn('docker', ['wait', containerName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  dockerExitWatchers.set(name, watcher);

  watcher.stdout?.on('data', async (data: Buffer) => {
    const exitCode = parseInt(data.toString().trim(), 10);
    console.log(`📦 [docker] Container ${containerName} exited with code ${exitCode}`);

    // If stopAgentDocker is handling this agent, bail out to prevent duplicate
    // lifecycle notifications from this already-queued callback. See issue #252.
    if (stoppingAgents.has(name)) {
      console.log(`   Agent ${name} being stopped by daemon, skipping exit handler`);
      return;
    }

    // Get container logs to see what happened
    try {
      const logs = execSync(`docker logs ${containerName} 2>&1 | tail -100`, { encoding: 'utf-8' });
      console.log(`   Container logs (last 100 lines):`);
      console.log(logs.split('\n').map(l => `     ${l}`).join('\n'));
    } catch (err) {
      console.error(`   Could not retrieve container logs: ${err}`);
    }

    // Get fresh agent data (might have been updated)
    const currentAgent = registry.getAgent(name);
    if (!currentAgent) {
      console.log(`   Agent ${name} already cleaned up`);
      return;
    }

    // Determine status based on exit code
    const status = exitCode === 0 ? 'completed' : 'dead';

    // Parse session and detect teammate spawning (post-hoc via session logs)
    let teammateCount: number | undefined;
    let session = null;
    try {
      session = parseAgentSession(currentAgent.workspace);
      if (session && session.subagentCount > 0) {
        teammateCount = session.subagentCount;
        console.log(`   🤝 Agent spawned ${teammateCount} teammate(s)`);
      }
    } catch {
      // Non-fatal — teammate count is best-effort
    }

    // Archive logs before deregistration (persistent storage for completed agents)
    await archiveAgentLogs(
      currentAgent,
      status,
      exitCode,
      status === 'dead' ? `Exit code: ${exitCode}` : null,
      session,
    );

    // Strip build artifacts (target/, node_modules/, etc.) to reclaim disk space
    await stripBuildArtifacts(currentAgent.workspace);

    // Update GitHub labels immediately
    if (currentAgent.issue && currentAgent.repo) {
      console.log(`   Updating GitHub labels for #${currentAgent.issue}`);
      try {
        await github.releaseAgent(
          currentAgent.issue,
          name,
          currentAgent.role,
          status,
          undefined, // outcome
          currentAgent.invocationMode,
          teammateCount
        );
      } catch (err) {
        console.error(`   Failed to update GitHub:`, err);
      }
    }

    // Notify via Telegram
    if (status === 'completed') {
      await lifecycle.completed(name, undefined, teammateCount);
    } else {
      await lifecycle.failed(name, `Exit code: ${exitCode}`);
    }

    // Clean up agent communication state
    agentComms.destroyAgent(name);

    // Clear focus mode for this agent
    clearFocus(name);

    // Set exit info so SSE events include exitCode/exitStatus (even without archive)
    registry.updateExitInfo(name, exitCode, status);

    // Remove from local registry
    registry.deregisterAgent(name);
    dockerExitWatchers.delete(name);
  });

  watcher.on('error', (err) => {
    console.error(`   Watcher error for ${containerName}:`, err.message);
    dockerExitWatchers.delete(name);
  });

  watcher.on('close', () => {
    dockerExitWatchers.delete(name);
  });
}

async function startAgentDocker(options: BootOptions): Promise<string> {
  // Enforce maxParallelAgents limit
  const maxParallel = getMaxParallelAgents();
  const activeCount = registry.listAgents().length;
  if (activeCount >= maxParallel) {
    if (options.force === true) {
      console.warn(`[WARN] Force-boot requested — bypassing maxParallelAgents limit (current: ${activeCount}/limit: ${maxParallel})`);
    } else {
      throw new Error(
        `Max parallel agents reached (${activeCount}/${maxParallel}). ` +
        `Wait for an agent to finish or increase daemon.maxParallelAgents in fritz.yaml.`
      );
    }
  }

  // Compute agent name + TTL upfront (needed for claim before boot)
  // Timestamp suffix ensures unique names across rework cycles and manual retries
  const timestampSuffix = Date.now().toString(16).slice(-4); // Last 4 hex chars of timestamp
  const descriptor = options.issue ? String(options.issue) : (options.retroCommand?.split(/\s+/)[0] || undefined);
  const agentName = options.name || (descriptor
    ? `${options.role}-${descriptor}-${timestampSuffix}`
    : `${options.role}-${timestampSuffix}`);
  const mode = options.mode || 'auto';
  // Chat-mode agents get an extended TTL by default so interactive sessions
  // aren't killed mid-conversation. Explicit options.ttl always wins.
  let ttl = options.ttl ?? (mode === 'chat' ? getDefaultChatTtl() : getRoleTtl(options.role));
  const model = getRoleModel(options.role);

  // Detect fritz.long-running label before claim so the "Agent Started" comment
  // shows the correct TTL (♾️ unlimited) instead of the role's default.
  if (options.issue && ttl !== 0) {
    const labels = github.getIssueLabels(options.issue);
    if (labels.includes('fritz.long-running')) {
      ttl = 0;
      console.log(`   ⏳ Long-running mode detected (pre-claim): TTL disabled`);
    }
  }

  // Apply TTL multiplier for all agents (before claim so GitHub shows correct TTL)
  const teamsConfig = getTeamsConfig();
  if (teamsConfig.ttlMultiplier !== 1.0 && ttl > 0) {
    ttl = Math.round(ttl * teamsConfig.ttlMultiplier);
    console.log(`   ⏳ TTL multiplier applied: ${teamsConfig.ttlMultiplier}x → ${ttl}s`);
  }

  // Phase 1: Claim on GitHub FIRST (fast — just two gh calls)
  let claim: { previousStatus?: string } | null = null;
  if (options.issue && config.githubRepo) {
    claim = await github.claimIssue(options.issue, options.role, agentName, Math.round(ttl / 60), model);
    if (!claim) {
      throw new Error(`Issue #${options.issue} already has an active agent`);
    }
    // Mark issue as pending so the watchdog doesn't treat it as orphaned
    // during the boot window (clone, image pull, etc.)
    pendingClaims.add(options.issue);
  }

  try {
    // Phase 2: Boot and start (slow — may fail)

    // Select the appropriate Docker image based on labels/options
    const agentImage = selectAgentImage(options);
    const langVariant = getLangVariant(options);

    // Boot (prepare workspace) — pass pre-computed name and TTL so they match the claim.
    // TTL may have been overridden to 0 by fritz.long-running detection above.
    const { name, workspace, role, issue, repo, branch, ttl: _agentTtl, bootContext, apiToken } =
      await bootAgent({ ...options, name: agentName, ttl });

    // Store lang on the agent for history/dashboard display
    if (langVariant) registry.updateLang(name, langVariant);

    const containerName = `${AGENT_CONTAINER_PREFIX}${name}`;

    // Stop existing container if any
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
    } catch {
      // Container didn't exist, that's fine
    }

    console.log(`🐳 [docker] Starting container: ${containerName}`);
    console.log(`   Using image: ${agentImage}`);
    console.log(`   Workspace: ${workspace}`);

    // Check if image exists locally, auto-pull from ghcr.io if not
    try {
      execSync(`docker image inspect ${agentImage}`, { stdio: 'pipe' });
      console.log(`   ✓ Image ${agentImage} found`);
    } catch {
      // Image not found locally - try pulling from registry
      const ghcrImage = `${config.ghcrRegistry}/${agentImage}:latest`;
      console.log(`   ⚠ Image ${agentImage} not found locally`);
      console.log(`   📦 Pulling from ${ghcrImage}...`);
      try {
        execSync(`docker pull ${ghcrImage}`, { stdio: 'inherit' });
        execSync(`docker tag ${ghcrImage} ${agentImage}`, { stdio: 'pipe' });
        console.log(`   ✓ Pulled and tagged ${agentImage}`);
      } catch {
        // Pull failed - show helpful error with build instructions
        const variant = getVariantFromImageName(agentImage);
        console.error(`   ✗ Failed to pull ${ghcrImage}`);
        if (variant) {
          const dockerfile = getDockerfileName(variant);
          console.error(`   Build locally: docker build -t ${agentImage} -f ${dockerfile} .`);
        }
        throw new Error(`Docker image ${agentImage} not found and pull from ${ghcrImage} failed`);
      }
    }

    // Start container
    const args = [
      'run',
      '-d',
      '--name',
      containerName,
    ];

    // Pass authentication
    if (config.claudeOauthToken) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`);
      console.log(`   ✓ CLAUDE_CODE_OAUTH_TOKEN will be passed to container`);
    }

    if (config.anthropicApiKey) {
      args.push('-e', `ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
      console.log(`   ✓ ANTHROPIC_API_KEY will be passed to container`);
    }

    if (!config.claudeOauthToken && !config.anthropicApiKey) {
      console.warn(`   ⚠ No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY - agent will rely on file-based credentials`);
    }

    if (config.ghToken) {
      args.push('-e', `GH_TOKEN=${config.ghToken}`);
    }

    // Pass daemon URL and per-agent API token so agents can call the API (report.sh)
    args.push('-e', `FRITZ_DAEMON_URL=${config.daemonUrl}`);
    args.push('-e', `FRITZ_API_TOKEN=${apiToken}`);

    // Agent Teams: inject env vars for all agents (persistent mode is universal)
    args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');

    // OpenTelemetry: export metrics, logs, and traces when collector endpoint is configured
    if (config.otelExporterEndpoint) {
      args.push('-e', 'CLAUDE_CODE_ENABLE_TELEMETRY=1');
      args.push('-e', 'OTEL_METRICS_EXPORTER=otlp');
      args.push('-e', 'OTEL_LOGS_EXPORTER=otlp');
      args.push('-e', 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
      args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${config.otelExporterEndpoint}`);
    }

    // Kali containers need raw socket access for nmap, masscan, etc.
    if (agentImage.endsWith('-kali')) {
      args.push('--cap-add=NET_RAW', '--cap-add=NET_ADMIN');
      console.log(`   ✓ Added NET_RAW + NET_ADMIN capabilities (Kali image)`);
    }

    // Join the fritz network so containers can reach the daemon by hostname
    args.push('--network', 'fritz');

    // Docker-in-Docker: Agent containers are siblings, not children
    // Must mount from HOST filesystem, not daemon container's filesystem
    let hostWorkspacePath: string;
    if (config.hostWorkspacesDir) {
      // Production (Docker): use host path
      // workspace = /app/.workspaces/agent-name
      // Extract agent name and build host path
      const wsName = workspace.split('/').pop();
      hostWorkspacePath = `${config.hostWorkspacesDir}/${wsName}`;
      console.log(`   Host workspace path: ${hostWorkspacePath}`);
    } else {
      // Local dev: workspace path is already the host path
      hostWorkspacePath = workspace;
    }

    args.push(
      '-v',
      `${hostWorkspacePath}:/workspace`
    );

    // Build host path for agent's .claude directory (for Docker-in-Docker)
    // Note: bootAgent() already created workspace/.claude and copied credentials
    let hostAgentClaudePath: string;
    if (config.hostWorkspacesDir) {
      // Production (Docker): use host path
      const wsName = workspace.split('/').pop();
      hostAgentClaudePath = `${config.hostWorkspacesDir}/${wsName}/.claude`;
      console.log(`   Host agent .claude path: ${hostAgentClaudePath}`);
    } else {
      // Local dev: workspace path is already the host path
      hostAgentClaudePath = join(workspace, '.claude');
    }

    args.push(
      '-v',
      `${hostAgentClaudePath}:/home/node/.claude`
    );
    console.log(`   ✓ Mounting isolated agent .claude: ${hostAgentClaudePath}`);

    args.push(
      '--entrypoint', 'sleep',
      agentImage,
      'infinity'
    );

    const dockerCmd = `docker ${args.join(' ')}`;
    console.log(`   Running: ${redactDockerCmd(dockerCmd)}`);

    try {
      execSync(dockerCmd, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      console.error(`   Failed to start container:`);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`   ${redactDockerCmd(errMsg)}`);
      if (err && typeof err === 'object' && 'stderr' in err) {
        console.error(`   stderr: ${redactDockerCmd((err as { stderr: string }).stderr)}`);
      }
      throw err;
    }

    // Wait a moment for container to start
    await new Promise(r => setTimeout(r, 2000));

    // Get container ID
    const containerId = execSync(`docker ps -q -f "name=${containerName}"`, {
      encoding: 'utf-8',
    }).trim();

    if (!containerId) {
      // Container already exited - get the logs
      console.error(`   ✗ Container ${containerName} already exited!`);
      try {
        const logs = execSync(`docker logs ${containerName} 2>&1`, { encoding: 'utf-8' });
        console.error(`   Container logs (stdout + stderr):`);
        console.error(logs);
      } catch {
        console.error(`   Could not retrieve logs`);
      }

      // Get exit code
      try {
        const inspect = execSync(`docker inspect ${containerName} --format='{{.State.ExitCode}}'`, { encoding: 'utf-8' }).trim();
        console.error(`   Exit code: ${inspect}`);
      } catch {
        console.error(`   Could not get exit code`);
      }

      throw new Error(`Agent container exited immediately - check logs above`);
    }

    console.log(`   ✓ Container ${containerId} is running`);

    // Capture Claude Code version from the running container
    let claudeCodeVersion: string | undefined;
    try {
      const raw = execSync(`docker exec ${containerName} claude --version`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      claudeCodeVersion = parseClaudeVersion(raw);
      console.log(`   ✓ Claude Code version: ${claudeCodeVersion}`);
    } catch (err) {
      console.log(`   ⚠ Could not capture Claude Code version: ${err instanceof Error ? err.message : err}`);
    }

    // Show initial logs to see what's happening
    try {
      const initialLogs = execSync(`docker logs ${containerName} 2>&1 | head -20`, { encoding: 'utf-8' });
      if (initialLogs.trim()) {
        console.log(`   Initial container output:`);
        console.log(initialLogs.split('\n').map(l => `     ${l}`).join('\n'));
      }
    } catch {
      // Ignore if we can't get logs yet
    }

    // Phase 3: Post-boot setup (NO assignAgent call — already done by claimIssue)
    agentComms.initAgent(name);
    registry.updateContainer(name, containerId);

    // Agent is now fully registered — watchdog can see it in the local registry
    if (issue) pendingClaims.delete(issue);

    // Store Claude Code version in registry
    if (claudeCodeVersion) {
      registry.updateClaudeCodeVersion(name, claudeCodeVersion);
    }

    // Fetch issue title (non-blocking, non-fatal)
    if (issue && config.ghToken) {
      try {
        const title = github.getIssueTitle(issue);
        if (title) {
          registry.updateIssueTitle(name, title);
        }
      } catch {
        // Title is optional, don't fail boot
      }
    }

    // Notify via Telegram
    await lifecycle.hello(name, role, issue, repo || undefined, branch || undefined, mode, bootContext, model, claudeCodeVersion);

    // Watch for container exit to immediately update GitHub
    watchContainerExit(name, containerName);

    // Fire initial prompt asynchronously — don't block /boot response
    // Skip in chat mode — user will send the first message manually
    if (mode === 'chat') {
      console.log(`[agents] Chat mode: skipping initial prompt for ${name}`);
    } else {
      sendInitialPrompt(name, role, issue, repo || undefined);
    }

    console.log(`   Container: ${containerId}`);
    console.log(`   Workspace: ${workspace}`);

    return name;
  } catch (err) {
    // Clear pending claim on failure
    if (options.issue) pendingClaims.delete(options.issue);

    // Phase 4: Rollback GitHub claim on any failure
    if (claim && options.issue && config.githubRepo) {
      try {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isCloneError = errorMessage.includes('Failed to clone repository');
        await github.unclaimIssue(options.issue, claim.previousStatus, {
          errorMessage,
          forceStatus: isCloneError ? 'for-human' : undefined,
        });
      } catch {
        // Best effort — watchdog will eventually clean up
      }
    }

    // Notify Telegram so failures are visible outside GitHub
    try {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const issueRef = options.issue ? `*#${options.issue}*` : `\`${options.role}\` agent`;
      logEvent('agent.start-failed', `${options.issue ? `#${options.issue}` : options.role} agent failed to start: ${errorMessage}`, { issue: options.issue, role: options.role });
      await lifecycle.system(`⚠️ ${issueRef} — agent failed to start: ${errorMessage}`);
    } catch {
      // Best effort — don't let notification failure mask the original error
    }

    throw err;
  }
}

// Send the initial prompt to a newly booted agent (runs async, non-blocking)
async function sendInitialPrompt(
  name: string,
  _role: AgentRole,
  _issue?: number,
  _repo?: string,
): Promise<void> {
  const prompt =
    'You are starting work. First action: read the file CLAUDE.md and follow all instructions in it.';
  try {
    const response = await agentComms.sendToAgent(name, prompt);
    const messageId = await lifecycle.agentResponse(name, response);
    if (messageId) {
      trackAgentMessage(messageId, name);
    }
    console.log(`[agents] Initial prompt delivered to ${name}`);
  } catch (err) {
    // If the agent was already destroyed (container exited mid-prompt),
    // skip lifecycle.failed() to avoid a confusing duplicate notification.
    const message = err instanceof Error ? err.message : String(err);
    const agentGone = !registry.getAgent(name)
      || message.includes('No comms state for agent')
      || message.includes('was stopped');
    if (agentGone) {
      console.log(`[agents] Initial prompt error ignored for ${name}: agent already gone`);
      return;
    }
    console.error(`[agents] Initial prompt failed for ${name}:`, err);
    await lifecycle.failed(name, `Initial prompt failed: ${message}`);
  }
}

async function stopAgentDocker(name: string, status: 'completed' | 'dead' = 'dead', outcome?: string): Promise<void> {
  const agent = registry.getAgent(name);
  if (!agent) {
    console.log(`Agent not found: ${name}`);
    return;
  }

  // Mark as stopping so the exit watcher's already-queued callback bails out
  // instead of double-processing. See issue #252.
  stoppingAgents.add(name);

  try {
    // Parse session data while agent is still registered (needs workspace path)
    let session = null;
    try {
      session = parseAgentSession(agent.workspace);
    } catch { /* non-fatal */ }

    // Set exit info so SSE events include exitCode/exitStatus (even without archive).
    // exitCode is null here because daemon-initiated stops don't have a container exit code
    // (unlike watchContainerExit which reads it from `docker wait`).
    registry.updateExitInfo(name, null, status);

    // Kill exit watcher (so it doesn't double-process)
    const watcher = dockerExitWatchers.get(name);
    if (watcher) {
      watcher.kill();
      dockerExitWatchers.delete(name);
    }

    // Detect teammate spawning (reuse session parsed above)
    let teammateCount: number | undefined;
    if (session && session.subagentCount > 0) {
      teammateCount = session.subagentCount;
      console.log(`   🤝 Agent spawned ${teammateCount} teammate(s)`);
    }

    // Update GitHub labels BEFORE stopping container or archiving logs.
    if (agent.issue && agent.repo) {
      await github.releaseAgent(agent.issue, name, agent.role, status, outcome, agent.invocationMode, teammateCount);
    }

    // Deregister AFTER GitHub labels are updated. This ensures the watchdog
    // never sees a mismatch (local=gone, GitHub=active) during normal stop.
    // The stoppingAgents guard prevents the exit watcher from double-processing
    // even if its callback was already queued in the event loop. See issue #252.
    registry.deregisterAgent(name);

    // Clean up agent communication state
    agentComms.destroyAgent(name);

    const containerName = `${AGENT_CONTAINER_PREFIX}${name}`;

    // Stop Docker container
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'pipe' });
      execSync(`docker rm ${containerName}`, { stdio: 'pipe' });
      console.log(`⏹️ [docker] Stopped agent: ${name}`);
    } catch {
      console.log(`   Container not running`);
    }

    // Archive logs after label update (non-critical, uses captured `agent` local)
    await archiveAgentLogs(agent, status, null, null, session);

    // Strip build artifacts (target/, node_modules/, etc.) to reclaim disk space
    await stripBuildArtifacts(agent.workspace);

    // Clear focus mode for this agent
    clearFocus(name);
  } finally {
    stoppingAgents.delete(name);
  }
}

async function stopAllAgentsDocker(): Promise<void> {
  console.log('[docker] Stopping all agents...');

  // Stop all agent containers
  try {
    const containers = execSync(
      `docker ps -q --filter "name=${AGENT_CONTAINER_PREFIX}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (containers) {
      execSync(`docker stop ${containers.split('\n').join(' ')}`, {
        stdio: 'pipe',
      });
      execSync(`docker rm ${containers.split('\n').join(' ')}`, {
        stdio: 'pipe',
      });
    }
  } catch {
    // No containers running
  }

  // Archive logs and clean up agent communication state, update GitHub
  const agentList = registry.listAgents();
  for (const agent of agentList) {
    // Archive before clearing registry
    let session = null;
    try { session = parseAgentSession(agent.workspace); } catch { /* non-fatal */ }
    await archiveAgentLogs(agent, 'stopped', null, 'Bulk stop (stopAllAgents)', session);
    await stripBuildArtifacts(agent.workspace);

    agentComms.destroyAgent(agent.name);
    if (agent.issue && agent.repo) {
      await github.releaseAgent(agent.issue, agent.name, agent.role, 'dead', undefined, agent.invocationMode);
    }
  }

  // Clear local registry in bulk. updateExitInfo is not needed here because
  // stopAllAgentsDocker is a bulk shutdown (daemon restart / manual stop-all):
  // agents are archived with status 'stopped' above, and clearAll() bypasses
  // per-agent deregistration (no SSE events emitted for individual agents).
  registry.clearAll();

  console.log('✅ All agents stopped');
}

function getAgentLogsImpl(name: string, lines: number = 50, maxLength?: number): string {
  // Resolve workspace path
  const agent = registry.getAgent(name);
  const workspace = agent ? agent.workspace : `${config.workspacesDir}/${name}`;

  // Try rich session view first (JSONL + agent.log merged)
  try {
    const summary = parseAgentSession(workspace);
    if (summary) {
      return formatSessionForTelegram(summary, maxLength);
    }
  } catch {
    // Fall through to raw agent.log
  }

  // Fallback: raw agent.log from workspace
  const logFile = `${workspace}/.fritz/agent.log`;

  if (existsSync(logFile)) {
    try {
      const content = readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n').filter(line => line.trim());
      const lastLines = allLines.slice(-lines);
      // Strip backticks so Telegram code-fence wrapping is not broken
      return (lastLines.join('\n') || '(no output yet)').replace(/`/g, "'");
    } catch (err) {
      return `Failed to read logs for agent ${name}: ${err}`;
    }
  }

  // Final fallback: check the persistent log archive
  return getArchivedLog(name, lines)?.log ?? `No logs found for agent: ${name}`;
}

function getAgentLogsDocker(name: string, lines: number = 50, maxLength?: number): string {
  return getAgentLogsImpl(name, lines, maxLength);
}

function isAgentRunningDocker(name: string): boolean {
  const containerName = `${AGENT_CONTAINER_PREFIX}${name}`;

  try {
    const result = execSync(`docker ps -q -f "name=${containerName}"`, {
      encoding: 'utf-8',
    }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

function listRunningDocker(): string[] {
  try {
    const result = execSync(
      `docker ps --filter "name=${AGENT_CONTAINER_PREFIX}" --format "{{.Names}}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (!result) return [];
    return result.split('\n').map((name) => name.replace(AGENT_CONTAINER_PREFIX, ''));
  } catch {
    return [];
  }
}

// ============================================================================
// WORKSPACE CLEANUP
// ============================================================================

export interface CleanupResult {
  removed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Remove old workspace directories that are no longer associated with a
 * running agent. A workspace is eligible for cleanup when:
 *   1. It has no entry in the local registry (agent already stopped), AND
 *   2. Its directory is older than `maxAgeHours` hours.
 *
 * @param maxAgeHours  Maximum age in hours. Workspaces older than this
 *                     and not in the registry are deleted. Pass 0 to
 *                     remove all non-active workspaces regardless of age.
 */
export function cleanupWorkspaces(maxAgeHours: number = getDaemonConfig().workspaceMaxAgeHours): CleanupResult {
  const result: CleanupResult = { removed: [], skipped: [], errors: [] };
  const workspacesDir = config.workspacesDir;

  if (!existsSync(workspacesDir)) {
    return result;
  }

  const activeAgents = new Set(registry.listAgents().map(a => a.name));
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(workspacesDir);
  } catch (err) {
    result.errors.push(`Failed to read workspaces directory: ${err}`);
    return result;
  }

  for (const entry of entries) {
    // Skip the registry file itself
    if (entry === 'registry.json') continue;

    // Skip the orchestrator's workspace (it's not in the agent registry)
    if (entry === 'fritz') {
      result.skipped.push(entry);
      continue;
    }

    // Skip the log archive directory (has its own cleanup policy via cleanupLogArchive)
    if (entry === 'logs') {
      result.skipped.push(entry);
      continue;
    }

    const fullPath = join(workspacesDir, entry);

    // Only process directories
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Skip workspaces with active agents
    if (activeAgents.has(entry)) {
      result.skipped.push(entry);
      continue;
    }

    // Check age (use mtime of the directory)
    if (maxAgeHours > 0) {
      try {
        const mtime = statSync(fullPath).mtimeMs;
        const ageMs = now - mtime;
        if (ageMs < maxAgeMs) {
          result.skipped.push(entry);
          continue;
        }
      } catch {
        result.skipped.push(entry);
        continue;
      }
    }

    // Remove the workspace
    try {
      rmSync(fullPath, { recursive: true, force: true });
      result.removed.push(entry);
      console.log(`[cleanup] Removed workspace: ${entry}`);
    } catch (err) {
      result.errors.push(`Failed to remove ${entry}: ${err}`);
      console.error(`[cleanup] Failed to remove workspace ${entry}:`, err);
    }
  }

  return result;
}

// ============================================================================
// PUBLIC API: Always use Docker for agents
// ============================================================================

export async function startAgent(options: BootOptions): Promise<string> {
  // Refresh issue cache before boot — ensures we have the latest labels/state
  // Uses ETag so if nothing changed, the API call is free (304)
  const repo = config.githubRepo;
  if (repo) {
    const [owner, name] = repo.split('/');
    refreshIssuesCache(owner, name).catch(() => {}); // best-effort, don't block boot
  }
  // Always spawn agents as Docker containers for isolation
  return startAgentDocker(options);
}

export async function stopAgent(name: string, status: 'completed' | 'dead' = 'dead', outcome?: string): Promise<void> {
  await stopAgentDocker(name, status, outcome);
  // Refresh issue cache after agent completes — labels just changed via releaseAgent()
  // Uses ETag so if nothing changed, the API call is free (304)
  const repo = config.githubRepo;
  if (repo) {
    const [owner, repoName] = repo.split('/');
    refreshIssuesCache(owner, repoName).catch(() => {}); // best-effort
  }
}

export async function stopAllAgents(): Promise<void> {
  return stopAllAgentsDocker();
}

export function getAgentLogs(name: string, lines: number = 50, maxLength?: number): string {
  return getAgentLogsDocker(name, lines, maxLength);
}

/**
 * Get the parsed Claude Code session timeline for an agent. JSONL-only.
 *
 * Resolution order:
 *   1. Active workspace JSONL via parseAgentSession + formatSessionForTelegram
 *   2. Persisted timeline at {workspacesDir}/logs/archive/{name}/session.txt
 *      (written by archiveAgentLogs at agent-exit time)
 *   3. null
 *
 * Unlike getAgentLogs(), this never falls back to agent.log — that fallback
 * was the root cause of issue #926, where the dashboard's Session Log and
 * Agent Log panels showed identical content for archived agents.
 *
 * Telegram and the live agent-log dashboard endpoint keep using getAgentLogs(),
 * which still has the agent.log fallback (their UX expects something to render
 * even when JSONL is unavailable).
 */
export function getSessionTimeline(name: string, maxLength?: number): string | null {
  // 1. Try the live workspace first (active or recently-stopped agent
  //    whose workspace hasn't been cleaned up yet).
  const agent = registry.getAgent(name);
  const workspace = agent ? agent.workspace : `${config.workspacesDir}/${name}`;

  try {
    const summary = parseAgentSession(workspace);
    if (summary) {
      return formatSessionForTelegram(summary, maxLength);
    }
  } catch {
    // Fall through to the archive.
  }

  // 2. Fall back to the persisted session.txt written at archive time.
  //    Workspaces are removed by cleanupWorkspaces, so this is the only
  //    source for completed agents whose workspace is gone.
  const archivedSession = join(config.workspacesDir, 'logs', 'archive', name, 'session.txt');
  if (existsSync(archivedSession)) {
    try {
      const content = readFileSync(archivedSession, 'utf-8');
      if (maxLength !== undefined && content.length > maxLength) {
        return content.slice(0, maxLength);
      }
      return content;
    } catch {
      // Unreadable — fall through to null.
    }
  }

  return null;
}

export function isAgentRunning(name: string): boolean {
  return isAgentRunningDocker(name);
}

export function listRunningProcesses(): string[] {
  return listRunningDocker();
}

export function getActiveAgentCount(): number {
  return registry.listAgents().length;
}

export function getMaxParallel(): number {
  return getMaxParallelAgents();
}

/**
 * Clean up orphan agents left running from a previous daemon instance.
 * This should be called during daemon startup to ensure a clean state.
 *
 * When the daemon restarts (e.g., via deploy), Docker containers may still be
 * running from before the restart. These become "orphans" - the daemon can't
 * communicate with them (no agent-comms state, no exit watchers).
 *
 * This function:
 * 1. Lists all running agent Docker containers (prefixed with AGENT_CONTAINER_PREFIX)
 * 2. Stops and removes them
 * 3. Clears the local registry to start fresh
 */
export async function cleanupOrphanAgents(): Promise<void> {
  console.log('[agents] Cleaning up orphan agents from previous daemon instance...');

  // Get list of running agent containers
  const runningAgents = listRunningDocker();

  if (runningAgents.length === 0) {
    console.log('[agents] No orphan agents found');
    registry.clearAll();
    return;
  }

  console.log(`[agents] Found ${runningAgents.length} orphan agent(s): ${runningAgents.join(', ')}`);

  // Best-effort archive from registry data before clearing, and restore GitHub labels.
  // We still have registry data here (before clearAll), so we can determine the right
  // pipeline status based on role and whether the agent had any activity (0-turn detection).
  const registeredAgents = registry.listAgents();
  for (const agent of registeredAgents) {
    try {
      await archiveAgentLogs(agent, 'stopped', null, 'Orphan cleanup (daemon restart)', null);
      await stripBuildArtifacts(agent.workspace);
    } catch {
      // Best-effort — orphan agents from a crashed daemon are a data-loss scenario
    }

    // Restore pipeline status on GitHub based on agent role and activity
    if (agent.issue && agent.repo) {
      try {
        const hadActivity = !!agent.lastActivity;
        const restoreStatus = github.getOrphanRestoreStatus(agent.role, hadActivity);
        const reason = hadActivity
          ? `agent '${agent.role}' had activity — restoring to ${restoreStatus}`
          : `agent '${agent.role}' had 0 turns — restoring to ${restoreStatus}`;
        console.log(`[agents] Restoring #${agent.issue}: ${reason}`);
        await github.transitionStatus(agent.issue, 'active', restoreStatus);
        logEvent('orphan.restore', `Orphan cleanup restored #${agent.issue} → ${restoreStatus}`, {
          issue: agent.issue,
          role: agent.role,
          hadActivity,
          restoreStatus,
        });
      } catch (error) {
        console.log(`[agents] Failed to restore status for #${agent.issue}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Stop each orphan container
  for (const agentName of runningAgents) {
    const containerName = `${AGENT_CONTAINER_PREFIX}${agentName}`;
    console.log(`[agents] Stopping orphan container: ${containerName}`);

    try {
      execSync(`docker stop ${containerName}`, { stdio: 'pipe', timeout: 30000 });
      execSync(`docker rm ${containerName}`, { stdio: 'pipe', timeout: 10000 });
      console.log(`[agents] ✓ Stopped and removed: ${containerName}`);
    } catch {
      // Container may have already stopped or been removed
      console.log(`[agents] Note: Could not stop ${containerName} (may already be stopped)`);

      // Try to remove even if stop failed
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'pipe', timeout: 10000 });
      } catch {
        // Ignore removal errors
      }
    }
  }

  // Clear the local registry to start fresh
  registry.clearAll();
  console.log('[agents] ✓ Registry cleared');
  console.log('[agents] Orphan cleanup complete');
}

// Re-export agent-comms for convenience
export { sendToAgent, isAgentBusy } from './agent-comms.js';
