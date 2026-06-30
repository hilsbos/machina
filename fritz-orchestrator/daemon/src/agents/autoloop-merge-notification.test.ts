/**
 * Vitest tests for auto-pipeline validated → for-merge transition (issue #343, #692).
 *
 * Imports hasAutoPipeline from github.ts for real source coverage.
 * The handleAutoPipelineValidated logic is inline since it's not exported.
 *
 * Covers:
 * - hasAutoPipeline (imported from github.ts)
 * - Auto-pipeline issues transition validated → for-merge (skipping human gate)
 * - Notification on successful transition
 * - Notification on transition failure
 * - No transition when no auto-pipeline label
 * - Notification message format
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

vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
}));

import { hasAutoPipeline } from '../github/github.js';

// ── Inline handler (mirrors autoloop.ts handleAutoPipelineValidated) ──

interface MockGithub {
  hasAutoPipeline(issue: number, labels: string[]): boolean;
  transitionStatus(issue: number, from: string, to: string): void;
}

interface MockLifecycle {
  system(message: string): void;
}

function handleAutoPipelineValidated(
  issue: number, labels: string[], github: MockGithub,
  lifecycle: MockLifecycle, logMessages: string[]
): void {
  if (!github.hasAutoPipeline(issue, labels)) return;

  logMessages.push(`#${issue}: Auto-pipeline enabled, transitioning validated → for-merge`);
  try {
    github.transitionStatus(issue, 'validated', 'for-merge');
    lifecycle.system(`🔄 *#${issue}* auto-pipeline: skipped human gate, advanced to for-merge.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessages.push(`#${issue}: Failed to auto-transition validated → for-merge: ${msg} — escalating to for-human`);
    lifecycle.system(`⚠️ *#${issue}* auto-pipeline failed: could not transition validated → for-merge. ${msg}. Escalating to human.`);
    github.transitionStatus(issue, 'validated', 'for-human');
  }
}

// ── Tests ──

describe('hasAutoPipeline (imported from github.ts)', () => {
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

function createMockGithub(overrides: Partial<MockGithub> = {}): MockGithub {
  return {
    hasAutoPipeline: () => true,
    transitionStatus: () => {},
    ...overrides,
  };
}

describe('handleAutoPipelineValidated', () => {
  it('transitions validated → for-merge and sends notification', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];
    const github = createMockGithub({
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleAutoPipelineValidated(100, ['fritz.auto-pipeline'], github, lifecycle, logMessages);

    expect(transitions).toEqual([{ from: 'validated', to: 'for-merge' }]);
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('for-merge');
    expect(systemMessages[0]).toContain('#100');
  });

  it('sends error notification and escalates to for-human on transition failure', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];
    let callCount = 0;
    const github = createMockGithub({
      transitionStatus: (_issue: number, from: string, to: string) => {
        callCount++;
        if (callCount === 1) throw new Error('API error');
        // Second call (for-human escalation) succeeds
        transitions.push({ from, to });
      },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleAutoPipelineValidated(300, ['fritz.auto-pipeline'], github, lifecycle, logMessages);

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain('failed');
    expect(systemMessages[0]).toContain('API error');
    expect(systemMessages[0]).toContain('Escalating to human');
    expect(logMessages.some(m => m.includes('escalating to for-human'))).toBe(true);
    expect(transitions).toEqual([{ from: 'validated', to: 'for-human' }]);
  });

  it('skips transition when no auto-pipeline label', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];
    const transitions: { from: string; to: string }[] = [];
    const github = createMockGithub({
      hasAutoPipeline: () => false,
      transitionStatus: (_issue, from, to) => { transitions.push({ from, to }); },
    });
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleAutoPipelineValidated(400, [], github, lifecycle, logMessages);

    expect(systemMessages).toHaveLength(0);
    expect(logMessages).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it('uses Telegram-safe markdown format', () => {
    const systemMessages: string[] = [];
    const logMessages: string[] = [];
    const github = createMockGithub();
    const lifecycle = { system: (msg: string) => systemMessages.push(msg) };

    handleAutoPipelineValidated(77, ['fritz.auto-pipeline'], github, lifecycle, logMessages);

    expect(systemMessages[0]).toContain('*#77*');
  });
});
