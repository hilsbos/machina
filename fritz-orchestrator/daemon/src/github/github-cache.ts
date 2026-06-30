/**
 * GitHub API Cache Layer
 *
 * Central caching module that reduces GitHub API calls through:
 * - ETag-based conditional requests (304 = free, doesn't count against rate limit)
 * - TTL-based result cache with configurable expiry
 * - Rate-limit circuit breaker to prevent death spirals
 * - Permanent dependency cache for closed issues
 *
 * Reads go through the cache; mutations go directly to `gh` then invalidate.
 */

import { execFileSync } from 'child_process';
import { execAsync } from '../agents/boot.js';
import * as lifecycle from '../core/lifecycle.js';
import { logEvent } from '../core/event-log.js';
import { invalidateIssuesCache } from './github-graphql.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T = string> {
  data: T;
  etag?: string;
  fetchedAt: number;
  ttl: number; // ms
}

interface ETagEntry {
  etag: string;
  data: string;
}

interface RateLimitState {
  remaining: number;
  resetAt: number;   // Unix timestamp (seconds)
  paused: boolean;
}

interface DependencyEntry {
  closed: boolean;
  fetchedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  etagHits: number;
  rateLimitEvents: number;
  entries: number;
}

interface ParsedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Default TTL
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60_000; // 60 seconds
const DEP_OPEN_TTL_MS = 60_000; // 60 seconds for open dependency issues

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** ETag store: URL path -> { etag, data } */
const etagStore = new Map<string, ETagEntry>();

/** TTL result cache: URL path -> CacheEntry */
const resultCache = new Map<string, CacheEntry>();

/** Dependency state cache: issue number -> { closed, fetchedAt } */
const depCache = new Map<number, DependencyEntry>();

/** Rate-limit circuit breaker state */
const rateLimitState: RateLimitState = {
  remaining: 5000,
  resetAt: 0,
  paused: false,
};

/** Cache statistics */
const stats = {
  hits: 0,
  misses: 0,
  etagHits: 0,
  rateLimitEvents: 0,
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the output of `gh api --include` which returns HTTP headers + body.
 *
 * Format:
 *   HTTP/2.0 200 OK
 *   Key: Value
 *   Key: Value
 *
 *   {"json":"body"}
 *
 * The blank line separates headers from body.
 */
function parseGhApiIncludeResponse(raw: string): ParsedResponse {
  // Find the blank line that separates headers from body.
  // gh api --include outputs headers, then \r\n\r\n or \n\n, then JSON body.
  const separatorIndex = raw.indexOf('\r\n\r\n');
  let headerBlock: string;
  let body: string;

  if (separatorIndex !== -1) {
    headerBlock = raw.substring(0, separatorIndex);
    body = raw.substring(separatorIndex + 4);
  } else {
    // Try Unix-style line endings
    const unixSep = raw.indexOf('\n\n');
    if (unixSep !== -1) {
      headerBlock = raw.substring(0, unixSep);
      body = raw.substring(unixSep + 2);
    } else {
      // No separator found — treat entire output as body (fallback)
      console.log('[github-cache] Warning: could not parse response headers, treating as body-only');
      return { status: 200, headers: {}, body: raw.trim() };
    }
  }

  const headerLines = headerBlock.split(/\r?\n/);
  let status = 200;
  const headers: Record<string, string> = {};

  // First line: HTTP/2.0 200 OK  or  HTTP/1.1 304 Not Modified
  if (headerLines.length > 0) {
    const statusMatch = headerLines[0].match(/HTTP\/[\d.]+\s+(\d+)/);
    if (statusMatch) {
      status = parseInt(statusMatch[1], 10);
    }
  }

  // Remaining lines: Key: Value
  for (let i = 1; i < headerLines.length; i++) {
    const line = headerLines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  return { status, headers, body: body.trim() };
}

// ---------------------------------------------------------------------------
// Rate-limit management
// ---------------------------------------------------------------------------

/**
 * Update rate-limit state from response headers.
 * When remaining drops below 50, pause reads and notify via lifecycle.
 */
function updateRateLimitState(headers: Record<string, string>): void {
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];

  if (remaining !== undefined) {
    rateLimitState.remaining = parseInt(remaining, 10);
  }
  if (reset !== undefined) {
    rateLimitState.resetAt = parseInt(reset, 10);
  }

  if (rateLimitState.remaining < 50 && !rateLimitState.paused) {
    rateLimitState.paused = true;
    stats.rateLimitEvents++;
    const resetIn = Math.max(0, rateLimitState.resetAt - Math.floor(Date.now() / 1000));
    console.log(`[github-cache] Rate limit low (${rateLimitState.remaining} remaining) — pausing reads for ${resetIn}s`);
    // Fire and forget — lifecycle notification is best-effort
    logEvent('github.rate-limit', `GitHub API rate limit low (${rateLimitState.remaining}) — paused for ${resetIn}s`, { remaining: rateLimitState.remaining, pauseSeconds: resetIn });
    lifecycle.system(`⚠️ GitHub API rate limit low (${rateLimitState.remaining}). Reads paused for ${resetIn}s.`).catch(() => {});
  }
}

/**
 * Check if the rate-limit pause has expired and unpause if so.
 */
function checkRateLimitReset(): void {
  if (rateLimitState.paused) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= rateLimitState.resetAt) {
      rateLimitState.paused = false;
      rateLimitState.remaining = 5000; // Assume reset to full
      console.log('[github-cache] Rate limit reset — resuming reads');
    }
  }
}

