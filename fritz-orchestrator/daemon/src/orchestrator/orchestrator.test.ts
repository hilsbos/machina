/**
 * Vitest tests for orchestrator identity loading and knowledge copy.
 *
 * Tests import directly from knowledge.ts (no config dependency) to avoid
 * drift between test re-implementations and actual code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadOrchestratorIdentity, copyKnowledge, DEFAULT_IDENTITY } from './knowledge.js';

// ── Test fixtures ──

const TEST_DIR = join(tmpdir(), `fritz-orchestrator-test-vitest-${Date.now()}`);
const FRITZ_ROOT = join(TEST_DIR, 'fritz-root');
const WORKSPACES_DIR = join(TEST_DIR, 'workspaces');
const WORKSPACE = join(WORKSPACES_DIR, 'fritz');

function setupTestDirs(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(FRITZ_ROOT, 'fritz', 'knowledge'), { recursive: true });
  mkdirSync(join(FRITZ_ROOT, '.claude', 'orchestrator', 'knowledge'), { recursive: true });
  mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function cleanupTestDirs(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ── Tests ──

describe('loadOrchestratorIdentity', () => {
  beforeEach(() => setupTestDirs());
  afterEach(() => cleanupTestDirs());

  it('falls back to hardcoded identity when SKILL.md is missing', () => {
    const identity = loadOrchestratorIdentity(FRITZ_ROOT, 'owner/repo');
    expect(identity).toContain('owner/repo');
    expect(identity).toContain('fritZ');
    expect(identity).not.toContain('{{GITHUB_REPO}}');
  });

  it('reads from SKILL.md when present', () => {
    const skillContent = `# Custom Orchestrator Identity

You are a custom orchestrator.
Repo: {{GITHUB_REPO}}
`;
    writeFileSync(join(FRITZ_ROOT, '.claude/orchestrator/SKILL.md'), skillContent);

    const identity = loadOrchestratorIdentity(FRITZ_ROOT, 'test/project');
    expect(identity).toContain('Custom Orchestrator Identity');
    expect(identity).toContain('test/project');
    expect(identity).not.toContain('{{GITHUB_REPO}}');
  });

  it('handles missing githubRepo gracefully', () => {
    const identity = loadOrchestratorIdentity(FRITZ_ROOT, '');
    expect(identity).toContain('(not configured)');
  });

  it('handles undefined githubRepo', () => {
    const identity = loadOrchestratorIdentity(FRITZ_ROOT, undefined);
    expect(identity).toContain('(not configured)');
  });

  it('replaces all occurrences of {{GITHUB_REPO}}', () => {
    const skillContent = `Repo: {{GITHUB_REPO}}
See also: {{GITHUB_REPO}}
`;
    writeFileSync(join(FRITZ_ROOT, '.claude/orchestrator/SKILL.md'), skillContent);

    const identity = loadOrchestratorIdentity(FRITZ_ROOT, 'multi/repo');
    expect(identity).not.toContain('{{GITHUB_REPO}}');
    const matches = identity.match(/multi\/repo/g);
    expect(matches?.length).toBe(2);
  });
});

describe('copyKnowledge', () => {
  beforeEach(() => setupTestDirs());
  afterEach(() => cleanupTestDirs());

  it('copies knowledge files from source to target', () => {
    writeFileSync(join(FRITZ_ROOT, 'fritz/knowledge/PATTERNS.md'), 'patterns content');
    writeFileSync(join(FRITZ_ROOT, 'fritz/knowledge/GOTCHAS.md'), 'gotchas content');

    const targetDir = join(WORKSPACE, '.fritz/knowledge');
    copyKnowledge(join(FRITZ_ROOT, 'fritz/knowledge'), targetDir);

    expect(existsSync(join(targetDir, 'PATTERNS.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'GOTCHAS.md'))).toBe(true);
    expect(readFileSync(join(targetDir, 'PATTERNS.md'), 'utf-8')).toBe('patterns content');
  });

  it('orchestrator knowledge overrides shared knowledge', () => {
    writeFileSync(join(FRITZ_ROOT, 'fritz/knowledge/PATTERNS.md'), 'patterns content');
    writeFileSync(join(FRITZ_ROOT, 'fritz/knowledge/GOTCHAS.md'), 'gotchas content');

    const targetDir = join(WORKSPACE, '.fritz/knowledge');
    copyKnowledge(join(FRITZ_ROOT, 'fritz/knowledge'), targetDir);

    // Now write orchestrator-specific override
    writeFileSync(
      join(FRITZ_ROOT, '.claude/orchestrator/knowledge/PATTERNS.md'),
      'orchestrator patterns override'
    );
    copyKnowledge(join(FRITZ_ROOT, '.claude/orchestrator/knowledge'), targetDir);

    expect(readFileSync(join(targetDir, 'PATTERNS.md'), 'utf-8'))
      .toBe('orchestrator patterns override');
    expect(readFileSync(join(targetDir, 'GOTCHAS.md'), 'utf-8'))
      .toBe('gotchas content');
  });

  it('gracefully handles missing source directory', () => {
    const targetDir = join(WORKSPACE, '.fritz/knowledge-test');
    copyKnowledge(join(FRITZ_ROOT, '.claude/nonexistent'), targetDir);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('creates target directory if it does not exist', () => {
    writeFileSync(join(FRITZ_ROOT, '.claude/orchestrator/knowledge/OPS.md'), 'ops content');
    const freshTarget = join(WORKSPACE, '.fritz/knowledge-fresh');
    copyKnowledge(join(FRITZ_ROOT, '.claude/orchestrator/knowledge'), freshTarget);
    expect(existsSync(join(freshTarget, 'OPS.md'))).toBe(true);
  });

  it('logs per-file copy failure and continues', () => {
    const logMessages: string[] = [];
    const testLog = (msg: string) => logMessages.push(msg);

    const srcDir = join(TEST_DIR, 'error-src');
    const targetDir = join(TEST_DIR, 'error-target');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'good.md'), 'good content');

    mkdirSync(join(srcDir, 'subdir'));
    writeFileSync(join(srcDir, 'subdir', 'inner.md'), 'inner');

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'subdir'), 'blocking file');

    copyKnowledge(srcDir, targetDir, testLog);
    expect(existsSync(join(targetDir, 'good.md'))).toBe(true);
    expect(logMessages.some(m => m.includes('Failed to copy knowledge file subdir'))).toBe(true);
    expect(logMessages.some(m => m.includes('Copied 1'))).toBe(true);
  });
});

describe('DEFAULT_IDENTITY', () => {
  it('contains expected content', () => {
    expect(DEFAULT_IDENTITY).toContain('fritZ');
    expect(DEFAULT_IDENTITY).toContain('{{GITHUB_REPO}}');
  });
});
