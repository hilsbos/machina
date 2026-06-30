/**
 * Vitest tests for session-parser.ts — Tier 2 state unit tests.
 *
 * Tests the JSONL session log parser and Telegram formatter.
 * Uses temp directories with synthetic JSONL data to test parsing logic
 * without requiring real Claude Code sessions.
 *
 * Covers:
 * - findJsonlFiles: recursive directory traversal, edge cases
 * - parseAgentSession: JSONL parsing, token counting, turn counting,
 *   subagent detection, agent.log parsing, duration formatting
 * - formatSessionForTelegram: output formatting, truncation, backtick stripping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { findJsonlFiles, parseAgentSession, formatSessionForTelegram } from './session-parser.js';

const TEST_DIR = '/tmp/vitest-session-parser';

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Helpers ──

function makeWorkspace(): string {
  return TEST_DIR;
}

function writeJsonl(dir: string, filename: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(dir, filename), content, 'utf-8');
}

function writeAgentLog(workspace: string, lines: string[]): void {
  const logDir = join(workspace, '.fritz');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'agent.log'), lines.join('\n') + '\n', 'utf-8');
}

// ── findJsonlFiles ──

describe('findJsonlFiles', () => {
  it('finds .jsonl files in a directory', () => {
    const dir = join(TEST_DIR, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), '{}', 'utf-8');
    writeFileSync(join(dir, 'other.txt'), 'not jsonl', 'utf-8');

    const files = findJsonlFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('session.jsonl');
  });

  it('recursively finds .jsonl files in subdirectories', () => {
    const dir = join(TEST_DIR, 'sessions');
    const subDir = join(dir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(dir, 'main.jsonl'), '{}', 'utf-8');
    writeFileSync(join(subDir, 'agent-1.jsonl'), '{}', 'utf-8');

    const files = findJsonlFiles(dir);
    expect(files).toHaveLength(2);
  });

  it('returns empty array for non-existent directory', () => {
    const files = findJsonlFiles(join(TEST_DIR, 'does-not-exist'));
    expect(files).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const dir = join(TEST_DIR, 'empty');
    mkdirSync(dir, { recursive: true });

    const files = findJsonlFiles(dir);
    expect(files).toEqual([]);
  });

  it('returns empty array for directory with no .jsonl files', () => {
    const dir = join(TEST_DIR, 'no-jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'readme.md'), '# Hello', 'utf-8');
    writeFileSync(join(dir, 'data.json'), '{}', 'utf-8');

    const files = findJsonlFiles(dir);
    expect(files).toEqual([]);
  });
});

// ── parseAgentSession ──

describe('parseAgentSession', () => {
  it('returns null when no JSONL files exist', () => {
    const workspace = makeWorkspace();
    // No .claude/projects/ directory
    const result = parseAgentSession(workspace);
    expect(result).toBeNull();
  });

  it('parses a basic session with assistant messages and token usage', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-abc');

    const lines = [
      {
        type: 'assistant',
        sessionId: 'session-abc',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, I will help you.' }],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
            output_tokens: 200,
          },
        },
      },
      {
        type: 'user',
        timestamp: '2026-02-23T10:01:00Z',
        message: { role: 'user', content: 'Please fix the bug.' },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:02:00Z',
        message: {
          id: 'msg-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Done, the bug is fixed.' }],
          usage: {
            input_tokens: 150,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 100,
          },
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-abc');
    expect(result!.turns).toBe(1); // one user message with text
    expect(result!.totalInputTokens).toBe(250); // 100 + 150
    expect(result!.totalOutputTokens).toBe(300); // 200 + 100
    expect(result!.totalCacheReadInputTokens).toBe(50);
    expect(result!.totalCacheCreationInputTokens).toBe(10);
    expect(result!.entries.length).toBe(2); // two text entries from assistant messages
  });

  it('counts turns only for user messages with text content', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-turns');

    const lines = [
      // Text string content → counts as turn
      { type: 'user', timestamp: '2026-02-23T10:00:00Z', message: { role: 'user', content: 'Hello' } },
      // Array with text item → counts as turn
      { type: 'user', timestamp: '2026-02-23T10:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'World' }] } },
      // Array with only tool_result → does NOT count as turn
      { type: 'user', timestamp: '2026-02-23T10:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.turns).toBe(2); // only the first two
  });

  it('deduplicates token usage per message ID', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-dedup');

    // Streaming produces multiple lines with same message ID
    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-dup',
          role: 'assistant',
          content: [{ type: 'text', text: 'Part 1' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:01Z',
        message: {
          id: 'msg-dup',
          role: 'assistant',
          content: [{ type: 'text', text: 'Part 1 continued...' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    // Usage counted only once despite two lines with same message ID
    expect(result!.totalInputTokens).toBe(100);
    expect(result!.totalOutputTokens).toBe(50);
    // Text entry emitted only once per message ID
    expect(result!.entries.filter(e => e.type === 'text')).toHaveLength(1);
  });

  it('extracts tool_use entries from assistant messages', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-tools');

    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-tools',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/workspace/project/src/index.ts' } },
            { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    const toolEntries = result!.entries.filter(e => e.type === 'tool_use');
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries[0].summary).toContain('Read:');
    expect(toolEntries[0].summary).toContain('index.ts');
    expect(toolEntries[1].summary).toContain('Bash:');
    expect(toolEntries[1].summary).toContain('npm test');
  });

  it('skips thinking tool_use entries', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-thinking');

    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-think',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-think', name: 'thinking', input: {} },
            { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/file.ts' } },
          ],
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    const toolEntries = result!.entries.filter(e => e.type === 'tool_use');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].summary).toContain('Read:');
  });

  it('skips "(no content)" text entries', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-nocontent');

    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-nc',
          role: 'assistant',
          content: [{ type: 'text', text: '(no content)' }],
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.entries.filter(e => e.type === 'text')).toHaveLength(0);
  });

  it('counts subagent JSONL files', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-sub');
    const subagentDir = join(sessionDir, 'subagents');

    writeJsonl(sessionDir, 'main.jsonl', [
      { type: 'assistant', timestamp: '2026-02-23T10:00:00Z', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    ]);
    writeJsonl(subagentDir, 'agent-1.jsonl', [
      { type: 'assistant', timestamp: '2026-02-23T10:01:00Z', message: { id: 'msg-s1', role: 'assistant', content: [{ type: 'text', text: 'Sub hello' }] } },
    ]);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.subagentCount).toBe(1);
  });

  it('parses subagent progress entries with tool_use deduplication', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-subprogress');

    const lines = [
      {
        type: 'progress',
        timestamp: '2026-02-23T10:00:00Z',
        data: {
          message: {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'sub-tu-1', name: 'Grep', input: { pattern: 'TODO' } },
              ],
            },
          },
        },
      },
      // Duplicate progress entry (same tool ID)
      {
        type: 'progress',
        timestamp: '2026-02-23T10:00:01Z',
        data: {
          message: {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'sub-tu-1', name: 'Grep', input: { pattern: 'TODO' } },
              ],
            },
          },
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    const toolEntries = result!.entries.filter(e => e.type === 'tool_use');
    // Deduplicated — only one entry despite two progress lines with same tool ID
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].summary).toContain('[sub] Grep:');
  });

  it('merges agent.log entries into timeline', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-log');

    writeJsonl(sessionDir, 'session.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working...' }] },
      },
    ]);

    writeAgentLog(workspace, [
      '[2026-02-23T10:00:30Z] \u2192 PROMPT: Start working on issue #183',
      '[2026-02-23T10:01:00Z] \u2190 RESPONSE: Completed task',
      '[2026-02-23T10:01:30Z] \u2190 TIMEOUT: (no response)',
      '[2026-02-23T10:02:00Z] \u2190 ERROR: Connection failed',
    ]);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();

    const agentLogEntries = result!.entries.filter(e => e.source === 'agent-log');
    expect(agentLogEntries).toHaveLength(4);

    expect(agentLogEntries[0].type).toBe('prompt');
    expect(agentLogEntries[1].type).toBe('response');
    expect(agentLogEntries[2].type).toBe('timeout');
    expect(agentLogEntries[3].type).toBe('error');

    // All entries sorted chronologically (session entries before agent.log)
    const timestamps = result!.entries.map(e => e.timestamp.getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });

  it('computes duration from first to last entry', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-dur');

    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Start' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:05:30Z',
        message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'End' }] },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.duration).toBe('5m 30s');
  });

  it('handles malformed JSONL lines gracefully', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-bad');

    // Write raw content with invalid lines
    mkdirSync(sessionDir, { recursive: true });
    const content = [
      'not valid json',
      JSON.stringify({ type: 'assistant', timestamp: '2026-02-23T10:00:00Z', message: { id: 'msg-ok', role: 'assistant', content: [{ type: 'text', text: 'Valid line' }] } }),
      '{ broken json',
      '',
    ].join('\n');
    writeFileSync(join(sessionDir, 'session.jsonl'), content, 'utf-8');

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    // Only the valid line produces an entry
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].summary).toContain('Valid line');
  });

  it('handles agent.log with arrow variants (ASCII and Unicode)', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-arrows');

    writeJsonl(sessionDir, 'session.jsonl', [
      { type: 'assistant', timestamp: '2026-02-23T10:00:00Z', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    writeAgentLog(workspace, [
      '[2026-02-23T10:00:10Z] -> PROMPT: ASCII arrow prompt',
      '[2026-02-23T10:00:20Z] <- RESPONSE: ASCII arrow response',
    ]);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    const logEntries = result!.entries.filter(e => e.source === 'agent-log');
    expect(logEntries).toHaveLength(2);
    expect(logEntries[0].type).toBe('prompt');
    expect(logEntries[1].type).toBe('response');
  });

  it('summarises various tool types correctly', () => {
    const workspace = makeWorkspace();
    const sessionDir = join(workspace, '.claude', 'projects', '-workspace', 'session-toolsummary');

    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-02-23T10:00:00Z',
        message: {
          id: 'msg-ts',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-w', name: 'Write', input: { file_path: '/workspace/project/new.ts' } },
            { type: 'tool_use', id: 'tu-e', name: 'Edit', input: { file_path: '/workspace/project/old.ts' } },
            { type: 'tool_use', id: 'tu-g', name: 'Glob', input: { pattern: '**/*.test.ts' } },
            { type: 'tool_use', id: 'tu-gr', name: 'Grep', input: { pattern: 'TODO|FIXME' } },
            { type: 'tool_use', id: 'tu-td', name: 'TodoWrite', input: { todos: [1, 2, 3] } },
            { type: 'tool_use', id: 'tu-ws', name: 'WebSearch', input: { query: 'vitest docs' } },
            { type: 'tool_use', id: 'tu-uk', name: 'UnknownTool', input: { foo: 'bar' } },
          ],
        },
      },
    ];

    writeJsonl(sessionDir, 'session.jsonl', lines);

    const result = parseAgentSession(workspace);
    expect(result).not.toBeNull();
    const tools = result!.entries.filter(e => e.type === 'tool_use');
    expect(tools).toHaveLength(7);

    expect(tools[0].summary).toContain('Write:');
    expect(tools[0].summary).toContain('new.ts');
    expect(tools[1].summary).toContain('Edit:');
    expect(tools[2].summary).toContain('Glob:');
    expect(tools[2].summary).toContain('**/*.test.ts');
    expect(tools[3].summary).toContain('Grep:');
    expect(tools[4].summary).toContain('TodoWrite:');
    expect(tools[4].summary).toContain('3 items');
    expect(tools[5].summary).toContain('WebSearch:');
    // Unknown tool has no detail — just the name
    expect(tools[6].summary).toBe('UnknownTool');
  });
});

