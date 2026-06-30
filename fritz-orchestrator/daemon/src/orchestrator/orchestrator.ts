import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { isRunningInDocker, getRuntimeMode } from '../runtime.js';
import { getOrchestratorModel, getClaudeConfig } from '../agents/fritz-config.js';
import {
  loadOrchestratorIdentity as loadIdentity,
  copyKnowledge as copyKnowledgeFiles,
} from './knowledge.js';
import { MessageQueue } from '../core/message-queue.js';
import { getCachedIssues } from '../github/github-graphql.js';
import { DEPENDS_ON_PREFIX } from '../github/github.js';
import { restoreClaudeJsonInContainer, restoreClaudeJsonLocal, filterClaudeStderr } from './claude-config-restore.js';

/**
 * Fetches a concise pipeline snapshot for orchestrator context.
 * Returns empty string on any failure — never throws.
 */
async function buildQueueContext(): Promise<string> {
  try {
    const pipelineStatuses = new Set([
      'for-define', 'for-implement', 'active', 'for-review', 'for-validate', 'for-rework',
    ]);
    // Use GraphQL cache (shared with autoloop) — no direct gh call
    const cached = getCachedIssues();
    let allIssues: Array<{ number: number; title: string; labels: string[] }>;
    if (cached) {
      allIssues = cached;
    } else {
      // Cache not yet populated — fall back to direct gh call
      const result = execSync(
        `gh issue list --repo ${config.githubRepo} --limit 50 --json number,title,labels,state 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      if (!result) return '';
      const raw = JSON.parse(result) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
      allIssues = raw.map(i => ({ number: i.number, title: i.title, labels: i.labels.map(l => l.name) }));
    }
    const issues = allIssues.filter(i =>
      i.labels.some(l => {
        if (!l.startsWith('fritz.status:')) return false;
        return pipelineStatuses.has(l.replace('fritz.status:', ''));
      })
    );
    if (!issues.length) return 'Pipeline is empty.';
    return issues.map(i => {
      const status = i.labels.find(l => l.startsWith('fritz.status:'))?.replace('fritz.status:', '') ?? '';
      const repo = i.labels.find(l => l.startsWith('fritz.repo:'))?.replace('fritz.repo:', '') ?? 'fritZ';
      const dep = i.labels.find(l => l.startsWith(DEPENDS_ON_PREFIX)) ?? '';
      const express = i.labels.some(l => l === 'priority:p0') ? ' ⚡' : '';
      return `#${i.number} [${status}] [${repo}]${dep ? ` [${dep}]` : ''}${express} — ${i.title}`;
    }).join('\n');
  } catch {
    return '';
  }
}

const PIPELINE_KEYWORDS = /pipeline|queue|issue|#\d+|depends|chain|order|priority|inbox|backlog|express|block|hold|fritzmonitor|fritzbridge/i;

const ORCHESTRATOR_NAME = 'fritz';
const WORKSPACE = `${config.workspacesDir}/${ORCHESTRATOR_NAME}`;
const CONTAINER_NAME = 'fritz-orchestrator';

// Stable API token for the orchestrator container (generated once per daemon lifecycle)
let orchestratorApiToken: string | null = null;

/** Get the orchestrator API token (for archive endpoint auth validation). */
export function getOrchestratorApiToken(): string | null {
  return orchestratorApiToken;
}

let isStarting = false;
let isReady = false;
let isFirstMessage = true;

function log(msg: string): void {
  console.log(`[orchestrator:${getRuntimeMode()}] ${msg}`);
}

// Message queue: serializes orchestrator.send() calls so only one Claude
// process runs at a time, preventing races on the isFirstMessage flag.
interface SendInput { message: string; commandHint?: string; timeoutMs: number }
const sendQueue = new MessageQueue<SendInput, string>(
  (input) => processSend(input.message, input.commandHint, input.timeoutMs),
  (position) => { if (position > 0) log(`Message queued (${position} waiting)`); },
);

