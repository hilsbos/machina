/**
 * Vitest tests for handleForReview merge conflict detection (issue #670, #702, #792).
 *
 * Uses the behavioral mirror pattern — mirrors the handleForReview logic
 * inline and verifies the expected behavior with mock dependencies.
 *
 * Covers:
 * - MERGEABLE → spawn review agent
 * - CONFLICTING → post conflict comment + transition to for-rework (agent handles rebase)
 * - UNKNOWN → retry once, then proceed
 * - No PR found → proceed with review
 * - API error → proceed with review (fail-open)
 * - Conflict comment includes file cross-references
 * - Cross-repo labels passed through to API calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
}));

import { getTargetRepo } from './repo-gate.js';

// ── Mock types ──

interface MockPR { number: number; headRefName: string; baseRefName: string }
interface MockGithub {
  findIssuePR(issue: number, repo?: string): MockPR | null;
  getPRMergeableStatus(prNumber: number, repo?: string): string;
  getPRFiles(prNumber: number, repo?: string): string[];
  listOpenPRsWithFiles(repo?: string): Array<{ number: number; headRefName: string; files: string[] }>;
  postComment(issue: number, body: string): Promise<void>;
  transitionStatus(issue: number, from: string, to: string): void;
}
interface MockLifecycle { system(message: string): void }

// ── Behavioral mirror of handleForReview ──

const mergeableRetries = new Map<number, number>();

async function handleForReview(
  issue: number,
  labels: string[],
  github: MockGithub,
  lifecycle: MockLifecycle,
  logMessages: string[],
  cycleCount: number,
  spawnedAgents: Array<{ issue: number; role: string }>,
): Promise<void> {
  const targetRepo = getTargetRepo(labels, 'owner/repo');
  let pr: MockPR | null;
  try {
    pr = github.findIssuePR(issue, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessages.push(`#${issue}: Failed to look up PR: ${msg} — will retry next cycle`);
    return; // Treat as transient, retry next cycle
  }

  if (!pr) {
    spawnedAgents.push({ issue, role: 'review' });
    return;
  }

  let mergeableStatus: string;
  try {
    mergeableStatus = github.getPRMergeableStatus(pr.number, targetRepo);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessages.push(`#${issue}: Failed to check mergeable status: ${msg} — proceeding with review`);
    spawnedAgents.push({ issue, role: 'review' });
    return;
  }

  switch (mergeableStatus) {
    case 'MERGEABLE':
      mergeableRetries.delete(issue);
      spawnedAgents.push({ issue, role: 'review' });
      return;

    case 'UNKNOWN': {
      const firstSeen = mergeableRetries.get(issue);
      if (firstSeen === undefined) {
        mergeableRetries.set(issue, cycleCount);
        logMessages.push(`#${issue}: PR #${pr.number} mergeable status UNKNOWN — will retry next cycle`);
        return;
      }
      logMessages.push(`#${issue}: PR #${pr.number} mergeable status still UNKNOWN after retry — proceeding with review`);
      mergeableRetries.delete(issue);
      spawnedAgents.push({ issue, role: 'review' });
      return;
    }

    case 'CONFLICTING': {
      mergeableRetries.delete(issue);
      logMessages.push(`#${issue}: PR #${pr.number} has merge conflicts — sending to rework agent for rebase`);

      // Gather conflict context for the rework agent
      const prFiles = github.getPRFiles(pr.number, targetRepo);
      const otherPRs = github.listOpenPRsWithFiles(targetRepo)
        .filter(p => p.number !== pr.number);

      const conflictingPRs: Array<{ number: number; sharedFiles: string[] }> = [];
      for (const other of otherPRs) {
        const sharedFiles = prFiles.filter(f => other.files.includes(f));
        if (sharedFiles.length > 0) {
          conflictingPRs.push({ number: other.number, sharedFiles });
        }
      }

      let comment = `⚠️ **Merge Conflict — Rebase Required**\n\n`;
      comment += `PR #${pr.number} has merge conflicts and needs rebasing onto \`${pr.baseRefName}\`.\n\n`;

      if (prFiles.length > 0) {
        comment += `**Files in this PR:**\n`;
        for (const f of prFiles) {
          comment += `- \`${f}\`\n`;
        }
        comment += `\n`;
      }

      if (conflictingPRs.length > 0) {
        comment += `**Other open PRs touching the same files:**\n`;
        for (const cp of conflictingPRs) {
          comment += `- PR #${cp.number}: ${cp.sharedFiles.map(f => `\`${f}\``).join(', ')}\n`;
        }
        comment += `\n`;
      }

      comment += `**Action:** Rebase onto \`${pr.baseRefName}\`, resolve conflicts`;
      if (conflictingPRs.length > 0) {
        comment += ` (check PRs ${conflictingPRs.map(p => `#${p.number}`).join(', ')} for context)`;
      }
      comment += `, then push.\n\n`;
      comment += `---\n🤖 Detected by fritZ autoloop merge conflict check`;

      try {
        await github.postComment(issue, comment);
      } catch {
        logMessages.push(`#${issue}: Failed to post conflict comment`);
      }

      github.transitionStatus(issue, 'for-review', 'for-rework');
      lifecycle.system(`⚠️ *#${issue}* PR #${pr.number} has merge conflicts — sent to rework agent for rebase.`);
      return;
    }

    default:
      logMessages.push(`#${issue}: PR #${pr.number} unexpected mergeable status "${mergeableStatus}" — proceeding with review`);
      spawnedAgents.push({ issue, role: 'review' });
      return;
  }
}

function createMockGithub(overrides: Partial<MockGithub> = {}): MockGithub {
  return {
    findIssuePR: () => ({ number: 100, headRefName: 'feature/42-foo', baseRefName: 'main' }),
    getPRMergeableStatus: () => 'MERGEABLE',
    getPRFiles: () => ['src/file1.ts', 'src/file2.ts'],
    listOpenPRsWithFiles: () => [],
    postComment: async () => {},
    transitionStatus: () => {},
    ...overrides,
  };
}

// ── Tests ──

describe('handleForReview — merge conflict detection', () => {
  beforeEach(() => {
    mergeableRetries.clear();
  });

  it('MERGEABLE — spawns review agent', async () => {
    const logMessages: string[] = [];
    const spawnedAgents: Array<{ issue: number; role: string }> = [];

    const github = createMockGithub({ getPRMergeableStatus: () => 'MERGEABLE' });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(spawnedAgents).toEqual([{ issue: 42, role: 'review' }]);
    expect(logMessages).toHaveLength(0);
  });

  it('CONFLICTING — transitions to for-rework for agent rebase', async () => {
    const transitions: { from: string; to: string }[] = [];
    const postedComments: string[] = [];
    const systemMessages: string[] = [];
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      getPRMergeableStatus: () => 'CONFLICTING',
      getPRFiles: () => ['src/autoloop.ts', 'src/config.ts'],
      listOpenPRsWithFiles: () => [
        { number: 200, headRefName: 'feature/200-other', files: ['src/autoloop.ts', 'src/other.ts'] },
        { number: 300, headRefName: 'feature/300-unrelated', files: ['src/unrelated.ts'] },
      ],
      postComment: async (_issue, body) => { postedComments.push(body); },
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    // No review agent spawned — sent to rework instead
    expect(spawnedAgents).toHaveLength(0);

    // Transition to for-rework
    expect(transitions).toEqual([{ from: 'for-review', to: 'for-rework' }]);

    // Conflict comment posted with file details
    const conflictComment = postedComments.find(c => c.includes('Rebase Required'));
    expect(conflictComment).toBeDefined();
    expect(conflictComment).toContain('`src/autoloop.ts`');
    // Cross-references PR #200 which touches autoloop.ts
    expect(conflictComment).toContain('PR #200');
    // Does NOT reference PR #300 (no shared files)
    expect(conflictComment).not.toContain('PR #300');

    // System notification sent
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('merge conflicts');
    expect(systemMessages[0]).toContain('rework agent for rebase');
  });

  it('UNKNOWN first time — retries next cycle', async () => {
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({ getPRMergeableStatus: () => 'UNKNOWN' });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 5, spawnedAgents);

    // No agent spawned — waiting for retry
    expect(spawnedAgents).toHaveLength(0);
    expect(logMessages.some(m => m.includes('UNKNOWN') && m.includes('retry'))).toBe(true);
    // Retry flag set
    expect(mergeableRetries.has(42)).toBe(true);
  });

  it('UNKNOWN second time — proceeds with review', async () => {
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    // Set retry flag from previous cycle
    mergeableRetries.set(42, 5);

    const github = createMockGithub({ getPRMergeableStatus: () => 'UNKNOWN' });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 6, spawnedAgents);

    // Agent spawned on second try
    expect(spawnedAgents).toEqual([{ issue: 42, role: 'review' }]);
    // Retry flag cleared
    expect(mergeableRetries.has(42)).toBe(false);
  });

  it('no PR found — proceeds with review', async () => {
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({ findIssuePR: () => null });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(spawnedAgents).toEqual([{ issue: 42, role: 'review' }]);
  });

  it('findIssuePR API error — retries next cycle (fail-open)', async () => {
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: () => { throw new Error('API timeout'); },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(spawnedAgents).toHaveLength(0); // no agent spawned — retry next cycle
    expect(logMessages.some(m => m.includes('Failed to look up PR') && m.includes('will retry'))).toBe(true);
  });

  it('API error checking mergeable — proceeds with review (fail-open)', async () => {
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      getPRMergeableStatus: () => { throw new Error('API timeout'); },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(spawnedAgents).toEqual([{ issue: 42, role: 'review' }]);
    expect(logMessages.some(m => m.includes('API timeout'))).toBe(true);
  });

  it('CONFLICTING with no file cross-references — still transitions to for-rework', async () => {
    const transitions: { from: string; to: string }[] = [];
    const postedComments: string[] = [];
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      getPRMergeableStatus: () => 'CONFLICTING',
      getPRFiles: () => ['src/unique-file.ts'],
      listOpenPRsWithFiles: () => [
        { number: 200, headRefName: 'feature/200-other', files: ['src/other.ts'] },
      ],
      postComment: async (_issue, body) => { postedComments.push(body); },
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(spawnedAgents).toHaveLength(0);
    expect(transitions).toEqual([{ from: 'for-review', to: 'for-rework' }]);
    // Conflict comment should not contain "Other open PRs" section
    const conflictComment = postedComments.find(c => c.includes('Rebase Required'));
    expect(conflictComment).toBeDefined();
    expect(conflictComment).not.toContain('Other open PRs');
  });

  it('cross-repo labels are passed through to all API calls', async () => {
    const repoCalls: Record<string, string[]> = {
      findIssuePR: [], getPRMergeableStatus: [], getPRFiles: [], listOpenPRsWithFiles: [],
    };
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      findIssuePR: (_issue, repo) => { repoCalls.findIssuePR.push(repo!); return { number: 100, headRefName: 'feature/42-foo' }; },
      getPRMergeableStatus: (_pr, repo) => { repoCalls.getPRMergeableStatus.push(repo!); return 'MERGEABLE'; },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, ['fritz.repo:your-org/fritzbridge'], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(repoCalls.findIssuePR).toEqual(['your-org/fritzbridge']);
    expect(repoCalls.getPRMergeableStatus).toEqual(['your-org/fritzbridge']);
  });

  it('CONFLICTING with cross-repo labels — passes target repo to conflict analysis', async () => {
    const prFileRepoCalls: string[] = [];
    const transitions: { from: string; to: string }[] = [];
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    const github = createMockGithub({
      getPRMergeableStatus: () => 'CONFLICTING',
      getPRFiles: (_pr, repo) => { prFileRepoCalls.push(repo!); return ['src/file.ts']; },
      listOpenPRsWithFiles: () => [],
      postComment: async () => {},
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, ['fritz.repo:your-org/fritzbridge'], github, lifecycle, logMessages, 1, spawnedAgents);

    expect(prFileRepoCalls).toEqual(['your-org/fritzbridge']);
    expect(spawnedAgents).toHaveLength(0);
    expect(transitions).toEqual([{ from: 'for-review', to: 'for-rework' }]);
  });

  it('CONFLICTING clears any previous UNKNOWN retry flag', async () => {
    const transitions: { from: string; to: string }[] = [];
    const spawnedAgents: Array<{ issue: number; role: string }> = [];
    const logMessages: string[] = [];

    // Previous cycle set UNKNOWN retry
    mergeableRetries.set(42, 5);

    const github = createMockGithub({
      getPRMergeableStatus: () => 'CONFLICTING',
      postComment: async () => {},
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: () => {} };

    await handleForReview(42, [], github, lifecycle, logMessages, 6, spawnedAgents);

    expect(mergeableRetries.has(42)).toBe(false);
    expect(transitions).toEqual([{ from: 'for-review', to: 'for-rework' }]);
  });
});

// ── Tests for github.ts new functions ──

import { getPRMergeableStatus, getPRFiles, listOpenPRsWithFiles } from '../github/github.js';
import { execSync } from 'child_process';

describe('getPRMergeableStatus', () => {
  it('returns MERGEABLE when PR is mergeable', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({ mergeable: 'MERGEABLE' }));
    expect(getPRMergeableStatus(100)).toBe('MERGEABLE');
  });

  it('returns CONFLICTING when PR has conflicts', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({ mergeable: 'CONFLICTING' }));
    expect(getPRMergeableStatus(100)).toBe('CONFLICTING');
  });

  it('returns UNKNOWN when GitHub is still computing', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({ mergeable: 'UNKNOWN' }));
    expect(getPRMergeableStatus(100)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when mergeable field is missing', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({}));
    expect(getPRMergeableStatus(100)).toBe('UNKNOWN');
  });
});

describe('getPRFiles', () => {
  it('returns file paths from PR', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify({
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    }));
    expect(getPRFiles(100)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty array on error', () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('fail'); });
    expect(getPRFiles(100)).toEqual([]);
  });
});

describe('listOpenPRsWithFiles', () => {
  it('returns PRs with files', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(JSON.stringify([
      { number: 10, headRefName: 'feature/10-a', files: [{ path: 'src/a.ts' }] },
      { number: 20, headRefName: 'feature/20-b', files: [{ path: 'src/b.ts' }] },
    ]));
    const result = listOpenPRsWithFiles();
    expect(result).toHaveLength(2);
    expect(result[0].files).toEqual(['src/a.ts']);
  });

  it('returns empty array on error', () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('fail'); });
    expect(listOpenPRsWithFiles()).toEqual([]);
  });
});
