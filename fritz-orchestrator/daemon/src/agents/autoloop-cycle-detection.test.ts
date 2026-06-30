/**
 * Vitest tests for dependency cycle detection (issue #631).
 *
 * Tests findDependencyCycles() which builds a dependency graph from
 * open issues and detects circular dependency chains.
 * Also tests detectAndReportCycles() cooldown and GitHub posting logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    githubRepo: 'owner/repo',
    githubToken: 'gh-token',
    workspacesDir: '/tmp/test-workspaces',
    fritzRoot: '/fritz-root',
  },
}));

vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
  listAgents: vi.fn(() => []),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
  notifyBootFailure: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock(import('../github/github.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    postComment: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../github/github-graphql.js', () => ({
  fetchAllOpenIssues: vi.fn().mockResolvedValue([]),
}));

vi.mock('../github/github-cache.js', () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
}));

vi.mock('./agents.js', () => ({
  bootAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./usage-monitor.js', () => ({
  isOverBudget: vi.fn().mockReturnValue(false),
  getUsageSummary: vi.fn().mockReturnValue({}),
}));

vi.mock('./repo-gate.js', () => ({
  getTargetRepo: vi.fn().mockReturnValue('owner/repo'),
}));

vi.mock('./priority-utils.js', () => ({
  computeIssuePriority: vi.fn().mockReturnValue(0),
  sortByPriority: vi.fn((issues: unknown[]) => issues),
}));

vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getAutoloopConfig: vi.fn(() => ({ intervalSec: 30, cleanupEveryNthCycle: 10 })),
  getUsageConfig: vi.fn(() => ({ allowP0: false })),
  getCommentLevel: vi.fn(() => 'verbose'),
}));

import { findDependencyCycles, detectAndReportCycles, reportedCycles, CYCLE_REPORT_COOLDOWN_MS } from './autoloop.js';
import * as github from '../github/github.js';
import type { CachedIssue } from '../github/github-graphql.js';

function makeIssue(number: number, labels: string[]): CachedIssue {
  return {
    number,
    title: `Issue #${number}`,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    labels,
  };
}

describe('findDependencyCycles', () => {
  it('returns empty array when no dependencies exist', () => {
    const issues = [
      makeIssue(1, ['fritz.status:for-implement']),
      makeIssue(2, ['fritz.status:for-implement']),
    ];
    expect(findDependencyCycles(issues)).toEqual([]);
  });

  it('returns empty array for linear dependency chain', () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:3']),
      makeIssue(3, []),
    ];
    expect(findDependencyCycles(issues)).toEqual([]);
  });

  it('detects a simple 2-node cycle', () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain(1);
    expect(cycles[0]).toContain(2);
  });

  it('detects the exact cycle from issue #631 (5-node chain)', () => {
    // #612 → #622 → #610 → #615 → #614 → #612
    const issues = [
      makeIssue(612, ['fritz.depends-on:622']),
      makeIssue(622, ['fritz.depends-on:610']),
      makeIssue(610, ['fritz.depends-on:615']),
      makeIssue(615, ['fritz.depends-on:614']),
      makeIssue(614, ['fritz.depends-on:612']),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(5);
    // All 5 issues should be in the cycle
    for (const num of [610, 612, 614, 615, 622]) {
      expect(cycles[0]).toContain(num);
    }
  });

  it('ignores dependencies on closed issues (not in open set)', () => {
    // Issue 1 depends on issue 99 which is closed (not in the list)
    const issues = [
      makeIssue(1, ['fritz.depends-on:99']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];
    expect(findDependencyCycles(issues)).toEqual([]);
  });

  it('detects multiple independent cycles', () => {
    const issues = [
      // Cycle 1: 1 → 2 → 1
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
      // Cycle 2: 3 → 4 → 3
      makeIssue(3, ['fritz.depends-on:4']),
      makeIssue(4, ['fritz.depends-on:3']),
      // Unrelated issue
      makeIssue(5, []),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(2);
  });

  it('detects self-referencing dependency', () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:1']),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([1]);
  });

  it('handles issues with multiple dependencies', () => {
    // 1 depends on both 2 and 3; 2 depends on 1 (cycle through 1→2→1)
    const issues = [
      makeIssue(1, ['fritz.depends-on:2', 'fritz.depends-on:3']),
      makeIssue(2, ['fritz.depends-on:1']),
      makeIssue(3, []),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain(1);
    expect(cycles[0]).toContain(2);
  });

  it('handles empty issue list', () => {
    expect(findDependencyCycles([])).toEqual([]);
  });

  it('normalizes cycles to start from smallest issue number', () => {
    const issues = [
      makeIssue(5, ['fritz.depends-on:3']),
      makeIssue(3, ['fritz.depends-on:5']),
    ];
    const cycles = findDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    // Should start with the smallest number
    expect(cycles[0][0]).toBe(3);
  });
});

describe('detectAndReportCycles', () => {
  beforeEach(() => {
    reportedCycles.clear();
    vi.mocked(github.postComment).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts a GitHub comment on first cycle detection', async () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];
    await detectAndReportCycles(issues);

    expect(github.postComment).toHaveBeenCalledTimes(1);
    // Comment should be posted on the first issue in the normalized cycle
    expect(github.postComment).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Dependency Cycle Detected'),
    );
  });

  it('does not re-post the same cycle within the 24h cooldown', async () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];

    await detectAndReportCycles(issues);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // Call again — should be suppressed by cooldown
    vi.mocked(github.postComment).mockClear();
    await detectAndReportCycles(issues);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('re-posts the cycle after the cooldown expires', async () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];

    await detectAndReportCycles(issues);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // Simulate cooldown expiry by backdating the reportedCycles entry
    const sig = '1,2'; // sorted cycle signature
    reportedCycles.set(sig, Date.now() - CYCLE_REPORT_COOLDOWN_MS - 1);

    vi.mocked(github.postComment).mockClear();
    await detectAndReportCycles(issues);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it('does not post when there are no cycles', async () => {
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, []),
    ];
    await detectAndReportCycles(issues);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('handles GitHub API errors gracefully without throwing', async () => {
    vi.mocked(github.postComment).mockRejectedValueOnce(new Error('API rate limit'));
    const issues = [
      makeIssue(1, ['fritz.depends-on:2']),
      makeIssue(2, ['fritz.depends-on:1']),
    ];
    // Should not throw
    await expect(detectAndReportCycles(issues)).resolves.toBeUndefined();
  });
});
