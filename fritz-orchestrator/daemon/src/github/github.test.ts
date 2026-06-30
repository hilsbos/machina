/**
 * Vitest tests for GitHub utility functions.
 *
 * Imports actual functions from github.ts and mocks child_process and other deps.
 *
 * Covers:
 * - DEPENDS_ON_PREFIX constant
 * - parseDependenciesFromLabels
 * - hasAutoPipeline detection
 * - getIssueLabels (mocked gh)
 * - getIssueTitle (mocked gh)
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

vi.mock('../agents/fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getCommentLevel: vi.fn(() => 'verbose'),
}));

vi.mock('./github-cache.js', () => ({
  invalidateAll: vi.fn(),
  invalidateIssue: vi.fn(),
  invalidateIssueList: vi.fn(),
}));

vi.mock('./github-graphql.js', () => ({
  getCachedIssues: vi.fn(() => null),
}));

vi.mock('../agents/boot.js', () => ({
  execAsync: vi.fn(async () => ''),
}));

import {
  DEPENDS_ON_PREFIX,
  parseDependenciesFromLabels,
  hasAutoPipeline,
  getIssueLabels,
  getIssueTitle,
  gh,
  MAX_REWORK_CYCLES,
  releaseAgent,
  assignAgent,
  isSecondaryRateLimit,
  RATE_LIMIT_RETRY_DELAYS_MS,
  _setRetrySleep,
  getOrphanRestoreStatus,
} from './github.js';

import { execSync } from 'child_process';
import { execFileSync } from 'child_process';

// ── Tests ──

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

describe('parseDependenciesFromLabels', () => {
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

describe('hasAutoPipeline', () => {
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

describe('getIssueLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses labels from gh output', () => {
    // gh() uses execSync with encoding:'utf-8' which returns string, and splits by newline
    vi.mocked(execSync).mockReturnValue('fritz.status:for-implement\npriority:p1\n');
    const labels = getIssueLabels(42);
    expect(labels).toContain('fritz.status:for-implement');
    expect(labels).toContain('priority:p1');
  });

  it('returns empty array on empty output', () => {
    vi.mocked(execSync).mockReturnValue('');
    const labels = getIssueLabels(42);
    expect(labels).toEqual([]);
  });

  it('returns empty array on command failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('gh failed'); });
    const labels = getIssueLabels(42);
    expect(labels).toEqual([]);
  });
});

describe('getIssueTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns title from gh output', () => {
    // gh() uses execSync with encoding:'utf-8' which returns a string
    vi.mocked(execSync).mockReturnValue('Fix the login bug\n');
    const title = getIssueTitle(42);
    expect(title).toBe('Fix the login bug');
  });

  it('returns null on command failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('gh failed'); });
    const title = getIssueTitle(42);
    expect(title).toBeNull();
  });
});

// Helper: mock that returns PR data for findIssuePR calls (needed when implement + completed)
const MOCK_PR_JSON = JSON.stringify([{ number: 99, headRefName: 'feature/42-test' }]);

function mockExecWithPR(calls: string[], labelResponse: string | Error) {
  vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
    calls.push((args as string[]).join(' '));
    return '';
  });
  return (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes('--json labels')) {
      if (labelResponse instanceof Error) throw labelResponse;
      return labelResponse;
    }
    // findIssuePR: return a valid PR for "pr list" calls
    if (cmd.includes('pr list')) {
      return MOCK_PR_JSON;
    }
    return '';
  };
}

describe('releaseAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only removes labels that are actually present on the issue', async () => {
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation(
      mockExecWithPR(calls, 'fritz.status:active\nfritz.skill:implement\npriority:p1\n')
    );

    await releaseAgent(42, 'agent-1', 'implement', 'completed');

    // The remove-label call should NOT include fritz.status:blocked
    const removeLabelCall = calls.find(c => c.includes('--remove-label'));
    expect(removeLabelCall).toBeDefined();
    expect(removeLabelCall).toContain('fritz.status:active');
    expect(removeLabelCall).toContain('fritz.skill:implement');
    expect(removeLabelCall).not.toContain('fritz.status:blocked');
  });

  it('always removes active and skill labels even when blocked is not present', async () => {
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation(
      mockExecWithPR(calls, 'priority:p1\nbug\n')
    );

    await releaseAgent(43, 'agent-2', 'implement', 'completed');

    // active and skill labels should still be attempted for removal
    const removeLabelCall = calls.find(c => c.includes('--remove-label'));
    expect(removeLabelCall).toBeDefined();
    expect(removeLabelCall).toContain('fritz.status:active');
    expect(removeLabelCall).toContain('fritz.skill:implement');
    expect(removeLabelCall).not.toContain('fritz.status:blocked');
  });

  it('removes blocked label when it is actually present', async () => {
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation(
      mockExecWithPR(calls, 'fritz.status:active\nfritz.status:blocked\nfritz.skill:implement\n')
    );

    await releaseAgent(44, 'agent-3', 'implement', 'completed');

    const removeLabelCall = calls.find(c => c.includes('--remove-label'));
    expect(removeLabelCall).toBeDefined();
    expect(removeLabelCall).toContain('fritz.status:blocked');
    expect(removeLabelCall).toContain('fritz.status:active');
    expect(removeLabelCall).toContain('fritz.skill:implement');
  });

  it('still removes active and skill labels when getIssueLabels fails', async () => {
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation(
      mockExecWithPR(calls, new Error('API timeout'))
    );

    await releaseAgent(45, 'agent-4', 'implement', 'completed');

    // active and skill labels should still be removed even when label fetch fails
    const removeLabelCall = calls.find(c => c.includes('--remove-label'));
    expect(removeLabelCall).toBeDefined();
    expect(removeLabelCall).toContain('fritz.status:active');
    expect(removeLabelCall).toContain('fritz.skill:implement');
    // blocked should NOT be in the removal list since we couldn't confirm it exists
    expect(removeLabelCall).not.toContain('fritz.status:blocked');
  });

  it('escalates to for-human when implement completes but no PR exists', async () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
      calls.push((args as string[]).join(' '));
      return '';
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('--json labels')) {
        return 'fritz.status:active\nfritz.skill:implement\n';
      }
      // findIssuePR: return empty arrays (no PR found)
      if (cmd.includes('pr list')) {
        return '[]';
      }
      return '';
    });

    await releaseAgent(50, 'agent-no-pr', 'implement', 'completed');

    // Should add for-human label instead of for-review
    const addLabelCall = calls.find(c => c.includes('--add-label'));
    expect(addLabelCall).toBeDefined();
    expect(addLabelCall).toContain('fritz.status:for-human');
    expect(addLabelCall).not.toContain('fritz.status:for-review');

    // Should post a warning comment
    const commentCall = calls.find(c => c.includes('issue comment') && c.includes('PR verification failed'));
    expect(commentCall).toBeDefined();
  });

  it('transitions to for-review when implement completes and PR exists', async () => {
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation(
      mockExecWithPR(calls, 'fritz.status:active\nfritz.skill:implement\n')
    );

    await releaseAgent(51, 'agent-with-pr', 'implement', 'completed');

    // Should add for-review label (PR exists)
    const addLabelCall = calls.find(c => c.includes('--add-label'));
    expect(addLabelCall).toBeDefined();
    expect(addLabelCall).toContain('fritz.status:for-review');
  });

  it('skips PR escalation when findIssuePR throws (API error)', async () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
      calls.push((args as string[]).join(' '));
      return '';
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('--json labels')) {
        return 'fritz.status:active\nfritz.skill:implement\n';
      }
      // findIssuePR: simulate API failure
      if (cmd.includes('pr list')) {
        throw new Error('API timeout');
      }
      return '';
    });

    await releaseAgent(53, 'agent-api-err', 'implement', 'completed');

    // Should NOT escalate to for-human — API error means we can't verify, not that PR is missing
    const addLabelCall = calls.find(c => c.includes('--add-label'));
    expect(addLabelCall).toBeDefined();
    expect(addLabelCall).toContain('fritz.status:for-review');
    expect(addLabelCall).not.toContain('fritz.status:for-human');
  });

  it('skips PR verification for non-implement roles', async () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
      calls.push((args as string[]).join(' '));
      return '';
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('--json labels')) {
        return 'fritz.status:active\nfritz.skill:review\n';
      }
      // No PR data returned — but shouldn't matter for review role
      if (cmd.includes('pr list')) {
        return '[]';
      }
      return '';
    });

    await releaseAgent(52, 'agent-review', 'review', 'completed');

    // Should add for-validate (normal review success path), NOT for-human
    const addLabelCall = calls.find(c => c.includes('--add-label'));
    expect(addLabelCall).toBeDefined();
    expect(addLabelCall).toContain('fritz.status:for-validate');
  });
});

describe('assignAgent batched label operations (Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('combines remove+add into a single gh edit call when old status labels exist', async () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
      const argStr = (args as string[]).join(' ');
      calls.push(argStr);
      return '';
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      calls.push(cmd);
      // Return existing status label to trigger remove
      if (cmd.includes('--json labels') || cmd.includes("--jq '.labels")) {
        return 'fritz.status:for-implement\npriority:p1\n';
      }
      return '';
    });

    await assignAgent(42, 'implement', 'agent-1', 120);

    // Single edit call with both --remove-label and --add-label
    const editCalls = calls.filter(c => c.includes('--add-label') && c.includes('issue') && c.includes('edit'));
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toContain('--remove-label');
    expect(editCalls[0]).toContain('fritz.status:for-implement');
    expect(editCalls[0]).toContain('fritz.skill:implement,fritz.status:active');
  });

  // Verify-retry test removed: Phase 1 (#685) eliminated the post-edit label verification
  // step to reduce API calls. The write queue's retry logic handles transient failures.
  it('uses single combined edit (no verify-retry) per Phase 1 optimization', async () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation((_prog: string, args: unknown) => {
      const argStr = (args as string[]).join(' ');
      calls.push(argStr);
      return '';
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('--json labels') || cmd.includes("--jq '.labels")) {
        return 'fritz.status:for-implement\npriority:p1\n';
      }
      return '';
    });

    await assignAgent(42, 'implement', 'agent-1', 120);

    // Phase 1: single edit call combines --remove-label and --add-label
    const editCalls = calls.filter(c => c.includes('--add-label'));
    expect(editCalls).toHaveLength(1);

    // The single edit should include both remove and add
    expect(editCalls[0]).toContain('--remove-label');
    expect(editCalls[0]).toContain('--add-label');
  });
});

describe('gh utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No-op sleep so retry tests don't actually block
    _setRetrySleep(() => {});
  });

  afterEach(() => {
    // Restore default sleep to avoid leaking the no-op into other test suites
    _setRetrySleep(() => {});
  });

  it('calls execSync with gh command', () => {
    vi.mocked(execSync).mockReturnValue('output');
    const result = gh('issue list --json number');
    expect(execSync).toHaveBeenCalled();
    expect(result).toBe('output');
  });

  it('throws on command failure', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command failed'); });
    expect(() => gh('bad command')).toThrow();
  });

  it('retries on secondary rate limit and succeeds', () => {
    let attempt = 0;
    vi.mocked(execSync).mockImplementation(() => {
      attempt++;
      if (attempt === 1) throw new Error('secondary rate limit exceeded');
      return 'ok';
    });
    const result = gh('issue list');
    expect(result).toBe('ok');
    // 2 calls to gh (1 fail + 1 success)
    expect(execSync).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 times on rate limit then throws', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('You have been rate limited. 429 secondary rate limit');
    });
    expect(() => gh('issue list')).toThrow();
    // 4 total attempts (1 initial + 3 retries)
    expect(execSync).toHaveBeenCalledTimes(4);
  });

  it('does not retry on non-rate-limit errors', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    expect(() => gh('issue view 999')).toThrow('not found');
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('retries on "submitted too quickly" error', () => {
    let attempt = 0;
    vi.mocked(execSync).mockImplementation(() => {
      attempt++;
      if (attempt <= 2) throw new Error('was submitted too quickly');
      return 'done';
    });
    const result = gh('issue comment 1');
    expect(result).toBe('done');
    expect(execSync).toHaveBeenCalledTimes(3);
  });
});

// ── isSecondaryRateLimit tests ──

describe('isSecondaryRateLimit', () => {
  it('detects "secondary rate limit" message', () => {
    expect(isSecondaryRateLimit(new Error('secondary rate limit exceeded'))).toBe(true);
  });

  it('detects "submitted too quickly" message', () => {
    expect(isSecondaryRateLimit(new Error('was submitted too quickly'))).toBe(true);
  });

  it('detects "abuse detection" message', () => {
    expect(isSecondaryRateLimit(new Error('abuse detection mechanism'))).toBe(true);
  });

  it('detects 429 status code in message', () => {
    expect(isSecondaryRateLimit(new Error('HTTP 429'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isSecondaryRateLimit(new Error('not found'))).toBe(false);
    expect(isSecondaryRateLimit(new Error('authentication failed'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isSecondaryRateLimit('429 rate limit')).toBe(true);
    expect(isSecondaryRateLimit('random string')).toBe(false);
  });
});

// ── RATE_LIMIT_RETRY_DELAYS_MS tests ──

describe('RATE_LIMIT_RETRY_DELAYS_MS', () => {
  it('has 3 retry delays', () => {
    expect(RATE_LIMIT_RETRY_DELAYS_MS).toHaveLength(3);
  });

  it('uses 10s, 30s, 60s backoff', () => {
    expect(RATE_LIMIT_RETRY_DELAYS_MS).toEqual([10_000, 30_000, 60_000]);
  });
});

// ── getOrphanRestoreStatus tests ──

describe('getOrphanRestoreStatus', () => {
  it('maps implement to for-rework when had activity', () => {
    expect(getOrphanRestoreStatus('implement')).toBe('for-rework');
    expect(getOrphanRestoreStatus('implement', true)).toBe('for-rework');
  });

  it('maps implement to for-implement when no activity (0 turns)', () => {
    expect(getOrphanRestoreStatus('implement', false)).toBe('for-implement');
  });

  it('maps review to for-review', () => {
    expect(getOrphanRestoreStatus('review')).toBe('for-review');
  });

  it('maps validate to for-validate', () => {
    expect(getOrphanRestoreStatus('validate')).toBe('for-validate');
  });

  it('maps define to for-define', () => {
    expect(getOrphanRestoreStatus('define')).toBe('for-define');
  });

  it('maps architect to for-architect', () => {
    expect(getOrphanRestoreStatus('architect')).toBe('for-architect');
  });

  it('maps ux to for-ux', () => {
    expect(getOrphanRestoreStatus('ux')).toBe('for-ux');
  });

  it('maps budget to for-budget', () => {
    expect(getOrphanRestoreStatus('budget')).toBe('for-budget');
  });

  it('maps security-review to for-security-review', () => {
    expect(getOrphanRestoreStatus('security-review')).toBe('for-security-review');
  });

  it('maps pentest to for-pentest', () => {
    expect(getOrphanRestoreStatus('pentest')).toBe('for-pentest');
  });

  it('maps retro to for-human (no re-entry point)', () => {
    expect(getOrphanRestoreStatus('retro')).toBe('for-human');
  });

  it('falls back to for-human for unknown roles', () => {
    expect(getOrphanRestoreStatus('unknown')).toBe('for-human');
    expect(getOrphanRestoreStatus('')).toBe('for-human');
  });

  it('0-turn mode differs only for implement', () => {
    // All roles except implement return the same status regardless of hadActivity
    expect(getOrphanRestoreStatus('review', false)).toBe('for-review');
    expect(getOrphanRestoreStatus('validate', false)).toBe('for-validate');
    expect(getOrphanRestoreStatus('define', false)).toBe('for-define');
    expect(getOrphanRestoreStatus('architect', false)).toBe('for-architect');
    expect(getOrphanRestoreStatus('ux', false)).toBe('for-ux');
    expect(getOrphanRestoreStatus('budget', false)).toBe('for-budget');
    expect(getOrphanRestoreStatus('security-review', false)).toBe('for-security-review');
    expect(getOrphanRestoreStatus('pentest', false)).toBe('for-pentest');
    expect(getOrphanRestoreStatus('retro', false)).toBe('for-human');
    expect(getOrphanRestoreStatus('unknown', false)).toBe('for-human');
  });
});
