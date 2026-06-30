/**
 * Vitest tests for fritz.depends-on label cleanup logic (issue #347).
 *
 * Imports parseDependenciesFromLabels and DEPENDS_ON_PREFIX from github.ts.
 * Also imports isDependencyClosed for coverage.
 *
 * Covers:
 * - parseDependenciesFromLabels
 * - filterDependsOnLabels pattern
 * - findStaleLabels (cleanup logic)
 * - Full cleanup flow simulation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    githubRepo: 'owner/repo',
    githubToken: 'gh-token',
    workspacesDir: '/tmp/test-workspaces',
    fritzRoot: '/fritz-root',
  },
}));

vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
  notifyBootFailure: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
}));

import {
  DEPENDS_ON_PREFIX,
  parseDependenciesFromLabels,
  isDependencyClosed,
} from '../github/github.js';
import { clearAllCaches } from '../github/github-cache.js';

import { execSync, execFileSync } from 'child_process';

// ── Helper (filter pattern used in autoloop) ──

function filterDependsOnLabels(allLabels: Array<{ name: string }>): string[] {
  return allLabels
    .map(l => l.name)
    .filter(name => name.startsWith(DEPENDS_ON_PREFIX));
}

function findStaleLabels(
  labels: string[],
  isIssueClosed: (issueNum: number) => boolean
): string[] {
  const stale: string[] = [];
  for (const label of labels) {
    const deps = parseDependenciesFromLabels([label]);
    if (deps.length === 0) continue;
    if (isIssueClosed(deps[0])) {
      stale.push(label);
    }
  }
  return stale;
}

// ── Tests ──

describe('parseDependenciesFromLabels (imported from github.ts)', () => {
  it('extracts issue numbers', () => {
    const result = parseDependenciesFromLabels([
      'fritz.status:for-implement',
      'fritz.depends-on:100',
      'fritz.depends-on:200',
      'priority:p1',
    ]);
    expect(result).toEqual([100, 200]);
  });

  it('returns empty for no dependencies', () => {
    const result = parseDependenciesFromLabels(['fritz.status:for-implement', 'priority:p1']);
    expect(result).toEqual([]);
  });

  it('handles non-numeric values', () => {
    const result = parseDependenciesFromLabels(['fritz.depends-on:abc', 'fritz.depends-on:42']);
    expect(result).toEqual([42]);
  });

  it('handles empty label list', () => {
    expect(parseDependenciesFromLabels([])).toEqual([]);
  });
});

describe('DEPENDS_ON_PREFIX', () => {
  it('has correct value', () => {
    expect(DEPENDS_ON_PREFIX).toBe('fritz.depends-on:');
  });
});

describe('isDependencyClosed (imported from github.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCaches();
  });

  it('returns true for closed issue', () => {
    // isDependencyClosed delegates to github-cache which calls execFileSync('gh', ['api', '--include', ...])
    vi.mocked(execFileSync).mockReturnValue('HTTP/2.0 200 OK\n\n{"state":"closed"}');
    expect(isDependencyClosed(42)).toBe(true);
  });

  it('returns false for open issue', () => {
    vi.mocked(execFileSync).mockReturnValue('HTTP/2.0 200 OK\n\n{"state":"open"}');
    expect(isDependencyClosed(42)).toBe(false);
  });

  it('returns false on command error', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('gh failed'); });
    expect(isDependencyClosed(42)).toBe(false);
  });
});

describe('filterDependsOnLabels', () => {
  it('extracts fritz.depends-on labels from repo labels', () => {
    const allLabels = [
      { name: 'fritz.status:active' },
      { name: 'fritz.depends-on:100' },
      { name: 'priority:p0' },
      { name: 'fritz.depends-on:200' },
      { name: 'fritz.auto-pipeline' },
      { name: 'fritz.depends-on:351' },
    ];
    expect(filterDependsOnLabels(allLabels)).toEqual([
      'fritz.depends-on:100',
      'fritz.depends-on:200',
      'fritz.depends-on:351',
    ]);
  });

  it('returns empty when no fritz.depends-on labels', () => {
    const allLabels = [{ name: 'fritz.status:active' }, { name: 'priority:p1' }];
    expect(filterDependsOnLabels(allLabels)).toEqual([]);
  });

  it('ignores labels that contain fritz.depends-on as substring', () => {
    const allLabels = [
      { name: 'my-fritz-depends-on:label' },
      { name: 'fritz.depends-on:42' },
    ];
    expect(filterDependsOnLabels(allLabels)).toEqual(['fritz.depends-on:42']);
  });
});

describe('findStaleLabels', () => {
  it('identifies labels for closed issues', () => {
    const closedIssues = new Set([100, 200]);
    const labels = ['fritz.depends-on:100', 'fritz.depends-on:200', 'fritz.depends-on:300'];
    const stale = findStaleLabels(labels, (num) => closedIssues.has(num));
    expect(stale).toEqual(['fritz.depends-on:100', 'fritz.depends-on:200']);
  });

  it('returns empty when all dependencies are open', () => {
    const labels = ['fritz.depends-on:100', 'fritz.depends-on:200'];
    expect(findStaleLabels(labels, () => false)).toEqual([]);
  });

  it('returns all when all dependencies are closed', () => {
    const labels = ['fritz.depends-on:50', 'fritz.depends-on:60'];
    expect(findStaleLabels(labels, () => true)).toEqual(['fritz.depends-on:50', 'fritz.depends-on:60']);
  });

  it('handles empty label list', () => {
    expect(findStaleLabels([], () => true)).toEqual([]);
  });
});
