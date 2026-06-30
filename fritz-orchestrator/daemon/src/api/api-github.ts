/**
 * GitHub cache proxy API — lets orchestrator and agent containers read
 * GitHub data from the daemon's in-memory cache instead of calling GitHub
 * directly.
 *
 * All endpoints are on the internal Docker network and do not require
 * agent authentication (mirrors dashboard route pattern in api.ts).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { config } from '../config.js';
import { getCachedIssues, invalidateIssuesCache } from '../github/github-graphql.js';
import * as githubCache from '../github/github-cache.js';
import * as github from '../github/github.js';
import { execAsync } from '../agents/boot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — mirrors api.ts readBody limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

function log(message: string): void {
  console.log(`[api-github] ${message}`);
}

// ---------------------------------------------------------------------------
// Context cache — /issues/:number/context is expensive, cache with TTL
// ---------------------------------------------------------------------------

interface ContextCacheEntry {
  data: IssueContext;
  cachedAt: number;
}

interface IssueContext {
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
  linkedPRs: Array<{ number: number; title: string; state: string }>;
}

const CONTEXT_TTL_MS = 120 * 1000; // 120 seconds
const contextCache = new Map<number, ContextCacheEntry>();

// Cache stats
let cacheHits = 0;
let cacheMisses = 0;

// ---------------------------------------------------------------------------
// GET /api/github/issues
// ---------------------------------------------------------------------------

function handleIssuesList(req: IncomingMessage, res: ServerResponse): void {
  const cached = getCachedIssues();

  if (!cached) {
    cacheMisses++;
    log('issues list: cache miss (not yet populated)');
    json(res, 200, [], { 'X-Cache': 'miss' });
    return;
  }

  cacheHits++;
  const result = cached.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
  }));

  json(res, 200, result, { 'X-Cache': 'hit' });
}

// ---------------------------------------------------------------------------
// GET /api/github/issues/:number
// ---------------------------------------------------------------------------

async function handleIssueDetail(req: IncomingMessage, res: ServerResponse, issueNumber: number): Promise<void> {
  // Try GraphQL cache first for basic info (number, title, labels)
  const cached = getCachedIssues();
  const cachedIssue = cached?.find((i) => i.number === issueNumber);

  // Fetch full details (body, state) via cached GitHub API (ETag + TTL)
  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  try {
    const apiPath = `repos/${repo}/issues/${issueNumber}`;
    const raw = await githubCache.cachedGhApiAsync(apiPath, { ttl: 60_000 });

    const issueData = JSON.parse(raw) as {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: Array<{ name: string }>;
    };

    cacheHits++;
    json(res, 200, {
      number: issueData.number,
      title: cachedIssue?.title ?? issueData.title,
      labels: cachedIssue?.labels ?? issueData.labels.map((l) => l.name),
      body: issueData.body,
      state: issueData.state,
    }, { 'X-Cache': cachedIssue ? 'hit' : 'miss' });
  } catch (err: unknown) {
    // Fall back to cached data if available
    if (cachedIssue) {
      cacheHits++;
      json(res, 200, {
        number: cachedIssue.number,
        title: cachedIssue.title,
        labels: cachedIssue.labels,
        body: null,
        state: 'OPEN',
      }, { 'X-Cache': 'partial' });
    } else {
      cacheMisses++;
      log(`issue #${issueNumber}: fetch failed: ${err instanceof Error ? err.message : err}`);
      json(res, 404, { error: `Issue #${issueNumber} not found` });
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/github/issues/:number/labels
// ---------------------------------------------------------------------------

function handleIssueLabels(req: IncomingMessage, res: ServerResponse, issueNumber: number): void {
  const cached = getCachedIssues();
  const cachedIssue = cached?.find((i) => i.number === issueNumber);

  if (cachedIssue) {
    cacheHits++;
    json(res, 200, { labels: cachedIssue.labels }, { 'X-Cache': 'hit' });
    return;
  }

  // Fall back to gh CLI
  cacheMisses++;
  try {
    const labels = github.getIssueLabels(issueNumber);
    json(res, 200, { labels }, { 'X-Cache': 'miss' });
  } catch {
    json(res, 404, { error: `Issue #${issueNumber} not found` });
  }
}

// ---------------------------------------------------------------------------
// GET /api/github/issues/:number/context
// ---------------------------------------------------------------------------

async function handleIssueContext(req: IncomingMessage, res: ServerResponse, issueNumber: number): Promise<void> {
  // Check context cache first
  const entry = contextCache.get(issueNumber);
  if (entry && Date.now() - entry.cachedAt < CONTEXT_TTL_MS) {
    cacheHits++;
    json(res, 200, entry.data, { 'X-Cache': 'hit' });
    return;
  }

  cacheMisses++;

  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  if (!config.ghToken) {
    json(res, 503, { error: 'GH_TOKEN not configured' });
    return;
  }

  const ghEnv = { ...process.env, GH_TOKEN: config.ghToken };

  try {
    // Determine the target repo for PRs (may differ from orchestrator repo)
    let prRepo = repo;
    try {
      const targetInfo = github.getTargetRepoInfo(issueNumber);
      if (targetInfo) {
        prRepo = targetInfo.repo;
      }
    } catch {
      // Non-critical — fall back to orchestrator repo
    }

    // Fetch issue details and linked PRs in parallel
    const [issueJson, prsJson] = await Promise.all([
      execAsync('gh', [
        'issue', 'view', String(issueNumber),
        '--repo', repo,
        '--json', 'title,body,labels,comments',
      ], { env: ghEnv, timeout: 10000 }),
      execAsync('gh', [
        'pr', 'list',
        '--search', String(issueNumber),
        '--repo', prRepo,
        '--json', 'number,title,state',
        '--limit', '5',
      ], { env: ghEnv, timeout: 5000 }).catch(() => '[]'),
    ]);

    const issueData = JSON.parse(issueJson) as {
      title?: string;
      body?: string;
      labels?: Array<{ name: string }>;
      comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>;
    };

    // Parse comments (limit to last 10, truncate long bodies)
    const MAX_COMMENTS = 10;
    const MAX_COMMENT_LENGTH = 500;
    const allComments = issueData.comments || [];
    const recentComments = allComments.slice(-MAX_COMMENTS);
    const comments = recentComments.map((c) => ({
      author: c.author?.login || 'unknown',
      body: c.body && c.body.length > MAX_COMMENT_LENGTH
        ? c.body.slice(0, MAX_COMMENT_LENGTH) + '...'
        : c.body || '',
      createdAt: c.createdAt || '',
    }));

    // Parse linked PRs
    let linkedPRs: Array<{ number: number; title: string; state: string }> = [];
    try {
      const prsData = JSON.parse(prsJson || '[]') as Array<{ number: number; title?: string; state?: string }>;
      linkedPRs = prsData.map((pr) => ({
        number: pr.number,
        title: pr.title || '',
        state: pr.state?.toUpperCase() || 'OPEN',
      }));
    } catch {
      log(`Could not parse linked PRs for #${issueNumber} (non-critical)`);
    }

    const context: IssueContext = {
      title: issueData.title || 'Unknown',
      body: issueData.body || '',
      labels: (issueData.labels || []).map((l) => l.name),
      comments,
      linkedPRs,
    };

    // Store in context cache
    contextCache.set(issueNumber, { data: context, cachedAt: Date.now() });

    log(`context #${issueNumber}: ${comments.length} comments, ${linkedPRs.length} PRs`);
    json(res, 200, context, { 'X-Cache': 'miss' });
  } catch (err: unknown) {
    log(`context #${issueNumber}: fetch failed: ${err instanceof Error ? err.message : err}`);
    json(res, 500, { error: `Failed to fetch context for issue #${issueNumber}` });
  }
}

// ---------------------------------------------------------------------------
// GET /api/github/rate-limit
// ---------------------------------------------------------------------------

function handleRateLimit(req: IncomingMessage, res: ServerResponse): void {
  // Prefer cached rate-limit state (populated from response headers on every API call)
  let rateLimit = githubCache.getRateLimitState();

  // Only fall back to a live API call if the cached state has never been populated
  if (rateLimit.remaining === -1 || (rateLimit.remaining === 5000 && rateLimit.resetAt === 0)) {
    try {
      const raw = github.gh('api rate_limit --jq \'.rate | {remaining, reset}\'');
      const parsed = JSON.parse(raw) as { remaining: number; reset: number };
      rateLimit = {
        remaining: parsed.remaining,
        resetAt: parsed.reset,
        paused: false,
      };
    } catch {
      log('rate-limit: could not fetch from GitHub API (cached state unavailable)');
    }
  }

  const cached = getCachedIssues();
  json(res, 200, {
    rateLimit,
    cache: {
      proxy: { hits: cacheHits, misses: cacheMisses },
      ...githubCache.getCacheStats(),
      graphqlIssues: cached?.length ?? 0,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/github/invalidate — external clients signal "I changed something"
// ---------------------------------------------------------------------------

/**
 * Allows orchestrator, agents, or any client to flag the cache as dirty.
 * Call this after any GitHub mutation (label change, PR creation, comment, etc.)
 * so the daemon's cache picks up the change on the next read.
 *
 * Body: { "issue": 618 }           — invalidate specific issue
 * Body: { "issue": 618, "dep": true } — also invalidate dep cache for that issue
 * Body: {} or no body               — invalidate everything
 */