// ── formatSessionForTelegram ──

describe('formatSessionForTelegram', () => {
  it('formats a basic session summary', () => {
    const summary = {
      sessionId: 'test-session',
      duration: '5m 30s',
      turns: 3,
      totalInputTokens: 1500,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 800,
      entries: [
        { timestamp: new Date('2026-02-23T10:00:00Z'), source: 'session' as const, type: 'text' as const, summary: 'Hello' },
        { timestamp: new Date('2026-02-23T10:01:00Z'), source: 'session' as const, type: 'tool_use' as const, summary: 'Read: /file.ts' },
      ],
      subagentCount: 0,
    };

    const output = formatSessionForTelegram(summary);
    expect(output).toContain('5m 30s');
    expect(output).toContain('3 turns');
    expect(output).toContain('2k'); // 1500 + 800 ≈ 2k
    expect(output).toContain('"Hello"'); // text entries get quotes
    expect(output).toContain('Read: /file.ts');
  });

  it('includes cache token info when present', () => {
    const summary = {
      sessionId: 'cache-session',
      duration: '10m',
      turns: 1,
      totalInputTokens: 500,
      totalCacheReadInputTokens: 2000,
      totalCacheCreationInputTokens: 500,
      totalOutputTokens: 300,
      entries: [],
      subagentCount: 0,
    };

    const output = formatSessionForTelegram(summary);
    // Cache tokens are displayed as "(+Xk cache)" in the header line
    expect(output).toMatch(/\(\+\d+k cache\)/);
  });

  it('includes subagent count when present', () => {
    const summary = {
      sessionId: 'sub-session',
      duration: '30m',
      turns: 5,
      totalInputTokens: 5000,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 3000,
      entries: [],
      subagentCount: 2,
    };

    const output = formatSessionForTelegram(summary);
    expect(output).toContain('2 subagents');
  });

  it('truncates long output keeping recent entries', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      timestamp: new Date(`2026-02-23T10:${String(i % 60).padStart(2, '0')}:00Z`),
      source: 'session' as const,
      type: 'tool_use' as const,
      summary: `Read: /very/long/path/to/some/deeply/nested/file-${i}.ts`,
    }));

    const summary = {
      sessionId: 'long-session',
      duration: '60m',
      turns: 100,
      totalInputTokens: 100000,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 50000,
      entries,
      subagentCount: 0,
    };

    const output = formatSessionForTelegram(summary, 3800);
    expect(output.length).toBeLessThanOrEqual(3800);
    expect(output).toContain('(truncated)');
    // Recent entries should be kept (end of the list)
    expect(output).toContain('file-199.ts');
  });

  it('strips backticks from output', () => {
    const summary = {
      sessionId: 'backtick-session',
      duration: '1m',
      turns: 1,
      totalInputTokens: 100,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 50,
      entries: [
        { timestamp: new Date('2026-02-23T10:00:00Z'), source: 'session' as const, type: 'text' as const, summary: 'Code: `const x = 1`' },
      ],
      subagentCount: 0,
    };

    const output = formatSessionForTelegram(summary);
    expect(output).not.toContain('`');
    expect(output).toContain("'const x = 1'"); // backticks replaced with single quotes
  });

  it('singular subagent text for count of 1', () => {
    const summary = {
      sessionId: 'one-sub',
      duration: '5m',
      turns: 1,
      totalInputTokens: 100,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalOutputTokens: 50,
      entries: [],
      subagentCount: 1,
    };

    const output = formatSessionForTelegram(summary);
    expect(output).toContain('1 subagent');
    expect(output).not.toContain('1 subagents');
  });
});