// Ensure workspace exists with orchestrator identity and knowledge
function ensureWorkspace(): void {
  const fritzDir = `${WORKSPACE}/.fritz`;
  if (!existsSync(fritzDir)) {
    mkdirSync(fritzDir, { recursive: true });
  }

  // 1. Load identity from SKILL.md (with fallback)
  const identity = loadIdentity(config.fritzRoot, config.githubRepo, log);
  writeFileSync(`${fritzDir}/identity.md`, identity);

  // 2. Copy shared knowledge
  copyKnowledgeFiles(
    resolve(config.fritzRoot, 'fritz/knowledge'),
    resolve(WORKSPACE, '.fritz/knowledge'),
    log
  );

  // 3. Copy orchestrator-specific knowledge (overrides shared)
  copyKnowledgeFiles(
    resolve(config.fritzRoot, '.claude/orchestrator/knowledge'),
    resolve(WORKSPACE, '.fritz/knowledge'),
    log
  );

  // Write CLAUDE.md so Claude Code auto-discovers knowledge via tool use
  // (knowledge files are already in .fritz/knowledge/ from copyKnowledgeFiles above)
  writeFileSync(join(WORKSPACE, 'CLAUDE.md'), [
    '# fritZ Orchestrator',
    '',
    'You are the fritZ orchestrator. Your identity is in `.fritz/identity.md`.',
    '',
    'Project knowledge files are in `.fritz/knowledge/`. Read relevant files',
    'when you need context about architecture, decisions, patterns, or operations.',
    'Only read what is relevant — do not load all files at once.',
  ].join('\n') + '\n');

  // Seed orchestrator auto-memory with daemon API access pattern
  const memoryDir = `${WORKSPACE}/.claude/projects/-workspace/memory`;
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  const memoryFile = `${memoryDir}/MEMORY.md`;
  if (!existsSync(memoryFile)) {
    const memory = `# fritZ Orchestrator Memory

## Daemon API Access

Access the daemon's log archive API using environment variables:

\`\`\`bash
# List archived agents (optional params: role, issue, since, limit)
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive

# Get agent log (optional param: lines, default 50)
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive/{name}/log

# Get agent summary (JSON: tokens, tools, duration)
curl -s -H "Authorization: Bearer $FRITZ_API_TOKEN" $FRITZ_API_URL/api/archive/{name}/summary
\`\`\`

Use these endpoints to answer questions about agent activity, logs, and performance.
`;
    writeFileSync(memoryFile, memory);
  }
}

/** Refresh orchestrator knowledge and identity. Re-reads SKILL.md and re-copies knowledge files. */
export function refresh(): string {
  try {
    ensureWorkspace();
    isFirstMessage = true;  // Force identity re-injection on next message
    log('Knowledge refreshed, session reset');
    return '🔄 Knowledge refreshed — identity will be re-injected on next message.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Knowledge refresh failed: ${message}`);
    return `⚠️ Knowledge refresh failed: ${message}`;
  }
}

// Build claude command flags from config
function getClaudeFlags(): string[] {
  const flags: string[] = [];
  const claudeConfig = getClaudeConfig();
  if (claudeConfig.claudeSkipPermissions) {
    flags.push('--dangerously-skip-permissions');
  }
  if (claudeConfig.claudePrintMode) {
    flags.push('--print');
  }
  // Use orchestrator-specific model from fritz.yaml
  const model = getOrchestratorModel();
  flags.push('--model', model);
  return flags;
}

// ============================================================================
// DOCKER MODE: Start persistent container with sleep infinity
// ============================================================================

