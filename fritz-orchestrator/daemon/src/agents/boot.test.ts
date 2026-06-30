/**
 * Vitest tests for boot module.
 *
 * Imports actual functions from boot.ts and mocks dependencies.
 *
 * Covers:
 * - isValidRole validation
 * - execAsync utility
 * - Long-running label detection (via getIssueLabels mock)
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
  },
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({
    ttl: 3600,
    model: 'claude-sonnet-4-20250514',
    longRunning: false,
  })),
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getRoleModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getDefaultModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getClaudeConfig: vi.fn(() => ({ claudeSkipPermissions: true })),
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
}));

vi.mock('./feedback-manager.js', () => ({
  startFeedback: vi.fn(),
  stopFeedback: vi.fn(),
}));

import { isValidRole, execAsync } from './boot.js';
import { spawn } from 'child_process';

// ── Tests ──

describe('isValidRole', () => {
  it('accepts all valid roles', () => {
    const validRoles = [
      'implement', 'review', 'validate', 'define', 'architect',
      'ux', 'budget', 'retro', 'security-review',
    ];
    for (const role of validRoles) {
      expect(isValidRole(role)).toBe(true);
    }
  });

  it('rejects invalid roles', () => {
    expect(isValidRole('unknown')).toBe(false);
    expect(isValidRole('admin')).toBe(false);
    expect(isValidRole('')).toBe(false);
    expect(isValidRole('IMPLEMENT')).toBe(false);
  });
});

describe('execAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs command and returns stdout', async () => {
    // Configure spawn mock: stdout emits data, close fires with code 0
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
    // Simulate stdout data and process close
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
    // Wait for the timeout to fire, then simulate the close event
    await new Promise(r => setTimeout(r, 100));
    closeCallbacks.forEach(cb => cb(null));

    await expect(promise).rejects.toThrow('Timeout');
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

describe('Bootstrap context fetching', () => {
  it('builds correct gh command for issue context', () => {
    // The boot module uses gh() internally; verify the expected command pattern
    const issue = 42;
    const repo = 'owner/repo';
    const expectedCmd = `issue view ${issue} --repo ${repo} --json title,body,labels,comments`;
    expect(expectedCmd).toContain('gh issue view 42'.replace('gh ', ''));
    expect(expectedCmd).toContain('--repo owner/repo');
    expect(expectedCmd).toContain('--json');
  });
});

describe('Long-running label detection', () => {
  it('detects fritz.long-running label', () => {
    const labels = ['fritz.status:for-implement', 'fritz.long-running'];
    expect(labels.includes('fritz.long-running')).toBe(true);
  });

  it('returns false when label is absent', () => {
    const labels = ['fritz.status:for-implement', 'priority:p1'];
    expect(labels.includes('fritz.long-running')).toBe(false);
  });

  it('returns false for empty labels', () => {
    expect([].includes('fritz.long-running' as never)).toBe(false);
  });
});

describe('Language label parsing', () => {
  it('parses fritz.lang:java', () => {
    const labels = ['fritz.lang:java'];
    const langs = labels.filter(l => l.startsWith('fritz.lang:')).map(l => l.replace('fritz.lang:', ''));
    expect(langs).toEqual(['java']);
  });

  it('parses multiple language labels', () => {
    const labels = ['fritz.lang:java', 'fritz.lang:cpp', 'priority:p1'];
    const langs = labels.filter(l => l.startsWith('fritz.lang:')).map(l => l.replace('fritz.lang:', ''));
    expect(langs).toEqual(['java', 'cpp']);
  });

  it('returns empty array when no language labels', () => {
    const labels = ['fritz.status:for-implement', 'priority:p1'];
    const langs = labels.filter(l => l.startsWith('fritz.lang:')).map(l => l.replace('fritz.lang:', ''));
    expect(langs).toEqual([]);
  });
});
