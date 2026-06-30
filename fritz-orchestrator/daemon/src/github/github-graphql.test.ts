/**
 * Vitest unit tests for the GraphQL consolidation module (github-graphql.ts).
 *
 * Covers:
 * - filterByStatus — client-side filtering by fritz.status label
 * - getActiveFromCache — convenience helper for active issues
 * - getCachedIssues / invalidateIssuesCache — cache accessors
 * - fetchAllOpenIssues — GraphQL fetch with caching, TTL, error handling
 * - refreshIssuesCache — forced re-fetch bypassing TTL
 * - Pagination — cursor-based multi-page fetching
 * - In-flight deduplication — thundering herd prevention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock execAsync from boot.js
// ---------------------------------------------------------------------------

const mockExecAsync = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock('../agents/boot.js', () => ({
  execAsync: (...args: unknown[]) => mockExecAsync(...args),
}));

// Mock priority-utils — use the real implementation for accurate priority extraction
vi.mock('../agents/priority-utils.js', async () => {
  return {
    extractPriority: (labels: Array<{ name: string }>) => {
      const prefix = 'priority:';
      const match = labels.find(l => l.name.startsWith(prefix));
      if (!match) return null;
      const level = match.name.slice(prefix.length);
      const valid = ['p0', 'p1', 'p2', 'p3'];
      return valid.includes(level) ? level : null;
    },
  };
});

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import {
  filterByStatus,
  getActiveFromCache,
  getCachedIssues,
  fetchAllOpenIssues,
  refreshIssuesCache,
  invalidateIssuesCache,
  setCacheTtl,
  type CachedIssue,
} from './github-graphql.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCachedIssue(overrides: Partial<CachedIssue> & { number: number }): CachedIssue {
  return {
    title: `Issue #${overrides.number}`,
    updatedAt: '2026-03-20T10:00:00Z',
    createdAt: '2026-03-01T10:00:00Z',
    labels: [],
    ...overrides,
  };
}

/** Build a valid GraphQL response shape for a single page of issues. */
function makeGraphQLResponse(
  nodes: Array<{
    number: number;
    title: string;
    updatedAt?: string;
    createdAt?: string;
    labels: string[];
  }>,
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          pageInfo: {
            hasNextPage,
            endCursor,
          },
          nodes: nodes.map(n => ({
            number: n.number,
            title: n.title,
            updatedAt: n.updatedAt ?? '2026-03-20T10:00:00Z',
            createdAt: n.createdAt ?? '2026-03-01T10:00:00Z',
            labels: {
              nodes: n.labels.map(name => ({ name })),
            },
          })),
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecAsync.mockReset();
  invalidateIssuesCache();
  setCacheTtl(60_000); // restore default
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// filterByStatus() tests
// ============================================================================

describe('filterByStatus', () => {
  it('filters issues by fritz.status:X label', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:for-define', 'type:feature'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:for-implement', 'priority:p1'] }),
      makeCachedIssue({ number: 3, labels: ['fritz.status:for-define', 'priority:p0'] }),
    ];

    const result = filterByStatus(issues, 'for-define');

    expect(result).toHaveLength(2);
    expect(result.map(r => r.number)).toEqual([1, 3]);
  });

  it('returns empty array when no issues match', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:for-define'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:active'] }),
    ];

    const result = filterByStatus(issues, 'validated');

    expect(result).toEqual([]);
  });

  it('supports extraLabels filter (e.g., fritz.auto-pipeline)', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:validated', 'fritz.auto-pipeline'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:validated'] }), // missing extra label
      makeCachedIssue({ number: 3, labels: ['fritz.status:validated', 'fritz.auto-pipeline', 'priority:p1'] }),
    ];

    const result = filterByStatus(issues, 'validated', ['fritz.auto-pipeline']);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.number)).toEqual([1, 3]);
  });

  it('requires ALL extra labels to be present', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:defined', 'fritz.auto-pipeline', 'fritz.express'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:defined', 'fritz.auto-pipeline'] }), // missing fritz.express
      makeCachedIssue({ number: 3, labels: ['fritz.status:defined', 'fritz.express'] }), // missing fritz.auto-pipeline
    ];

    const result = filterByStatus(issues, 'defined', ['fritz.auto-pipeline', 'fritz.express']);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('returns PrioritizedIssue with correct priority extracted from labels', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 10, labels: ['fritz.status:for-implement', 'priority:p0', 'type:bug'] }),
      makeCachedIssue({ number: 11, labels: ['fritz.status:for-implement', 'priority:p2'] }),
      makeCachedIssue({ number: 12, labels: ['fritz.status:for-implement'] }), // no priority
    ];

    const result = filterByStatus(issues, 'for-implement');

    expect(result).toHaveLength(3);

    expect(result[0].number).toBe(10);
    expect(result[0].priority).toBe('p0');
    expect(result[0].labels).toContain('priority:p0');

    expect(result[1].number).toBe(11);
    expect(result[1].priority).toBe('p2');

    expect(result[2].number).toBe(12);
    expect(result[2].priority).toBeNull();
  });

  it('handles issues with no fritz.status label (excludes them)', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['type:feature', 'priority:p1'] }),
      makeCachedIssue({ number: 2, labels: [] }),
      makeCachedIssue({ number: 3, labels: ['fritz.status:active'] }),
    ];

    const result = filterByStatus(issues, 'active');

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(3);
  });

  it('multiple issues matching same status', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 100, labels: ['fritz.status:for-review'] }),
      makeCachedIssue({ number: 101, labels: ['fritz.status:for-review'] }),
      makeCachedIssue({ number: 102, labels: ['fritz.status:for-review'] }),
      makeCachedIssue({ number: 103, labels: ['fritz.status:for-review'] }),
    ];

    const result = filterByStatus(issues, 'for-review');

    expect(result).toHaveLength(4);
    expect(result.map(r => r.number)).toEqual([100, 101, 102, 103]);
  });

  it('preserves title in returned PrioritizedIssue', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 42, title: 'Fix the widget', labels: ['fritz.status:active'] }),
    ];

    const result = filterByStatus(issues, 'active');

    expect(result[0].title).toBe('Fix the widget');
  });

  it('returns empty array for empty input', () => {
    const result = filterByStatus([], 'for-define');
    expect(result).toEqual([]);
  });
});

