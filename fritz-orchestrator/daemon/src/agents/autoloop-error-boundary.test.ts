/**
 * Vitest tests for processIssue error boundary in autoloop check() (issue #672).
 *
 * Verifies that when processIssue throws, the autoloop continues processing
 * subsequent issues instead of crashing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing autoloop
vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-error-boundary',
    githubRepo: 'test/repo',
    fritzRoot: '/tmp/fritz-root',
    telegramBotToken: 'test-token',
    telegramChatId: 'test-chat-id',
    dockerImage: 'fritz-agent:latest',
    apiPort: 3456,
    daemonUrl: 'http://localhost:3456',
  },
}));

// Mock github module — spawnIfNoAgent calls agents.bootAgent via this
const mockGh = vi.fn(() => '');
const mockGetIssueLabels = vi.fn(() => []);
const mockGetDependencies = vi.fn(() => []);
const mockParseDependenciesFromLabels = vi.fn(() => []);
vi.mock('../github/github.js', () => ({
  gh: (...args: unknown[]) => mockGh(...args),
  getIssueLabels: (...args: unknown[]) => mockGetIssueLabels(...args),
  getDependencies: (...args: unknown[]) => mockGetDependencies(...args),
  parseDependenciesFromLabels: (...args: unknown[]) => mockParseDependenciesFromLabels(...args),
  getActionableIssues: vi.fn(() => []),
  claimIssue: vi.fn(),
  releaseIssue: vi.fn(),
  transitionIssueStatus: vi.fn(),
  transitionStatus: vi.fn(),
  hasAutoPipeline: vi.fn(() => false),
  isDependencyClosed: vi.fn(() => true),
  findIssuePR: vi.fn(),
  assignAgent: vi.fn(),
  releaseAgent: vi.fn(),
  // logActivity removed in #685
  postMergeComment: vi.fn(),
  MAX_REWORK_CYCLES: 3,
  RATE_LIMIT_RETRY_DELAYS_MS: [10_000, 30_000, 60_000],
  isSecondaryRateLimit: vi.fn(() => false),
  _setRetrySleep: vi.fn(),
}));

// Mock agents
const mockStartAgent = vi.fn(() => Promise.resolve('agent-name'));
vi.mock('./agents.js', () => ({
  startAgent: (...args: unknown[]) => mockStartAgent(...args),
  stopAgent: vi.fn(),
}));

vi.mock('../core/registry.js', () => ({
  listAgents: vi.fn(() => []),
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
  notifyBootFailure: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('./boot.js', () => ({
  execAsync: vi.fn(() => Promise.resolve('')),
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
  getUsageConfig: vi.fn(() => ({ enabled: false, pauseThreshold: 80, resumeThreshold: 50, checkIntervalMinutes: 5, allowP0: true })),
  getAutoloopConfig: vi.fn(() => ({ intervalSec: 60, cleanupEveryNthCycle: 10 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
}));

vi.mock('./usage-monitor.js', () => ({
  isUsagePaused: vi.fn(() => false),
  hasOverride: vi.fn(() => false),
}));

vi.mock('./priority-utils.js', () => ({
  extractPriority: vi.fn(() => null),
  sortByPriority: vi.fn((arr: unknown[]) => arr),
}));

// Mock graphql — returns two issues so we can verify the second is processed after the first throws
const mockFetchAllOpenIssues = vi.fn();
const mockFilterByStatus = vi.fn(() => []);
vi.mock('../github/github-graphql.js', () => ({
  fetchAllOpenIssues: (...args: unknown[]) => mockFetchAllOpenIssues(...args),
  filterByStatus: (...args: unknown[]) => mockFilterByStatus(...args),
  getCachedIssues: vi.fn(() => []),
}));

vi.mock('../github/github-cache.js', () => ({
  isRateLimited: vi.fn(() => false),
}));

// ── Tests ──

describe('processIssue error boundary', () => {
  let autoloop: typeof import('./autoloop.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    autoloop = await import('./autoloop.js');

    // Return two 'defined' issues — processIssue calls getIssueLabels() for these,
    // which can throw and trigger the error boundary
    mockFetchAllOpenIssues.mockResolvedValue([
      { number: 100, labels: ['fritz.status:defined', 'fritz.auto-pipeline'], title: 'Issue 100' },
      { number: 200, labels: ['fritz.status:defined', 'fritz.auto-pipeline'], title: 'Issue 200' },
    ]);

    // filterByStatus returns both issues only for 'defined', empty for others
    mockFilterByStatus.mockImplementation((_issues: unknown, status: string) => {
      if (status === 'defined') {
        return [
          { number: 100, labels: ['fritz.status:defined', 'fritz.auto-pipeline'], title: 'Issue 100', priority: null },
          { number: 200, labels: ['fritz.status:defined', 'fritz.auto-pipeline'], title: 'Issue 200', priority: null },
        ];
      }
      return [];
    });
  });

  it('continues processing after processIssue throws on one issue', async () => {
    // getIssueLabels throws for issue 100 (simulates rate limit), succeeds for 200
    mockGetIssueLabels.mockImplementation((issue: number) => {
      if (issue === 100) throw new Error('secondary rate limit exceeded');
      return ['fritz.status:defined', 'fritz.auto-pipeline'];
    });

    // Run one check cycle — should NOT throw
    await autoloop._check();

    // getIssueLabels should have been called for both issues (error boundary caught the first)
    expect(mockGetIssueLabels).toHaveBeenCalledTimes(2);
    expect(mockGetIssueLabels).toHaveBeenCalledWith(100);
    expect(mockGetIssueLabels).toHaveBeenCalledWith(200);
  });

  it('does not crash when all processIssue calls throw', async () => {
    mockGetIssueLabels.mockImplementation(() => {
      throw new Error('rate limited');
    });

    // Should complete without throwing
    await expect(autoloop._check()).resolves.toBeUndefined();
  });
});