async function startDockerMode(): Promise<void> {
  log('Starting Docker orchestrator container...');

  ensureWorkspace();

  // Stop any existing container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Container didn't exist
  }

  const args = [
    'run',
    '--rm',
    '-d',  // Detached
    '--name', CONTAINER_NAME,
    '-e', `HOME=/home/node`,
  ];

  // Pass authentication
  if (config.claudeOauthToken) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`);
  }

  if (config.anthropicApiKey) {
    args.push('-e', `ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
  }

  if (config.ghToken) {
    args.push('-e', `GH_TOKEN=${config.ghToken}`);
  }

  // Mount workspace (use host path for Docker-in-Docker)
  const hostWorkspacePath = config.hostWorkspacesDir
    ? `${config.hostWorkspacesDir}/${ORCHESTRATOR_NAME}`
    : WORKSPACE;
  args.push('-v', `${hostWorkspacePath}:/workspace`);

  // Mount orchestrator-specific .claude directory (isolated from agents)
  const orchestratorClaude = join(WORKSPACE, '.claude');
  if (!existsSync(orchestratorClaude)) {
    mkdirSync(orchestratorClaude, { recursive: true });
    log(`Created orchestrator .claude directory: ${orchestratorClaude}`);
  }

  if (config.claudeOauthToken) {
    // Token-based auth: no credential files needed
    log(`✓ Using CLAUDE_CODE_OAUTH_TOKEN (skipping credential file copy)`);
  } else {
    // CRITICAL: Copy credentials from host .claude to orchestrator .claude
    const credentialFiles = ['.credentials.json', 'subscription_token.json'];
    for (const credFile of credentialFiles) {
      const hostCred = join(config.claudeHome, credFile);
      const orchestratorCred = join(orchestratorClaude, credFile);

      if (existsSync(hostCred)) {
        try {
          copyFileSync(hostCred, orchestratorCred);
          log(`✓ Copied ${credFile} to orchestrator .claude`);
        } catch (err: unknown) {
          log(`⚠ Failed to copy ${credFile}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // Build host path for orchestrator's .claude directory (for Docker-in-Docker)
  let hostOrchestratorClaudePath: string;
  if (config.hostWorkspacesDir) {
    // Production (Docker): use host path
    hostOrchestratorClaudePath = `${config.hostWorkspacesDir}/${ORCHESTRATOR_NAME}/.claude`;
    log(`Host orchestrator .claude path: ${hostOrchestratorClaudePath}`);
  } else {
    // Local dev: orchestratorClaude is already the host path
    hostOrchestratorClaudePath = orchestratorClaude;
  }

  args.push('-v', `${hostOrchestratorClaudePath}:/home/node/.claude`);
  log(`✓ Mounting isolated orchestrator .claude: ${hostOrchestratorClaudePath}`);

  // Join the fritz network so orchestrator can reach the daemon by hostname
  args.push('--network', 'fritz');

  // Pass daemon API URL so orchestrator can call /api/archive, etc.
  args.push('-e', `FRITZ_API_URL=${config.daemonUrl}`);

  // Generate a stable API token for archive access
  orchestratorApiToken = randomBytes(16).toString('hex');
  args.push('-e', `FRITZ_API_TOKEN=${orchestratorApiToken}`);
  log(`✓ Orchestrator API access: FRITZ_API_URL=${config.daemonUrl}`);

  // Pass bridge token so orchestrator can reach an external agent system via fritzbridge
  if (process.env.BRIDGE_API_TOKEN) {
    args.push('-e', `BRIDGE_API_TOKEN=${process.env.BRIDGE_API_TOKEN}`);
    log('✓ Bridge API token passed to orchestrator');
  }

  // OpenTelemetry: export metrics, logs, and traces when collector endpoint is configured
  if (config.otelExporterEndpoint) {
    args.push('-e', 'CLAUDE_CODE_ENABLE_TELEMETRY=1');
    args.push('-e', 'OTEL_METRICS_EXPORTER=otlp');
    args.push('-e', 'OTEL_LOGS_EXPORTER=otlp');
    args.push('-e', 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${config.otelExporterEndpoint}`);
  }

  args.push(
    '--entrypoint', 'sleep',
    config.dockerImage,
    'infinity'
  );

  log('Starting container (sleep infinity)...');

  try {
    execSync(`docker ${args.join(' ')}`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to start container: ${err}`);
  }

  // Verify container is running
  await new Promise(r => setTimeout(r, 1000));

  try {
    const status = execSync(`docker ps -q -f name=${CONTAINER_NAME}`, { encoding: 'utf-8' }).trim();
    if (!status) {
      throw new Error('Container not running');
    }
    log('Docker orchestrator container is ready!');
  } catch {
    throw new Error('Container failed to start');
  }
}

async function sendDockerMode(message: string, commandHint?: string, timeoutMs: number = 180000): Promise<string> {
  // Verify container is still running
  try {
    const status = execSync(`docker ps -q -f name=${CONTAINER_NAME}`, { encoding: 'utf-8' }).trim();
    if (!status) {
      isReady = false;
      await startDockerMode();
      isReady = true;
    }
  } catch {
    isReady = false;
    await startDockerMode();
    isReady = true;
  }

  // Pre-restore .claude.json from backup before each message spawn.
  // Claude removes this file on shutdown, so subsequent messages would
  // trigger the backup warning. No-op when the file already exists.
  await restoreClaudeJsonInContainer(CONTAINER_NAME);

  log(`→ Owner: ${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);

  // Fetch pipeline context if message mentions pipeline-related keywords
  let queueContext = '';
  if (PIPELINE_KEYWORDS.test(message)) {
    queueContext = await buildQueueContext();
  }

  // Build the prompt — capture flag before mutation (same pattern as sendNativeMode)
  let prompt: string;
  const isFirst = isFirstMessage;
  if (isFirst) {
    const identityPath = resolve(WORKSPACE, '.fritz/identity.md');
    const identity = existsSync(identityPath)
      ? readFileSync(identityPath, 'utf-8')
      : `Du bist fritZ, dein AI Orchestrator. Kommunizierst via Telegram. Kurze Antworten! Repo: ${config.githubRepo}. Agents können mit /tell <name> <msg> angesprochen werden.`;
    const commandContext = commandHint ? `\nCommand context: /${commandHint}` : '';
    prompt = `${identity}${commandContext}\n\nNachricht vom Owner: ${message}${queueContext ? `\n\n## Current Pipeline\n${queueContext}` : ''}\n\nAntworte kurz und prägnant.`;
  } else {
    const commandContext = commandHint ? `\nCommand context: /${commandHint}` : '';
    prompt = `${commandContext}\nNachricht vom Owner: ${message}${queueContext ? `\n\n## Current Pipeline\n${queueContext}` : ''}\n\nAntworte kurz und prägnant.`;
  }

  // Build docker exec args as an array (no shell string concatenation)
  const claudeFlags = getClaudeFlags();
  const continueFlag = !isFirst ? ['--continue'] : [];

  // Mark first message sent AFTER building flags
  if (isFirst) {
    isFirstMessage = false;
  }

  const dockerArgs = [
    'exec', CONTAINER_NAME,
    'claude',
    ...claudeFlags,
    ...continueFlag,
    '-p', prompt
  ];

  // Use spawn instead of execSync to avoid blocking the event loop.
  // This allows setInterval-based typing indicators to fire while
  // waiting for the Claude process to complete.
  return new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log(`Error spawning docker exec: ${err.message}`);
      resolve('(error getting response)');
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0 && code !== null) {
        log(`Docker exec exited with code ${code}`);
        const filteredStderr = filterClaudeStderr(stderr);
        if (filteredStderr) {
          log(`stderr: ${filteredStderr}`);
        }
      }

      // Clean up response
      const clean = stdout
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI codes
        .trim();

      if (clean) {
        log(`← fritZ: ${clean.slice(0, 80)}${clean.length > 80 ? '...' : ''}`);
        resolve(clean);
      } else if (stdout.trim()) {
        // If we have stdout but it was all ANSI codes
        log(`← fritZ: ${stdout.trim().slice(0, 80)}...`);
        resolve(stdout.trim());
      } else {
        resolve('(empty response)');
      }
    });

    // Handle timeout
    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        const partial = stdout
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .trim();
        if (partial) {
          log(`← fritZ (timeout, partial): ${partial.slice(0, 80)}...`);
          resolve(partial);
        } else {
          resolve('(timeout - no response)');
        }
      }
    }, timeoutMs);
  });
}

