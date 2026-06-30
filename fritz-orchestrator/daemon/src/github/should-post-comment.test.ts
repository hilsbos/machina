/**
 * Vitest unit tests for shouldPostComment() gating logic and related utilities.
 *
 * Tests all comment types × all comment levels (3×11 = 33 cases),
 * plus cleanupLifecycleComment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fritz-config to control comment level
let mockCommentLevel = 'essential';

vi.mock('../agents/fritz-config.js', () => ({
  getCommentLevel: () => mockCommentLevel,
}));

// Minimal mocks for github.ts dependencies
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

vi.mock('./github-cache.js', () => ({
  invalidateAll: vi.fn(),
  invalidateIssue: vi.fn(),
}));

vi.mock('./github-graphql.js', () => ({
  getCachedIssues: vi.fn(() => null),
}));

vi.mock('./github-write-queue.js', () => ({
  enqueue: vi.fn(async () => ''),
}));

vi.mock('../agents/boot.js', () => ({
  execAsync: vi.fn(async () => ''),
}));

import { shouldPostComment, cleanupLifecycleComment, _testLifecycle, type GitHubCommentType } from './github.js';
import * as githubWriteQueue from './github-write-queue.js';

const ALL_TYPES: GitHubCommentType[] = [
  'agent-started',
  'agent-finished',
  'progress',
  'complete',
  'blocked',
  'auto-pipeline-transition',
  'auto-pipeline-merge',
  'rework-escalation',
  'dependency-cycle',
  'skill-summary',
  'conflict',
];

const ALWAYS_POST_TYPES: GitHubCommentType[] = [
  'blocked',
  'rework-escalation',
  'dependency-cycle',
  'skill-summary',
  'conflict',
];

const QUIET_EXTRA_TYPES: GitHubCommentType[] = [
  'agent-started',
  'agent-finished',
];

const VERBOSE_ONLY_TYPES: GitHubCommentType[] = [
  'progress',
  'complete',
  'auto-pipeline-transition',
  'auto-pipeline-merge',
];

describe('shouldPostComment', () => {
  beforeEach(() => {
    mockCommentLevel = 'essential';
  });

  describe('verbose mode — all comments posted', () => {
    it('posts all comment types', () => {
      mockCommentLevel = 'verbose';
      for (const type of ALL_TYPES) {
        expect(shouldPostComment(type)).toBe(true);
      }
    });
  });

  describe('essential mode — only critical comments', () => {
    it('posts always-post types', () => {
      mockCommentLevel = 'essential';
      for (const type of ALWAYS_POST_TYPES) {
        expect(shouldPostComment(type)).toBe(true);
      }
    });

    it('skips lifecycle comments', () => {
      mockCommentLevel = 'essential';
      for (const type of QUIET_EXTRA_TYPES) {
        expect(shouldPostComment(type)).toBe(false);
      }
    });

    it('skips verbose-only comments', () => {
      mockCommentLevel = 'essential';
      for (const type of VERBOSE_ONLY_TYPES) {
        expect(shouldPostComment(type)).toBe(false);
      }
    });
  });

  describe('quiet mode — critical + lifecycle comments', () => {
    it('posts always-post types', () => {
      mockCommentLevel = 'quiet';
      for (const type of ALWAYS_POST_TYPES) {
        expect(shouldPostComment(type)).toBe(true);
      }
    });

    it('posts lifecycle comments', () => {
      mockCommentLevel = 'quiet';
      for (const type of QUIET_EXTRA_TYPES) {
        expect(shouldPostComment(type)).toBe(true);
      }
    });

    it('skips verbose-only comments', () => {
      mockCommentLevel = 'quiet';
      for (const type of VERBOSE_ONLY_TYPES) {
        expect(shouldPostComment(type)).toBe(false);
      }
    });
  });

  describe('exhaustive matrix (all types × all levels)', () => {
    const expected: Record<string, Record<GitHubCommentType, boolean>> = {
      essential: {
        'agent-started': false,
        'agent-finished': false,
        'progress': false,
        'complete': false,
        'blocked': true,
        'auto-pipeline-transition': false,
        'auto-pipeline-merge': false,
        'rework-escalation': true,
        'dependency-cycle': true,
        'skill-summary': true,
        'conflict': true,
      },
      quiet: {
        'agent-started': true,
        'agent-finished': true,
        'progress': false,
        'complete': false,
        'blocked': true,
        'auto-pipeline-transition': false,
        'auto-pipeline-merge': false,
        'rework-escalation': true,
        'dependency-cycle': true,
        'skill-summary': true,
        'conflict': true,
      },
      verbose: {
        'agent-started': true,
        'agent-finished': true,
        'progress': true,
        'complete': true,
        'blocked': true,
        'auto-pipeline-transition': true,
        'auto-pipeline-merge': true,
        'rework-escalation': true,
        'dependency-cycle': true,
        'skill-summary': true,
        'conflict': true,
      },
    };

    for (const [level, typeMap] of Object.entries(expected)) {
      for (const [type, shouldPost] of Object.entries(typeMap)) {
        it(`${level} + ${type} → ${shouldPost ? 'post' : 'skip'}`, () => {
          mockCommentLevel = level;
          expect(shouldPostComment(type as GitHubCommentType)).toBe(shouldPost);
        });
      }
    }
  });
});

describe('cleanupLifecycleComment', () => {
  it('does not throw when cleaning up non-existent agent', () => {
    expect(() => cleanupLifecycleComment('nonexistent-agent')).not.toThrow();
  });
});

describe('postLifecycleComment (edit-in-place flow)', () => {
  const mockEnqueue = vi.mocked(githubWriteQueue.enqueue);

  beforeEach(() => {
    mockCommentLevel = 'quiet';
    mockEnqueue.mockReset();
    _testLifecycle.lifecycleCommentIds.clear();
    _testLifecycle.lifecycleStartContexts.clear();
  });

  it('quiet mode agent-started: posts via gh api and stores comment ID', async () => {
    mockEnqueue.mockResolvedValueOnce(JSON.stringify({ id: 12345 }));

    await _testLifecycle.postLifecycleComment(1, 'test-agent', 'Started body', 'agent-started');

    // Should call gh api (not gh issue comment) to get comment ID
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const args = mockEnqueue.mock.calls[0][0];
    expect(args[0]).toBe('api');
    expect(args[1]).toContain('/issues/1/comments');
    expect(args).toContain('body=Started body');

    // Should store the comment ID
    expect(_testLifecycle.lifecycleCommentIds.get('test-agent')).toBe(12345);
  });

  it('quiet mode agent-finished: edits existing comment via PATCH', async () => {
    // Pre-set a lifecycle comment ID (simulating prior agent-started)
    _testLifecycle.lifecycleCommentIds.set('test-agent', 12345);
    mockEnqueue.mockResolvedValueOnce('');

    await _testLifecycle.postLifecycleComment(1, 'test-agent', 'Finished body', 'agent-finished');

    // Should call PATCH to edit existing comment
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const args = mockEnqueue.mock.calls[0][0];
    expect(args[0]).toBe('api');
    expect(args).toContain('-X');
    expect(args).toContain('PATCH');
    expect(args[1]).toContain('/issues/comments/12345');

    // Should clean up the comment ID
    expect(_testLifecycle.lifecycleCommentIds.has('test-agent')).toBe(false);
  });

  it('quiet mode agent-finished: falls back to new comment when edit fails', async () => {
    // Pre-set a lifecycle comment ID
    _testLifecycle.lifecycleCommentIds.set('test-agent', 99999);
    // First call (PATCH edit) fails, second call (fallback post) succeeds
    mockEnqueue
      .mockRejectedValueOnce(new Error('Not Found'))
      .mockResolvedValueOnce('');

    await _testLifecycle.postLifecycleComment(1, 'test-agent', 'Finished body', 'agent-finished');

    // First call: attempted PATCH
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    const patchArgs = mockEnqueue.mock.calls[0][0];
    expect(patchArgs).toContain('PATCH');

    // Second call: fallback to normal comment post
    const fallbackArgs = mockEnqueue.mock.calls[1][0];
    expect(fallbackArgs[0]).toBe('issue');
    expect(fallbackArgs[1]).toBe('comment');

    // Should clean up the comment ID
    expect(_testLifecycle.lifecycleCommentIds.has('test-agent')).toBe(false);
  });

  it('quiet mode agent-finished without prior started comment: posts normally', async () => {
    // No lifecycleCommentId set — agent-finished without paired start
    mockEnqueue.mockResolvedValueOnce('');

    await _testLifecycle.postLifecycleComment(1, 'test-agent', 'Finished body', 'agent-finished');

    // Should post via normal gh issue comment
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const args = mockEnqueue.mock.calls[0][0];
    expect(args[0]).toBe('issue');
    expect(args[1]).toBe('comment');
  });

  it('verbose mode: posts normally without tracking comment ID', async () => {
    mockCommentLevel = 'verbose';
    mockEnqueue.mockResolvedValueOnce('');

    await _testLifecycle.postLifecycleComment(1, 'test-agent', 'Started body', 'agent-started');

    // Should post via normal gh issue comment (not gh api)
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const args = mockEnqueue.mock.calls[0][0];
    expect(args[0]).toBe('issue');
    expect(args[1]).toBe('comment');

    // Should NOT store a comment ID
    expect(_testLifecycle.lifecycleCommentIds.has('test-agent')).toBe(false);
  });
});
