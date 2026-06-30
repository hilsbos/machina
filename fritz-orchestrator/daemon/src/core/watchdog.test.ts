/**
 * Vitest unit tests for watchdog.
 *
 * Covers:
 * - getSummary forces REST refresh when local > 0 but cache shows 0 active
 * - Orphan cleanup restores correct status based on agent role
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockListAgents = vi.fn<() => Array<{ name: string; issue?: number }>>(() => []);
const mockGetExpiredAgents = vi.fn(() => []);
const mockGetAgent = vi.fn();

vi.mock('./registry.js', () => ({
  listAgents: () => mockListAgents(),
  getExpiredAgents: () => mockGetExpiredAgents(),
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
}));

const mockGetActiveAgents = vi.fn<() => Promise<Array<{ issue: number; title: string; role: string; status: string }>>>(
  async () => []
);
const mockPruneReleasedAgents = vi.fn();
const mockTransitionStatus = vi.fn();

vi.mock('../github/github.js', () => ({
  getActiveAgents: () => mockGetActiveAgents(),
  pruneReleasedAgents: () => mockPruneReleasedAgents(),
  transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  getOrphanRestoreStatus: (role: string, hadActivity = true) => {
    switch (role) {
      case 'implement':       return hadActivity ? 'for-rework' : 'for-implement';
      case 'review':          return 'for-review';
      case 'validate':        return 'for-validate';
      case 'define':          return 'for-define';
      case 'architect':       return 'for-architect';
      case 'ux':              return 'for-ux';
      case 'budget':          return 'for-budget';
      case 'security-review': return 'for-security-review';
      case 'pentest':         return 'for-pentest';
      default:                return 'for-human';
    }
  },
}));

const mockListRunningProcesses = vi.fn<() => string[]>(() => []);
const mockIsBootInProgress = vi.fn(() => false);
const mockCleanupWorkspaces = vi.fn(() => ({ removed: [], errors: [] }));

vi.mock('../agents/agents.js', () => ({
  listRunningProcesses: () => mockListRunningProcesses(),
  isBootInProgress: (...args: unknown[]) => mockIsBootInProgress(...args),
  stopAgent: vi.fn(),
  cleanupWorkspaces: () => mockCleanupWorkspaces(),
}));

vi.mock('./lifecycle.js', () => ({
  timeout: vi.fn(),
  completed: vi.fn(),
  system: vi.fn(),
}));

vi.mock('../agents/agent-comms.js', () => ({
  destroyAgent: vi.fn(),
}));

vi.mock('../agents/fritz-config.js', () => ({
  getDaemonConfig: () => ({ watchdogIntervalSec: 60, workspaceMaxAgeHours: 0 }),
  getLogArchiveMaxAgeDays: () => 0,
}));

vi.mock('../agents/log-archive.js', () => ({
  archiveAgentLogs: vi.fn(),
  cleanupLogArchive: () => ({ removed: [], errors: [] }),
}));

vi.mock('./event-log.js', () => ({
  logEvent: vi.fn(),
}));

let mockCachedIssues: Array<{ number: number; title: string; labels: string[] }> | null = null;
const mockInvalidateIssuesCache = vi.fn();

vi.mock('../github/github-graphql.js', () => ({
  getCachedIssues: () => mockCachedIssues,
  getActiveFromCache: (issues: Array<{ labels: string[] }>) =>
    issues.filter(i => i.labels.includes('fritz.status:active')),
  invalidateIssuesCache: () => mockInvalidateIssuesCache(),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import { check, resetMismatchCount, getMismatchCount } from './watchdog.js';
import { logEvent } from './event-log.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watchdog cache refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCachedIssues = null;
    mockListAgents.mockReturnValue([]);
    mockListRunningProcesses.mockReturnValue([]);
    mockGetActiveAgents.mockResolvedValue([]);
    resetMismatchCount();
  });

  it('does not trigger REST refresh when local=0 and GitHub=0', async () => {
    mockCachedIssues = [];
    await check();

    expect(mockGetActiveAgents).not.toHaveBeenCalled();
    expect(mockInvalidateIssuesCache).not.toHaveBeenCalled();
    expect(getMismatchCount()).toBe(0);
  });

  it('does not trigger REST refresh when local and GitHub are consistent', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 42 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = [
      { number: 42, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:implement'] },
    ];

    await check();

    expect(mockGetActiveAgents).not.toHaveBeenCalled();
    expect(mockInvalidateIssuesCache).not.toHaveBeenCalled();
    expect(getMismatchCount()).toBe(0);
  });

  it('forces REST refresh when issue-tracked local > 0 but cache shows 0 active', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 42 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = [
      { number: 42, title: 'Test', labels: ['fritz.status:for-implement'] },
    ];
    mockGetActiveAgents.mockResolvedValue([
      { issue: 42, title: 'Test', role: 'implement', status: 'working' },
    ]);

    await check();

    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
    expect(mockGetActiveAgents).toHaveBeenCalled();
    expect(getMismatchCount()).toBe(0);
  });

  it('does NOT trigger REST refresh for manually spawned agents (issue=null)', async () => {
    mockListAgents.mockReturnValue([{ name: 'manual-agent', issue: null }]);
    mockListRunningProcesses.mockReturnValue(['manual-agent']);
    mockCachedIssues = [];

    await check();

    // No REST refresh — manual agents have no GitHub counterpart
    expect(mockGetActiveAgents).not.toHaveBeenCalled();
    expect(mockInvalidateIssuesCache).not.toHaveBeenCalled();
    expect(getMismatchCount()).toBe(0);
  });

  it('increments mismatch counter only for issue-tracked agents', async () => {
    // Mix of tracked and untracked agents — only tracked should count
    mockListAgents.mockReturnValue([
      { name: 'daemon-agent', issue: 42 },
      { name: 'manual-agent', issue: null },
    ]);
    mockListRunningProcesses.mockReturnValue(['daemon-agent', 'manual-agent']);
    mockCachedIssues = [];
    mockGetActiveAgents.mockResolvedValue([]);

    await check();
    expect(getMismatchCount()).toBe(1);

    await check();
    expect(getMismatchCount()).toBe(2);
    expect(logEvent).toHaveBeenCalledWith(
      'watchdog.mismatch',
      expect.stringContaining('2 cycles'),
      expect.objectContaining({ cycles: 2, trackedLocal: 1 }),
    );
  });

  it('resets mismatch counter when state becomes consistent', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 42 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = [];
    mockGetActiveAgents.mockResolvedValue([]);

    await check();
    await check();
    expect(getMismatchCount()).toBe(2);

    mockGetActiveAgents.mockResolvedValue([
      { issue: 42, title: 'Test', role: 'implement', status: 'working' },
    ]);

    await check();
    expect(getMismatchCount()).toBe(0);
  });

  it('falls back to REST when cache is null (not populated)', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 42 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = null;
    mockGetActiveAgents.mockResolvedValue([
      { issue: 42, title: 'Test', role: 'implement', status: 'working' },
    ]);

    await check();

    expect(mockGetActiveAgents).toHaveBeenCalledTimes(1);
    expect(getMismatchCount()).toBe(0);
  });

  it('does not double-call REST when cache is null and REST returns 0', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 42 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = null;
    mockGetActiveAgents.mockResolvedValue([]);

    await check();

    expect(mockGetActiveAgents).toHaveBeenCalledTimes(1);
    expect(mockInvalidateIssuesCache).not.toHaveBeenCalled();
    expect(getMismatchCount()).toBe(1);
  });
});

describe('orphan cleanup — role-based status restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCachedIssues = null;
    mockListAgents.mockReturnValue([]);
    mockListRunningProcesses.mockReturnValue([]);
    mockGetActiveAgents.mockResolvedValue([]);
    mockIsBootInProgress.mockReturnValue(false);
    resetMismatchCount();
  });

  it('restores implement agent orphan to for-rework', async () => {
    mockCachedIssues = [
      { number: 100, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:implement'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(100, 'active', 'for-rework');
  });

  it('restores review agent orphan to for-review', async () => {
    mockCachedIssues = [
      { number: 101, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:review'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(101, 'active', 'for-review');
  });

  it('restores validate agent orphan to for-validate', async () => {
    mockCachedIssues = [
      { number: 102, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:validate'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(102, 'active', 'for-validate');
  });

  it('restores define agent orphan to for-define', async () => {
    mockCachedIssues = [
      { number: 103, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:define'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(103, 'active', 'for-define');
  });

  it('falls back to for-human for unknown role', async () => {
    mockCachedIssues = [
      { number: 104, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:unknown-role'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(104, 'active', 'for-human');
  });

  it('logs restoration decision with role and status', async () => {
    mockCachedIssues = [
      { number: 105, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:review'] },
    ];

    await check();

    expect(logEvent).toHaveBeenCalledWith(
      'watchdog.orphan',
      expect.stringContaining('for-review'),
      expect.objectContaining({
        issue: 105,
        role: 'review',
        restoreStatus: 'for-review',
      }),
    );
  });

  it('does not clean up when boot is in progress', async () => {
    mockIsBootInProgress.mockReturnValue(true);
    mockCachedIssues = [
      { number: 106, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:implement'] },
    ];

    await check();

    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('does not clean up issues that have a local agent', async () => {
    mockListAgents.mockReturnValue([{ name: 'agent-1', issue: 100 }]);
    mockListRunningProcesses.mockReturnValue(['agent-1']);
    mockCachedIssues = [
      { number: 100, title: 'Test', labels: ['fritz.status:active', 'fritz.skill:implement'] },
    ];

    await check();

    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('handles multiple orphans with different roles', async () => {
    mockCachedIssues = [
      { number: 200, title: 'A', labels: ['fritz.status:active', 'fritz.skill:implement'] },
      { number: 201, title: 'B', labels: ['fritz.status:active', 'fritz.skill:review'] },
      { number: 202, title: 'C', labels: ['fritz.status:active', 'fritz.skill:validate'] },
    ];

    await check();

    expect(mockTransitionStatus).toHaveBeenCalledWith(200, 'active', 'for-rework');
    expect(mockTransitionStatus).toHaveBeenCalledWith(201, 'active', 'for-review');
    expect(mockTransitionStatus).toHaveBeenCalledWith(202, 'active', 'for-validate');
  });
});