async function handleInvalidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Read error';
    const status = msg === 'Body too large' ? 413 : 400;
    json(res, status, { error: msg });
    return;
  }

  let issueNumber: number | undefined;
  let dep = false;
  try {
    if (body.trim()) {
      const parsed = JSON.parse(body);
      issueNumber = typeof parsed.issue === 'number' ? parsed.issue : undefined;
      dep = Boolean(parsed.dep);
    }
  } catch {
    // Empty or invalid body — invalidate everything
  }

  if (issueNumber) {
    contextCache.delete(issueNumber); // Clear context cache too
    githubCache.invalidate(issueNumber);
    githubCache.invalidate('all-issues');
    if (dep) githubCache.invalidate(`dep:${issueNumber}`);
    invalidateIssuesCache();
    log(`invalidate: issue #${issueNumber}${dep ? ' + dep' : ''} (external)`);
  } else {
    contextCache.clear(); // Clear all context cache
    githubCache.invalidate('all-issues');
    invalidateIssuesCache();
    log('invalidate: all (external)');
  }

  json(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/github/issues/:number/comment — agent write proxy
// ---------------------------------------------------------------------------

/**
 * Allows agent containers to post issue comments via the daemon's write queue
 * instead of calling `gh issue comment` directly (which bypasses rate limiting).
 *
 * Body: { "body": "comment text" }
 */
async function handlePostComment(req: IncomingMessage, res: ServerResponse, issueNumber: number): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Read error';
    const status = msg === 'Body too large' ? 413 : 400;
    json(res, status, { error: msg });
    return;
  }

  let commentBody: string;
  try {
    const parsed = JSON.parse(rawBody);
    commentBody = parsed.body;
    if (typeof commentBody !== 'string' || commentBody.trim().length === 0) {
      json(res, 400, { error: 'Missing or empty "body" field' });
      return;
    }
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  try {
    await github.postComment(issueNumber, commentBody);
    githubCache.invalidateIssue(issueNumber);
    log(`comment #${issueNumber}: posted via write queue`);
    json(res, 201, { ok: true });
  } catch (err: unknown) {
    log(`comment #${issueNumber}: failed: ${err instanceof Error ? err.message : err}`);
    json(res, 502, { error: `Failed to post comment: ${err instanceof Error ? err.message : err}` });
  }
}

