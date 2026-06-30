/**
 * Dashboard route handler + SSE manager.
 *
 * Serves the dashboard SPA and provides real-time updates via Server-Sent Events.
 * Aggregates data from registry, autoloop, log-archive, and agents.
 * Provides operational controls (stop, boot, autoloop toggle) via POST endpoints.
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec, execSync } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
import * as registry from '../core/registry.js';
import type { LocalAgent } from '../core/registry.js';
import * as autoloop from '../agents/autoloop.js';
import * as logArchive from '../agents/log-archive.js';
import type { AgentLogSummary } from '../agents/log-archive.js';
import * as agents from '../agents/agents.js';
import * as github from '../github/github.js';
import { MAX_REWORK_CYCLES, DEPENDS_ON_PREFIX } from '../github/github.js';
import { getCachedIssues, fetchAllOpenIssues, refreshIssuesCache, type CachedIssue } from '../github/github-graphql.js';
import { cachedGhApiAsync, getRateLimitState } from '../github/github-cache.js';
import * as githubWriteQueue from '../github/github-write-queue.js';
import type { WriteQueueStats } from '../github/github-write-queue.js';
import { getDaemonConfig, getMaxParallelAgents, setMaxParallelAgents, persistMaxParallelAgents, getRoleModel, getUsageConfig, getConfigPath, resetConfigCache, getNotificationMode, setNotificationMode, isValidNotificationMode, getCommentLevel, setCommentLevel, isValidCommentLevel } from '../agents/fritz-config.js';
import * as usageMonitor from '../agents/usage-monitor.js';
import type { CachedUsageData } from '../agents/usage-monitor.js';
import { config } from '../config.js';
import type { AgentRole } from '../types.js';
import { logEvent, getRecentEvents, onEventLogEntry, getEventsSince } from '../core/event-log.js';
import { getOrchestratorHistory } from '../orchestrator/orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardAgent {
  name: string;
  role: string;
  issue: number | null;
  issueTitle: string | null;
  issueUrl: string | null;     // URL to the issue in the tracker repo (config.githubRepo)
  repo: string | null;         // Target code repo (may differ from issue tracker repo)
  branch: string | null;
  started: string;
  ttl: number;
  elapsed: number;
  remaining: number | null;
  lastActivity: string | null;
  lastActivityAt: string | null;
  model: string;
  claudeCodeVersion: string | null;
  autoPipeline: boolean;
}

interface CuratedLabel {
  category: 'type' | 'language' | 'repo' | 'auto-pipeline' | 'skill';
  value: string;
  raw: string;
}

interface IssueItem {
  number: number;
  title: string;
  status: string;                // fritz.status value or 'none'
  statusLabels: string[];        // All fritz.status:* labels (for multi-label removal)
  priority: number | null;       // 0-3 or null
  labels: CuratedLabel[];
  rawLabels: string[];           // All raw label names (for workflow rework detection etc.)
  blocked: boolean;              // Has open dependencies
  blockedBy: number[];           // Open dependency issue numbers
  dependsOn: number[];           // All fritz.depends-on values
  dependsOnResolved: number[];   // Closed dependency issue numbers
  updatedAt: string;             // ISO timestamp
  createdAt: string;             // ISO timestamp
  url: string;                   // GitHub issue URL
}

interface QueuedIssue {
  number: number;
  title: string;
  status: string;
  nextRole: string;
  priority: number | null;
  blocked: boolean;
  blockedBy: number[];
  labels: CuratedLabel[];
}

interface HistoryEntry {
  name: string;
  role: string;
  issue: number | null;
  issueTitle: string | null;
  issueUrl: string | null;     // URL to the issue in the tracker repo (config.githubRepo)
  repo: string | null;         // Target code repo (may differ from issue tracker repo)
  branch: string | null;
  started: string;
  ended: string;
  duration: string;
  exitStatus: 'completed' | 'dead' | 'expired' | 'stopped' | 'unknown';
  exitCode: number | null;
  exitReason: string | null;
  turns: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  lastActivity: string | null;
  model: string;
  subagentCount: number;
  lang: string | null;
}

interface SystemStatus {
  autoloopRunning: boolean;
  autoloopPaused: boolean;
  autoloopManuallyPaused: boolean;
  usagePaused: boolean;
  usageOverride: boolean;
  usage: CachedUsageData | null;
  usageLastCheck: string | null;
  usageAuthMode: 'oauth_token' | 'credentials_file' | 'none';
  usageAccountName?: string;
  usageMonitorRunning: boolean;
  usageStopReason: string | null;
  activeAgentCount: number;
  maxParallelAgents: number;
  uptime: number;
  rateLimit: {
    writeQueue: WriteQueueStats;
  };
  githubApiQuotaRemaining: number;
  recentFailureStreak: number;
}

interface DashboardState {
  agents: DashboardAgent[];
  history: HistoryEntry[];
  system: SystemStatus;
  timestamp: string;
}

// Valid agent roles for boot validation
const VALID_ROLES: readonly string[] = [
  'implement', 'review', 'validate', 'define',
  'architect', 'ux', 'budget', 'retro', 'security-review', 'pentest',
];

// Agent name validation regex (path traversal prevention)
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Status-to-role mapping — used by workflow pipeline (agent-active detection)
// and retained for API compatibility via getQueueData() export
const STATUS_TO_ROLE: Record<string, string> = {
  'for-define': 'define',
  'for-implement': 'implement',
  'for-architect': 'architect',
  'for-ux': 'ux',
  'for-budget': 'budget',
  'for-review': 'review',
  'for-validate': 'validate',
  'for-security-review': 'security-review',
  'for-pentest': 'pentest',
  'for-rework': 'implement',
};

// Pipeline stages for the workflow funnel view (ordered by flow)
const WORKFLOW_PIPELINE_STAGES = [
  'for-define', 'define', 'defined',
  'for-implement', 'implement',
  'for-review', 'review',
  'for-validate', 'validate', 'validated',
  'for-merge',
  'for-human', 'for-rework',
] as const;

// Human gate stages (pipeline pauses here for operator approval)
const HUMAN_GATE_STAGES = new Set(['defined', 'validated']);

// Agent-active stages (agents work here)
const AGENT_ACTIVE_STAGES = new Set(['define', 'implement', 'review', 'validate']);

// Staleness threshold (7 days in ms)
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

// for-merge stale threshold (30 minutes in ms) — detects stuck CI checks
const FOR_MERGE_STALE_THRESHOLD_MS = 30 * 60 * 1000;

// Dependency staleness threshold (2 hours in ms) — for dependsOnStale flag
const DEP_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let unsubscribeRegistry: (() => void) | null = null;
let unsubscribeUsage: (() => void) | null = null;
let unsubscribeEventLog: (() => void) | null = null;
const daemonStartTime = Date.now();

// Track usage pause state to detect transitions in the usage listener
let prevUsagePaused = false; // initialized in init() after usageMonitor is ready

// Cache for isDependencyClosed results (avoids blocking the event loop)
// Uses async background refresh — never blocks on cache miss.
const DEP_CACHE_TTL_MS = 60_000; // 60 seconds
const depClosedCache = new Map<number, { closed: boolean; expires: number }>();
const depRefreshInFlight = new Set<number>();

function isDependencyClosedCached(dep: number): boolean {
  const cached = depClosedCache.get(dep);
  if (cached !== undefined && Date.now() < cached.expires) return cached.closed;

  // Cache miss or expired — return safe default (assume open) and queue async refresh
  refreshDepCacheAsync(dep);
  return false;
}

function refreshDepCacheAsync(dep: number): void {
  if (depRefreshInFlight.has(dep)) return; // already fetching
  const repo = config.githubRepo;
  if (!repo) return;

  depRefreshInFlight.add(dep);
  cachedGhApiAsync(`repos/${repo}/issues/${dep}`, { ttl: 60_000 })
    .then((raw) => {
      const parsed = JSON.parse(raw);
      depClosedCache.set(dep, { closed: parsed.state === 'closed', expires: Date.now() + DEP_CACHE_TTL_MS });
    })
    .catch((err) => {
      console.error(`[dashboard] refreshDepCacheAsync(#${dep}) failed: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      depRefreshInFlight.delete(dep);
    });
}

// Issues cache (30s TTL — avoids excessive GitHub API calls)
let issuesCache: { data: IssueItem[]; timestamp: number } | null = null;
const ISSUES_CACHE_TTL_MS = 30_000; // 30 seconds

// Background refresh timer for issues cache
let issuesRefreshTimer: NodeJS.Timeout | null = null;

// Recently merged issues cache (5min TTL — merged state is stable)
interface MergedItem {
  number: number;
  title: string;
  closedAt: string;
  autoPipeline: boolean;
  prUrl: string | null;
  labels: string[];
}
let mergedCache: { data: MergedItem[]; timestamp: number } | null = null;
const MERGED_CACHE_TTL_MS = 300_000; // 5 minutes

let mergedRefreshInFlight = false;

/**
 * Returns cached recently-merged data (never blocks the event loop).
 * If the cache is expired, kicks off an async background refresh and
 * returns stale/empty data immediately. The UI tolerates stale merged
 * data since it is cosmetic.
 */
export function getRecentlyMerged(): MergedItem[] {
  if (mergedCache && Date.now() - mergedCache.timestamp < MERGED_CACHE_TTL_MS) {
    return mergedCache.data;
  }
  // Cache miss — trigger async refresh, return stale data immediately
  refreshRecentlyMergedBackground();
  return mergedCache?.data ?? [];
}

export function refreshRecentlyMergedBackground(): void {
  if (mergedRefreshInFlight) return;
  const repo = config.githubRepo;
  if (!repo) return;
  mergedRefreshInFlight = true;
  const cmd = `gh issue list --repo ${repo} --state closed --limit 15 --json number,title,closedAt,labels`;
  exec(cmd, { encoding: 'utf-8', timeout: 15_000 }, (err, stdout) => {
    mergedRefreshInFlight = false;
    if (err) {
      console.error('[dashboard] Failed to fetch recently merged issues:', err);
      return;
    }
    try {
      const raw = (stdout || '').trim();
      if (!raw) { mergedCache = { data: [], timestamp: Date.now() }; return; }
      const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
      const all = JSON.parse(raw) as Array<{ number: number; title: string; closedAt: string; labels: Array<{ name: string }> }>;
      const recent = all.filter(i => i.closedAt >= cutoff);
      const items: MergedItem[] = recent.map(i => {
        const repoLabel = i.labels.find(l => l.name.startsWith('fritz.repo:'));
        const targetRepo = repoLabel ? repoLabel.name.replace('fritz.repo:', '') : repo;
        return {
          number: i.number,
          title: i.title,
          closedAt: i.closedAt,
          autoPipeline: i.labels.some(l => l.name === 'fritz.auto-pipeline'),
          prUrl: `https://github.com/${targetRepo}`,
          labels: i.labels.map(l => l.name),
        };
      });
      mergedCache = { data: items, timestamp: Date.now() };
    } catch (parseErr) {
      console.error('[dashboard] Failed to parse recently merged issues:', parseErr);
    }
  });
}

/** Reset merged-data cache and in-flight guard (test-only). */
export function _resetMergedCache(): void {
  mergedCache = null;
  mergedRefreshInFlight = false;
}

/**
 * Invalidates the merged cache and eagerly kicks off a background refresh
 * when a PR has just been merged. Wired into the event-log subscription in
 * init() so that dashboard clients see the freshly-merged issue on their
 * next loadWorkflow fetch instead of a stale 5-minute cache.
 *
 * Exported (named, not underscore-prefixed) so the handleEventLogEntry test
 * below can call it directly — the production caller is the onEventLogEntry
 * subscription installed in init().
 */
export function handleEventLogEntryForMergedCache(entry: { type: string }): void {
  if (entry.type !== 'pr.merged') return;
  mergedCache = null;
  refreshRecentlyMergedBackground();
}

function invalidateIssuesCache(): Promise<void> {
  issuesCache = null;
  // Force-refresh the GraphQL cache (bypasses TTL) so next workflow fetch gets fresh data
  return triggerBackgroundRefresh(true);
}

function triggerBackgroundRefresh(force = false): Promise<void> {
  const repo = config.githubRepo;
  if (!repo) return Promise.resolve();
  const [owner, name] = repo.split('/');
  if (!owner || !name) return Promise.resolve();
  if (force) {
    return refreshIssuesCache(owner, name).then(() => {}).catch(() => {});
  } else {
    return fetchAllOpenIssues(owner, name).then(() => {}).catch(() => {});
  }
}

/**
 * Transform a CachedIssue from the GraphQL cache into the dashboard's IssueItem format.
 */
function cachedIssueToIssueItem(issue: CachedIssue): IssueItem {
  const labelNames = issue.labels;
  const allStatusLabels = labelNames.filter(l => l.startsWith('fritz.status:'));
  const statusLabel = allStatusLabels[0];
  const status = statusLabel ? statusLabel.replace('fritz.status:', '') : 'none';
  const priorityLabel = labelNames.find(l => l.startsWith('priority:p'));
  const priority = priorityLabel
    ? parseInt(priorityLabel.replace('priority:p', ''), 10)
    : null;
  const allDeps = github.parseDependenciesFromLabels(labelNames);
  const resolvedDeps: number[] = [];
  const openDeps: number[] = [];
  for (const dep of allDeps) {
    (isDependencyClosedCached(dep) ? resolvedDeps : openDeps).push(dep);
  }

  return {
    number: issue.number,
    title: issue.title,
    status,
    statusLabels: allStatusLabels,
    priority: priority !== null && !isNaN(priority) ? priority : null,
    labels: parseCuratedLabels(labelNames),
    rawLabels: labelNames,
    blocked: openDeps.length > 0,
    blockedBy: openDeps,
    dependsOn: allDeps,
    dependsOnResolved: resolvedDeps,
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    url: config.githubRepo
      ? `https://github.com/${config.githubRepo}/issues/${issue.number}`
      : '',
  };
}

