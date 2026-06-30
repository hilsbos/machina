/**
 * Watchdog - monitors local processes and syncs with GitHub
 *
 * GitHub is the source of truth for coordination.
 * Local registry tracks process IDs and workspaces.
 * Watchdog ensures consistency between process state and GitHub labels.
 */

import * as registry from './registry.js';
import * as github from '../github/github.js';
import * as agents from '../agents/agents.js';
import * as lifecycle from './lifecycle.js';
import * as agentComms from '../agents/agent-comms.js';
import { getDaemonConfig, getLogArchiveMaxAgeDays } from '../agents/fritz-config.js';
import { archiveAgentLogs, cleanupLogArchive } from '../agents/log-archive.js';
import { logEvent } from './event-log.js';
import { getCachedIssues, getActiveFromCache, invalidateIssuesCache } from '../github/github-graphql.js';

let watchdogInterval: NodeJS.Timeout | null = null;

// Track consecutive cycles where issue-tracked agents exist locally but GitHub shows 0 active.
// Only counts agents with an issue number (daemon-spawned); manually spawned agents (issue=null)
// are excluded since they legitimately have no GitHub counterpart.
let consecutiveMismatchCount = 0;

/** Reset mismatch counter (exported for testing) */
export function resetMismatchCount(): void {
  consecutiveMismatchCount = 0;
}

/** Get current mismatch count (exported for testing) */
export function getMismatchCount(): number {
  return consecutiveMismatchCount;
}

function log(message: string): void {
  console.log(`[watchdog] ${new Date().toISOString()} ${message}`);
}

// Check for expired agents (TTL exceeded)
async function checkExpired(): Promise<void> {
  const expired = registry.getExpiredAgents();

  for (const agent of expired) {
    const lastActive = agent.lastActivity
      ? `last activity: ${agent.lastActivity}`
      : `started: ${agent.started}`;
    log(`⏰ Agent ${agent.name} expired (TTL reached, ${lastActive})`);

    // Notify via Telegram
    await lifecycle.timeout(agent.name);

    // Stop the agent (also updates GitHub)
    await agents.stopAgent(agent.name, 'dead');
  }
}

// Check if processes match registry
async function syncProcesses(): Promise<void> {
  const localAgents = registry.listAgents();
  const runningProcesses = agents.listRunningProcesses();

  for (const agent of localAgents) {
    const isRunning = runningProcesses.includes(agent.name);

    if (!isRunning) {
      // Re-check registry — another handler (exit watcher, stopAgent) may have
      // already cleaned up this agent between our listAgents() snapshot and now.
      if (!registry.getAgent(agent.name)) {
        log(`🔍 Agent ${agent.name} process not found — already cleaned up, skipping`);
        continue;
      }

      // Process died - check if it completed or crashed
      log(`🔍 Agent ${agent.name} process not found`);

      // Check exit code to determine if completed or failed
      // For now, assume completed if process is gone
      const status = 'completed';
      log(`   Marking as ${status}`);

      // Archive logs before deregistration (persistent storage)
      await archiveAgentLogs(agent, status, null, 'Process vanished (syncProcesses)', null);

      // Update GitHub and cleanup local
      if (agent.issue && agent.repo) {
        await github.releaseAgent(agent.issue, agent.name, agent.role, status);
      }

      // Notify
      await lifecycle.completed(agent.name);

      // Clean up agent communication state
      agentComms.destroyAgent(agent.name);

      // Set exit info so SSE events include exitCode/exitStatus (even without archive)
      registry.updateExitInfo(agent.name, null, status);

      // Remove from local registry
      registry.deregisterAgent(agent.name);
    }
  }
}

