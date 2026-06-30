/**
 * Message Sanitizer for Telegram Markdown v1
 *
 * Provides robust sanitization for agent messages to ensure they
 * are parseable by Telegram's strict Markdown v1 parser.
 *
 * Issue #228: Telegram API failures caused by malformed Markdown entities
 */

export interface SanitizeResult {
  text: string;
  parseMode: 'Markdown' | 'text';
  wasModified: boolean;
  warnings: string[];
}

// Placeholder format using non-printable characters to avoid collision
const PLACEHOLDER_PREFIX = '\x00PH';
const PLACEHOLDER_SUFFIX = '\x00';

/**
 * Main sanitization function - 6-stage pipeline for Telegram Markdown v1
 */
export function sanitize(text: string): SanitizeResult {
  const warnings: string[] = [];
  let wasModified = false;
  let result = text;

  try {
    // Stage 1: Normalize line endings
    const normalized = normalizeLineEndings(result);
    if (normalized !== result) wasModified = true;
    result = normalized;

    // Stage 2: Balance code blocks (``` ... ```)
    const balanced = balanceCodeBlocks(result, warnings);
    if (balanced !== result) wasModified = true;
    result = balanced;

    // Stage 3: Balance inline code (` ... `)
    const inlineBalanced = balanceInlineCode(result, warnings);
    if (inlineBalanced !== result) wasModified = true;
    result = inlineBalanced;

    // Stage 4 & 5: Protect regions and escape dangerous chars
    const escaped = escapeWithProtection(result);
    if (escaped !== result) wasModified = true;
    result = escaped;

    // Stage 6: Validate and truncate
    result = truncateIfNeeded(result, warnings);

    // Validate the result can be parsed
    if (!isValidMarkdown(result)) {
      warnings.push('Failed validation, falling back to plain text');
      return {
        text: stripMarkdown(text),
        parseMode: 'text',
        wasModified: true,
        warnings,
      };
    }

    return {
      text: result,
      parseMode: 'Markdown',
      wasModified,
      warnings,
    };
  } catch (error) {
    // If anything goes wrong, fall back to plain text
    warnings.push(`Sanitization error: ${error instanceof Error ? error.message : String(error)}`);
    return {
      text: stripMarkdown(text),
      parseMode: 'text',
      wasModified: true,
      warnings,
    };
  }
}

/**
 * Stage 1: Normalize line endings and remove problematic characters
 */
function normalizeLineEndings(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x00/g, ''); // Remove null bytes (except our placeholders)
}

/**
 * Stage 2: Balance code blocks (``` ... ```)
 * Ensures all opening ``` have matching closing ```
 */
function balanceCodeBlocks(text: string, warnings: string[]): string {
  // Count code block markers
  const markers = text.match(/```/g) || [];
  const count = markers.length;

  if (count === 0) {
    return text;
  }

  if (count % 2 !== 0) {
    // Odd number of markers - need to close the last unclosed block
    warnings.push('Unclosed code block detected, auto-closing');
    return text + '\n```';
  }

  return text;
}

/**
 * Stage 3: Balance inline code (` ... `)
 * Ensures backticks outside code blocks are properly matched
 */
function balanceInlineCode(text: string, warnings: string[]): string {
  const placeholders: string[] = [];

  // First, extract code blocks to protect them
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
  });

  // Count remaining backticks (outside code blocks)
  const backticks = result.match(/`/g) || [];
  if (backticks.length % 2 !== 0) {
    // Odd number - escape the last unmatched backtick
    warnings.push('Unmatched backtick detected, escaping');
    // Find the last backtick and escape it
    const lastIdx = result.lastIndexOf('`');
    result = result.slice(0, lastIdx) + '\\`' + result.slice(lastIdx + 1);
  }

  // Restore code blocks
  result = result.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, idx) => placeholders[parseInt(idx, 10)]
  );

  return result;
}

/**
 * Stage 4 & 5: Protect special regions and escape dangerous characters
 */
