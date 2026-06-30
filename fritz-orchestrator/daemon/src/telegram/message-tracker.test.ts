/**
 * Vitest tests for message-tracker.ts
 *
 * Covers:
 * - ORCHESTRATOR_ID constant
 * - trackAgentMessage: basic tracking
 * - getAgentForMessage: lookup
 * - Trimming behavior when exceeding MAX_TRACKED_MESSAGES (1000)
 */

import { describe, it, expect } from 'vitest';

import {
  ORCHESTRATOR_ID,
  trackAgentMessage,
  getAgentForMessage,
} from './message-tracker.js';

describe('message-tracker', () => {
  // We cannot easily reset the internal Map between tests since it is
  // module-level state with no reset export. Tests are designed to be
  // order-independent by using unique message IDs.

  describe('ORCHESTRATOR_ID', () => {
    it('is the expected sentinel value', () => {
      expect(ORCHESTRATOR_ID).toBe('__orchestrator__');
    });
  });

  describe('trackAgentMessage / getAgentForMessage', () => {
    it('returns undefined for untracked message', () => {
      expect(getAgentForMessage(999999)).toBeUndefined();
    });

    it('tracks and retrieves a message-to-agent mapping', () => {
      trackAgentMessage(100001, 'impl-42');
      expect(getAgentForMessage(100001)).toBe('impl-42');
    });

    it('tracks orchestrator messages', () => {
      trackAgentMessage(100002, ORCHESTRATOR_ID);
      expect(getAgentForMessage(100002)).toBe(ORCHESTRATOR_ID);
    });

    it('overwrites previous mapping for same message ID', () => {
      trackAgentMessage(100003, 'agent-a');
      trackAgentMessage(100003, 'agent-b');
      expect(getAgentForMessage(100003)).toBe('agent-b');
    });

    it('tracks multiple different messages independently', () => {
      trackAgentMessage(100010, 'agent-x');
      trackAgentMessage(100011, 'agent-y');
      trackAgentMessage(100012, 'agent-z');
      expect(getAgentForMessage(100010)).toBe('agent-x');
      expect(getAgentForMessage(100011)).toBe('agent-y');
      expect(getAgentForMessage(100012)).toBe('agent-z');
    });
  });

  describe('trimming behavior', () => {
    it('trims oldest entries when exceeding MAX_TRACKED_MESSAGES', () => {
      // MAX_TRACKED_MESSAGES is 1000, TRIM_TARGET is 900
      // Insert more than 1000 messages with unique IDs (200000+)
      const baseId = 200000;
      for (let i = 0; i < 1001; i++) {
        trackAgentMessage(baseId + i, `agent-${i}`);
      }
      // The very first entries should have been trimmed
      // After trim, map size should be TRIM_TARGET (900) + 1 new = ~901
      // The oldest entries (baseId through baseId + ~100) should be gone
      expect(getAgentForMessage(baseId)).toBeUndefined();
      // The newest entry should still be present
      expect(getAgentForMessage(baseId + 1000)).toBe('agent-1000');
    });
  });
});
