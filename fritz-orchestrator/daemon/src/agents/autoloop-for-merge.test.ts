/**
 * Vitest tests for handleForMerge logic (issue #433, #664, #792).
 *
 * Imports hasAutoPipeline, parseDependenciesFromLabels, and isBranchBehindError
 * from github.ts to provide real source coverage. The handleForMerge function
 * itself is not exported, so the merge flow is tested inline.
 *
 * Covers:
 * - hasAutoPipeline (imported from github.ts)
 * - isBranchBehindError (imported from github.ts)
 * - Successful merge path (pattern)
 * - CI pending (silent retry)
 * - CI failure (escalate to for-human)
 * - Merge conflicts (escalate)
 * - No PR found (escalate)
 * - Transient API error (silent retry)
 * - Merge fails at merge step (escalate)
 * - Race condition (PR already merged)
 * - Branch behind base → transition to for-rework (agent handles rebase)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
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

import { hasAutoPipeline, parseDependenciesFromLabels, isBranchBehindError } from '../github/github.js';

// ── Inline merge handler (mirrors autoloop.ts handleForMerge) ──

import { getTargetRepo } from './repo-gate.js';

interface MockPR { number: number; headRefName: string; baseRefName: string }
interface MockGithub {
  findIssuePR(issue: number, repo?: string): MockPR | null;
  getPRCheckStatus(prNumber: number, repo?: string): 'success' | 'failure' | 'pending';
  isPRMergeable(prNumber: number, repo?: string): boolean;
  mergePR(prNumber: number, repo?: string): void;
  getPRState(prNumber: number, repo?: string): string;
  closeIssue(issue: number): void;
  postComment(issue: number, body: string): void;
  postMergeComment(issue: number, prNumber: number, trigger: 'dashboard'): void;
  transitionStatus(issue: number, from: string, to: string): void;
  removeStatusLabel(issue: number, status: string): void;
}
interface MockLifecycle { system(message: string): void }
interface LoggedEvent { type: string; msg: string; meta?: Record<string, unknown> }

function handleForMerge(
  issue: number, labels: string[], github: MockGithub, lifecycle: MockLifecycle,
  logMessages: string[],
  logEvent: (type: string, msg: string, meta?: Record<string, unknown>) => void = () => {},
): void {
  const targetRepo = getTargetRepo(labels, 'owner/repo');
  let pr: MockPR | null;
  try {
    pr = github.findIssuePR(issue, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessages.push(`#${issue}: Failed to look up PR: ${msg} — will retry`);
    return; // Treat as transient, retry next cycle
  }
  if (!pr) {
    logMessages.push(`#${issue}: No open PR found for merge`);
    lifecycle.system(`Warning *#${issue}* merge failed: no open PR found.`);
    github.transitionStatus(issue, 'for-merge', 'for-human');
    return;
  }
  let ciStatus: 'success' | 'failure' | 'pending';
  try { ciStatus = github.getPRCheckStatus(pr.number, targetRepo); } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessages.push(`#${issue}: Failed CI check: ${msg} — will retry`);
    return;
  }
  switch (ciStatus) {
    case 'pending': logMessages.push(`#${issue}: PR #${pr.number} checks pending — will retry`); return;
    case 'failure':
      logMessages.push(`#${issue}: PR #${pr.number} CI failed`);
      lifecycle.system(`Warning *#${issue}* merge blocked: CI checks failed.`);
      github.transitionStatus(issue, 'for-merge', 'for-human');
      return;
    case 'success': break;
  }
  let mergeable: boolean;
  try { mergeable = github.isPRMergeable(pr.number, targetRepo); } catch {
    logMessages.push(`#${issue}: mergeability check failed — will retry`);
    return;
  }
  if (!mergeable) {
    // Pre-merge conflicts: send to rework agent for rebase (matches the
    // branch-behind path below). Agents have git identity configured.
    logMessages.push(`#${issue}: PR #${pr.number} has merge conflicts — sending to rework agent for rebase`);
    try { github.postComment(issue, 'Rebase required — sending to rework agent'); } catch { /* best effort */ }
    github.transitionStatus(issue, 'for-merge', 'for-rework');
    lifecycle.system(`Warning *#${issue}* PR #${pr.number} has merge conflicts — sent to rework for rebase.`);
    return;
  }
  try { github.mergePR(pr.number, targetRepo); } catch (error: unknown) {
    const prState = github.getPRState(pr.number, targetRepo);
    if (prState === 'MERGED') {
      logMessages.push(`#${issue}: PR #${pr.number} was already merged (race condition)`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);

      // Branch behind base: send to rework agent for rebase (agents have git identity configured)
      if (isBranchBehindError(msg)) {
        logMessages.push(`#${issue}: PR #${pr.number} branch behind — sending to rework agent for rebase`);
        try { github.postComment(issue, 'Rebase required — sending to rework agent'); } catch { /* best effort */ }
        github.transitionStatus(issue, 'for-merge', 'for-rework');
        lifecycle.system(`Warning *#${issue}* branch behind base — sent to rework for rebase.`);
        return;
      } else {
        logMessages.push(`#${issue}: merge failed: ${msg}`);
        lifecycle.system(`Warning *#${issue}* merge failed.`);
        github.transitionStatus(issue, 'for-merge', 'for-human');
        return;
      }
    }
  }
  logEvent('pr.merged', `PR #${pr.number} merged`, { pr: pr.number, issue });
  // Issue lives on the main repo, not the PR repo
  github.closeIssue(issue);
  try { github.postMergeComment(issue, pr.number, 'dashboard'); } catch { /* best effort */ }
  logEvent('issue.done', `Issue #${issue} completed`, { issue, pr: pr.number });
  try { github.removeStatusLabel(issue, 'for-merge'); } catch { /* best effort */ }
  logMessages.push(`#${issue}: Merged PR #${pr.number}`);
  lifecycle.system(`Success *#${issue}* merged PR #${pr.number}.`);
}

