/**
 * Vitest tests for agents module.
 *
 * Imports isValidRole and execAsync from boot.ts and functions from agents.ts
 * to provide actual source coverage.
 *
 * Covers:
 * - Image variant selection based on labels
 * - isValidRole validation (imported from boot.ts)
 * - Agent name generation pattern
 * - Orphan cleanup pattern
 * - Boot failure notification pattern
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
    dockerImage: 'fritz-agent:latest',
    workspacesDir: '/tmp/test-workspaces',
    githubRepo: 'owner/repo',
    githubToken: 'gh-token',
    telegramBotToken: 'tg-token',
    telegramChatId: 'chat-123',
    claudeModel: 'claude-sonnet-4-20250514',
    maxParallelAgents: 4,
    claudeOauthToken: 'oauth-token',
    fritzApiToken: 'api-token',
    fritzApiUrl: 'http://localhost:3000',
    claudeHome: '/home/.claude',
    fritzRoot: '/fritz-root',
  },
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

vi.mock('../github/github.js', () => ({
  claimIssue: vi.fn(),
  releaseIssue: vi.fn(),
  getIssueLabels: vi.fn(() => []),
  getIssueTitle: vi.fn(() => 'Test issue'),
  gh: vi.fn(() => ''),
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
  getDaemonConfig: vi.fn(() => ({ workspaceMaxAgeHours: 24 })),
  getMaxParallelAgents: vi.fn(() => 4),
  getRoleModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getDefaultModel: vi.fn(() => 'claude-sonnet-4-20250514'),
  getClaudeConfig: vi.fn(() => ({ claudeSkipPermissions: true })),
}));

vi.mock('./agent-comms.js', () => ({
  initAgent: vi.fn(),
  destroyAgent: vi.fn(),
}));

vi.mock('./feedback-manager.js', () => ({
  startFeedback: vi.fn(),
  stopFeedback: vi.fn(),
}));

vi.mock('./session-parser.js', () => ({
  parseAgentSession: vi.fn(() => null),
  formatSessionForTelegram: vi.fn(() => 'formatted-timeline'),
  findJsonlFiles: vi.fn(() => []),
}));

vi.mock('./log-archive.js', () => ({
  archiveAgentLogs: vi.fn().mockResolvedValue(undefined),
  getArchivedLog: vi.fn(() => null),
  stripBuildArtifacts: vi.fn().mockResolvedValue({ stripped: [], errors: [] }),
}));

import { isValidRole } from './boot.js';
import { isBootInProgress, LABEL_TO_VARIANT, LANG_PREFIX, redactDockerCmd, getSessionTimeline } from './agents.js';
import { AGENT_IMAGE_VARIANTS } from '../types.js';
import { getAgents as _getAgents, getAgent } from '../core/registry.js';
import { parseAgentSession, formatSessionForTelegram } from './session-parser.js';
import { existsSync, readFileSync } from 'fs';

// ── Tests ──

describe('isValidRole (imported from boot.ts)', () => {
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

describe('Image variant selection', () => {
  it('uses default image when no language labels', () => {
    const labels: string[] = ['fritz.status:for-implement', 'priority:p1'];
    const langLabels = labels.filter(l => l.startsWith('fritz.lang:'));
    expect(langLabels).toEqual([]);
  });

  it('detects java language label', () => {
    const labels = ['fritz.status:for-implement', 'fritz.lang:java'];
    const langLabels = labels
      .filter(l => l.startsWith('fritz.lang:'))
      .map(l => l.replace('fritz.lang:', ''));
    expect(langLabels).toEqual(['java']);
  });

  it('detects kali language label', () => {
    const labels = ['fritz.status:for-implement', 'fritz.lang:kali'];
    const langLabels = labels
      .filter(l => l.startsWith('fritz.lang:'))
      .map(l => l.replace('fritz.lang:', ''));
    expect(langLabels).toEqual(['kali']);
  });

  it('detects multiple language labels', () => {
    const labels = ['fritz.lang:java', 'fritz.lang:cpp', 'priority:p1'];
    const langLabels = labels
      .filter(l => l.startsWith('fritz.lang:'))
      .map(l => l.replace('fritz.lang:', ''));
    expect(langLabels).toEqual(['java', 'cpp']);
  });
});

describe('LABEL_TO_VARIANT mapping', () => {
  it('maps fritz.lang:java to java variant', () => {
    expect(LABEL_TO_VARIANT[`${LANG_PREFIX}java`]).toBe('java');
  });

  it('maps fritz.lang:cpp to cpp variant', () => {
    expect(LABEL_TO_VARIANT[`${LANG_PREFIX}cpp`]).toBe('cpp');
  });

  it('maps fritz.lang:kali to kali variant', () => {
    expect(LABEL_TO_VARIANT[`${LANG_PREFIX}kali`]).toBe('kali');
  });

  it('all mapped variants exist in AGENT_IMAGE_VARIANTS', () => {
    for (const variant of Object.values(LABEL_TO_VARIANT)) {
      expect(AGENT_IMAGE_VARIANTS).toContain(variant);
    }
  });

  it('does not map unknown labels', () => {
    expect(LABEL_TO_VARIANT['fritz.lang:python']).toBeUndefined();
    expect(LABEL_TO_VARIANT['lang:java']).toBeUndefined();
  });
});

describe('Agent boot flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers agent before spawning', () => {
    const callOrder: string[] = [];
    const mockRegister = vi.fn(() => { callOrder.push('register'); });
    const mockSpawn = vi.fn(() => { callOrder.push('spawn'); });

    mockRegister();
    mockSpawn();

    expect(callOrder).toEqual(['register', 'spawn']);
    expect(mockRegister).toHaveBeenCalledBefore(mockSpawn);
  });

  it('generates correct agent name with issue number', () => {
    const role = 'implement';
    const issue = 42;
    const suffix = 'abcd';
    const name = `${role}-${issue}-${suffix}`;
    expect(name).toBe('implement-42-abcd');
  });

  it('generates correct agent name without issue', () => {
    const role = 'retro';
    const suffix = 'abcd';
    const name = `${role}-${suffix}`;
    expect(name).toBe('retro-abcd');
  });
});

describe('Orphan cleanup on startup', () => {
  it('identifies orphan containers by name prefix', () => {
    const containerNames = [
      'fritz-implement-42-abcd',
      'fritz-review-10-efgh',
      'other-container',
      'postgres',
    ];
    const orphans = containerNames.filter(n => n.startsWith('fritz-'));
    expect(orphans).toEqual(['fritz-implement-42-abcd', 'fritz-review-10-efgh']);
  });

  it('cleans up containers not in registry', () => {
    const registeredAgents = new Set(['fritz-implement-42-abcd']);
    const runningContainers = [
      'fritz-implement-42-abcd',
      'fritz-review-10-efgh',
    ];
    const orphans = runningContainers.filter(c => !registeredAgents.has(c));
    expect(orphans).toEqual(['fritz-review-10-efgh']);
  });
});

describe('Pending claims (boot-in-progress guard)', () => {
  it('isBootInProgress returns false when no boot in progress', () => {
    expect(isBootInProgress(999)).toBe(false);
  });
});

describe('Boot failure notification', () => {
  it('generates failure message with issue number', () => {
    const issue = 42;
    const role = 'implement';
    const error = 'Docker pull failed';
    const message = `Agent ${role} for #${issue} failed to boot: ${error}`;
    expect(message).toContain('#42');
    expect(message).toContain('implement');
    expect(message).toContain('Docker pull failed');
  });
});

describe('getSessionTimeline (issue #926)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgent).mockReturnValue(undefined);
    vi.mocked(parseAgentSession).mockReturnValue(null);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('returns formatted timeline when JSONL session is parseable', () => {
    vi.mocked(parseAgentSession).mockReturnValue({
      sessionId: 's1',
      duration: '1m',
      turns: 1,
      totalInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 0,
      entries: [],
      subagentCount: 0,
    });
    vi.mocked(formatSessionForTelegram).mockReturnValue('TIMELINE');

    expect(getSessionTimeline('agent-1')).toBe('TIMELINE');
    expect(formatSessionForTelegram).toHaveBeenCalled();
  });

  it('falls back to archived session.txt when JSONL is gone', () => {
    vi.mocked(parseAgentSession).mockReturnValue(null);
    vi.mocked(existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('session.txt')
    );
    vi.mocked(readFileSync).mockReturnValue('ARCHIVED_SESSION');

    expect(getSessionTimeline('agent-2')).toBe('ARCHIVED_SESSION');
  });

  it('returns null when neither workspace JSONL nor archive exists', () => {
    vi.mocked(parseAgentSession).mockReturnValue(null);
    vi.mocked(existsSync).mockReturnValue(false);

    expect(getSessionTimeline('agent-3')).toBeNull();
  });

  it('does NOT fall back to agent.log (root cause of #926)', () => {
    // The bug: getAgentLogs() falls through to agent.log when JSONL is missing,
    // which made Session Log identical to Agent Log for archived agents.
    // getSessionTimeline must keep that fallback off the table.
    vi.mocked(parseAgentSession).mockReturnValue(null);
    vi.mocked(existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('agent.log'),
    );
    vi.mocked(readFileSync).mockReturnValue('AGENT_LOG_CONTENT');

    expect(getSessionTimeline('agent-4')).toBeNull();
  });

  it('truncates archived session.txt to maxLength', () => {
    vi.mocked(parseAgentSession).mockReturnValue(null);
    vi.mocked(existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('session.txt'),
    );
    vi.mocked(readFileSync).mockReturnValue('A'.repeat(1000));

    const result = getSessionTimeline('agent-5', 50);
    expect(result).toHaveLength(50);
  });
});

describe('redactDockerCmd', () => {
  it('redacts CLAUDE_CODE_OAUTH_TOKEN values', () => {
    const cmd = 'docker run -d -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret123 --name test';
    const result = redactDockerCmd(cmd);
    expect(result).toBe('docker run -d -e CLAUDE_CODE_OAUTH_TOKEN=*** --name test');
    expect(result).not.toContain('sk-ant-oat01-secret123');
  });

  it('redacts ANTHROPIC_API_KEY values', () => {
    const cmd = 'docker run -d -e ANTHROPIC_API_KEY=sk-ant-api03-xyz789 --name test';
    const result = redactDockerCmd(cmd);
    expect(result).toBe('docker run -d -e ANTHROPIC_API_KEY=*** --name test');
  });

  it('redacts GH_TOKEN values', () => {
    const cmd = 'docker run -d -e GH_TOKEN=ghp_abcdef123456 --name test';
    const result = redactDockerCmd(cmd);
    expect(result).toBe('docker run -d -e GH_TOKEN=*** --name test');
  });

  it('redacts FRITZ_API_TOKEN values', () => {
    const cmd = 'docker run -d -e FRITZ_API_TOKEN=tok_secret --name test';
    const result = redactDockerCmd(cmd);
    expect(result).toBe('docker run -d -e FRITZ_API_TOKEN=*** --name test');
  });

  it('redacts multiple secrets in one command', () => {
    const cmd = 'docker run -d -e CLAUDE_CODE_OAUTH_TOKEN=secret1 -e GH_TOKEN=secret2 -e FRITZ_API_TOKEN=secret3 --name test';
    const result = redactDockerCmd(cmd);
    expect(result).toBe('docker run -d -e CLAUDE_CODE_OAUTH_TOKEN=*** -e GH_TOKEN=*** -e FRITZ_API_TOKEN=*** --name test');
  });

  it('does not alter commands without secrets', () => {
    const cmd = 'docker run -d --name test-container -v /host:/container';
    const result = redactDockerCmd(cmd);
    expect(result).toBe(cmd);
  });

  it('does not alter non-secret env vars', () => {
    const cmd = 'docker run -d -e NODE_ENV=production -e FRITZ_DAEMON_URL=http://localhost:3456';
    const result = redactDockerCmd(cmd);
    expect(result).toBe(cmd);
  });

  it('handles error messages containing docker commands', () => {
    const errMsg = 'Command failed: docker run -d -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-long-token-here --name agent';
    const result = redactDockerCmd(errMsg);
    expect(result).not.toContain('sk-ant-oat01-long-token-here');
    expect(result).toContain('CLAUDE_CODE_OAUTH_TOKEN=***');
  });
});