function escapeWithProtection(text: string): string {
  const placeholders: string[] = [];

  function placeholder(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
  }

  // 1. Extract code blocks (``` ... ```)
  let result = text.replace(/```[\s\S]*?```/g, (match) => placeholder(match));

  // 2. Extract inline code (` ... `)
  result = result.replace(/`[^`]+`/g, (match) => placeholder(match));

  // 3. Extract links [text](url)
  result = result.replace(/\[[^\]]*\]\([^)]*\)/g, (match) => placeholder(match));

  // 4. Extract and validate bold *text* (matched pairs only)
  result = result.replace(/\*[^*\n]+\*/g, (match) => placeholder(match));

  // 5. Escape underscores in remaining plain text
  result = result.replace(/_/g, '\\_');

  // 6. Escape unmatched asterisks (those remaining after extraction)
  // Only escape if there's an odd number of remaining asterisks
  const remainingAsterisks = (result.match(/(?<!\\)\*/g) || []).length;
  if (remainingAsterisks % 2 !== 0) {
    // Escape all remaining asterisks since they're unmatched
    result = result.replace(/(?<!\\)\*/g, '\\*');
  }

  // 7. Escape brackets that aren't part of links (already extracted)
  // Only escape [ if not followed by ](
  result = result.replace(/\[(?![^\]]*\]\()/g, '\\[');

  // 8. Restore placeholders
  result = result.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, idx) => placeholders[parseInt(idx, 10)]
  );

  return result;
}

/**
 * Stage 6: Truncate if message exceeds Telegram's 4096 char limit
 */
function truncateIfNeeded(text: string, warnings: string[]): string {
  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    return text;
  }

  warnings.push(`Message truncated from ${text.length} to ${MAX_LENGTH} chars`);

  // Try to truncate at a natural boundary
  let truncated = text.slice(0, MAX_LENGTH - 20);

  // Ensure we don't truncate mid-entity
  // Check for unclosed code blocks in truncated text
  const codeBlockCount = (truncated.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    // Find the last ``` and truncate before it
    const lastMarker = truncated.lastIndexOf('```');
    if (lastMarker > 0) {
      truncated = truncated.slice(0, lastMarker);
    }
  }

  // Ensure we don't truncate mid-inline-code
  const backtickCount = (truncated.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    const lastBacktick = truncated.lastIndexOf('`');
    if (lastBacktick > 0) {
      truncated = truncated.slice(0, lastBacktick);
    }
  }

  return truncated.trim() + '\n\n_(truncated)_';
}

/**
 * Basic validation that Markdown entities are balanced
 */
function isValidMarkdown(text: string): boolean {
  // Extract code blocks first
  const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, '');

  // Check inline code balance
  const inlineBackticks = (withoutCodeBlocks.match(/(?<!\\)`/g) || []).length;
  if (inlineBackticks % 2 !== 0) {
    return false;
  }

  // Check bold asterisk balance (outside code)
  const withoutInlineCode = withoutCodeBlocks.replace(/`[^`]+`/g, '');
  const asterisks = (withoutInlineCode.match(/(?<!\\)\*/g) || []).length;
  if (asterisks % 2 !== 0) {
    return false;
  }

  return true;
}

/**
 * Strip all Markdown formatting - always succeeds
 * Used as ultimate fallback
 */
export function stripMarkdown(text: string): string {
  // Use unique placeholders for each escaped character type
  const placeholders = new Map<string, string>();
  let counter = 0;

  // Step 1: Replace escaped characters with unique placeholders
  let result = text.replace(/\\([_*`\[])/g, (_, char) => {
    const placeholder = `\x01${counter++}\x01`;
    placeholders.set(placeholder, char);
    return placeholder;
  });

  // Step 2: Remove markdown formatting
  result = result
    // Remove code block markers (keep content)
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    // Remove inline code markers (keep content)
    .replace(/`/g, '')
    // Remove bold markers (keep content)
    .replace(/\*\*?/g, '')
    // Remove italic markers (keep content)
    .replace(/_/g, '')
    // Convert links to plain text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Step 3: Restore escaped characters
  for (const [placeholder, char] of placeholders) {
    result = result.replace(placeholder, char);
  }

  return result;
}
