/**
 * GitHub Write Queue — Token Bucket Rate Limiter
 *
 * Routes all GitHub mutation operations (label changes, comments, PR merges)
 * through a token-bucket queue to prevent secondary rate limit (429) errors.
 *
 * Architecture:
 * - Token bucket: 0.5 tokens/sec sustained (30 writes/min), burst capacity 10
 * - Priority levels: critical (bypass bucket), high (label transitions), normal (comments), low (best-effort)
 * - Secondary rate limit circuit breaker: 60s → 120s → 300s exponential backoff
 * - Queue overflow protection: max 20 critical, 50 high, 40 normal, 20 low
 *
 * Queue is ephemeral — drains on daemon restart. Label add/remove operations
 * are idempotent, but comment posts are not and may be duplicated if retried
 * due to secondary rate limits; callers must tolerate or deduplicate comments.
 */

import { execFileSync } from 'child_process';
import * as lifecycle from '../core/lifecycle.js';
import { logEvent } from '../core/event-log.js';
/** Detect GitHub secondary rate limit errors (duplicated from github.ts to avoid circular import: github.ts imports ghQueued() from this module, so importing github.ts here would create a cycle). */
function isSecondaryRateLimit(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /secondary rate limit/i.test(msg)
    || /submitted too quickly/i.test(msg)
    || /abuse detection/i.test(msg)
    || /\b429\b/.test(msg);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Priority levels:
 * - 'critical': bypasses token bucket entirely (merge, close, issue create)
 * - 'high': label transitions (first to drain when tokens available)
 * - 'normal': comments
 * - 'low': best-effort (cleanup labels, etc.)
 */
export type WritePriority = 'critical' | 'high' | 'normal' | 'low';

interface QueueItem {
  args: string[];
  priority: WritePriority;
  enqueuedAt: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export interface WriteQueueStats {
  /** Total operations processed since startup */
  totalProcessed: number;
  /** Operations currently waiting in queue */
  queueDepth: number;
  /** Queue depth by priority */
  queueDepthByPriority: Record<WritePriority, number>;
  /** Available tokens in bucket */
  tokensAvailable: number;
  /** Whether secondary rate limit circuit breaker is active */
  secondaryLimitActive: boolean;
  /** When the secondary limit backoff expires (ISO string, null if not active) */
  secondaryLimitResetsAt: string | null;
  /** Current backoff tier (0 = none, 1 = 60s, 2 = 120s, 3 = 300s) */
  backoffTier: number;
  /** Writes per minute (rolling 60s window) */
  writesPerMinute: number;
  /** Total operations dropped (timeout or overflow) */
  totalDropped: number;
  /** Total operations coalesced (label edits merged) */
  totalCoalesced: number;
  /** Whether the write queue is enabled (feature flag) */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max tokens in bucket (burst capacity — allows rapid initial writes) */
const MAX_TOKENS = 10;

/** Tokens added per refill interval */
const TOKENS_PER_REFILL = 1;

/** Refill interval in ms (1 token every 2000ms = 0.5/sec = 30/min sustained)
 *  This enforces ≤30 writes/min to stay well under GitHub's secondary rate limit (~80-100/min). */
const REFILL_INTERVAL_MS = 2_000;

/** Operation timeout — drop if queued longer than this.
 *  Increased from 30s to accommodate slower drain rate at 30 writes/min. */
const OPERATION_TIMEOUT_MS = 60_000;

/** Max queue depth by priority (overflow protection) */
const MAX_QUEUE_DEPTH: Record<WritePriority, number> = {
  critical: 20,
  high: 50,
  normal: 40,
  low: 20,
};

/** Secondary rate limit backoff tiers (ms) */
const BACKOFF_TIERS_MS = [60_000, 120_000, 300_000];

/** Time without secondary rate limit errors to reset backoff tier (ms) */
const BACKOFF_RESET_MS = 60 * 60 * 1000; // 1 hour

/** Drain interval — how often we try to process queued items */
const DRAIN_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Feature flag: when false, operations execute synchronously bypassing the queue */
let queueEnabled = true;

/** Token bucket — current available tokens */
let tokens = MAX_TOKENS;

/** Priority queues (critical queue drains immediately, bypassing token bucket) */
const queues: Record<WritePriority, QueueItem[]> = {
  critical: [],
  high: [],
  normal: [],
  low: [],
};

/** Secondary rate limit circuit breaker */
let secondaryLimitActive = false;
let secondaryLimitExpiresAt = 0;
let backoffTier = 0;
let lastSecondaryHitAt = 0;

/** Stats */
let totalProcessed = 0;
let totalDropped = 0;
let totalCoalesced = 0;

/** Rolling write timestamps for writes-per-minute calculation */
const writeTimestamps: number[] = [];

/** Interval handles for cleanup */
let refillInterval: ReturnType<typeof setInterval> | null = null;
let drainInterval: ReturnType<typeof setInterval> | null = null;

/** Whether the queue has been started */
let started = false;

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

function refillTokens(): void {
  if (tokens < MAX_TOKENS) {
    tokens = Math.min(MAX_TOKENS, tokens + TOKENS_PER_REFILL);
  }
}

function consumeToken(): boolean {
  if (tokens > 0) {
    tokens--;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Secondary rate limit circuit breaker
// ---------------------------------------------------------------------------

function onSecondaryRateLimit(): void {
  const now = Date.now();
  lastSecondaryHitAt = now;

  // Advance backoff tier (cap at max)
  if (backoffTier < BACKOFF_TIERS_MS.length) {
    backoffTier++;
  }

  const backoffMs = BACKOFF_TIERS_MS[Math.min(backoffTier - 1, BACKOFF_TIERS_MS.length - 1)];
  secondaryLimitActive = true;
  secondaryLimitExpiresAt = now + backoffMs;

  console.warn(
    `[write-queue] Secondary rate limit hit — circuit breaker active for ${backoffMs / 1000}s (tier ${backoffTier})`
  );

  // Event log + Telegram alert (fire and forget)
  logEvent('github.rate-limit', `Secondary rate limit — write queue paused for ${backoffMs / 1000}s`, { tier: backoffTier, pauseSeconds: backoffMs / 1000 });
  lifecycle.system(
    `⚠️ GitHub secondary rate limit hit — write queue paused for ${backoffMs / 1000}s (backoff tier ${backoffTier}/${BACKOFF_TIERS_MS.length})`
  ).catch(() => {});
}

function checkSecondaryReset(): void {
  if (secondaryLimitActive && Date.now() >= secondaryLimitExpiresAt) {
    secondaryLimitActive = false;
    // Reset enqueuedAt for all queued items to prevent timeout after long backoff
    const now = Date.now();
    for (const priority of ['critical', 'high', 'normal', 'low'] as WritePriority[]) {
      for (const item of queues[priority]) {
        item.enqueuedAt = now;
      }
    }
    console.log('[write-queue] Secondary rate limit backoff expired — resuming writes');
  }

  // Reset backoff tier after 1 hour of clean operation
  if (backoffTier > 0 && !secondaryLimitActive && Date.now() - lastSecondaryHitAt > BACKOFF_RESET_MS) {
    console.log('[write-queue] 1 hour clean — resetting backoff tier to 0');
    backoffTier = 0;
  }
}

// ---------------------------------------------------------------------------
// Write-per-minute tracking
// ---------------------------------------------------------------------------

function recordWrite(): void {
  const now = Date.now();
  writeTimestamps.push(now);
  // Trim timestamps older than 60s
  const cutoff = now - 60_000;
  while (writeTimestamps.length > 0 && writeTimestamps[0] < cutoff) {
    writeTimestamps.shift();
  }
}

function getWritesPerMinute(): number {
  const cutoff = Date.now() - 60_000;
  while (writeTimestamps.length > 0 && writeTimestamps[0] < cutoff) {
    writeTimestamps.shift();
  }
  return writeTimestamps.length;
}

// ---------------------------------------------------------------------------
// Drop tracking
// ---------------------------------------------------------------------------

function recordDrop(): void {
  totalDropped++;
}

// ---------------------------------------------------------------------------
// Queue drain
// ---------------------------------------------------------------------------

/** Get the next item from queues in priority order (skipping critical — handled separately) */
function dequeue(): QueueItem | null {
  const now = Date.now();

  for (const priority of ['high', 'normal', 'low'] as WritePriority[]) {
    const queue = queues[priority];
    while (queue.length > 0) {
      const item = queue[0];
      // Check timeout
      if (now - item.enqueuedAt > OPERATION_TIMEOUT_MS) {
        queue.shift();
        recordDrop();
        item.reject(new Error(`Write operation timed out after ${OPERATION_TIMEOUT_MS}ms in queue`));
        continue;
      }
      return queue.shift()!;
    }
  }
  return null;
}

/** Execute a single queue item via gh CLI */
function executeItem(item: QueueItem): void {
  try {
    const result = execFileSync('gh', item.args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    totalProcessed++;
    recordWrite();
    item.resolve(result);
  } catch (error: unknown) {
    if (isSecondaryRateLimit(error)) {
      onSecondaryRateLimit();
      // Re-queue for retry — do NOT reset enqueuedAt for critical items so the
      // timeout eventually fires as a safety net against infinite retry loops.
      if (item.priority !== 'critical') {
        item.enqueuedAt = Date.now();
      }
      queues[item.priority].unshift(item);
      // Return token since write didn't complete
      tokens = Math.min(MAX_TOKENS, tokens + 1);
      return;
    }

    totalProcessed++;
    recordWrite();
    item.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Process one item from the queue */
function drain(): void {
  // Check if secondary rate limit backoff has expired
  checkSecondaryReset();

  // Critical queue: drain ALL items immediately, bypassing token bucket.
  // However, respect the circuit breaker — if secondary rate limit is active,
  // skip critical items too (they'll retry on the next drain after backoff expires).
  while (queues.critical.length > 0) {
    if (secondaryLimitActive) break;
    const criticalItem = queues.critical.shift()!;
    const now = Date.now();
    if (now - criticalItem.enqueuedAt > OPERATION_TIMEOUT_MS) {
      recordDrop();
      criticalItem.reject(new Error(`Critical write operation timed out after ${OPERATION_TIMEOUT_MS}ms`));
      continue;
    }
    const sizeBefore = queues.critical.length;
    executeItem(criticalItem);
    // If executeItem re-queued the item (secondary rate limit hit), stop draining
    // critical queue this cycle — respect the circuit breaker backoff before retrying.
    if (queues.critical.length > sizeBefore) break;
  }

  // Don't process non-critical while circuit breaker is active
  if (secondaryLimitActive) return;

  // Try to consume a token and process an item
  if (!consumeToken()) return;

  const item = dequeue();
  if (!item) {
    // No items to process — return the token
    tokens = Math.min(MAX_TOKENS, tokens + 1);
    return;
  }

  executeItem(item);
}

// ---------------------------------------------------------------------------
// Label coalescing — merge rapid label edits on the same issue
// ---------------------------------------------------------------------------

/**
 * Try to coalesce a new label edit with an existing queued item for the same issue.
 * If coalesced, returns a promise that resolves when the merged item completes.
 *
 * Coalescing logic: if two `issue edit` operations target the same issue number,
 * merge their --add-label and --remove-label sets into a single API call.
 */
function tryCoalesceLabels(args: string[], priority: WritePriority): Promise<string> | null {
  // Only coalesce label edit operations
  if (!args.includes('issue') || !args.includes('edit')) return null;

  // Extract issue number from args
  const editIdx = args.indexOf('edit');
  if (editIdx === -1 || editIdx + 1 >= args.length) return null;
  const issueNum = args[editIdx + 1];

  // Only coalesce if args contain label flags
  if (!args.includes('--add-label') && !args.includes('--remove-label')) return null;

  // Search the queue for a matching item
  const queue = queues[priority];
  for (const existing of queue) {
    if (!existing.args.includes('issue') || !existing.args.includes('edit')) continue;
    const existingEditIdx = existing.args.indexOf('edit');
    if (existingEditIdx === -1 || existingEditIdx + 1 >= existing.args.length) continue;
    if (existing.args[existingEditIdx + 1] !== issueNum) continue;

    // Found matching issue edit — merge label sets
    const existingAdd = extractArgValue(existing.args, '--add-label');
    const existingRemove = extractArgValue(existing.args, '--remove-label');
    const newAdd = extractArgValue(args, '--add-label');
    const newRemove = extractArgValue(args, '--remove-label');

    let mergedAdd = mergeCommaSeparated(existingAdd, newAdd);
    const mergedRemove = mergeCommaSeparated(existingRemove, newRemove);

    // Deduplicate: if a label appears in both add and remove, the later operation
    // (remove) wins — the intent is to remove a label that was previously queued to be added.
    if (mergedAdd && mergedRemove) {
      const addSet = new Set(mergedAdd.split(',').map(s => s.trim()).filter(Boolean));
      const removeSet = new Set(mergedRemove.split(',').map(s => s.trim()).filter(Boolean));
      for (const label of removeSet) {
        addSet.delete(label);
      }
      mergedAdd = [...addSet].join(',');
    }

    // Rebuild args with merged labels
    const repo = extractArgValue(existing.args, '--repo') || extractArgValue(args, '--repo');
    const mergedArgs = ['issue', 'edit', issueNum];
    if (mergedRemove) mergedArgs.push('--remove-label', mergedRemove);
    if (mergedAdd) mergedArgs.push('--add-label', mergedAdd);
    if (repo) mergedArgs.push('--repo', repo);

    existing.args = mergedArgs;

    // Chain the new caller's promise to the existing queue item's completion
    const origResolve = existing.resolve;
    const origReject = existing.reject;

    const coalescedPromise = new Promise<string>((resolve, reject) => {
      existing.resolve = (v: string) => { origResolve(v); resolve(v); };
      existing.reject = (e: Error) => { origReject(e); reject(e); };
    });

    totalCoalesced++;
    return coalescedPromise;
  }

  return null;
}

function extractArgValue(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return '';
  return args[idx + 1];
}

function mergeCommaSeparated(a: string, b: string): string {
  const setA = new Set(a ? a.split(',').map(s => s.trim()).filter(Boolean) : []);
  const setB = b ? b.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const item of setB) setA.add(item);
  return [...setA].join(',');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable or disable the write queue feature flag.
 * When disabled, enqueue() executes operations synchronously (bypasses queue).
 */
export function setEnabled(enabled: boolean): void {
  queueEnabled = enabled;
  console.log(`[write-queue] Feature flag: ${enabled ? 'enabled' : 'disabled'}`);
}

/** Check if the write queue is enabled */
export function isEnabled(): boolean {
  return queueEnabled;
}

/**
 * Start the write queue (token refill + drain intervals).
 * Call once during daemon startup.
 */
export function start(): void {
  if (started) return;
  started = true;

  refillInterval = setInterval(refillTokens, REFILL_INTERVAL_MS);
  drainInterval = setInterval(drain, DRAIN_INTERVAL_MS);

  console.log('[write-queue] Started — token bucket (0.5/sec sustained = 30/min, burst 10, critical bypass)');
}

/**
 * Enqueue a GitHub write operation.
 *
 * @param args - The `gh` CLI arguments as an array (e.g., `['issue', 'edit', '42', '--add-label', 'foo']`)
 * @param priority - Priority level: 'critical' (bypass bucket), 'high' (labels), 'normal' (comments), 'low' (best-effort)
 * @returns Promise that resolves with the gh CLI output, or rejects on error
 */
export function enqueue(args: string[], priority: WritePriority = 'normal'): Promise<string> {
  // Feature flag: when disabled, execute synchronously (bypass queue)
  if (!queueEnabled) {
    try {
      const result = execFileSync('gh', args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      totalProcessed++;
      recordWrite();
      return Promise.resolve(result);
    } catch (error: unknown) {
      totalProcessed++;
      recordWrite();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Auto-start if not started (safety net)
  if (!started) start();

  const queue = queues[priority];

  // Queue overflow protection
  if (queue.length >= MAX_QUEUE_DEPTH[priority]) {
    recordDrop();
    return Promise.reject(
      new Error(`Write queue overflow: ${priority} queue at capacity (${MAX_QUEUE_DEPTH[priority]})`)
    );
  }

  // Try to coalesce label edits on the same issue (reduces redundant writes)
  if (priority !== 'critical') {
    const coalescedPromise = tryCoalesceLabels(args, priority);
    if (coalescedPromise) {
      return coalescedPromise;
    }
  }

  return new Promise<string>((resolve, reject) => {
    queue.push({
      args,
      priority,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });
  });
}

/**
 * Gracefully shutdown the write queue.
 * Clears intervals and rejects all pending items.
 */
export function shutdown(): void {
  if (!started) return;

  if (refillInterval) {
    clearInterval(refillInterval);
    refillInterval = null;
  }
  if (drainInterval) {
    clearInterval(drainInterval);
    drainInterval = null;
  }

  // Drain remaining items synchronously (best-effort during shutdown)
  let remaining = 0;
  for (const priority of ['critical', 'high', 'normal', 'low'] as WritePriority[]) {
    remaining += queues[priority].length;
    // Reject all pending items
    while (queues[priority].length > 0) {
      const item = queues[priority].shift()!;
      item.reject(new Error('Write queue shutting down'));
    }
  }

  if (remaining > 0) {
    console.log(`[write-queue] Shutdown — ${remaining} pending operations rejected`);
  }

  started = false;
  console.log('[write-queue] Stopped');
}

/**
 * Get write queue statistics for dashboard monitoring.
 */
export function getStats(): WriteQueueStats {
  return {
    totalProcessed,
    queueDepth: queues.critical.length + queues.high.length + queues.normal.length + queues.low.length,
    queueDepthByPriority: {
      critical: queues.critical.length,
      high: queues.high.length,
      normal: queues.normal.length,
      low: queues.low.length,
    },
    tokensAvailable: tokens,
    secondaryLimitActive,
    secondaryLimitResetsAt: secondaryLimitActive
      ? new Date(secondaryLimitExpiresAt).toISOString()
      : null,
    backoffTier,
    writesPerMinute: getWritesPerMinute(),
    totalDropped,
    totalCoalesced,
    enabled: queueEnabled,
  };
}

/**
 * Reset all state. Intended for testing only.
 */
export function _resetForTesting(): void {
  tokens = MAX_TOKENS;
  for (const priority of ['critical', 'high', 'normal', 'low'] as WritePriority[]) {
    queues[priority].length = 0;
  }
  secondaryLimitActive = false;
  secondaryLimitExpiresAt = 0;
  backoffTier = 0;
  lastSecondaryHitAt = 0;
  totalProcessed = 0;
  totalDropped = 0;
  totalCoalesced = 0;
  queueEnabled = true;
  writeTimestamps.length = 0;
  started = false;

  if (refillInterval) {
    clearInterval(refillInterval);
    refillInterval = null;
  }
  if (drainInterval) {
    clearInterval(drainInterval);
    drainInterval = null;
  }
}
