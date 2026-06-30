/**
 * Tests for claude-config-restore utility.
 *
 * Mocks child_process.execFile to verify restore script invocation
 * without executing shell commands. Tests filterClaudeStderr regex
 * patterns and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess, ExecFileOptions } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  restoreClaudeJsonInContainer,
  restoreClaudeJsonLocal,
  filterClaudeStderr,
  _testing,
} from './claude-config-restore.js';

const { RESTORE_SCRIPT, CLAUDE_BACKUP_WARNING } = _testing;

const mockedExecFile = vi.mocked(execFile);

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Restore script syntax ──

describe('RESTORE_SCRIPT', () => {
  it('is valid shell syntax', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    // -n flag: syntax check only, no execution
    expect(() => actual.execFileSync('sh', ['-n', '-c', RESTORE_SCRIPT])).not.toThrow();
  });
});

// ── Restore script invocation ──

describe('restoreClaudeJsonInContainer', () => {
  it('calls execFile with docker exec prefix and restore script', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const callback = cb as (error: Error | null) => void;
      callback(null);
      return new EventEmitter() as ChildProcess;
    });

    await restoreClaudeJsonInContainer('fritz-orchestrator');

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [file, args, opts] = mockedExecFile.mock.calls[0];
    expect(file).toBe('docker');
    expect(args).toEqual(['exec', 'fritz-orchestrator', 'sh', '-c', RESTORE_SCRIPT]);
    expect((opts as ExecFileOptions).timeout).toBe(5000);
  });

  it('resolves even when execFile returns an error', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const callback = cb as (error: Error | null) => void;
      callback(new Error('container not found'));
      return new EventEmitter() as ChildProcess;
    });

    // Should not throw
    await expect(restoreClaudeJsonInContainer('nonexistent')).resolves.toBeUndefined();
  });

  it('resolves when child emits error event', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, _cb) => {
      const emitter = new EventEmitter() as ChildProcess;
      // Simulate process error (e.g. ENOENT)
      process.nextTick(() => emitter.emit('error', new Error('ENOENT')));
      return emitter;
    });

    await expect(restoreClaudeJsonInContainer('test')).resolves.toBeUndefined();
  });
});

describe('restoreClaudeJsonLocal', () => {
  it('calls execFile with sh -c and restore script (no docker prefix)', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const callback = cb as (error: Error | null) => void;
      callback(null);
      return new EventEmitter() as ChildProcess;
    });

    await restoreClaudeJsonLocal();

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [file, args] = mockedExecFile.mock.calls[0];
    expect(file).toBe('sh');
    expect(args).toEqual(['-c', RESTORE_SCRIPT]);
  });
});

// ── Stderr filtering ──

describe('filterClaudeStderr', () => {
  it('removes all three backup warning line variants', () => {
    const stderr = [
      'Claude configuration file not found at: /home/node/.claude.json',
      'A backup file exists at: /home/node/.claude/backups/.claude.json.backup.1774236994618',
      'You can manually restore it by running: cp "/home/node/.claude/backups/.claude.json.backup.1774236994618" "/home/node/.claude.json"',
    ].join('\n');

    expect(filterClaudeStderr(stderr)).toBe('');
  });

  it('preserves non-warning stderr lines', () => {
    const stderr = [
      'Claude configuration file not found at: /home/node/.claude.json',
      'Some real error happened',
      'A backup file exists at: /path/to/backup',
    ].join('\n');

    expect(filterClaudeStderr(stderr)).toBe('Some real error happened');
  });

  it('returns empty string for empty input', () => {
    expect(filterClaudeStderr('')).toBe('');
  });

  it('passes through unrelated stderr unchanged', () => {
    const stderr = 'Error: something went wrong\nAnother line';
    expect(filterClaudeStderr(stderr)).toBe(stderr);
  });

  it('handles lines with leading whitespace', () => {
    const stderr = '  Claude configuration file not found at: /path';
    expect(filterClaudeStderr(stderr)).toBe('');
  });
});

// ── Regex patterns ──

describe('CLAUDE_BACKUP_WARNING regex', () => {
  it('matches "Claude configuration file not found" line', () => {
    expect(CLAUDE_BACKUP_WARNING.test('Claude configuration file not found at: /home/node/.claude.json')).toBe(true);
  });

  it('matches "A backup file exists" line', () => {
    expect(CLAUDE_BACKUP_WARNING.test('A backup file exists at: /some/path')).toBe(true);
  });

  it('matches "You can manually restore" line', () => {
    expect(CLAUDE_BACKUP_WARNING.test('You can manually restore it by running: cp "/a" "/b"')).toBe(true);
  });

  it('does not match unrelated lines', () => {
    expect(CLAUDE_BACKUP_WARNING.test('Error: something else')).toBe(false);
    expect(CLAUDE_BACKUP_WARNING.test('configuration file loaded')).toBe(false);
    expect(CLAUDE_BACKUP_WARNING.test('')).toBe(false);
  });

  it('does not match partial matches in the middle of a line', () => {
    expect(CLAUDE_BACKUP_WARNING.test('XYZ Claude configuration file not found at: foo')).toBe(false);
  });
});
