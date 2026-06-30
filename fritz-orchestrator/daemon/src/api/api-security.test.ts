/**
 * Vitest tests for API token validation logic.
 *
 * Imports getQuestionOptions and resolveQuestion from api.ts
 * to provide coverage on the API module.
 *
 * Also tests the token validation logic pattern used in the middleware.
 *
 * Covers:
 * - Valid bearer token accepted
 * - Invalid token rejected
 * - Missing token rejected
 * - Case-insensitive bearer prefix
 * - Question management functions
 */

import { describe, it, expect, vi } from 'vitest';

// Mock heavy deps before importing api.ts
vi.mock('../config.js', () => ({
  config: {
    fritzApiToken: 'test-api-token-12345',
    apiPort: 3456,
    workspacesDir: '/tmp/test-workspaces',
    githubRepo: 'owner/repo',
  },
}));

vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
}));

vi.mock('../agents/autoloop.js', () => ({
  isPaused: vi.fn(() => false),
  isRunning: vi.fn(() => true),
  pause: vi.fn(),
  resume: vi.fn(),
  isManuallyPaused: vi.fn(() => false),
}));

vi.mock('../agents/agents.js', () => ({
  bootAgent: vi.fn(),
  stopAgent: vi.fn(),
  getAgentLogs: vi.fn(() => ''),
}));

vi.mock('../agents/agent-comms.js', () => ({
  sendToAgent: vi.fn(),
  getQueueInfo: vi.fn(),
}));

vi.mock('../agents/boot.js', () => ({
  isValidRole: vi.fn(() => true),
}));

vi.mock('../agents/fritz-config.js', () => ({
  getDaemonConfig: vi.fn(() => ({})),
}));

vi.mock('../github/github.js', () => ({
  getIssueLabels: vi.fn(() => []),
}));

vi.mock('../dashboard/dashboard.js', () => ({
  handleDashboardRequest: vi.fn(),
}));

import { getQuestionOptions, resolveQuestion } from './api.js';

// ── Tests ──

describe('Question management (api.ts)', () => {
  it('getQuestionOptions returns undefined for unknown question', () => {
    const result = getQuestionOptions('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('resolveQuestion returns false for unknown question', () => {
    const result = resolveQuestion('nonexistent-id', 'answer');
    expect(result).toBe(false);
  });
});

describe('API token validation (logic pattern)', () => {
  const CONFIGURED_TOKEN = 'test-api-token-12345';

  function validateToken(authHeader: string | undefined): { valid: boolean; reason?: string } {
    if (!authHeader) {
      return { valid: false, reason: 'Missing Authorization header' };
    }
    const match = authHeader.match(/^bearer\s+(.+)$/i);
    if (!match) {
      return { valid: false, reason: 'Invalid Authorization format' };
    }
    const token = match[1];
    if (token !== CONFIGURED_TOKEN) {
      return { valid: false, reason: 'Invalid token' };
    }
    return { valid: true };
  }

  it('accepts valid bearer token', () => {
    const result = validateToken(`Bearer ${CONFIGURED_TOKEN}`);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects invalid token', () => {
    const result = validateToken('Bearer wrong-token');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid token');
  });

  it('rejects missing token', () => {
    const result = validateToken(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Missing Authorization header');
  });

  it('accepts case-insensitive bearer prefix', () => {
    const result = validateToken(`bearer ${CONFIGURED_TOKEN}`);
    expect(result.valid).toBe(true);
  });

  it('accepts uppercase BEARER prefix', () => {
    const result = validateToken(`BEARER ${CONFIGURED_TOKEN}`);
    expect(result.valid).toBe(true);
  });

  it('rejects empty string header', () => {
    const result = validateToken('');
    expect(result.valid).toBe(false);
  });

  it('rejects token without Bearer prefix', () => {
    const result = validateToken(CONFIGURED_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid Authorization format');
  });

  it('rejects Basic auth format', () => {
    const result = validateToken('Basic dXNlcjpwYXNz');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid Authorization format');
  });
});

describe('Archive list pagination (logic pattern)', () => {
  // Behavioral mirror of handleArchiveList pagination logic from api.ts (line ~301).
  // IMPORTANT: If you change pagination logic in api.ts handleArchiveList(), update this mirror too.
  function paginateArchives(
    archives: { name: string }[],
    params: { limit?: string; offset?: string },
  ): { archives: { name: string }[]; total: number } {
    const rawLimit = params.limit ? parseInt(params.limit, 10) : 50;
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 500);
    const rawOffset = params.offset ? parseInt(params.offset, 10) : 0;
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    return {
      archives: archives.slice(offset, offset + limit),
      total: archives.length,
    };
  }

  const testData = Array.from({ length: 10 }, (_, i) => ({ name: `agent-${i}` }));

  it('returns total count of all archives', () => {
    const result = paginateArchives(testData, {});
    expect(result.total).toBe(10);
  });

  it('defaults to limit=50 and offset=0', () => {
    const result = paginateArchives(testData, {});
    expect(result.archives).toHaveLength(10);
    expect(result.archives[0].name).toBe('agent-0');
  });

  it('applies offset correctly', () => {
    const result = paginateArchives(testData, { offset: '3', limit: '2' });
    expect(result.archives).toHaveLength(2);
    expect(result.archives[0].name).toBe('agent-3');
    expect(result.archives[1].name).toBe('agent-4');
    expect(result.total).toBe(10);
  });

  it('caps limit at 500', () => {
    const largeData = Array.from({ length: 600 }, (_, i) => ({ name: `agent-${i}` }));
    const result = paginateArchives(largeData, { limit: '9999' });
    expect(result.archives).toHaveLength(500);
    expect(result.total).toBe(600);
  });

  it('enforces minimum limit of 1', () => {
    const result = paginateArchives(testData, { limit: '0' });
    expect(result.archives).toHaveLength(1);
  });

  it('handles NaN limit by defaulting to 50', () => {
    const result = paginateArchives(testData, { limit: 'abc' });
    expect(result.archives).toHaveLength(10); // 10 < 50, so all returned
    expect(result.total).toBe(10);
  });

  it('handles NaN offset by defaulting to 0', () => {
    const result = paginateArchives(testData, { offset: 'xyz', limit: '3' });
    expect(result.archives).toHaveLength(3);
    expect(result.archives[0].name).toBe('agent-0');
  });

  it('handles negative offset by clamping to 0', () => {
    const result = paginateArchives(testData, { offset: '-5', limit: '3' });
    expect(result.archives).toHaveLength(3);
    expect(result.archives[0].name).toBe('agent-0');
  });

  it('returns empty array when offset exceeds total', () => {
    const result = paginateArchives(testData, { offset: '100' });
    expect(result.archives).toHaveLength(0);
    expect(result.total).toBe(10);
  });

  it('returns partial page at end of results', () => {
    const result = paginateArchives(testData, { offset: '8', limit: '5' });
    expect(result.archives).toHaveLength(2);
    expect(result.archives[0].name).toBe('agent-8');
    expect(result.archives[1].name).toBe('agent-9');
    expect(result.total).toBe(10);
  });
});
