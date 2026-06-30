/**
 * Unit tests for message-sanitizer.ts
 *
 * Covers: sanitize, stripMarkdown
 */

import { describe, it, expect } from 'vitest';
import { sanitize, stripMarkdown } from './message-sanitizer.js';

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

describe('sanitize', () => {
  // --- Basic preservation ---

  it('passes plain text through unchanged', () => {
    const result = sanitize('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.parseMode).toBe('Markdown');
    expect(result.wasModified).toBe(false);
  });

  it('passes valid Markdown through unchanged', () => {
    const input = 'This is *bold* and `code`';
    const result = sanitize(input);
    expect(result.text).toBe(input);
    expect(result.parseMode).toBe('Markdown');
  });

  it('returns empty string for empty input', () => {
    const result = sanitize('');
    expect(result.text).toBe('');
    expect(result.parseMode).toBe('Markdown');
  });

  // --- CRLF normalization ---

  it('normalizes CRLF and CR line endings to LF', () => {
    const input = 'Line 1\r\nLine 2\rLine 3';
    const result = sanitize(input);
    expect(result.text).toBe('Line 1\nLine 2\nLine 3');
  });

  // --- Code block tests ---

  it('preserves a single code block', () => {
    const input = '```bash\necho hello\n```';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  it('preserves multiple code blocks', () => {
    const input = '```js\nconst x = 1;\n```\n\n```ts\nconst y: number = 2;\n```';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  it('auto-closes unclosed code blocks', () => {
    const input = 'Some text\n```bash\necho hello';
    const result = sanitize(input);
    expect(result.text).toBe(input + '\n```');
    expect(result.wasModified).toBe(true);
    expect(result.warnings).toContain('Unclosed code block detected, auto-closing');
  });

  it('preserves language specifier in code blocks', () => {
    const input = '```typescript\nconst x: number = 5;\n```';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  it('does not escape underscores inside code blocks', () => {
    const input = '```\nsome_variable_name\n```';
    const result = sanitize(input);
    expect(result.text).toBe(input);
    expect(result.text).not.toContain('\\_');
  });

  // --- Inline code tests ---

  it('preserves single inline code', () => {
    const input = 'Use the `console.log` function';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  it('preserves multiple inline codes', () => {
    const input = 'Both `foo` and `bar` are valid';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  it('escapes unmatched backtick', () => {
    const input = 'This has an unmatched ` backtick';
    const result = sanitize(input);
    expect(result.text).toContain('\\`');
    expect(result.wasModified).toBe(true);
    expect(result.warnings).toContain('Unmatched backtick detected, escaping');
  });

  it('does not escape underscores inside inline code', () => {
    const input = 'Use `some_func()` here';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  // --- Underscore escaping ---

  it('escapes underscores in plain text', () => {
    const input = 'This has_underscore_in it';
    const result = sanitize(input);
    expect(result.text).toBe('This has\\_underscore\\_in it');
  });

  it('handles mixed code and plain text underscores correctly', () => {
    const input = 'Plain text `code_with_underscore` more text_here';
    const result = sanitize(input);
    expect(result.text).toBe('Plain text `code_with_underscore` more text\\_here');
  });

  // --- Preserve links ---

  it('preserves links', () => {
    const input = 'See [my_link](https://example.com/path_here)';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  // --- Preserve bold ---

  it('preserves bold formatting', () => {
    const input = '*bold text* here';
    const result = sanitize(input);
    expect(result.text).toBe('*bold text* here');
  });

  // --- XML/HTML-like content ---

  it('handles XML/HTML-like content', () => {
    const input = '<div>content</div>';
    const result = sanitize(input);
    expect(result.text).toContain('content');
    expect(result.parseMode).toBe('Markdown');
  });

  // --- Truncation ---

  it('truncates very long messages to 4096 characters', () => {
    const longText = 'x'.repeat(5000);
    const result = sanitize(longText);
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text).toContain('_(truncated)_');
  });

  // --- Unicode ---

  it('handles unicode/emoji content with underscores', () => {
    const input = 'Hello 👋 world 🌍 with emoji_underscore';
    const result = sanitize(input);
    expect(result.text).toContain('👋');
    expect(result.text).toContain('🌍');
    expect(result.text).toContain('\\_');
  });

  // --- Mixed content ---

  it('handles mixed content: bold, code blocks, and plain text', () => {
    const input =
      '*Summary*\n\nUpdated `config_file.ts` and fixed the broken_link issue.\n\n```\nconst old_value = 1;\n```';
    const expected =
      '*Summary*\n\nUpdated `config_file.ts` and fixed the broken\\_link issue.\n\n```\nconst old_value = 1;\n```';
    const result = sanitize(input);
    expect(result.text).toBe(expected);
  });

  it('handles real agent response with code, links, and plain text underscores', () => {
    const input = `I've completed the implementation. Here's what I did:

1. Updated \`src/utils/parse_config.ts\` to handle edge cases
2. Fixed the \`validate_input\` function
3. Added error handling for missing_fields

\`\`\`typescript
function parse_config(input: string): Config {
  return JSON.parse(input);
}
\`\`\`

The PR is ready for review. See [PR #42](https://github.com/org/repo/pull/42) for details.`;

    const expected = `I've completed the implementation. Here's what I did:

1. Updated \`src/utils/parse_config.ts\` to handle edge cases
2. Fixed the \`validate_input\` function
3. Added error handling for missing\\_fields

\`\`\`typescript
function parse_config(input: string): Config {
  return JSON.parse(input);
}
\`\`\`

The PR is ready for review. See [PR #42](https://github.com/org/repo/pull/42) for details.`;

    const result = sanitize(input);
    expect(result.text).toBe(expected);
  });

  // --- No special chars ---

  it('passes through text without any special characters', () => {
    const input = 'Simple text with no special chars.';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  // --- Multiple code blocks and inline code ---

  it('preserves multiple inline code and code blocks together', () => {
    const input =
      'Run `cmd_one` then `cmd_two`.\n\n```\nline_a\n```\n\nThen `cmd_three`.';
    const result = sanitize(input);
    expect(result.text).toBe(input);
  });

  // --- Issue 228 reproduction tests ---

  it('handles XML and bash content (issue 228)', () => {
    const input = `Now I understand the context.

\`\`\`bash
mkdir -p ~/.fritz-certs && cd ~/.fritz-certs

# Create CA
openssl genrsa -out ca.key 4096
\`\`\`

\`\`\`xml
<?xml version="1.0" encoding="UTF-8"?>
<dict>
    <key>PayloadContent</key>
</dict>
\`\`\``;

    const result = sanitize(input);
    expect(result.parseMode).toBe('Markdown');
    expect(result.warnings).toHaveLength(0);
  });

  it('handles truncated code block (issue 228)', () => {
    const input = `Some intro text

\`\`\`bash
# Long script that got truncated
echo "Hello"
echo "World"
# ... more lines ...
cat > file.txt <<EOF
Some content here`;

    const result = sanitize(input);
    expect(result.parseMode).toBe('Markdown');
    expect(
      result.text.endsWith('```') || result.text.includes('```\n')
    ).toBe(true);
    expect(result.warnings).toContain('Unclosed code block detected, auto-closing');
  });

  // --- Balanced code blocks ---

  it('leaves balanced code blocks as-is', () => {
    const input = '```\ncode\n```';
    const result = sanitize(input);
    expect(result.text).toBe(input);
    expect(result.warnings).not.toContain('Unclosed code block detected, auto-closing');
  });
});

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe('stripMarkdown', () => {
  it('removes code block markers but preserves content', () => {
    const result = stripMarkdown('```bash\necho hello\n```');
    expect(result).not.toContain('```');
    expect(result).toContain('echo hello');
  });

  it('removes inline code markers', () => {
    expect(stripMarkdown('Use `code` here')).toBe('Use code here');
  });

  it('removes bold markers (double asterisk)', () => {
    expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
  });

  it('removes bold markers (single asterisk)', () => {
    expect(stripMarkdown('This is *bold* text')).toBe('This is bold text');
  });

  it('converts links to plain text (link text only)', () => {
    expect(stripMarkdown('Check [this link](https://example.com)')).toBe(
      'Check this link'
    );
  });

  it('removes escape characters and restores original chars', () => {
    expect(stripMarkdown('Escaped \\_underscore\\_ here')).toBe(
      'Escaped _underscore_ here'
    );
  });

  it('handles text with no markdown', () => {
    const plain = 'Just plain text here';
    expect(stripMarkdown(plain)).toBe(plain);
  });

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('strips all formatting from complex mixed content', () => {
    const input = '*Bold* and `code` with [link](http://ex.com) and ```block\ncode\n```';
    const result = stripMarkdown(input);
    expect(result).not.toContain('*');
    expect(result).not.toContain('`');
    expect(result).not.toContain('[');
    expect(result).not.toContain('](');
    expect(result).toContain('Bold');
    expect(result).toContain('code');
    expect(result).toContain('link');
  });
});
