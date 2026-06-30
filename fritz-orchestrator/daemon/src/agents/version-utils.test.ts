/**
 * Unit tests for version-utils.ts — Tier 1 pure unit tests.
 *
 * Covers: parseClaudeVersion, getLatestClaudeCodeVersion
 *
 * NOTE: version-capture.test.ts also tests these functions but focuses on
 * documenting known limitations (multiline output, update banners) with
 * explanatory comments for future maintainers. This file covers the standard
 * input/output behavior. The split is intentional — keeping the "known
 * limitation documentation" tests separate from the "normal behavior" tests.
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeVersion, getLatestClaudeCodeVersion } from './version-utils.js';
import type { LocalAgent } from '../core/registry.js';

// ---------------------------------------------------------------------------
// parseClaudeVersion
// ---------------------------------------------------------------------------

describe('parseClaudeVersion', () => {
  it('parses standard output "claude v2.1.39"', () => {
    expect(parseClaudeVersion('claude v2.1.39')).toBe('2.1.39');
  });

  it('parses version without "v" prefix: "claude 2.1.39"', () => {
    expect(parseClaudeVersion('claude 2.1.39')).toBe('2.1.39');
  });

  it('passes through plain version number: "2.1.39"', () => {
    expect(parseClaudeVersion('2.1.39')).toBe('2.1.39');
  });

  it('handles uppercase "Claude v2.1.39"', () => {
    expect(parseClaudeVersion('Claude v2.1.39')).toBe('2.1.39');
  });

  it('strips trailing newline', () => {
    expect(parseClaudeVersion('claude v2.1.39\n')).toBe('2.1.39');
  });

  it('strips leading/trailing whitespace', () => {
    expect(parseClaudeVersion('  claude v2.1.39  ')).toBe('2.1.39');
  });

  it('handles pre-release version', () => {
    expect(parseClaudeVersion('claude v2.2.0-beta.1')).toBe('2.2.0-beta.1');
  });

  it('preserves extra info after version', () => {
    expect(parseClaudeVersion('claude v2.1.39 (stable)')).toBe('2.1.39 (stable)');
  });

  it('uses first line only for multiline output', () => {
    const input = 'claude v2.1.39\nUpdate available: 2.2.0\nRun npm install -g to update';
    expect(parseClaudeVersion(input)).toBe('2.1.39');
  });

  it('handles leading blank lines (empty first line)', () => {
    // Known limitation of first-line-only design: leading blank lines cause
    // the function to return '' since the first line is empty. Non-fatal in
    // production — version stays undefined. See version-capture.test.ts for
    // more documentation of this design choice.
    const input = '\n\nclaude v2.1.39\n';
    expect(parseClaudeVersion(input)).toBe('');
  });

  it('extracts version from first line ignoring subsequent lines', () => {
    const input = 'claude v2.3.0\nSome warning about something';
    expect(parseClaudeVersion(input)).toBe('2.3.0');
  });
});

// ---------------------------------------------------------------------------
// getLatestClaudeCodeVersion
// ---------------------------------------------------------------------------

describe('getLatestClaudeCodeVersion', () => {
  // Helper to create a minimal LocalAgent-like object with required fields
  function makeAgent(overrides: Partial<LocalAgent> & { name: string; started: string }): LocalAgent {
    return {
      role: 'implement',
      issue: null,
      repo: null,
      branch: null,
      workspace: '/tmp/ws',
      ttl: 3600,
      ...overrides,
    } as LocalAgent;
  }

  it('returns the version from the most recently started agent', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T10:00:00Z', claudeCodeVersion: '2.1.38' }),
      makeAgent({ name: 'b', started: '2025-01-01T12:00:00Z', claudeCodeVersion: '2.1.39' }),
      makeAgent({ name: 'c', started: '2025-01-01T11:00:00Z', claudeCodeVersion: '2.1.37' }),
    ];

    expect(getLatestClaudeCodeVersion(agents)).toBe('2.1.39');
  });

  it('skips agents without claudeCodeVersion', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T14:00:00Z' }), // no version
      makeAgent({ name: 'b', started: '2025-01-01T12:00:00Z', claudeCodeVersion: '2.1.39' }),
    ];

    expect(getLatestClaudeCodeVersion(agents)).toBe('2.1.39');
  });

  it('returns undefined for empty agent list', () => {
    expect(getLatestClaudeCodeVersion([])).toBeUndefined();
  });

  it('returns undefined when no agents have versions', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T10:00:00Z' }),
      makeAgent({ name: 'b', started: '2025-01-01T12:00:00Z' }),
    ];

    expect(getLatestClaudeCodeVersion(agents)).toBeUndefined();
  });

  it('handles single agent with version', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T10:00:00Z', claudeCodeVersion: '2.1.40' }),
    ];

    expect(getLatestClaudeCodeVersion(agents)).toBe('2.1.40');
  });

  it('handles single agent without version', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T10:00:00Z' }),
    ];

    expect(getLatestClaudeCodeVersion(agents)).toBeUndefined();
  });

  it('picks latest by start time, not by version string', () => {
    const agents: LocalAgent[] = [
      makeAgent({ name: 'a', started: '2025-01-01T10:00:00Z', claudeCodeVersion: '9.9.9' }),
      makeAgent({ name: 'b', started: '2025-01-02T10:00:00Z', claudeCodeVersion: '1.0.0' }),
    ];

    // Agent b started later, so its version should be returned
    expect(getLatestClaudeCodeVersion(agents)).toBe('1.0.0');
  });
});
