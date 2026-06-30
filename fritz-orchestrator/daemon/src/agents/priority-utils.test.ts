/**
 * Unit tests for priority-utils.ts
 *
 * Covers: extractPriority, getPriorityWeight, sortByPriority,
 *         PRIORITY_PREFIX, PRIORITY_WEIGHT, NO_PRIORITY_WEIGHT
 */

import { describe, it, expect } from 'vitest';
import {
  extractPriority,
  getPriorityWeight,
  sortByPriority,
  PRIORITY_PREFIX,
  PRIORITY_WEIGHT,
  NO_PRIORITY_WEIGHT,
  type PrioritizedIssue,
} from './priority-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('PRIORITY_PREFIX is "priority:"', () => {
    expect(PRIORITY_PREFIX).toBe('priority:');
  });

  it('PRIORITY_WEIGHT has p0-p3 weights in ascending order', () => {
    expect(PRIORITY_WEIGHT['p0']).toBe(0);
    expect(PRIORITY_WEIGHT['p1']).toBe(1);
    expect(PRIORITY_WEIGHT['p2']).toBe(2);
    expect(PRIORITY_WEIGHT['p3']).toBe(3);
  });

  it('NO_PRIORITY_WEIGHT is 4 (lower priority than p3)', () => {
    expect(NO_PRIORITY_WEIGHT).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// extractPriority
// ---------------------------------------------------------------------------

describe('extractPriority', () => {
  it('returns p0 for priority:p0 label', () => {
    const result = extractPriority([
      { name: 'fritz.status:for-implement' },
      { name: 'priority:p0' },
      { name: 'type:feature' },
    ]);
    expect(result).toBe('p0');
  });

  it('returns p1 for priority:p1 label', () => {
    expect(extractPriority([{ name: 'priority:p1' }])).toBe('p1');
  });

  it('returns p2 for priority:p2 label', () => {
    expect(extractPriority([{ name: 'priority:p2' }])).toBe('p2');
  });

  it('returns p3 for priority:p3 label', () => {
    expect(extractPriority([{ name: 'priority:p3' }])).toBe('p3');
  });

  it('returns null when no priority label exists', () => {
    const result = extractPriority([
      { name: 'fritz.status:for-implement' },
      { name: 'type:bug' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for empty labels array', () => {
    expect(extractPriority([])).toBeNull();
  });

  it('returns null for unknown priority level (e.g., priority:p5)', () => {
    expect(extractPriority([{ name: 'priority:p5' }])).toBeNull();
  });

  it('uses first match when multiple priority labels exist', () => {
    const result = extractPriority([
      { name: 'priority:p2' },
      { name: 'priority:p0' },
    ]);
    expect(result).toBe('p2');
  });

  it('ignores labels that merely contain "priority" as a substring', () => {
    const result = extractPriority([
      { name: 'high-priority' },
      { name: 'no-priority-here' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for priority label with empty level', () => {
    // "priority:" with nothing after it
    expect(extractPriority([{ name: 'priority:' }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPriorityWeight
// ---------------------------------------------------------------------------

describe('getPriorityWeight', () => {
  it('returns 0 for p0', () => {
    expect(getPriorityWeight('p0')).toBe(0);
  });

  it('returns 1 for p1', () => {
    expect(getPriorityWeight('p1')).toBe(1);
  });

  it('returns 2 for p2', () => {
    expect(getPriorityWeight('p2')).toBe(2);
  });

  it('returns 3 for p3', () => {
    expect(getPriorityWeight('p3')).toBe(3);
  });

  it('returns NO_PRIORITY_WEIGHT (4) for null', () => {
    expect(getPriorityWeight(null)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// sortByPriority
// ---------------------------------------------------------------------------

describe('sortByPriority', () => {
  it('sorts mixed priorities correctly (p0 first, unprioritized last)', () => {
    const input: PrioritizedIssue[] = [
      { number: 10, priority: 'p3', labels: [] },
      { number: 20, priority: 'p0', labels: [] },
      { number: 30, priority: null, labels: [] },
      { number: 40, priority: 'p1', labels: [] },
      { number: 50, priority: 'p2', labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(20); // p0
    expect(sorted[1].number).toBe(40); // p1
    expect(sorted[2].number).toBe(50); // p2
    expect(sorted[3].number).toBe(10); // p3
    expect(sorted[4].number).toBe(30); // null
  });

  it('preserves order for same priority (stable sort)', () => {
    const input: PrioritizedIssue[] = [
      { number: 1, priority: 'p1', labels: [] },
      { number: 2, priority: 'p1', labels: [] },
      { number: 3, priority: 'p1', labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(1);
    expect(sorted[1].number).toBe(2);
    expect(sorted[2].number).toBe(3);
  });

  it('handles empty array', () => {
    const sorted = sortByPriority([]);
    expect(sorted).toHaveLength(0);
  });

  it('handles single element', () => {
    const sorted = sortByPriority([{ number: 42, priority: 'p2', labels: [] }]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].number).toBe(42);
  });

  it('preserves order for all unprioritized issues', () => {
    const input: PrioritizedIssue[] = [
      { number: 5, priority: null, labels: [] },
      { number: 3, priority: null, labels: [] },
      { number: 7, priority: null, labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(5);
    expect(sorted[1].number).toBe(3);
    expect(sorted[2].number).toBe(7);
  });

  it('does not mutate the input array', () => {
    const input: PrioritizedIssue[] = [
      { number: 10, priority: 'p3', labels: [] },
      { number: 20, priority: 'p0', labels: [] },
    ];

    const inputCopy = [...input];
    sortByPriority(input);

    expect(input[0].number).toBe(inputCopy[0].number);
    expect(input[1].number).toBe(inputCopy[1].number);
  });

  it('puts p0 issues first regardless of input position', () => {
    const input: PrioritizedIssue[] = [
      { number: 100, priority: null, labels: [] },
      { number: 101, priority: 'p3', labels: [] },
      { number: 102, priority: null, labels: [] },
      { number: 103, priority: 'p0', labels: [] },
      { number: 104, priority: 'p2', labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(103); // p0
    expect(sorted[1].number).toBe(104); // p2
    expect(sorted[2].number).toBe(101); // p3
    expect(sorted[3].priority).toBeNull();
    expect(sorted[4].priority).toBeNull();
  });

  // --- Integration: extractPriority + sortByPriority ---

  it('end-to-end: parse labels then sort', () => {
    const ghResponse = [
      { number: 50, labels: [{ name: 'fritz.status:for-implement' }, { name: 'type:feature' }] },
      { number: 51, labels: [{ name: 'fritz.status:for-implement' }, { name: 'priority:p1' }] },
      { number: 52, labels: [{ name: 'fritz.status:for-implement' }, { name: 'priority:p0' }, { name: 'type:bug' }] },
      { number: 53, labels: [{ name: 'fritz.status:for-implement' }, { name: 'priority:p3' }] },
    ];

    const issues: PrioritizedIssue[] = ghResponse.map(i => ({
      number: i.number,
      priority: extractPriority(i.labels),
      labels: i.labels.map(l => l.name),
    }));

    const sorted = sortByPriority(issues);

    expect(sorted[0].number).toBe(52);
    expect(sorted[0].priority).toBe('p0');
    expect(sorted[1].number).toBe(51);
    expect(sorted[1].priority).toBe('p1');
    expect(sorted[2].number).toBe(53);
    expect(sorted[2].priority).toBe('p3');
    expect(sorted[3].number).toBe(50);
    expect(sorted[3].priority).toBeNull();
  });
});
