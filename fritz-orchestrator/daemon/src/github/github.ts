import { execSync } from 'child_process';
import { config } from '../config.js';
import * as lifecycle from '../core/lifecycle.js';
import { logEvent } from '../core/event-log.js';
import { execAsync } from '../agents/boot.js';
import type { AgentRole, InvocationMode } from '../types.js';
import { getCommentLevel, type GitHubCommentLevel } from '../agents/fritz-config.js';
import * as githubCache from './github-cache.js';
import { getCachedIssues } from './github-graphql.js';
import * as githubWriteQueue from './github-write-queue.js';
import type { WritePriority } from './github-write-queue.js';

// GitHub comment types for gating decisions
export type GitHubCommentType =
  | 'agent-started'
  | 'agent-finished'
  | 'progress'
  | 'complete'
  | 'blocked'
  | 'auto-pipeline-transition'
  | 'auto-pipeline-merge'
  | 'rework-escalation'
  | 'dependency-cycle'
  | 'skill-summary'
  | 'conflict';

// Comments that are always posted regardless of comment level
const ALWAYS_POST: Set<GitHubCommentType> = new Set([
  'blocked',
  'rework-escalation',
  'dependency-cycle',
  'skill-summary',
  'conflict',
]);

// Comments posted in quiet mode (in addition to always-post)
const QUIET_POST: Set<GitHubCommentType> = new Set([
  'agent-started',
  'agent-finished',
]);

/**
 * Determine whether a comment should be posted based on the current comment level.
 *
 * | Comment Type              | essential | quiet | verbose |
 * |---------------------------|-----------|-------|---------|
 * | blocked                   | post      | post  | post    |
 * | rework-escalation         | post      | post  | post    |
 * | dependency-cycle           | post      | post  | post    |
 * | skill-summary             | post      | post  | post    |
 * | conflict                  | post      | post  | post    |
 * | agent-started             | skip      | post  | post    |
 * | agent-finished            | skip      | post  | post    |
 * | progress                  | skip      | skip  | post    |
 * | complete                  | skip      | skip  | post    |
 * | auto-pipeline-transition  | skip      | skip  | post    |
 * | auto-pipeline-merge       | skip      | skip  | post    |
 */
export function shouldPostComment(commentType: GitHubCommentType): boolean {
  const level: GitHubCommentLevel = getCommentLevel();

  if (level === 'verbose') return true;
  if (ALWAYS_POST.has(commentType)) return true;
  if (level === 'quiet' && QUIET_POST.has(commentType)) return true;

  return false;
}

// Track lifecycle comment IDs for edit-in-place in quiet mode
// Key: agentName, Value: GitHub comment ID
// Note: No watchdog prune path — entries are cleaned up in releaseAgent() and cleanupLifecycleComment().
// If an agent exits without going through releaseAgent(), entries will accumulate (bounded by max parallel agents).
const lifecycleCommentIds = new Map<string, number>();

// Track lifecycle start context for edit-in-place combined comments
interface LifecycleStartContext {
  startedAt: Date;
  ttlMinutes: number;
  model?: string;
}
const lifecycleStartContexts = new Map<string, LifecycleStartContext>();

/**
 * Post or edit a lifecycle comment (agent-started/agent-finished) using GitHub API.
 * In quiet mode, started and finished are combined into a single edited comment.
 */
async function postLifecycleComment(issue: number, agentName: string, body: string, type: 'agent-started' | 'agent-finished'): Promise<void> {
  const repo = getRepo();
  const level = getCommentLevel();

  if (level === 'quiet' && type === 'agent-finished') {
    // Try to edit the started comment
    const commentId = lifecycleCommentIds.get(agentName);
    if (commentId) {
      try {
        await editComment(repo, commentId, body);
        lifecycleCommentIds.delete(agentName);
        return;
      } catch (err) {
        console.warn(`[github] Failed to edit lifecycle comment ${commentId} for ${agentName}, posting new comment:`, err instanceof Error ? err.message : err);
        lifecycleCommentIds.delete(agentName);
      }
    }
  }

  // Post a new comment (and track the ID in quiet mode for agent-started)
  if (level === 'quiet' && type === 'agent-started') {
    try {
      const commentId = await postCommentAndGetId(issue, body);
      if (commentId) {
        lifecycleCommentIds.set(agentName, commentId);
      }
      return;
    } catch (err) {
      console.error(`[github] Failed to post lifecycle comment for ${agentName}:`, err);
      return;
    }
  }

  // Default: post normally via write queue
  await ghQueued(['issue', 'comment', String(issue), '--body', body, '--repo', repo], 'normal');
}

/**
 * Post a comment and return the comment ID (using gh api for JSON response).
 */
