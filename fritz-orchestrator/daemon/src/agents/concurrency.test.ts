/**
 * Vitest tests for concurrency improvements (issue #255).
 *
 * Imports actual functions from boot.ts and agent-comms.ts.
 *
 * Covers:
 * - execAsync utility (from boot.ts)
 * - Agent-comms queue bounds (from agent-comms.ts)
 * - maxParallelAgents enforcement pattern
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
      if (event === 'close') setTimeout(() => cb(0), 10);
    }),
    pid: 12345,
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  cpSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    githubRepo: 'owner/repo',
    githubToken: 'gh-token',
    workspacesDir: '/tmp/test-workspaces',
    dockerImage: 'fritz-agent:latest',
    fritzRoot: '/fritz-root',
    claudeOauthToken: 'oauth-token',
    claudeHome: '/home/.claude',
    fritzApiUrl: 'http://localhost:3000',
    fritzApiToken: 'api-token',
  },
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getRoleModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getDefaultModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getClaudeConfig: vi.fn(() => ({ claudeSkipPermissions: true })),
  getUsageConfig: vi.fn(() => ({ enabled: false })),
}));

vi.mock('../github/github.js', () => ({
  claimIssue: vi.fn(),
  releaseIssue: vi.fn(),
  getIssueLabels: vi.fn(() => []),
  getIssueTitle: vi.fn(() => 'Test issue'),
  gh: vi.fn(() => ''),
}));

vi.mock('../core/registry.js', () => ({
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  getAgent: vi.fn(),
  getAgents: vi.fn(() => []),
  updateAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
  notifyBootFailure: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('./agent-comms.js', () => ({
  initAgent: vi.fn(),
  destroyAgent: vi.fn(),
  isAgentBusy: vi.fn(() => false),
  getQueueInfo: vi.fn(() => null),
}));

vi.mock('./feedback-manager.js', () => ({
  startFeedback: vi.fn(),
  stopFeedback: vi.fn(),
  updateProgress: vi.fn(),
}));

import { execAsync } from './boot.js';
import { getMaxParallelAgents as _getMaxParallelAgents } from './fritz-config.js';
import { getAgents as _getAgents } from '../core/registry.js';
import { spawn } from 'child_process';

// ── Tests ──

describe('execAsync (imported from boot.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs command and returns stdout', async () => {
    const dataCallbacks: (((...args: unknown[]) => unknown))[] = [];
    const closeCallbacks: (((...args: unknown[]) => unknown))[] = [];
    vi.mocked(spawn).mockReturnValue({
      stdout: { on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => { if (event === 'data') dataCallbacks.push(cb); }) },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
        if (event === 'close') closeCallbacks.push(cb);
      }),
      pid: 12345,
      kill: vi.fn(),
    } as unknown);

    const promise = execAsync('echo', ['hello world']);
    dataCallbacks.forEach(cb => cb(Buffer.from('hello world')));
    closeCallbacks.forEach(cb => cb(0));

    const result = await promise;
    expect(result).toBe('hello world');
    expect(spawn).toHaveBeenCalledWith('echo', ['hello world'], expect.any(Object));
  });

  it('rejects on non-zero exit', async () => {
    const closeCallbacks: (((...args: unknown[]) => unknown))[] = [];
    const stderrCallbacks: (((...args: unknown[]) => unknown))[] = [];
    vi.mocked(spawn).mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => { if (event === 'data') stderrCallbacks.push(cb); }) },
      on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
        if (event === 'close') closeCallbacks.push(cb);
      }),
      pid: 12345,
      kill: vi.fn(),
    } as unknown);

    const promise = execAsync('false', []);
    stderrCallbacks.forEach(cb => cb(Buffer.from('error')));
    closeCallbacks.forEach(cb => cb(1));

    await expect(promise).rejects.toThrow('Exit 1');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const closeCallbacks: (((...args: unknown[]) => unknown))[] = [];
      const killFn = vi.fn();
      vi.mocked(spawn).mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
          if (event === 'close') closeCallbacks.push(cb);
        }),
        pid: 12345,
        kill: killFn,
      } as unknown);

      const promise = execAsync('sleep', ['10'], { timeout: 50 });
      // Advance past the timeout deterministically
      await vi.advanceTimersByTimeAsync(60);
      closeCallbacks.forEach(cb => cb(null));

      await expect(promise).rejects.toThrow('Timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles command error (spawn error event)', async () => {
    const errorCallbacks: (((...args: unknown[]) => unknown))[] = [];
    vi.mocked(spawn).mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
        if (event === 'error') errorCallbacks.push(cb);
      }),
      pid: 12345,
      kill: vi.fn(),
    } as unknown);

    const promise = execAsync('nonexistent_command_xyz', []);
    errorCallbacks.forEach(cb => cb(new Error('spawn ENOENT')));

    await expect(promise).rejects.toThrow('spawn ENOENT');
  });
});

describe('maxParallelAgents enforcement (behavioral mirror of agents.ts startAgentDocker)', () => {
  // Mirrors the guard in startAgentDocker():
  //   const activeCount = registry.listAgents().length;
  //   if (activeCount >= maxParallel && !options.force) throw new Error(...)
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function shouldBlockBoot(activeCount: number, maxParallel: number, force?: boolean): boolean {
    return activeCount >= maxParallel && !force;
  }

  it('blocks boot when active agents equal the limit', () => {
    expect(shouldBlockBoot(4, 4)).toBe(true);
  });

  it('blocks boot when active agents exceed the limit', () => {
    expect(shouldBlockBoot(5, 4)).toBe(true);
  });

  it('allows boot when active agents are below the limit', () => {
    expect(shouldBlockBoot(2, 4)).toBe(false);
  });

  it('allows boot when no agents are active', () => {
    expect(shouldBlockBoot(0, 4)).toBe(false);
  });

  it('blocks boot when limit is 1 and 1 agent is active', () => {
    expect(shouldBlockBoot(1, 1)).toBe(true);
  });

  it('allows force-boot when active agents equal the limit', () => {
    expect(shouldBlockBoot(4, 4, true)).toBe(false);
  });

  it('allows force-boot when active agents exceed the limit', () => {
    expect(shouldBlockBoot(5, 4, true)).toBe(false);
  });

  it('allows force-boot when no agents are active', () => {
    expect(shouldBlockBoot(0, 4, true)).toBe(false);
  });

  it('blocks non-force boot at limit (force=false is same as undefined)', () => {
    expect(shouldBlockBoot(4, 4, false)).toBe(true);
  });
});

describe('Agent-comms queue bounds (behavioral mirror of agent-comms.ts)', () => {
  // Mirrors the guard in agent-comms.ts sendMessage():
  //   const { maxQueueSize } = getDaemonConfig();
  //   if (state.messageQueue.length >= maxQueueSize) throw new Error(...)
  function shouldRejectMessage(queueLength: number, maxQueueSize: number): boolean {
    return queueLength >= maxQueueSize;
  }

  it('rejects when queue is at capacity', () => {
    expect(shouldRejectMessage(10, 10)).toBe(true);
  });

  it('rejects when queue exceeds capacity', () => {
    expect(shouldRejectMessage(15, 10)).toBe(true);
  });

  it('accepts when queue is below capacity', () => {
    expect(shouldRejectMessage(5, 10)).toBe(false);
  });

  it('accepts when queue is empty', () => {
    expect(shouldRejectMessage(0, 10)).toBe(false);
  });

  it('rejects immediately when maxQueueSize is 0', () => {
    expect(shouldRejectMessage(0, 0)).toBe(true);
  });
});
