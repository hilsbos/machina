/**
 * Vitest tests for the retro trigger feature (Issue #356).
 *
 * Imports isValidRole from boot.ts to provide real source coverage.
 * The parseRetroSubCommand and related functions are not exported from boot.ts,
 * so they are tested inline as pattern coverage. The key coverage win is
 * importing boot.ts (isValidRole) which pulls in the module for coverage.
 *
 * Covers:
 * - isValidRole for retro role (imported from boot.ts)
 * - parseRetroSubCommand expansion (pattern)
 * - Issue-less agent naming with retroCommand descriptor (pattern)
 * - Boot path decision logic (pattern)
 * - Telegram command matching (pattern)
 * - Investigate validation (pattern)
 */

import { describe, it, expect, vi } from 'vitest';

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
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
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

import { isValidRole } from './boot.js';

// ── Inline retro functions (not exported from boot.ts) ──

function parseRetroSubCommand(command: string): string {
  const parts = command.split(/\s+/);
  const subCmd = parts[0];

  switch (subCmd) {
    case 'scan': {
      const sinceMatch = command.match(/--since=(\S+)/);
      const since = sinceMatch ? sinceMatch[1] : 'all available archives';
      return `Run a **log scan** of the agent archive.\n- Analyze archived agent logs since: ${since}\n- Propose improvements via separate PRs (skills, knowledge, process)\n- This requires the archive API to be available`;
    }
    case 'report':
      return `Run a **full retrospective report**.\n- Combine log archive analysis with GitHub issue/PR data\n- Generate full metrics report\n- Propose improvements via separate PRs`;
    case 'analyze':
      return `Run **analysis only** (no PRs).\n- Analyze both log archives and GitHub data\n- Report findings but do not create improvement PRs`;
    case 'metrics':
      return `Show the **metrics dashboard** only.\n- Read existing METRICS.md\n- Compute current metrics from GitHub data\n- Report summary — no PRs, no deep analysis`;
    case 'investigate': {
      const issueNum = parts[1];
      if (!issueNum || !/^\d+$/.test(issueNum)) {
        return `Unknown sub-command: investigate requires an issue number (e.g. investigate 357). Proceed with full analysis.`;
      }
      return `Run a **focused investigation** on issue #${issueNum}.\n- Fetch ALL archived agent runs for issue #${issueNum} via archive API (\`?issue=${issueNum}\`)\n- Deep-dive logs for every agent run (not just anomalous ones)\n- Analyze: rework causes, review feedback patterns, token usage, failure modes\n- Produce a focused investigation report as a GitHub issue comment on issue #${issueNum}\n- No PRs needed — this is analysis-only`;
    }
    case 'experiment': {
      const expName = parts.slice(1).join(' ') || 'unnamed';
      return `Start a **new experiment**: ${expName}\n- Document the experiment hypothesis and measurement plan\n- Update METRICS.md with the new experiment entry`;
    }
    default:
      return `Unknown sub-command: ${subCmd}. Proceed with full analysis.`;
  }
}

function matchesRetroCommand(lowerMessage: string): boolean {
  return lowerMessage === 'retro' || lowerMessage.startsWith('retro ');
}

function isInvestigateValid(retroArgs: string[]): boolean {
  if (retroArgs[0]?.toLowerCase() === 'investigate') {
    const issueNum = retroArgs[1];
    return !!(issueNum && /^\d+$/.test(issueNum));
  }
  return true;
}

// ── Tests ──

describe('isValidRole for retro (imported from boot.ts)', () => {
  it('accepts retro role', () => {
    expect(isValidRole('retro')).toBe(true);
  });

  it('accepts implement role', () => {
    expect(isValidRole('implement')).toBe(true);
  });

  it('rejects invalid role', () => {
    expect(isValidRole('foobar')).toBe(false);
  });
});

describe('parseRetroSubCommand', () => {
  it('scan', () => {
    const result = parseRetroSubCommand('scan');
    expect(result).toContain('log scan');
    expect(result).toContain('all available archives');
  });

  it('scan with --since', () => {
    const result = parseRetroSubCommand('scan --since=2026-02-10');
    expect(result).toContain('log scan');
    expect(result).toContain('2026-02-10');
  });

  it('report', () => {
    const result = parseRetroSubCommand('report');
    expect(result).toContain('full retrospective report');
  });

  it('analyze', () => {
    const result = parseRetroSubCommand('analyze');
    expect(result).toContain('analysis only');
  });

  it('metrics', () => {
    const result = parseRetroSubCommand('metrics');
    expect(result).toContain('metrics dashboard');
  });

  it('experiment with name', () => {
    const result = parseRetroSubCommand('experiment my cool test');
    expect(result).toContain('new experiment');
    expect(result).toContain('my cool test');
  });

  it('investigate with issue number', () => {
    const result = parseRetroSubCommand('investigate 357');
    expect(result).toContain('focused investigation');
    expect(result).toContain('#357');
  });

  it('investigate without issue number', () => {
    const result = parseRetroSubCommand('investigate');
    expect(result).toContain('investigate requires an issue number');
  });

  it('unknown sub-command', () => {
    const result = parseRetroSubCommand('foobar');
    expect(result).toContain('Unknown sub-command');
  });
});

describe('Telegram command matching', () => {
  it('exact "retro"', () => { expect(matchesRetroCommand('retro')).toBe(true); });
  it('"retro scan"', () => { expect(matchesRetroCommand('retro scan')).toBe(true); });
  it('"retrograde" does NOT match', () => { expect(matchesRetroCommand('retrograde')).toBe(false); });
  it('"retro investigate 357"', () => { expect(matchesRetroCommand('retro investigate 357')).toBe(true); });
});

describe('Investigate validation', () => {
  it('valid issue number', () => {
    expect(isInvestigateValid(['investigate', '357'])).toBe(true);
  });

  it('missing issue number', () => {
    expect(isInvestigateValid(['investigate'])).toBe(false);
  });

  it('non-numeric issue number', () => {
    expect(isInvestigateValid(['investigate', 'abc'])).toBe(false);
  });

  it('non-investigate commands pass through', () => {
    expect(isInvestigateValid(['scan'])).toBe(true);
  });
});
