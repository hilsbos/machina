/**
 * GraphQL consolidation module — replaces 14 separate `gh issue list --label`
 * calls with a SINGLE GraphQL query that fetches all open issues at once.
 *
 * Uses the GraphQL rate limit pool (separate 5000/hr from REST), effectively
 * doubling our API quota.
 *
 * Results are cached in memory with a configurable TTL (default 60s).
 * Client-side filtering replaces what `getIssuesByStatus()` previously did
 * with individual REST calls per status.
 */

import { execAsync } from '../agents/boot.js';
import {
  extractPriority,
  type PrioritizedIssue,
} from '../agents/priority-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedIssue {
  number: number;
  title: string;
  updatedAt: string;
  createdAt: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_PREFIX = 'fritz.status:';
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds

// ---------------------------------------------------------------------------
// GraphQL query (with pagination support)
// ---------------------------------------------------------------------------

const ISSUES_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: [OPEN], first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        updatedAt
        createdAt
        labels(first: 50) {
          nodes { name }
        }
      }
    }
  }
}
`.trim();

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let cachedIssues: CachedIssue[] | null = null;
let cachedAt = 0;
let cacheTtlMs = DEFAULT_TTL_MS;

/** In-flight deduplication — prevents thundering herd when multiple callers trigger concurrent fetches */
let inFlightFetch: Promise<CachedIssue[]> | null = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[github-graphql] ${message}`);
}

// ---------------------------------------------------------------------------
// Core: fetch all open issues via GraphQL
// ---------------------------------------------------------------------------

/**
 * Fetch all open issues from the repository via a single GraphQL query.
 * Returns cached result if the cache is still valid (within TTL).
 *
 * Handles cursor-based pagination if the repo has >100 open issues.
 * Uses in-flight deduplication to prevent thundering herd.
 */
export async function fetchAllOpenIssues(owner: string, name: string): Promise<CachedIssue[]> {
  // Return cached if fresh
  if (cachedIssues !== null && Date.now() - cachedAt < cacheTtlMs) {
    return cachedIssues;
  }

  // If another caller is already fetching, wait for that result
  if (inFlightFetch) return inFlightFetch;

  // Start fetch and track the in-flight promise
  inFlightFetch = doFetch(owner, name).finally(() => { inFlightFetch = null; });
  return inFlightFetch;
}

/**
 * Force a fresh fetch of all open issues, bypassing the TTL cache.
 * Use at critical moments (agent boot, agent completion) to ensure
 * the autoloop has the latest state before making decisions.
 *
 * If a fetch is already in-flight, waits for that instead of starting a duplicate.
 */
export async function refreshIssuesCache(owner: string, name: string): Promise<CachedIssue[]> {
  // If already fetching, piggyback on that
  if (inFlightFetch) return inFlightFetch;

  // Force re-fetch regardless of TTL
  inFlightFetch = doFetch(owner, name).finally(() => { inFlightFetch = null; });
  return inFlightFetch;
}

/**
 * Internal: perform the actual GraphQL fetch with pagination.
 */