function createMockGithub(overrides: Partial<MockGithub> = {}): MockGithub {
  return {
    findIssuePR: () => ({ number: 100, headRefName: 'feature/42-foo', baseRefName: 'main' }),
    getPRCheckStatus: () => 'success',
    isPRMergeable: () => true,
    mergePR: () => {},
    getPRState: () => 'OPEN',
    closeIssue: () => {},
    postComment: () => {},
    postMergeComment: () => {},
    transitionStatus: () => {},
    removeStatusLabel: () => {},
    ...overrides,
  };
}

// ── Tests ──

describe('hasAutoPipeline (imported from github.ts)', () => {
  it('detects auto-pipeline label', () => {
    expect(hasAutoPipeline(1, ['fritz.auto-pipeline', 'priority:p1'])).toBe(true);
  });

  it('returns false when label is absent', () => {
    expect(hasAutoPipeline(1, ['fritz.status:for-implement'])).toBe(false);
  });
});

describe('parseDependenciesFromLabels (imported from github.ts)', () => {
  it('extracts issue numbers', () => {
    expect(parseDependenciesFromLabels(['fritz.depends-on:100', 'fritz.depends-on:200'])).toEqual([100, 200]);
  });
});

describe('handleForMerge', () => {
  it('successfully merges PR, closes issue, and notifies', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];
    const mergedPRs: number[] = [];
    const closedIssues: number[] = [];
    const events: LoggedEvent[] = [];

    const github = createMockGithub({
      mergePR: (pr) => { mergedPRs.push(pr); },
      closeIssue: (issue) => { closedIssues.push(issue); },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleForMerge(42, [], github, lifecycle, logMessages,
      (type, msg, meta) => events.push({ type, msg, meta }));

    expect(mergedPRs).toEqual([100]);
    expect(closedIssues).toEqual([42]);
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('Success');
    expect(events).toHaveLength(2);
  });

  it('CI pending results in silent retry', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];

    const github = createMockGithub({ getPRCheckStatus: () => 'pending' });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleForMerge(42, [], github, lifecycle, logMessages);

    expect(systemMessages).toHaveLength(0);
    expect(logMessages.some(m => m.includes('pending'))).toBe(true);
  });

  it('CI failure escalates to for-human', () => {
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];

    const github = createMockGithub({
      getPRCheckStatus: () => 'failure',
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);
    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-human' }]);
  });

  it('no PR found escalates to for-human', () => {
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];

    const github = createMockGithub({
      findIssuePR: () => null,
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);
    expect(transitions[0].to).toBe('for-human');
  });

  it('findIssuePR API error retries next cycle instead of escalating', () => {
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];

    const github = createMockGithub({
      findIssuePR: () => { throw new Error('API timeout'); },
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);
    expect(transitions).toHaveLength(0); // no escalation
    expect(logMessages.some(m => m.includes('Failed to look up PR') && m.includes('will retry'))).toBe(true);
  });

  it('race condition (PR already merged) treats as success', () => {
    const logMessages: string[] = [];
    const closedIssues: number[] = [];

    const github = createMockGithub({
      mergePR: () => { throw new Error('Pull request already merged'); },
      getPRState: () => 'MERGED',
      closeIssue: (issue) => { closedIssues.push(issue); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);
    expect(closedIssues).toEqual([42]);
    expect(logMessages.some(m => m.includes('race condition'))).toBe(true);
  });

  it('passes cross-repo target to all merge primitives', () => {
    const repoCalls: Record<string, string[]> = {
      findIssuePR: [], getPRCheckStatus: [], isPRMergeable: [], mergePR: [], getPRState: [],
    };
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: (_issue, repo) => { repoCalls.findIssuePR.push(repo!); return { number: 11, headRefName: 'feature/618-ci', baseRefName: 'main' }; },
      getPRCheckStatus: (_pr, repo) => { repoCalls.getPRCheckStatus.push(repo!); return 'success'; },
      isPRMergeable: (_pr, repo) => { repoCalls.isPRMergeable.push(repo!); return true; },
      mergePR: (_pr, repo) => { repoCalls.mergePR.push(repo!); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(618, ['fritz.repo:your-org/fritzbridge'], github, lifecycle, logMessages);

    expect(repoCalls.findIssuePR).toEqual(['your-org/fritzbridge']);
    expect(repoCalls.getPRCheckStatus).toEqual(['your-org/fritzbridge']);
    expect(repoCalls.isPRMergeable).toEqual(['your-org/fritzbridge']);
    expect(repoCalls.mergePR).toEqual(['your-org/fritzbridge']);
  });

  it('defaults to main repo when no fritz.repo: label', () => {
    const repoCalls: string[] = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: (_issue, repo) => { repoCalls.push(repo!); return { number: 100, headRefName: 'feature/42-foo' }; },
      mergePR: (_pr, repo) => { repoCalls.push(repo!); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);

    expect(repoCalls.every(r => r === 'owner/repo')).toBe(true);
  });

  it('pre-merge conflicts (mergeable=false) — transitions to for-rework for agent rebase', () => {
    // Issue #792: the daemon cannot rebase (no git identity), so when GitHub
    // reports mergeable=false, send to rework agent instead of escalating to
    // a human. Mirrors the branch-behind handling below.
    const logMessages: string[] = [];
    const closedIssues: number[] = [];
    const comments: string[] = [];
    const transitions: { from: string; to: string }[] = [];
    const systemMessages: string[] = [];

    const github = createMockGithub({
      isPRMergeable: () => false,
      closeIssue: (issue) => { closedIssues.push(issue); },
      postComment: (_issue, body) => { comments.push(body); },
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleForMerge(42, [], github, lifecycle, logMessages);

    // Issue NOT closed — sent to rework
    expect(closedIssues).toEqual([]);
    // Transition to for-rework (agent handles rebase / conflict resolution)
    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-rework' }]);
    expect(logMessages.some(m => m.includes('sending to rework agent for rebase'))).toBe(true);
    expect(comments.some(c => c.includes('rework agent'))).toBe(true);
    expect(systemMessages.some(m => m.includes('sent to rework'))).toBe(true);
  });

  it('pre-merge conflicts with cross-repo labels — transitions to for-rework', () => {
    const transitions: { from: string; to: string }[] = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: () => ({ number: 11, headRefName: 'feature/618-ci', baseRefName: 'main' }),
      isPRMergeable: () => false,
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(618, ['fritz.repo:your-org/fritzbridge'], github, lifecycle, logMessages);

    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-rework' }]);
  });

  it('branch behind base — transitions to for-rework for agent rebase', () => {
    const logMessages: string[] = [];
    const closedIssues: number[] = [];
    const comments: string[] = [];
    const transitions: { from: string; to: string }[] = [];

    const github = createMockGithub({
      mergePR: () => { throw new Error('Pull Request is not up to date with the base branch'); },
      getPRState: () => 'OPEN',
      closeIssue: (issue) => { closedIssues.push(issue); },
      postComment: (_issue, body) => { comments.push(body); },
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);

    // Issue NOT closed — sent to rework
    expect(closedIssues).toEqual([]);
    // Transition to for-rework (agent handles rebase)
    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-rework' }]);
    expect(logMessages.some(m => m.includes('sending to rework agent for rebase'))).toBe(true);
    expect(comments.some(c => c.includes('rework agent'))).toBe(true);
  });

  it('non-"branch behind" merge errors still escalate directly to for-human', () => {
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];

    const github = createMockGithub({
      mergePR: () => { throw new Error('Repository rule violations found'); },
      getPRState: () => 'OPEN',
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(42, [], github, lifecycle, logMessages);

    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-human' }]);
    expect(logMessages.some(m => m.includes('merge failed'))).toBe(true);
  });

  it('branch behind with cross-repo labels — transitions to for-rework', () => {
    const transitions: { from: string; to: string }[] = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: () => ({ number: 11, headRefName: 'feature/618-ci', baseRefName: 'main' }),
      mergePR: () => { throw new Error('not up to date'); },
      getPRState: () => 'OPEN',
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    handleForMerge(618, ['fritz.repo:your-org/fritzbridge'], github, lifecycle, logMessages);

    expect(transitions).toEqual([{ from: 'for-merge', to: 'for-rework' }]);
  });
});

describe('isBranchBehindError (imported from github.ts)', () => {
  it('detects "not up to date" error', () => {
    expect(isBranchBehindError('Pull Request is not up to date with the base branch')).toBe(true);
  });

  it('detects "out-of-date" error', () => {
    expect(isBranchBehindError('Branch out-of-date with base branch')).toBe(true);
  });

  it('detects "out of date" error', () => {
    expect(isBranchBehindError('The head branch is out of date')).toBe(true);
  });

  it('detects "Head branch was modified" error', () => {
    expect(isBranchBehindError('Head branch was modified. Review and try the merge again.')).toBe(true);
  });

  it('returns false for unrelated merge errors', () => {
    expect(isBranchBehindError('Repository rule violations found')).toBe(false);
    expect(isBranchBehindError('Admin approval required')).toBe(false);
  });

  it('returns false for CI failure messages (not branch-behind)', () => {
    expect(isBranchBehindError('Required status check "CI" is expected')).toBe(false);
  });
});
