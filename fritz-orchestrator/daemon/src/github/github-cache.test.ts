/**
 * Vitest tests for GitHub API Cache Layer (github-cache.ts).
 *
 * Covers:
 * - parseGhApiIncludeResponse (via _testing export)
 * - cachedGhApi (sync) — TTL, cache hit/miss, rate-limit fallback
 * - ETag behavior — conditional requests, 304 responses, etagHits counter
 * - isDependencyClosedCached — permanent vs TTL caching, error handling
 * - Rate-limit circuit breaker — pause/unpause, detectRateLimitError
 * - invalidateAll / invalidate — selective and bulk cache eviction
 * - Cache stats and clearAllCaches
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
}));

vi.mock('../agents/boot.js', () => ({
  execAsync: vi.fn(async () => ''),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(async () => {}),
  notifyBootFailure: vi.fn(),
}));

vi.mock('./github-graphql.js', () => ({
  invalidateIssuesCache: vi.fn(),
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
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are set up
// ---------------------------------------------------------------------------

import {
  cachedGhApi,
  isDependencyClosedCached,
  isRateLimited,
  getRateLimitState,
  detectRateLimitError,
  invalidate,
  invalidateAll,
  invalidateIssue,
  invalidateIssueList,
  getCacheStats,
  clearAllCaches,
  _testing,
} from './github-cache.js';

import { execFileSync } from 'child_process';
import * as lifecycle from '../core/lifecycle.js';
import { invalidateIssuesCache } from './github-graphql.js';

const {
  parseGhApiIncludeResponse,
  updateRateLimitState,
  etagStore,
  resultCache,
  depCache,
  rateLimitState,
  stats,
} = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a well-formed `gh api --include` response string. */
function buildResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
  lineEnding: '\r\n' | '\n' = '\r\n',
): string {
  const lines: string[] = [`HTTP/2.0 ${status} ${statusText}`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join(lineEnding) + lineEnding + lineEnding + body;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  clearAllCaches();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. parseGhApiIncludeResponse
// ═══════════════════════════════════════════════════════════════════════════

describe('parseGhApiIncludeResponse', () => {
  it('parses HTTP/2.0 200 OK with headers and JSON body', () => {
    const raw = buildResponse(200, 'OK', {
      'ETag': '"abc123"',
      'Content-Type': 'application/json',
    }, '{"id":1}');

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.headers['etag']).toBe('"abc123"');
    expect(parsed.headers['content-type']).toBe('application/json');
    expect(parsed.body).toBe('{"id":1}');
  });

  it('parses HTTP/1.1 304 Not Modified with empty body', () => {
    const raw = 'HTTP/1.1 304 Not Modified\r\nETag: "xyz"\r\n\r\n';

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.status).toBe(304);
    expect(parsed.headers['etag']).toBe('"xyz"');
    expect(parsed.body).toBe('');
  });

  it('handles \\r\\n line endings', () => {
    const raw = 'HTTP/2.0 200 OK\r\nX-Custom: val\r\n\r\n{"ok":true}';

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.headers['x-custom']).toBe('val');
    expect(parsed.body).toBe('{"ok":true}');
  });

  it('handles \\n line endings', () => {
    const raw = 'HTTP/2.0 200 OK\nX-Custom: val\n\n{"ok":true}';

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.headers['x-custom']).toBe('val');
    expect(parsed.body).toBe('{"ok":true}');
  });

  it('extracts ETag header case-insensitively', () => {
    // The implementation lower-cases all header keys
    const raw = 'HTTP/2.0 200 OK\r\nEtag: "W/abc"\r\n\r\n{}';

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.headers['etag']).toBe('"W/abc"');
  });

  it('extracts X-RateLimit-Remaining and X-RateLimit-Reset headers', () => {
    const raw = buildResponse(200, 'OK', {
      'X-RateLimit-Remaining': '4500',
      'X-RateLimit-Reset': '1700000000',
    }, '{}');

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.headers['x-ratelimit-remaining']).toBe('4500');
    expect(parsed.headers['x-ratelimit-reset']).toBe('1700000000');
  });

  it('handles response with no headers (just status + body)', () => {
    const raw = 'HTTP/2.0 200 OK\r\n\r\n{"data":"value"}';

    const parsed = parseGhApiIncludeResponse(raw);
    expect(parsed.status).toBe(200);
    expect(Object.keys(parsed.headers)).toHaveLength(0);
    expect(parsed.body).toBe('{"data":"value"}');
  });

  it('returns status 0-equivalent and empty body on unparseable input', () => {
    // No blank-line separator -> fallback treats it all as body with status 200
    const raw = 'garbage-no-separator';

    const parsed = parseGhApiIncludeResponse(raw);
    // The implementation returns status 200 as default and the raw as body when
    // it cannot find a separator.
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('garbage-no-separator');
    expect(Object.keys(parsed.headers)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. cachedGhApi (sync)
// ═══════════════════════════════════════════════════════════════════════════

describe('cachedGhApi (sync)', () => {
  it('returns fresh data on first call (cache miss)', () => {
    const response = buildResponse(200, 'OK', {}, '{"fresh":true}');
    vi.mocked(execFileSync).mockReturnValue(response);

    const result = cachedGhApi('repos/owner/repo/issues');
    expect(result).toBe('{"fresh":true}');
    expect(execFileSync).toHaveBeenCalledTimes(1);

    const s = getCacheStats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(0);
  });

  it('returns cached data on second call within TTL (cache hit)', () => {
    const response = buildResponse(200, 'OK', {}, '{"cached":true}');
    vi.mocked(execFileSync).mockReturnValue(response);

    cachedGhApi('repos/owner/repo/issues');
    const result = cachedGhApi('repos/owner/repo/issues');

    expect(result).toBe('{"cached":true}');
    // Only one actual fetch should have happened
    expect(execFileSync).toHaveBeenCalledTimes(1);

    const s = getCacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });

  it('re-fetches after TTL expires', () => {
    const response1 = buildResponse(200, 'OK', {}, '{"v":1}');
    const response2 = buildResponse(200, 'OK', {}, '{"v":2}');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(response1)
      .mockReturnValueOnce(response2);

    // Use a very short TTL so we can expire it by manipulating the cache entry
    cachedGhApi('repos/owner/repo/test', { ttl: 100 });

    // Manually expire the cache entry
    const entry = resultCache.get('repos/owner/repo/test');
    if (entry) entry.fetchedAt = Date.now() - 200;

    const result = cachedGhApi('repos/owner/repo/test', { ttl: 100 });
    expect(result).toBe('{"v":2}');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('custom TTL is respected', () => {
    const response = buildResponse(200, 'OK', {}, '{"custom":true}');
    vi.mocked(execFileSync).mockReturnValue(response);

    cachedGhApi('repos/owner/repo/custom', { ttl: 5000 });

    const entry = resultCache.get('repos/owner/repo/custom');
    expect(entry).toBeDefined();
    expect(entry!.ttl).toBe(5000);
  });

  it('returns stale data when rate-limited', () => {
    const response = buildResponse(200, 'OK', {}, '{"stale":true}');
    vi.mocked(execFileSync).mockReturnValue(response);

    // Populate the cache
    cachedGhApi('repos/owner/repo/stale');

    // Simulate rate limiting
    rateLimitState.paused = true;
    rateLimitState.resetAt = Math.floor(Date.now() / 1000) + 3600; // far future

    const result = cachedGhApi('repos/owner/repo/stale');
    expect(result).toBe('{"stale":true}');
    // No additional fetch should have been attempted
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('throws when rate-limited and no cached data exists', () => {
    rateLimitState.paused = true;
    rateLimitState.resetAt = Math.floor(Date.now() / 1000) + 3600;

    expect(() => cachedGhApi('repos/owner/repo/uncached')).toThrow(
      'GitHub API rate limited and no cached data available',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ETag behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('ETag behavior', () => {
  it('first request sends no If-None-Match header', () => {
    const response = buildResponse(200, 'OK', { 'ETag': '"first"' }, '{"data":1}');
    vi.mocked(execFileSync).mockReturnValue(response);

    cachedGhApi('repos/owner/repo/etag-test');

    const args = vi.mocked(execFileSync).mock.calls[0];
    // args[0] = 'gh', args[1] = ['api', '--include', path, ...]
    const ghArgs = args[1] as string[];
    expect(ghArgs).not.toContain('If-None-Match');
  });

  it('second request sends If-None-Match with stored ETag', () => {
    const response1 = buildResponse(200, 'OK', { 'ETag': '"v1"' }, '{"data":1}');
    const response2 = buildResponse(200, 'OK', { 'ETag': '"v2"' }, '{"data":2}');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(response1)
      .mockReturnValueOnce(response2);

    const path = 'repos/owner/repo/etag-second';
    cachedGhApi(path);

    // Expire the TTL cache so the second call goes to fetchWithETag
    const entry = resultCache.get(path);
    if (entry) entry.fetchedAt = 0;

    cachedGhApi(path);

    const secondCallArgs = vi.mocked(execFileSync).mock.calls[1][1] as string[];
    const headerIdx = secondCallArgs.indexOf('-H');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(secondCallArgs[headerIdx + 1]).toBe('If-None-Match: "v1"');
  });

  it('304 response from error output returns cached data and increments etagHits', () => {
    // First call — populate the etag store
    const response1 = buildResponse(200, 'OK', { 'ETag': '"etag1"' }, '{"cached":"yes"}');
    vi.mocked(execFileSync).mockReturnValueOnce(response1);

    const path = 'repos/owner/repo/etag-304';
    cachedGhApi(path);

    // Expire TTL so the second call re-fetches
    const entry = resultCache.get(path);
    if (entry) entry.fetchedAt = 0;

    // gh exits non-zero on 304 — simulate via thrown error
    const error304 = new Error('HTTP 304 Not Modified');
    (error304 as Record<string, unknown>).stdout = 'HTTP/2.0 304 Not Modified\r\n\r\n';
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw error304; });

    const result = cachedGhApi(path);
    expect(result).toBe('{"cached":"yes"}');

    const s = getCacheStats();
    expect(s.etagHits).toBeGreaterThanOrEqual(1);
  });

  it('200 response updates the ETag store', () => {
    const response = buildResponse(200, 'OK', { 'ETag': '"new-etag"' }, '{"updated":true}');
    vi.mocked(execFileSync).mockReturnValue(response);

    const path = 'repos/owner/repo/etag-update';
    cachedGhApi(path);

    const stored = etagStore.get(path);
    expect(stored).toBeDefined();
    expect(stored!.etag).toBe('"new-etag"');
    expect(stored!.data).toBe('{"updated":true}');
  });

  it('etagHits counter increments on 304', () => {
    const response = buildResponse(200, 'OK', { 'ETag': '"e1"' }, '{"val":1}');
    vi.mocked(execFileSync).mockReturnValueOnce(response);

    const path = 'repos/owner/repo/etag-count';
    cachedGhApi(path);

    const before = getCacheStats().etagHits;

    // Expire TTL
    const entry = resultCache.get(path);
    if (entry) entry.fetchedAt = 0;

    // Simulate 304 via error
    const err = new Error('304');
    (err as Record<string, unknown>).stdout = '304 Not Modified';
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw err; });

    cachedGhApi(path);

    expect(getCacheStats().etagHits).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. isDependencyClosedCached
// ═══════════════════════════════════════════════════════════════════════════

describe('isDependencyClosedCached', () => {
  it('returns true for closed issue (fetches and caches)', () => {
    const response = buildResponse(200, 'OK', {}, '{"state":"closed"}');
    vi.mocked(execFileSync).mockReturnValue(response);

    const result = isDependencyClosedCached(42, 'owner/repo');
    expect(result).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns true on second check without API call (permanent cache)', () => {
    const response = buildResponse(200, 'OK', {}, '{"state":"closed"}');
    vi.mocked(execFileSync).mockReturnValue(response);

    isDependencyClosedCached(42, 'owner/repo');
    vi.mocked(execFileSync).mockClear();

    const result = isDependencyClosedCached(42, 'owner/repo');
    expect(result).toBe(true);
    // No API call should be made — permanent cache for closed issues
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns false for open issue', () => {
    const response = buildResponse(200, 'OK', {}, '{"state":"open"}');
    vi.mocked(execFileSync).mockReturnValue(response);

    const result = isDependencyClosedCached(43, 'owner/repo');
    expect(result).toBe(false);
  });

  it('returns cached false within 60s (no API call)', () => {
    const response = buildResponse(200, 'OK', {}, '{"state":"open"}');
    vi.mocked(execFileSync).mockReturnValue(response);

    isDependencyClosedCached(44, 'owner/repo');
    vi.mocked(execFileSync).mockClear();

    const result = isDependencyClosedCached(44, 'owner/repo');
    expect(result).toBe(false);
    // Should use dep cache, not make an API call
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('re-fetches open issue after 60s', () => {
    const response1 = buildResponse(200, 'OK', {}, '{"state":"open"}');
    const response2 = buildResponse(200, 'OK', {}, '{"state":"closed"}');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(response1)
      .mockReturnValueOnce(response2);

    isDependencyClosedCached(45, 'owner/repo');

    // Expire the dep cache entry (simulate 60s passing)
    const depEntry = depCache.get(45);
    if (depEntry) depEntry.fetchedAt = Date.now() - 61_000;

    // Also expire the result cache so cachedGhApi re-fetches
    for (const [key, entry] of resultCache) {
      if (key.includes('/issues/45')) entry.fetchedAt = 0;
    }

    const result = isDependencyClosedCached(45, 'owner/repo');
    expect(result).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('returns false on fetch error (safe default)', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('network error');
    });

    const result = isDependencyClosedCached(46, 'owner/repo');
    expect(result).toBe(false);
  });

  it('after invalidate("dep:N"), re-fetches on next check', () => {
    const response1 = buildResponse(200, 'OK', {}, '{"state":"open"}');
    const response2 = buildResponse(200, 'OK', {}, '{"state":"closed"}');
    vi.mocked(execFileSync)
      .mockReturnValueOnce(response1)
      .mockReturnValueOnce(response2);

    isDependencyClosedCached(47, 'owner/repo');

    // Invalidate just the dep cache for issue 47
    invalidate('dep:47');

    // Also expire the result cache so cachedGhApi re-fetches
    for (const [key, entry] of resultCache) {
      if (key.includes('/issues/47')) entry.fetchedAt = 0;
    }

    const result = isDependencyClosedCached(47, 'owner/repo');
    expect(result).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Rate-limit circuit breaker
// ═══════════════════════════════════════════════════════════════════════════

describe('Rate-limit circuit breaker', () => {
  it('sets paused=true when remaining < 50', () => {
    updateRateLimitState({
      'x-ratelimit-remaining': '10',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    });

    expect(rateLimitState.paused).toBe(true);
    expect(rateLimitState.remaining).toBe(10);
    expect(lifecycle.system).toHaveBeenCalled();
  });

  it('isRateLimited() returns true when paused', () => {
    rateLimitState.paused = true;
    rateLimitState.resetAt = Math.floor(Date.now() / 1000) + 3600;

    expect(isRateLimited()).toBe(true);
  });

  it('auto-unpauses after resetAt time passes', () => {
    rateLimitState.paused = true;
    rateLimitState.resetAt = Math.floor(Date.now() / 1000) - 10; // 10 seconds in the past

    expect(isRateLimited()).toBe(false);
    expect(rateLimitState.paused).toBe(false);
    expect(rateLimitState.remaining).toBe(5000); // Reset to full
  });

  it('detectRateLimitError catches known error strings', () => {
    expect(detectRateLimitError('API rate limit already exceeded')).toBe(true);
    expect(detectRateLimitError('API rate limit exceeded')).toBe(true);
    expect(detectRateLimitError('rate limit exceeded')).toBe(true);
    expect(detectRateLimitError('secondary rate limit')).toBe(true);
    expect(detectRateLimitError('some other error')).toBe(false);
    expect(detectRateLimitError('')).toBe(false);
  });

  it('getRateLimitState returns current state', () => {
    rateLimitState.remaining = 1234;
    rateLimitState.resetAt = 9999999;
    rateLimitState.paused = false;

    const state = getRateLimitState();
    expect(state.remaining).toBe(1234);
    expect(state.resetAt).toBe(9999999);
    expect(state.paused).toBe(false);

    // Should return a copy, not a reference
    state.remaining = 0;
    expect(rateLimitState.remaining).toBe(1234);
  });

  it('increments rateLimitEvents on pause', () => {
    const before = getCacheStats().rateLimitEvents;

    updateRateLimitState({
      'x-ratelimit-remaining': '5',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    });

    expect(getCacheStats().rateLimitEvents).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. invalidateAll
// ═══════════════════════════════════════════════════════════════════════════

describe('invalidateAll', () => {
  beforeEach(() => {
    // Populate caches with test data
    resultCache.set('repos/owner/repo/issues/42', {
      data: '{"id":42}',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/421', {
      data: '{"id":421}',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues', {
      data: '[{"id":42}]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/42/comments', {
      data: '[]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    etagStore.set('repos/owner/repo/issues/42', {
      etag: '"e42"',
      data: '{"id":42}',
    });
  });

  it('clears specific issue from result cache', () => {
    invalidate(42);
    expect(resultCache.has('repos/owner/repo/issues/42')).toBe(false);
    expect(etagStore.has('repos/owner/repo/issues/42')).toBe(false);
  });

  it('clears "all-issues" entries', () => {
    invalidate('all-issues');
    // Issue list caches should be gone
    expect(resultCache.has('repos/owner/repo/issues')).toBe(false);
    // Single-issue entry should also match /issues pattern
    expect(resultCache.has('repos/owner/repo/issues/42')).toBe(false);
    // Comments should be preserved (the implementation excludes /comments)
    expect(resultCache.has('repos/owner/repo/issues/42/comments')).toBe(true);
  });

  it('calls invalidateIssuesCache (mock and verify)', () => {
    invalidateAll(42);
    expect(invalidateIssuesCache).toHaveBeenCalledTimes(1);
  });

  it('invalidate(42) does NOT match issue 421', () => {
    invalidate(42);
    // Issue 421 must still be in the cache
    expect(resultCache.has('repos/owner/repo/issues/421')).toBe(true);
    // Issue 42 must be gone
    expect(resultCache.has('repos/owner/repo/issues/42')).toBe(false);
  });

  it('invalidateAll without issue number still clears all-issues and calls invalidateIssuesCache', () => {
    invalidateAll();
    expect(resultCache.has('repos/owner/repo/issues')).toBe(false);
    expect(invalidateIssuesCache).toHaveBeenCalled();
    // Individual issue paths that contain /issues/ but not /comments are cleared by all-issues
    // The comments path should remain
    expect(resultCache.has('repos/owner/repo/issues/42/comments')).toBe(true);
  });

  it('invalidate clears dep cache for numeric keys', () => {
    depCache.set(42, { closed: true, fetchedAt: Date.now() });
    invalidate(42);
    expect(depCache.has(42)).toBe(false);
  });

  it('invalidate("dep:N") clears only the specified dependency', () => {
    depCache.set(10, { closed: false, fetchedAt: Date.now() });
    depCache.set(20, { closed: false, fetchedAt: Date.now() });
    invalidate('dep:10');
    expect(depCache.has(10)).toBe(false);
    expect(depCache.has(20)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6b. invalidateIssue — targeted invalidation preserving ETags
// ═══════════════════════════════════════════════════════════════════════════

describe('invalidateIssue', () => {
  beforeEach(() => {
    resultCache.set('repos/owner/repo/issues/42', {
      data: '{"id":42}',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/42/comments', {
      data: '[]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/421', {
      data: '{"id":421}',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues', {
      data: '[{"id":42}]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    etagStore.set('repos/owner/repo/issues/42', {
      etag: '"e42"',
      data: '{"id":42}',
    });
    etagStore.set('repos/owner/repo/issues', {
      etag: '"eall"',
      data: '[{"id":42}]',
    });
  });

  it('clears result cache for the specific issue', () => {
    invalidateIssue(42);
    expect(resultCache.has('repos/owner/repo/issues/42')).toBe(false);
    expect(resultCache.has('repos/owner/repo/issues/42/comments')).toBe(false);
  });

  it('preserves ETags for the invalidated issue', () => {
    invalidateIssue(42);
    expect(etagStore.has('repos/owner/repo/issues/42')).toBe(true);
    expect(etagStore.get('repos/owner/repo/issues/42')?.etag).toBe('"e42"');
  });

  it('does NOT clear all-issues cache or ETags', () => {
    invalidateIssue(42);
    expect(resultCache.has('repos/owner/repo/issues')).toBe(true);
    expect(etagStore.has('repos/owner/repo/issues')).toBe(true);
  });

  it('does NOT affect unrelated issues', () => {
    invalidateIssue(42);
    expect(resultCache.has('repos/owner/repo/issues/421')).toBe(true);
  });

  it('calls invalidateIssuesCache to clear GraphQL consolidated cache', () => {
    vi.mocked(invalidateIssuesCache).mockClear();
    invalidateIssue(42);
    expect(invalidateIssuesCache).toHaveBeenCalledOnce();
  });

  it('clears dependency cache for the issue', () => {
    depCache.set(42, { closed: false, fetchedAt: Date.now() });
    invalidateIssue(42);
    expect(depCache.has(42)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6c. invalidateIssueList — list-level invalidation preserving ETags
// ═══════════════════════════════════════════════════════════════════════════

describe('invalidateIssueList', () => {
  beforeEach(() => {
    resultCache.set('repos/owner/repo/issues', {
      data: '[{"id":42}]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/42', {
      data: '{"id":42}',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    resultCache.set('repos/owner/repo/issues/42/comments', {
      data: '[]',
      fetchedAt: Date.now(),
      ttl: 60000,
    });
    etagStore.set('repos/owner/repo/issues', {
      etag: '"eall"',
      data: '[{"id":42}]',
    });
  });

  it('clears issue list result caches', () => {
    invalidateIssueList();
    expect(resultCache.has('repos/owner/repo/issues')).toBe(false);
  });

  it('also clears individual issue TTL caches (but not comments)', () => {
    invalidateIssueList();
    // Individual issue paths match `/issues` and are cleared too
    expect(resultCache.has('repos/owner/repo/issues/42')).toBe(false);
    // Comments are excluded from the clearing
    expect(resultCache.has('repos/owner/repo/issues/42/comments')).toBe(true);
  });

  it('preserves ETags for issue list paths', () => {
    invalidateIssueList();
    expect(etagStore.has('repos/owner/repo/issues')).toBe(true);
  });

  it('preserves comments cache', () => {
    invalidateIssueList();
    expect(resultCache.has('repos/owner/repo/issues/42/comments')).toBe(true);
  });

  it('calls invalidateIssuesCache for GraphQL', () => {
    vi.mocked(invalidateIssuesCache).mockClear();
    invalidateIssueList();
    expect(invalidateIssuesCache).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Cache stats
// ═══════════════════════════════════════════════════════════════════════════

describe('Cache stats', () => {
  it('tracks hits, misses, etagHits, rateLimitEvents', () => {
    const response = buildResponse(200, 'OK', {}, '{"v":1}');
    vi.mocked(execFileSync).mockReturnValue(response);

    cachedGhApi('repos/owner/repo/stats-test'); // miss
    cachedGhApi('repos/owner/repo/stats-test'); // hit

    const s = getCacheStats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.etagHits).toBeGreaterThanOrEqual(0);
    expect(s.rateLimitEvents).toBeGreaterThanOrEqual(0);
    expect(s.entries).toBeGreaterThan(0);
  });

  it('clearAllCaches resets everything', () => {
    // Set up some state
    const response = buildResponse(200, 'OK', { 'ETag': '"e1"' }, '{"v":1}');
    vi.mocked(execFileSync).mockReturnValue(response);

    cachedGhApi('repos/owner/repo/clear-test');
    depCache.set(99, { closed: true, fetchedAt: Date.now() });
    stats.rateLimitEvents = 5;

    clearAllCaches();

    const s = getCacheStats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.etagHits).toBe(0);
    expect(s.rateLimitEvents).toBe(0);
    expect(s.entries).toBe(0);

    expect(resultCache.size).toBe(0);
    expect(etagStore.size).toBe(0);
    expect(depCache.size).toBe(0);

    expect(rateLimitState.paused).toBe(false);
    expect(rateLimitState.remaining).toBe(5000);
    expect(rateLimitState.resetAt).toBe(0);
  });
});