function getIssuesData(): IssueItem[] {
  if (issuesCache && Date.now() - issuesCache.timestamp < ISSUES_CACHE_TTL_MS) {
    return issuesCache.data;
  }

  // Cache-only read from the shared GraphQL cache (populated by background refresh timer).
  // Never blocks — returns [] if cache is cold (first few seconds after startup).
  const cached = getCachedIssues();
  if (!cached) return issuesCache?.data ?? [];

  try {
    const items = cached.map(cachedIssueToIssueItem);
    issuesCache = { data: items, timestamp: Date.now() };
    return items;
  } catch (err) {
    console.error('[dashboard] Failed to transform GraphQL cached issues:', err);
    return issuesCache?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Workflow data computation
// ---------------------------------------------------------------------------

interface WorkflowPipelineStage {
  count: number;
  agentActive: boolean;
  activeCount: number;
  humanGate: boolean;
}

interface AttentionItem {
  number: number;
  title: string;
  status: string;
  tier: 'escalated' | 'awaiting_approval' | 'merging' | 'blocked' | 'stale';
  priority: string | null;
  waitingSince: string;
  waitingDuration: string;
  reworkCycle: number | null;
  reworkMax: number;
  context: string;
  blockedBy: number[] | null;
  url: string;
  labels: CuratedLabel[];
  autoPipeline: boolean;
  dependsOn: number[];
  dependsOnResolved: number[];
  dependsOnStale: boolean;
  paused: boolean;
}

interface QueuedItem {
  number: number;
  title: string;
  status: string;
  nextRole: string;
  priority: string | null;
  waitingSince: string;
  waitingDuration: string;
  blocked: boolean;
  blockedBy: number[];
  labels: CuratedLabel[];
  rawLabels: string[];
  autoPipeline: boolean;
  url: string;
  dependsOn: number[];
  dependsOnResolved: number[];
  paused: boolean;
}

interface DependencyChain {
  id: string; // 'A', 'B', 'C', etc.
  issues: number[];
  color: string;
}

interface WorkflowData {
  pipeline: Record<string, WorkflowPipelineStage>;
  attention: AttentionItem[];
  blocked: AttentionItem[];
  queued: QueuedItem[];
  merged: MergedItem[];
  velocity: UsageVelocity;
  summary: {
    totalOpen: number;
    needsAttention: number;
    blocked: number;
    movingAutonomously: number;
  };
  autoloopIntervalSec: number;
  autoloopRunning: boolean;
  chains: DependencyChain[];
}

function formatWaitDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

const CHAIN_COLORS = ['teal', 'purple', 'accent', 'orange', 'yellow', 'green', 'red'];

function computeDependencyChains(items: Array<{ number: number; dependsOn: number[]; dependsOnResolved: number[] }>): DependencyChain[] {
  // Build adjacency list from dependency relationships
  const graph = new Map<number, Set<number>>();
  const allIssueNumbers = new Set(items.map(i => i.number));

  for (const item of items) {
    if (!graph.has(item.number)) graph.set(item.number, new Set());
    for (const dep of [...item.dependsOn, ...item.dependsOnResolved]) {
      if (!allIssueNumbers.has(dep)) continue; // only link to issues in the current view
      if (!graph.has(dep)) graph.set(dep, new Set());
      graph.get(item.number)!.add(dep);
      graph.get(dep)!.add(item.number);
    }
  }

  // Find connected components via BFS
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const issueNum of graph.keys()) {
    if (visited.has(issueNum)) continue;
    const component: number[] = [];
    const queue = [issueNum];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of graph.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length > 1) { // Only chains with 2+ issues
      components.push(component.sort((a, b) => a - b));
    }
  }

  // Sort components by smallest issue number and assign chain IDs
  components.sort((a, b) => a[0] - b[0]);

  return components.map((issues, idx) => ({
    id: String.fromCharCode(65 + idx), // A, B, C, ...
    issues,
    color: CHAIN_COLORS[idx % CHAIN_COLORS.length],
  }));
}

// ---------------------------------------------------------------------------
// Usage velocity computation
// ---------------------------------------------------------------------------

interface VelocityWindow {
  minutes: number;
  fiveHourDelta: number | null;   // % change
  sevenDayDelta: number | null;
  sevenDayOpusDelta: number | null;
  avgAgents: number | null;       // avg active agents in window
}

interface RunCount {
  minutes: number;
  runs: number;
}

interface UsageVelocity {
  windows: VelocityWindow[];
  runCounts: RunCount[];
  // Recommended max agents based on burn rate and remaining capacity
  recommendedMaxAgents: number | null;
  bottleneck: string | null; // which window is the constraint
}

function computeUsageVelocity(): UsageVelocity {
  const snapshots = usageMonitor.getUsageSnapshots();
  const usage = usageMonitor.getUsageData();
  const now = Date.now();
  const windowMins = [10, 30, 60];

  const windows: VelocityWindow[] = windowMins.map(mins => {
    const cutoff = now - mins * 60_000;
    const older = snapshots.filter(s => new Date(s.timestamp).getTime() <= cutoff);
    if (older.length === 0) {
      return { minutes: mins, fiveHourDelta: null, sevenDayDelta: null, sevenDayOpusDelta: null, avgAgents: null };
    }
    // Use the snapshot closest to the cutoff
    const baseline = older[older.length - 1];
    const latest = snapshots[snapshots.length - 1];
    if (!latest) {
      return { minutes: mins, fiveHourDelta: null, sevenDayDelta: null, sevenDayOpusDelta: null, avgAgents: null };
    }

    // Compute avg agent count across snapshots in this window
    const inWindow = snapshots.filter(s => new Date(s.timestamp).getTime() >= cutoff);
    const avgAgents = inWindow.length > 0
      ? inWindow.reduce((sum, s) => sum + s.agentCount, 0) / inWindow.length
      : null;

    return {
      minutes: mins,
      fiveHourDelta: +(latest.fiveHourPct - baseline.fiveHourPct).toFixed(1),
      sevenDayDelta: +(latest.sevenDayPct - baseline.sevenDayPct).toFixed(1),
      sevenDayOpusDelta: latest.sevenDayOpusPct !== null && baseline.sevenDayOpusPct !== null
        ? +(latest.sevenDayOpusPct - baseline.sevenDayOpusPct).toFixed(1)
        : null,
      avgAgents: avgAgents !== null ? +avgAgents.toFixed(1) : null,
    };
  });

  // Compute recommended max agents from 10-min window (most responsive)
  let recommendedMaxAgents: number | null = null;
  let bottleneck: string | null = null;

  if (usage && windows[0].fiveHourDelta !== null && windows[0].avgAgents !== null && windows[0].avgAgents > 0) {
    const w = windows[0]; // 10-min window
    const dims: Array<{ label: string; remaining: number; resetsInMin: number; delta: number }> = [];

    if (w.fiveHourDelta !== null && w.fiveHourDelta > 0) {
      const remaining = 80 - usage.fiveHour.utilization; // 80% safety threshold
      const resetsIn = usage.fiveHour.resetsAt
        ? Math.max(1, (new Date(usage.fiveHour.resetsAt).getTime() - now) / 60_000)
        : 300; // assume 5h if unknown
      dims.push({ label: '5h window', remaining, resetsInMin: resetsIn, delta: w.fiveHourDelta });
    }
    if (w.sevenDayDelta !== null && w.sevenDayDelta > 0) {
      const remaining = 80 - usage.sevenDay.utilization;
      const resetsIn = usage.sevenDay.resetsAt
        ? Math.max(1, (new Date(usage.sevenDay.resetsAt).getTime() - now) / 60_000)
        : 10080;
      dims.push({ label: '7d quota', remaining, resetsInMin: resetsIn, delta: w.sevenDayDelta });
    }
    if (usage.sevenDayOpus && w.sevenDayOpusDelta !== null && w.sevenDayOpusDelta > 0) {
      const remaining = 80 - usage.sevenDayOpus.utilization;
      const resetsIn = usage.sevenDayOpus.resetsAt
        ? Math.max(1, (new Date(usage.sevenDayOpus.resetsAt).getTime() - now) / 60_000)
        : 10080;
      dims.push({ label: '7d Opus', remaining, resetsInMin: resetsIn, delta: w.sevenDayOpusDelta });
    }

    if (dims.length > 0) {
      // For each dimension: burn rate per agent per 10min = delta / avgAgents
      // Time-to-exhaust at N agents = remaining / (burnPerAgent * N) * 10 minutes
      // We want time-to-exhaust >= resetsInMin, so:
      // N <= remaining / (burnPerAgent * resetsInMin / 10)
      let minMax = Infinity;
      for (const d of dims) {
        const burnPerAgent10m = d.delta / w.avgAgents!;
        const maxN = d.remaining / (burnPerAgent10m * (d.resetsInMin / 10));
        if (maxN < minMax) {
          minMax = maxN;
          bottleneck = d.label;
        }
      }
      recommendedMaxAgents = Math.max(1, Math.floor(minMax));
    }
  }

  // Count completed agent runs per time window
  const allArchived = logArchive.listArchivedAgents({ since: new Date(now - 60 * 60_000).toISOString() });
  const runCounts: RunCount[] = windowMins.map(mins => {
    const cutoff = new Date(now - mins * 60_000).toISOString();
    const runs = allArchived.filter(a => a.summary?.ended && a.summary.ended >= cutoff).length;
    return { minutes: mins, runs };
  });

  return { windows, runCounts, recommendedMaxAgents, bottleneck };
}

