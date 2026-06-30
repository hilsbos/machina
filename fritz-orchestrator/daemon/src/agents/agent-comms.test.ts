/**
 * Vitest tests for agent-comms module.
 *
 * Imports actual functions from agent-comms.ts and mocks dependencies.
 *
 * Covers:
 * - initAgent / destroyAgent session management
 * - isAgentBusy state tracking
 * - getQueueInfo for queued agents
 * - _testing helpers (cleanResponse, extractResponseFromResult)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 12345,
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
    claudeOauthToken: 'oauth-token',
    claudeHome: '/home/.claude',
    fritzApiUrl: 'http://localhost:3000',
    fritzApiToken: 'api-token',
  },
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
  getClaudeConfig: vi.fn(() => ({ claudeSkipPermissions: true })),
  getDaemonConfig: vi.fn(() => ({
    maxParallelAgents: 4,
    maxQueueSize: 10,
    persistDebounceMs: 1000,
    agentMessageTimeoutMs: 180000,
    startupReadinessTimeoutMs: 30000,
    watchdogIntervalSec: 60,
    workspaceMaxAgeHours: 24,
    logArchiveMaxAgeDays: 7,
    deployWorkflow: 'build-and-deploy-hetzner.yml',
  } satisfies import('./fritz-config.js').DaemonConfig)),
}));

vi.mock('../core/registry.js', () => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('./feedback-manager.js', () => ({
  startFeedback: vi.fn(),
  stopFeedback: vi.fn(),
  updateProgress: vi.fn(),
}));

import {
  initAgent,
  destroyAgent,
  isAgentBusy,
  getQueueInfo,
  _testing,
} from './agent-comms.js';

// ── Tests ──

describe('initAgent / destroyAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes and destroys agent without error', () => {
    expect(() => initAgent('test-agent-1')).not.toThrow();
    expect(() => destroyAgent('test-agent-1')).not.toThrow();
  });

  it('destroyAgent is safe for unknown agent', () => {
    expect(() => destroyAgent('nonexistent')).not.toThrow();
  });
});

describe('isAgentBusy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for unknown agent', () => {
    expect(isAgentBusy('nonexistent')).toBe(false);
  });

  it('returns false for idle agent', () => {
    initAgent('idle-agent');
    expect(isAgentBusy('idle-agent')).toBe(false);
    destroyAgent('idle-agent');
  });
});

describe('getQueueInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unknown agent', () => {
    expect(getQueueInfo('nonexistent')).toBeNull();
  });

  it('returns queue info for initialized agent', () => {
    initAgent('queue-agent');
    const info = getQueueInfo('queue-agent');
    expect(info).not.toBeNull();
    // position is queueLength + 1 (next message slot), so 1 for empty queue
    expect(info!.position).toBe(1);
    expect(info!.queueLength).toBe(0);
    destroyAgent('queue-agent');
  });
});

describe('_testing.cleanResponse', () => {
  it('trims whitespace', () => {
    expect(_testing.cleanResponse('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(_testing.cleanResponse('')).toBe('');
  });

  it('handles multiline response', () => {
    const result = _testing.cleanResponse('line1\nline2\n');
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('passes through plain text unchanged', () => {
    expect(_testing.cleanResponse('Hello world')).toBe('Hello world');
  });

  it('strips ANSI escape codes', () => {
    expect(_testing.cleanResponse('\x1b[32mgreen\x1b[0m text')).toBe('green text');
  });

  it('extracts assistant text from NDJSON lines', () => {
    const ndjson = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Starting work"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"tooluseid":"x","type":"toolresult","content":"file updated"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done!"}]}}',
    ].join('\n');
    expect(_testing.cleanResponse(ndjson)).toBe('Starting work\n\nDone!');
  });

  it('skips tool_use blocks in assistant messages', () => {
    const ndjson = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading file"},{"type":"tool_use","id":"x","name":"Read","input":{}}]}}';
    expect(_testing.cleanResponse(ndjson)).toBe('Reading file');
  });

  it('returns placeholder when only tool results and buffer is large', () => {
    // Build a large buffer of only user/tool_result lines (no assistant text)
    const toolResultLine = '{"type":"user","message":{"role":"user","content":[{"type":"toolresult","content":"' + 'x'.repeat(200) + '"}]}}';
    const lines = Array(5).fill(toolResultLine);
    const ndjson = lines.join('\n');
    // Verify the stripped buffer is > 500 chars
    expect(ndjson.length).toBeGreaterThan(500);
    expect(_testing.cleanResponse(ndjson)).toBe('(agent working — no text response yet)');
  });

  it('returns placeholder when only tool results even if buffer is small', () => {
    const ndjson = '{"type":"user","message":{"role":"user","content":[{"type":"toolresult","content":"ok"}]}}';
    // Even small NDJSON with only tool results should never be returned verbatim
    expect(ndjson.length).toBeLessThan(500);
    expect(_testing.cleanResponse(ndjson)).toBe('(agent working — no text response yet)');
  });

  it('extracts only assistant text when NDJSON is present, skipping plain text lines', () => {
    // When NDJSON assistant messages are found, non-JSON lines are skipped
    // because lines not starting with '{' are skipped via `continue`.
    const input = [
      'plain text line',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Assistant says hi"}]}}',
    ].join('\n');
    const result = _testing.cleanResponse(input);
    expect(result).toBe('Assistant says hi');
  });

  it('returns plain text lines when no NDJSON is present', () => {
    const input = 'just some plain text output\nwith multiple lines';
    const result = _testing.cleanResponse(input);
    // No lines start with '{', so no JSON parsing happens.
    // No assistant texts extracted → falls back to stripped text (< 500 chars).
    expect(result).toBe(input);
  });

  it('skips partial/incomplete JSON at end of buffer', () => {
    const input = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Complete message"}]}}',
      '{"type":"assis',
    ].join('\n');
    // The partial JSON starts with '{', so the parse fails; the catch block
    // only includes non-'{' lines, so it is skipped.
    expect(_testing.cleanResponse(input)).toBe('Complete message');
  });

  it('skips system/init events', () => {
    const ndjson = [
      '{"type":"system","subtype":"init","apiKey":"sk-xxx"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}',
    ].join('\n');
    expect(_testing.cleanResponse(ndjson)).toBe('Hello');
  });

  it('extracts result events alongside assistant messages', () => {
    const ndjson = [
      '{"type":"result","result":"Final answer"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Visible"}]}}',
    ].join('\n');
    expect(_testing.cleanResponse(ndjson)).toBe('Final answer\n\nVisible');
  });

  it('extracts result event when it is the only line', () => {
    const ndjson = '{"type":"result","result":"Final answer"}';
    expect(_testing.cleanResponse(ndjson)).toBe('Final answer');
  });

  it('extracts text from content_block_delta streaming events', () => {
    const ndjson = [
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
    ].join('\n');
    expect(_testing.cleanResponse(ndjson)).toBe('Hello \n\nworld');
  });

  it('skips content_block_delta with non-text delta type', () => {
    const ndjson = '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}';
    expect(_testing.cleanResponse(ndjson)).toBe('(agent working — no text response yet)');
  });

  it('handles string content in assistant message (not just array)', () => {
    const ndjson = '{"type":"assistant","message":{"role":"assistant","content":"plain string"}}';
    expect(_testing.cleanResponse(ndjson)).toBe('plain string');
  });
});

describe('_testing.extractResponseFromResult', () => {
  it('extracts text from result object', () => {
    const result = _testing.extractResponseFromResult({
      result: 'the response text',
    });
    expect(result).toContain('the response text');
  });

  it('handles string input (no result property)', () => {
    // extractResponseFromResult expects Record<string, unknown>;
    // a plain string has no .result property, so it returns ''
    const result = _testing.extractResponseFromResult('plain text' as unknown as Record<string, unknown>);
    expect(result).toBe('');
  });

  it('handles empty result', () => {
    const result = _testing.extractResponseFromResult('');
    expect(result).toBe('');
  });
});