// ---------------------------------------------------------------------------
// Core fetch with ETag support (sync)
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub API path using `gh api --include` with ETag support.
 * Returns the response body as a string.
 *
 * On 304 Not Modified, returns the previously cached body (free — no rate-limit cost).
 * Parses and updates rate-limit state from every response.
 */
function fetchWithETag(path: string): { status: number; body: string } {
  const etag = etagStore.get(path);
  const args = ['api', '--include', path];

  if (etag?.etag) {
    args.push('-H', `If-None-Match: ${etag.etag}`);
  }

  try {
    const raw = execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const parsed = parseGhApiIncludeResponse(raw);

    // Update rate-limit state from every response
    updateRateLimitState(parsed.headers);

    // 304 Not Modified — return cached data (FREE, doesn't count against rate limit)
    if (parsed.status === 304 && etag) {
      stats.etagHits++;
      return { status: 304, body: etag.data };
    }

    // Store new ETag if present
    if (parsed.headers['etag']) {
      etagStore.set(path, { etag: parsed.headers['etag'], data: parsed.body });
    }

    return { status: parsed.status, body: parsed.body };
  } catch (error: unknown) {
    // gh api --include exits non-zero on 304 Not Modified
    // Check error output for 304 status and return cached data
    const execErr = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const errOutput = execErr.stdout?.toString() || execErr.stderr?.toString() || '';
    const errMsg = error instanceof Error ? error.message : '';
    const combined = errOutput + errMsg;

    if (combined.includes('304') || combined.includes('Not Modified')) {
      const entry = etagStore.get(path);
      if (entry) {
        stats.etagHits++;
        return { status: 304, body: entry.data };
      }
    }

    const msg = error instanceof Error ? error.message : String(error);

    // Detect rate-limit errors from error output
    if (detectRateLimitError(msg)) {
      rateLimitState.paused = true;
      stats.rateLimitEvents++;
      // Try to parse a reset time from the error, otherwise assume 60s
      if (rateLimitState.resetAt <= Math.floor(Date.now() / 1000)) {
        rateLimitState.resetAt = Math.floor(Date.now() / 1000) + 60;
      }
      console.log(`[github-cache] Rate limit exceeded (from error) — pausing reads`);
    }

    console.error(`[github-cache] gh api ${path} failed:`, msg);
    throw error;
  }
}

/**
 * Async version of fetchWithETag using execAsync.
 */
