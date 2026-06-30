/**
 * Vitest tests for Telegram boot mode formatting (Issue #263).
 *
 * Imports actual helper functions from telegram-helpers.ts and
 * message-sanitizer.ts. Tests escapeMd, formatHeader, and sanitize
 * which are the real source functions used during boot messaging.
 *
 * Covers:
 * - escapeMd escaping special characters
 * - formatHeader for boot messages
 * - sanitize message truncation and balancing
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../types.js', () => ({
  ROLE_EMOJI: {
    implement: '\u{1F528}',
    review: '\u{1F50D}',
    validate: '\u{2705}',
    define: '\u{1F4CB}',
    architect: '\u{1F3D7}',
    ux: '\u{1F3A8}',
    budget: '\u{1F4B0}',
    retro: '\u{1F50E}',
  },
}));

import { escapeMd, formatHeader } from './telegram-helpers.js';
import { sanitize, stripMarkdown } from './message-sanitizer.js';

// ── Tests ──

describe('escapeMd', () => {
  it('escapes underscores', () => {
    expect(escapeMd('hello_world')).toBe('hello\\_world');
  });

  it('escapes asterisks', () => {
    expect(escapeMd('a*b*c')).toBe('a\\*b\\*c');
  });

  it('escapes backticks', () => {
    expect(escapeMd('`code`')).toBe('\\`code\\`');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeMd('hello world')).toBe('hello world');
  });

  it('escapes multiple special chars', () => {
    expect(escapeMd('a_b*c')).toBe('a\\_b\\*c');
  });
});

describe('sanitize', () => {
  it('leaves valid markdown unchanged', () => {
    const result = sanitize('Hello *world*');
    expect(result.parseMode).toBe('Markdown');
    expect(result.text).toContain('world');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(5000);
    const result = sanitize(long);
    expect(result.text.length).toBeLessThanOrEqual(4096);
  });

  it('handles exact length text', () => {
    const exact = 'a'.repeat(4096);
    const result = sanitize(exact);
    expect(result.text.length).toBeLessThanOrEqual(4096);
  });

  it('auto-closes unclosed code blocks', () => {
    const result = sanitize('```\nsome code');
    expect(result.text).toContain('```');
    expect(result.warnings.some(w => w.includes('Unclosed code block'))).toBe(true);
  });

  it('balances unmatched backticks', () => {
    const result = sanitize('hello `code world');
    expect(result.text).toBeDefined();
    expect(result.parseMode).toBeDefined();
  });
});

describe('formatHeader for boot messages', () => {
  it('formats Docker boot message with issue number', () => {
    const msg = formatHeader('impl-42-abcd', 'implement', '\u{1F680}', {
      verb: 'started',
      issue: 42,
    });
    expect(msg).toContain('impl-42-abcd');
    expect(msg).toContain('implement');
    expect(msg).toContain('#42');
  });

  it('formats without issue number', () => {
    const msg = formatHeader('retro-scan-abcd', 'retro', '\u{1F50E}', {
      verb: 'started',
    });
    expect(msg).toContain('retro-scan-abcd');
    expect(msg).not.toContain('#');
  });

  it('formats with repo and branch', () => {
    const msg = formatHeader('impl-42', 'implement', '\u{1F680}', {
      verb: 'started',
      issue: 42,
      repo: 'owner/repo',
      branch: 'feature/42-fix',
    });
    expect(msg).toContain('owner/repo');
    expect(msg).toContain('feature/42-fix');
  });

  it('formats without repo', () => {
    const msg = formatHeader('agent', 'review', '\u{1F50D}', {
      verb: 'started',
      issue: 10,
    });
    expect(msg).not.toContain('\u{1F4E6}');
  });
});

describe('stripMarkdown', () => {
  it('removes bold markers', () => {
    expect(stripMarkdown('*bold text*')).toBe('bold text');
  });

  it('removes code markers', () => {
    expect(stripMarkdown('`code`')).toBe('code');
  });

  it('preserves link text', () => {
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here');
  });

  it('handles plain text', () => {
    expect(stripMarkdown('hello world')).toBe('hello world');
  });
});