function stopDockerMode(): void {
  log('Stopping Docker orchestrator container...');

  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {
    // Already stopped
  }
}

function isRunningDockerMode(): boolean {
  try {
    const status = execSync(`docker ps -q -f name=${CONTAINER_NAME}`, { encoding: 'utf-8' }).trim();
    return !!status;
  } catch {
    return false;
  }
}

// ============================================================================
// NATIVE MODE: Spawn claude process for each message
// ============================================================================

async function startNativeMode(): Promise<void> {
  log('Starting native orchestrator...');
  ensureWorkspace();
  // Generate API token for native mode too (used for archive access)
  orchestratorApiToken = randomBytes(16).toString('hex');
  log(`✓ Orchestrator API access: http://localhost:${config.apiPort}`);
  log('Native orchestrator is ready!');
}

async function sendNativeMode(message: string, commandHint?: string, timeoutMs: number = 180000): Promise<string> {
  // Pre-restore .claude.json from backup before each message spawn.
  // Claude removes this file on shutdown, so subsequent messages would
  // trigger the backup warning. No-op when the file already exists.
  await restoreClaudeJsonLocal();

  log(`→ Owner: ${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);

  // Fetch pipeline context if message mentions pipeline-related keywords
  let queueContext = '';
  if (PIPELINE_KEYWORDS.test(message)) {
    queueContext = await buildQueueContext();
  }

  // Build the prompt
  let prompt: string;
  const useIdentity = isFirstMessage;

  if (useIdentity) {
    const identityPath = resolve(WORKSPACE, '.fritz/identity.md');
    const identity = existsSync(identityPath)
      ? readFileSync(identityPath, 'utf-8')
      : `Du bist fritZ, dein AI Orchestrator. Kommunizierst via Telegram. Kurze Antworten! Repo: ${config.githubRepo}. Agents können mit /tell <name> <msg> angesprochen werden.`;
    const commandContext = commandHint ? `\nCommand context: /${commandHint}` : '';
    prompt = `${identity}${commandContext}\n\nNachricht vom Owner: ${message}${queueContext ? `\n\n## Current Pipeline\n${queueContext}` : ''}\n\nAntworte kurz und prägnant.`;
  } else {
    const commandContext = commandHint ? `\nCommand context: /${commandHint}` : '';
    prompt = `${commandContext}\nNachricht vom Owner: ${message}${queueContext ? `\n\n## Current Pipeline\n${queueContext}` : ''}\n\nAntworte kurz und prägnant.`;
  }

  // Build claude command (use continue flag for subsequent messages)
  const claudeFlags = getClaudeFlags();
  const continueFlag = !useIdentity ? ['--continue'] : [];

  // Mark that we've sent first message (do this AFTER building flags)
  if (useIdentity) {
    isFirstMessage = false;
  }

  const args = [
    ...claudeFlags,
    ...continueFlag,
    '-p',
    prompt,
  ];

  // Spawn claude process
  return new Promise((resolve, _reject) => {
    let stdout = '';
    let stderr = '';

    log(`Spawning: claude ${args.join(' ')}`);

    const proc = spawn('claude', args, {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        ...(config.claudeOauthToken && { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken }),
        ...(config.anthropicApiKey && { ANTHROPIC_API_KEY: config.anthropicApiKey }),
        ...(config.ghToken && { GH_TOKEN: config.ghToken }),
        // Daemon API access (native mode uses localhost)
        FRITZ_API_URL: `http://localhost:${config.apiPort}`,
        ...(orchestratorApiToken && { FRITZ_API_TOKEN: orchestratorApiToken }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],  // ignore stdin, pipe stdout/stderr
    });

    log(`Process spawned with PID: ${proc.pid}`);

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      log(`stdout chunk: ${chunk.slice(0, 100)}`);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const filtered = filterClaudeStderr(chunk);
      stderr += chunk;
      if (filtered) {
        log(`stderr chunk: ${filtered.slice(0, 100)}`);
      }
    });

    proc.on('error', (err) => {
      log(`Error spawning process: ${err.message}`);
      resolve(`(error: ${err.message})`);
    });

    proc.on('close', (code) => {
      log(`Process closed with code: ${code}`);
      if (code !== 0 && code !== null) {
        log(`Claude exited with code ${code}`);
        const filteredStderr = filterClaudeStderr(stderr);
        if (filteredStderr) {
          log(`stderr: ${filteredStderr}`);
        }
      }

      // Clean up response
      const clean = stdout
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI codes
        .trim();

      if (clean) {
        log(`← fritZ: ${clean.slice(0, 80)}${clean.length > 80 ? '...' : ''}`);
        resolve(clean);
      } else if (stdout.trim()) {
        // If we have stdout but it was all ANSI codes
        log(`← fritZ: ${stdout.trim().slice(0, 80)}...`);
        resolve(stdout.trim());
      } else {
        resolve('(empty response)');
      }
    });

    // Handle timeout
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        if (stdout) {
          const partial = stdout.trim();
          log(`← fritZ (timeout, partial): ${partial.slice(0, 80)}...`);
          resolve(partial);
        } else {
          resolve('(timeout - no response)');
        }
      }
    }, timeoutMs);
  });
}

