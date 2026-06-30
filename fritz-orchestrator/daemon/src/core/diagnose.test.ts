/**
 * Vitest tests for diagnose-utils (git blob hash, directory state, drift detection).
 *
 * These test the pure utility functions in diagnose-utils.ts directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  gitBlobHash,
  hashDirectory,
  compareStates,
  type DirectoryState,
} from './diagnose-utils.js';

const TEST_DIR = join(tmpdir(), `fritz-diagnose-test-${Date.now()}`);

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('gitBlobHash', () => {
  it('produces consistent hash for same content', () => {
    const content = Buffer.from('hello world\n');
    const hash1 = gitBlobHash(content);
    const hash2 = gitBlobHash(content);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different content', () => {
    const hash1 = gitBlobHash(Buffer.from('content a'));
    const hash2 = gitBlobHash(Buffer.from('content b'));
    expect(hash1).not.toBe(hash2);
  });

  it('returns a 40-character hex string', () => {
    const hash = gitBlobHash(Buffer.from('test'));
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('hashDirectory', () => {
  it('lists all files with hashes', () => {
    writeFileSync(join(TEST_DIR, 'a.txt'), 'content a');
    writeFileSync(join(TEST_DIR, 'b.txt'), 'content b');

    const state = hashDirectory(TEST_DIR);
    expect(state.totalFiles).toBe(2);
    expect(state.files.map(f => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(state.computedAt).toBeTruthy();
  });

  it('handles empty directory', () => {
    const state = hashDirectory(TEST_DIR);
    expect(state.totalFiles).toBe(0);
    expect(state.files).toEqual([]);
  });

  it('includes subdirectory files', () => {
    mkdirSync(join(TEST_DIR, 'sub'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'sub', 'nested.txt'), 'nested');

    const state = hashDirectory(TEST_DIR);
    expect(state.totalFiles).toBe(1);
    expect(state.files[0].path).toContain('nested.txt');
  });

  it('returns file sizes', () => {
    writeFileSync(join(TEST_DIR, 'file.txt'), 'hello');
    const state = hashDirectory(TEST_DIR);
    expect(state.files[0].size).toBeGreaterThan(0);
  });
});

describe('compareStates', () => {
  it('detects no drift for identical states', () => {
    writeFileSync(join(TEST_DIR, 'same.txt'), 'content');
    const state = hashDirectory(TEST_DIR);
    const drift = compareStates(state, state);
    expect(drift).toHaveLength(0);
  });

  it('detects modified files', () => {
    const localState: DirectoryState = {
      files: [{ path: 'a.txt', hash: 'hash-a-local', size: 10 }],
      totalFiles: 1,
      computedAt: new Date().toISOString(),
    };
    const remoteState: DirectoryState = {
      files: [{ path: 'a.txt', hash: 'hash-a-remote', size: 10 }],
      totalFiles: 1,
      computedAt: new Date().toISOString(),
    };

    const drift = compareStates(localState, remoteState);
    expect(drift).toHaveLength(1);
    expect(drift[0].type).toBe('modified');
    expect(drift[0].path).toBe('a.txt');
  });

  it('detects deleted files (local only, missing remote)', () => {
    const localState: DirectoryState = {
      files: [
        { path: 'a.txt', hash: 'hash-a', size: 10 },
        { path: 'local-only.txt', hash: 'hash-local', size: 5 },
      ],
      totalFiles: 2,
      computedAt: new Date().toISOString(),
    };
    const remoteState: DirectoryState = {
      files: [{ path: 'a.txt', hash: 'hash-a', size: 10 }],
      totalFiles: 1,
      computedAt: new Date().toISOString(),
    };

    const drift = compareStates(localState, remoteState);
    expect(drift).toHaveLength(1);
    expect(drift[0].type).toBe('deleted');
    expect(drift[0].path).toBe('local-only.txt');
  });

  it('detects added files (remote only, missing local)', () => {
    const localState: DirectoryState = {
      files: [{ path: 'a.txt', hash: 'hash-a', size: 10 }],
      totalFiles: 1,
      computedAt: new Date().toISOString(),
    };
    const remoteState: DirectoryState = {
      files: [
        { path: 'a.txt', hash: 'hash-a', size: 10 },
        { path: 'remote-only.txt', hash: 'hash-remote', size: 5 },
      ],
      totalFiles: 2,
      computedAt: new Date().toISOString(),
    };

    const drift = compareStates(localState, remoteState);
    expect(drift).toHaveLength(1);
    expect(drift[0].type).toBe('added');
    expect(drift[0].path).toBe('remote-only.txt');
  });

  it('detects mixed changes', () => {
    const localState: DirectoryState = {
      files: [
        { path: 'a.txt', hash: 'hash-a-new', size: 10 },
        { path: 'local-only.txt', hash: 'hash-local', size: 5 },
      ],
      totalFiles: 2,
      computedAt: new Date().toISOString(),
    };
    const remoteState: DirectoryState = {
      files: [
        { path: 'a.txt', hash: 'hash-a-old', size: 10 },
        { path: 'remote-only.txt', hash: 'hash-remote', size: 5 },
      ],
      totalFiles: 2,
      computedAt: new Date().toISOString(),
    };

    const drift = compareStates(localState, remoteState);
    expect(drift).toHaveLength(3);
    expect(drift.find(d => d.type === 'modified')?.path).toBe('a.txt');
    expect(drift.find(d => d.type === 'deleted')?.path).toBe('local-only.txt');
    expect(drift.find(d => d.type === 'added')?.path).toBe('remote-only.txt');
  });
});