async function postCommentAndGetId(issue: number, body: string): Promise<number | null> {
  const repo = getRepo();
  try {
    const result = await ghQueued(['api', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`], 'normal');
    const parsed = JSON.parse(result);
    return parsed.id ?? null;
  } catch {
    // Fallback: post without tracking
    await ghQueued(['issue', 'comment', String(issue), '--body', body, '--repo', repo], 'normal');
    return null;
  }
}

/**
 * Edit an existing GitHub comment by ID.
 */
async function editComment(repo: string, commentId: number, body: string): Promise<void> {
  await ghQueued(['api', `repos/${repo}/issues/comments/${commentId}`, '-X', 'PATCH', '-f', `body=${body}`], 'normal');
}

/**
 * Clean up lifecycle comment tracking for a released agent.
 */
export function cleanupLifecycleComment(agentName: string): void {
  lifecycleCommentIds.delete(agentName);
  lifecycleStartContexts.delete(agentName);
}

/** @internal Test-only: expose postLifecycleComment for integration tests. */
export const _testLifecycle = {
  postLifecycleComment: (issue: number, agentName: string, body: string, type: 'agent-started' | 'agent-finished') =>
    postLifecycleComment(issue, agentName, body, type),
  lifecycleCommentIds,
  lifecycleStartContexts,
};

function formatTimestamp(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = months[date.getUTCMonth()];
  return `${date.getUTCDate()} ${d} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// Label prefixes
const ROLE_PREFIX = 'fritz.skill:';
const STATUS_PREFIX = 'fritz.status:';
const REWORK_PREFIX = 'fritz.rework:';
export const MAX_REWORK_CYCLES = 3;

// Retry delays for secondary rate limit (429 / "submitted too quickly") errors.
// Exported for testing.
export const RATE_LIMIT_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/** Check if an error is a GitHub secondary rate limit (429 / "submitted too quickly"). */
export function isSecondaryRateLimit(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /secondary rate limit/i.test(msg)
    || /submitted too quickly/i.test(msg)
    || /abuse detection/i.test(msg)
    || /\b429\b/.test(msg);
}

/** Synchronous sleep — blocks the process (including HTTP server) for the specified duration.
 *  Acceptable because gh() already blocks via execSync; async would require gh() to become async
 *  (larger refactor). Side effect: daemon HTTP API is unresponsive during retry backoff
 *  (up to 100s total under sustained rate limiting: 10s + 30s + 60s). */
function defaultSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Overridable sleep for testing. Use `_setRetrySleep` to replace in tests. */
let retrySleep: (ms: number) => void = defaultSleepSync;

/** @internal Test-only: replace the sleep function used during retries. */
export function _setRetrySleep(fn: (ms: number) => void): void {
  retrySleep = fn;
}

/**
 * Execute a GitHub CLI command synchronously with retry on rate limits.
 * Default timeout of 30s prevents indefinite event-loop blocks when the
 * GitHub API is slow or rate-limited. Callers can override via timeoutMs.
 */
export function gh(args: string, timeoutMs = 30_000): string {
  const maxAttempts = RATE_LIMIT_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execSync(`gh ${args}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      }).trim();
    } catch (error: unknown) {
      if (attempt < maxAttempts && isSecondaryRateLimit(error)) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt - 1];
        console.warn(`[github] gh ${args} hit secondary rate limit (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s...`);
        retrySleep(delay);
        continue;
      }
      console.error(`[github] gh ${args} failed:`, error instanceof Error ? error.message : error);
      throw error;
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error('gh: max retries exceeded');
}

/**
 * Enqueue a GitHub write operation through the rate-limited write queue.
 * All mutation operations (label changes, comments, PR merges) should use this
 * instead of calling `gh()` directly to prevent secondary rate limit errors.
 *
 * @param args - The `gh` CLI arguments as an array (avoids shell injection)
 * @param priority - 'high' for label transitions, 'normal' for comments, 'low' for best-effort
 */
export async function ghQueued(args: string[], priority: WritePriority = 'normal'): Promise<string> {
  return githubWriteQueue.enqueue(args, priority);
}

function getRepo(): string {
  if (!config.githubRepo) {
    throw new Error('GITHUB_REPO not configured');
  }
  return config.githubRepo;
}

// Fetch issue title from GitHub
export function getIssueTitle(issue: number): string | null {
  const repo = getRepo();
  try {
    const result = gh(`issue view ${issue} --json title --jq '.title' --repo ${repo}`);
    return result || null;
  } catch {
    return null;
  }
}

// Cache for bootable issues to avoid repeated GitHub API calls
let issueCache: { issues: Array<{ number: number; title: string }>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch issues that are ready for agent boot (for-define, for-implement, or unlabeled)
export async function getBootableIssues(limit: number = 5): Promise<Array<{ number: number; title: string }>> {
  const repo = getRepo();

  // Return cached if fresh
  if (issueCache && Date.now() - issueCache.fetchedAt < CACHE_TTL_MS) {
    return issueCache.issues.slice(0, limit);
  }

  try {
    // Fetch all three queries in parallel (independent read-only calls)
    const [defineResult, implementResult, unlabeled] = await Promise.all([
      execAsync('gh', [
        'issue', 'list', '--label', 'fritz.status:for-define',
        '--state', 'open', '--json', 'number,title', '--limit', String(limit), '--repo', repo,
      ]).catch(() => '[]'),
      execAsync('gh', [
        'issue', 'list', '--label', 'fritz.status:for-implement',
        '--state', 'open', '--json', 'number,title', '--limit', String(limit), '--repo', repo,
      ]).catch(() => '[]'),
      execAsync('gh', [
        'issue', 'list', '--state', 'open',
        '--json', 'number,title,labels', '--limit', '20', '--repo', repo,
      ]).catch(() => '[]'),
    ]);

    const defineIssues: Array<{ number: number; title: string }> = JSON.parse(defineResult || '[]');
    const implementIssues: Array<{ number: number; title: string }> = JSON.parse(implementResult || '[]');
    const allIssues: Array<{ number: number; title: string; labels: Array<{ name: string }> }> = JSON.parse(unlabeled || '[]');

    // Filter to issues without any fritz.status label
    const newIssues = allIssues.filter(
      i => !i.labels.some(l => l.name.startsWith('fritz.status:'))
    );

    // Combine and deduplicate, for-define/for-implement issues first
    const seen = new Set<number>();
    const combined: Array<{ number: number; title: string }> = [];

    for (const issue of [...defineIssues, ...implementIssues, ...newIssues]) {
      if (!seen.has(issue.number)) {
        seen.add(issue.number);
        combined.push({ number: issue.number, title: issue.title });
      }
    }

    const resultIssues = combined.slice(0, limit);
    issueCache = { issues: resultIssues, fetchedAt: Date.now() };
    return resultIssues;
  } catch {
    return [];
  }
}

// Ensure labels exist in the repo
export async function ensureLabels(): Promise<void> {
  const repo = getRepo();

  const labels = [
    // Role labels (used while agent is active, removed when agent finishes)
    // Colors match their corresponding for-{role} status labels
    { name: `${ROLE_PREFIX}define`, color: 'C5DEF5', description: 'Define agent' },
    { name: `${ROLE_PREFIX}implement`, color: 'A2D2FF', description: 'Implement agent' },
    { name: `${ROLE_PREFIX}architect`, color: 'FFDAB9', description: 'Architect agent' },
    { name: `${ROLE_PREFIX}ux`, color: 'FFD6E0', description: 'UX agent' },
    { name: `${ROLE_PREFIX}budget`, color: 'FEF3C0', description: 'Budget agent' },
    { name: `${ROLE_PREFIX}review`, color: '74B9FF', description: 'Review agent' },
    { name: `${ROLE_PREFIX}validate`, color: '5A9BF2', description: 'Validate agent' },
    { name: `${ROLE_PREFIX}retro`, color: '6F42C1', description: 'Retro agent' },
    { name: `${ROLE_PREFIX}security-review`, color: '274E68', description: 'Security review agent' },
    { name: `${ROLE_PREFIX}pentest`, color: '9B111E', description: 'Pentest agent' },
    // Status labels using for-{role} pattern
    // Workflow: inbox → for-define → for-implement → for-review → for-validate → validated → human merges
    // Rework loop: for-rework → active → for-review (cycle tracked via fritz.rework:N labels)
    { name: `${STATUS_PREFIX}inbox`, color: 'E1E4E8', description: 'New issue, needs triage' },
    { name: `${STATUS_PREFIX}backlog`, color: 'F1F1F1', description: 'Deprioritized' },
    { name: `${STATUS_PREFIX}for-define`, color: 'C5DEF5', description: 'Waiting for define agent' },
    { name: `${STATUS_PREFIX}defined`, color: '2EA44F', description: 'Spec complete, awaiting human review' },
    { name: `${STATUS_PREFIX}for-implement`, color: 'A2D2FF', description: 'Waiting for implement agent' },
    { name: `${STATUS_PREFIX}for-architect`, color: 'FFDAB9', description: 'Waiting for architect agent' },
    { name: `${STATUS_PREFIX}for-ux`, color: 'FFD6E0', description: 'Waiting for UX agent' },
    { name: `${STATUS_PREFIX}for-budget`, color: 'FEF3C0', description: 'Waiting for budget agent' },
    { name: `${STATUS_PREFIX}for-review`, color: '74B9FF', description: 'Waiting for review agent' },
    { name: `${STATUS_PREFIX}for-validate`, color: '5A9BF2', description: 'Waiting for validate agent' },
    { name: `${STATUS_PREFIX}for-security-review`, color: '274E68', description: 'Waiting for security review agent' },
    { name: `${STATUS_PREFIX}for-pentest`, color: '9B111E', description: 'Waiting for pentest agent' },
    { name: `${STATUS_PREFIX}for-rework`, color: 'FFC107', description: 'Changes requested, waiting for implement rework' },
    { name: `${STATUS_PREFIX}for-human`, color: 'D93F0B', description: 'Human must look' },
    { name: `${STATUS_PREFIX}active`, color: '0366D6', description: 'Agent is working' },
    { name: `${STATUS_PREFIX}discussion`, color: '6F42C1', description: 'Multi-agent discussion in progress' },
    { name: `${STATUS_PREFIX}validated`, color: '17A2B8', description: 'Ready for human merge' },
    { name: `${STATUS_PREFIX}for-merge`, color: '28A745', description: 'Approved — autoloop merges PR with CI checks' },
    // Rework cycle tracking labels
    { name: `${REWORK_PREFIX}1`, color: 'D4C5F9', description: 'Rework cycle 1' },
    { name: `${REWORK_PREFIX}2`, color: 'D4C5F9', description: 'Rework cycle 2' },
    { name: `${REWORK_PREFIX}3`, color: 'D4C5F9', description: 'Rework cycle 3' },
    // Long-running label (disables TTL for extended tasks)
    { name: 'fritz.long-running', color: '5319E7', description: 'Long-running task — TTL disabled' },
    // Paused label (manually pause an issue in the pipeline)
    { name: 'fritz.paused', color: 'D29922', description: 'Issue is manually paused in the pipeline' },
    // Auto-pipeline label (enables automatic defined→for-implement and validated→merge)
    { name: 'fritz.auto-pipeline', color: '6F42C1', description: 'Auto-pipeline — skip human gates for define→implement and validate→merge' },
    // Language labels (for agent image selection)
    { name: 'fritz.lang:java', color: 'E76F00', description: 'Java project — uses fritz-agent-java image' },
    { name: 'fritz.lang:cpp', color: '00599C', description: 'C/C++ project — uses fritz-agent-cpp image' },
    { name: 'fritz.lang:kali', color: '557C94', description: 'Kali Linux project — uses fritz-agent-kali image' },
    { name: 'fritz.lang:rust', color: 'DEA584', description: 'Rust project — uses fritz-agent-rust image' },
    // Type labels (issue classification — used by issue templates)
    { name: 'type:feature', color: 'A2EEEF', description: 'New feature' },
    { name: 'type:bug', color: 'D73A4A', description: 'Bug fix' },
    { name: 'type:refactor', color: 'F9D0C4', description: 'Refactoring' },
    // Priority labels
    { name: 'priority:p0', color: 'B60205', description: 'Critical — drop everything' },
    { name: 'priority:p1', color: 'D93F0B', description: 'High — current sprint' },
    { name: 'priority:p2', color: 'FBCA04', description: 'Medium — next sprint' },
    { name: 'priority:p3', color: '0E8A16', description: 'Low — backlog' },
  ];

  // Create all labels in parallel (each is independent, idempotent with --force)
  await Promise.allSettled(
    labels.map((label) =>
      execAsync('gh', [
        'label', 'create', label.name,
        '--color', label.color,
        '--description', label.description,
        '--repo', repo,
        '--force',
      ]).catch(() => {
        // Label might already exist, that's fine
      })
    )
  );
}

// Assign an agent to an issue
// Phase 1 optimization: combines label remove+add into a single gh CLI call (≤2 API calls total)
export async function assignAgent(
  issue: number,
  role: AgentRole,
  agentName: string,
  ttlMinutes: number,
  model?: string,
): Promise<void> {
  const repo = getRepo();
  const roleLabel = `${ROLE_PREFIX}${role}`;
  const statusLabel = `${STATUS_PREFIX}active`;

  // Build a single gh issue edit command with both --remove-label and --add-label.
  // The gh CLI supports both flags in one call, reducing 2-3 API calls to 1.
  const editArgs = ['issue', 'edit', String(issue)];

  // Remove any existing status labels (e.g., for-implement, inbox, backlog)
  // Uses GraphQL cache for label reads (cache-first, API fallback on miss)
  try {
    const currentLabels = getIssueLabels(issue);
    const oldStatusLabels = currentLabels.filter(l => l.startsWith(STATUS_PREFIX));
    if (oldStatusLabels.length > 0) {
      editArgs.push('--remove-label', oldStatusLabels.join(','));
    }
  } catch {
    // Labels might not exist — proceed with add-only
  }

  editArgs.push('--add-label', `${roleLabel},${statusLabel}`, '--repo', repo);
  await ghQueued(editArgs, 'high');

  // Post "Agent Started" comment (API call #2, gated by comment level)
  if (shouldPostComment('agent-started')) {
    const modelLine = model ? `\n**Model:** \`${model}\`` : '';
    const ttlDisplay = ttlMinutes === 0
      ? '♾️ unlimited (long-running)'
      : `${ttlMinutes} min`;
    const comment = `🤖 **fritZ · Agent Started**

**Agent:** \`${agentName}\`
**Role:** \`${role}\`${modelLine}
**TTL:** ${ttlDisplay}
**Started:** ${formatTimestamp(new Date())}

---
Working on this issue…`;

    await postLifecycleComment(issue, agentName, comment, 'agent-started');
  } else {
    console.log(`[github] Skipping agent-started comment for #${issue} (commentLevel: ${getCommentLevel()})`);
  }

  // Store start context for edit-in-place combined comments (only needed in quiet mode)
  if (getCommentLevel() === 'quiet') {
    lifecycleStartContexts.set(agentName, { startedAt: new Date(), ttlMinutes, model });
  }

  // Smart invalidation: labels+comment changed on single issue
  githubCache.invalidateIssue(issue);
}

// Claim an issue for an agent (check + assign atomically).
// Returns previous status for rollback, or null if already claimed.
export async function claimIssue(
  issue: number,
  role: AgentRole,
  agentName: string,
  ttlMinutes: number,
  model?: string,
): Promise<{ previousStatus?: string } | null> {
  const repo = getRepo();

  let previousStatus: string | undefined;
  try {
    // Uses GraphQL cache for label reads (cache-first, API fallback on miss)
    const labelList = getIssueLabels(issue);

    // Already has an active agent?
    if (labelList.some(l => l === `${STATUS_PREFIX}active` || l === `${STATUS_PREFIX}blocked`)) {
      return null;
    }

    // Record previous status for rollback
    const prevLabel = labelList.find(l => l.startsWith(STATUS_PREFIX));
    previousStatus = prevLabel?.replace(STATUS_PREFIX, '');

    // Claim: assign agent to issue (sets working label, posts comment)
    await assignAgent(issue, role, agentName, ttlMinutes, model);

    return { previousStatus };
  } catch (error) {
    // assignAgent may have removed old labels before failing — restore previous status
    if (previousStatus) {
      console.error(`[github] claimIssue failed for #${issue}, restoring ${previousStatus}:`, error instanceof Error ? error.message : error);
      try {
        await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}${previousStatus}`, '--repo', repo], 'high');
      } catch { /* best effort rollback */ }
    }
    return null;
  }
}

// Roll back a claim when agent boot fails
export async function unclaimIssue(
  issue: number,
  previousStatus?: string,
  options?: { errorMessage?: string; forceStatus?: string }
): Promise<void> {
  const repo = getRepo();
  const restoreStatus = options?.forceStatus || previousStatus;

  // Remove active + role labels added by claimIssue
  // Uses GraphQL cache for label reads (cache-first, API fallback on miss)
  try {
    const labels = getIssueLabels(issue);
    const toRemove = labels.filter(l =>
      l === `${STATUS_PREFIX}active` || l.startsWith(ROLE_PREFIX)
    );
    if (toRemove.length > 0) {
      await ghQueued(['issue', 'edit', String(issue), '--remove-label', toRemove.join(','), '--repo', repo], 'high');
    }
  } catch {
    // Best effort
  }

  // Restore status (forced or previous)
  if (restoreStatus) {
    try {
      await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}${restoreStatus}`, '--repo', repo], 'high');
    } catch {
      // Best effort
    }
  }

  // Post failure comment with error details
  const statusNote = restoreStatus ? `Issue set to \`${restoreStatus}\`.` : '';
  const errorNote = options?.errorMessage ? `\n\n**Error:** ${options.errorMessage}` : '';
  const comment = `\u26a0\ufe0f **fritZ \u00b7 Agent Failed to Start**\n\n${statusNote}${errorNote}`;
  try {
    await ghQueued(['issue', 'comment', String(issue), '--body', comment, '--repo', repo], 'normal');
  } catch {
    // Best effort
  }

  // Smart invalidation: labels changed on single issue
  githubCache.invalidateIssue(issue);
}

// Determine next status based on role that just finished
function getNextStatus(
  role: AgentRole,
  success: boolean,
  outcome?: string,
  invocationMode?: InvocationMode
): string {
  if (!success) {
    return 'for-human'; // Agent crashed → human must look
  }

  // Check for rejection by review/validate
  if (outcome === 'rejected') {
    switch (role) {
      case 'review':
      case 'validate':
        return 'for-rework';  // Route back to implement
      default:
        return 'for-human'; // Other roles rejecting is unexpected
    }
  }

  // Normal success path using for-{role} pattern
  switch (role) {
    case 'define':
      return 'defined';           // Ready for human review of spec
    case 'implement':
      return 'for-review';        // Ready for review agent
    case 'review':
      return 'for-validate';      // Ready for validate agent
    case 'validate':
      return 'validated';         // Ready for human approval
    case 'security-review':
    case 'pentest':
      return 'for-human';         // Security/pentest report posted → human reviews findings
    case 'architect':
    case 'ux':
    case 'budget':
      // Sub-skills route based on invocation mode:
      // - 'standalone' (via /boot): Skip define synthesis, go directly to 'defined'
      // - 'orchestrated' (via /define): Return to define for synthesis
      // Default to 'orchestrated' for backwards compatibility
      if (invocationMode === 'standalone') {
        return 'defined';         // Standalone sub-skill → ready for human review
      }
      return 'for-define';        // Orchestrated sub-skill → define synthesizes
    default:
      return 'for-human';         // Other roles → human decides next
  }
}

/**
 * Map an agent role to the pipeline status it should be restored to on orphan cleanup.
 *
 * When `hadActivity` is true (default), the agent was actively working — restore to the
 * status that re-queues the same pipeline stage (e.g. implement → for-rework).
 *
 * When `hadActivity` is false, the agent died with 0 turns — no work was done, so
 * restore to the pre-agent queue status that would re-trigger the same agent type
 * (e.g. implement → for-implement instead of for-rework).
 */
export function getOrphanRestoreStatus(role: string, hadActivity = true): string {
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
    case 'retro':           return 'for-human'; // No for-retro pipeline status — retro has no re-entry point
    default:                return 'for-human'; // Unknown role — escalate
  }
}

// Track released agents to prevent duplicate "Agent Finished" comments.
// Key format: "agentName:issue" — once released, subsequent calls are no-ops.
// Value: timestamp when released (for periodic pruning to prevent unbounded growth).
const releasedAgents = new Map<string, number>();

// Prune entries older than this (1 hour). Agents rarely run more than 4 hours,
// so 1 hour after release there's no risk of duplicate calls for the same agent.
const RELEASE_CACHE_TTL_MS = 60 * 60 * 1000;

// Prune old entries from releasedAgents to prevent unbounded memory growth.
// Called periodically by watchdog.
export function pruneReleasedAgents(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [key, timestamp] of releasedAgents) {
    if (now - timestamp > RELEASE_CACHE_TTL_MS) {
      releasedAgents.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[github] Pruned ${pruned} stale entries from releasedAgents cache`);
  }
  return pruned;
}

// Release agent from issue (update status to reflect completion)
export async function releaseAgent(
  issue: number,
  agentName: string,
  role: AgentRole,
  finalStatus: 'completed' | 'dead' | 'timeout',
  outcome?: string,
  invocationMode?: InvocationMode,
  teammateCount?: number
): Promise<void> {
  const releaseKey = `${agentName}:${issue}`;
  if (releasedAgents.has(releaseKey)) {
    console.log(`[github] releaseAgent skipped for ${agentName} on #${issue} — already released`);
    return;
  }
  releasedAgents.set(releaseKey, Date.now());

  const repo = getRepo();

  // Phase 1 optimization: compute labels to remove and the new status label,
  // then combine both into a single gh issue edit call (≤2 API calls total).
  const currentLabels = getIssueLabels(issue);

  // Build labels to remove: active + skill + blocked (if present)
  const labelsToRemove = [`${STATUS_PREFIX}active`, `${ROLE_PREFIX}${role}`];
  if (currentLabels.includes(`${STATUS_PREFIX}blocked`)) {
    labelsToRemove.push(`${STATUS_PREFIX}blocked`);
  }

  // Determine new status label based on role and outcome
  const success = finalStatus === 'completed';
  const nextStatus = getNextStatus(role, success, outcome, invocationMode);
  let effectiveNextStatus = nextStatus;

  // Handle rework cycle tracking and safety valve
  if (nextStatus === 'for-rework') {
    const cycleCount = await incrementReworkCycle(issue);
    if (cycleCount > MAX_REWORK_CYCLES) {
      // Safety valve: escalate to human instead of reworking further
      effectiveNextStatus = 'for-human';
      if (shouldPostComment('rework-escalation')) {
        const escalationComment = `⚠️ **Rework limit reached** (${MAX_REWORK_CYCLES} cycles). Escalating to human.\n\nThe review/validate → implement loop has run ${cycleCount} times without resolution.`;
        try {
          await ghQueued(['issue', 'comment', String(issue), '--body', escalationComment, '--repo', repo], 'normal');
        } catch {
          // Best effort
        }
      }
      logEvent('issue.attention', `#${issue} stuck in rework loop (${cycleCount} cycles)`, { issue, reason: 'rework-loop', cycles: cycleCount });
      await lifecycle.system(`⚠️ *#${issue}* stuck in rework loop (${cycleCount} cycles). Needs human attention.`);
    }
  }

  // Safety net: verify PR exists before transitioning implement → for-review.
  // If the agent reported success but no PR was created (or gh pr create failed silently),
  // escalate to human instead of sending a non-existent PR to the review agent.
  let prVerificationFailed = false;
  if (effectiveNextStatus === 'for-review' && role === 'implement') {
    // Resolve target repo for cross-repo issues (fritz.repo: label may point to a different repo)
    const targetRepoInfo = getTargetRepoInfo(issue);
    const prRepo = targetRepoInfo?.repo ?? repo;

    let linkedPR: { number: number; headRefName: string } | null | undefined;
    try {
      linkedPR = findIssuePR(issue, prRepo);
    } catch {
      // API failure — skip safety net, cannot verify; log and continue
      console.warn(`[github] PR verification skipped for #${issue} — findIssuePR threw`);
      linkedPR = undefined;
    }
    if (linkedPR === null) {
      // Confirmed: no PR found → escalate
      effectiveNextStatus = 'for-human';
      prVerificationFailed = true;
      const warningComment = `⚠️ **PR verification failed** — implement agent reported success but no open PR found for issue #${issue}.\n\nEscalating to human. The agent may have failed to create a PR or push its branch.`;
      try {
        gh(`issue comment ${issue} --body "${warningComment.replace(/"/g, '\\"').replace(/\`/g, '\\`')}" --repo ${repo}`);
      } catch {
        // Best effort
      }
      console.error(`[github] PR verification failed for #${issue} — no open PR found, escalating to human`);
      logEvent('issue.attention', `#${issue} implement completed but no PR found`, { issue, reason: 'no-pr' });
      await lifecycle.system(`⚠️ *#${issue}* implement agent completed but no PR found. Needs human attention.`);
    }
  }

  // Reset rework count when pipeline succeeds (validated) or needs human attention
  if (effectiveNextStatus === 'validated') {
    await resetReworkCycle(issue);
  }

  const newStatusLabel = `${STATUS_PREFIX}${effectiveNextStatus}`;

  // Single combined gh issue edit: remove old labels + add new status label (API call #1)
  try {
    await ghQueued([
      'issue', 'edit', String(issue),
      '--remove-label', labelsToRemove.join(','),
      '--add-label', newStatusLabel,
      '--repo', repo,
    ], 'high');
  } catch (firstError) {
    // Batch failed — fall back to separate calls (critical: issue must have correct labels)
    console.error(`[github] Combined label edit failed for #${issue}, retrying separately:`, firstError instanceof Error ? firstError.message : firstError);
    // Best-effort removal of stale labels (don't block on failure)
    try {
      await ghQueued(['issue', 'edit', String(issue), '--remove-label', labelsToRemove.join(','), '--repo', repo], 'high');
    } catch (removeError) {
      console.warn(`[github] Failed to remove stale labels from #${issue} (best-effort):`, removeError instanceof Error ? removeError.message : removeError);
    }
    // Critical: add the new status label so the issue is not stuck without status
    try {
      await ghQueued(['issue', 'edit', String(issue), '--add-label', newStatusLabel, '--repo', repo], 'high');
    } catch (retryError) {
      console.error(`[github] CRITICAL: Failed to add ${newStatusLabel} to #${issue} after retry — issue may have no status label:`, retryError instanceof Error ? retryError.message : retryError);
    }
  }

  // Compute these outside the comment-gating block so they can also be used by the Telegram notification below
  const nextStepHint = getNextStepHint(role, success, outcome, effectiveNextStatus);

  // Final comment (gated by comment level)
  if (shouldPostComment('agent-finished')) {
    const emoji = success ? '✅' : finalStatus === 'timeout' ? '⏰' : '💀';
    const teamsLine = (teammateCount !== undefined && teammateCount > 0)
      ? `\n**Teammates:** 🤝 ${teammateCount} spawned` : '';

    const standardComment = `${emoji} **fritZ · Agent Finished**\n\n**Agent:** \`${agentName}\`\n**Role:** \`${role}\`\n**Status:** ${finalStatus}${teamsLine}\n**Ended:** ${formatTimestamp(new Date())}\n\n---\n${nextStepHint}`;

    const level = getCommentLevel();
    if (level === 'quiet') {
      // In quiet mode, combine with started comment via edit-in-place
      const startCtx = lifecycleStartContexts.get(agentName);
      const now = new Date();
      const elapsedMs = startCtx ? now.getTime() - startCtx.startedAt.getTime() : 0;
      const elapsedMin = Math.round(elapsedMs / 60000);
      const elapsedStr = elapsedMin >= 60 ? `${Math.floor(elapsedMin / 60)}h${elapsedMin % 60 > 0 ? `${elapsedMin % 60}m` : ''}` : `${elapsedMin}m`;
      const startTimeStr = startCtx ? formatTimestamp(startCtx.startedAt) : 'unknown';
      const ttlStr = startCtx ? (startCtx.ttlMinutes === 0 ? '♾️ unlimited' : startCtx.ttlMinutes < 60 ? `${startCtx.ttlMinutes} min` : `${Math.floor(startCtx.ttlMinutes / 60)}h`) : '';
      const combinedComment = lifecycleCommentIds.has(agentName)
        ? `🤖 **fritZ · ${role}** \`${agentName}\`\n⏱️ Started ${startTimeStr}${ttlStr ? ` · TTL ${ttlStr}` : ''}\n\n---\n${emoji} ${finalStatus === 'completed' ? 'Completed' : finalStatus === 'timeout' ? 'Timed out' : 'Died'} ${formatTimestamp(now)} (${elapsedStr})${teamsLine ? `\n${teamsLine}` : ''}\n→ ${effectiveNextStatus ?? nextStepHint}`
        : null;
      lifecycleStartContexts.delete(agentName);

      if (combinedComment) {
        await postLifecycleComment(issue, agentName, combinedComment, 'agent-finished');
      } else {
        // No started comment to edit — post standalone
        await ghQueued(['issue', 'comment', String(issue), '--body', standardComment, '--repo', repo], 'normal');
      }
    } else {
      await ghQueued(['issue', 'comment', String(issue), '--body', standardComment, '--repo', repo], 'normal');
    }
  } else {
    console.log(`[github] Skipping agent-finished comment for #${issue} (commentLevel: ${getCommentLevel()})`);
    cleanupLifecycleComment(agentName);
  }

  // Notify Telegram when issue needs human attention
  // Skip if safety valve already sent a notification (nextStatus was for-rework but got overridden)
  // Also skip if PR verification already sent a specific notification
  const safetyValveTriggered = (nextStatus === 'for-rework' && effectiveNextStatus === 'for-human') || prVerificationFailed;
  if (effectiveNextStatus === 'for-human' && !safetyValveTriggered) {
    logEvent('issue.attention', `#${issue} needs attention — ${role} agent ${finalStatus}`, { issue, role, status: finalStatus });
    await lifecycle.system(`⚠️ *#${issue}* needs attention — ${role} agent ${finalStatus}. ${nextStepHint}`);
  }

  // Smart invalidation: labels changed on single issue
  githubCache.invalidateIssue(issue);
}

function getNextStepHint(role: AgentRole, success: boolean, outcome?: string, effectiveStatus?: string): string {
  if (!success) {
    return '⚠️ Needs human attention';
  }

  // Safety valve override: if effectiveStatus is for-human but outcome was rejected,
  // the rework cycle limit was exceeded
  if (effectiveStatus === 'for-human' && outcome === 'rejected') {
    return '⚠️ Rework limit exceeded — needs human attention';
  }

  if (outcome === 'rejected') {
    return '🔄 Routing back to implement for rework';
  }

  switch (role) {
    case 'define':
      return '👉 Ready for human review of spec';
    case 'implement':
      return '👉 Review agent will pick this up automatically';
    case 'review':
      return '👉 Validate agent will pick this up automatically';
    case 'validate':
      return '👉 Ready for human to merge';
    case 'architect':
    case 'ux':
    case 'budget':
      // Check effectiveStatus to provide correct hint for standalone vs orchestrated
      if (effectiveStatus === 'defined') {
        return '👉 Ready for human review of spec';
      }
      return '👉 Define agent will pick this up to synthesize specs';
    case 'security-review':
    case 'pentest':
      return '👉 Pentest/security report posted — human reviews findings';
    default:
      return '👉 Needs human to decide next step';
  }
}

// Increment the rework cycle counter on an issue and return the new count
async function incrementReworkCycle(issue: number): Promise<number> {
  const repo = getRepo();

  // Read current rework count from labels (uses GraphQL cache)
  let currentCount = 0;
  try {
    const labels = getIssueLabels(issue);
    const reworkLabel = labels.find(l => l.startsWith(REWORK_PREFIX));
    if (reworkLabel) {
      currentCount = parseInt(reworkLabel.replace(REWORK_PREFIX, ''), 10) || 0;
      // Remove old rework label
      try {
        await ghQueued(['issue', 'edit', String(issue), '--remove-label', reworkLabel, '--repo', repo], 'high');
      } catch { /* label might not exist */ }
    }
  } catch {
    // No labels or issue not found
  }

  const newCount = currentCount + 1;
  const newLabel = `${REWORK_PREFIX}${newCount}`;

  // Create label if it doesn't exist (first time for this count)
  try {
    await ghQueued(['label', 'create', newLabel, '--color', 'D4C5F9', '--description', `Rework cycle ${newCount}`, '--force', '--repo', repo], 'low');
  } catch { /* label might already exist */ }

  try {
    await ghQueued(['issue', 'edit', String(issue), '--add-label', newLabel, '--repo', repo], 'high');
  } catch { /* best effort */ }

  return newCount;
}

// Reset rework count when issue reaches validated status
async function resetReworkCycle(issue: number): Promise<void> {
  const repo = getRepo();
  try {
    const labels = getIssueLabels(issue);
    const reworkLabel = labels.find(l => l.startsWith(REWORK_PREFIX));
    if (reworkLabel) {
      await ghQueued(['issue', 'edit', String(issue), '--remove-label', reworkLabel, '--repo', repo], 'high');
    }
  } catch {
    // Best effort
  }
}

// Post a comment to an issue
export async function postComment(issue: number, body: string): Promise<void> {
  const repo = getRepo();
  await ghQueued(['issue', 'comment', String(issue), '--body', body, '--repo', repo], 'normal');
}

// Get all labels on an issue (returns raw label names)
export function getIssueLabels(issue: number): string[] {
  // Check GraphQL cache first (falls back to API on miss)
  const cached = getCachedIssues();
  if (cached) {
    const found = cached.find(i => i.number === issue);
    if (found) return found.labels;
  }

  // Cache miss (closed issue, or cache not yet populated) — fetch directly
  const repo = getRepo();

  try {
    const result = gh(`issue view ${issue} --json labels --jq '.labels[].name' --repo ${repo}`);
    return result.split('\n').filter(l => l.length > 0);
  } catch {
    return [];
  }
}

// ============================================================================
// Target Repo Info - Parse fritz.repo: labels for multi-repo support
// ============================================================================

// Label prefix for target repository
const REPO_PREFIX = 'fritz.repo:';

export interface TargetRepoInfo {
  repo: string;       // "owner/name"
  branch?: string;    // optional target branch
}

/**
 * Parse the fritz.repo: label from an issue to get target repo and optional branch.
 * Label syntax:
 *   - fritz.repo:owner/name           → clone repo, use default branch
 *   - fritz.repo:owner/name:branch    → clone repo, checkout specified branch
 *
 * @returns TargetRepoInfo if a fritz.repo: label exists, null otherwise
 */
export function getTargetRepoInfo(issue: number): TargetRepoInfo | null {
  const labels = getIssueLabels(issue);
  const repoLabel = labels.find(l => l.startsWith(REPO_PREFIX));

  if (!repoLabel) return null;

  // Parse fritz.repo:owner/name or fritz.repo:owner/name:branch
  const value = repoLabel.replace(REPO_PREFIX, '');

  // Split on : but need to handle owner/name:branch format
  // The repo part always contains a /, the branch part doesn't (or if it does, it's after the first :)
  const colonIndex = value.indexOf(':');

  if (colonIndex === -1) {
    // fritz.repo:owner/name (no branch specified)
    return { repo: value };
  } else {
    // fritz.repo:owner/name:branch
    const repo = value.substring(0, colonIndex);
    const branch = value.substring(colonIndex + 1);
    return { repo, branch: branch || undefined };
  }
}

// Get all active agents from GitHub
export interface GitHubAgent {
  issue: number;
  title: string;
  role: AgentRole;
  status: 'working' | 'blocked' | 'completed';
}

export async function getActiveAgents(): Promise<GitHubAgent[]> {
  const repo = getRepo();

  try {
    const result = gh(`issue list --label "${STATUS_PREFIX}active" --json number,title,labels --repo ${repo}`);
    const issues = JSON.parse(result || '[]');

    return issues.map((issue: { number: number; title: string; labels: { name: string }[] }) => {
      const roleLabel = issue.labels.find((l) => l.name.startsWith(ROLE_PREFIX));
      const role = roleLabel ? roleLabel.name.replace(ROLE_PREFIX, '') : 'implement';

      return {
        issue: issue.number,
        title: issue.title,
        role: role as AgentRole,
        status: 'working' as const,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Auto-Pipeline - Automatic status transitions and merge support
// ============================================================================

// Label constants for auto-pipeline and fritz.depends-on
const AUTO_PIPELINE_LABEL = 'fritz.auto-pipeline';
export const DEPENDS_ON_PREFIX = 'fritz.depends-on:';

/**
 * Check if an issue has the fritz.auto-pipeline label.
 * Accepts optional pre-fetched labels to avoid redundant API calls.
 */
export function hasAutoPipeline(issue: number, labels?: string[]): boolean {
  const effectiveLabels = labels ?? getIssueLabels(issue);
  return effectiveLabels.includes(AUTO_PIPELINE_LABEL);
}

/**
 * Add or remove the fritz.auto-pipeline label on an issue.
 */
export async function setAutoPipeline(issue: number, enabled: boolean): Promise<void> {
  const repo = getRepo();
  if (enabled) {
    await ghQueued(['issue', 'edit', String(issue), '--add-label', AUTO_PIPELINE_LABEL, '--repo', repo], 'normal');
  } else {
    await ghQueued(['issue', 'edit', String(issue), '--remove-label', AUTO_PIPELINE_LABEL, '--repo', repo], 'normal');
  }

  // Smart invalidation: label changed on single issue
  githubCache.invalidateIssue(issue);
}

/**
 * Parse fritz.depends-on:NNN labels from an issue and return dependency issue numbers.
 */
export function getDependencies(issue: number): number[] {
  const labels = getIssueLabels(issue);
  return parseDependenciesFromLabels(labels);
}

/**
 * Parse fritz.depends-on:NNN from a pre-fetched label list (avoids extra API call).
 */
export function parseDependenciesFromLabels(labels: string[]): number[] {
  return labels
    .filter(l => l.startsWith(DEPENDS_ON_PREFIX))
    .map(l => parseInt(l.replace(DEPENDS_ON_PREFIX, ''), 10))
    .filter(n => !isNaN(n));
}

/**
 * Check if a dependency issue is closed (resolved).
 * Logs a warning on failure so persistent errors are visible in logs.
 */
export function isDependencyClosed(depIssue: number): boolean {
  const repo = getRepo();
  return githubCache.isDependencyClosedCached(depIssue, repo);
}

// ============================================================================
// Depends-On Label Cleanup
// ============================================================================

/**
 * List all fritz.depends-on:NNN labels that exist in the repository.
 * Uses `gh label list` with search to find matching labels.
 */
export async function listDependsOnLabels(): Promise<string[]> {
  const repo = getRepo();
  try {
    const result = await execAsync('gh', [
      'label', 'list',
      '--search', 'fritz.depends-on:',
      '--json', 'name',
      '--limit', '100',
      '--repo', repo,
    ], { timeout: 15000 });
    const labels: Array<{ name: string }> = JSON.parse(result || '[]');
    return labels
      .map(l => l.name)
      .filter(name => name.startsWith(DEPENDS_ON_PREFIX));
  } catch (error: unknown) {
    console.warn(`[github] listDependsOnLabels failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * Remove a label from all open issues that have it, then delete the label itself.
 * Logs each step for auditability.
 */
export async function removeLabelAndDelete(label: string): Promise<void> {
  const repo = getRepo();

  // Step 1: Find all open issues with this label
  try {
    const result = await execAsync('gh', [
      'issue', 'list',
      '--label', label,
      '--state', 'open',
      '--json', 'number',
      '--limit', '100',
      '--repo', repo,
    ], { timeout: 15000 });
    const issues: Array<{ number: number }> = JSON.parse(result || '[]');

    // Remove label from each issue (using execAsync to avoid shell injection via label names)
    for (const issue of issues) {
      try {
        await execAsync('gh', [
          'issue', 'edit', String(issue.number),
          '--remove-label', label,
          '--repo', repo,
        ], { timeout: 15000 });
        console.log(`[github] Removed label "${label}" from #${issue.number}`);
      } catch (error: unknown) {
        console.warn(`[github] Failed to remove "${label}" from #${issue.number}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error: unknown) {
    console.warn(`[github] Failed to list issues for label "${label}": ${error instanceof Error ? error.message : error}`);
  }

  // Step 2: Delete the label from the repository (using execAsync to avoid shell injection)
  try {
    await execAsync('gh', [
      'label', 'delete', label,
      '--yes',
      '--repo', repo,
    ], { timeout: 15000 });
    console.log(`[github] Deleted label "${label}"`);
  } catch (error: unknown) {
    console.warn(`[github] Failed to delete label "${label}": ${error instanceof Error ? error.message : error}`);
  }

  // Smart invalidation: bulk label removal affects issue list
  githubCache.invalidateIssueList();
}

/**
 * Transition an issue from 'defined' to 'for-implement' (auto-pipeline).
 * Uses rollback logic: if adding 'for-implement' fails after removing 'defined',
 * re-adds 'defined' to prevent orphaning the issue.
 */
export async function transitionToForImplement(issue: number): Promise<void> {
  const repo = getRepo();

  // Remove 'defined' status
  try {
    await ghQueued(['issue', 'edit', String(issue), '--remove-label', `${STATUS_PREFIX}defined`, '--repo', repo], 'high');
  } catch { /* may not exist */ }

  // Add 'for-implement' — if this fails, roll back by re-adding 'defined'
  try {
    await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}for-implement`, '--repo', repo], 'high');
  } catch (error) {
    console.error(`[github] Failed to add for-implement label to #${issue}, rolling back to defined`);
    try {
      await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}defined`, '--repo', repo], 'high');
    } catch { /* best effort rollback */ }
    throw error;
  }

  // Smart invalidation: labels changed on single issue
  githubCache.invalidateIssue(issue);

  if (shouldPostComment('auto-pipeline-transition')) {
    await postComment(issue, `🔄 **fritZ · Auto-Pipeline**\n\nAutomatically transitioning from \`defined\` → \`for-implement\`.`);
  } else {
    console.log(`[github] Skipping auto-pipeline-transition comment for #${issue} (commentLevel: ${getCommentLevel()})`);
  }
}

// ============================================================================
// Merge Primitives — shared by auto-pipeline and dashboard merge paths
//
// Error handling convention:
// - State queries (findIssuePR, getPRCheckStatus, isPRMergeable, getPRState):
//   throw on errors — callers decide whether to retry or escalate.
// - Mutations (mergePR): throw on errors — callers handle race conditions.
// - Best-effort side effects (closeIssue, removeStatusLabel, postMergeComment):
//   catch errors internally and log — callers don't need to guard.
// ============================================================================

/**
 * Find the open PR linked to an issue.
 * Searches by "closes #N" keyword first, then by issue number in branch name.
 * @param repo - Target repo (for cross-repo issues). Defaults to config.githubRepo.
 */
export function findIssuePR(issue: number, repo?: string): { number: number; headRefName: string; baseRefName: string } | null {
  const targetRepo = repo ?? getRepo();

  const result = gh(`pr list --search "closes #${issue}" --state open --json number,headRefName,baseRefName --repo ${targetRepo}`);
  const prs: Array<{ number: number; headRefName: string; baseRefName: string }> = JSON.parse(result || '[]');

  if (prs.length > 0) {
    return prs[0];
  }

  // Also try searching by issue number in branch name.
  // Branch naming convention: feature/<issue>-<slug>
  const branchResult = gh(`pr list --state open --json number,headRefName,baseRefName --repo ${targetRepo}`);
  const allPrs: Array<{ number: number; headRefName: string; baseRefName: string }> = JSON.parse(branchResult || '[]');
  const issuePattern = new RegExp(`(^|/)${issue}-`);
  const issuePrs = allPrs.filter(p => issuePattern.test(p.headRefName));
  return issuePrs.length > 0 ? issuePrs[0] : null;
}

/**
 * Check CI/checks status for a PR.
 * Returns 'success' if all checks pass (or no checks configured),
 * 'failure' if any check failed/errored, 'pending' if any still running.
 */
export function getPRCheckStatus(prNumber: number, repo?: string): 'success' | 'failure' | 'pending' {
  const targetRepo = repo ?? getRepo();

  const result = gh(`pr view ${prNumber} --json statusCheckRollup --repo ${targetRepo}`);
  const { statusCheckRollup } = JSON.parse(result);

  if (!statusCheckRollup || statusCheckRollup.length === 0) {
    return 'success'; // No checks configured → treat as passing
  }

  const passingConclusions = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
  const hasFailure = statusCheckRollup.some(
    (c: { conclusion?: string; status?: string }) =>
      c.status === 'COMPLETED' && !passingConclusions.has(c.conclusion ?? '')
  );
  if (hasFailure) return 'failure';

  const hasPending = statusCheckRollup.some(
    (c: { status?: string }) => c.status !== 'COMPLETED'
  );
  if (hasPending) return 'pending';

  return 'success';
}

/**
 * Check if a PR has merge conflicts.
 * GitHub API returns: "MERGEABLE", "CONFLICTING", "UNKNOWN".
 * UNKNOWN is treated as non-mergeable (escalates to human).
 */
export function isPRMergeable(prNumber: number, repo?: string): boolean {
  return getPRMergeableStatus(prNumber, repo) === 'MERGEABLE';
}

/**
 * Get the raw mergeable status of a PR.
 * Returns: "MERGEABLE", "CONFLICTING", or "UNKNOWN".
 */
export function getPRMergeableStatus(prNumber: number, repo?: string): string {
  const targetRepo = repo ?? getRepo();

  const result = gh(`pr view ${prNumber} --json mergeable --repo ${targetRepo}`);
  const { mergeable } = JSON.parse(result);
  return mergeable ?? 'UNKNOWN';
}

/**
 * Get the list of files changed by a PR.
 * Returns an array of file paths.
 */
export function getPRFiles(prNumber: number, repo?: string): string[] {
  const targetRepo = repo ?? getRepo();

  try {
    const result = gh(`pr view ${prNumber} --json files --repo ${targetRepo}`);
    const { files } = JSON.parse(result);
    if (!Array.isArray(files)) return [];
    return files.map((f: { path: string }) => f.path);
  } catch {
    return [];
  }
}

/**
 * List all open PRs with their numbers, branch names, and changed files.
 * Used for cross-referencing conflicting files across PRs.
 */
export function listOpenPRsWithFiles(repo?: string): Array<{ number: number; headRefName: string; files: string[] }> {
  const targetRepo = repo ?? getRepo();

  try {
    const result = gh(`pr list --state open --json number,headRefName,files --repo ${targetRepo}`);
    const prs: Array<{ number: number; headRefName: string; files?: Array<{ path: string }> }> = JSON.parse(result || '[]');
    return prs.map(pr => ({
      number: pr.number,
      headRefName: pr.headRefName,
      files: (pr.files ?? []).map((f) => f.path),
    }));
  } catch {
    return [];
  }
}

/**
 * Get the current state of a PR (OPEN, CLOSED, MERGED).
 * Used for race condition detection: if a merge call fails, check if the PR was already merged.
 */
export function getPRState(prNumber: number, repo?: string): string {
  const targetRepo = repo ?? getRepo();
  try {
    const result = gh(`pr view ${prNumber} --json state --jq '.state' --repo ${targetRepo}`);
    return result; // 'OPEN', 'CLOSED', or 'MERGED'
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Merge a PR via squash merge. Throws on failure.
 */
export async function mergePR(prNumber: number, repo?: string): Promise<void> {
  const targetRepo = repo ?? getRepo();
  // Critical priority: merge operations bypass the token bucket to avoid delays
  await ghQueued(['pr', 'merge', String(prNumber), '--squash', '--repo', targetRepo], 'critical');
  // Smart invalidation: PR merge changes list membership
  githubCache.invalidateIssueList();
}

/**
 * Check if a merge error indicates the branch is behind the base branch.
 * GitHub returns errors like "Head branch was modified" or "is not up to date"
 * when branch protection requires the branch to be current.
 */
export function isBranchBehindError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes('not up to date') ||
    lower.includes('out-of-date') ||
    lower.includes('out of date') ||
    lower.includes('head branch was modified');
}

/**
 * Close a GitHub issue. Best-effort — logs errors but doesn't throw.
 */
export async function closeIssue(issue: number, repo?: string): Promise<void> {
  const targetRepo = repo ?? getRepo();
  try {
    // Critical priority: close operations bypass the token bucket
    await ghQueued(['issue', 'close', String(issue), '--repo', targetRepo], 'critical');
    // Smart invalidation: issue closed — affects both single issue and list membership
    // invalidateIssue() clears the depCache for this issue internally
    githubCache.invalidateIssue(issue);
    githubCache.invalidateIssueList();
  } catch (error: unknown) {
    console.error(`[github] Failed to close issue #${issue}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Post a merge comment with correct trigger attribution.
 * Distinguishes auto-pipeline merges from dashboard-approved merges.
 */
export async function postMergeComment(
  issue: number,
  prNumber: number,
  trigger: 'auto-pipeline' | 'dashboard',
): Promise<void> {
  const header = trigger === 'auto-pipeline'
    ? '🔄 **fritZ · Auto-Pipeline**'
    : '✅ **fritZ · Dashboard Merge**';
  const verb = trigger === 'auto-pipeline'
    ? 'Automatically merged'
    : 'Merged via Dashboard approve';
  if (shouldPostComment('auto-pipeline-merge')) {
    await postComment(issue, `${header}\n\n${verb} PR #${prNumber} and closed issue.`);
  } else {
    console.log(`[github] Skipping auto-pipeline-merge comment for #${issue} (commentLevel: ${getCommentLevel()})`);
  }
}

/**
 * Remove a status label from an issue (best-effort).
 * Used for cleanup after merge when the issue is already closed.
 */
export async function removeStatusLabel(issue: number, status: string, repo?: string): Promise<void> {
  const targetRepo = repo ?? getRepo();
  try {
    await ghQueued(['issue', 'edit', String(issue), '--remove-label', `${STATUS_PREFIX}${status}`, '--repo', targetRepo], 'high');
    // Smart invalidation: label removed from single issue
    githubCache.invalidateIssue(issue);
  } catch (error: unknown) {
    console.error(
      `[github] Failed to remove status label ${STATUS_PREFIX}${status} from #${issue}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Transition an issue from one status to another.
 * Removes the old status label and adds the new one with rollback on failure.
 */
export async function transitionStatus(issue: number, fromStatus: string, toStatus: string): Promise<void> {
  const repo = getRepo();

  try {
    await ghQueued(['issue', 'edit', String(issue), '--remove-label', `${STATUS_PREFIX}${fromStatus}`, '--repo', repo], 'high');
  } catch { /* may not exist */ }

  try {
    await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}${toStatus}`, '--repo', repo], 'high');
  } catch (error) {
    console.error(`[github] Failed to add ${toStatus} label to #${issue}, rolling back to ${fromStatus}`);
    try {
      await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}${fromStatus}`, '--repo', repo], 'high');
    } catch { /* best effort rollback */ }
    throw error;
  }

  // Smart invalidation: labels changed on single issue
  githubCache.invalidateIssue(issue);
}

/**
 * Find the open PR linked to an issue and merge it (convenience wrapper).
 * Used by handleAutoPipelineValidated(). Returns the merged PR number, or null.
 *
 * Separates merge from close/comment so a successful merge is never masked
 * by a failure in the subsequent close or comment step.
 * @param repo - Target repo for PR lookup/merge (for cross-repo issues). Defaults to config.githubRepo.
 */
export async function mergeIssuePR(issue: number, repo?: string): Promise<number | null> {
  const targetRepo = repo ?? getRepo();
  const pr = findIssuePR(issue, targetRepo);
  if (!pr) return null;

  // Throw on merge failure so callers can distinguish "no PR" (null) from "merge failed" (exception)
  await mergePR(pr.number, targetRepo);

  logEvent('pr.merged', `PR #${pr.number} merged for issue #${issue}`, {
    pr: pr.number,
    issue,
    trigger: 'auto-pipeline',
  });

  // Issue lives on the main repo (your-org/fritZ), not the PR repo
  try { await closeIssue(issue); } catch { /* best effort */ }
  try { await postMergeComment(issue, pr.number, 'auto-pipeline'); } catch { /* best effort */ }

  logEvent('issue.done', `Issue #${issue} completed`, {
    issue,
    pr: pr.number,
    trigger: 'auto-pipeline',
  });

  return pr.number;
}

/**
 * Get title and labels for a PR.
 * Used by deployment tracker to determine hotfix/rollback status.
 */
export function getPRInfo(prNumber: number, repo?: string): { title: string; labels: string[] } {
  const targetRepo = repo ?? getRepo();
  const result = gh(`pr view ${prNumber} --json title,labels --repo ${targetRepo}`);
  const { title, labels } = JSON.parse(result);
  return { title, labels: labels.map((l: { name: string }) => l.name) };
}

// ============================================================================
// Activity Log - Track all agent activity on an issue
// ============================================================================

// logActivity() removed in #685 Phase 1 — activity is now tracked via issue comments
// (posted by report.sh → daemon /api/notify) and the local event log (logEvent).
// This eliminates 2 GitHub API calls per activity entry (read body + write body).

// ============================================================================
// Discussion Mode - Multi-agent collaboration
// ============================================================================

export interface DiscussionState {
  roles: AgentRole[];
  currentTurn: AgentRole | null;
  rounds: number;
  maxRounds: number;
  history: Array<{ role: AgentRole; agent: string; timestamp: string }>;
}

// Get all role labels on an issue (internal helper for getDiscussionState)
// Uses GraphQL cache for label reads (cache-first, API fallback on miss)
function getIssueRoles(issue: number): AgentRole[] {
  try {
    const labels = getIssueLabels(issue);
    return labels
      .filter(l => l.startsWith(ROLE_PREFIX))
      .map(l => l.replace(ROLE_PREFIX, '') as AgentRole);
  } catch {
    return [];
  }
}

// Get discussion state from issue comments
export async function getDiscussionState(issue: number, maxRounds = 3): Promise<DiscussionState> {
  const repo = getRepo();
  const roles = getIssueRoles(issue);

  try {
    // Get comments to build history
    const commentsJson = gh(`issue view ${issue} --json comments --repo ${repo}`);
    const { comments } = JSON.parse(commentsJson);

    const history: DiscussionState['history'] = [];

    // Parse agent comments (look for "**Agent `name`**" pattern)
    for (const comment of comments) {
      const match = comment.body.match(/\*\*Agent `([^`]+)`\*\*/);
      if (match) {
        const agentName = match[1];
        const role = agentName.split('-')[0] as AgentRole;
        if (roles.includes(role)) {
          history.push({
            role,
            agent: agentName,
            timestamp: comment.createdAt,
          });
        }
      }
    }

    // Determine whose turn it is (alternate between roles)
    const turnCounts = new Map<AgentRole, number>();
    for (const role of roles) {
      turnCounts.set(role, 0);
    }
    for (const h of history) {
      turnCounts.set(h.role, (turnCounts.get(h.role) || 0) + 1);
    }

    // Find role with fewest turns (it's their turn)
    let currentTurn: AgentRole | null = null;
    let minTurns = Infinity;
    for (const [role, count] of turnCounts) {
      if (count < minTurns) {
        minTurns = count;
        currentTurn = role;
      }
    }

    // Calculate rounds (a round = each role has spoken once)
    const rounds = Math.min(...Array.from(turnCounts.values()));

    return {
      roles,
      currentTurn: rounds >= maxRounds ? null : currentTurn,
      rounds,
      maxRounds,
      history,
    };
  } catch {
    return {
      roles,
      currentTurn: roles[0] || null,
      rounds: 0,
      maxRounds,
      history: [],
    };
  }
}

// End a discussion
export async function endDiscussion(
  issue: number,
  outcome: 'consensus' | 'max-rounds' | 'human-requested'
): Promise<void> {
  const repo = getRepo();

  // Move to for-human
  // Uses GraphQL cache for label reads (cache-first, API fallback on miss)
  try {
    const currentLabels = getIssueLabels(issue);
    const statusLabels = currentLabels.filter(l => l.startsWith(STATUS_PREFIX));

    if (statusLabels.length > 0) {
      await ghQueued(['issue', 'edit', String(issue), '--remove-label', statusLabels.join(','), '--repo', repo], 'high');
    }
  } catch {
    // Ignore
  }

  await ghQueued(['issue', 'edit', String(issue), '--add-label', `${STATUS_PREFIX}for-human`, '--repo', repo], 'high');

  // Smart invalidation: labels changed on single issue
  githubCache.invalidateIssue(issue);

  const emoji = outcome === 'consensus' ? '✅' : outcome === 'max-rounds' ? '⏰' : '🙋';
  const comment = `${emoji} **Discussion Ended**

Outcome: ${outcome}
Human review needed.`;

  await ghQueued(['issue', 'comment', String(issue), '--body', comment, '--repo', repo], 'normal');
}