// Detect orphaned fritz.status:active labels on GitHub with no matching local agent.
// This catches cases where the daemon restarted after deregistering an agent locally
// but before updating GitHub labels (crash window in stopAgentDocker).
async function cleanupOrphanedLabels(githubActive: github.GitHubAgent[]): Promise<void> {
  if (githubActive.length === 0) return;

  const localAgents = registry.listAgents();

  for (const ghAgent of githubActive) {
    const hasLocal = localAgents.some(a => a.issue === ghAgent.issue);
    if (!hasLocal && !agents.isBootInProgress(ghAgent.issue)) {
      // Note: 0-turn detection is not possible here (no lastActivity data from GitHub).
      // Startup cleanupOrphanAgents() handles 0-turn detection using local registry data.
      const restoreStatus = github.getOrphanRestoreStatus(ghAgent.role);
      const knownForHumanRoles = ['retro'];
      const reason = restoreStatus === 'for-human'
        ? (knownForHumanRoles.includes(ghAgent.role)
          ? `'${ghAgent.role}' agent has no re-entry point`
          : `unknown role '${ghAgent.role}'`)
        : `restoring pipeline status for '${ghAgent.role}' agent`;
      log(`🧹 Orphaned active label on #${ghAgent.issue} (no local agent) — ${reason} → ${restoreStatus}`);
      try {
        await github.transitionStatus(ghAgent.issue, 'active', restoreStatus);
        await lifecycle.system(`⚠️ *#${ghAgent.issue}* had orphaned active label (no running agent). Set to ${restoreStatus} (${reason}).`);
        logEvent('watchdog.orphan', `Cleaned orphaned active label on #${ghAgent.issue} → ${restoreStatus}`, {
          issue: ghAgent.issue,
          role: ghAgent.role,
          restoreStatus,
        });
      } catch (error: unknown) {
        log(`   Failed to clean orphaned label on #${ghAgent.issue}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

// Get summary from local + GitHub
async function getSummary(): Promise<{
  local: number;
  trackedLocal: number;
  running: number;
  githubActive: github.GitHubAgent[];
}> {
  const localAgents = registry.listAgents();
  const trackedAgents = localAgents.filter(a => a.issue !== null);
  const runningProcesses = agents.listRunningProcesses();

  let githubActive: github.GitHubAgent[] = [];
  let usedRestFallback = false;

  // Try the shared GraphQL cache first (avoids a direct gh CLI call)
  const cached = getCachedIssues();
  if (cached) {
    const activeIssues = getActiveFromCache(cached);
    githubActive = activeIssues.map(issue => {
      const roleLabel = issue.labels.find(l => l.startsWith('fritz.skill:'));
      const role = roleLabel ? roleLabel.replace('fritz.skill:', '') : 'implement';
      return {
        issue: issue.number,
        title: issue.title,
        role: role as github.GitHubAgent['role'],
        status: 'working' as const,
      };
    });
  } else {
    // Fallback: direct gh CLI call (cache not yet populated)
    try {
      githubActive = await github.getActiveAgents();
      usedRestFallback = true;
    } catch {
      // GitHub not available
    }
  }

  // Mismatch detection: issue-tracked agents exist but GitHub shows 0 active.
  // This can happen due to GraphQL eventual consistency after REST label mutations.
  // Force a fresh REST fetch to get authoritative state.
  // Skip when REST fallback was already taken (avoids redundant call with same result).
  // Only consider agents with an issue number — manually spawned agents (issue=null)
  // legitimately have no GitHub counterpart.
  if (!usedRestFallback && trackedAgents.length > 0 && githubActive.length === 0) {
    log('⚠️ Mismatch detected: issue-tracked agents running but GitHub shows 0 active — forcing REST refresh');
    invalidateIssuesCache();
    try {
      githubActive = await github.getActiveAgents();
    } catch {
      // GitHub not available — keep empty
    }
  }

  return {
    local: localAgents.length,
    trackedLocal: trackedAgents.length,
    running: runningProcesses.length,
    githubActive,
  };
}

// Clean up old workspace directories — returns count of removed workspaces
function cleanupOldWorkspaces(): number {
  const daemonCfg = getDaemonConfig();
  if (daemonCfg.workspaceMaxAgeHours <= 0) return 0;

  const result = agents.cleanupWorkspaces(daemonCfg.workspaceMaxAgeHours);

  if (result.removed.length > 0) {
    log(`🧹 Cleaned up ${result.removed.length} old workspace(s): ${result.removed.join(', ')}`);
  }
  if (result.errors.length > 0) {
    log(`⚠️ Cleanup errors: ${result.errors.join('; ')}`);
  }
  return result.removed.length;
}

// Clean up old archived logs — returns count of removed archives
function cleanupOldArchives(): number {
  const maxAgeDays = getLogArchiveMaxAgeDays();
  if (maxAgeDays <= 0) return 0;

  const result = cleanupLogArchive(maxAgeDays);

  if (result.removed.length > 0) {
    log(`🧹 Cleaned up ${result.removed.length} old archive(s): ${result.removed.join(', ')}`);
  }
  if (result.errors.length > 0) {
    log(`⚠️ Archive cleanup errors: ${result.errors.join('; ')}`);
  }
  return result.removed.length;
}

// Single check cycle
export async function check(): Promise<void> {
  // Summary
  const summary = await getSummary();
  log(
    `📊 Local: ${summary.local} | Running: ${summary.running} | GitHub active: ${summary.githubActive.length}`
  );

  // Track consecutive mismatch cycles (issue-tracked local agents > 0 but GitHub still shows 0)
  // Manually spawned agents (issue=null) are excluded — they have no GitHub counterpart.
  if (summary.trackedLocal > 0 && summary.githubActive.length === 0) {
    consecutiveMismatchCount++;
    if (consecutiveMismatchCount >= 2) {
      log(`🚨 Persistent mismatch: tracked=${summary.trackedLocal} vs GitHub active=0 for ${consecutiveMismatchCount} consecutive cycles`);
      logEvent('watchdog.mismatch', `Local/GitHub mismatch persisted for ${consecutiveMismatchCount} cycles`, {
        trackedLocal: summary.trackedLocal,
        running: summary.running,
        githubActive: 0,
        cycles: consecutiveMismatchCount,
      });
    }
  } else {
    consecutiveMismatchCount = 0;
  }

  // Run checks
  await checkExpired();
  await syncProcesses();
  await cleanupOrphanedLabels(summary.githubActive);

  // Clean up old workspaces
  const workspacesCleaned = cleanupOldWorkspaces();

  // Clean up old archived logs (independent retention policy from workspaces)
  const archivesCleaned = cleanupOldArchives();

  // Log cleanup event if anything was actually removed
  if (workspacesCleaned > 0 || archivesCleaned > 0) {
    logEvent('watchdog.cleanup',
      `Cleaned ${workspacesCleaned} workspace${workspacesCleaned !== 1 ? 's' : ''}, ${archivesCleaned} archive${archivesCleaned !== 1 ? 's' : ''}`,
      { workspaces: workspacesCleaned, archives: archivesCleaned }
    );
  }

  // Periodic maintenance: prune stale entries from dedup cache
  github.pruneReleasedAgents();
}

// Start watchdog daemon
export function start(options?: { quiet?: boolean }): void {
  if (watchdogInterval) {
    if (!options?.quiet) log('Watchdog already running');
    return;
  }

  const daemonCfg = getDaemonConfig();
  if (!options?.quiet) {
    log(`🐕 Watchdog starting (interval: ${daemonCfg.watchdogIntervalSec}s)`);
  }

  // Run first check after a short delay to keep startup clean
  setTimeout(() => check(), 2000);

  // Then run on interval
  watchdogInterval = setInterval(check, daemonCfg.watchdogIntervalSec * 1000);
}

// Stop watchdog daemon
export function stop(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    log('🐕 Watchdog stopped');
  }
}

// Get status (for Telegram commands)
export async function getStatus(): Promise<{
  running: boolean;
  local: registry.LocalAgent[];
  github: github.GitHubAgent[];
}> {
  let githubAgents: github.GitHubAgent[] = [];

  // Try the shared GraphQL cache first (avoids a direct gh CLI call)
  const cached = getCachedIssues();
  if (cached) {
    const activeIssues = getActiveFromCache(cached);
    githubAgents = activeIssues.map(issue => {
      const roleLabel = issue.labels.find(l => l.startsWith('fritz.skill:'));
      const role = roleLabel ? roleLabel.replace('fritz.skill:', '') : 'implement';
      return {
        issue: issue.number,
        title: issue.title,
        role: role as github.GitHubAgent['role'],
        status: 'working' as const,
      };
    });
  } else {
    // Fallback: direct gh CLI call (cache not yet populated)
    try {
      githubAgents = await github.getActiveAgents();
    } catch {
      // GitHub not available
    }
  }

  return {
    running: watchdogInterval !== null,
    local: registry.listAgents(),
    github: githubAgents,
  };
}
