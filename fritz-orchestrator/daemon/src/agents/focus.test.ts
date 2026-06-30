/**
 * Unit tests for focus.ts
 *
 * Covers: getFocusedAgent, setFocusedAgent, clearFocusForChat, clearFocus
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getFocusedAgent,
  setFocusedAgent,
  clearFocusForChat,
  clearFocus,
} from './focus.js';

describe('focus', () => {
  // Clear focus state between tests by removing known chat IDs
  beforeEach(() => {
    clearFocusForChat('chat-1');
    clearFocusForChat('chat-2');
    clearFocusForChat('chat-3');
    clearFocus('agent-a');
    clearFocus('agent-b');
  });

  // --- getFocusedAgent / setFocusedAgent ---

  describe('getFocusedAgent', () => {
    it('returns undefined when no agent is focused for a chat', () => {
      expect(getFocusedAgent('unknown-chat')).toBeUndefined();
    });
  });

  describe('setFocusedAgent', () => {
    it('sets the focused agent for a chat', () => {
      setFocusedAgent('chat-1', 'agent-a');
      expect(getFocusedAgent('chat-1')).toBe('agent-a');
    });

    it('overwrites the previously focused agent', () => {
      setFocusedAgent('chat-1', 'agent-a');
      setFocusedAgent('chat-1', 'agent-b');
      expect(getFocusedAgent('chat-1')).toBe('agent-b');
    });

    it('tracks different agents for different chats', () => {
      setFocusedAgent('chat-1', 'agent-a');
      setFocusedAgent('chat-2', 'agent-b');
      expect(getFocusedAgent('chat-1')).toBe('agent-a');
      expect(getFocusedAgent('chat-2')).toBe('agent-b');
    });
  });

  // --- clearFocusForChat ---

  describe('clearFocusForChat', () => {
    it('removes focus for a specific chat and returns the previous agent', () => {
      setFocusedAgent('chat-1', 'agent-a');
      const was = clearFocusForChat('chat-1');
      expect(was).toBe('agent-a');
      expect(getFocusedAgent('chat-1')).toBeUndefined();
    });

    it('returns undefined if no agent was focused', () => {
      const was = clearFocusForChat('chat-999');
      expect(was).toBeUndefined();
    });

    it('does not affect other chats', () => {
      setFocusedAgent('chat-1', 'agent-a');
      setFocusedAgent('chat-2', 'agent-b');
      clearFocusForChat('chat-1');
      expect(getFocusedAgent('chat-1')).toBeUndefined();
      expect(getFocusedAgent('chat-2')).toBe('agent-b');
    });
  });

  // --- clearFocus ---

  describe('clearFocus', () => {
    it('clears an agent from all chats that have it focused', () => {
      setFocusedAgent('chat-1', 'agent-a');
      setFocusedAgent('chat-2', 'agent-a');
      setFocusedAgent('chat-3', 'agent-b');

      clearFocus('agent-a');

      expect(getFocusedAgent('chat-1')).toBeUndefined();
      expect(getFocusedAgent('chat-2')).toBeUndefined();
      expect(getFocusedAgent('chat-3')).toBe('agent-b');
    });

    it('is a no-op if the agent is not focused anywhere', () => {
      setFocusedAgent('chat-1', 'agent-a');
      clearFocus('nonexistent-agent');
      expect(getFocusedAgent('chat-1')).toBe('agent-a');
    });

    it('handles clearing when same agent is in single chat', () => {
      setFocusedAgent('chat-1', 'agent-a');
      clearFocus('agent-a');
      expect(getFocusedAgent('chat-1')).toBeUndefined();
    });
  });

  // --- Full lifecycle ---

  describe('lifecycle', () => {
    it('set -> get -> clear -> get flow', () => {
      // Initially empty
      expect(getFocusedAgent('chat-1')).toBeUndefined();

      // Set
      setFocusedAgent('chat-1', 'agent-a');
      expect(getFocusedAgent('chat-1')).toBe('agent-a');

      // Clear by chat
      clearFocusForChat('chat-1');
      expect(getFocusedAgent('chat-1')).toBeUndefined();
    });

    it('set -> clearFocus (by agent name) flow', () => {
      setFocusedAgent('chat-1', 'agent-a');
      setFocusedAgent('chat-2', 'agent-a');

      clearFocus('agent-a');
      expect(getFocusedAgent('chat-1')).toBeUndefined();
      expect(getFocusedAgent('chat-2')).toBeUndefined();
    });
  });
});
