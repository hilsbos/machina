/**
 * Vitest tests for registry module.
 *
 * Covers:
 * - updateExitInfo stores exitCode/exitStatus on agent before deregistration
 * - deregisterAgent preserves exitCode/exitStatus in the returned agent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"agents":{}}'),
}));

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
  },
}));

vi.mock('../agents/fritz-config.js', () => ({
  getRoleTtl: vi.fn(() => 120),
  getDaemonConfig: vi.fn(() => ({ persistDebounceMs: 100 })),
}));

import { registerAgent, updateExitInfo, deregisterAgent, getAgent, init } from './registry.js';

describe('updateExitInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    init();
  });

  it('sets exitCode and exitStatus on an existing agent', () => {
    registerAgent('test-agent-1', 'implement', {
      issue: 100,
      repo: 'owner/repo',
      workspace: '/tmp/ws',
    });

    updateExitInfo('test-agent-1', 0, 'completed');

    const agent = getAgent('test-agent-1');
    expect(agent).not.toBeNull();
    expect(agent!.exitCode).toBe(0);
    expect(agent!.exitStatus).toBe('completed');
  });

  it('sets non-zero exitCode for failed agents', () => {
    registerAgent('test-agent-2', 'review', {
      issue: 200,
      repo: 'owner/repo',
      workspace: '/tmp/ws',
    });

    updateExitInfo('test-agent-2', 1, 'dead');

    const agent = getAgent('test-agent-2');
    expect(agent).not.toBeNull();
    expect(agent!.exitCode).toBe(1);
    expect(agent!.exitStatus).toBe('dead');
  });

  it('sets null exitCode (e.g. manual stop)', () => {
    registerAgent('test-agent-3', 'implement', {
      issue: 300,
      repo: 'owner/repo',
      workspace: '/tmp/ws',
    });

    updateExitInfo('test-agent-3', null, 'completed');

    const agent = getAgent('test-agent-3');
    expect(agent).not.toBeNull();
    expect(agent!.exitCode).toBeNull();
    expect(agent!.exitStatus).toBe('completed');
  });

  it('is a no-op for non-existent agents', () => {
    // Should not throw
    updateExitInfo('non-existent', 0, 'completed');
  });

  it('exitInfo is preserved in deregisterAgent return value', () => {
    registerAgent('test-agent-4', 'implement', {
      issue: 400,
      repo: 'owner/repo',
      workspace: '/tmp/ws',
    });

    updateExitInfo('test-agent-4', 0, 'completed');
    const agent = deregisterAgent('test-agent-4');

    expect(agent).not.toBeNull();
    expect(agent!.exitCode).toBe(0);
    expect(agent!.exitStatus).toBe('completed');
  });
});
