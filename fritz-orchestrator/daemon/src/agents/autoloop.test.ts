/**
 * Vitest unit tests for autoloop:
 * - Priority-based sorting (issue #267)
 * - Repo target resolution helpers
 */

import { describe, it, expect } from 'vitest';
import {
  extractPriority,
  getPriorityWeight,
  sortByPriority,
  type PrioritizedIssue,
} from './priority-utils.js';
import { getTargetRepo } from './repo-gate.js';

// ============================================================================
// extractPriority() tests
// ============================================================================

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
    const result = extractPriority([{ name: 'priority:p1' }]);
    expect(result).toBe('p1');
  });

  it('returns p2 for priority:p2 label', () => {
    const result = extractPriority([{ name: 'priority:p2' }]);
    expect(result).toBe('p2');
  });

  it('returns p3 for priority:p3 label', () => {
    const result = extractPriority([{ name: 'priority:p3' }]);
    expect(result).toBe('p3');
  });

  it('returns null for no priority label', () => {
    const result = extractPriority([
      { name: 'fritz.status:for-implement' },
      { name: 'type:bug' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for empty labels', () => {
    const result = extractPriority([]);
    expect(result).toBeNull();
  });

  it('returns null for unknown priority level (e.g., priority:p5)', () => {
    const result = extractPriority([{ name: 'priority:p5' }]);
    expect(result).toBeNull();
  });

  it('with multiple priority labels uses first match', () => {
    const result = extractPriority([
      { name: 'priority:p2' },
      { name: 'priority:p0' },
    ]);
    expect(result).toBe('p2');
  });

  it('ignores labels that merely contain "priority" substring', () => {
    const result = extractPriority([
      { name: 'high-priority' },
      { name: 'no-priority-here' },
    ]);
    expect(result).toBeNull();
  });
});

// ============================================================================
// getPriorityWeight() tests
// ============================================================================

describe('getPriorityWeight', () => {
  it('returns correct weights for each priority level', () => {
    expect(getPriorityWeight('p0')).toBe(0);
    expect(getPriorityWeight('p1')).toBe(1);
    expect(getPriorityWeight('p2')).toBe(2);
    expect(getPriorityWeight('p3')).toBe(3);
    expect(getPriorityWeight(null)).toBe(4);
  });
});

// ============================================================================
// sortByPriority() tests
// ============================================================================

describe('sortByPriority', () => {
  it('sorts mixed priorities correctly', () => {
    const input: PrioritizedIssue[] = [
      { number: 10, priority: 'p3', labels: [] },
      { number: 20, priority: 'p0', labels: [] },
      { number: 30, priority: null, labels: [] },
      { number: 40, priority: 'p1', labels: [] },
      { number: 50, priority: 'p2', labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(20);  // p0
    expect(sorted[1].number).toBe(40);  // p1
    expect(sorted[2].number).toBe(50);  // p2
    expect(sorted[3].number).toBe(10);  // p3
    expect(sorted[4].number).toBe(30);  // null
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

  it('handles all unprioritized issues', () => {
    const input: PrioritizedIssue[] = [
      { number: 5, priority: null, labels: [] },
      { number: 3, priority: null, labels: [] },
      { number: 7, priority: null, labels: [] },
    ];

    const sorted = sortByPriority(input);

    // All have same weight, order should be preserved (stable sort)
    expect(sorted[0].number).toBe(5);
    expect(sorted[1].number).toBe(3);
    expect(sorted[2].number).toBe(7);
  });

  it('does not mutate input array', () => {
    const input: PrioritizedIssue[] = [
      { number: 10, priority: 'p3', labels: [] },
      { number: 20, priority: 'p0', labels: [] },
    ];

    const inputCopy = [...input];
    sortByPriority(input);

    expect(input[0].number).toBe(inputCopy[0].number);
    expect(input[1].number).toBe(inputCopy[1].number);
  });

  it('p0 issues always bubble to top regardless of position', () => {
    const input: PrioritizedIssue[] = [
      { number: 100, priority: null, labels: [] },
      { number: 101, priority: 'p3', labels: [] },
      { number: 102, priority: null, labels: [] },
      { number: 103, priority: 'p0', labels: [] },
      { number: 104, priority: 'p2', labels: [] },
    ];

    const sorted = sortByPriority(input);

    expect(sorted[0].number).toBe(103);  // p0 first
    expect(sorted[1].number).toBe(104);  // p2 second
    expect(sorted[2].number).toBe(101);  // p3 third
    expect(sorted[3].priority).toBeNull();
    expect(sorted[4].priority).toBeNull();
  });
});

// ============================================================================
// Integration: extractPriority + sortByPriority together
// ============================================================================

describe('end-to-end: parse labels then sort', () => {
  it('correctly processes GitHub-like issue data', () => {
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

// ============================================================================
// Repo target resolution helpers
// ============================================================================

describe('getTargetRepo', () => {
  const DEFAULT_REPO = 'your-org/fritZ';

  it('extracts repo from fritz.repo: label', () => {
    expect(getTargetRepo(['fritz.status:for-implement', 'fritz.repo:your-org/other-repo'], DEFAULT_REPO)).toBe('your-org/other-repo');
  });

  it('strips branch suffix from fritz.repo: label', () => {
    expect(getTargetRepo(['fritz.repo:your-org/other-repo:feature-branch'], DEFAULT_REPO)).toBe('your-org/other-repo');
  });

  it('falls back to defaultRepo when no repo label', () => {
    expect(getTargetRepo(['fritz.status:for-implement', 'priority:p1'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
  });

  it('returns defaultRepo for empty labels', () => {
    expect(getTargetRepo([], DEFAULT_REPO)).toBe(DEFAULT_REPO);
  });

  it('uses first fritz.repo: label when multiple exist', () => {
    expect(getTargetRepo(['fritz.repo:your-org/first', 'fritz.repo:your-org/second'], DEFAULT_REPO)).toBe('your-org/first');
  });

  it('rejects shell metacharacters and falls back to default', () => {
    expect(getTargetRepo(['fritz.repo:; rm -rf /'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:$(whoami)/repo'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:owner/repo && echo pwned'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:owner/repo`id`'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
  });

  it('rejects empty or malformed repo values', () => {
    expect(getTargetRepo(['fritz.repo:'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:noslash'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:/leading-slash'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
    expect(getTargetRepo(['fritz.repo:owner/'], DEFAULT_REPO)).toBe(DEFAULT_REPO);
  });

  it('allows valid repo names with dots, hyphens, underscores', () => {
    expect(getTargetRepo(['fritz.repo:my-org/my_repo.js'], DEFAULT_REPO)).toBe('my-org/my_repo.js');
  });
});