// ---------------------------------------------------------------------------
// POST /api/github/issues/:number/labels — agent write proxy
// ---------------------------------------------------------------------------

/**
 * Allows agent containers to modify labels via the daemon's write queue.
 *
 * Body: { "add": ["label1","label2"], "remove": ["label3"] }
 * Both fields are optional; at least one must be present.
 */
async function handleModifyLabels(req: IncomingMessage, res: ServerResponse, issueNumber: number): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Read error';
    const status = msg === 'Body too large' ? 413 : 400;
    json(res, status, { error: msg });
    return;
  }

  let addLabels: string[] = [];
  let removeLabels: string[] = [];
  try {
    const parsed = JSON.parse(rawBody);
    if (Array.isArray(parsed.add)) addLabels = parsed.add.filter((l: unknown) => typeof l === 'string');
    if (Array.isArray(parsed.remove)) removeLabels = parsed.remove.filter((l: unknown) => typeof l === 'string');
    if (addLabels.length === 0 && removeLabels.length === 0) {
      json(res, 400, { error: 'At least one of "add" or "remove" must be non-empty' });
      return;
    }
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  const editArgs = ['issue', 'edit', String(issueNumber)];
  if (removeLabels.length > 0) editArgs.push('--remove-label', removeLabels.join(','));
  if (addLabels.length > 0) editArgs.push('--add-label', addLabels.join(','));
  editArgs.push('--repo', repo);

  try {
    await github.ghQueued(editArgs, 'high');
    githubCache.invalidateIssue(issueNumber);
    log(`labels #${issueNumber}: add=[${addLabels}] remove=[${removeLabels}] via write queue`);
    json(res, 200, { ok: true });
  } catch (err: unknown) {
    log(`labels #${issueNumber}: failed: ${err instanceof Error ? err.message : err}`);
    json(res, 502, { error: `Failed to modify labels: ${err instanceof Error ? err.message : err}` });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleGitHubProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method ?? '';

  // POST /api/github/invalidate — external cache invalidation
  if (method === 'POST' && path === '/api/github/invalidate') {
    await handleInvalidate(req, res);
    return;
  }

  // Routes with :number parameter (GET and POST)
  const issueMatch = path.match(/^\/api\/github\/issues\/(\d+)(\/.*)?$/);
  if (issueMatch) {
    const issueNumber = parseInt(issueMatch[1], 10);
    const subPath = issueMatch[2] || '';

    if (isNaN(issueNumber) || issueNumber <= 0) {
      json(res, 400, { error: 'Invalid issue number' });
      return;
    }

    // POST endpoints (agent write proxies)
    if (method === 'POST') {
      if (subPath === '/comment') {
        await handlePostComment(req, res, issueNumber);
        return;
      }
      if (subPath === '/labels') {
        await handleModifyLabels(req, res, issueNumber);
        return;
      }
    }

    // GET endpoints
    if (method === 'GET') {
      if (subPath === '' || subPath === '/') {
        await handleIssueDetail(req, res, issueNumber);
        return;
      }
      if (subPath === '/labels') {
        handleIssueLabels(req, res, issueNumber);
        return;
      }
      if (subPath === '/context') {
        await handleIssueContext(req, res, issueNumber);
        return;
      }
    }
  }

  if (method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/github/issues
  if (path === '/api/github/issues') {
    handleIssuesList(req, res);
    return;
  }

  // GET /api/github/rate-limit
  if (path === '/api/github/rate-limit') {
    handleRateLimit(req, res);
    return;
  }

  json(res, 404, { error: 'Not found' });
}
