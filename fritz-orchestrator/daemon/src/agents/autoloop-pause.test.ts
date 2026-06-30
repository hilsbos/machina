/**
 * Vitest tests for autoloop manual pause/resume functionality (issue #336).
 *
 * Covers:
 * - isPaused / isManuallyPaused checks
 * - pause() creates manual pause file
 * - resume() removes manual pause file
 * - Persistence across checks
 * - Independence of manual pause from usage-pause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_WORKSPACES_DIR = resolve(__dirname, '../../.test-fixtures-autoloop-pause-vitest');

const PAUSE_FILE = join(TEST_WORKSPACES_DIR, 'autoloop.paused');
const USAGE_PAUSE_FILE = join(TEST_WORKSPACES_DIR, 'usage-paused');

// Mock config before importing autoloop
vi.mock('../config.js', () => ({
  config: {
    workspacesDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../.test-fixtures-autoloop-pause-vitest'),
    telegramBotToken: 'test-token',
    telegramChatId: 'test-chat-id',
    githubRepo: 'test/repo',
    fritzRoot: '/tmp/fritz-root',
    dockerImage: 'fritz-agent:latest',
    apiPort: 3456,
    daemonUrl: 'http://localhost:3456',
  },
}));

// Mock heavy dependencies that autoloop imports
vi.mock('../github/github.js', () => ({
  getActionableIssues: vi.fn(() => []),
  getIssueLabels: vi.fn(() => []),
  claimIssue: vi.fn(),
  releaseIssue: vi.fn(),
  transitionIssueStatus: vi.fn(),
}));

vi.mock('./agents.js', () => ({
  bootAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
  notifyBootFailure: vi.fn(),
}));

vi.mock('../core/event-log.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('./boot.js', () => ({
  execAsync: vi.fn(() => Promise.resolve('')),
}));

vi.mock('./fritz-config.js', () => ({
  getAgentConfig: vi.fn(() => ({ ttl: 3600, model: 'claude-sonnet-4-20250514' })),
  getUsageConfig: vi.fn(() => ({ enabled: false, pauseThreshold: 80, resumeThreshold: 50, checkIntervalMinutes: 5, allowP0: true })),
}));

vi.mock('./usage-monitor.js', () => {
  let usagePaused = false;
  return {
    isUsagePaused: vi.fn(() => usagePaused),
    _setUsagePaused: (val: boolean) => { usagePaused = val; },
  };
});

vi.mock('./priority-utils.js', () => ({
  extractPriority: vi.fn(() => ({ level: 'p2', label: '' })),
  sortByPriority: vi.fn((arr: unknown[]) => arr),
}));

// ── Helpers ──

function cleanup(): void {
  try { rmSync(PAUSE_FILE); } catch { /* ignore */ }
  try { rmSync(USAGE_PAUSE_FILE); } catch { /* ignore */ }
}

// ── Tests ──

let autoloop: typeof import('./autoloop.js');
let usageMonitorMock: { isUsagePaused: ReturnType<typeof vi.fn>; _setUsagePaused: (val: boolean) => void };

beforeEach(async () => {
  if (!existsSync(TEST_WORKSPACES_DIR)) {
    mkdirSync(TEST_WORKSPACES_DIR, { recursive: true });
  }
  cleanup();
  autoloop = await import('./autoloop.js');
  usageMonitorMock = (await import('./usage-monitor.js')) as unknown as typeof usageMonitorMock;
  usageMonitorMock._setUsagePaused(false);
});

afterEach(() => {
  cleanup();
  try { rmSync(TEST_WORKSPACES_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe('isPaused', () => {
  it('returns false when no pause file exists', () => {
    expect(autoloop.isPaused()).toBe(false);
  });

  it('returns true after pause()', () => {
    autoloop.pause();
    expect(autoloop.isPaused()).toBe(true);
  });
});

describe('pause', () => {
  it('creates the pause file', () => {
    expect(existsSync(PAUSE_FILE)).toBe(false);
    autoloop.pause();
    expect(existsSync(PAUSE_FILE)).toBe(true);
  });

  it('is idempotent (calling twice is safe)', () => {
    autoloop.pause();
    autoloop.pause();
    expect(existsSync(PAUSE_FILE)).toBe(true);
  });
});

describe('resume', () => {
  it('removes the pause file', () => {
    autoloop.pause();
    expect(existsSync(PAUSE_FILE)).toBe(true);
    autoloop.resume();
    expect(existsSync(PAUSE_FILE)).toBe(false);
  });

  it('is idempotent (calling when not paused is safe)', () => {
    autoloop.resume();
    expect(existsSync(PAUSE_FILE)).toBe(false);
  });

  it('pause then resume then isPaused returns false', () => {
    autoloop.pause();
    expect(autoloop.isPaused()).toBe(true);
    autoloop.resume();
    expect(autoloop.isPaused()).toBe(false);
  });
});

describe('Persistence', () => {
  it('pause file persists (simulates daemon restart)', () => {
    autoloop.pause();
    expect(existsSync(PAUSE_FILE)).toBe(true);
    expect(autoloop.isPaused()).toBe(true);
  });
});

describe('Manual pause independence from usage-pause', () => {
  it('pause() works when usage-paused', () => {
    usageMonitorMock._setUsagePaused(true);
    expect(autoloop.isManuallyPaused()).toBe(false);
    expect(autoloop.isPaused()).toBe(true);
    autoloop.pause();
    expect(existsSync(PAUSE_FILE)).toBe(true);
    expect(autoloop.isManuallyPaused()).toBe(true);
  });

  it('resume() is no-op when only usage-paused', () => {
    usageMonitorMock._setUsagePaused(true);
    expect(autoloop.isManuallyPaused()).toBe(false);
    expect(autoloop.isPaused()).toBe(true);
    autoloop.resume();
    expect(existsSync(PAUSE_FILE)).toBe(false);
    expect(autoloop.isPaused()).toBe(true);
  });

  it('resume() only removes manual pause, usage-pause remains', () => {
    autoloop.pause();
    usageMonitorMock._setUsagePaused(true);
    expect(autoloop.isManuallyPaused()).toBe(true);
    expect(autoloop.isPaused()).toBe(true);
    autoloop.resume();
    expect(autoloop.isManuallyPaused()).toBe(false);
    expect(autoloop.isPaused()).toBe(true);
  });

  it('isManuallyPaused is independent of usage-paused', () => {
    expect(autoloop.isManuallyPaused()).toBe(false);
    usageMonitorMock._setUsagePaused(true);
    expect(autoloop.isManuallyPaused()).toBe(false);
  });
});
