/**
 * Pure utility functions for priority-based issue sorting.
 *
 * Extracted from autoloop.ts so tests can import without triggering
 * side-effect dependencies (config, github, agents, registry).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Priority = 'p0' | 'p1' | 'p2' | 'p3' | null;

export interface PrioritizedIssue {
  number: number;
  priority: Priority;
  labels: string[];
  title?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRIORITY_PREFIX = 'priority:';

export const PRIORITY_WEIGHT: Record<string, number> = {
  'p0': 0,
  'p1': 1,
  'p2': 2,
  'p3': 3,
};

export const NO_PRIORITY_WEIGHT = 4;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function extractPriority(labels: Array<{ name: string }>): Priority {
  const priorityLabel = labels.find(l => l.name.startsWith(PRIORITY_PREFIX));
  if (!priorityLabel) return null;
  const level = priorityLabel.name.slice(PRIORITY_PREFIX.length);
  return (level in PRIORITY_WEIGHT) ? level as Priority : null;
}

export function getPriorityWeight(priority: Priority): number {
  if (priority === null) return NO_PRIORITY_WEIGHT;
  return PRIORITY_WEIGHT[priority] ?? NO_PRIORITY_WEIGHT;
}

export function sortByPriority(issues: PrioritizedIssue[]): PrioritizedIssue[] {
  return [...issues].sort((a, b) =>
    getPriorityWeight(a.priority) - getPriorityWeight(b.priority)
  );
}
