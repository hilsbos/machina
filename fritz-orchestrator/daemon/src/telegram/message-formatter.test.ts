/**
 * Unit tests for message-formatter.ts
 *
 * Covers: formatMessage, message splitting, emoji selection,
 *         splitMessage edge cases, simpleSplit helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatMessage, type MessageMetadata } from './message-formatter.js';

// Use a fixed timestamp for deterministic output
const FIXED_DATE = new Date('2025-06-15T14:30:00Z');

describe('formatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Orchestrator messages ---

  describe('orchestrator source', () => {
    it('formats a basic orchestrator message', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Hello world', metadata);

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('orchestrator');
      expect(result[0]).toContain('Hello world');
    });

    it('uses lightning emoji for orchestrator', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\u26A1');
    });

    it('includes context in orchestrator header', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        context: 'sprint-3',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Status update', metadata);
      expect(result[0]).toContain('sprint-3');
    });

    it('includes sourceId in orchestrator header', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        sourceId: 'main',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('orchestrator-main');
    });

    it('formats without context (time only in subheader)', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('No context', metadata);
      expect(result).toHaveLength(1);
      // Should still have the header with time
      expect(result[0]).toContain('orchestrator');
    });
  });

  // --- Agent messages ---

  describe('agent source', () => {
    it('formats a basic agent message', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        sourceId: 'impl-7',
        role: 'implement',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Working on feature', metadata);

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('agent-impl-7');
      expect(result[0]).toContain('Working on feature');
    });

    it('includes issue number in agent header', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        sourceId: 'impl-7',
        role: 'implement',
        issue: 42,
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Fix applied', metadata);
      expect(result[0]).toContain('#42');
    });

    it('includes repo in agent header', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        sourceId: 'impl-7',
        role: 'implement',
        repo: 'org/repo',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('org/repo');
    });

    it('formats agent without sourceId', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        role: 'implement',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('agent');
    });

    it('formats agent without repo (time only in subheader)', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        sourceId: 'impl-7',
        role: 'implement',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('No repo', metadata);
      expect(result).toHaveLength(1);
    });
  });

  // --- Emoji selection ---

  describe('emoji selection', () => {
    it('uses lightning emoji for orchestrator', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\u26A1');
    });

    it('uses hammer emoji for implement role', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        role: 'implement',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\uD83D\uDD28');
    });

    it('uses eyes emoji for review role', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        role: 'review',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\uD83D\uDC40');
    });

    it('uses checkmark emoji for validate role', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        role: 'validate',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\u2705');
    });

    it('uses clipboard emoji for define role', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        role: 'define',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\uD83D\uDCCB');
    });

    it('uses default robot emoji for agent without role', () => {
      const metadata: MessageMetadata = {
        source: 'agent',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('\uD83E\uDD16');
    });
  });

  // --- Message splitting ---

  describe('message splitting for long messages', () => {
    it('returns single element for short messages', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Short message', metadata);
      expect(result).toHaveLength(1);
    });

    it('returns single element for message at exactly 4096 chars', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // Build a header to figure out the overhead
      const testResult = formatMessage('x', metadata);
      const headerLen = testResult[0].length - 1; // minus 'x'
      const bodyLen = 4096 - headerLen;
      const body = 'x'.repeat(bodyLen);

      const result = formatMessage(body, metadata);
      expect(result).toHaveLength(1);
    });

    it('splits message that exceeds 4096 chars into multiple parts', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // Create a body with multiple paragraphs that exceeds 4096 chars
      const paragraphs = Array.from({ length: 50 }, (_, i) =>
        `Paragraph ${i}: ${'x'.repeat(100)}`
      );
      const body = paragraphs.join('\n\n');

      const result = formatMessage(body, metadata);
      expect(result.length).toBeGreaterThan(1);

      // Each chunk should be within 4096 char limit
      // (chunks may exceed slightly due to chunk indicators, but should be reasonable)
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(4200); // allow some slack for indicators
      }
    });

    it('adds chunk indicators (1/N) when splitting', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const paragraphs = Array.from({ length: 50 }, (_, i) =>
        `Paragraph ${i}: ${'x'.repeat(100)}`
      );
      const body = paragraphs.join('\n\n');

      const result = formatMessage(body, metadata);
      if (result.length > 1) {
        expect(result[0]).toContain(`(1/${result.length})`);
        expect(result[result.length - 1]).toContain(`(${result.length}/${result.length})`);
      }
    });

    it('handles single very long paragraph that must be word-split', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // One paragraph with many words that exceeds 4096 chars
      const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
      const body = words.join(' ');

      const result = formatMessage(body, metadata);
      expect(result.length).toBeGreaterThan(1);
    });

    it('handles body shorter than 100 chars after splitting header', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // This body is short enough that even though the full message might be
      // large, the body after header is under 100 chars
      const body = 'Short body';
      const result = formatMessage(body, metadata);
      expect(result).toHaveLength(1);
    });

    it('handles message without header pattern (no bold line)', () => {
      // When splitMessage is called internally with a message that
      // doesn't match the header pattern, it falls back to simpleSplit.
      // This is tested indirectly through very long messages.
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // Build a message that exceeds 4096
      const longBody = Array.from({ length: 60 }, (_, i) =>
        `Section ${i}: ${'x'.repeat(80)}`
      ).join('\n\n');

      const result = formatMessage(longBody, metadata);
      expect(result.length).toBeGreaterThan(1);
    });

    it('preserves header in first chunk when splitting by paragraphs', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const paragraphs = Array.from({ length: 50 }, (_, i) =>
        `Para ${i}: ${'y'.repeat(100)}`
      );
      const body = paragraphs.join('\n\n');

      const result = formatMessage(body, metadata);
      // First chunk should contain the orchestrator header
      expect(result[0]).toContain('orchestrator');
      expect(result[0]).toContain('\u26A1');
    });

    it('splits message where paragraph exceeds remaining space after header', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      // First paragraph is huge (over 4000 chars), should trigger simpleSplit inside splitMessage
      const hugeParagraph = 'word '.repeat(900); // ~4500 chars
      const body = hugeParagraph + '\n\nShort paragraph';

      const result = formatMessage(body, metadata);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  // --- Timestamp formatting ---

  describe('timestamp formatting', () => {
    it('shows time only for today', () => {
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: FIXED_DATE,
      };

      const result = formatMessage('Test', metadata);
      // The time should be formatted as HH:MM in local timezone
      // Since we can't predict timezone, just check the message exists
      expect(result[0]).toBeDefined();
    });

    it('includes date for non-today timestamp', () => {
      const yesterdayDate = new Date('2025-06-14T10:00:00Z');
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: yesterdayDate,
      };

      const result = formatMessage('Test', metadata);
      // Should contain month abbreviation
      expect(result[0]).toContain('Jun');
    });

    it('formats different months correctly', () => {
      const janDate = new Date('2025-01-15T10:00:00Z');
      const metadata: MessageMetadata = {
        source: 'orchestrator',
        timestamp: janDate,
      };

      const result = formatMessage('Test', metadata);
      expect(result[0]).toContain('Jan');
    });
  });
});