function stopNativeMode(): void {
  log('Stopping native orchestrator...');
}

function isRunningNativeMode(): boolean {
  return isReady;
}

// ============================================================================
// PUBLIC API: Auto-detect runtime mode and dispatch
// ============================================================================

export async function start(): Promise<void> {
  if (isStarting || isReady) {
    log('Orchestrator already running or starting');
    return;
  }

  isStarting = true;
  isReady = false;
  isFirstMessage = true;

  try {
    if (isRunningInDocker()) {
      await startDockerMode();
    } else {
      await startNativeMode();
    }
    isReady = true;
  } finally {
    isStarting = false;
  }
}

export function stop(): void {
  if (isRunningInDocker()) {
    stopDockerMode();
  } else {
    stopNativeMode();
  }
  isReady = false;
  isFirstMessage = true;
}

/**
 * Internal send implementation — processes a single message.
 * Callers should use send() which serializes via the message queue.
 */
async function processSend(
  message: string,
  commandHint?: string,
  timeoutMs: number = 180000
): Promise<string> {
  // Auto-start if not running
  if (!isReady) {
    if (!isStarting) {
      await start();
    } else {
      while (isStarting) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  if (isRunningInDocker()) {
    return sendDockerMode(message, commandHint, timeoutMs);
  } else {
    return sendNativeMode(message, commandHint, timeoutMs);
  }
}

/**
 * Send a message to the orchestrator. Messages are serialized via an internal
 * queue so only one Claude process runs at a time, preventing races on the
 * isFirstMessage flag and parallel process spawns.
 *
 * Each caller receives a Promise that resolves with the orchestrator's response
 * once their message has been processed.
 */
export function send(
  message: string,
  commandHint?: string,
  timeoutMs: number = 180000
): Promise<string> {
  return sendQueue.enqueue({ message, commandHint, timeoutMs });
}

export function isRunning(): boolean {
  if (isRunningInDocker()) {
    return isRunningDockerMode();
  } else {
    return isRunningNativeMode();
  }
}

export function getStatus(): { running: boolean; ready: boolean } {
  const running = isRunning();
  return {
    running,
    ready: running && isReady,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator History Buffer — rolling circular buffer of recent conversations
// ---------------------------------------------------------------------------

export interface OrchestratorHistoryEntry {
  ts: string;                        // ISO timestamp
  source: 'bridge' | 'telegram';
  question: string;                  // truncated to 120 chars
  reply: string;                     // truncated to 120 chars
  issueRef?: number;
}

const MAX_HISTORY_ENTRIES = 50;
const orchestratorHistory: OrchestratorHistoryEntry[] = [];
let lastOrchestratorActivity: string | null = null;

/** Reset buffer state — only for use in tests. */
export function resetOrchestratorHistoryForTesting(): void {
  orchestratorHistory.length = 0;
  lastOrchestratorActivity = null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Append a conversation turn to the orchestrator history buffer.
 * Called after every successful POST /api/orchestrator/message.
 */
export function appendOrchestratorHistory(entry: Omit<OrchestratorHistoryEntry, 'ts'>): void {
  const full: OrchestratorHistoryEntry = {
    ts: new Date().toISOString(),
    source: entry.source,
    question: truncate(entry.question, 120),
    reply: truncate(entry.reply, 120),
    ...(entry.issueRef !== undefined && { issueRef: entry.issueRef }),
  };
  orchestratorHistory.push(full);
  if (orchestratorHistory.length > MAX_HISTORY_ENTRIES) {
    orchestratorHistory.shift();
  }
  lastOrchestratorActivity = full.ts;
}

/**
 * Get recent orchestrator conversation history.
 */
export function getOrchestratorHistory(limit: number = 5): {
  conversations: OrchestratorHistoryEntry[];
  connected: boolean;
  lastActivity: string | null;
} {
  const clamped = Math.min(Math.max(1, limit), MAX_HISTORY_ENTRIES);
  return {
    conversations: orchestratorHistory.slice(-clamped),
    connected: isReady,
    lastActivity: lastOrchestratorActivity,
  };
}
