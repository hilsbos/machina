/**
 * Vitest unit tests for types.ts exports.
 *
 * Tests ROLE_EMOJI mapping, AGENT_IMAGE_VARIANTS constant,
 * and type safety checks for AgentRole, AgentImageVariant, AgentMode, and InvocationMode.
 */

import { describe, it, expect } from 'vitest';
import { ROLE_EMOJI, AGENT_IMAGE_VARIANTS } from './types.js';
import type { AgentRole, AgentImageVariant, AgentMode, InvocationMode } from './types.js';

describe('types', () => {
  describe('ROLE_EMOJI', () => {
    it('maps all agent roles to emojis', () => {
      const roles: AgentRole[] = [
        'implement', 'review', 'validate', 'define',
        'architect', 'ux', 'budget', 'retro', 'security-review',
        'pentest',
      ];
      for (const role of roles) {
        expect(ROLE_EMOJI[role]).toBeDefined();
        expect(typeof ROLE_EMOJI[role]).toBe('string');
      }
    });

    it('has correct emoji value for pentest', () => {
      expect(ROLE_EMOJI['pentest']).toBe('🎯');
    });

    it('includes fritz emoji', () => {
      expect(ROLE_EMOJI.fritz).toBeDefined();
      expect(typeof ROLE_EMOJI.fritz).toBe('string');
    });

    it('has unique emojis per role', () => {
      const values = Object.values(ROLE_EMOJI);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('has entries for all roles plus fritz', () => {
      const keys = Object.keys(ROLE_EMOJI);
      // 10 roles + fritz = 11
      expect(keys.length).toBe(11);
    });
  });

  describe('AGENT_IMAGE_VARIANTS', () => {
    it('includes base, java, cpp, kali, and rust', () => {
      expect(AGENT_IMAGE_VARIANTS).toContain('base');
      expect(AGENT_IMAGE_VARIANTS).toContain('java');
      expect(AGENT_IMAGE_VARIANTS).toContain('cpp');
      expect(AGENT_IMAGE_VARIANTS).toContain('kali');
      expect(AGENT_IMAGE_VARIANTS).toContain('rust');
    });

    it('is a readonly tuple with 5 elements', () => {
      expect(AGENT_IMAGE_VARIANTS.length).toBe(5);
    });
  });

  describe('type safety', () => {
    it('AgentRole accepts valid roles', () => {
      const role: AgentRole = 'implement';
      expect(role).toBe('implement');
    });

    it('AgentImageVariant accepts valid variants', () => {
      const variant: AgentImageVariant = 'java';
      expect(variant).toBe('java');
    });

    it('AgentMode accepts valid modes', () => {
      const mode: AgentMode = 'auto';
      expect(mode).toBe('auto');

      const chatMode: AgentMode = 'chat';
      expect(chatMode).toBe('chat');
    });

    it('InvocationMode accepts valid modes', () => {
      const standalone: InvocationMode = 'standalone';
      expect(standalone).toBe('standalone');

      const orchestrated: InvocationMode = 'orchestrated';
      expect(orchestrated).toBe('orchestrated');
    });
  });
});