function getWorkflowData(): WorkflowData {
  const issues = getIssuesData();
  const activeAgents = registry.listAgents();
  const now = Date.now();

  // Build issues lookup for dependency staleness checks
  const issuesByNumber = new Map<number, IssueItem>();
  for (const issue of issues) {
    issuesByNumber.set(issue.number, issue);
  }

  // Build pipeline stage counts
  const pipeline: Record<string, WorkflowPipelineStage> = {};
  for (const stage of WORKFLOW_PIPELINE_STAGES) {
    let activeCount = 0;
    if (AGENT_ACTIVE_STAGES.has(stage)) {
      const expectedRole = STATUS_TO_ROLE[`for-${stage}`] ?? stage;
      activeCount = activeAgents.filter(a => a.role === expectedRole || a.role === stage).length;
    }
    pipeline[stage] = {
      count: 0,
      agentActive: activeCount > 0,
      activeCount,
      humanGate: HUMAN_GATE_STAGES.has(stage),
    };
  }

  // Count issues per stage
  for (const issue of issues) {
    if (issue.status in pipeline) {
      pipeline[issue.status].count++;
    }
  }

  // Build attention items (blocked issues are tracked separately)
  const attention: AttentionItem[] = [];
  const blocked: AttentionItem[] = [];

  for (const issue of issues) {
    const waitMs = now - new Date(issue.updatedAt).getTime();
    const waitDuration = formatWaitDuration(waitMs);
    const priorityStr = issue.priority !== null ? `P${issue.priority}` : null;

    // Tier 1: Escalated (for-human)
    if (issue.status === 'for-human') {
      // Extract rework cycle from raw labels
      const reworkLabel = issue.rawLabels.find(l => l.startsWith('fritz.rework:'));
      const reworkCycle = reworkLabel
        ? parseInt(reworkLabel.replace('fritz.rework:', ''), 10)
        : null;

      attention.push({
        number: issue.number,
        title: issue.title,
        status: issue.status,
        tier: 'escalated',
        priority: priorityStr,
        waitingSince: issue.updatedAt,
        waitingDuration: waitDuration,
        reworkCycle: reworkCycle !== null && !isNaN(reworkCycle) ? reworkCycle : null,
        reworkMax: MAX_REWORK_CYCLES,
        context: reworkCycle !== null && !isNaN(reworkCycle)
          ? `Rework cycle ${reworkCycle}/${MAX_REWORK_CYCLES} — exceeded max rework attempts`
          : 'Escalated to human — needs manual intervention',
        blockedBy: null,
        url: issue.url,
        labels: parseCuratedLabels(issue.rawLabels),
        autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
        dependsOn: issue.dependsOn ?? [],
        dependsOnResolved: issue.dependsOnResolved ?? [],
        dependsOnStale: false,
        paused: issue.rawLabels.includes('fritz.paused'),
      });
      continue;
    }

    // Tier 2: Awaiting approval (human gates: defined, validated)
    if (HUMAN_GATE_STAGES.has(issue.status)) {
      attention.push({
        number: issue.number,
        title: issue.title,
        status: issue.status,
        tier: 'awaiting_approval',
        priority: priorityStr,
        waitingSince: issue.updatedAt,
        waitingDuration: waitDuration,
        reworkCycle: null,
        reworkMax: MAX_REWORK_CYCLES,
        context: issue.status === 'defined'
          ? `Spec ready — waiting for approval`
          : `Validation passed — waiting for merge approval`,
        blockedBy: null,
        url: issue.url,
        labels: parseCuratedLabels(issue.rawLabels),
        autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
        dependsOn: issue.dependsOn ?? [],
        dependsOnResolved: issue.dependsOnResolved ?? [],
        dependsOnStale: false,
        paused: issue.rawLabels.includes('fritz.paused'),
      });
      continue;
    }

    // Tier 3: Merging (for-merge — autoloop will handle CI checks + merge)
    // Issues in for-merge for >30 min are flagged as stale (CI may be stuck)
    if (issue.status === 'for-merge') {
      const isForMergeStale = waitMs > FOR_MERGE_STALE_THRESHOLD_MS;
      attention.push({
        number: issue.number,
        title: issue.title,
        status: issue.status,
        tier: isForMergeStale ? 'stale' : 'merging',
        priority: priorityStr,
        waitingSince: issue.updatedAt,
        waitingDuration: waitDuration,
        reworkCycle: null,
        reworkMax: MAX_REWORK_CYCLES,
        context: isForMergeStale
          ? `In for-merge for ${formatWaitDuration(waitMs)} — CI checks may be stuck`
          : 'Merge approved — waiting for CI checks',
        blockedBy: null,
        url: issue.url,
        labels: parseCuratedLabels(issue.rawLabels),
        autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
        dependsOn: issue.dependsOn ?? [],
        dependsOnResolved: issue.dependsOnResolved ?? [],
        dependsOnStale: false,
        paused: issue.rawLabels.includes('fritz.paused'),
      });
      continue;
    }

    // Tier 4: Blocked (has unresolved dependencies)
    // Note: for-merge issues are already handled above (merging tier) and won't reach here
    if (issue.blocked && issue.blockedBy.length > 0) {
      // Check if any blocking dependency has last activity >2h ago.
      // Note: updatedAt reflects any GitHub activity (comments, label changes, etc.)
      // — not just agent progress. A label change resets the stale timer.
      const depStale = issue.blockedBy.some(depNum => {
        const dep = issuesByNumber.get(depNum);
        if (!dep) return true; // unknown dependency → treat as stale
        return (now - new Date(dep.updatedAt).getTime()) > DEP_STALE_THRESHOLD_MS;
      });

      blocked.push({
        number: issue.number,
        title: issue.title,
        status: issue.status,
        tier: 'blocked',
        priority: priorityStr,
        waitingSince: issue.updatedAt,
        waitingDuration: waitDuration,
        reworkCycle: null,
        reworkMax: MAX_REWORK_CYCLES,
        context: `Blocked by: ${issue.blockedBy.map(n => '#' + n).join(', ')}`,
        blockedBy: issue.blockedBy,
        url: issue.url,
        labels: parseCuratedLabels(issue.rawLabels),
        autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
        dependsOn: issue.dependsOn ?? [],
        dependsOnResolved: issue.dependsOnResolved ?? [],
        dependsOnStale: depStale,
        paused: issue.rawLabels.includes('fritz.paused'),
      });
      continue;
    }

    // Tier 5: Stale (no activity for 7+ days, not actively being worked on)
    // Covers both for-* statuses (queued but not picked up) and agent-active statuses
    // (define/implement/review/validate) with no active agent (agent may have crashed)
    const isForStatus = issue.status.startsWith('for-') && issue.status !== 'for-human';
    const isStuckAgentStatus = AGENT_ACTIVE_STAGES.has(issue.status);
    if ((isForStatus || isStuckAgentStatus) && waitMs > STALE_THRESHOLD_MS) {
      // Exclude if an agent is currently working on this issue
      const hasActiveAgent = activeAgents.some(a => a.issue === issue.number);
      if (!hasActiveAgent) {
        const staleContext = isStuckAgentStatus
          ? `In ${issue.status} status with no active agent for ${formatWaitDuration(waitMs)} — agent may have crashed`
          : `No agent activity for ${formatWaitDuration(waitMs)} — autoloop may have skipped this`;
        attention.push({
          number: issue.number,
          title: issue.title,
          status: issue.status,
          tier: 'stale',
          priority: priorityStr,
          waitingSince: issue.updatedAt,
          waitingDuration: waitDuration,
          reworkCycle: null,
          reworkMax: MAX_REWORK_CYCLES,
          context: staleContext,
          blockedBy: null,
          url: issue.url,
          labels: parseCuratedLabels(issue.rawLabels),
          autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
          dependsOn: issue.dependsOn ?? [],
          dependsOnResolved: issue.dependsOnResolved ?? [],
          dependsOnStale: false,
          paused: issue.rawLabels.includes('fritz.paused'),
        });
      }
    }
  }

  // Sort attention items: by tier priority, then by priority (P0 first), then by wait time (longest first)
  const tierOrder: Record<string, number> = { escalated: 0, awaiting_approval: 1, merging: 2, blocked: 3, stale: 4 };
  attention.sort((a, b) => {
    const tierDiff = (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99);
    if (tierDiff !== 0) return tierDiff;
    // Within same tier: priority (lower number = higher priority)
    const ap = a.priority ? parseInt(a.priority.replace('P', ''), 10) : 99;
    const bp = b.priority ? parseInt(b.priority.replace('P', ''), 10) : 99;
    if (ap !== bp) return ap - bp;
    // Then by wait time (longest first)
    return new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime();
  });

  // Build queued items: issues with for-* statuses (excluding for-human) that are waiting for agents
  const queued: QueuedItem[] = [];
  for (const issue of issues) {
    if (!issue.status.startsWith('for-') || issue.status === 'for-human') continue;
    // Exclude issues that already have an active agent
    const hasActiveAgent = activeAgents.some(a => a.issue === issue.number);
    if (hasActiveAgent) continue;
    // Exclude issues with unresolved deps — they belong in Blocked, not Ready
    if (issue.blocked && issue.blockedBy.length > 0) continue;
    const waitMs = now - new Date(issue.updatedAt).getTime();
    const nextRole = STATUS_TO_ROLE[issue.status] ?? issue.status.replace('for-', '');
    queued.push({
      number: issue.number,
      title: issue.title,
      status: issue.status,
      nextRole,
      priority: issue.priority !== null ? `P${issue.priority}` : null,
      waitingSince: issue.updatedAt,
      waitingDuration: formatWaitDuration(waitMs),
      blocked: issue.blocked,
      blockedBy: issue.blockedBy,
      labels: issue.labels,
      rawLabels: issue.rawLabels,
      autoPipeline: issue.rawLabels.includes('fritz.auto-pipeline'),
      url: issue.url,
      dependsOn: issue.dependsOn ?? [],
      dependsOnResolved: issue.dependsOnResolved ?? [],
      paused: issue.rawLabels.includes('fritz.paused'),
    });
  }
  // Sort queued: priority first (P0 before P3), then by wait time (longest first)
  queued.sort((a, b) => {
    const ap = a.priority ? parseInt(a.priority.replace('P', ''), 10) : 99;
    const bp = b.priority ? parseInt(b.priority.replace('P', ''), 10) : 99;
    if (ap !== bp) return ap - bp;
    return new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime();
  });

  const needsAttention = attention.length;
  const totalOpen = issues.length;

  // Build dependency chains from connected components
  const allItems = [...queued, ...attention, ...blocked];
  const chains = computeDependencyChains(allItems);

  return {
    pipeline,
    attention,
    blocked,
    queued,
    merged: getRecentlyMerged(),
    velocity: computeUsageVelocity(),
    summary: {
      totalOpen,
      needsAttention,
      blocked: blocked.length,
      movingAutonomously: totalOpen - needsAttention - blocked.length,
    },
    autoloopIntervalSec: autoloop.getLoopInterval(),
    autoloopRunning: autoloop.isRunning(),
    chains,
  };
}


// Label whitelist for dashboard label management
const ALLOWED_LABEL_PATTERNS = [
  /^fritz\.status:(inbox|backlog|for-define|defined|for-implement|active|for-review|for-validate|validated|for-merge|discussion|for-rework|for-human|for-architect|for-ux|for-budget|for-security-review|for-pentest|accepted)$/,
  /^priority:p[0-3]$/,
  /^fritz\.depends-on:\d+$/,
  /^fritz\.auto-pipeline$/,
  /^fritz\.paused$/,
];

function isLabelAllowed(label: string): boolean {
  return ALLOWED_LABEL_PATTERNS.some(re => re.test(label));
}

// ---------------------------------------------------------------------------
// Retro metrics parser (issue #509)
// ---------------------------------------------------------------------------

interface RetroScan {
  date: string;
  mode: string;
  agents: number;
  avgCacheTokens: string;
  failureRate: string;
  reworkPct: string;
  avgDuration: string;
  experiments: string;
  notes: string[];
}

interface RolePerformanceByPeriod {
  scanDate: string;
  role: string;
  agents: number;
  avgDuration: string;
  medianDuration: string;
  avgCacheTokens: string;
  failureRate: string;
  subagentPct: string;
}

interface TrendEntry {
  role: string;
  durationDelta: string;
  tokensDelta: string;
  subagentDelta: string;
  notes: string;
}

interface RetroExperiment {
  name: string;
  date: string;
  result: string;
  adopted: boolean | null;
}

type RetroSource = 'github' | 'local' | 'cache';

interface RetroData {
  scans: RetroScan[];
  rolePerformance: Record<string, RolePerformanceByPeriod[]>;
  trends: TrendEntry[];
  experiments: RetroExperiment[];
  lastUpdated: string;
  parseErrors: string[];
  source?: RetroSource;
}

interface RetroResult {
  data: RetroData;
  source: RetroSource;
}

// Cache for parsed retro data (120s TTL with SHA invalidation)
let retroCache: { data: RetroData; sha: string; expires: number; source: RetroSource } | null = null;
let inflightFetch: Promise<RetroResult | null> | null = null;
const RETRO_CACHE_TTL_MS = 120_000;

/** Clear the retro cache (for testing). */
export function clearRetroCache(): void {
  retroCache = null;
  inflightFetch = null;
  ghFallbackWarningLogged = false;
}

function getRetroMetricsPath(): string {
  return resolve(config.fritzRoot, 'fritz/knowledge/RETRO-METRICS.md');
}

/**
 * Parse a Markdown table row into an array of trimmed cell values.
 * Handles leading/trailing pipes and ignores separator rows (---|---).
 */
function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  // Skip separator rows
  if (/^\|[\s-:|]+\|$/.test(trimmed)) return null;
  const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
  return cells.length > 0 ? cells : null;
}

/**
 * Parse raw RETRO-METRICS.md content into structured retro data.
 * Pure function — no I/O, independently testable.
 */
export function parseRetroMetricsContent(content: string): RetroData {
  const lines = content.split('\n');
  const parseErrors: string[] = [];

  const scans: RetroScan[] = [];
  const rolePerformance: Record<string, RolePerformanceByPeriod[]> = {};
  const trends: TrendEntry[] = [];
  const experiments: RetroExperiment[] = [];
  const scanNotes: Record<string, string[]> = {};

  let section = '';
  let currentScanDate = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section headers
    if (line.startsWith('## Metrics History')) {
      section = 'metrics';
      continue;
    }
    if (line.startsWith('## Role Performance')) {
      section = 'role-performance';
      continue;
    }
    if (line.startsWith('## Trends')) {
      section = 'trends';
      continue;
    }
    if (line.startsWith('## Experiment')) {
      section = 'experiments';
      continue;
    }
    if (line.startsWith('## Notes')) {
      section = 'notes';
      continue;
    }
    // Sub-headers within sections
    if (line.startsWith('### ') && section === 'metrics') {
      // Column definitions sub-header — skip
      continue;
    }
    if (line.startsWith('### ') && section === 'role-performance') {
      // Extract scan end-date from "### Scan N (start-date to end-date)" header
      // Use the end date (second date) to match the scan date in Metrics History
      const endDateMatch = line.match(/to\s+(\d{4}-\d{2}-\d{2})/);
      if (endDateMatch) {
        currentScanDate = endDateMatch[1];
      } else {
        // Fallback: single-date header like "### Scan 1 (2026-02-20 — Baseline)"
        const dateMatch = line.match(/\((\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          currentScanDate = dateMatch[1];
        }
      }
      continue;
    }
    if (line.startsWith('### ') && section === 'notes') {
      // Notes sub-header like "### 2026-02-25 — Scan 2"
      const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentScanDate = dateMatch[1];
        if (!scanNotes[currentScanDate]) scanNotes[currentScanDate] = [];
      }
      continue;
    }

    // Parse table rows based on current section
    if (section === 'metrics') {
      const cells = parseTableRow(line);
      if (!cells || cells.length < 7) continue;
      // Skip header row
      if (cells[0] === 'Date') continue;
      try {
        scans.push({
          date: cells[0],
          mode: cells[1],
          agents: parseInt(cells[2], 10) || 0,
          avgCacheTokens: cells[3],
          failureRate: cells[4],
          reworkPct: cells[5],
          avgDuration: cells[6],
          experiments: cells[7] || '—',
          notes: [],
        });
      } catch {
        parseErrors.push(`Failed to parse metrics row at line ${i + 1}`);
      }
    }

    if (section === 'role-performance' && currentScanDate) {
      const cells = parseTableRow(line);
      if (!cells || cells.length < 7) continue;
      if (cells[0] === 'Role') continue;
      try {
        if (!rolePerformance[currentScanDate]) rolePerformance[currentScanDate] = [];
        rolePerformance[currentScanDate].push({
          scanDate: currentScanDate,
          role: cells[0],
          agents: parseInt(cells[1], 10) || 0,
          avgDuration: cells[2],
          medianDuration: cells[3],
          avgCacheTokens: cells[4],
          failureRate: cells[5],
          subagentPct: cells[6],
        });
      } catch {
        parseErrors.push(`Failed to parse role performance row at line ${i + 1}`);
      }
    }

    if (section === 'trends') {
      const cells = parseTableRow(line);
      if (!cells || cells.length < 5) continue;
      if (cells[0] === 'Role') continue;
      try {
        trends.push({
          role: cells[0],
          durationDelta: cells[1],
          tokensDelta: cells[2],
          subagentDelta: cells[3],
          notes: cells[4] || '',
        });
      } catch {
        parseErrors.push(`Failed to parse trends row at line ${i + 1}`);
      }
    }

    if (section === 'experiments') {
      const cells = parseTableRow(line);
      if (!cells || cells.length < 4) continue;
      if (cells[0] === 'Experiment') continue;
      // Skip placeholder rows
      if (cells[0].startsWith('(no experiment')) continue;
      try {
        experiments.push({
          name: cells[0],
          date: cells[1],
          result: cells[2],
          adopted: cells[3] === '—' ? null : cells[3].toLowerCase() === 'yes',
        });
      } catch {
        parseErrors.push(`Failed to parse experiment row at line ${i + 1}`);
      }
    }

    if (section === 'notes' && currentScanDate) {
      // Capture bullet points
      const bulletMatch = line.match(/^\s*-\s+(.+)/);
      if (bulletMatch) {
        if (!scanNotes[currentScanDate]) scanNotes[currentScanDate] = [];
        scanNotes[currentScanDate].push(bulletMatch[1].trim());
      }
    }
  }

  // Attach notes to scans
  for (const scan of scans) {
    scan.notes = scanNotes[scan.date] || [];
  }

  // Derive lastUpdated from the most recent scan date (first row)
  // Guard against malformed dates that would cause RangeError from toISOString()
  const parsedDate = scans.length > 0 ? new Date(scans[0].date + 'T00:00:00Z') : null;
  const lastUpdated = (parsedDate && !isNaN(parsedDate.getTime()))
    ? parsedDate.toISOString()
    : new Date().toISOString();

  return {
    scans,
    rolePerformance,
    trends,
    experiments,
    lastUpdated,
    parseErrors,
  };
}