// ============================================================================
// getActiveFromCache() tests
// ============================================================================

describe('getActiveFromCache', () => {
  it('returns issues with fritz.status:active label', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:active', 'priority:p0'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:for-define'] }),
      makeCachedIssue({ number: 3, labels: ['fritz.status:active'] }),
    ];

    const result = getActiveFromCache(issues);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.number)).toEqual([1, 3]);
  });

  it('returns empty array when no active issues', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({ number: 1, labels: ['fritz.status:for-define'] }),
      makeCachedIssue({ number: 2, labels: ['fritz.status:validated'] }),
    ];

    const result = getActiveFromCache(issues);

    expect(result).toEqual([]);
  });

  it('works with empty input array', () => {
    const result = getActiveFromCache([]);
    expect(result).toEqual([]);
  });

  it('returns CachedIssue objects (not PrioritizedIssue)', () => {
    const issues: CachedIssue[] = [
      makeCachedIssue({
        number: 5,
        labels: ['fritz.status:active'],
        updatedAt: '2026-03-22T12:00:00Z',
        createdAt: '2026-03-10T08:00:00Z',
      }),
    ];

    const result = getActiveFromCache(issues);

    expect(result[0]).toHaveProperty('updatedAt', '2026-03-22T12:00:00Z');
    expect(result[0]).toHaveProperty('createdAt', '2026-03-10T08:00:00Z');
  });
});

// ============================================================================
// getCachedIssues() tests
// ============================================================================

