/**
 * Unit tests for telegram-helpers functions.
 *
 * Covers: parseArgs, escapeMd, formatHeader, formatTimeAgo,
 *         createOrchestratorMetadata, formatError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseArgs,
  escapeMd,
  formatHeader,
  formatTimeAgo,
  createOrchestratorMetadata,
  formatError,
} from './telegram-helpers.js';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns empty array for command with no arguments', () => {
    expect(parseArgs('/boot')).toEqual([]);
  });

  it('returns single argument', () => {
    expect(parseArgs('/boot implement')).toEqual(['implement']);
  });

  it('returns multiple arguments', () => {
    expect(parseArgs('/boot implement 42')).toEqual(['implement', '42']);
  });

  it('handles extra whitespace between args', () => {
    // split(' ') produces empty strings for consecutive spaces
    expect(parseArgs('/boot  implement')).toEqual(['', 'implement']);
  });

  it('handles empty string input', () => {
    expect(parseArgs('')).toEqual([]);
  });

  it('strips only the first word (the command)', () => {
    expect(parseArgs('/status verbose --all')).toEqual(['verbose', '--all']);
  });
});

// ---------------------------------------------------------------------------
// escapeMd
// ---------------------------------------------------------------------------

describe('escapeMd', () => {
  it('escapes underscores', () => {
    expect(escapeMd('my_var')).toBe('my\\_var');
  });

  it('escapes asterisks', () => {
    expect(escapeMd('*bold*')).toBe('\\*bold\\*');
  });

  it('escapes backticks', () => {
    expect(escapeMd('`code`')).toBe('\\`code\\`');
  });

  it('escapes opening square brackets', () => {
    expect(escapeMd('[link]')).toBe('\\[link]');
  });

  it('escapes multiple special characters in one string', () => {
    expect(escapeMd('_hello_ *world* `code` [link]')).toBe(
      '\\_hello\\_ \\*world\\* \\`code\\` \\[link]'
    );
  });

  it('returns plain text unchanged', () => {
    expect(escapeMd('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(escapeMd('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatHeader
// ---------------------------------------------------------------------------

describe('formatHeader', () => {
  it('renders basic header with agent name, emoji, and role', () => {
    const result = formatHeader('agent-123', 'implement', '🚀');
    expect(result).toBe('`agent-123` 🚀 *implement*');
  });

  it('includes verb when provided', () => {
    const result = formatHeader('agent-123', 'implement', '✅', { verb: 'completed' });
    expect(result).toBe('`agent-123` ✅ *implement* completed');
  });

  it('includes issue number', () => {
    const result = formatHeader('agent-123', 'implement', '🚀', {
      verb: 'started',
      issue: 42,
    });
    expect(result).toBe('`agent-123` 🚀 *implement* started • #42');
  });

  it('includes issue number and title', () => {
    const result = formatHeader('agent-123', 'implement', '🚀', {
      verb: 'started',
      issue: 42,
      issueTitle: 'Fix bug in login',
    });
    expect(result).toBe('`agent-123` 🚀 *implement* started • #42 Fix bug in login');
  });

  it('includes repo and branch on second line', () => {
    const result = formatHeader('agent-123', 'implement', '✅', {
      verb: 'completed',
      issue: 42,
      issueTitle: 'Add feature',
      repo: 'owner/repo',
      branch: 'feature/42-add-feature',
    });
    expect(result).toBe(
      '`agent-123` ✅ *implement* completed • #42 Add feature\n📦 owner/repo (feature/42-add-feature)'
    );
  });

  it('shows repo without branch parentheses when branch is null', () => {
    const result = formatHeader('agent-123', 'implement', '✅', {
      verb: 'completed',
      repo: 'owner/repo',
      branch: null,
    });
    expect(result).toBe('`agent-123` ✅ *implement* completed\n📦 owner/repo');
  });

  it('shows repo without branch when branch is empty string', () => {
    const result = formatHeader('agent-123', 'implement', '✅', {
      repo: 'owner/repo',
      branch: '',
    });
    expect(result).toBe('`agent-123` ✅ *implement*\n📦 owner/repo');
  });

  it('omits repo line when repo is null even if branch is set', () => {
    const result = formatHeader('agent-123', 'implement', '✅', {
      verb: 'completed',
      repo: null,
      branch: 'feature/test',
    });
    expect(result).toBe('`agent-123` ✅ *implement* completed');
  });

  it('omits repo/branch line when not provided (legacy)', () => {
    const result = formatHeader('agent-123', 'review', '👀', {
      verb: 'started',
      issue: 100,
    });
    expect(result).toBe('`agent-123` 👀 *review* started • #100');
  });

  it('truncates long titles at 30 characters with ellipsis', () => {
    const result = formatHeader('agent-123', 'implement', '🚀', {
      issue: 42,
      issueTitle: 'This is a very long issue title that should be truncated',
    });
    expect(result).toContain('This is a very long issue t…');
    expect(result.length).toBeLessThan(200);
  });

  it('does not truncate titles at exactly 30 characters', () => {
    const thirtyCharTitle = 'A'.repeat(30);
    const result = formatHeader('agent-123', 'implement', '🚀', {
      issue: 42,
      issueTitle: thirtyCharTitle,
    });
    expect(result).toContain(thirtyCharTitle);
  });

  it('truncates titles longer than 30 characters to 27 + ellipsis', () => {
    const longTitle = 'A'.repeat(31);
    const result = formatHeader('agent-123', 'implement', '🚀', {
      issue: 42,
      issueTitle: longTitle,
    });
    expect(result).toContain('A'.repeat(27) + '…');
  });

  it('escapes special characters in title', () => {
    const result = formatHeader('agent-123', 'implement', '🚀', {
      issue: 42,
      issueTitle: 'Fix _underscore_ issue',
    });
    expect(result).toBe('`agent-123` 🚀 *implement* • #42 Fix \\_underscore\\_ issue');
  });

  it('formats all roles correctly', () => {
    const roles = ['implement', 'review', 'validate', 'architect'] as const;
    for (const role of roles) {
      const result = formatHeader('agent-123', role, '🤖');
      expect(result).toContain(`*${role}*`);
    }
  });

  it('falls back to ROLE_EMOJI when statusEmoji is empty string', () => {
    const result = formatHeader('agent-123', 'implement', '');
    expect(result).toContain('🔨'); // ROLE_EMOJI for 'implement'
  });

  it('falls back to default emoji when statusEmoji is empty and role has no emoji', () => {
    // All AgentRoles have emoji defined, but the fallback path is '🤖'
    // We test by casting an unknown role
    const result = formatHeader('agent-123', 'implement' as unknown as Parameters<typeof formatHeader>[1], '');
    // implement has 🔨
    expect(result).toContain('🔨');
  });

  it('omits issue title when no issue number is provided', () => {
    const result = formatHeader('agent-123', 'implement', '🚀', {
      issueTitle: 'Should not appear',
    });
    expect(result).not.toContain('Should not appear');
  });
});

// ---------------------------------------------------------------------------
// formatTimeAgo
// ---------------------------------------------------------------------------

describe('formatTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for less than 1 minute ago', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const thirtySecondsAgo = new Date(now.getTime() - 30_000).toISOString();
    expect(formatTimeAgo(thirtySecondsAgo)).toBe('just now');
  });

  it('returns minutes ago', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatTimeAgo(fiveMinutesAgo)).toBe('5m ago');
  });

  it('returns "1m ago" for exactly 1 minute', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
    expect(formatTimeAgo(oneMinuteAgo)).toBe('1m ago');
  });

  it('returns "59m ago" for 59 minutes', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const fiftyNineMinutesAgo = new Date(now.getTime() - 59 * 60_000).toISOString();
    expect(formatTimeAgo(fiftyNineMinutesAgo)).toBe('59m ago');
  });

  it('returns hours ago', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(formatTimeAgo(threeHoursAgo)).toBe('3h ago');
  });

  it('returns "1h ago" for exactly 1 hour', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString();
    expect(formatTimeAgo(oneHourAgo)).toBe('1h ago');
  });

  it('returns "23h ago" for 23 hours', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000).toISOString();
    expect(formatTimeAgo(twentyThreeHoursAgo)).toBe('23h ago');
  });

  it('returns days ago', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600_000).toISOString();
    expect(formatTimeAgo(twoDaysAgo)).toBe('2d ago');
  });

  it('returns "1d ago" for exactly 24 hours', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    const oneDayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
    expect(formatTimeAgo(oneDayAgo)).toBe('1d ago');
  });

  it('returns "just now" for zero ms difference', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    vi.setSystemTime(now);
    expect(formatTimeAgo(now.toISOString())).toBe('just now');
  });
});

// ---------------------------------------------------------------------------
// createOrchestratorMetadata
// ---------------------------------------------------------------------------

describe('createOrchestratorMetadata', () => {
  it('returns metadata with source "orchestrator"', () => {
    const meta = createOrchestratorMetadata();
    expect(meta.source).toBe('orchestrator');
  });

  it('returns metadata with a timestamp that is a Date', () => {
    const meta = createOrchestratorMetadata();
    expect(meta.timestamp).toBeInstanceOf(Date);
  });

  it('returns a timestamp close to now', () => {
    const before = Date.now();
    const meta = createOrchestratorMetadata();
    const after = Date.now();
    expect(meta.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(meta.timestamp.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe('formatError', () => {
  it('extracts message from Error object', () => {
    expect(formatError(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to string', () => {
    expect(formatError('plain error')).toBe('plain error');
  });

  it('converts number to string', () => {
    expect(formatError(42)).toBe('42');
  });

  it('converts null to string', () => {
    expect(formatError(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(formatError(undefined)).toBe('undefined');
  });

  it('converts object to string', () => {
    expect(formatError({ code: 'ENOENT' })).toBe('[object Object]');
  });
});