// ---------------------------------------------------------------------------
// GitHub Contents API fetcher with local-filesystem fallback
// ---------------------------------------------------------------------------

const GITHUB_FETCH_TIMEOUT_MS = 3_000;

let ghFallbackWarningLogged = false;

/** Result from fetching retro metrics content (GitHub API or local filesystem). */
interface FetchResult {
  content: string;
  sha: string;
  source: 'github' | 'local';
}

/**
 * Fetch RETRO-METRICS.md content from GitHub Contents API with local fallback.
 * Returns { content, sha, source } or null if the file does not exist anywhere.
 */
async function fetchRetroMetricsContent(): Promise<FetchResult | null> {
  // Guard: need both token and repo to use GitHub API
  if (!config.ghToken || !config.githubRepo) {
    if (!ghFallbackWarningLogged) {
      console.warn('[dashboard] GitHub token or repo not configured — retro metrics will use local file (may be stale)');
      ghFallbackWarningLogged = true;
    }
    return readLocalRetroMetrics();
  }

  try {
    // config.githubRepo is validated as "owner/repo" format at config load time (see config.ts)
    const url = `https://api.github.com/repos/${config.githubRepo}/contents/fritz/knowledge/RETRO-METRICS.md?ref=main`;
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${config.ghToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'fritZ-daemon',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });

    if (response.status === 404) {
      // File not found on GitHub — fall back to local copy (consistent with other error paths)
      return readLocalRetroMetrics();
    }

    if (!response.ok) {
      console.warn(`[dashboard] GitHub API returned ${response.status} for RETRO-METRICS.md — falling back to local`);
      return readLocalRetroMetrics();
    }

    const json = await response.json() as { content?: string; sha?: string; encoding?: string };
    if (!json.content || json.encoding !== 'base64') {
      console.warn('[dashboard] Unexpected GitHub API response format — falling back to local');
      return readLocalRetroMetrics();
    }

    const content = Buffer.from(json.content, 'base64').toString('utf-8');
    return { content, sha: json.sha ?? '', source: 'github' };
  } catch (err) {
    // Network error, timeout, or AbortError
    console.warn('[dashboard] GitHub API fetch failed — falling back to local:', (err as Error).message);
    return readLocalRetroMetrics();
  }
}

function readLocalRetroMetrics(): FetchResult | null {
  const filePath = getRetroMetricsPath();
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return { content, sha: 'local', source: 'local' };
}

// ---------------------------------------------------------------------------
// Async cache + single-flight orchestrator
// ---------------------------------------------------------------------------

async function doFetchAndParse(): Promise<RetroResult | null> {
  try {
    const result = await fetchRetroMetricsContent();
    if (!result) return null;

    const source: RetroSource = result.source;
    const data = parseRetroMetricsContent(result.content);

    retroCache = {
      data,
      sha: result.sha,
      expires: Date.now() + RETRO_CACHE_TTL_MS,
      source,
    };

    return { data: { ...data, source }, source };
  } catch (err) {
    console.error('[dashboard] Failed to fetch/parse retro metrics:', (err as Error).message);
    return null;
  }
}

/**
 * Get retro metrics with caching, GitHub API fetch, and single-flight coalescing.
 * Replaces the former synchronous parseRetroMetrics().
 */
export async function getRetroMetrics(): Promise<RetroResult | null> {
  // Return cached result if valid
  if (retroCache && retroCache.expires > Date.now()) {
    return { data: { ...retroCache.data, source: 'cache' }, source: retroCache.source };
  }

  // Single-flight: if a fetch is already in progress, piggyback on it
  if (inflightFetch) return inflightFetch;

  inflightFetch = doFetchAndParse().finally(() => {
    inflightFetch = null;
  });

  return inflightFetch;
}

// SPA file path — resolved once at init
let spaFilePath: string | null = null;

// Build version string — resolved once at init
let buildVersion = 'dev';

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

function toAgent(agent: LocalAgent): DashboardAgent {
  const now = Date.now();
  const startedMs = new Date(agent.started).getTime();
  const elapsed = Math.floor((now - startedMs) / 1000);
  const remaining = agent.ttl === 0 ? null : Math.max(0, agent.ttl - elapsed);

  // Cross-reference issue data to check for auto-pipeline label
  let autoPipeline = false;
  if (agent.issue) {
    const issues = getIssuesData();
    const issueData = issues.find(i => i.number === agent.issue);
    if (issueData) {
      autoPipeline = issueData.rawLabels.includes('fritz.auto-pipeline');
    }
  }

  return {
    name: agent.name,
    role: agent.role,
    issue: agent.issue,
    issueTitle: agent.issueTitle ?? null,
    issueUrl: agent.issue && config.githubRepo
      ? `https://github.com/${config.githubRepo}/issues/${agent.issue}`
      : null,
    repo: agent.repo,
    branch: agent.branch,
    started: agent.started,
    ttl: agent.ttl,
    elapsed,
    remaining,
    lastActivity: agent.lastActivity ?? null,
    lastActivityAt: agent.lastActivityAt ?? null,
    model: getRoleModel(agent.role),
    claudeCodeVersion: agent.claudeCodeVersion ?? null,
    autoPipeline,
  };
}

function getActiveAgents(): DashboardAgent[] {
  return registry.listAgents().map(toAgent);
}

/**
 * Parse curated labels from raw GitHub labels for display as badges.
 */
function parseCuratedLabels(rawLabels: string[]): CuratedLabel[] {
  const labels: CuratedLabel[] = [];

  for (const raw of rawLabels) {
    if (raw.startsWith('type:')) {
      labels.push({ category: 'type', value: raw.replace('type:', ''), raw });
    } else if (raw.startsWith('fritz.lang:')) {
      labels.push({ category: 'language', value: raw.replace('fritz.lang:', ''), raw });
    } else if (raw.startsWith('fritz.repo:')) {
      labels.push({ category: 'repo', value: raw.replace('fritz.repo:', ''), raw });
    } else if (raw === 'fritz.auto-pipeline') {
      labels.push({ category: 'auto-pipeline', value: 'auto', raw });
    } else if (raw.startsWith('fritz.skill:')) {
      labels.push({ category: 'skill', value: raw.replace('fritz.skill:', ''), raw });
    }
  }

  return labels;
}

// Retained for API compatibility — the Queue tab was removed from the dashboard UI
// but external consumers may still call this endpoint
export function getQueueData(): QueuedIssue[] {
  const raw = autoloop.getLastKnownQueue();

  return raw.map(issue => {
    const statusLabel = issue.labels.find(l => l.startsWith('fritz.status:'));
    const status = statusLabel ? statusLabel.replace('fritz.status:', '') : 'unknown';
    const nextRole = STATUS_TO_ROLE[status] ?? status;

    const priorityLabel = issue.labels.find(l => l.startsWith('priority:p'));
    const priority = priorityLabel
      ? parseInt(priorityLabel.replace('priority:p', ''), 10)
      : null;

    // Resolve blocked status using cached results (avoids blocking the event loop)
    const depLabels = issue.labels.filter(l => l.startsWith(DEPENDS_ON_PREFIX));
    const allDeps = depLabels.map(l => parseInt(l.replace(DEPENDS_ON_PREFIX, ''), 10)).filter(n => !isNaN(n));
    const openDeps = allDeps.filter(dep => !isDependencyClosedCached(dep));

    return {
      number: issue.number,
      title: issue.title ?? `#${issue.number}`,
      status,
      nextRole,
      priority: priority !== null && !isNaN(priority) ? priority : null,
      blocked: openDeps.length > 0,
      blockedBy: openDeps,
      labels: parseCuratedLabels(issue.labels),
    };
  });
}

function toHistoryEntry(a: { name: string; summary: AgentLogSummary }): HistoryEntry {
  return {
    name: a.name,
    role: a.summary.role,
    issue: a.summary.issue,
    issueTitle: a.summary.issueTitle || null,
    issueUrl: a.summary.issue && config.githubRepo
      ? `https://github.com/${config.githubRepo}/issues/${a.summary.issue}`
      : null,
    repo: a.summary.repo,
    branch: a.summary.branch,
    started: a.summary.started,
    ended: a.summary.ended,
    duration: a.summary.duration,
    exitStatus: a.summary.exitStatus,
    exitCode: a.summary.exitCode ?? null,
    exitReason: a.summary.exitReason,
    turns: a.summary.turns,
    inputTokens: a.summary.inputTokens,
    cacheReadInputTokens: a.summary.cacheReadInputTokens || 0,
    cacheCreationInputTokens: a.summary.cacheCreationInputTokens || 0,
    outputTokens: a.summary.outputTokens,
    lastActivity: a.summary.lastActivity,
    model: a.summary.model,
    subagentCount: a.summary.subagentCount ?? 0,
    lang: a.summary.lang ?? null,
  };
}

function getRecentHistory(limit: number = 50): HistoryEntry[] {
  const archives = logArchive.listArchivedAgents();
  return archives.slice(0, limit).map(toHistoryEntry);
}

function getSystemStatus(): SystemStatus {
  return {
    autoloopRunning: autoloop.isRunning(),
    autoloopPaused: autoloop.isPaused(),
    autoloopManuallyPaused: autoloop.isManuallyPaused(),
    usagePaused: usageMonitor.isUsagePaused(),
    usageOverride: usageMonitor.hasOverride(),
    usage: usageMonitor.getUsageData(),
    usageLastCheck: usageMonitor.getLastCheckTime(),
    usageAuthMode: usageMonitor.getAuthMode(),
    usageAccountName: usageMonitor.getAccountName(),
    usageMonitorRunning: usageMonitor.isRunning(),
    usageStopReason: usageMonitor.getStopReason(),
    activeAgentCount: registry.listAgents().length,
    maxParallelAgents: getMaxParallelAgents(),
    uptime: Math.floor((Date.now() - daemonStartTime) / 1000),
    rateLimit: {
      writeQueue: githubWriteQueue.getStats(),
    },
    githubApiQuotaRemaining: computeGitHubQuotaPercent(),
    recentFailureStreak: computeRecentFailureStreak(),
  };
}

/**
 * Compute GitHub API quota remaining as a percentage (0–100).
 * Uses the shared rate-limit state from github-cache.
 */
function computeGitHubQuotaPercent(): number {
  try {
    const state = getRateLimitState();
    const limit = 5000; // GitHub API default rate limit
    if (state.remaining < 0) return 100; // unknown state → assume full
    return Math.min(100, Math.round((state.remaining / limit) * 100));
  } catch {
    return 100; // fallback
  }
}

/**
 * Count consecutive recent agent failures (dead) from history,
 * starting from the most recent agent backwards.
 * Both `completed` and `stopped` break the streak.
 * `expired` (TTL timeout) also breaks the streak — it indicates intentional
 * time-boxing, not a failure in the agent's work.
 */
