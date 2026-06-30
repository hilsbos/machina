/**
 * Vitest unit tests for deferral tracker (issue #666).
 *
 * Tests cover:
 * - First deferral is logged (trackDeferral returns true)
 * - Repeat deferral with same reason is suppressed (returns false)
 * - Reason change re-logs (returns true)
 * - Reconciliation detects undeferred issues
 * - Reconciliation clears state for undeferred issues
 * - Error-path scenario: partial cycle (trackDeferral without reconcile) doesn't
 *   corrupt next cycle thanks to resetCurrentCycle()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackDeferral,
  reconcileDeferrals,
  resetCurrentCycle,
  getDeferralState,
  _resetForTesting,
} from './deferral-tracker.js';

beforeEach(() => {
  _resetForTesting();
});

describe('trackDeferral', () => {
  it('returns true on first deferral for an issue', () => {
    expect(trackDeferral(615, 'fritz.depends-on:#614 not closed')).toBe(true);
  });

  it('returns false on repeated deferral with same reason', () => {
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    expect(trackDeferral(615, 'fritz.depends-on:#614 not closed')).toBe(false);
  });

  it('returns true when deferral reason changes for same issue', () => {
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    expect(trackDeferral(615, 'fritz.depends-on:#620 not closed')).toBe(true);
  });

  it('tracks multiple issues independently', () => {
    expect(trackDeferral(615, 'fritz.depends-on:#614 not closed')).toBe(true);
    expect(trackDeferral(616, 'fritz.depends-on:#614 not closed')).toBe(true);
    // Repeat for both
    expect(trackDeferral(615, 'fritz.depends-on:#614 not closed')).toBe(false);
    expect(trackDeferral(616, 'fritz.depends-on:#614 not closed')).toBe(false);
  });
});

describe('reconcileDeferrals', () => {
  it('returns empty when all previously deferred issues are still deferred', () => {
    // Cycle 1: defer issue 615
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    expect(reconcileDeferrals()).toEqual([]);

    // Cycle 2: still deferred
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    expect(reconcileDeferrals()).toEqual([]);
  });

  it('detects issue exiting deferred state', () => {
    // Cycle 1: defer issue 615
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    reconcileDeferrals();

    // Cycle 2: issue 615 is NOT deferred (dependency resolved)
    resetCurrentCycle();
    const undeferred = reconcileDeferrals();
    expect(undeferred).toEqual([
      { issueNumber: 615, previousReason: 'fritz.depends-on:#614 not closed' },
    ]);
  });

  it('clears state for undeferred issues', () => {
    // Cycle 1: defer
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    reconcileDeferrals();

    // Cycle 2: undefer
    resetCurrentCycle();
    reconcileDeferrals(); // clears state

    // Cycle 3: re-defer should be treated as new (returns true)
    resetCurrentCycle();
    expect(trackDeferral(615, 'fritz.depends-on:#614 not closed')).toBe(true);
  });

  it('handles multiple issues with mixed state changes', () => {
    // Cycle 1: defer 615 and 616
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    trackDeferral(616, 'fritz.depends-on:#610 not closed');
    reconcileDeferrals();

    // Cycle 2: 615 still deferred, 616 unblocked
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    const undeferred = reconcileDeferrals();
    expect(undeferred).toEqual([
      { issueNumber: 616, previousReason: 'fritz.depends-on:#610 not closed' },
    ]);
  });
});

describe('getDeferralState', () => {
  it('returns a read-only view of deferral state', () => {
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    const state = getDeferralState();
    expect(state.get(615)).toBe('fritz.depends-on:#614 not closed');
    expect(state.size).toBe(1);
  });
});

describe('error-path: partial cycle without reconcile', () => {
  it('resetCurrentCycle prevents stale entries from corrupting next cycle', () => {
    // Cycle 1: defer 615 and 616, complete normally
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    trackDeferral(616, 'fritz.depends-on:#610 not closed');
    reconcileDeferrals();

    // Cycle 2 (partial/errored): defer only 615, then "crash" — no reconcile called
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    // Simulated error: reconcileDeferrals() is NOT called

    // Cycle 3: starts fresh with resetCurrentCycle()
    // 615 is still deferred, 616 is no longer deferred
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    const undeferred = reconcileDeferrals();

    // 616 should be detected as undeferred (not missed due to stale partial cycle)
    expect(undeferred).toEqual([
      { issueNumber: 616, previousReason: 'fritz.depends-on:#610 not closed' },
    ]);
  });

  it('without resetCurrentCycle, stale entries would cause missed UNDEFERRED', () => {
    // This test demonstrates the bug: if resetCurrentCycle() is NOT called
    // before cycle 3, the stale currentCycleDeferrals from cycle 2 (which
    // included 616) persist, making reconcileDeferrals() think 616 is still
    // deferred and missing the UNDEFERRED event.

    // Cycle 1: defer 615 and 616
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    trackDeferral(616, 'fritz.depends-on:#610 not closed');
    reconcileDeferrals();

    // Cycle 2 (partial): defer 615 and 616, then crash — no reconcile, no reset
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    trackDeferral(616, 'fritz.depends-on:#610 not closed');
    // No reconcile, no resetCurrentCycle after this — simulated error

    // Cycle 3: only 615 deferred — WITHOUT calling resetCurrentCycle() first,
    // so the stale 616 entry from cycle 2 is still in currentCycleDeferrals.
    // This means reconcileDeferrals() will NOT detect 616 as undeferred (the bug).
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    const undeferredWithoutReset = reconcileDeferrals();

    // Bug: 616 is missed because it was in currentCycleDeferrals from cycle 2
    expect(undeferredWithoutReset).toEqual([]);

    // Now demonstrate the fix: call resetCurrentCycle() before re-running cycle 3
    _resetForTesting();
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    // Restore deferralState for 616 (as if cycles 1+2 had run)
    trackDeferral(616, 'fritz.depends-on:#610 not closed');
    reconcileDeferrals(); // commit to deferralState
    resetCurrentCycle();
    trackDeferral(615, 'fritz.depends-on:#614 not closed');
    const undeferredWithReset = reconcileDeferrals();

    // With the fix: 616 is correctly detected as undeferred
    expect(undeferredWithReset).toEqual([
      { issueNumber: 616, previousReason: 'fritz.depends-on:#610 not closed' },
    ]);
  });
});
