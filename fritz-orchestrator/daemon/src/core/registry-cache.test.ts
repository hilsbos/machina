/**
 * Vitest unit tests for registry.ts in-memory cache with debounced persistence,
 * change listeners, and agent lifecycle operations.
 *
 * Mocks config.js and fritz-config.js to avoid side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { dirname } from 'path';

// Mock dependencies before importing registry
vi.mock('../config.js', () => ({
  config: { workspacesDir: '/tmp/vitest-registry' },
}));
vi.mock('../agents/fritz-config.js', () => ({
  getRoleTtl: vi.fn(() => 3600),
  getDaemonConfig: vi.fn(() => ({ persistDebounceMs: 100 })),
}));

import {
  init,
  flush,
  registerAgent,
  getAgent,
  listAgents,
  deregisterAgent,
  updateContainer,
  updateIssueTitle,
  updateActivity,
  updateLang,
  updateClaudeCodeVersion,
  getExpiredAgents,
  touchAgent,
  clearAll,
  onAgentChange,
} from './registry.js';

const TEST_DIR = '/tmp/vitest-registry';
const REGISTRY_FILE = `${TEST_DIR}/registry.json`;

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

beforeEach(() => {
  // Clean test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  // Initialize fresh registry
  init();
  clearAll();
  flush();
});

afterEach(() => {
  // Flush any pending writes
  flush();
  // Clean up
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe('registry', () => {
  // ==========================================================================
  // init()
  // ==========================================================================

  describe('init', () => {
    it('creates registry from scratch when no file exists', () => {
      // Remove the file if it was created by beforeEach
      if (existsSync(REGISTRY_FILE)) {
        rmSync(REGISTRY_FILE);
      }
      init();
      const agents = listAgents();
      expect(agents).toEqual([]);
    });

    it('loads existing agents from disk', () => {
      // Pre-populate registry file
      ensureDir(REGISTRY_FILE);
      writeFileSync(REGISTRY_FILE, JSON.stringify({
        agents: {
          'existing-agent': {
            name: 'existing-agent',
            role: 'validate',
            issue: 42,
            repo: null,
            branch: null,
            workspace: '/tmp/test',
            started: '2024-01-01T00:00:00Z',
            ttl: 3600,
          },
        },
      }));

      init();
      const agent = getAgent('existing-agent');
      expect(agent).not.toBeNull();
      expect(agent?.issue).toBe(42);
    });

    it('handles corrupted disk file gracefully', () => {
      ensureDir(REGISTRY_FILE);
      writeFileSync(REGISTRY_FILE, 'not valid json {{{');

      init();
      const agents = listAgents();
      expect(agents).toEqual([]);
    });
  });

  // ==========================================================================
  // registerAgent
  // ==========================================================================

  describe('registerAgent', () => {
    it('creates agent in cache', () => {
      const agent = registerAgent('agent-1', 'implement', { issue: 42, repo: 'owner/repo' });
      expect(agent.name).toBe('agent-1');
      expect(agent.role).toBe('implement');
      expect(agent.issue).toBe(42);
      expect(agent.repo).toBe('owner/repo');
      expect(agent.branch).toBeNull();
      expect(typeof agent.started).toBe('string');
    });

    it('stores branch correctly', () => {
      const agent = registerAgent('agent-branch', 'implement', {
        issue: 42,
        repo: 'owner/repo',
        branch: 'feature/42-test',
      });
      expect(agent.branch).toBe('feature/42-test');
    });

    it('defaults branch to null when not provided', () => {
      const agent = registerAgent('agent-no-branch', 'review', { issue: 50 });
      expect(agent.branch).toBeNull();
    });

    it('preserves ttl: 0 (long-running mode)', () => {
      const agent = registerAgent('long-running', 'implement', {
        issue: 299,
        repo: 'owner/repo',
        ttl: 0,
      });
      expect(agent.ttl).toBe(0);
    });

    it('stores invocationMode', () => {
      const agent = registerAgent('standalone-agent', 'implement', {
        invocationMode: 'standalone',
      });
      expect(agent.invocationMode).toBe('standalone');
    });
  });

  // ==========================================================================
  // getAgent
  // ==========================================================================

  describe('getAgent', () => {
    it('retrieves registered agent', () => {
      registerAgent('test-get', 'implement', { issue: 100 });
      const agent = getAgent('test-get');
      expect(agent).not.toBeNull();
      expect(agent?.name).toBe('test-get');
      expect(agent?.issue).toBe(100);
    });

    it('returns null for non-existent agent', () => {
      expect(getAgent('ghost')).toBeNull();
    });
  });

  // ==========================================================================
  // listAgents
  // ==========================================================================

  describe('listAgents', () => {
    it('returns all agents', () => {
      registerAgent('a1', 'implement');
      registerAgent('a2', 'review');
      registerAgent('a3', 'validate');

      const agents = listAgents();
      expect(agents).toHaveLength(3);
      const names = agents.map(a => a.name).sort();
      expect(names).toEqual(['a1', 'a2', 'a3']);
    });

    it('returns empty array when no agents', () => {
      expect(listAgents()).toEqual([]);
    });
  });

  // ==========================================================================
  // deregisterAgent
  // ==========================================================================

  describe('deregisterAgent', () => {
    it('removes agent from cache', () => {
      registerAgent('to-remove', 'implement');
      expect(getAgent('to-remove')).not.toBeNull();

      deregisterAgent('to-remove');
      expect(getAgent('to-remove')).toBeNull();
    });

    it('returns removed agent', () => {
      registerAgent('to-deregister', 'implement', { branch: 'feature/test' });
      const removed = deregisterAgent('to-deregister');
      expect(removed).not.toBeNull();
      expect(removed?.branch).toBe('feature/test');
    });

    it('returns null for non-existent agent', () => {
      expect(deregisterAgent('ghost')).toBeNull();
    });
  });

  // ==========================================================================
  // updateContainer
  // ==========================================================================

  describe('updateContainer', () => {
    it('updates container ID on agent', () => {
      registerAgent('container-test', 'implement');
      updateContainer('container-test', 'abc123');
      const agent = getAgent('container-test');
      expect(agent?.containerId).toBe('abc123');
    });

    it('is no-op for non-existent agent', () => {
      // Should not throw
      updateContainer('ghost', 'abc123');
      expect(getAgent('ghost')).toBeNull();
    });
  });

  // ==========================================================================
  // updateIssueTitle
  // ==========================================================================

  describe('updateIssueTitle', () => {
    it('updates issue title on agent', () => {
      registerAgent('title-test', 'implement', { issue: 42 });
      updateIssueTitle('title-test', 'Fix the bug');
      const agent = getAgent('title-test');
      expect(agent?.issueTitle).toBe('Fix the bug');
    });
  });

  // ==========================================================================
  // updateActivity
  // ==========================================================================

  describe('updateActivity', () => {
    it('updates lastActivity and lastActivityAt', () => {
      registerAgent('activity-test', 'implement');
      updateActivity('activity-test', 'Working on implementation');
      const agent = getAgent('activity-test');
      expect(agent?.lastActivity).toBe('Working on implementation');
      expect(agent?.lastActivityAt).toBeDefined();
    });
  });

  // ==========================================================================
  // updateLang
  // ==========================================================================

  describe('updateLang', () => {
    it('updates language variant', () => {
      registerAgent('lang-test', 'implement');
      updateLang('lang-test', 'java');
      const agent = getAgent('lang-test');
      expect(agent?.lang).toBe('java');
    });

    it('can set lang to null', () => {
      registerAgent('lang-null-test', 'implement');
      updateLang('lang-null-test', 'java');
      updateLang('lang-null-test', null);
      const agent = getAgent('lang-null-test');
      expect(agent?.lang).toBeNull();
    });
  });

  // ==========================================================================
  // updateClaudeCodeVersion
  // ==========================================================================

  describe('updateClaudeCodeVersion', () => {
    it('stores version correctly', () => {
      registerAgent('version-agent', 'implement', { issue: 307 });
      updateClaudeCodeVersion('version-agent', '2.1.39');
      const agent = getAgent('version-agent');
      expect(agent?.claudeCodeVersion).toBe('2.1.39');
    });

    it('is no-op for non-existent agent', () => {
      updateClaudeCodeVersion('ghost-agent', '1.0.0');
      expect(getAgent('ghost-agent')).toBeNull();
    });

    it('version is undefined when not set', () => {
      registerAgent('no-version', 'implement');
      const agent = getAgent('no-version');
      expect(agent?.claudeCodeVersion).toBeUndefined();
    });

    it('can be updated multiple times (last update wins)', () => {
      registerAgent('multi-update', 'implement');
      updateClaudeCodeVersion('multi-update', '2.1.38');
      updateClaudeCodeVersion('multi-update', '2.1.39');
      const agent = getAgent('multi-update');
      expect(agent?.claudeCodeVersion).toBe('2.1.39');
    });
  });

  // ==========================================================================
  // getExpiredAgents
  // ==========================================================================

  describe('getExpiredAgents', () => {
    // NOTE: These tests mutate agents via getAgent() references directly.
    // This relies on getAgent() returning a mutable reference into registry
    // internal state (not a clone). If the registry ever switches to returning
    // clones, these tests will need to use a different approach to set up
    // expired timestamps (e.g., registerAgent with a past started time).

    it('returns agents past TTL', () => {
      const _agent = registerAgent('expired', 'implement', { ttl: 1 });
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

      const retrieved = getAgent('expired');
      if (retrieved) {
        retrieved.started = twoHoursAgo;
        retrieved.ttl = 3600; // 1 hour
      }

      const expired = getExpiredAgents();
      expect(expired.length).toBe(1);
      expect(expired[0].name).toBe('expired');
    });

    it('skips agents with TTL=0 (long-running)', () => {
      registerAgent('long-running', 'implement', { ttl: 0 });
      // Manually set started time to 24 hours ago
      const agent = getAgent('long-running');
      if (agent) {
        agent.started = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }

      const expired = getExpiredAgents();
      expect(expired.length).toBe(0);
    });

    it('does not return fresh agents with remaining TTL', () => {
      registerAgent('fresh', 'implement', { ttl: 3600 });
      const expired = getExpiredAgents();
      expect(expired.length).toBe(0);
    });

    it('TTL=0 agent never expires regardless of age', () => {
      registerAgent('long-active', 'implement', { ttl: 0 });
      const agent = getAgent('long-active');
      if (agent) {
        agent.started = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      }

      const expired = getExpiredAgents();
      expect(expired.length).toBe(0);
    });

    it('handles mixed agents - TTL=0 and TTL>0 (expired and fresh)', () => {
      // Long-running (TTL=0) - should NOT expire
      registerAgent('long', 'implement', { ttl: 0 });
      const longAgent = getAgent('long');
      if (longAgent) {
        longAgent.started = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      }

      // Normal expired (TTL=3600, started 2h ago) - should expire
      registerAgent('expired', 'review', { ttl: 3600 });
      const expiredAgent = getAgent('expired');
      if (expiredAgent) {
        expiredAgent.started = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      }

      // Normal fresh (TTL=3600, just started) - should NOT expire
      registerAgent('fresh', 'validate', { ttl: 3600 });

      const expired = getExpiredAgents();
      expect(expired.length).toBe(1);
      expect(expired[0].name).toBe('expired');
    });
  });

  // ==========================================================================
  // flush()
  // ==========================================================================

  describe('flush', () => {
    it('persists to disk', () => {
      registerAgent('flush-test', 'review');
      flush();

      const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
      expect(data.agents['flush-test']).toBeDefined();
      expect(data.agents['flush-test'].name).toBe('flush-test');
    });

    it('is no-op when not dirty', () => {
      // flush() after init with no changes should not throw
      init();
      flush();
      // If file was not created, that's fine too
    });

    it('stays consistent on disk write failure', () => {
      // Register an agent to make the registry dirty
      registerAgent('write-fail-test', 'implement');

      // Make the directory read-only so writeFileSync throws
      chmodSync(TEST_DIR, 0o444);

      // flush() should not throw (it catches the error internally)
      expect(() => flush()).not.toThrow();

      // Restore write permissions for afterEach cleanup
      chmodSync(TEST_DIR, 0o755);

      // In-memory cache should still be consistent
      const agent = getAgent('write-fail-test');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('write-fail-test');
      expect(agent!.role).toBe('implement');
    });
  });

  // ==========================================================================
  // touchAgent
  // ==========================================================================

  describe('touchAgent', () => {
    it('updates lastActivityAt to a new timestamp', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-02-23T10:00:00Z'));
        registerAgent('touch-test', 'implement');
        const beforeTouch = getAgent('touch-test')?.lastActivityAt;

        vi.advanceTimersByTime(1000); // advance clock by 1 second
        touchAgent('touch-test');
        const afterTouch = getAgent('touch-test')?.lastActivityAt;

        expect(afterTouch).toBeDefined();
        expect(afterTouch).not.toBe(beforeTouch);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  // clearAll
  // ==========================================================================

  describe('clearAll', () => {
    it('empties registry', () => {
      registerAgent('a1', 'implement');
      registerAgent('a2', 'review');
      expect(listAgents().length).toBe(2);

      clearAll();
      expect(listAgents().length).toBe(0);
    });

    it('persists empty state after flush', () => {
      registerAgent('temp', 'implement');
      flush();
      clearAll();
      flush();

      const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
      expect(Object.keys(data.agents).length).toBe(0);
    });
  });

  // ==========================================================================
  // Change listeners
  // ==========================================================================

  describe('change listeners', () => {
    it('calls listener on register', async () => {
      const events: Array<{ name: string; event: string }> = [];
      const unsub = onAgentChange((agent, event) => {
        events.push({ name: agent.name, event });
      });

      registerAgent('listener-test', 'implement');

      // Change notifications are dispatched via setImmediate, so wait a tick
      await new Promise(resolve => setImmediate(resolve));

      expect(events.length).toBe(1);
      expect(events[0].name).toBe('listener-test');
      expect(events[0].event).toBe('registered');

      unsub();
    });

    it('calls listener on update (updateContainer)', async () => {
      const events: Array<{ name: string; event: string }> = [];
      registerAgent('update-listener', 'implement');
      await new Promise(resolve => setImmediate(resolve)); // drain register event

      const unsub = onAgentChange((agent, event) => {
        events.push({ name: agent.name, event });
      });

      updateContainer('update-listener', 'container-xyz');
      await new Promise(resolve => setImmediate(resolve));

      expect(events.length).toBe(1);
      expect(events[0].event).toBe('updated');

      unsub();
    });

    it('calls listener on deregister', async () => {
      const events: Array<{ name: string; event: string }> = [];
      registerAgent('dereg-listener', 'implement');
      await new Promise(resolve => setImmediate(resolve));

      const unsub = onAgentChange((agent, event) => {
        events.push({ name: agent.name, event });
      });

      deregisterAgent('dereg-listener');
      await new Promise(resolve => setImmediate(resolve));

      expect(events.length).toBe(1);
      expect(events[0].event).toBe('deregistered');

      unsub();
    });

    it('unsubscribe stops notifications', async () => {
      const events: Array<{ name: string; event: string }> = [];
      const unsub = onAgentChange((agent, event) => {
        events.push({ name: agent.name, event });
      });

      registerAgent('unsub-test-1', 'implement');
      await new Promise(resolve => setImmediate(resolve));
      expect(events.length).toBe(1);

      unsub();

      registerAgent('unsub-test-2', 'review');
      await new Promise(resolve => setImmediate(resolve));
      // Should still be 1 since we unsubscribed
      expect(events.length).toBe(1);
    });
  });

  // ==========================================================================
  // Branch-specific tests (from registry.test.ts)
  // ==========================================================================

  describe('branch field', () => {
    it('branch survives registry persistence cycle', () => {
      registerAgent('persist-branch', 'implement', { branch: 'feature/persist-test' });
      flush();

      // Reload from disk
      init();
      const agent = getAgent('persist-branch');
      expect(agent?.branch).toBe('feature/persist-test');
    });

    it('empty string branch becomes null', () => {
      const agent = registerAgent('empty-branch', 'implement', { branch: '' });
      // Empty string becomes null due to || operator in registerAgent
      expect(agent.branch).toBeNull();
    });

    it('multiple agents with different branches', () => {
      registerAgent('agent-a', 'implement', { branch: 'branch-a' });
      registerAgent('agent-b', 'review', { branch: 'branch-b' });
      registerAgent('agent-c', 'validate');

      expect(getAgent('agent-a')?.branch).toBe('branch-a');
      expect(getAgent('agent-b')?.branch).toBe('branch-b');
      expect(getAgent('agent-c')?.branch).toBeNull();
    });

    it('branch with special characters', () => {
      const specialBranch = 'feature/232-add-@mentions-#test';
      registerAgent('special-branch', 'implement', { branch: specialBranch });
      expect(getAgent('special-branch')?.branch).toBe(specialBranch);

      // Round-trip through persistence
      flush();
      init();
      expect(getAgent('special-branch')?.branch).toBe(specialBranch);
    });
  });
});
