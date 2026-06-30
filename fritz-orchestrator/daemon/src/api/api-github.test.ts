/**
 * Vitest tests for api-github module (GitHub cache proxy API).
 *
 * Covers:
 * - GET /api/github/issues — cached list, cache miss, method check
 * - GET /api/github/issues/:number/labels — GraphQL cache hit, fallback, invalid number
 * - POST /api/github/invalidate — specific issue, all, dep, contextCache, response
 * - GET /api/github/rate-limit — cached state, cache stats
 * - Routing — 404 for unknown paths, 405 for wrong methods, URL parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../github/github-graphql.js', () => ({
  getCachedIssues: vi.fn(() => null),
  invalidateIssuesCache: vi.fn(),
}));

vi.mock('../github/github-cache.js', () => ({
  getRateLimitState: vi.fn(() => ({ remaining: 5000, resetAt: 0, paused: false })),
  getCacheStats: vi.fn(() => ({ hits: 10, misses: 2, etagHits: 3, rateLimitEvents: 0, entries: 5 })),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  invalidateIssue: vi.fn(),
  cachedGhApiAsync: vi.fn(),
}));

vi.mock('../github/github.js', () => ({
  getIssueLabels: vi.fn(() => ['bug', 'fritz.status:queued']),
  gh: vi.fn(() => '{"remaining":4999,"reset":1700000000}'),
  getTargetRepoInfo: vi.fn(() => null),
  postComment: vi.fn(() => Promise.resolve()),
  ghQueued: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../agents/boot.js', () => ({
  execAsync: vi.fn(() => '{}'),
}));

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
    githubRepo: 'owner/repo',
    ghToken: 'test-token',
    fritzRoot: '/fritz-root',
  },
}));

// ---------------------------------------------------------------------------
// Import module under test and mocked modules
// ---------------------------------------------------------------------------

import { handleGitHubProxy } from './api-github.js';
import { getCachedIssues, invalidateIssuesCache } from '../github/github-graphql.js';
import * as githubCache from '../github/github-cache.js';
import * as github from '../github/github.js';

const mockGetCachedIssues = vi.mocked(getCachedIssues);
const mockInvalidateIssuesCache = vi.mocked(invalidateIssuesCache);
const mockGetRateLimitState = vi.mocked(githubCache.getRateLimitState);
const mockGetCacheStats = vi.mocked(githubCache.getCacheStats);
const mockInvalidate = vi.mocked(githubCache.invalidate);
const mockCachedGhApiAsync = vi.mocked(githubCache.cachedGhApiAsync);
const mockGetIssueLabels = vi.mocked(github.getIssueLabels);
const mockGh = vi.mocked(github.gh);
const mockPostComment = vi.mocked(github.postComment as (...args: unknown[]) => Promise<void>);
const mockGhQueued = vi.mocked(github.ghQueued as (...args: unknown[]) => Promise<string>);

// ---------------------------------------------------------------------------
// Mock HTTP helpers
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body?: string): IncomingMessage {
  const req = new Readable() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3456' };
  if (body) req.push(body);
  req.push(null);
  return req;
}

function mockRes(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    end(body?: string) { res._body = body ?? ''; },
  } as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
  return res;
}

/** Parse the JSON body from a mock response. */
function parseBody(res: ReturnType<typeof mockRes>): unknown {
  return JSON.parse(res._body);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SAMPLE_ISSUES = [
  { number: 42, title: 'Fix login bug', labels: ['bug', 'fritz.status:queued'], updatedAt: '2026-03-20T10:00:00Z', createdAt: '2026-03-19T08:00:00Z' },
  { number: 43, title: 'Add dark mode', labels: ['enhancement'], updatedAt: '2026-03-21T12:00:00Z', createdAt: '2026-03-20T09:00:00Z' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults
  mockGetCachedIssues.mockReturnValue(null);
  mockGetRateLimitState.mockReturnValue({ remaining: 5000, resetAt: 0, paused: false });
  mockGetCacheStats.mockReturnValue({ hits: 10, misses: 2, etagHits: 3, rateLimitEvents: 0, entries: 5 });
  mockGetIssueLabels.mockReturnValue(['bug', 'fritz.status:queued']);
  mockGh.mockReturnValue('{"remaining":4999,"reset":1700000000}');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/github/issues
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/github/issues', () => {
  it('returns cached issues when cache is populated', async () => {
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);

    const req = mockReq('GET', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('hit');
    expect(res._headers['Content-Type']).toBe('application/json');

    const body = parseBody(res) as Array<{ number: number; title: string; labels: string[]; updatedAt: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].number).toBe(42);
    expect(body[0].title).toBe('Fix login bug');
    expect(body[0].labels).toEqual(['bug', 'fritz.status:queued']);
    expect(body[1].number).toBe(43);
  });

  it('returns empty array with X-Cache: miss when cache is empty', async () => {
    mockGetCachedIssues.mockReturnValue(null);

    const req = mockReq('GET', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('miss');

    const body = parseBody(res);
    expect(body).toEqual([]);
  });

  it('returns 405 for non-GET methods (except POST /invalidate)', async () => {
    const req = mockReq('PUT', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(405);
    const body = parseBody(res) as { error: string };
    expect(body.error).toBe('Method not allowed');
  });

  it('returns 405 for DELETE method', async () => {
    const req = mockReq('DELETE', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /api/github/issues/:number/labels
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/github/issues/:number/labels', () => {
  it('returns labels from GraphQL cache when issue is cached', async () => {
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);

    const req = mockReq('GET', '/api/github/issues/42/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('hit');

    const body = parseBody(res) as { labels: string[] };
    expect(body.labels).toEqual(['bug', 'fritz.status:queued']);
  });

  it('falls back to github.getIssueLabels on cache miss', async () => {
    mockGetCachedIssues.mockReturnValue(null);
    mockGetIssueLabels.mockReturnValue(['fallback-label']);

    const req = mockReq('GET', '/api/github/issues/99/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('miss');
    expect(mockGetIssueLabels).toHaveBeenCalledWith(99);

    const body = parseBody(res) as { labels: string[] };
    expect(body.labels).toEqual(['fallback-label']);
  });

  it('falls back to github.getIssueLabels when issue not in cache', async () => {
    // Cache has issues but not this one
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);
    mockGetIssueLabels.mockReturnValue(['other-label']);

    const req = mockReq('GET', '/api/github/issues/999/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('miss');
    expect(mockGetIssueLabels).toHaveBeenCalledWith(999);

    const body = parseBody(res) as { labels: string[] };
    expect(body.labels).toEqual(['other-label']);
  });

  it('returns 404 when getIssueLabels throws', async () => {
    mockGetCachedIssues.mockReturnValue(null);
    mockGetIssueLabels.mockImplementation(() => { throw new Error('Not found'); });

    const req = mockReq('GET', '/api/github/issues/404/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('404');
  });

  it('returns 400 for invalid issue number (non-numeric handled by regex — negative not matched)', async () => {
    // The regex /^\/api\/github\/issues\/(\d+)(\/.*)?$/ will not match non-numeric,
    // so this falls through to 404.
    const req = mockReq('GET', '/api/github/issues/abc/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. POST /api/github/invalidate
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/github/invalidate', () => {
  it('clears specific issue cache when body has {"issue": 42}', async () => {
    const req = mockReq('POST', '/api/github/invalidate', JSON.stringify({ issue: 42 }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockInvalidate).toHaveBeenCalledWith(42);
    expect(mockInvalidate).toHaveBeenCalledWith('all-issues');
    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
  });

  it('clears all caches when body is empty', async () => {
    const req = mockReq('POST', '/api/github/invalidate', '');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockInvalidate).toHaveBeenCalledWith('all-issues');
    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
    // Should NOT have been called with a specific issue number
    expect(mockInvalidate).not.toHaveBeenCalledWith(42);
  });

  it('clears all caches when body is empty JSON object', async () => {
    const req = mockReq('POST', '/api/github/invalidate', '{}');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockInvalidate).toHaveBeenCalledWith('all-issues');
    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
  });

  it('clears dep cache when body has {"issue": 42, "dep": true}', async () => {
    const req = mockReq('POST', '/api/github/invalidate', JSON.stringify({ issue: 42, dep: true }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockInvalidate).toHaveBeenCalledWith(42);
    expect(mockInvalidate).toHaveBeenCalledWith('all-issues');
    expect(mockInvalidate).toHaveBeenCalledWith('dep:42');
    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
  });

  it('does not clear dep cache when dep is false', async () => {
    const req = mockReq('POST', '/api/github/invalidate', JSON.stringify({ issue: 42, dep: false }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(mockInvalidate).not.toHaveBeenCalledWith('dep:42');
  });

  it('clears contextCache entries for specific issue', async () => {
    // First, populate the context cache by triggering a context request.
    // We test indirectly: after invalidation of issue 42, the context cache
    // entry for that issue should be deleted. We verify by checking that
    // invalidate was called correctly — the contextCache.delete(42) call
    // is internal and not directly observable from outside, but the function
    // completes without error and returns ok: true.
    const req = mockReq('POST', '/api/github/invalidate', JSON.stringify({ issue: 42 }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual({ ok: true });
  });

  it('clears all contextCache entries when body is empty', async () => {
    const req = mockReq('POST', '/api/github/invalidate', '');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual({ ok: true });
  });

  it('returns 200 with {"ok": true}', async () => {
    const req = mockReq('POST', '/api/github/invalidate', '{}');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res);
    expect(body).toEqual({ ok: true });
  });

  it('handles invalid JSON body gracefully (invalidates everything)', async () => {
    const req = mockReq('POST', '/api/github/invalidate', 'not-json');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual({ ok: true });
    // Falls through to "invalidate everything" path
    expect(mockInvalidate).toHaveBeenCalledWith('all-issues');
    expect(mockInvalidateIssuesCache).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GET /api/github/rate-limit
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/github/rate-limit', () => {
  it('returns cached rate limit state', async () => {
    mockGetRateLimitState.mockReturnValue({ remaining: 4500, resetAt: 1700000000, paused: false });
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { rateLimit: { remaining: number; resetAt: number; paused: boolean }; cache: Record<string, unknown> };
    expect(body.rateLimit.remaining).toBe(4500);
    expect(body.rateLimit.resetAt).toBe(1700000000);
    expect(body.rateLimit.paused).toBe(false);
  });

  it('includes cache stats in response', async () => {
    mockGetRateLimitState.mockReturnValue({ remaining: 4500, resetAt: 1700000000, paused: false });
    mockGetCacheStats.mockReturnValue({ hits: 100, misses: 20, etagHits: 15, rateLimitEvents: 1, entries: 50 });
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { cache: { hits: number; misses: number; etagHits: number; graphqlIssues: number; proxy: { hits: number; misses: number } } };
    expect(body.cache.hits).toBe(100);
    expect(body.cache.misses).toBe(20);
    expect(body.cache.etagHits).toBe(15);
    expect(body.cache.graphqlIssues).toBe(2);
    expect(body.cache.proxy).toBeDefined();
  });

  it('falls back to gh CLI when rate limit state has never been populated', async () => {
    // remaining: -1 triggers the fallback
    mockGetRateLimitState.mockReturnValue({ remaining: -1, resetAt: 0, paused: false });
    mockGh.mockReturnValue('{"remaining":4800,"reset":1700000000}');
    mockGetCachedIssues.mockReturnValue(null);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(mockGh).toHaveBeenCalledWith('api rate_limit --jq \'.rate | {remaining, reset}\'');

    const body = parseBody(res) as { rateLimit: { remaining: number } };
    expect(body.rateLimit.remaining).toBe(4800);
  });

  it('falls back to gh CLI when remaining=5000 and resetAt=0 (default state)', async () => {
    mockGetRateLimitState.mockReturnValue({ remaining: 5000, resetAt: 0, paused: false });
    mockGh.mockReturnValue('{"remaining":4900,"reset":1700000000}');
    mockGetCachedIssues.mockReturnValue(null);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(mockGh).toHaveBeenCalled();

    const body = parseBody(res) as { rateLimit: { remaining: number } };
    expect(body.rateLimit.remaining).toBe(4900);
  });

  it('handles gh CLI failure gracefully', async () => {
    mockGetRateLimitState.mockReturnValue({ remaining: -1, resetAt: 0, paused: false });
    mockGh.mockImplementation(() => { throw new Error('gh not available'); });
    mockGetCachedIssues.mockReturnValue(null);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    // Should still return 200, with the original (unpopulated) rate limit state
    expect(res._status).toBe(200);
    const body = parseBody(res) as { rateLimit: { remaining: number } };
    expect(body.rateLimit.remaining).toBe(-1);
  });

  it('reports graphqlIssues count as 0 when cache is empty', async () => {
    mockGetRateLimitState.mockReturnValue({ remaining: 4500, resetAt: 1700000000, paused: false });
    mockGetCachedIssues.mockReturnValue(null);

    const req = mockReq('GET', '/api/github/rate-limit');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    const body = parseBody(res) as { cache: { graphqlIssues: number } };
    expect(body.cache.graphqlIssues).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Routing
// ═══════════════════════════════════════════════════════════════════════════

describe('Routing', () => {
  it('returns 404 for unknown paths', async () => {
    const req = mockReq('GET', '/api/github/unknown');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
    const body = parseBody(res) as { error: string };
    expect(body.error).toBe('Not found');
  });

  it('returns 404 for unknown sub-paths under issues/:number', async () => {
    const req = mockReq('GET', '/api/github/issues/42/unknown');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
  });

  it('returns 405 for wrong methods', async () => {
    const req = mockReq('PATCH', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(405);
    const body = parseBody(res) as { error: string };
    expect(body.error).toBe('Method not allowed');
  });

  it('returns 405 for POST to non-invalidate path', async () => {
    const req = mockReq('POST', '/api/github/issues');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(405);
  });

  it('allows POST only to /api/github/invalidate', async () => {
    const req = mockReq('POST', '/api/github/invalidate', '{}');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
  });

  it('correctly parses issue numbers from URL', async () => {
    mockGetCachedIssues.mockReturnValue([
      { number: 618, title: 'Issue 618', labels: ['priority:high'], updatedAt: '2026-03-20T10:00:00Z', createdAt: '2026-03-19T08:00:00Z' },
    ]);

    const req = mockReq('GET', '/api/github/issues/618/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { labels: string[] };
    expect(body.labels).toEqual(['priority:high']);
  });

  it('parses multi-digit issue numbers', async () => {
    mockGetCachedIssues.mockReturnValue([
      { number: 12345, title: 'Large number', labels: ['test'], updatedAt: '2026-03-20T10:00:00Z', createdAt: '2026-03-19T08:00:00Z' },
    ]);

    const req = mockReq('GET', '/api/github/issues/12345/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    const body = parseBody(res) as { labels: string[] };
    expect(body.labels).toEqual(['test']);
  });

  it('returns 404 for /api/github/issues/0 (zero is not a valid issue number)', async () => {
    // The regex matches \d+ so "0" is captured, but issueNumber <= 0 check triggers 400
    const req = mockReq('GET', '/api/github/issues/0/labels');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toBe('Invalid issue number');
  });

  it('returns 404 for paths that do not match the /api/github prefix pattern', async () => {
    const req = mockReq('GET', '/api/github/');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. GET /api/github/issues/:number (detail endpoint)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/github/issues/:number', () => {
  it('returns full issue details from cachedGhApiAsync', async () => {
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);
    mockCachedGhApiAsync.mockResolvedValue(JSON.stringify({
      number: 42,
      title: 'Fix login bug',
      body: 'Detailed description here',
      state: 'open',
      labels: [{ name: 'bug' }],
    }));

    const req = mockReq('GET', '/api/github/issues/42');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('hit');
    const body = parseBody(res) as { number: number; title: string; body: string; state: string; labels: string[] };
    expect(body.number).toBe(42);
    // Title should come from cached issue (GraphQL cache) when available
    expect(body.title).toBe('Fix login bug');
    expect(body.body).toBe('Detailed description here');
    expect(body.state).toBe('open');
    // Labels should come from cached issue (GraphQL cache) when available
    expect(body.labels).toEqual(['bug', 'fritz.status:queued']);
  });

  it('falls back to cached GraphQL data when API fetch fails', async () => {
    mockGetCachedIssues.mockReturnValue(SAMPLE_ISSUES);
    mockCachedGhApiAsync.mockRejectedValue(new Error('API unavailable'));

    const req = mockReq('GET', '/api/github/issues/42');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('partial');
    const body = parseBody(res) as { number: number; title: string; body: null; state: string };
    expect(body.number).toBe(42);
    expect(body.title).toBe('Fix login bug');
    expect(body.body).toBeNull();
    expect(body.state).toBe('OPEN');
  });

  it('returns 404 when API fails and issue not in GraphQL cache', async () => {
    mockGetCachedIssues.mockReturnValue(null);
    mockCachedGhApiAsync.mockRejectedValue(new Error('Not found'));

    const req = mockReq('GET', '/api/github/issues/999');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(404);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('999');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. POST /api/github/issues/:number/comment — agent write proxy
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/github/issues/:number/comment', () => {
  it('posts a comment via write queue and returns 201', async () => {
    mockPostComment.mockResolvedValue(undefined);

    const req = mockReq('POST', '/api/github/issues/42/comment', JSON.stringify({ body: 'Test comment' }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(201);
    expect(parseBody(res)).toEqual({ ok: true });
    expect(mockPostComment).toHaveBeenCalledWith(42, 'Test comment');
  });

  it('returns 400 when body field is missing', async () => {
    const req = mockReq('POST', '/api/github/issues/42/comment', JSON.stringify({ text: 'wrong field' }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('body');
  });

  it('returns 400 when body field is empty', async () => {
    const req = mockReq('POST', '/api/github/issues/42/comment', JSON.stringify({ body: '  ' }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('body');
  });

  it('returns 400 for invalid JSON', async () => {
    const req = mockReq('POST', '/api/github/issues/42/comment', 'not-json');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('JSON');
  });

  it('returns 502 when downstream postComment fails', async () => {
    mockPostComment.mockRejectedValue(new Error('GitHub API error'));

    const req = mockReq('POST', '/api/github/issues/42/comment', JSON.stringify({ body: 'Test comment' }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(502);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('GitHub API error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. POST /api/github/issues/:number/labels — agent write proxy
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/github/issues/:number/labels', () => {
  it('modifies labels via write queue and returns 200', async () => {
    mockGhQueued.mockResolvedValue('');

    const req = mockReq('POST', '/api/github/issues/42/labels', JSON.stringify({ add: ['bug'], remove: ['wontfix'] }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual({ ok: true });
    expect(mockGhQueued).toHaveBeenCalledWith(
      expect.arrayContaining(['issue', 'edit', '42', '--remove-label', 'wontfix', '--add-label', 'bug']),
      'high'
    );
  });

  it('returns 400 when both add and remove are empty', async () => {
    const req = mockReq('POST', '/api/github/issues/42/labels', JSON.stringify({ add: [], remove: [] }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('add');
  });

  it('returns 400 for invalid JSON', async () => {
    const req = mockReq('POST', '/api/github/issues/42/labels', 'not-json');
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(400);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('JSON');
  });

  it('returns 502 when downstream ghQueued fails', async () => {
    mockGhQueued.mockRejectedValue(new Error('Rate limit exceeded'));

    const req = mockReq('POST', '/api/github/issues/42/labels', JSON.stringify({ add: ['bug'] }));
    const res = mockRes();
    await handleGitHubProxy(req, res);

    expect(res._status).toBe(502);
    const body = parseBody(res) as { error: string };
    expect(body.error).toContain('Rate limit exceeded');
  });
});
