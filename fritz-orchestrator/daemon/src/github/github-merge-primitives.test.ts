/**
 * Vitest tests for GitHub merge primitives.
 *
 * Imports actual functions from github.ts (parseDependenciesFromLabels,
 * hasAutoPipeline, DEPENDS_ON_PREFIX, MAX_REWORK_CYCLES) and mocks deps.
 *
 * Also tests CI status, PR state, and merge-related patterns that are
 * used in the autoloop merge handler.
 *
 * Covers:
 * - parseDependenciesFromLabels
 * - hasAutoPipeline
 * - CI status parsing pattern
 * - PR mergeability checking pattern
 * - Post-merge comment generation pattern
 * - PR state determination pattern
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
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

vi.mock('../agents/fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
}));

import {
  parseDependenciesFromLabels,
  hasAutoPipeline,
  DEPENDS_ON_PREFIX,
  MAX_REWORK_CYCLES,
} from './github.js';

// ── Tests ──

describe('parseDependenciesFromLabels (from github.ts)', () => {
  it('extracts issue numbers from fritz.depends-on labels', () => {
    const result = parseDependenciesFromLabels([
      'fritz.status:for-implement',
      'fritz.depends-on:100',
      'fritz.depends-on:200',
      'priority:p1',
    ]);
    expect(result).toEqual([100, 200]);
  });

  it('returns empty array when no fritz.depends-on labels', () => {
    const result = parseDependenciesFromLabels([
      'fritz.status:for-implement',
      'priority:p1',
    ]);
    expect(result).toEqual([]);
  });

  it('filters out non-numeric values', () => {
    const result = parseDependenciesFromLabels([
      'fritz.depends-on:abc',
      'fritz.depends-on:42',
    ]);
    expect(result).toEqual([42]);
  });

  it('handles empty label list', () => {
    expect(parseDependenciesFromLabels([])).toEqual([]);
  });
});

describe('hasAutoPipeline (from github.ts)', () => {
  it('detects auto-pipeline label', () => {
    expect(hasAutoPipeline(1, ['fritz.auto-pipeline', 'priority:p1'])).toBe(true);
  });

  it('returns false when label is absent', () => {
    expect(hasAutoPipeline(1, ['fritz.status:for-implement'])).toBe(false);
  });

  it('returns false for empty labels', () => {
    expect(hasAutoPipeline(1, [])).toBe(false);
  });
});

describe('DEPENDS_ON_PREFIX', () => {
  it('has correct value', () => {
    expect(DEPENDS_ON_PREFIX).toBe('fritz.depends-on:');
  });
});

describe('MAX_REWORK_CYCLES', () => {
  it('is a positive integer', () => {
    expect(MAX_REWORK_CYCLES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_REWORK_CYCLES)).toBe(true);
  });
});

describe('parseCIStatus (pattern)', () => {
  type CIStatus = 'success' | 'failure' | 'pending';

  function parseCIStatus(checkConclusion: string | null, checkStatus: string): CIStatus {
    if (checkStatus === 'completed') {
      return checkConclusion === 'success' ? 'success' : 'failure';
    }
    return 'pending';
  }

  it('returns success for completed+success', () => {
    expect(parseCIStatus('success', 'completed')).toBe('success');
  });

  it('returns failure for completed+failure', () => {
    expect(parseCIStatus('failure', 'completed')).toBe('failure');
  });

  it('returns failure for completed+null conclusion', () => {
    expect(parseCIStatus(null, 'completed')).toBe('failure');
  });

  it('returns pending for in_progress', () => {
    expect(parseCIStatus(null, 'in_progress')).toBe('pending');
  });

  it('returns pending for queued', () => {
    expect(parseCIStatus(null, 'queued')).toBe('pending');
  });
});

describe('isPRMergeable (pattern)', () => {
  function isPRMergeable(mergeableState: string): boolean {
    return mergeableState === 'MERGEABLE';
  }

  it('returns true for MERGEABLE', () => {
    expect(isPRMergeable('MERGEABLE')).toBe(true);
  });

  it('returns false for CONFLICTING', () => {
    expect(isPRMergeable('CONFLICTING')).toBe(false);
  });

  it('returns false for UNKNOWN', () => {
    expect(isPRMergeable('UNKNOWN')).toBe(false);
  });
});

describe('determinePRState (pattern)', () => {
  function determinePRState(stateField: string): 'OPEN' | 'MERGED' | 'CLOSED' {
    const upper = stateField.toUpperCase();
    if (upper === 'MERGED') return 'MERGED';
    if (upper === 'CLOSED') return 'CLOSED';
    return 'OPEN';
  }

  it('detects MERGED state', () => {
    expect(determinePRState('MERGED')).toBe('MERGED');
  });

  it('detects CLOSED state', () => {
    expect(determinePRState('CLOSED')).toBe('CLOSED');
  });

  it('defaults to OPEN for unknown state', () => {
    expect(determinePRState('OPEN')).toBe('OPEN');
  });

  it('handles case-insensitive input', () => {
    expect(determinePRState('merged')).toBe('MERGED');
    expect(determinePRState('Closed')).toBe('CLOSED');
  });
});