async function fetchWithETagAsync(path: string): Promise<{ status: number; body: string }> {
  const etag = etagStore.get(path);
  const args = ['api', '--include', path];

  if (etag?.etag) {
    args.push('-H', `If-None-Match: ${etag.etag}`);
  }

  try {
    const raw = await execAsync('gh', args, { timeout: 30_000 });

    const parsed = parseGhApiIncludeResponse(raw.trim());

    // Update rate-limit state from every response
    updateRateLimitState(parsed.headers);

    // 304 Not Modified — return cached data (FREE)
    if (parsed.status === 304 && etag) {
      stats.etagHits++;
      return { status: 304, body: etag.data };
    }

    // Store new ETag if present
    if (parsed.headers['etag']) {
      etagStore.set(path, { etag: parsed.headers['etag'], data: parsed.body });
    }

    return { status: parsed.status, body: parsed.body };
  } catch (error: unknown) {
    // gh api --include exits non-zero on 304 Not Modified
    // Check error output for 304 status and return cached data
    const execErr = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const errOutput = execErr.stdout?.toString() || execErr.stderr?.toString() || '';
    const errMsg = error instanceof Error ? error.message : '';
    const combined = errOutput + errMsg;

    if (combined.includes('304') || combined.includes('Not Modified')) {
      const entry = etagStore.get(path);
      if (entry) {
        stats.etagHits++;
        return { status: 304, body: entry.data };
      }
    }

    const msg = error instanceof Error ? error.message : String(error);

    if (detectRateLimitError(msg)) {
      rateLimitState.paused = true;
      stats.rateLimitEvents++;
      if (rateLimitState.resetAt <= Math.floor(Date.now() / 1000)) {
        rateLimitState.resetAt = Math.floor(Date.now() / 1000) + 60;
      }
      console.log(`[github-cache] Rate limit exceeded (from error) — pausing reads`);
    }

    console.error(`[github-cache] gh api ${path} failed:`, msg);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public API: cached gh api (sync)
// ---------------------------------------------------------------------------

/**
 * Fetch a GitHub API path with ETag + TTL caching (synchronous).
 *
 * Returns the JSON body as a string. Cache entries expire after `opts.ttl` (default 60s),
 * but ETag re-validation may still result in a free 304.
 *
 * @param path - GitHub API path (e.g., `repos/owner/name/issues`)
 * @param opts - Optional configuration: `ttl` in milliseconds (default 60000)
 * @returns The response body as a string
 */
export function cachedGhApi(path: string, opts?: { ttl?: number }): string {
  // If rate-limited, return stale cached data or throw
  checkRateLimitReset();
  if (rateLimitState.paused) {
    const cached = resultCache.get(path);
    if (cached) {
      stats.hits++;
      return cached.data;
    }
    throw new Error('GitHub API rate limited and no cached data available');
  }

  const ttl = opts?.ttl ?? DEFAULT_TTL_MS;
  const now = Date.now();

  // Check TTL cache first
  const cached = resultCache.get(path);
  if (cached && (now - cached.fetchedAt < cached.ttl)) {
    stats.hits++;
    return cached.data;
  }

  // Cache miss or expired — fetch (ETag may still save us a rate-limit hit)
  stats.misses++;
  const { body } = fetchWithETag(path);

  // Store in TTL cache
  resultCache.set(path, {
    data: body,
    fetchedAt: now,
    ttl,
  });

  return body;
}

/**
 * Fetch a GitHub API path with ETag + TTL caching (asynchronous).
 *
 * Returns the JSON body as a string. Cache entries expire after `opts.ttl` (default 60s),
 * but ETag re-validation may still result in a free 304.
 *
 * @param path - GitHub API path (e.g., `repos/owner/name/issues`)
 * @param opts - Optional configuration: `ttl` in milliseconds (default 60000)
 * @returns Promise resolving to the response body as a string
 */
export async function cachedGhApiAsync(path: string, opts?: { ttl?: number }): Promise<string> {
  // If rate-limited, return stale cached data or throw
  checkRateLimitReset();
  if (rateLimitState.paused) {
    const cached = resultCache.get(path);
    if (cached) {
      stats.hits++;
      return cached.data;
    }
    throw new Error('GitHub API rate limited and no cached data available');
  }

  const ttl = opts?.ttl ?? DEFAULT_TTL_MS;
  const now = Date.now();

  // Check TTL cache first
  const cached = resultCache.get(path);
  if (cached && (now - cached.fetchedAt < cached.ttl)) {
    stats.hits++;
    return cached.data;
  }

  // Cache miss or expired — fetch (ETag may still save us a rate-limit hit)
  stats.misses++;
  const { body } = await fetchWithETagAsync(path);

  // Store in TTL cache
  resultCache.set(path, {
    data: body,
    fetchedAt: Date.now(),
    ttl,
  });

  return body;
}

// ---------------------------------------------------------------------------
// Public API: dependency cache
// ---------------------------------------------------------------------------

/**
 * Check if a dependency issue is closed, using a smart cache strategy.
 *
 * - Closed issues are cached **permanently** (closed issues don't reopen in this workflow).
 * - Open issues are cached for 60 seconds.
 * - Cache misses trigger a fresh `gh api` call.
 *
 * @param issue - The dependency issue number to check
 * @param repo - The repository in `owner/name` format
 * @returns `true` if the issue is closed, `false` otherwise
 */
export function isDependencyClosedCached(issue: number, repo: string): boolean {
  const cached = depCache.get(issue);
  if (cached) {
    // Closed = permanent cache (closed issues don't reopen in this workflow)
    if (cached.closed) return true;
    // Open = 60s TTL
    if (Date.now() - cached.fetchedAt < DEP_OPEN_TTL_MS) return cached.closed;
  }

  // Cache miss or expired — fetch from GitHub API
  try {
    const raw = cachedGhApi(`repos/${repo}/issues/${issue}`, { ttl: DEP_OPEN_TTL_MS });
    const parsed = JSON.parse(raw);
    const closed = parsed.state === 'closed';

    depCache.set(issue, { closed, fetchedAt: Date.now() });
    return closed;
  } catch (error: unknown) {
    // Log warning so persistent failures are visible (safe default: not closed)
    console.warn(
      `[github-cache] isDependencyClosedCached(#${issue}) failed: ${error instanceof Error ? error.message : error} — treating as not closed`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API: rate-limit
// ---------------------------------------------------------------------------

/**
 * Check if GitHub API reads are currently paused due to rate limiting.
 *
 * Returns `true` if the rate-limit circuit breaker is active. Callers should
 * skip non-essential reads when this returns `true`.
 *
 * @returns `true` if rate-limited, `false` otherwise
 */
export function isRateLimited(): boolean {
  checkRateLimitReset();
  return rateLimitState.paused;
}

/**
 * Get the current rate-limit state including remaining quota, reset time, and pause status.
 *
 * @returns Object with `remaining` (API calls left), `resetAt` (Unix timestamp in seconds),
 *          and `paused` (whether the circuit breaker is active)
 */
export function getRateLimitState(): { remaining: number; resetAt: number; paused: boolean } {
  checkRateLimitReset();
  return { ...rateLimitState };
}

/**
 * Detect rate-limit errors from GitHub CLI error output.
 *
 * Matches common GitHub rate-limit error strings that appear in `gh` stderr.
 * Can be used by other modules to detect rate limiting from non-cache `gh` calls.
 *
 * @param errorMsg - The error message string to check
 * @returns `true` if the error indicates a rate limit has been hit
 */
export function detectRateLimitError(errorMsg: string): boolean {
  return (
    errorMsg.includes('API rate limit already exceeded') ||
    errorMsg.includes('API rate limit exceeded') ||
    errorMsg.includes('rate limit exceeded') ||
    errorMsg.includes('secondary rate limit')
  );
}

// ---------------------------------------------------------------------------
// Public API: invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate cached data for a specific key.
 *
 * Called by `github.ts` after mutations to ensure stale data is evicted.
 *
 * @param key - What to invalidate:
 *   - `number` — issue number: clears all cached data for that issue
 *   - `'all-issues'` — clears the consolidated issues cache
 *   - `'dep:${number}'` — clears dependency cache for a specific issue
 */
export function invalidate(key: string | number): void {
  if (typeof key === 'number') {
    // Invalidate all cached data for a specific issue number
    const issueStr = String(key);
    for (const [cachePath] of resultCache) {
      const issueRegex = new RegExp(`/issues/${issueStr}(?:/|$)`);
      if (issueRegex.test(cachePath)) {
        resultCache.delete(cachePath);
        etagStore.delete(cachePath);
      }
    }
    // Also clear from dependency cache
    depCache.delete(key);
    console.log(`[github-cache] Invalidated cache for issue #${key}`);
    return;
  }

  if (key === 'all-issues') {
    // Invalidate all issue list caches (GraphQL consolidated query, REST issue lists)
    for (const [cachePath] of resultCache) {
      if (cachePath.includes('/issues') && !cachePath.includes('/comments')) {
        resultCache.delete(cachePath);
        etagStore.delete(cachePath);
      }
    }
    console.log('[github-cache] Invalidated all-issues cache');
    return;
  }

  if (key.startsWith('dep:')) {
    const issueNum = parseInt(key.substring(4), 10);
    if (!isNaN(issueNum)) {
      depCache.delete(issueNum);
      console.log(`[github-cache] Invalidated dependency cache for #${issueNum}`);
    }
    return;
  }

  // Generic string key — clear from result and etag caches
  resultCache.delete(key);
  etagStore.delete(key);
  console.log(`[github-cache] Invalidated cache key: ${key}`);
}

/**
 * Invalidate cached data for a single issue.
 *
 * Clears the TTL result cache for this issue so the next read re-fetches,
 * but **preserves ETags** so the re-fetch can still get a free 304.
 *
 * Use after single-issue mutations (label change, comment, status update).
 */
export function invalidateIssue(issue: number): void {
  const issueStr = String(issue);
  const issueRegex = new RegExp(`/issues/${issueStr}(?:/|$)`);
  for (const [cachePath] of resultCache) {
    if (issueRegex.test(cachePath)) {
      resultCache.delete(cachePath);
      // NOTE: ETags are intentionally preserved so re-fetches can get free 304s
    }
  }
  depCache.delete(issue);
  // Also invalidate the GraphQL consolidated cache — label changes on a single
  // issue make the cached "all open issues" response stale, causing the autoloop
  // to see the old status and re-process the issue (e.g. repeated conflict spam).
  invalidateIssuesCache();
  console.log(`[github-cache] Invalidated issue #${issue} (ETags preserved, GraphQL cache cleared)`);
}

/**
 * Invalidate the issue list caches (REST + GraphQL).
 *
 * Clears TTL result cache entries whose path contains `/issues` but not `/comments`.
 * This includes both the list root (e.g. `repos/owner/repo/issues`) and individual
 * issue paths (e.g. `repos/owner/repo/issues/42`), since list-membership changes
 * may affect issue data too. ETags are preserved so re-fetches can still get free 304s.
 *
 * Use after operations that change list membership: issue open/close, PR merge,
 * bulk label removal.
 */
export function invalidateIssueList(): void {
  for (const [cachePath] of resultCache) {
    if (cachePath.includes('/issues') && !cachePath.includes('/comments')) {
      resultCache.delete(cachePath);
      // NOTE: ETags are intentionally preserved so re-fetches can get free 304s
    }
  }
  invalidateIssuesCache();
  console.log('[github-cache] Invalidated issue list caches (ETags preserved)');
}

/**
 * Unified cache invalidation — clears both REST cache and GraphQL cache.
 *
 * @deprecated Use `invalidateIssue(n)` for single-issue mutations or
 * `invalidateIssueList()` for list-membership changes instead.
 */
export function invalidateAll(issue?: number): void {
  if (issue !== undefined) {
    invalidate(issue);
  }
  invalidate('all-issues');
  invalidateIssuesCache();
}

// ---------------------------------------------------------------------------
// Public API: stats
// ---------------------------------------------------------------------------

/**
 * Get cache statistics for monitoring and debugging.
 *
 * @returns Object with hit/miss counts, ETag hit count, rate-limit event count,
 *          and total number of entries across all caches
 */
export function getCacheStats(): CacheStats {
  return {
    hits: stats.hits,
    misses: stats.misses,
    etagHits: stats.etagHits,
    rateLimitEvents: stats.rateLimitEvents,
    entries: resultCache.size + etagStore.size + depCache.size,
  };
}

// ---------------------------------------------------------------------------
// Public API: testing
// ---------------------------------------------------------------------------

/**
 * Clear all caches and reset statistics. Intended for testing only.
 */
export function clearAllCaches(): void {
  etagStore.clear();
  resultCache.clear();
  depCache.clear();
  rateLimitState.remaining = 5000;
  rateLimitState.resetAt = 0;
  rateLimitState.paused = false;
  stats.hits = 0;
  stats.misses = 0;
  stats.etagHits = 0;
  stats.rateLimitEvents = 0;
  console.log('[github-cache] All caches cleared');
}

// ---------------------------------------------------------------------------
// Test helpers — not part of the public API
// ---------------------------------------------------------------------------

/** Exported for unit testing only. */
export const _testing = {
  parseGhApiIncludeResponse,
  updateRateLimitState,
  etagStore,
  resultCache,
  depCache,
  rateLimitState,
  stats,
};
