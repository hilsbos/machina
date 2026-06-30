/**
 * Vitest tests for the log archiver module (Issue #294).
 *
 * Imports actual functions from log-archive.ts and mocks dependencies.
 *
 * Covers:
 * - archiveAgentLogs: writing archive with summary and log file
 * - getArchivedLog reading and formatting
 * - getArchivedSummary parsing
 * - listArchivedAgents filtering and sorting
 * - cleanupLogArchive age-based cleanup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
  },
}));

vi.mock('./fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({
    workspaceMaxAgeHours: 24,
    cleanupArtifactGlobs: ['target', 'node_modules', 'build', '.venv'],
  })),
  getRoleModel: vi.fn(() => 'claude-sonnet-4-20250514'),
}));

vi.mock('./session-parser.js', () => ({
  findJsonlFiles: vi.fn(() => []),
  formatSessionForTelegram: vi.fn(() => 'formatted-session-text'),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  rm: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
  statSync: vi.fn(() => ({ isDirectory: () => true, mtimeMs: Date.now() })),
  rmSync: vi.fn(),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual };
});

import type { LocalAgent } from '../core/registry.js';
import {
  archiveAgentLogs,
  getArchivedLog,
  getArchivedSummary,
  listArchivedAgents,
  cleanupLogArchive,
  stripBuildArtifacts,
} from './log-archive.js';

import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'fs';
import { mkdir, copyFile, writeFile, readFile, rm } from 'fs/promises';
import { findJsonlFiles, formatSessionForTelegram } from './session-parser.js';

// ── Tests ──

describe('archiveAgentLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates archive directory and writes summary', async () => {
    const agent = {
      name: 'impl-42',
      role: 'implement',
      issue: 42,
      issueTitle: 'Fix the bug',
      repo: 'org/repo',
      branch: 'feature/fix',
      workspace: '/tmp/ws/impl-42',
      started: '2026-02-23T10:00:00Z',
      lastActivity: '2026-02-23T10:30:00Z',
      invocationMode: 'auto',
      lang: 'typescript',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('agent.log')) return true;
      if (path.includes('.claude/projects')) return false;
      return false;
    });

    const session = {
      duration: '30m',
      turns: 15,
      totalInputTokens: 1000,
      totalCacheReadInputTokens: 500,
      totalCacheCreationInputTokens: 200,
      totalOutputTokens: 800,
      subagentCount: 2,
    } as unknown;

    await archiveAgentLogs(agent, 'completed', 0, null, session);

    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining('impl-42'),
      { recursive: true }
    );
    expect(copyFile).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('summary.json'),
      expect.any(String)
    );

    // Verify summary content
    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    expect(summary.name).toBe('impl-42');
    expect(summary.role).toBe('implement');
    expect(summary.issue).toBe(42);
    expect(summary.exitStatus).toBe('completed');
    expect(summary.duration).toBe('30m');
    expect(summary.turns).toBe(15);
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(800);
  });

  it('handles missing agent.log gracefully', async () => {
    const agent = {
      name: 'impl-99',
      role: 'implement',
      workspace: '/tmp/ws/impl-99',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockReturnValue(false);

    await archiveAgentLogs(agent, 'dead', 1, 'crashed', null);

    expect(mkdir).toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled(); // No log file to copy
    expect(writeFile).toHaveBeenCalled(); // Summary still written
  });

  it('handles null session (defaults to zero values)', async () => {
    const agent = {
      name: 'impl-50',
      role: 'implement',
      workspace: '/tmp/ws/impl-50',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockReturnValue(false);

    await archiveAgentLogs(agent, 'stopped', null, 'user stopped', null);

    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    expect(summary.duration).toBe('0s');
    expect(summary.turns).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
  });

  it('writes session.txt when a parsed session is provided (issue #926)', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-session',
      role: 'implement',
      workspace: '/tmp/ws/impl-session',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(formatSessionForTelegram).mockReturnValue('SESSION_TIMELINE_TEXT');

    const session = {
      duration: '5m',
      turns: 3,
      totalInputTokens: 100,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 50,
      subagentCount: 0,
    } as unknown;

    await archiveAgentLogs(agent, 'completed', 0, null, session);

    const writeCalls = vi.mocked(writeFile).mock.calls;
    const sessionWrite = writeCalls.find(c => String(c[0]).endsWith('session.txt'));
    expect(sessionWrite).toBeDefined();
    expect(sessionWrite?.[1]).toBe('SESSION_TIMELINE_TEXT');
    expect(formatSessionForTelegram).toHaveBeenCalledWith(session, 500_000);
  });

  it('skips session.txt when session is null (no JSONL data)', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-no-session',
      role: 'implement',
      workspace: '/tmp/ws/impl-no-session',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockReturnValue(false);

    await archiveAgentLogs(agent, 'completed', 0, null, null);

    const sessionWrite = vi.mocked(writeFile).mock.calls
      .find(c => String(c[0]).endsWith('session.txt'));
    expect(sessionWrite).toBeUndefined();
  });

  it('does not throw on errors (non-fatal)', async () => {
    const agent = {
      name: 'impl-err',
      role: 'implement',
      workspace: '/tmp/ws/impl-err',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(mkdir).mockRejectedValue(new Error('mkdir failed'));

    // Should not throw
    await expect(
      archiveAgentLogs(agent, 'dead', 1, 'error', null)
    ).resolves.toBeUndefined();
  });

  it('extracts tool usage from JSONL files (Claude Code format)', async () => {
    // Reset mkdir to resolve (previous test may have set it to reject)
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-tools',
      role: 'implement',
      workspace: '/tmp/ws/impl-tools',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.claude/projects')) return true;
      if (path.includes('agent.log')) return false;
      return false;
    });

    vi.mocked(findJsonlFiles).mockReturnValue(['/tmp/ws/impl-tools/.claude/projects/session.jsonl']);

    // Claude Code JSONL format: tool_use is nested inside message.content[]
    const jsonlLines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/file.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-2',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'npm run build' } },
          ],
        },
      }),
    ].join('\n') + '\n';

    vi.mocked(readFile).mockResolvedValue(jsonlLines);

    await archiveAgentLogs(agent, 'completed', 0, null, null);

    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    expect(summary.toolUsage).toEqual({ Bash: 2, Read: 1 });
  });

  it('extracts tool usage from subagent progress entries', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-sub-tools',
      role: 'implement',
      workspace: '/tmp/ws/impl-sub-tools',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.claude/projects')) return true;
      if (path.includes('agent.log')) return false;
      return false;
    });

    vi.mocked(findJsonlFiles).mockReturnValue(['/tmp/ws/impl-sub-tools/.claude/projects/session.jsonl']);

    const jsonlLines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'progress',
        data: {
          message: {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'sub-tu-1', name: 'Read', input: { file_path: '/sub.ts' } },
              ],
            },
          },
        },
      }),
    ].join('\n') + '\n';

    vi.mocked(readFile).mockResolvedValue(jsonlLines);

    await archiveAgentLogs(agent, 'completed', 0, null, null);

    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    expect(summary.toolUsage).toEqual({ Grep: 1, Read: 1 });
  });

  it('excludes thinking tool from tool usage counts', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-thinking',
      role: 'implement',
      workspace: '/tmp/ws/impl-thinking',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.claude/projects')) return true;
      if (path.includes('agent.log')) return false;
      return false;
    });

    vi.mocked(findJsonlFiles).mockReturnValue(['/tmp/ws/impl-thinking/.claude/projects/session.jsonl']);

    const jsonlLines = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-think', name: 'thinking', input: {} },
          { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/file.ts' } },
        ],
      },
    }) + '\n';

    vi.mocked(readFile).mockResolvedValue(jsonlLines);

    await archiveAgentLogs(agent, 'completed', 0, null, null);

    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    expect(summary.toolUsage).toEqual({ Read: 1 });
  });

  it('deduplicates streaming duplicates by message+tool ID', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const agent = {
      name: 'impl-dedup',
      role: 'implement',
      workspace: '/tmp/ws/impl-dedup',
      started: '2026-02-23T10:00:00Z',
    } as unknown as LocalAgent;

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.claude/projects')) return true;
      if (path.includes('agent.log')) return false;
      return false;
    });

    vi.mocked(findJsonlFiles).mockReturnValue(['/tmp/ws/impl-dedup/.claude/projects/session.jsonl']);

    // Streaming produces multiple JSONL lines for the same assistant message
    // with the same tool_use entries — these should be counted only once
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg-dup',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
    };
    // Same message emitted 3 times (streaming snapshots)
    const jsonlLines = [
      JSON.stringify(msg),
      JSON.stringify(msg),
      JSON.stringify(msg),
    ].join('\n') + '\n';

    vi.mocked(readFile).mockResolvedValue(jsonlLines);

    await archiveAgentLogs(agent, 'completed', 0, null, null);

    const summaryCall = vi.mocked(writeFile).mock.calls[0];
    const summary = JSON.parse(summaryCall[1] as string);
    // Should count each tool once, not 3x
    expect(summary.toolUsage).toEqual({ Bash: 1, Read: 1 });
  });
});

describe('getArchivedLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when archive directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = getArchivedLog('test-agent');
    expect(result).toBeNull();
  });

  it('returns log with header when summary exists', () => {
    vi.mocked(existsSync).mockImplementation((_p: unknown) => {
      return true; // all paths exist
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('summary.json')) {
        return JSON.stringify({
          role: 'implement',
          issue: 42,
          exitStatus: 'completed',
          duration: '30m',
          turns: 15,
        });
      }
      return 'Line 1\nLine 2\nLine 3\n';
    });

    const result = getArchivedLog('test-agent', 50);
    expect(result).not.toBeNull();
    expect(result!.log).toContain('archived');
    expect(result!.log).toContain('implement');
    expect(result!.log).toContain('#42');
    expect(result!.log).toContain('completed');
  });

  it('returns no-log-file message when agent.log is missing', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('agent.log')) return false;
      return true; // archive dir and summary exist
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      role: 'review',
      exitStatus: 'dead',
      duration: '5m',
      turns: 3,
    }));

    const result = getArchivedLog('test-agent');
    expect(result).not.toBeNull();
    expect(result!.log).toContain('no log file in archive');
  });

  it('returns "(archived)" header when summary parse fails', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('agent.log')) return false;
      return true;
    });
    vi.mocked(readFileSync).mockReturnValue('invalid json{{{');

    const result = getArchivedLog('bad-agent');
    expect(result).not.toBeNull();
    expect(result!.log).toContain('(archived)');
  });

  it('returns summary without issue when issue is null', () => {
    vi.mocked(existsSync).mockImplementation(() => true);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('summary.json')) {
        return JSON.stringify({
          role: 'review',
          issue: null,
          exitStatus: 'completed',
          duration: '10m',
          turns: 5,
        });
      }
      return 'Line 1\nLine 2\n';
    });

    const result = getArchivedLog('no-issue-agent');
    expect(result).not.toBeNull();
    // Should show "—" for no issue
    expect(result!.log).toContain('\u2014');
  });

  it('replaces backticks with single quotes in log output', () => {
    vi.mocked(existsSync).mockImplementation(() => true);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('summary.json')) {
        return JSON.stringify({ role: 'implement', exitStatus: 'completed', duration: '5m', turns: 1 });
      }
      return 'some `backtick` text\n';
    });

    const result = getArchivedLog('backtick-agent');
    expect(result).not.toBeNull();
    expect(result!.log).not.toContain('`');
    expect(result!.log).toContain("'");
  });

  it('respects the lines parameter', () => {
    vi.mocked(existsSync).mockImplementation(() => true);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('summary.json')) {
        return JSON.stringify({ role: 'implement', exitStatus: 'completed', duration: '5m', turns: 1 });
      }
      // 20 lines
      return Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
    });

    const result = getArchivedLog('many-lines-agent', 5);
    expect(result).not.toBeNull();
    expect(result!.totalLines).toBe(20);
    // Last 5 lines should be shown
    expect(result!.log).toContain('Line 20');
    expect(result!.log).toContain('Line 16');
  });
});

describe('getArchivedSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when summary file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = getArchivedSummary('missing-agent');
    expect(result).toBeNull();
  });

  it('returns parsed summary when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      name: 'impl-42',
      role: 'implement',
      issue: 42,
      exitStatus: 'completed',
      duration: '30m',
    }));

    const result = getArchivedSummary('impl-42');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('impl-42');
    expect(result!.role).toBe('implement');
    expect(result!.exitStatus).toBe('completed');
  });

  it('returns null on parse error', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('invalid json{');

    const result = getArchivedSummary('bad-agent');
    expect(result).toBeNull();
  });
});

describe('listArchivedAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when archive dir does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = listArchivedAgents();
    expect(result).toEqual([]);
  });

  it('returns agents sorted by ended timestamp (newest first)', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['agent-1', 'agent-2'] as unknown as string[]);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('agent-1')) {
        return JSON.stringify({ ended: '2026-02-23T10:00:00Z', role: 'implement' });
      }
      return JSON.stringify({ ended: '2026-02-23T11:00:00Z', role: 'review' });
    });

    const result = listArchivedAgents();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('agent-2'); // Newer first
    expect(result[1].name).toBe('agent-1');
  });

  it('filters by role', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['impl-1', 'review-1'] as unknown as string[]);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('impl-1')) {
        return JSON.stringify({ ended: '2026-02-23T10:00:00Z', role: 'implement' });
      }
      return JSON.stringify({ ended: '2026-02-23T11:00:00Z', role: 'review' });
    });

    const result = listArchivedAgents({ role: 'review' });
    expect(result).toHaveLength(1);
    expect(result[0].summary.role).toBe('review');
  });

  it('filters by issue', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['impl-1', 'impl-2'] as unknown as string[]);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('impl-1')) {
        return JSON.stringify({ ended: '2026-02-23T10:00:00Z', role: 'implement', issue: 42 });
      }
      return JSON.stringify({ ended: '2026-02-23T11:00:00Z', role: 'implement', issue: 43 });
    });

    const result = listArchivedAgents({ issue: 42 });
    expect(result).toHaveLength(1);
    expect(result[0].summary.issue).toBe(42);
  });

  it('filters by since date', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['old-agent', 'new-agent'] as unknown as string[]);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('old-agent')) {
        return JSON.stringify({ ended: '2026-01-01T00:00:00Z', role: 'implement' });
      }
      return JSON.stringify({ ended: '2026-02-23T10:00:00Z', role: 'implement' });
    });

    const result = listArchivedAgents({ since: '2026-02-01T00:00:00Z' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new-agent');
  });

  it('returns empty when readdirSync throws', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(() => { throw new Error('read error'); });

    const result = listArchivedAgents();
    expect(result).toEqual([]);
  });

  it('skips entries without summary.json', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      // Archive dir exists, but summary.json does not for 'no-summary'
      if (path.includes('no-summary') && path.includes('summary.json')) return false;
      return true;
    });
    vi.mocked(readdirSync).mockReturnValue(['no-summary', 'has-summary'] as unknown as string[]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      ended: '2026-02-23T10:00:00Z',
      role: 'implement',
    }));

    const result = listArchivedAgents();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('has-summary');
  });
});

describe('cleanupLogArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when archive dir does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = cleanupLogArchive(7);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('removes entries older than maxAgeDays', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['old-agent'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() - 999999999 } as unknown as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      ended: '2020-01-01T00:00:00Z', // Very old
    }));

    const result = cleanupLogArchive(1);
    expect(result.removed).toContain('old-agent');
  });

  it('skips entries newer than maxAgeDays', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['new-agent'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() } as unknown as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      ended: new Date().toISOString(), // Very recent
    }));

    const result = cleanupLogArchive(7);
    expect(result.skipped).toContain('new-agent');
    expect(result.removed).toEqual([]);
  });

  it('removes all entries when maxAgeDays is 0', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['agent-1'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() } as unknown as ReturnType<typeof statSync>);

    const result = cleanupLogArchive(0);
    expect(result.removed).toContain('agent-1');
  });

  it('falls back to mtime when summary.json is invalid', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['agent-bad-summary'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({
      isDirectory: () => true,
      mtimeMs: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
    } as unknown as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('parse error'); });

    const result = cleanupLogArchive(7);
    expect(result.removed).toContain('agent-bad-summary');
  });

  it('records errors when rmSync fails', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['rm-fail-agent'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() } as unknown as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      ended: '2020-01-01T00:00:00Z', // Very old
    }));
    vi.mocked(rmSync).mockImplementation(() => { throw new Error('rm failed'); });

    const result = cleanupLogArchive(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('rm-fail-agent');
  });

  it('skips non-directory entries', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['not-a-dir'] as unknown as string[]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false, mtimeMs: Date.now() } as unknown as ReturnType<typeof statSync>);

    const result = cleanupLogArchive(1);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('returns empty when readdirSync throws', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation(() => { throw new Error('read error'); });

    const result = cleanupLogArchive(7);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('stripBuildArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  it('strips matching artifact directories from project/', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('/project')) return true;
      if (path.endsWith('/project/target')) return true;
      if (path.endsWith('/project/node_modules')) return true;
      return false;
    });

    const result = await stripBuildArtifacts('/tmp/ws/impl-42');
    expect(result.stripped).toEqual(['target', 'node_modules']);
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it('returns empty when project/ does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await stripBuildArtifacts('/tmp/ws/impl-99');
    expect(result.stripped).toEqual([]);
    expect(rm).not.toHaveBeenCalled();
  });

  it('skips artifact dirs that do not exist', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('/project')) return true;
      return false; // No artifact dirs exist
    });

    const result = await stripBuildArtifacts('/tmp/ws/impl-50');
    expect(result.stripped).toEqual([]);
    expect(rm).not.toHaveBeenCalled();
  });

  it('records errors when rm fails', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('/project')) return true;
      if (path.endsWith('/project/target')) return true;
      return false;
    });
    vi.mocked(rm).mockRejectedValue(new Error('permission denied'));

    const result = await stripBuildArtifacts('/tmp/ws/impl-err');
    expect(result.stripped).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('target');
  });
});