describe('getCachedIssues', () => {
  it('returns null when cache is not populated', () => {
    expect(getCachedIssues()).toBeNull();
  });

  it('returns cached data after fetchAllOpenIssues', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Issue 1', labels: ['fritz.status:active'] },
        { number: 2, title: 'Issue 2', labels: ['fritz.status:for-define'] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    const cached = getCachedIssues();

    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached![0].number).toBe(1);
    expect(cached![1].number).toBe(2);
  });

  it('returns null after invalidateIssuesCache', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Issue 1', labels: [] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    expect(getCachedIssues()).not.toBeNull();

    invalidateIssuesCache();
    expect(getCachedIssues()).toBeNull();
  });
});

// ============================================================================
// fetchAllOpenIssues() tests
// ============================================================================

describe('fetchAllOpenIssues', () => {
  it('parses GraphQL response correctly', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        {
          number: 42,
          title: 'Add caching layer',
          updatedAt: '2026-03-20T15:30:00Z',
          createdAt: '2026-03-01T09:00:00Z',
          labels: ['fritz.status:for-implement', 'priority:p1', 'type:feature'],
        },
      ]),
    );

    const result = await fetchAllOpenIssues('your-org', 'fritZ');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      number: 42,
      title: 'Add caching layer',
      updatedAt: '2026-03-20T15:30:00Z',
      createdAt: '2026-03-01T09:00:00Z',
      labels: ['fritz.status:for-implement', 'priority:p1', 'type:feature'],
    });
  });

  it('calls gh api graphql with correct arguments', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([]),
    );

    await fetchAllOpenIssues('your-org', 'fritZ');

    expect(mockExecAsync).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecAsync.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toContain('api');
    expect(args).toContain('graphql');
    expect(args).toContain('owner=your-org');
    expect(args).toContain('name=fritZ');
    expect(opts).toEqual({ timeout: 15000 });
  });

  it('populates cache after successful fetch', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Test', labels: ['fritz.status:active'] },
      ]),
    );

    expect(getCachedIssues()).toBeNull();

    await fetchAllOpenIssues('owner', 'repo');

    expect(getCachedIssues()).not.toBeNull();
    expect(getCachedIssues()).toHaveLength(1);
  });

  it('returns cached data within TTL (no API call)', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Cached', labels: [] },
      ]),
    );

    // First call populates the cache
    const first = await fetchAllOpenIssues('owner', 'repo');
    expect(first).toHaveLength(1);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    // Second call should return cached data, no new API call
    const second = await fetchAllOpenIssues('owner', 'repo');
    expect(second).toHaveLength(1);
    expect(second[0].number).toBe(1);
    expect(mockExecAsync).toHaveBeenCalledTimes(1); // still 1
  });

  it('re-fetches after TTL expires', async () => {
    // Use a very short TTL
    setCacheTtl(1);

    mockExecAsync
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          { number: 1, title: 'First fetch', labels: [] },
        ]),
      )
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          { number: 1, title: 'First fetch', labels: [] },
          { number: 2, title: 'Second fetch', labels: [] },
        ]),
      );

    const first = await fetchAllOpenIssues('owner', 'repo');
    expect(first).toHaveLength(1);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire (1ms + small buffer)
    await new Promise(resolve => setTimeout(resolve, 10));

    const second = await fetchAllOpenIssues('owner', 'repo');
    expect(second).toHaveLength(2);
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
  });

  it('returns stale cache on error (if cache exists)', async () => {
    // First call: populate cache
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Stale data', labels: ['fritz.status:active'] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    // Expire TTL
    setCacheTtl(0);

    // Second call: API fails
    mockExecAsync.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await fetchAllOpenIssues('owner', 'repo');

    // Should return stale cached data
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].title).toBe('Stale data');
  });

  it('returns empty array on error (if no cache)', async () => {
    mockExecAsync.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toEqual([]);
  });

  it('handles GraphQL-level errors', async () => {
    mockExecAsync.mockResolvedValueOnce(
      JSON.stringify({
        errors: [
          { message: 'Could not resolve to a Repository' },
        ],
      }),
    );

    const result = await fetchAllOpenIssues('invalid', 'repo');

    expect(result).toEqual([]);
  });

  it('handles unexpected response shape (missing repository.issues)', async () => {
    mockExecAsync.mockResolvedValueOnce(
      JSON.stringify({ data: { repository: null } }),
    );

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toEqual([]);
  });

  it('in-flight dedup: two concurrent calls result in one API call', async () => {
    // Use a slow-resolving mock to ensure both calls happen concurrently
    let resolvePromise: (value: string) => void;
    const slowPromise = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });

    mockExecAsync.mockReturnValueOnce(slowPromise);

    // Start two concurrent fetches
    const promise1 = fetchAllOpenIssues('owner', 'repo');
    const promise2 = fetchAllOpenIssues('owner', 'repo');

    // Resolve the single API call
    resolvePromise!(
      makeGraphQLResponse([
        { number: 1, title: 'Deduped', labels: [] },
      ]),
    );

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // Both should get the same result
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0].number).toBe(1);
    expect(result2[0].number).toBe(1);

    // Only one API call should have been made
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// refreshIssuesCache() tests
// ============================================================================