function computeRecentFailureStreak(): number {
  try {
    // Only read recent archives — we only need enough to find the streak end
    const archives = logArchive.listArchivedAgents({ since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    let streak = 0;
    for (const a of archives) {
      if (a.summary.exitStatus === 'completed' || a.summary.exitStatus === 'stopped' || a.summary.exitStatus === 'expired') break;
      streak++;
    }
    return streak;
  } catch {
    return 0;
  }
}

function getFullState(): DashboardState {
  return {
    agents: getActiveAgents(),
    history: getRecentHistory(),
    system: getSystemStatus(),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SSE management
// ---------------------------------------------------------------------------

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected — will be cleaned up by close handler
  }
}

function broadcastSSE(event: string, data: unknown): void {
  for (const client of sseClients) {
    sendSSE(client, event, data);
  }
}

export function notifyClients(event: string, data: unknown): void {
  broadcastSSE(event, data);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAgentDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Registry change handler
// ---------------------------------------------------------------------------

function onRegistryChange(agent: LocalAgent, event: 'registered' | 'updated' | 'deregistered'): void {
  switch (event) {
    case 'registered': {
      // Invalidate issues cache so the next workflow fetch gets fresh GitHub data
      invalidateIssuesCache();
      const issuePart = agent.issue ? ` · #${agent.issue}` : '';
      logEvent('agent.started', `${agent.role} started${issuePart}`, {
        role: agent.role,
        issue: agent.issue ?? null,
      });
      broadcastSSE('agent-started', toAgent(agent));
      break;
    }
    case 'updated':
      broadcastSSE('agent-update', toAgent(agent));
      break;
    case 'deregistered': {
      // Invalidate issues cache so the next workflow fetch gets fresh GitHub data
      invalidateIssuesCache();
      const durationMs = Date.now() - new Date(agent.started).getTime();
      const durationStr = fmtAgentDuration(durationMs);
      // Check if there's a history entry for this agent
      const summary = logArchive.getArchivedSummary(agent.name);
      // Use archive summary if available, fall back to agent's exit info (set before deregistration)
      const exitStatus = summary?.exitStatus ?? agent.exitStatus ?? 'unknown';
      const exitCode = summary?.exitCode ?? agent.exitCode ?? null;
      const issuePart = agent.issue ? ` · #${agent.issue}` : '';
      logEvent('agent.stopped', `${agent.role}${issuePart} ${exitStatus} · ${durationStr}`, {
        role: agent.role,
        issue: agent.issue ?? null,
        exitStatus,
        exitCode,
        durationSec: Math.floor(durationMs / 1000),
      });
      if (summary) {
        broadcastSSE('agent-stopped', toHistoryEntry({ name: summary.name, summary }));
      } else {
        // No archive yet (archive happens async) — send basic info with agent's exit info
        broadcastSSE('agent-stopped', {
          name: agent.name,
          role: agent.role,
          issue: agent.issue,
          issueTitle: agent.issueTitle ?? null,
          issueUrl: agent.issue && config.githubRepo
            ? `https://github.com/${config.githubRepo}/issues/${agent.issue}`
            : null,
          repo: agent.repo,
          branch: agent.branch ?? null,
          started: agent.started,
          ended: new Date().toISOString(),
          duration: '0s',
          exitStatus,
          exitCode,
          exitReason: null,
          turns: 0,
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          lastActivity: agent.lastActivity ?? null,
          model: getRoleModel(agent.role),
          subagentCount: 0,
          lang: agent.lang ?? null,
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Request body reader (for POST endpoints)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024; // 64 KB (dashboard requests are small)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => { if (!rejected) resolve(body); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleDashboardRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? '';
  const path = url.split('?')[0];

  // GET /dashboard — serve SPA
  if (method === 'GET' && path === '/dashboard') {
    serveSPA(res);
    return;
  }

  // GET /api/dashboard/state — full state snapshot
  if (method === 'GET' && path === '/api/dashboard/state') {
    json(res, 200, getFullState());
    return;
  }

  // GET /api/dashboard/orchestrator-history — recent orchestrator conversations
  if (method === 'GET' && path === '/api/dashboard/orchestrator-history') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const limitStr = parsed.searchParams.get('limit');
    const rawLimit = limitStr ? parseInt(limitStr, 10) : 5;
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 5 : rawLimit), 50);
    json(res, 200, getOrchestratorHistory(limit));
    return;
  }

  // GET /api/dashboard/history — paginated history
  // Optional: since=today|7d|30d, countOnly=true, groupBy=day
  if (method === 'GET' && path === '/api/dashboard/history') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const role = parsed.searchParams.get('role') ?? undefined;
    const issueStr = parsed.searchParams.get('issue');
    const issue = issueStr ? parseInt(issueStr, 10) : undefined;
    const limitStr = parsed.searchParams.get('limit');
    const rawLimit = limitStr ? parseInt(limitStr, 10) : 50;
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200);
    const offsetStr = parsed.searchParams.get('offset');
    const rawOffset = offsetStr ? parseInt(offsetStr, 10) : 0;
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    // Compute 'since' ISO timestamp from shorthand
    const sinceParam = parsed.searchParams.get('since');
    let sinceISO: string | undefined;
    if (sinceParam) {
      const now = new Date();
      if (sinceParam === 'today') {
        sinceISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      } else if (sinceParam === '7d') {
        sinceISO = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (sinceParam === '30d') {
        sinceISO = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      }
      // else: ignore unknown since values, no filter applied
    }

    const allHistory = logArchive.listArchivedAgents({
      role,
      issue: issue && !isNaN(issue) ? issue : undefined,
      since: sinceISO,
    });

    const countOnly = parsed.searchParams.get('countOnly') === 'true';
    const groupBy = parsed.searchParams.get('groupBy');

    if (countOnly) {
      json(res, 200, { total: allHistory.length });
      return;
    }

    if (groupBy === 'day') {
      const buckets = new Map<string, number>();
      for (const a of allHistory) {
        const date = a.summary.ended.slice(0, 10); // YYYY-MM-DD
        buckets.set(date, (buckets.get(date) ?? 0) + 1);
      }
      const sortedBuckets = Array.from(buckets.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count }));
      json(res, 200, { buckets: sortedBuckets });
      return;
    }

    const entries = allHistory.slice(offset, offset + limit).map(toHistoryEntry);

    json(res, 200, { entries, total: allHistory.length });
    return;
  }

  // GET /api/dashboard/log/:name — archived agent execution log
  if (method === 'GET' && path.startsWith('/api/dashboard/log/')) {
    const agentName = path.replace('/api/dashboard/log/', '');

    // Validate agent name (path traversal prevention)
    if (!AGENT_NAME_RE.test(agentName)) {
      json(res, 400, { error: 'Invalid agent name' });
      return;
    }

    const parsed = new URL(url, `http://${req.headers.host}`);
    const linesStr = parsed.searchParams.get('lines');
    const rawLines = linesStr ? parseInt(linesStr, 10) : 200;
    const lines = Math.min(Math.max(1, isNaN(rawLines) ? 200 : rawLines), 5000);

    const result = logArchive.getArchivedLog(agentName, lines);
    const summary = logArchive.getArchivedSummary(agentName);

    if (result === null) {
      json(res, 404, { error: `No logs found for agent: ${agentName}` });
      return;
    }

    json(res, 200, { log: result.log, totalLines: result.totalLines, summary });
    return;
  }

  // GET /api/dashboard/session-log/:name — parsed JSONL session timeline.
  // JSONL-only by contract (issue #926): no fallback to agent.log, otherwise
  // the Session Log panel duplicates the Agent Log panel for archived agents.
  // Empty timeline → 200 { log: '' } so the frontend can hide the panel
  // without surfacing an error toast for old archives that pre-date this fix.
  if (method === 'GET' && path.startsWith('/api/dashboard/session-log/')) {
    const agentName = path.replace('/api/dashboard/session-log/', '');

    if (!AGENT_NAME_RE.test(agentName)) {
      json(res, 400, { error: 'Invalid agent name' });
      return;
    }

    const parsed = new URL(url, `http://${req.headers.host}`);
    const fullParam = parsed.searchParams.get('full');
    const maxLength = fullParam === '1' ? 500_000 : 3800;

    try {
      const log = agents.getSessionTimeline(agentName, maxLength);
      json(res, 200, { log: log ?? '' });
    } catch (err) {
      console.error(`[dashboard] Failed to read session log for ${agentName}:`, err);
      json(res, 200, { log: '' });
    }
    return;
  }

  // GET /api/dashboard/agent-log/:name — live log for active agent
  if (method === 'GET' && path.startsWith('/api/dashboard/agent-log/')) {
    const agentName = path.replace('/api/dashboard/agent-log/', '');

    if (!AGENT_NAME_RE.test(agentName)) {
      json(res, 400, { error: 'Invalid agent name' });
      return;
    }

    const parsed = new URL(url, `http://${req.headers.host}`);
    const linesStr = parsed.searchParams.get('lines');
    const rawLines = linesStr ? parseInt(linesStr, 10) : 100;
    const lines = Math.min(Math.max(1, isNaN(rawLines) ? 100 : rawLines), 500);

    const agent = registry.getAgent(agentName);
    if (!agent) {
      json(res, 404, { error: 'Agent not found or no logs available' });
      return;
    }

    try {
      const log = agents.getAgentLogs(agentName, lines);
      json(res, 200, { log, active: true });
    } catch (err) {
      console.error(`[dashboard] Failed to read agent log for ${agentName}:`, err);
      json(res, 500, { error: 'Failed to read agent log' });
    }
    return;
  }

  // GET /api/dashboard/issue-trail/:issue — agent trail for an issue
  if (method === 'GET' && path.startsWith('/api/dashboard/issue-trail/')) {
    const issueStr = path.replace('/api/dashboard/issue-trail/', '');
    const issueNum = parseInt(issueStr, 10);

    if (isNaN(issueNum) || issueNum <= 0) {
      json(res, 400, { error: 'Invalid issue number' });
      return;
    }

    // Combine active agents and archived agents for this issue
    const activeAgents = registry.listAgents()
      .filter(a => a.issue === issueNum)
      .map(a => ({
        name: a.name,
        role: a.role,
        started: a.started,
        ended: null as string | null,
        duration: null as string | null,
        status: 'active',
        active: true,
        subagentCount: 0,
      }));

    const archivedAgents = logArchive.listArchivedAgents({ issue: issueNum })
      .map(a => ({
        name: a.name,
        role: a.summary.role,
        started: a.summary.started,
        ended: a.summary.ended,
        duration: a.summary.duration,
        status: a.summary.exitStatus,
        active: false,
        subagentCount: a.summary.subagentCount ?? 0,
      }));

    // Merge and deduplicate (active agent may also appear in archive)
    const seen = new Set<string>();
    const combined = [...activeAgents, ...archivedAgents].filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });

    // Sort by started ascending (oldest first)
    combined.sort((a, b) => new Date(a.started).getTime() - new Date(b.started).getTime());

    json(res, 200, { issue: issueNum, agents: combined });
    return;
  }

  // POST /api/dashboard/agent/:name/stop — kill an active agent
  if (method === 'POST' && path.match(/^\/api\/dashboard\/agent\/[^/]+\/stop$/)) {
    const agentName = path.replace('/api/dashboard/agent/', '').replace('/stop', '');

    if (!AGENT_NAME_RE.test(agentName)) {
      json(res, 400, { error: 'Invalid agent name' });
      return;
    }

    const agent = registry.getAgent(agentName);
    if (!agent) {
      json(res, 404, { error: `Agent not found: ${agentName}` });
      return;
    }

    try {
      await agents.stopAgent(agentName, 'dead');
      json(res, 200, { ok: true, message: `Agent stopped: ${agentName}` });
    } catch (err) {
      console.error(`[dashboard] Failed to stop agent ${agentName}:`, err);
      json(res, 500, { error: 'Failed to stop agent' });
    }
    return;
  }

  // POST /api/dashboard/boot — boot a new agent for a queued issue
  if (method === 'POST' && path === '/api/dashboard/boot') {
    try {
      const body = await readBody(req);

      let payload: { issue?: unknown; role?: unknown; mode?: unknown; force?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const { issue, role, mode, force } = payload;

      if (!issue || typeof issue !== 'number' || issue <= 0) {
        json(res, 400, { error: 'Invalid issue number' });
        return;
      }

      if (!role || !VALID_ROLES.includes(role as string)) {
        json(res, 400, { error: `Invalid role: ${role}` });
        return;
      }

      if (mode !== undefined && mode !== 'auto' && mode !== 'chat') {
        json(res, 400, { error: 'Invalid mode (must be "auto" or "chat")' });
        return;
      }

      const bootMode = (mode as 'auto' | 'chat') || 'auto';
      const forceFlag = force === true;
      const preBootCount = agents.getActiveAgentCount();
      const agentName = await agents.startAgent({ role: role as AgentRole, issue, mode: bootMode, force: forceFlag || undefined });
      const warning = forceFlag ? `⚠️ Force-boot: bypassing parallel limit (currently ${preBootCount}/${agents.getMaxParallel()})` : undefined;
      json(res, 200, { ok: true, message: `Agent booted: ${agentName}`, name: agentName, mode: bootMode, ...(warning && { warning }) });
    } catch (err) {
      console.error('[dashboard] Boot failed:', err);
      json(res, 500, { error: 'Failed to boot agent' });
    }
    return;
  }

  // POST /api/dashboard/autoloop/toggle — toggle manual autoloop pause/resume
  if (method === 'POST' && path === '/api/dashboard/autoloop/toggle') {
    const wasManuallyPaused = autoloop.isManuallyPaused();
    if (wasManuallyPaused) {
      autoloop.resume();
    } else {
      autoloop.pause();
    }
    const manuallyPaused = autoloop.isManuallyPaused();
    const usagePaused = usageMonitor.isUsagePaused();
    json(res, 200, {
      ok: true,
      paused: autoloop.isPaused(),
      manuallyPaused,
      usagePaused,
      message: manuallyPaused
        ? 'Autoloop paused (manual)'
        : usagePaused
          ? 'Manual pause removed, but autoloop is still paused due to usage limits'
          : 'Autoloop resumed',
    });
    return;
  }

  // GET /api/dashboard/usage — aggregate usage stats
  // Optional: period=30d — returns totalCost for the specified period
  if (method === 'GET' && path === '/api/dashboard/usage') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const period = parsed.searchParams.get('period');

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const todayArchives = logArchive.listArchivedAgents({ since: todayStart });
    const weekArchives = logArchive.listArchivedAgents({ since: weekStart });

    const aggregate = (archives: { summary: AgentLogSummary }[]) => {
      let inputTokens = 0;
      let cacheReadInputTokens = 0;
      let cacheCreationInputTokens = 0;
      let outputTokens = 0;
      let agentsCompleted = 0;
      let agentsFailed = 0;
      for (const a of archives) {
        inputTokens += a.summary.inputTokens || 0;
        cacheReadInputTokens += a.summary.cacheReadInputTokens || 0;
        cacheCreationInputTokens += a.summary.cacheCreationInputTokens || 0;
        outputTokens += a.summary.outputTokens || 0;
        if (a.summary.exitStatus === 'completed') agentsCompleted++;
        else agentsFailed++;
      }
      return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, agentsCompleted, agentsFailed };
    };

    const result: Record<string, unknown> = {
      today: aggregate(todayArchives),
      week: aggregate(weekArchives),
    };

    // Optional period param: compute totalCost for the specified period
    if (period) {
      let periodMs: number | null = null;
      if (period === '30d') periodMs = 30 * 24 * 60 * 60 * 1000;
      else if (period === '7d') periodMs = 7 * 24 * 60 * 60 * 1000;
      else if (period === 'today') periodMs = now.getTime() - new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();

      if (periodMs !== null) {
        const periodStart = new Date(now.getTime() - periodMs).toISOString();
        const periodArchives = logArchive.listArchivedAgents({ since: periodStart });
        const agg = aggregate(periodArchives);
        // Approximate cost using Sonnet pricing as a baseline.
        // The system uses multiple models (opus, sonnet, haiku) so this is
        // an estimate, not an exact figure. Named accordingly.
        // Sonnet rates: Input $3/MTok, Cache read $0.30/MTok, Cache create $3.75/MTok, Output $15/MTok
        const cost =
          (agg.inputTokens / 1_000_000) * 3 +
          (agg.cacheReadInputTokens / 1_000_000) * 0.30 +
          (agg.cacheCreationInputTokens / 1_000_000) * 3.75 +
          (agg.outputTokens / 1_000_000) * 15;
        result.estimatedCostSonnetBaseline = Math.round(cost * 100) / 100;
      }
    }

    json(res, 200, result);
    return;
  }

  // GET /api/dashboard/usage/breakdown — detailed usage breakdown
  // Optional query param: ?since=ISO8601 (e.g. ?since=2026-02-13T00:00:00.000Z)
  if (method === 'GET' && path === '/api/dashboard/usage/breakdown') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const since = parsed.searchParams.get('since') ?? undefined;
    const archives = logArchive.listArchivedAgents({ since });

    // Single pass: build totals, by-role, by-issue, top-agents, by-day
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0, totalDuration = 0;
    const byRole = new Map<string, { count: number; input: number; output: number; cacheRead: number; cacheCreate: number; duration: number }>();
    const byIssue = new Map<number, { count: number; input: number; output: number; cacheRead: number; cacheCreate: number; duration: number; title: string | null }>();
    const byDay = new Map<string, { count: number; input: number; output: number }>();
    const agentEntries: { name: string; role: string; issue: number | null; input: number; cacheRead: number; output: number; duration: string }[] = [];

    const sinceMs = since ? new Date(since).getTime() : 0;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const dailyCutoff = sinceMs > thirtyDaysAgo ? sinceMs : thirtyDaysAgo;

    for (const a of archives) {
      const s = a.summary;
      const input = s.inputTokens || 0;
      const output = s.outputTokens || 0;
      const cacheRead = s.cacheReadInputTokens || 0;
      const cacheCreate = s.cacheCreationInputTokens || 0;

      // Parse duration string to seconds (e.g. "5m 30s", "1h 2m", "45s")
      let durSec = 0;
      const durMatch = s.duration?.match(/(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/);
      if (durMatch) {
        durSec = (parseInt(durMatch[1] || '0') * 3600) + (parseInt(durMatch[2] || '0') * 60) + parseInt(durMatch[3] || '0');
      }

      totalInput += input;
      totalOutput += output;
      totalCacheRead += cacheRead;
      totalCacheCreate += cacheCreate;
      totalDuration += durSec;

      // By role
      const role = s.role || 'unknown';
      const r = byRole.get(role) || { count: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, duration: 0 };
      r.count++;
      r.input += input;
      r.output += output;
      r.cacheRead += cacheRead;
      r.cacheCreate += cacheCreate;
      r.duration += durSec;
      byRole.set(role, r);

      // By issue
      if (s.issue) {
        const iss = byIssue.get(s.issue) || { count: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, duration: 0, title: null };
        iss.count++;
        iss.input += input;
        iss.output += output;
        iss.cacheRead += cacheRead;
        iss.cacheCreate += cacheCreate;
        iss.duration += durSec;
        if (!iss.title && s.issueTitle) iss.title = s.issueTitle;
        byIssue.set(s.issue, iss);
      }

      // Top agents (collect all, sort later)
      agentEntries.push({ name: a.name, role, issue: s.issue, input, cacheRead, output, duration: s.duration });

      // By day (within daily chart range)
      const endedMs = new Date(s.ended).getTime();
      if (endedMs >= dailyCutoff) {
        const day = s.ended.substring(0, 10); // YYYY-MM-DD
        const d = byDay.get(day) || { count: 0, input: 0, output: 0 };
        d.count++;
        d.input += input;
        d.output += output;
        byDay.set(day, d);
      }
    }

    // Sort and limit
    const totalContext = (r: { input: number; cacheRead: number; output: number }) => r.input + r.cacheRead + r.output;

    const roleBreakdown = Array.from(byRole.entries())
      .map(([role, v]) => ({ role, ...v, avgInput: v.count > 0 ? Math.round(v.input / v.count) : 0 }))
      .sort((a, b) => totalContext(b) - totalContext(a));

    const issueBreakdown = Array.from(byIssue.entries())
      .map(([issue, v]) => ({ issue, ...v }))
      .sort((a, b) => totalContext(b) - totalContext(a))
      .slice(0, 15);

    const topAgents = agentEntries
      .sort((a, b) => totalContext(b) - totalContext(a))
      .slice(0, 10);

    // Fill daily data (including zero days)
    const dailyData: { date: string; count: number; input: number; output: number }[] = [];
    const now = new Date();
    const dailyDays = Math.min(30, Math.ceil((now.getTime() - dailyCutoff) / (24 * 60 * 60 * 1000)) + 1);
    for (let i = dailyDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().substring(0, 10);
      const entry = byDay.get(key) || { count: 0, input: 0, output: 0 };
      dailyData.push({ date: key, ...entry });
    }

    // Time range from archives (sorted newest-first)
    const oldest = archives.length > 0 ? archives[archives.length - 1].summary.ended : null;
    const newest = archives.length > 0 ? archives[0].summary.ended : null;

    json(res, 200, {
      totals: {
        agents: archives.length,
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        duration: totalDuration,
      },
      timeRange: { oldest, newest },
      byRole: roleBreakdown,
      byIssue: issueBreakdown,
      topAgents,
      byDay: dailyData,
    });
    return;
  }

  // GET /api/dashboard/workflow — workflow overview (pipeline funnel + attention panel)
  if (method === 'GET' && path === '/api/dashboard/workflow') {
    try {
      const data = getWorkflowData();
      json(res, 200, data);
    } catch (err) {
      console.error('[dashboard] Workflow data fetch failed:', err);
      json(res, 500, { error: 'Failed to compute workflow data' });
    }
    return;
  }


  // GET /api/dashboard/issues — all open issues with label data
  if (method === 'GET' && path === '/api/dashboard/issues') {
    try {
      const issues = getIssuesData();
      json(res, 200, {
        issues,
        total: issues.length,
        cachedAt: issuesCache ? new Date(issuesCache.timestamp).toISOString() : null,
      });
    } catch (err) {
      console.error('[dashboard] Issues fetch failed:', err);
      json(res, 500, { error: 'Failed to fetch issues' });
    }
    return;
  }

  // POST /api/dashboard/issues/:number/label — add/remove labels on an issue
  if (method === 'POST' && path.match(/^\/api\/dashboard\/issues\/\d+\/label$/)) {
    const numberStr = path.replace('/api/dashboard/issues/', '').replace('/label', '');
    const issueNumber = parseInt(numberStr, 10);

    if (isNaN(issueNumber) || issueNumber <= 0) {
      json(res, 400, { error: 'Invalid issue number' });
      return;
    }

    try {
      const body = await readBody(req);
      let payload: { add?: unknown; remove?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const add = Array.isArray(payload.add) ? payload.add.filter((l): l is string => typeof l === 'string') : [];
      const remove = Array.isArray(payload.remove) ? payload.remove.filter((l): l is string => typeof l === 'string') : [];

      if (add.length === 0 && remove.length === 0) {
        json(res, 400, { error: 'At least one label must be specified in add or remove' });
        return;
      }

      // Validate all labels against whitelist
      const allLabels = [...add, ...remove];
      for (const label of allLabels) {
        if (!isLabelAllowed(label)) {
          json(res, 400, { error: `Invalid label: '${label}'. Only fritz.status:*, priority:p*, fritz.depends-on:*, and fritz.auto-pipeline labels are allowed.` });
          return;
        }
      }

      // Validate at most one status and one priority in add
      const statusAdds = add.filter(l => l.startsWith('fritz.status:'));
      if (statusAdds.length > 1) {
        json(res, 400, { error: 'At most one fritz.status label can be added at a time' });
        return;
      }
      const priorityAdds = add.filter(l => l.startsWith('priority:p'));
      if (priorityAdds.length > 1) {
        json(res, 400, { error: 'At most one priority label can be added at a time' });
        return;
      }

      const repo = config.githubRepo;
      if (!repo) {
        json(res, 500, { error: 'GITHUB_REPO not configured' });
        return;
      }

      // Execute label changes via gh CLI (remove first, then add)
      // If add fails after remove, attempt rollback by re-adding removed labels
      if (remove.length > 0) {
        github.gh(`issue edit ${issueNumber} --remove-label "${remove.join(',')}" --repo ${repo}`);
      }
      if (add.length > 0) {
        try {
          github.gh(`issue edit ${issueNumber} --add-label "${add.join(',')}" --repo ${repo}`);
        } catch (addErr) {
          // Attempt rollback: re-add the labels we just removed
          if (remove.length > 0) {
            try {
              github.gh(`issue edit ${issueNumber} --add-label "${remove.join(',')}" --repo ${repo}`);
              console.error(`[dashboard] Rolled back label removal on #${issueNumber} after add failed`);
            } catch (rollbackErr) {
              console.error(`[dashboard] CRITICAL: Label rollback failed on #${issueNumber} — issue may be in inconsistent state:`, rollbackErr);
            }
          }
          throw addErr;
        }
      }

      // Await cache refresh so the client's next workflow fetch gets fresh data
      await invalidateIssuesCache();

      // Broadcast SSE event for multi-viewer sync
      broadcastSSE('issues-update', { type: 'label-change', issue: issueNumber, added: add, removed: remove });

      json(res, 200, { ok: true, message: `Labels updated on #${issueNumber}`, added: add, removed: remove });
    } catch (err) {
      console.error(`[dashboard] Failed to update labels on #${issueNumber}:`, err);
      json(res, 500, { error: `Failed to update labels on #${issueNumber}` });
    }
    return;
  }

  // GET /api/dashboard/issues/:number — single issue detail (for dependency checks)
  if (method === 'GET' && path.match(/^\/api\/dashboard\/issues\/\d+$/)) {
    const numberStr = path.replace('/api/dashboard/issues/', '');
    const issueNumber = parseInt(numberStr, 10);

    if (isNaN(issueNumber) || issueNumber <= 0) {
      json(res, 400, { error: 'Invalid issue number' });
      return;
    }

    const repo = config.githubRepo;
    if (!repo) {
      json(res, 500, { error: 'GITHUB_REPO not configured' });
      return;
    }

    try {
      const raw = github.gh(`issue view ${issueNumber} --json number,title,state,labels,updatedAt --repo ${repo}`);
      const data = JSON.parse(raw);
      json(res, 200, {
        number: data.number,
        title: data.title,
        state: data.state,
        labels: (data.labels || []).map((l: { name: string }) => l.name),
        updatedAt: data.updatedAt,
      });
    } catch (err) {
      console.error(`[dashboard] Failed to fetch issue #${issueNumber}:`, err);
      json(res, 500, { error: `Failed to fetch issue #${issueNumber}` });
    }
    return;
  }

  // POST /api/dashboard/issues/:number/comment — post a comment on an issue (for reject feedback)
  if (method === 'POST' && path.match(/^\/api\/dashboard\/issues\/\d+\/comment$/)) {
    const numberStr = path.replace('/api/dashboard/issues/', '').replace('/comment', '');
    const issueNumber = parseInt(numberStr, 10);

    if (isNaN(issueNumber) || issueNumber <= 0) {
      json(res, 400, { error: 'Invalid issue number' });
      return;
    }

    try {
      const body = await readBody(req);
      let payload: { comment?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const comment = payload.comment;
      if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
        json(res, 400, { error: 'Comment text is required' });
        return;
      }

      const repo = config.githubRepo;
      if (!repo) {
        json(res, 500, { error: 'GITHUB_REPO not configured' });
        return;
      }

      // Use --body-file with stdin to avoid shell injection (no shell escaping needed).
      // Timeout of 30s prevents blocking the event loop on slow GitHub API calls.
      execSync(`gh issue comment ${issueNumber} --body-file - --repo ${repo}`, {
        input: comment,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      json(res, 200, { ok: true, message: `Comment posted on #${issueNumber}` });
    } catch (err) {
      console.error(`[dashboard] Failed to post comment on #${issueNumber}:`, err);
      json(res, 500, { error: `Failed to post comment on #${issueNumber}` });
    }
    return;
  }


  // GET /api/dashboard/subscription-usage — real-time subscription usage from Anthropic API
  if (method === 'GET' && path === '/api/dashboard/subscription-usage') {
    const data = usageMonitor.getUsageData();
    const usageCfg = getUsageConfig();
    json(res, 200, {
      usage: data,
      paused: usageMonitor.isUsagePaused(),
      override: usageMonitor.hasOverride(),
      lastCheck: usageMonitor.getLastCheckTime(),
      authMode: usageMonitor.getAuthMode(),
      accountName: usageMonitor.getAccountName(),
      monitorRunning: usageMonitor.isRunning(),
      config: {
        enabled: usageCfg.enabled,
        pauseThreshold: usageCfg.pauseThreshold,
        resumeThreshold: usageCfg.resumeThreshold,
        allowP0: usageCfg.allowP0,
      },
    });
    return;
  }

  // POST /api/dashboard/subscription-usage/override — toggle usage override
  if (method === 'POST' && path === '/api/dashboard/subscription-usage/override') {
    try {
      const body = await readBody(req);
      let payload: { enabled?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (typeof payload.enabled !== 'boolean') {
        json(res, 400, { error: 'enabled must be a boolean' });
        return;
      }

      usageMonitor.setOverride(payload.enabled);
      logEvent('usage.override',
        payload.enabled ? 'Usage override enabled' : 'Usage override disabled',
        { enabled: payload.enabled }
      );
      json(res, 200, {
        ok: true,
        override: usageMonitor.hasOverride(),
        paused: usageMonitor.isUsagePaused(),
        message: payload.enabled ? 'Override enabled' : 'Override disabled',
      });
    } catch (err) {
      console.error('[dashboard] Override toggle failed:', err);
      json(res, 500, { error: 'Failed to toggle override' });
    }
    return;
  }

  // POST /api/dashboard/subscription-usage/reload — restart the usage monitor
  // Resets envTokenForbidden + consecutiveErrors so a refreshed token is picked up.
  if (method === 'POST' && path === '/api/dashboard/subscription-usage/reload') {
    usageMonitor.reload();
    json(res, 200, {
      ok: true,
      monitorRunning: usageMonitor.isRunning(),
      authMode: usageMonitor.getAuthMode(),
      message: 'Usage monitor restarted',
    });
    return;
  }

  // GET /api/dashboard/config — read fritz.yaml as structured data + raw YAML
  if (method === 'GET' && path === '/api/dashboard/config') {
    try {
      const configPath = getConfigPath();
      if (!existsSync(configPath)) {
        json(res, 404, { error: 'fritz.yaml not found' });
        return;
      }
      const raw = readFileSync(configPath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (parseErr: unknown) {
        json(res, 500, { error: `Failed to parse fritz.yaml: ${parseErr instanceof Error ? parseErr.message : parseErr}` });
        return;
      }
      json(res, 200, { config: parsed, raw, path: configPath });
    } catch (err) {
      console.error('[dashboard] Config read failed:', err);
      json(res, 500, { error: 'Failed to read config' });
    }
    return;
  }

  // POST /api/dashboard/config — save fritz.yaml (backs up current file first)
  if (method === 'POST' && path === '/api/dashboard/config') {
    try {
      const body = await readBody(req);
      let payload: { yaml?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const yamlContent = payload.yaml;
      if (!yamlContent || typeof yamlContent !== 'string') {
        json(res, 400, { error: 'yaml field is required and must be a string' });
        return;
      }

      // Validate YAML syntax before saving
      try {
        const parsed = parseYaml(yamlContent);
        if (!parsed || typeof parsed !== 'object') {
          json(res, 400, { error: 'YAML must be a valid object' });
          return;
        }
        // Validate required structure: must have defaults.ttl and defaults.model
        const cfg = parsed as Record<string, unknown>;
        if (!cfg.defaults || typeof cfg.defaults !== 'object') {
          json(res, 400, { error: 'YAML must have a "defaults" section' });
          return;
        }
        const defaults = cfg.defaults as Record<string, unknown>;
        if (typeof defaults.ttl !== 'number') {
          json(res, 400, { error: 'defaults.ttl must be a number' });
          return;
        }
        if (typeof defaults.model !== 'string') {
          json(res, 400, { error: 'defaults.model must be a string' });
          return;
        }
      } catch (parseErr: unknown) {
        json(res, 400, { error: `Invalid YAML: ${parseErr instanceof Error ? parseErr.message : parseErr}` });
        return;
      }

      const configPath = getConfigPath();

      // Create backup
      const backupPath = configPath + '.bak';
      if (existsSync(configPath)) {
        copyFileSync(configPath, backupPath);
      }

      // Write new content
      writeFileSync(configPath, yamlContent, 'utf-8');

      // Reset the cached config so next access picks up changes
      resetConfigCache();

      json(res, 200, { ok: true, message: 'Config saved', backupPath });
    } catch (err) {
      console.error('[dashboard] Config save failed:', err);
      json(res, 500, { error: 'Failed to save config' });
    }
    return;
  }

  // POST /api/dashboard/config/redeploy — trigger the build-and-deploy GitHub Actions workflow
  if (method === 'POST' && path === '/api/dashboard/config/redeploy') {
    const repo = config.githubRepo;
    if (!repo) {
      json(res, 400, { error: 'GITHUB_REPO not configured' });
      return;
    }
    try {
      const deployWorkflow = getDaemonConfig().deployWorkflow;
      execSync(`gh workflow run ${deployWorkflow} --repo ${repo}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logEvent('daemon.redeploy', 'Redeploy triggered via dashboard');
      json(res, 200, { ok: true, message: 'Redeploy triggered — check GitHub Actions for progress' });
    } catch (err) {
      console.error('[dashboard] Redeploy failed:', err);
      json(res, 500, { error: `Redeploy failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  // POST /api/dashboard/config/restart — restart the daemon container
  if (method === 'POST' && path === '/api/dashboard/config/restart') {
    try {
      const activeAgents = registry.listAgents();

      json(res, 200, {
        ok: true,
        message: 'Daemon restart initiated',
        activeAgentCount: activeAgents.length,
      });

      // Schedule restart after response is sent (give 500ms for response to flush)
      setTimeout(() => {
        console.log('[dashboard] Restarting daemon process (config editor request)...');
        process.exit(0); // Docker restart policy or systemd will bring it back
      }, 500);
    } catch (err) {
      console.error('[dashboard] Restart failed:', err);
      json(res, 500, { error: 'Failed to initiate restart' });
    }
    return;
  }

  // POST /api/dashboard/config/commit — commit & push fritz.yaml to git
  if (method === 'POST' && path === '/api/dashboard/config/commit') {
    try {
      const body = await readBody(req);
      let payload: { message?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        payload = {};
      }

      const commitMessage = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : 'chore: update fritz.yaml via dashboard config editor';

      const configPath = getConfigPath();
      // In Docker: /app/config/fritz.yaml → /app (git repo root). In local dev this
      // resolves to fritz-orchestrator/ which is NOT the repo root — commit/push would
      // target the wrong directory. This endpoint is designed for Docker-only use.
      const repoDir = resolve(configPath, '../..');

      // Stage, commit, and push
      try {
        execSync(`git add "${configPath}"`, { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (stageErr: unknown) {
        json(res, 500, { error: `Git stage failed: ${stageErr instanceof Error ? stageErr.message : stageErr}` });
        return;
      }

      // Check if there are changes to commit
      try {
        execSync('git diff --cached --quiet', { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        // If exit code 0, no changes staged
        json(res, 200, { ok: true, committed: false, message: 'No changes to commit' });
        return;
      } catch {
        // Exit code 1 means there are staged changes — continue
      }

      // Use stdin for commit message to avoid shell injection
      try {
        execSync('git commit -F -', { cwd: repoDir, input: commitMessage, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (commitErr: unknown) {
        json(res, 500, { error: `Git commit failed: ${commitErr instanceof Error ? commitErr.message : commitErr}` });
        return;
      }

      try {
        execSync('git push', { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      } catch (pushErr: unknown) {
        json(res, 500, { error: `Git push failed: ${pushErr instanceof Error ? pushErr.message : pushErr}` });
        return;
      }

      json(res, 200, { ok: true, committed: true, message: `Committed and pushed: ${commitMessage}` });
    } catch (err) {
      console.error('[dashboard] Config commit failed:', err);
      json(res, 500, { error: 'Failed to commit config' });
    }
    return;
  }

  // GET /api/dashboard/env-info — read-only view of environment / runtime config
  if (method === 'GET' && path === '/api/dashboard/env-info') {
    const authMode = config.claudeOauthToken
      ? 'oauth_token'
      : config.anthropicApiKey
        ? 'api_key'
        : 'file_based';

    json(res, 200, {
      // GitHub
      githubRepo:        config.githubRepo || null,

      // Auth
      authMode,
      accountName:       config.claudeAccountName || null,
      anthropicApiKey:   config.anthropicApiKey
        ? config.anthropicApiKey.substring(0, 8) + '...'
        : null,
      oauthToken:        config.claudeOauthToken
        ? config.claudeOauthToken.substring(0, 10) + '...'
        : null,

      // Telegram
      telegramChatId:    config.telegramChatId
        ? '...' + config.telegramChatId.slice(-4)
        : null,
      telegramTagHandle: config.telegramTagHandle || null,

      // Docker
      dockerImage:       config.dockerImage,
      ghcrRegistry:      config.ghcrRegistry,

      // API / networking
      apiPort:           config.apiPort,
      daemonUrl:         config.daemonUrl,

      // Paths
      workspacesDir:     config.workspacesDir,
      hostWorkspacesDir: config.hostWorkspacesDir || null,
      claudeHome:        config.claudeHome,
    });
    return;
  }

  // GET /api/dashboard/event-log?limit=50 — recent structured events
  if (method === 'GET' && path === '/api/dashboard/event-log') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const rawLimit = parseInt(parsed.searchParams.get('limit') ?? '50', 10);
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200);
    json(res, 200, { events: getRecentEvents(limit) });
    return;
  }

  // GET /api/dashboard/daemon-log?lines=200 — last N lines of raw daemon stdout
  if (method === 'GET' && path === '/api/dashboard/daemon-log') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const rawLines = parseInt(parsed.searchParams.get('lines') ?? '200', 10);
    const lines = Math.min(Math.max(1, isNaN(rawLines) ? 200 : rawLines), 1000);
    const logPath = join(config.workspacesDir, 'logs', 'daemon.log');
    try {
      if (!existsSync(logPath)) {
        json(res, 200, { lines: [], totalLines: 0, truncated: false });
        return;
      }
      const content = readFileSync(logPath, 'utf-8');
      const all = content.split('\n').filter(l => l.length > 0);
      const totalLines = all.length;
      const truncated = totalLines > lines;
      json(res, 200, { lines: truncated ? all.slice(-lines) : all, totalLines, truncated });
    } catch (err) {
      console.error('[dashboard] Failed to read daemon log:', err);
      json(res, 500, { error: 'Failed to read daemon log' });
    }
    return;
  }

  // GET /api/dashboard/notification-mode — current Telegram notification mode
  if (method === 'GET' && path === '/api/dashboard/notification-mode') {
    json(res, 200, { mode: getNotificationMode() });
    return;
  }

  // POST /api/dashboard/notification-mode — set Telegram notification mode
  if (method === 'POST' && path === '/api/dashboard/notification-mode') {
    try {
      const body = await readBody(req);
      let payload: { mode?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (typeof payload.mode !== 'string' || !isValidNotificationMode(payload.mode)) {
        json(res, 400, { error: 'mode must be "essential", "quiet", "compact", or "verbose"' });
        return;
      }

      const prevMode = getNotificationMode();
      setNotificationMode(payload.mode);
      logEvent('notification.mode', `Notification mode: ${prevMode} → ${payload.mode}`, {
        from: prevMode, to: payload.mode,
      });
      json(res, 200, { ok: true, mode: getNotificationMode() });
    } catch (err) {
      console.error('[dashboard] Notification mode set failed:', err);
      json(res, 500, { error: 'Failed to set notification mode' });
    }
    return;
  }

  // GET /api/dashboard/comment-level — current GitHub comment level
  if (method === 'GET' && path === '/api/dashboard/comment-level') {
    json(res, 200, { level: getCommentLevel() });
    return;
  }

  // POST /api/dashboard/comment-level — set GitHub comment level
  if (method === 'POST' && path === '/api/dashboard/comment-level') {
    try {
      const body = await readBody(req);
      let payload: { level?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (typeof payload.level !== 'string' || !isValidCommentLevel(payload.level)) {
        json(res, 400, { error: 'level must be "essential", "quiet", or "verbose"' });
        return;
      }

      const prevLevel = getCommentLevel();
      setCommentLevel(payload.level);
      logEvent('comment.level', `GitHub comment level: ${prevLevel} → ${payload.level}`, {
        from: prevLevel, to: payload.level,
      });
      json(res, 200, { ok: true, level: getCommentLevel() });
    } catch (err) {
      console.error('[dashboard] Comment level set failed:', err);
      json(res, 500, { error: 'Failed to set comment level' });
    }
    return;
  }

  // GET /api/dashboard/agents/max — current max parallel agents
  if (method === 'GET' && path === '/api/dashboard/agents/max') {
    json(res, 200, {
      max: getMaxParallelAgents(),
      active: registry.listAgents().length,
    });
    return;
  }

  // POST /api/dashboard/agents/max — set max parallel agents (1–20)
  if (method === 'POST' && path === '/api/dashboard/agents/max') {
    try {
      const body = await readBody(req);
      let payload: { max?: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (typeof payload.max !== 'number' || !Number.isInteger(payload.max) || payload.max < 1 || payload.max > 20) {
        json(res, 400, { error: 'max must be an integer between 1 and 20' });
        return;
      }

      const prevMax = getMaxParallelAgents();
      setMaxParallelAgents(payload.max);
      const persisted = persistMaxParallelAgents(payload.max);
      logEvent('agents.max', `Max agents: ${prevMax} → ${payload.max}${persisted ? ' (persisted)' : ' (in-memory only)'}`, {
        from: prevMax, to: payload.max, persisted,
      });
      // Broadcast updated system status so all dashboard tabs reflect the change
      broadcastSSE('system-update', getSystemStatus());
      json(res, 200, {
        ok: true,
        max: getMaxParallelAgents(),
        active: registry.listAgents().length,
        persisted,
      });
    } catch (err) {
      console.error('[dashboard] Max agents set failed:', err);
      json(res, 500, { error: 'Failed to set max agents' });
    }
    return;
  }

  // GET /api/dashboard/retro — full retro dataset from RETRO-METRICS.md
  if (method === 'GET' && path === '/api/dashboard/retro') {
    const result = await getRetroMetrics();
    if (!result) {
      json(res, 404, { error: 'RETRO-METRICS.md not found' });
      return;
    }
    json(res, 200, result.data);
    return;
  }

  // GET /api/dashboard/retro/scans — scan history only (lighter payload)
  if (method === 'GET' && path === '/api/dashboard/retro/scans') {
    const result = await getRetroMetrics();
    if (!result) {
      json(res, 404, { error: 'RETRO-METRICS.md not found' });
      return;
    }
    json(res, 200, { scans: result.data.scans, total: result.data.scans.length, source: result.data.source });
    return;
  }

  // GET /api/dashboard/events — SSE stream
  if (method === 'GET' && path === '/api/dashboard/events') {
    handleSSE(req, res);
    return;
  }

  // Stage metrics
  if (method === 'GET' && path === '/api/dashboard/stage-metrics') {
    const archived = logArchive.listArchivedAgents();
    const roleMetrics: Record<string, { totalMs: number; count: number; recentCount: number }> = {};
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    for (const entry of archived) {
      const role = entry.summary.role ?? 'unknown';
      if (!roleMetrics[role]) roleMetrics[role] = { totalMs: 0, count: 0, recentCount: 0 };
      if (entry.summary.started && entry.summary.ended) {
        const durationMs = new Date(entry.summary.ended).getTime() - new Date(entry.summary.started).getTime();
        if (durationMs > 0) {
          roleMetrics[role].totalMs += durationMs;
          roleMetrics[role].count++;
        }
      }
      if (entry.summary.ended && new Date(entry.summary.ended).getTime() > weekStart.getTime()) {
        roleMetrics[role].recentCount++;
      }
    }

    const stages: Record<string, { avgMs: number; completedThisWeek: number }> = {};
    for (const [role, metrics] of Object.entries(roleMetrics)) {
      stages[role] = {
        avgMs: metrics.count > 0 ? Math.round(metrics.totalMs / metrics.count) : 0,
        completedThisWeek: metrics.recentCount,
      };
    }

    json(res, 200, { stages });
    return;
  }

  // Issue journey — stage transitions for a specific issue
  const journeyMatch = path.match(/^\/api\/dashboard\/journey\/(\d+)$/);
  if (method === 'GET' && journeyMatch) {
    const issueNumber = parseInt(journeyMatch[1], 10);
    const archived = logArchive.listArchivedAgents({ issue: issueNumber });

    const transitions = archived
      .filter(entry => entry.summary.started && entry.summary.ended)
      .map(entry => ({
        role: entry.summary.role ?? 'unknown',
        status: entry.summary.exitStatus ?? 'unknown',
        started: entry.summary.started,
        ended: entry.summary.ended,
        durationMs: new Date(entry.summary.ended).getTime() - new Date(entry.summary.started).getTime(),
        agent: entry.name,
      }))
      .sort((a, b) => new Date(a.started).getTime() - new Date(b.started).getTime());

    json(res, 200, { issue: issueNumber, transitions });
    return;
  }

  // Reorder — change issue priority
  if (method === 'PATCH' && path === '/api/dashboard/reorder') {
    try {
      const body = await readBody(req);
      const { issue, direction } = JSON.parse(body);
      if (!issue || !direction) {
        json(res, 400, { error: 'issue and direction required' });
        return;
      }

      const repo = config.githubRepo;
      if (!repo) {
        json(res, 500, { error: 'GITHUB_REPO not configured' });
        return;
      }

      // Get current labels for this issue
      const labels = github.gh(`issue view ${issue} --repo ${repo} --json labels --jq '.labels[].name'`).split('\n').filter(Boolean);

      // Find current priority
      const currentPriority = labels.find(l => l.startsWith('priority:'));
      const priorityOrder = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'];
      const currentIdx = currentPriority ? priorityOrder.indexOf(currentPriority) : 3;

      let newPriority: string;
      if (direction === 'up') {
        newPriority = priorityOrder[Math.max(0, currentIdx - 1)];
      } else {
        newPriority = priorityOrder[Math.min(3, currentIdx + 1)];
      }

      if (currentPriority && currentPriority !== newPriority) {
        github.gh(`issue edit ${issue} --repo ${repo} --remove-label "${currentPriority}" --add-label "${newPriority}"`);
      } else if (!currentPriority) {
        github.gh(`issue edit ${issue} --repo ${repo} --add-label "${newPriority}"`);
      }

      invalidateIssuesCache();
      json(res, 200, { ok: true, issue, newPriority });
    } catch (err) {
      console.error('[dashboard] Reorder failed:', err);
      json(res, 500, { error: 'Failed to reorder issue' });
    }
    return;
  }

  // Pause/resume individual issue
  if (method === 'PATCH' && path === '/api/dashboard/pause') {
    try {
      const body = await readBody(req);
      const { issue, paused } = JSON.parse(body);
      if (!issue || typeof paused !== 'boolean') {
        json(res, 400, { error: 'issue (number) and paused (boolean) required' });
        return;
      }

      const repo = config.githubRepo;
      if (!repo) {
        json(res, 500, { error: 'GITHUB_REPO not configured' });
        return;
      }

      if (paused) {
        github.gh(`issue edit ${issue} --repo ${repo} --add-label "fritz.paused"`);
      } else {
        github.gh(`issue edit ${issue} --repo ${repo} --remove-label "fritz.paused"`);
      }

      invalidateIssuesCache();
      json(res, 200, { ok: true, issue, paused });
    } catch (err) {
      console.error('[dashboard] Pause/resume failed:', err);
      json(res, 500, { error: 'Failed to pause/resume issue' });
    }
    return;
  }

  // GET /api/dashboard/prometheus/query — proxy PromQL instant queries to Prometheus
  if (method === 'GET' && path === '/api/dashboard/prometheus/query') {
    const parsed = new URL(url, `http://${req.headers.host}`);
    const query = parsed.searchParams.get('query');
    if (!query) {
      json(res, 400, { error: 'Missing query parameter' });
      return;
    }
    try {
      const promUrl = `http://fritzmonitor-prometheus:9090/api/v1/query?query=${encodeURIComponent(query)}`;
      const promRes = await fetch(promUrl, { signal: AbortSignal.timeout(5000) });
      const body = await promRes.text();
      res.writeHead(promRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch {
      json(res, 502, { error: 'Prometheus unreachable' });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// SSE endpoint
// ---------------------------------------------------------------------------

function handleSSE(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Parse ?since=<seq> from URL
  const urlObj = new URL(req.url!, `http://localhost`);
  const sinceParam = urlObj.searchParams.get('since');
  const sinceSeq = sinceParam ? parseInt(sinceParam, 10) : null;

  // Send full state snapshot first (existing behaviour)
  sendSSE(res, 'state', getFullState());

  // Replay missed events if client provided a cursor
  if (sinceSeq !== null && !isNaN(sinceSeq)) {
    const missed = getEventsSince(sinceSeq);
    for (const entry of missed) {
      sendSSE(res, 'event-log-entry', entry);
    }
  }

  // Add to live sseClients AFTER replay so there's no gap between replay and live
  sseClients.add(res);
  console.log(`[dashboard] SSE client connected (${sseClients.size} total)`);

  // Clean up on disconnect
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[dashboard] SSE client disconnected (${sseClients.size} remaining)`);
  });
}

// ---------------------------------------------------------------------------
// SPA serving
// ---------------------------------------------------------------------------

function serveSPA(res: ServerResponse): void {
  if (!spaFilePath || !existsSync(spaFilePath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not available');
    return;
  }

  // Always read from disk so edits to dashboard-ui.html are picked up without restart
  const content = readFileSync(spaFilePath, 'utf-8').replace('__FRITZ_VERSION__', buildVersion);

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function init(): void {
  // Resolve SPA file path
  const isDocker = existsSync('/.dockerenv');
  spaFilePath = isDocker
    ? '/app/dashboard-ui.html'
    : resolve(__dirname, '../../../../dashboard-ui.html');

  // Resolve build version — prefer baked-in file, fall back to git, then 'dev'
  const buildVersionFile = isDocker ? '/app/.build-version' : resolve(__dirname, '../../../../.build-version');
  try {
    if (existsSync(buildVersionFile)) {
      buildVersion = readFileSync(buildVersionFile, 'utf-8').trim() || 'dev';
    } else {
      buildVersion = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    }
  } catch {
    buildVersion = 'dev';
  }

  // Initialize usage pause tracking
  prevUsagePaused = usageMonitor.isUsagePaused();

  // Wire up agent count provider for usage velocity snapshots
  usageMonitor.setAgentCountProvider(() => registry.listAgents().length);

  // Subscribe to registry change events
  unsubscribeRegistry = registry.onAgentChange(onRegistryChange);

  // Subscribe to usage monitor changes
  unsubscribeUsage = usageMonitor.onUsageChange(() => {
    const nowPaused = usageMonitor.isUsagePaused();
    if (!prevUsagePaused && nowPaused) {
      const usage = usageMonitor.getUsageData();
      const pct = usage
        ? Math.round(Math.max(
            usage.fiveHour.utilization,
            usage.sevenDay.utilization,
            usage.sevenDayOpus?.utilization ?? 0
          ))
        : 0;
      logEvent('usage.paused', `Autoloop paused — session at ${pct}%`, { pct });
    } else if (prevUsagePaused && !nowPaused) {
      const usage = usageMonitor.getUsageData();
      const pct = usage
        ? Math.round(Math.max(
            usage.fiveHour.utilization,
            usage.sevenDay.utilization,
            usage.sevenDayOpus?.utilization ?? 0
          ))
        : 0;
      logEvent('usage.resumed', `Autoloop resumed — session at ${pct}%`, { pct });
    }
    prevUsagePaused = nowPaused;
    broadcastSSE('usage-update', getSystemStatus());
  });

  // Subscribe to event log entries → push to SSE clients AND invalidate
  // the merged cache when a PR merge occurs so the next workflow fetch
  // picks up the freshly-closed issue instead of a stale 5-minute cache.
  unsubscribeEventLog = onEventLogEntry((entry) => {
    broadcastSSE('event-log-entry', entry);
    handleEventLogEntryForMergedCache(entry);
  });

  // Start heartbeat timer (30s interval)
  heartbeatTimer = setInterval(() => {
    broadcastSSE('heartbeat', getSystemStatus());
  }, 30_000);

  // Start background issues refresh: immediate fire-and-forget + 30s interval.
  // Uses fetchAllOpenIssues which respects the GraphQL cache TTL to avoid redundant API calls.
  triggerBackgroundRefresh();
  issuesRefreshTimer = setInterval(triggerBackgroundRefresh, 30_000);

  console.log(`[dashboard] Initialized (SPA: ${spaFilePath})`);
}

export function destroy(): void {
  // Unsubscribe from registry
  if (unsubscribeRegistry) {
    unsubscribeRegistry();
    unsubscribeRegistry = null;
  }

  // Unsubscribe from usage changes
  if (unsubscribeUsage) {
    unsubscribeUsage();
    unsubscribeUsage = null;
  }

  // Unsubscribe from event log
  if (unsubscribeEventLog) {
    unsubscribeEventLog();
    unsubscribeEventLog = null;
  }

  // Stop heartbeat
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Stop background issues refresh
  if (issuesRefreshTimer) {
    clearInterval(issuesRefreshTimer);
    issuesRefreshTimer = null;
  }

  // Close all SSE connections
  for (const client of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();

  console.log('[dashboard] Destroyed');
}
