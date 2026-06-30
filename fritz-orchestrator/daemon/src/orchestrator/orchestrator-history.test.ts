/**
 * Tests for OrchestratorHistoryBuffer (appendOrchestratorHistory, getOrchestratorHistory).
 *
 * These functions are pure in-memory operations — no mocks needed beyond
 * preventing the orchestrator module from importing heavy dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all heavy dependencies that orchestrator.ts imports at module level
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    killed: false,
    kill: vi.fn(),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual };
});

vi.mock('crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'deadbeef' })),
}));

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
    githubRepo: 'owner/repo',
    fritzRoot: '/fritz-root',
  },
}));

vi.mock('../runtime.js', () => ({
  isRunningInDocker: vi.fn(() => false),
  getRuntimeMode: vi.fn(() => 'native'),
}));

vi.mock('../agents/fritz-config.js', () => ({
  getOrchestratorModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getClaudeConfig: vi.fn(() => ({
    claudeSkipPermissions: false,
    claudePrintMode: false,
  })),
}));

vi.mock('./knowledge.js', () => ({
  loadOrchestratorIdentity: vi.fn(() => 'test identity'),
  copyKnowledge: vi.fn(),
}));

vi.mock('../github/github-graphql.js', () => ({
  getCachedIssues: vi.fn(() => null),
}));

vi.mock('../core/message-queue.js', () => ({
  MessageQueue: class {
    enqueue = vi.fn();
    constructor() {}
  },
}));

import { appendOrchestratorHistory, getOrchestratorHistory, resetOrchestratorHistoryForTesting } from './orchestrator.js';

// ── Tests ──

describe('OrchestratorHistoryBuffer', () => {
  beforeEach(() => {
    resetOrchestratorHistoryForTesting();
  });

  it('getOrchestratorHistory returns empty state initially', () => {
    const result = getOrchestratorHistory();
    expect(result).toHaveProperty('conversations');
    expect(result).toHaveProperty('connected');
    expect(result).toHaveProperty('lastActivity');
    expect(Array.isArray(result.conversations)).toBe(true);
    expect(result.conversations).toHaveLength(0);
    expect(result.connected).toBe(false);
    expect(result.lastActivity).toBeNull();
  });

  it('appendOrchestratorHistory adds entry and getOrchestratorHistory retrieves it', () => {
    appendOrchestratorHistory({
      source: 'telegram',
      question: 'What is the pipeline status?',
      reply: 'Pipeline is running smoothly.',
    });

    const result = getOrchestratorHistory(10);
    expect(result.conversations).toHaveLength(1);
    const last = result.conversations[0];
    expect(last.source).toBe('telegram');
    expect(last.question).toBe('What is the pipeline status?');
    expect(last.reply).toBe('Pipeline is running smoothly.');
    expect(last.ts).toBeTruthy();
    expect(result.lastActivity).toBeTruthy();
  });

  it('truncates question and reply to 120 chars', () => {
    const longText = 'x'.repeat(200);
    appendOrchestratorHistory({
      source: 'bridge',
      question: longText,
      reply: longText,
    });

    const result = getOrchestratorHistory(10);
    const last = result.conversations[0];
    expect(last.question.length).toBe(120);
    expect(last.reply.length).toBe(120);
    expect(last.question.endsWith('…')).toBe(true);
  });

  it('preserves issueRef when provided', () => {
    appendOrchestratorHistory({
      source: 'telegram',
      question: 'What about #42?',
      reply: 'Issue 42 is in review.',
      issueRef: 42,
    });

    const result = getOrchestratorHistory(10);
    expect(result.conversations[0].issueRef).toBe(42);
  });

  it('omits issueRef when not provided', () => {
    appendOrchestratorHistory({
      source: 'telegram',
      question: 'Hello',
      reply: 'Hi',
    });

    const result = getOrchestratorHistory(10);
    expect(result.conversations[0].issueRef).toBeUndefined();
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      appendOrchestratorHistory({
        source: 'telegram',
        question: `Q${i}`,
        reply: `A${i}`,
      });
    }

    const result = getOrchestratorHistory(3);
    expect(result.conversations).toHaveLength(3);
    // Should return the most recent 3
    expect(result.conversations[0].question).toBe('Q7');
    expect(result.conversations[2].question).toBe('Q9');
  });

  it('clamps limit=0 to 1', () => {
    appendOrchestratorHistory({ source: 'telegram', question: 'Q', reply: 'A' });
    const result = getOrchestratorHistory(0);
    expect(result.conversations).toHaveLength(1);
  });

  it('clamps limit to max 50', () => {
    for (let i = 0; i < 5; i++) {
      appendOrchestratorHistory({ source: 'telegram', question: `Q${i}`, reply: `A${i}` });
    }
    const result = getOrchestratorHistory(100);
    // Should not throw, returns all 5 (clamped request to 50, but only 5 exist)
    expect(result.conversations).toHaveLength(5);
  });

  it('enforces circular buffer max of 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      appendOrchestratorHistory({
        source: 'telegram',
        question: `Q${i}`,
        reply: `A${i}`,
      });
    }

    const result = getOrchestratorHistory(50);
    expect(result.conversations).toHaveLength(50);
    // First 10 should have been shifted out (Q0–Q9 gone, Q10 is oldest)
    expect(result.conversations[0].question).toBe('Q10');
    expect(result.conversations[49].question).toBe('Q59');
  });

  it('lastActivity updates after each append', () => {
    const before = new Date().toISOString();
    appendOrchestratorHistory({ source: 'bridge', question: 'Q', reply: 'A' });
    const result = getOrchestratorHistory();
    expect(result.lastActivity).not.toBeNull();
    expect(result.lastActivity! >= before).toBe(true);
  });
});
