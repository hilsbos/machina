/**
 * Deferral Tracker — suppresses repeated AGENT-DEFERRED log entries.
 *
 * Tracks per-issue deferral state so the autoloop logs a deferral event only
 * once per (issue, reason) combination.  Re-logs when the reason changes or
 * the issue exits the deferred state (AGENT-UNDEFERRED).
 *
 * The state map lives in autoloop process scope and resets on daemon restart
 * (acceptable — restarts are infrequent and a single re-log on startup is fine).
 */

/**
 * Persistent deferral state: issue number → last logged deferral reason.
 * Survives across cycles; only cleared when an issue is undeferred.
 */
const deferralState = new Map<number, string>();

/**
 * Issues deferred during the current autoloop cycle.
 * Reset at the start of each cycle via `resetCurrentCycle()`.
 * Used by `reconcileDeferrals()` to detect issues that left the deferred state.
 */
const currentCycleDeferrals = new Set<number>();

/** Read-only view of the deferral state map (for dashboard/debugging). */
export function getDeferralState(): ReadonlyMap<number, string> {
  return deferralState;
}

/**
 * Reset the current-cycle tracking set.
 * MUST be called at the start of every `check()` invocation — including
 * cycles that throw — so stale entries from a partial/errored cycle
 * don't leak into the next successful one.
 */
export function resetCurrentCycle(): void {
  currentCycleDeferrals.clear();
}

/**
 * Track a deferral event for an issue.
 *
 * @returns `true` if this is a new deferral (or reason changed) and should be logged.
 *          `false` if the same (issue, reason) was already logged — suppress.
 */
export function trackDeferral(issueNumber: number, reason: string): boolean {
  currentCycleDeferrals.add(issueNumber);

  const previousReason = deferralState.get(issueNumber);
  if (previousReason === reason) {
    return false; // Already logged this exact deferral — suppress
  }

  deferralState.set(issueNumber, reason);
  return true; // New deferral or reason changed — log it
}

/**
 * Reconcile end-of-cycle: detect issues that were previously deferred but
 * were NOT deferred this cycle (i.e. they became unblocked or were removed).
 *
 * @returns Array of `{ issueNumber, previousReason }` for issues that exited
 *          the deferred state this cycle (should be logged as AGENT-UNDEFERRED).
 */
export function reconcileDeferrals(): Array<{ issueNumber: number; previousReason: string }> {
  const undeferred: Array<{ issueNumber: number; previousReason: string }> = [];

  for (const [issueNumber, previousReason] of deferralState) {
    if (!currentCycleDeferrals.has(issueNumber)) {
      undeferred.push({ issueNumber, previousReason });
    }
  }

  // Clean up state for undeferred issues
  for (const { issueNumber } of undeferred) {
    deferralState.delete(issueNumber);
  }

  return undeferred;
}

/**
 * Clear all state — used in tests.
 * @internal
 */
export function _resetForTesting(): void {
  deferralState.clear();
  currentCycleDeferrals.clear();
}
