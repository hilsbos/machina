/**
 * Vitest tests for dashboard module.
 *
 * Imports actual functions from dashboard.ts and mocks heavy dependencies.
 *
 * Covers:
 * - getQueueData returns array
 * - notifyClients sends SSE events
 * - Agent status formatting (inline tests for coverage of patterns)
 * - Duration formatting
 * - Status badge generation
 * - Agent list sorting
 * - parseRetroMetricsContent (pure parser)
 * - getRetroMetrics (async cache + GitHub fetch + single-flight)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => ''),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual };
});

vi.mock('url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('url')>();
  return { ...actual };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, ''); }),
}));

vi.mock('yaml', () => ({
  parse: vi.fn(() => ({})),
}));

vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  listAgents: vi.fn(() => []),
  onAgentChange: vi.fn(() => () => {}),
}));

vi.mock('../agents/autoloop.js', () => ({
  isPaused: vi.fn(() => false),
  isRunning: vi.fn(() => false),
  isManuallyPaused: vi.fn(() => false),
  getLastKnownQueue: vi.fn(() => []),
}));

vi.mock('../agents/log-archive.js', () => ({
  listArchivedAgents: vi.fn(() => []),
  getArchivedLog: vi.fn(),
  getArchivedSummary: vi.fn(),
}));

vi.mock('../agents/agents.js', () => ({
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  stopAllAgents: vi.fn(),
  getAgentLogs: vi.fn(() => ''),
  getSessionTimeline: vi.fn(() => null),
  isAgentRunning: vi.fn(() => false),
  cleanupWorkspaces: vi.fn(() => ({ removed: [], errors: [] })),
}));

vi.mock('../github/github.js', () => ({
  getIssueLabels: vi.fn(() => []),
  getIssueTitle: vi.fn(() => null),
  parseDependenciesFromLabels: vi.fn((labels: string[]) =>
    labels
      .filter((l: string) => l.startsWith('fritz.depends-on:'))
      .map((l: string) => parseInt(l.replace('fritz.depends-on:', ''), 10))
      .filter((n: number) => !isNaN(n))
  ),
  MAX_REWORK_CYCLES: 3,
  DEPENDS_ON_PREFIX: 'fritz.depends-on:',
}));

vi.mock('../agents/fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getRoleModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getUsageConfig: vi.fn(() => ({ enabled: false })),
  getConfigPath: vi.fn(() => '/tmp/fritz.yaml'),
  resetConfigCache: vi.fn(),
  getNotificationMode: vi.fn(() => 'all'),
  setNotificationMode: vi.fn(),
  isValidNotificationMode: vi.fn(() => true),
}));

vi.mock('../agents/usage-monitor.js', () => ({
  getUsageData: vi.fn(() => null),
  isUsagePaused: vi.fn(() => false),
  getLastCheckTime: vi.fn(() => null),
  onUsageChange: vi.fn(() => () => {}),
  hasOverride: vi.fn(() => false),
  getAuthMode: vi.fn(() => 'none'),
  getAccountName: vi.fn(() => undefined),
  isRunning: vi.fn(() => false),
  getStopReason: vi.fn(() => null),
  setAgentCountProvider: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
  getRecentEvents: vi.fn(() => []),
  onEventLogEntry: vi.fn(() => () => {}),
  getEventsSince: vi.fn(() => []),
}));

vi.mock('../github/github-write-queue.js', () => ({
  getStats: vi.fn(() => ({ queued: 0, inFlight: 0, completed: 0, failed: 0, retries: 0 })),
}));

vi.mock('../github/github-graphql.js', () => ({
  getCachedIssues: vi.fn(() => null),
  fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
  invalidateIssuesCache: vi.fn(),
}));

vi.mock('../github/github-cache.js', () => ({
  cachedGhApiAsync: vi.fn(() => Promise.resolve('{"state":"open"}')),
  getRateLimitState: vi.fn(() => ({ remaining: 5000, resetAt: 0, paused: false })),
}));

vi.mock('../orchestrator/orchestrator.js', () => ({
  getOrchestratorHistory: vi.fn(() => ({
    conversations: [],
    connected: false,
    lastActivity: null,
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
    githubRepo: 'owner/repo',
    ghToken: 'test-token',
    fritzRoot: '/fritz-root',
  },
}));

import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { config } from '../config.js';
import { getQueueData, handleDashboardRequest, notifyClients, parseRetroMetricsContent, getRetroMetrics, clearRetroCache, init, destroy, getRecentlyMerged, refreshRecentlyMergedBackground, _resetMergedCache, handleEventLogEntryForMergedCache } from './dashboard.js';
import { getSessionTimeline } from '../agents/agents.js';
import { getCachedIssues, fetchAllOpenIssues } from '../github/github-graphql.js';
import { cachedGhApiAsync } from '../github/github-cache.js';
import { getLastKnownQueue } from '../agents/autoloop.js';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Tests ──

describe('getQueueData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an array', () => {
    const result = getQueueData();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array when no queued issues', () => {
    const result = getQueueData();
    expect(result).toEqual([]);
  });
});

describe('notifyClients', () => {
  it('does not throw when no clients connected', () => {
    expect(() => notifyClients('test-event', { data: 'hello' })).not.toThrow();
  });
});

describe('Duration formatting (pattern)', () => {
  function formatDurationFromMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  it('formats seconds', () => {
    expect(formatDurationFromMs(30_000)).toBe('30s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDurationFromMs(90_000)).toBe('1m 30s');
  });

  it('formats hours and minutes', () => {
    expect(formatDurationFromMs(3_660_000)).toBe('1h 1m');
  });

  it('handles zero', () => {
    expect(formatDurationFromMs(0)).toBe('0s');
  });
});

describe('Status badge (pattern)', () => {
  function getStatusBadge(status: string): string {
    switch (status) {
      case 'running': return 'badge-running';
      case 'completed': return 'badge-completed';
      case 'failed': return 'badge-failed';
      case 'stopped': return 'badge-stopped';
      default: return 'badge-unknown';
    }
  }

  it('returns correct badge class for running', () => {
    expect(getStatusBadge('running')).toBe('badge-running');
  });

  it('returns correct badge class for completed', () => {
    expect(getStatusBadge('completed')).toBe('badge-completed');
  });

  it('returns unknown badge for unrecognized status', () => {
    expect(getStatusBadge('other')).toBe('badge-unknown');
  });
});

describe('Agent sorting (pattern)', () => {
  interface DashboardAgent {
    name: string;
    status: string;
    started: string;
  }

  function sortAgents(agents: DashboardAgent[]): DashboardAgent[] {
    const statusOrder: Record<string, number> = {
      running: 0, failed: 1, stopped: 2, completed: 3,
    };
    return [...agents].sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
      if (orderDiff !== 0) return orderDiff;
      return new Date(b.started).getTime() - new Date(a.started).getTime();
    });
  }

  it('sorts running agents first', () => {
    const agents = [
      { name: 'a', status: 'completed', started: '2026-02-23T10:00:00Z' },
      { name: 'b', status: 'running', started: '2026-02-23T11:00:00Z' },
    ];
    const sorted = sortAgents(agents);
    expect(sorted[0].status).toBe('running');
  });

  it('handles empty array', () => {
    expect(sortAgents([])).toEqual([]);
  });
});

// ── agent-stopped SSE exitStatus fallback (issue #651) ──

describe('agent-stopped SSE exit info fallback (pattern)', () => {
  // Pattern test: the actual fallback logic lives inline in onRegistryChange's
  // 'deregistered' handler (dashboard.ts ~L1289). It's not exported, so we test
  // the pattern here to verify the fallback chain behaves correctly.
  function resolveExitStatus(
    archiveSummary: { exitStatus: string; exitCode: number | null } | null,
    agent: { exitStatus?: string; exitCode?: number | null },
  ): { exitStatus: string; exitCode: number | null } {
    return {
      exitStatus: archiveSummary?.exitStatus ?? agent.exitStatus ?? 'unknown',
      exitCode: archiveSummary?.exitCode ?? agent.exitCode ?? null,
    };
  }

  it('uses archive summary when available', () => {
    const result = resolveExitStatus(
      { exitStatus: 'completed', exitCode: 0 },
      { exitStatus: 'completed', exitCode: 0 },
    );
    expect(result.exitStatus).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('falls back to agent exit info when archive is missing', () => {
    const result = resolveExitStatus(null, { exitStatus: 'completed', exitCode: 0 });
    expect(result.exitStatus).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('falls back to agent exit info for dead agents when archive is missing', () => {
    const result = resolveExitStatus(null, { exitStatus: 'dead', exitCode: 1 });
    expect(result.exitStatus).toBe('dead');
    expect(result.exitCode).toBe(1);
  });

  it('returns unknown only when both archive and agent have no exit info', () => {
    const result = resolveExitStatus(null, {});
    expect(result.exitStatus).toBe('unknown');
    expect(result.exitCode).toBeNull();
  });

  it('agent exitStatus with null exitCode still reports correct status', () => {
    const result = resolveExitStatus(null, { exitStatus: 'completed', exitCode: null });
    expect(result.exitStatus).toBe('completed');
    expect(result.exitCode).toBeNull();
  });
});

// ── Retro metrics pure parser tests (issue #509, refactored in #537) ──

describe('parseRetroMetricsContent', () => {
  it('parses a complete RETRO-METRICS.md file', () => {
    const content = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-02-25 | log-based | 100 | 3.6M | 4.0% | 16.0% | 7m 22s | — |
| 2026-02-20 | log-based | 100 | 4.2M | 1.0% | 15.8% | 7m | (baseline) |

## Role Performance

### Scan 2 (2026-02-20 to 2026-02-25)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 32 | 9m 48s | 7m 47s | 6.16M | 0% | 66% |
| review | 40 | 6m 20s | 5m 15s | 3.19M | 5% | 53% |

### Scan 1 (2026-02-19 to 2026-02-20 — Baseline)

| Role | Agents | Avg Duration | Median Duration | Avg Cache Tokens | Failure Rate | Subagent % |
|------|--------|-------------|----------------|-----------------|-------------|------------|
| implement | 32 | 8m 11s | 7m 0s | 5.8M | 3.0% | 41% |

## Trends (Scan 1 → Scan 2)

| Role | Duration Δ | Cache Tokens Δ | Subagent % Δ | Notes |
|------|-----------|----------------|-------------|-------|
| implement | +19% (8m11s → 9m48s) | +6% (5.8M → 6.16M) | +25pp (41% → 66%) | Outlier skews average |
| review | +2% (6m13s → 6m20s) | -3% (3.3M → 3.19M) | -16pp (69% → 53%) | Quality maintained |

## Experiment Results

| Experiment | Date | Result | Adopted? |
|------------|------|--------|----------|
| (no experiments yet) | — | — | — |

## Notes

### 2026-02-25 — Scan 2

- 100% autonomous completion rate
- Validate efficiency improved 21%

### 2026-02-20 — First Retro Scan (Baseline)

- 94% completion rate
- Universal 3-minute initial timeout
`;

    const result = parseRetroMetricsContent(content);

    // Scans
    expect(result.scans).toHaveLength(2);
    expect(result.scans[0].date).toBe('2026-02-25');
    expect(result.scans[0].agents).toBe(100);
    expect(result.scans[0].avgCacheTokens).toBe('3.6M');
    expect(result.scans[0].failureRate).toBe('4.0%');
    expect(result.scans[0].reworkPct).toBe('16.0%');
    expect(result.scans[0].avgDuration).toBe('7m 22s');
    expect(result.scans[0].experiments).toBe('—');
    expect(result.scans[0].notes).toHaveLength(2);
    expect(result.scans[0].notes[0]).toBe('100% autonomous completion rate');

    expect(result.scans[1].date).toBe('2026-02-20');
    expect(result.scans[1].experiments).toBe('(baseline)');
    expect(result.scans[1].notes).toHaveLength(2);

    // Role performance — keys use end-date from scan range header
    expect(Object.keys(result.rolePerformance)).toHaveLength(2);
    expect(result.rolePerformance['2026-02-25']).toHaveLength(2);
    expect(result.rolePerformance['2026-02-25'][0].role).toBe('implement');
    expect(result.rolePerformance['2026-02-25'][0].agents).toBe(32);
    expect(result.rolePerformance['2026-02-25'][0].avgDuration).toBe('9m 48s');
    expect(result.rolePerformance['2026-02-25'][0].subagentPct).toBe('66%');

    expect(result.rolePerformance['2026-02-20']).toHaveLength(1);
    expect(result.rolePerformance['2026-02-20'][0].role).toBe('implement');

    // Trends
    expect(result.trends).toHaveLength(2);
    expect(result.trends[0].role).toBe('implement');
    expect(result.trends[0].durationDelta).toBe('+19% (8m11s → 9m48s)');
    expect(result.trends[0].tokensDelta).toBe('+6% (5.8M → 6.16M)');
    expect(result.trends[0].subagentDelta).toBe('+25pp (41% → 66%)');
    expect(result.trends[0].notes).toBe('Outlier skews average');

    // Experiments (placeholder row should be skipped)
    expect(result.experiments).toHaveLength(0);

    // Parse errors
    expect(result.parseErrors).toHaveLength(0);

    // lastUpdated derived from first scan date
    expect(result.lastUpdated).toBe('2026-02-25T00:00:00.000Z');
  });

  it('handles missing sections gracefully', () => {
    const content = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-02-25 | log-based | 50 | 2.0M | 2.0% | 10.0% | 5m | — |
`;

    const result = parseRetroMetricsContent(content);
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0].agents).toBe(50);
    expect(result.rolePerformance).toEqual({});
    expect(result.trends).toEqual([]);
    expect(result.experiments).toEqual([]);
    expect(result.scans[0].notes).toEqual([]);
  });

  it('handles single scan with no notes', () => {
    const content = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-02-20 | log-based | 100 | 4.2M | 1.0% | 15.8% | 7m | (baseline) |
`;

    const result = parseRetroMetricsContent(content);
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0].date).toBe('2026-02-20');
    expect(result.scans[0].notes).toEqual([]);
  });

  it('derives lastUpdated from first scan date', () => {
    const content = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-02-25 | log-based | 100 | 3.6M | 4.0% | 16.0% | 7m 22s | — |
| 2026-02-20 | log-based | 100 | 4.2M | 1.0% | 15.8% | 7m | (baseline) |
`;

    const result = parseRetroMetricsContent(content);
    expect(result.lastUpdated).toBe('2026-02-25T00:00:00.000Z');
  });

  it('uses current time for lastUpdated when no scans exist', () => {
    const before = Date.now();
    const result = parseRetroMetricsContent('# Empty\n## Metrics History\n');
    const after = Date.now();
    const lastUpdatedMs = new Date(result.lastUpdated).getTime();
    expect(lastUpdatedMs).toBeGreaterThanOrEqual(before);
    expect(lastUpdatedMs).toBeLessThanOrEqual(after);
  });

  it('returns empty arrays for empty content', () => {
    const result = parseRetroMetricsContent('');
    expect(result.scans).toEqual([]);
    expect(result.rolePerformance).toEqual({});
    expect(result.trends).toEqual([]);
    expect(result.experiments).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('handles malformed scan dates gracefully (no RangeError)', () => {
    const content = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| N/A | log-based | 50 | 2.0M | 2.0% | 10.0% | 5m | — |
`;

    const before = Date.now();
    const result = parseRetroMetricsContent(content);
    const after = Date.now();

    // Should not throw — falls back to current time
    expect(result.scans).toHaveLength(1);
    expect(result.scans[0].date).toBe('N/A');
    const lastUpdatedMs = new Date(result.lastUpdated).getTime();
    expect(lastUpdatedMs).toBeGreaterThanOrEqual(before);
    expect(lastUpdatedMs).toBeLessThanOrEqual(after);
  });
});

// ── getRetroMetrics async tests (issue #537) ──

describe('getRetroMetrics', () => {
  const mockExistsSync = vi.mocked(existsSync);
  const mockReadFileSync = vi.mocked(readFileSync);
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const sampleContent = `# Retro Metrics History

## Metrics History

| Date | Mode | Agents | Avg Tokens (cache) | Failure Rate | Rework % | Avg Duration | Experiments |
|------|------|--------|-------------------|-------------|----------|-------------|-------------|
| 2026-02-25 | log-based | 100 | 3.6M | 4.0% | 16.0% | 7m 22s | — |
`;

  const base64Content = Buffer.from(sampleContent).toString('base64');

  function mockGitHubSuccess(): void {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        content: base64Content,
        sha: 'abc123def456',
        encoding: 'base64',
      }),
    } as Response);
  }

  function mockGitHub404(): void {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ message: 'Not Found' }),
    } as Response);
  }

  function mockGitHub403(): void {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ message: 'rate limit exceeded' }),
    } as Response);
  }

  function mockGitHubTimeout(): void {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearRetroCache();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    clearRetroCache();
    fetchSpy.mockRestore();
  });

  it('fetches from GitHub API and returns parsed data with source github', async () => {
    mockGitHubSuccess();

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('github');
    expect(result!.data.scans).toHaveLength(1);
    expect(result!.data.scans[0].date).toBe('2026-02-25');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when GitHub returns 404 and no local file', async () => {
    mockGitHub404();
    mockExistsSync.mockReturnValue(false);

    const result = await getRetroMetrics();
    expect(result).toBeNull();
  });

  it('falls back to local file when GitHub returns 404 but local exists', async () => {
    mockGitHub404();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
    expect(result!.data.scans).toHaveLength(1);
  });

  it('falls back to local file when GitHub returns 500', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Internal Server Error' }),
    } as Response);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
    expect(result!.data.scans).toHaveLength(1);
  });

  it('falls back to local file when GitHub returns 403', async () => {
    mockGitHub403();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
    expect(result!.data.scans).toHaveLength(1);
  });

  it('falls back to local file when GitHub fetch times out', async () => {
    mockGitHubTimeout();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
  });

  it('falls back to local when ghToken is not set', async () => {
    const originalToken = (config as Record<string, unknown>).ghToken;
    (config as Record<string, unknown>).ghToken = undefined;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
    expect(fetchSpy).not.toHaveBeenCalled();

    (config as Record<string, unknown>).ghToken = originalToken;
  });

  it('falls back to local when githubRepo is not set', async () => {
    const originalRepo = (config as Record<string, unknown>).githubRepo;
    (config as Record<string, unknown>).githubRepo = undefined;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(sampleContent);

    const result = await getRetroMetrics();
    expect(result).not.toBeNull();
    expect(result!.data.source).toBe('local');
    expect(fetchSpy).not.toHaveBeenCalled();

    (config as Record<string, unknown>).githubRepo = originalRepo;
  });

  it('returns cached result within TTL', async () => {
    mockGitHubSuccess();

    // First call — populates cache
    const first = await getRetroMetrics();
    expect(first).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const second = await getRetroMetrics();
    expect(second).not.toBeNull();
    expect(second!.data.source).toBe('cache');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after cache TTL expires', async () => {
    mockGitHubSuccess();

    // First call — populates cache
    await getRetroMetrics();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past TTL (120s)
    const originalDateNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(originalDateNow() + 121_000);

    // Second call — TTL expired, should re-fetch
    await getRetroMetrics();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it('single-flight: concurrent calls share one fetch', async () => {
    let resolvePromise: ((v: Response) => void) | null = null;
    fetchSpy.mockImplementation(() => new Promise<Response>(resolve => {
      resolvePromise = resolve;
    }));

    // Start two concurrent calls
    const p1 = getRetroMetrics();
    const p2 = getRetroMetrics();

    // Only one fetch should have been initiated
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Resolve the fetch
    resolvePromise!({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        content: base64Content,
        sha: 'abc123',
        encoding: 'base64',
      }),
    } as Response);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.data.scans).toHaveLength(1);
    expect(r2!.data.scans).toHaveLength(1);
  });

  it('clearRetroCache resets cache and inflight state', async () => {
    mockGitHubSuccess();

    // Populate cache
    await getRetroMetrics();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Clear cache
    clearRetroCache();

    // Next call should re-fetch
    await getRetroMetrics();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null when both GitHub and local file are unavailable', async () => {
    mockGitHubTimeout();
    mockExistsSync.mockReturnValue(false);

    const result = await getRetroMetrics();
    expect(result).toBeNull();
  });

  it('returns null (does not throw) when doFetchAndParse encounters an error', async () => {
    // Simulate an unexpected error from fetch (not a network error, but e.g. json parse failure)
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token')),
    } as unknown as Response);

    const result = await getRetroMetrics();
    // Should return null instead of propagating the error
    expect(result).toBeNull();
  });
});

// ── History query param logic (pattern tests for dashboard.ts inline logic) ──

describe('History since param computation (pattern)', () => {
  function computeSinceISO(sinceParam: string): string | undefined {
    const now = new Date('2026-03-23T12:00:00Z');
    if (sinceParam === 'today') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    } else if (sinceParam === '7d') {
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (sinceParam === '30d') {
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    return undefined;
  }

  it('today returns start of UTC day', () => {
    const result = computeSinceISO('today');
    expect(result).toBe('2026-03-23T00:00:00.000Z');
  });

  it('7d returns 7 days ago', () => {
    const result = computeSinceISO('7d');
    expect(result).toBe('2026-03-16T12:00:00.000Z');
  });

  it('30d returns 30 days ago', () => {
    const result = computeSinceISO('30d');
    expect(result).toBe('2026-02-21T12:00:00.000Z');
  });

  it('unknown value returns undefined (no filter)', () => {
    expect(computeSinceISO('unknown')).toBeUndefined();
    expect(computeSinceISO('')).toBeUndefined();
  });
});

describe('History countOnly response (pattern)', () => {
  it('returns total count when countOnly is true', () => {
    const allHistory = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const countOnly = true;
    if (countOnly) {
      const result = { total: allHistory.length };
      expect(result).toEqual({ total: 3 });
    }
  });

  it('returns 0 for empty history', () => {
    const allHistory: unknown[] = [];
    expect({ total: allHistory.length }).toEqual({ total: 0 });
  });
});

describe('History groupBy=day bucketing (pattern)', () => {
  function groupByDay(archives: { summary: { ended: string } }[]): { date: string; count: number }[] {
    const buckets = new Map<string, number>();
    for (const a of archives) {
      const date = a.summary.ended.slice(0, 10);
      buckets.set(date, (buckets.get(date) ?? 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));
  }

  it('groups archives by day', () => {
    const archives = [
      { summary: { ended: '2026-03-23T10:00:00Z' } },
      { summary: { ended: '2026-03-23T14:00:00Z' } },
      { summary: { ended: '2026-03-22T10:00:00Z' } },
    ];
    const result = groupByDay(archives);
    expect(result).toEqual([
      { date: '2026-03-22', count: 1 },
      { date: '2026-03-23', count: 2 },
    ]);
  });

  it('returns empty array for no archives', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('returns single bucket for same-day archives', () => {
    const archives = [
      { summary: { ended: '2026-03-23T01:00:00Z' } },
      { summary: { ended: '2026-03-23T23:59:59Z' } },
    ];
    const result = groupByDay(archives);
    expect(result).toEqual([{ date: '2026-03-23', count: 2 }]);
  });
});

describe('Usage period cost computation (pattern)', () => {
  function computeCost(agg: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
  }): number {
    // Sonnet pricing baseline
    const cost =
      (agg.inputTokens / 1_000_000) * 3 +
      (agg.cacheReadInputTokens / 1_000_000) * 0.30 +
      (agg.cacheCreationInputTokens / 1_000_000) * 3.75 +
      (agg.outputTokens / 1_000_000) * 15;
    return Math.round(cost * 100) / 100;
  }

  it('computes cost for typical token counts', () => {
    const result = computeCost({
      inputTokens: 1_000_000,
      cacheReadInputTokens: 2_000_000,
      cacheCreationInputTokens: 500_000,
      outputTokens: 100_000,
    });
    // 3 + 0.60 + 1.875 + 1.50 = 6.975 → rounds to 6.98
    expect(result).toBe(6.98);
  });

  it('returns 0 for zero tokens', () => {
    const result = computeCost({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    });
    expect(result).toBe(0);
  });

  it('handles large token counts', () => {
    const result = computeCost({
      inputTokens: 10_000_000,
      cacheReadInputTokens: 50_000_000,
      cacheCreationInputTokens: 5_000_000,
      outputTokens: 2_000_000,
    });
    // 30 + 15 + 18.75 + 30 = 93.75
    expect(result).toBe(93.75);
  });
});

describe('Usage period param parsing (pattern)', () => {
  function computePeriodMs(period: string, now: Date): number | null {
    if (period === '30d') return 30 * 24 * 60 * 60 * 1000;
    if (period === '7d') return 7 * 24 * 60 * 60 * 1000;
    if (period === 'today') return now.getTime() - new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    return null;
  }

  it('30d returns 30 days in ms', () => {
    const result = computePeriodMs('30d', new Date());
    expect(result).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('7d returns 7 days in ms', () => {
    const result = computePeriodMs('7d', new Date());
    expect(result).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('today returns ms since UTC midnight', () => {
    const now = new Date('2026-03-23T14:30:00Z');
    const result = computePeriodMs('today', now);
    // 14h 30m = 52200000 ms
    expect(result).toBe(14 * 60 * 60 * 1000 + 30 * 60 * 1000);
  });

  it('unknown period returns null', () => {
    expect(computePeriodMs('1y', new Date())).toBeNull();
    expect(computePeriodMs('', new Date())).toBeNull();
  });
});

describe('GitHub quota clamping (pattern)', () => {
  function computeQuotaPercent(remaining: number): number {
    const limit = 5000;
    if (remaining < 0) return 100;
    return Math.min(100, Math.round((remaining / limit) * 100));
  }

  it('returns 100 for full quota', () => {
    expect(computeQuotaPercent(5000)).toBe(100);
  });

  it('returns 0 for exhausted quota', () => {
    expect(computeQuotaPercent(0)).toBe(0);
  });

  it('clamps above 100 for GitHub Apps with higher limits', () => {
    // GitHub Apps get 15000/hour — remaining can exceed hardcoded 5000 limit
    expect(computeQuotaPercent(15000)).toBe(100);
  });

  it('returns 100 for negative remaining (unknown state)', () => {
    expect(computeQuotaPercent(-1)).toBe(100);
  });

  it('computes percentage for partial quota', () => {
    expect(computeQuotaPercent(2500)).toBe(50);
  });
});

describe('Failure streak with expired status (pattern)', () => {
  function computeStreak(statuses: string[]): number {
    let streak = 0;
    for (const status of statuses) {
      if (status === 'completed' || status === 'stopped' || status === 'expired') break;
      streak++;
    }
    return streak;
  }

  it('counts dead agents as failures', () => {
    expect(computeStreak(['dead', 'dead', 'completed'])).toBe(2);
  });

  it('expired breaks the streak', () => {
    expect(computeStreak(['dead', 'expired', 'dead'])).toBe(1);
  });

  it('completed breaks the streak', () => {
    expect(computeStreak(['completed', 'dead'])).toBe(0);
  });

  it('stopped breaks the streak', () => {
    expect(computeStreak(['stopped', 'dead'])).toBe(0);
  });

  it('returns 0 for empty archive', () => {
    expect(computeStreak([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Async background refresh (issue #486)
// ---------------------------------------------------------------------------

describe('getIssuesData (cache-only via /api/dashboard/issues)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockReqRes(url: string): { req: IncomingMessage; res: ServerResponse; body: () => unknown } {
    let responseBody = '';
    const req = { url, method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((data: string) => { responseBody = data; }),
      setHeader: vi.fn(),
    } as unknown as ServerResponse;
    return { req, res, body: () => JSON.parse(responseBody) };
  }

  it('returns empty issues array when GraphQL cache is cold', async () => {
    vi.mocked(getCachedIssues).mockReturnValue(null);

    const { req, res, body } = mockReqRes('/api/dashboard/issues');
    await handleDashboardRequest(req, res);

    const result = body() as { issues: unknown[]; total: number };
    expect(result.issues).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('transforms and returns GraphQL cached issues', async () => {
    vi.mocked(getCachedIssues).mockReturnValue([
      {
        number: 42,
        title: 'Test issue',
        updatedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
        labels: ['fritz.status:for-implement', 'priority:p1'],
      },
    ]);

    const { req, res, body } = mockReqRes('/api/dashboard/issues');
    await handleDashboardRequest(req, res);

    const result = body() as { issues: Array<{ number: number; title: string; status: string; priority: number | null }>; total: number };
    expect(result.total).toBe(1);
    expect(result.issues[0].number).toBe(42);
    expect(result.issues[0].title).toBe('Test issue');
    expect(result.issues[0].status).toBe('for-implement');
    expect(result.issues[0].priority).toBe(1);
  });
});

describe('isDependencyClosedCached (async refresh via getQueueData)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues async refresh via cachedGhApiAsync on dep cache miss', () => {
    const mockCachedGhApiAsync = vi.mocked(cachedGhApiAsync);
    mockCachedGhApiAsync.mockResolvedValue('{"state":"closed"}');

    // Provide autoloop queue with an issue that has fritz.depends-on labels.
    // getQueueData parses fritz.depends-on: labels directly and calls isDependencyClosedCached.
    vi.mocked(getLastKnownQueue).mockReturnValue([
      {
        number: 42,
        title: 'Issue with dep',
        labels: ['fritz.status:for-implement', 'fritz.depends-on:99'],
      },
    ] as ReturnType<typeof getLastKnownQueue>);

    const result = getQueueData();

    // On cache miss, isDependencyClosedCached returns false (assume open) and queues async refresh
    expect(result[0].blocked).toBe(true);
    expect(result[0].blockedBy).toEqual([99]);

    // cachedGhApiAsync should have been called to refresh the dep cache
    expect(mockCachedGhApiAsync).toHaveBeenCalledWith(
      'repos/owner/repo/issues/99',
      { ttl: 60_000 },
    );
  });

  it('returns cached dep status without re-fetching when TTL is valid', async () => {
    const mockCachedGhApiAsync = vi.mocked(cachedGhApiAsync);
    mockCachedGhApiAsync.mockResolvedValue('{"state":"closed"}');

    // Use dep 200 (unique to this test — depClosedCache is module-level and persists)
    vi.mocked(getLastKnownQueue).mockReturnValue([
      {
        number: 50,
        title: 'Issue with dep',
        labels: ['fritz.status:for-implement', 'fritz.depends-on:200'],
      },
    ] as ReturnType<typeof getLastKnownQueue>);

    // First call — triggers async refresh for dep 200
    getQueueData();
    expect(mockCachedGhApiAsync).toHaveBeenCalledTimes(1);

    // Allow the promise to settle so depClosedCache is populated
    await new Promise(r => setTimeout(r, 0));

    mockCachedGhApiAsync.mockClear();

    // Second call — should use cached result (dep 200 is closed)
    const result = getQueueData();
    expect(result[0].blocked).toBe(false);
    expect(result[0].blockedBy).toEqual([]);
    expect(mockCachedGhApiAsync).not.toHaveBeenCalled();
  });
});

describe('Background refresh timer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    destroy();
    vi.useRealTimers();
  });

  it('init() triggers immediate background refresh', () => {
    const mockFetchAll = vi.mocked(fetchAllOpenIssues);
    mockFetchAll.mockResolvedValue([]);

    init();

    // fetchAllOpenIssues should be called immediately on init
    expect(mockFetchAll).toHaveBeenCalledWith('owner', 'repo');
  });

  it('init() sets up 30s interval for background refresh', () => {
    const mockFetchAll = vi.mocked(fetchAllOpenIssues);
    mockFetchAll.mockResolvedValue([]);

    init();
    mockFetchAll.mockClear();

    // Advance 30 seconds — should trigger another refresh
    vi.advanceTimersByTime(30_000);
    expect(mockFetchAll).toHaveBeenCalledTimes(1);
    expect(mockFetchAll).toHaveBeenCalledWith('owner', 'repo');
  });

  it('destroy() stops the background refresh timer', () => {
    const mockFetchAll = vi.mocked(fetchAllOpenIssues);
    mockFetchAll.mockResolvedValue([]);

    init();
    mockFetchAll.mockClear();

    destroy();

    // Advance time — should NOT trigger any more refreshes
    vi.advanceTimersByTime(60_000);
    expect(mockFetchAll).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getRecentlyMerged — async background refresh (non-blocking)
// ---------------------------------------------------------------------------

describe('getRecentlyMerged', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mockExec = vi.mocked(exec) as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetMergedCache();
    mockExec.mockReset();
    // Default: callback with empty string (no results)
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, ''); });
  });

  it('returns empty array on cache miss and triggers background refresh', () => {
    const result = getRecentlyMerged();
    expect(result).toEqual([]);
    // exec should have been called to fetch data in background
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toContain('gh issue list');
  });

  it('returns cached data when cache is fresh', () => {
    // Populate cache by triggering a background refresh with mock data
    const now = new Date().toISOString();
    const mockData = JSON.stringify([
      { number: 1, title: 'Test', closedAt: now, labels: [] },
    ]);
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, mockData); });

    // First call triggers background refresh
    refreshRecentlyMergedBackground();
    // Cache should now be populated
    const result = getRecentlyMerged();
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);

    // Second call should NOT trigger another exec (cache is fresh)
    mockExec.mockClear();
    const result2 = getRecentlyMerged();
    expect(result2).toHaveLength(1);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('prevents duplicate in-flight requests (single-flight guard)', () => {
    // Make exec NOT call the callback (simulates in-flight request)
    mockExec.mockImplementation(() => {});

    refreshRecentlyMergedBackground();
    refreshRecentlyMergedBackground(); // should be guarded
    refreshRecentlyMergedBackground(); // should be guarded

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('returns stale data immediately on cache miss', () => {
    vi.useFakeTimers();
    try {
      // Populate cache, then let it expire
      const now = new Date().toISOString();
      const mockData = JSON.stringify([
        { number: 42, title: 'Stale', closedAt: now, labels: [] },
      ]);
      mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, mockData); });
      refreshRecentlyMergedBackground();

      // Expire the cache by advancing time past MERGED_CACHE_TTL_MS (5 min)
      vi.advanceTimersByTime(300_001);

      // Make exec not callback (simulate slow in-flight request)
      mockExec.mockImplementation(() => {});

      // Should return stale data immediately, not block
      const result = getRecentlyMerged();
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handleEventLogEntryForMergedCache: pr.merged invalidates cache and triggers refresh', () => {
    // Populate cache with a known entry
    const now = new Date().toISOString();
    const mockDataBefore = JSON.stringify([
      { number: 100, title: 'Old merged', closedAt: now, labels: [] },
    ]);
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, mockDataBefore); });
    refreshRecentlyMergedBackground();
    expect(getRecentlyMerged()).toHaveLength(1);
    expect(getRecentlyMerged()[0].number).toBe(100);

    // Arm exec to return a DIFFERENT list on the next call (simulating the
    // freshly-merged issue being picked up by gh issue list)
    const mockDataAfter = JSON.stringify([
      { number: 200, title: 'Freshly merged', closedAt: now, labels: [] },
      { number: 100, title: 'Old merged', closedAt: now, labels: [] },
    ]);
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, mockDataAfter); });

    // Fire the handler with a pr.merged event (as the event-log subscription would)
    handleEventLogEntryForMergedCache({ type: 'pr.merged' });

    // Cache should now contain the fresh data
    const after = getRecentlyMerged();
    expect(after).toHaveLength(2);
    expect(after.map(i => i.number)).toEqual([200, 100]);
  });

  it('handleEventLogEntryForMergedCache: unrelated events do not invalidate cache', () => {
    // Populate cache
    const now = new Date().toISOString();
    const mockData = JSON.stringify([
      { number: 300, title: 'Stable', closedAt: now, labels: [] },
    ]);
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => { cb(null, mockData); });
    refreshRecentlyMergedBackground();
    expect(getRecentlyMerged()).toHaveLength(1);

    // Clear exec tracking and fire unrelated events
    mockExec.mockClear();
    handleEventLogEntryForMergedCache({ type: 'agent.started' });
    handleEventLogEntryForMergedCache({ type: 'autoloop.rebase-needed' });
    handleEventLogEntryForMergedCache({ type: 'issue.done' });

    // No refresh should have been triggered, cache still serves original data
    expect(mockExec).not.toHaveBeenCalled();
    expect(getRecentlyMerged()[0].number).toBe(300);
  });
});

describe('GET /api/dashboard/session-log/:name (issue #926)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockReqRes(url: string): {
    req: IncomingMessage;
    res: ServerResponse;
    status: () => number;
    body: () => unknown;
  } {
    let responseBody = '';
    let responseStatus = 0;
    const req = { url, method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    const res = {
      writeHead: vi.fn((status: number) => { responseStatus = status; }),
      end: vi.fn((data: string) => { responseBody = data; }),
      setHeader: vi.fn(),
    } as unknown as ServerResponse;
    return {
      req,
      res,
      status: () => responseStatus,
      body: () => JSON.parse(responseBody),
    };
  }

  it('returns 200 { log: "" } when no session timeline exists (empty-string contract, not 404)', async () => {
    vi.mocked(getSessionTimeline).mockReturnValue(null);

    const { req, res, status, body } = mockReqRes('/api/dashboard/session-log/architect-926-eac0');
    await handleDashboardRequest(req, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ log: '' });
    expect(getSessionTimeline).toHaveBeenCalledWith('architect-926-eac0', 3800);
  });

  it('returns 200 { log: <content> } when session timeline exists for an archived agent', async () => {
    vi.mocked(getSessionTimeline).mockReturnValue('[USER] hello\n[ASSISTANT] hi\n');

    const { req, res, status, body } = mockReqRes('/api/dashboard/session-log/implement-926-abcd');
    await handleDashboardRequest(req, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ log: '[USER] hello\n[ASSISTANT] hi\n' });
  });

  it('uses 500_000-byte cap when full=1 query param is set, otherwise 3800', async () => {
    vi.mocked(getSessionTimeline).mockReturnValue('');

    const a = mockReqRes('/api/dashboard/session-log/agent-1?full=1');
    await handleDashboardRequest(a.req, a.res);
    expect(getSessionTimeline).toHaveBeenLastCalledWith('agent-1', 500_000);

    const b = mockReqRes('/api/dashboard/session-log/agent-1');
    await handleDashboardRequest(b.req, b.res);
    expect(getSessionTimeline).toHaveBeenLastCalledWith('agent-1', 3800);
  });

  it('returns 400 for an invalid agent name (AGENT_NAME_RE guard)', async () => {
    const { req, res, status, body } = mockReqRes('/api/dashboard/session-log/../../etc/passwd');
    await handleDashboardRequest(req, res);

    expect(status()).toBe(400);
    expect(body()).toEqual({ error: 'Invalid agent name' });
    expect(getSessionTimeline).not.toHaveBeenCalled();
  });

  it('degrades silently to 200 { log: "" } if getSessionTimeline throws (no UI error toast)', async () => {
    vi.mocked(getSessionTimeline).mockImplementation(() => {
      throw new Error('disk read failure');
    });

    const { req, res, status, body } = mockReqRes('/api/dashboard/session-log/agent-x');
    await handleDashboardRequest(req, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ log: '' });
  });
});