describe('refreshIssuesCache', () => {
  it('forces re-fetch regardless of TTL', async () => {
    // First call: populate cache
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Old', labels: [] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    // Cache is still fresh (within default 60s TTL)
    // refreshIssuesCache should fetch anyway
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Old', labels: [] },
        { number: 2, title: 'New', labels: [] },
      ]),
    );

    const result = await refreshIssuesCache('owner', 'repo');

    expect(result).toHaveLength(2);
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
  });

  it('deduplicates with in-flight fetch', async () => {
    let resolvePromise: (value: string) => void;
    const slowPromise = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });

    mockExecAsync.mockReturnValueOnce(slowPromise);

    // Start a fetchAllOpenIssues that is still in-flight
    const fetchPromise = fetchAllOpenIssues('owner', 'repo');

    // refreshIssuesCache should piggyback on the in-flight fetch
    const refreshPromise = refreshIssuesCache('owner', 'repo');

    // Resolve
    resolvePromise!(
      makeGraphQLResponse([
        { number: 1, title: 'Shared', labels: [] },
      ]),
    );

    const [fetchResult, refreshResult] = await Promise.all([fetchPromise, refreshPromise]);

    expect(fetchResult).toHaveLength(1);
    expect(refreshResult).toHaveLength(1);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it('updates cache so subsequent getCachedIssues returns fresh data', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 99, title: 'Refreshed', labels: ['fritz.status:validated'] },
      ]),
    );

    await refreshIssuesCache('owner', 'repo');

    const cached = getCachedIssues();
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0].number).toBe(99);
  });
});

// ============================================================================
// invalidateIssuesCache() tests
// ============================================================================

describe('invalidateIssuesCache', () => {
  it('clears cached data', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Cached', labels: [] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    expect(getCachedIssues()).not.toBeNull();

    invalidateIssuesCache();
    expect(getCachedIssues()).toBeNull();
  });

  it('getCachedIssues returns null after invalidation', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 1, title: 'Will be cleared', labels: [] },
      ]),
    );

    await fetchAllOpenIssues('owner', 'repo');
    invalidateIssuesCache();

    expect(getCachedIssues()).toBeNull();
  });

  it('causes next fetchAllOpenIssues to make a new API call', async () => {
    mockExecAsync
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          { number: 1, title: 'First', labels: [] },
        ]),
      )
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          { number: 2, title: 'After invalidation', labels: [] },
        ]),
      );

    await fetchAllOpenIssues('owner', 'repo');
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    invalidateIssuesCache();

    const result = await fetchAllOpenIssues('owner', 'repo');
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });
});

// ============================================================================
// Pagination tests
// ============================================================================

