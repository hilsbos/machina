/**
 * Vitest tests for version capture utilities (Issue #318).
 *
 * Documents known limitations and edge cases of parseClaudeVersion and
 * getLatestClaudeCodeVersion from version-utils.ts, with explanatory
 * comments for future maintainers.
 *
 * NOTE: version-utils.test.ts covers the standard input/output behavior.
 * This file focuses on documenting known limitations (multiline output,
 * update banners) and production impact. The split is intentional.
 *
 * Covers:
 * - Standard "claude v2.1.39" format
 * - Without "v" prefix: "claude 2.1.39"
 * - Plain version: "2.1.39"
 * - Multiline output with update banners (known limitation)
 * - Whitespace handling
 * - getLatestClaudeCodeVersion from agent list
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeVersion, getLatestClaudeCodeVersion } from './version-utils.js';

// ── Tests ──

describe('parseClaudeVersion', () => {
  it('parses standard "claude v2.1.39" format', () => {
    expect(parseClaudeVersion('claude v2.1.39')).toBe('2.1.39');
  });

  it('parses without v prefix: "claude 2.1.39"', () => {
    expect(parseClaudeVersion('claude 2.1.39')).toBe('2.1.39');
  });

  it('parses plain version: "2.1.39"', () => {
    expect(parseClaudeVersion('2.1.39')).toBe('2.1.39');
  });

  it('handles multiline output — first-line-only design (known limitation)', () => {
    // parseClaudeVersion() uses first line only by design (see version-utils.ts).
    // When an update banner precedes the version line, the banner text is returned
    // instead of the version number. This is a known limitation — in production,
    // the daemon captures version via `docker exec claude --version` with a 5s
    // timeout and the result is non-fatal if unexpected (version stays undefined).
    const multiline = `Some update banner text\nclaude v2.1.39\n`;
    expect(parseClaudeVersion(multiline)).toBe('Some update banner text');
  });

  it('documents real-world update banner scenario', () => {
    // Real-world scenario: Claude Code CLI sometimes prints update notices
    // before the version line. The first-line-only approach returns the
    // notice text rather than the actual version. Documented as known
    // limitation (first-line-only). Non-fatal in production — see GOTCHAS.md
    // "claude --version output format" entry.
    const realWorld = `Update available: 2.1.39 -> 2.1.40\nclaude v2.1.39\n`;
    expect(parseClaudeVersion(realWorld)).toBe('Update available: 2.1.39 -> 2.1.40');
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseClaudeVersion('  claude v2.1.39  ')).toBe('2.1.39');
  });

  it('handles newline at end', () => {
    expect(parseClaudeVersion('claude v2.1.39\n')).toBe('2.1.39');
  });

  it('is case-insensitive on "claude" prefix', () => {
    expect(parseClaudeVersion('Claude v2.1.39')).toBe('2.1.39');
    expect(parseClaudeVersion('CLAUDE v2.1.39')).toBe('2.1.39');
  });

  it('handles version with only two segments', () => {
    expect(parseClaudeVersion('claude v2.1')).toBe('2.1');
  });

  it('handles empty string', () => {
    expect(parseClaudeVersion('')).toBe('');
  });
});

describe('getLatestClaudeCodeVersion', () => {
  it('returns version from most recently booted agent', () => {
    const agents = [
      { name: 'a1', claudeCodeVersion: '2.1.38', started: '2026-02-23T10:00:00Z' },
      { name: 'a2', claudeCodeVersion: '2.1.39', started: '2026-02-23T11:00:00Z' },
      { name: 'a3', claudeCodeVersion: '2.1.37', started: '2026-02-23T09:00:00Z' },
    ] as unknown[];
    expect(getLatestClaudeCodeVersion(agents)).toBe('2.1.39');
  });

  it('returns undefined for empty agent list', () => {
    expect(getLatestClaudeCodeVersion([])).toBeUndefined();
  });

  it('skips agents without version', () => {
    const agents = [
      { name: 'a1', claudeCodeVersion: undefined, started: '2026-02-23T11:00:00Z' },
      { name: 'a2', claudeCodeVersion: '2.1.39', started: '2026-02-23T10:00:00Z' },
    ] as unknown[];
    expect(getLatestClaudeCodeVersion(agents)).toBe('2.1.39');
  });

  it('returns undefined when no agent has version', () => {
    const agents = [
      { name: 'a1', claudeCodeVersion: undefined, started: '2026-02-23T10:00:00Z' },
    ] as unknown[];
    expect(getLatestClaudeCodeVersion(agents)).toBeUndefined();
  });
});