async function doFetch(owner: string, name: string): Promise<CachedIssue[]> {
  try {
    const allIssues: CachedIssue[] = [];
    let cursor: string | null = null;
    let page = 1;

    do {
      const args = [
        'api', 'graphql',
        '-f', `query=${ISSUES_QUERY}`,
        '-f', `owner=${owner}`,
        '-f', `name=${name}`,
      ];

      if (cursor) {
        args.push('-f', `cursor=${cursor}`);
      }

      const raw = await execAsync('gh', args, { timeout: 15000 });
      const response = JSON.parse(raw);

      // Check for GraphQL-level errors
      if (response.errors) {
        const messages = response.errors.map((e: { message: string }) => e.message).join('; ');
        throw new Error(`GraphQL errors: ${messages}`);
      }

      const issuesData = response.data?.repository?.issues;
      if (!issuesData) {
        throw new Error('Unexpected response shape: missing repository.issues');
      }

      const nodes: Array<{
        number: number;
        title: string;
        updatedAt: string;
        createdAt: string;
        labels: { nodes: Array<{ name: string }> };
      }> = issuesData.nodes || [];

      for (const node of nodes) {
        allIssues.push({
          number: node.number,
          title: node.title,
          updatedAt: node.updatedAt,
          createdAt: node.createdAt,
          labels: node.labels.nodes.map((l) => l.name),
        });
      }

      const pageInfo = issuesData.pageInfo;
      if (pageInfo?.hasNextPage && pageInfo.endCursor) {
        cursor = pageInfo.endCursor;
        page++;
        log(`Fetching page ${page}...`);
      } else {
        cursor = null;
      }
    } while (cursor);

    // Update cache
    cachedIssues = allIssues;
    cachedAt = Date.now();

    log(`Fetched ${allIssues.length} open issue(s) via GraphQL${page > 1 ? ` (${page} pages)` : ''}`);
    return allIssues;
  } catch (error: unknown) {
    log(`Failed to fetch issues via GraphQL: ${error instanceof Error ? error.message : error}`);
    if (cachedIssues !== null) {
      log('Returning stale cached data');
      return cachedIssues;
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cache accessors
// ---------------------------------------------------------------------------

/**
 * Returns the cached issues without fetching.
 * Returns null if the cache has not been populated yet.
 * Intended for dashboard/watchdog consumers that should not trigger fetches.
 */
export function getCachedIssues(): CachedIssue[] | null {
  return cachedIssues;
}

/**
 * Clear the in-memory cache. Call this after mutations (label changes,
 * issue transitions) so the next fetch gets fresh data.
 */
export function invalidateIssuesCache(): void {
  cachedIssues = null;
  cachedAt = 0;
}

/**
 * Override the cache TTL (mainly for testing).
 */
export function setCacheTtl(ms: number): void {
  cacheTtlMs = ms;
}

// ---------------------------------------------------------------------------
// Client-side filtering
// ---------------------------------------------------------------------------

/**
 * Filter cached issues by fritz.status label and return PrioritizedIssue[].
 *
 * Replaces per-status `gh issue list --label fritz.status:X` calls with
 * client-side filtering of the single GraphQL result.
 *
 * @param issues   - The full list of cached open issues
 * @param status   - The status to filter for (e.g., 'for-define', 'validated')
 * @param extraLabels - Optional additional labels that must ALL be present
 *                      (e.g., ['fritz.auto-pipeline'] for defined/validated)
 */
export function filterByStatus(
  issues: CachedIssue[],
  status: string,
  extraLabels?: string[]
): PrioritizedIssue[] {
  const statusLabel = `${STATUS_PREFIX}${status}`;

  return issues
    .filter((issue) => {
      // Must have the target status label
      if (!issue.labels.includes(statusLabel)) return false;

      // Must have all extra labels (if specified)
      if (extraLabels) {
        for (const extra of extraLabels) {
          if (!issue.labels.includes(extra)) return false;
        }
      }

      return true;
    })
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      // extractPriority expects Array<{ name: string }> — convert flat labels
      priority: extractPriority(issue.labels.map((name) => ({ name }))),
    }));
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Get issues with the fritz.status:active label.
 * Used by the watchdog to monitor active agents.
 */
export function getActiveFromCache(issues: CachedIssue[]): CachedIssue[] {
  return issues.filter((issue) =>
    issue.labels.includes(`${STATUS_PREFIX}active`)
  );
}

/**
 * Get all issues that have any fritz.status: label.
 * Used by the dashboard to show the full pipeline view.
 */
export function getStatusIssues(issues: CachedIssue[]): CachedIssue[] {
  return issues.filter((issue) =>
    issue.labels.some((label) => label.startsWith(STATUS_PREFIX))
  );
}