describe('Pagination', () => {
  it('handles single page (hasNextPage: false)', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [
          { number: 1, title: 'Only page', labels: ['fritz.status:active'] },
          { number: 2, title: 'Also only page', labels: [] },
        ],
        false, // hasNextPage
        null,  // endCursor
      ),
    );

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toHaveLength(2);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it('handles multiple pages (accumulates results)', async () => {
    // Page 1 — has next page
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [
          { number: 1, title: 'Page 1 Issue 1', labels: ['fritz.status:active'] },
          { number: 2, title: 'Page 1 Issue 2', labels: [] },
        ],
        true,       // hasNextPage
        'cursor-1', // endCursor
      ),
    );

    // Page 2 — has next page
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [
          { number: 3, title: 'Page 2 Issue 1', labels: ['priority:p0'] },
        ],
        true,       // hasNextPage
        'cursor-2', // endCursor
      ),
    );

    // Page 3 — last page
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [
          { number: 4, title: 'Page 3 Issue 1', labels: ['fritz.status:for-define'] },
        ],
        false, // hasNextPage
        null,  // endCursor
      ),
    );

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toHaveLength(4);
    expect(result.map(r => r.number)).toEqual([1, 2, 3, 4]);
    expect(mockExecAsync).toHaveBeenCalledTimes(3);
  });

  it('passes cursor to subsequent page requests', async () => {
    // Page 1
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [{ number: 1, title: 'P1', labels: [] }],
        true,
        'abc123',
      ),
    );

    // Page 2
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse(
        [{ number: 2, title: 'P2', labels: [] }],
        false,
        null,
      ),
    );

    await fetchAllOpenIssues('owner', 'repo');

    // First call should NOT have a cursor arg
    const firstCallArgs = mockExecAsync.mock.calls[0][1] as string[];
    expect(firstCallArgs).not.toContain('cursor=abc123');

    // Second call should have the cursor from page 1
    const secondCallArgs = mockExecAsync.mock.calls[1][1] as string[];
    expect(secondCallArgs).toContain('cursor=abc123');
  });

  it('handles zero issues', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([], false, null),
    );

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toEqual([]);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it('handles page with empty nodes array', async () => {
    mockExecAsync.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      }),
    );

    const result = await fetchAllOpenIssues('owner', 'repo');

    expect(result).toEqual([]);
  });
});

// ============================================================================
// Integration: fetch + filter flow
// ============================================================================

describe('Integration: fetch then filter', () => {
  it('fetchAllOpenIssues + filterByStatus works end-to-end', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 10, title: 'Define me', labels: ['fritz.status:for-define', 'priority:p1'] },
        { number: 11, title: 'Implement me', labels: ['fritz.status:for-implement', 'priority:p0'] },
        { number: 12, title: 'Also define', labels: ['fritz.status:for-define'] },
        { number: 13, title: 'Active work', labels: ['fritz.status:active'] },
      ]),
    );

    const allIssues = await fetchAllOpenIssues('owner', 'repo');

    const forDefine = filterByStatus(allIssues, 'for-define');
    expect(forDefine).toHaveLength(2);
    expect(forDefine[0].number).toBe(10);
    expect(forDefine[0].priority).toBe('p1');
    expect(forDefine[1].number).toBe(12);
    expect(forDefine[1].priority).toBeNull();

    const forImplement = filterByStatus(allIssues, 'for-implement');
    expect(forImplement).toHaveLength(1);
    expect(forImplement[0].number).toBe(11);
    expect(forImplement[0].priority).toBe('p0');

    const active = getActiveFromCache(allIssues);
    expect(active).toHaveLength(1);
    expect(active[0].number).toBe(13);
  });

  it('fetchAllOpenIssues + filterByStatus with extraLabels works end-to-end', async () => {
    mockExecAsync.mockResolvedValueOnce(
      makeGraphQLResponse([
        { number: 20, title: 'Auto pipeline', labels: ['fritz.status:defined', 'fritz.auto-pipeline'] },
        { number: 21, title: 'No pipeline', labels: ['fritz.status:defined'] },
        { number: 22, title: 'Different status', labels: ['fritz.status:active', 'fritz.auto-pipeline'] },
      ]),
    );

    const allIssues = await fetchAllOpenIssues('owner', 'repo');

    const autoDefined = filterByStatus(allIssues, 'defined', ['fritz.auto-pipeline']);
    expect(autoDefined).toHaveLength(1);
    expect(autoDefined[0].number).toBe(20);
  });
});
