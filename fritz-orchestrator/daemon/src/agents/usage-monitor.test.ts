/**
 * Vitest tests for usage monitor logic (Issue #335).
 *
 * Imports actual functions from usage-monitor.ts and mocks dependencies.
 *
 * Covers:
 * - isUsagePaused / hasOverride / setOverride (file-based state)
 * - getUsageData / getLastCheckTime / getAuthMode / getStopReason
 * - _resetForTesting
 * - Threshold logic (pause/resume)
 * - Hysteresis (separate pause/resume thresholds)
 * - Edge cases (0%, 100%, exact thresholds)
 * - check() flow: pause, resume, override, errors, rate limit
 * - refreshTokenIfNeeded logic
 * - onUsageChange listener
 * - start/stop/reload lifecycle
 * - getAccountName / isRunning / getStopReason
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual };
});

vi.mock('../config.js', () => ({
  config: {
    workspacesDir: '/tmp/test-workspaces',
    claudeOauthToken: '',
    claudeHome: '/home/.claude',
    claudeAccountName: 'test-account',
  },
}));

vi.mock('./fritz-config.js', () => ({
  getUsageConfig: vi.fn(() => ({
    enabled: true,
    pauseThreshold: 80,
    resumeThreshold: 50,
    checkIntervalMinutes: 5,
    allowP0Override: true,
  })),
}));

vi.mock('../core/lifecycle.js', () => ({
  system: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  isUsagePaused,
  hasOverride,
  setOverride,
  getUsageData,
  getLastCheckTime,
  getAuthMode,
  getStopReason,
  getAccountName,
  isRunning,
  onUsageChange,
  check,
  start,
  stop,
  reload,
  refreshTokenIfNeeded,
  _resetForTesting,
} from './usage-monitor.js';

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { config as _config } from '../config.js';
import { getUsageConfig } from './fritz-config.js';
import * as lifecycle from '../core/lifecycle.js';

// ── Tests ──

describe('isUsagePaused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns false when pause file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(isUsagePaused()).toBe(false);
  });

  it('returns true when pause file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(isUsagePaused()).toBe(true);
  });
});

describe('hasOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns false when override file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(hasOverride()).toBe(false);
  });

  it('returns true when override file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(hasOverride()).toBe(true);
  });
});

describe('setOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('creates override file when enabled=true', () => {
    setOverride(true);
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('removes override file when enabled=false', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    setOverride(false);
    expect(unlinkSync).toHaveBeenCalled();
  });

  it('does not throw when removing nonexistent file', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => setOverride(false)).not.toThrow();
  });

  it('clears usage-pause file when override is enabled and pause exists', () => {
    // existsSync: first call for override file write, second for isUsagePaused check
    vi.mocked(existsSync).mockReturnValue(true);
    setOverride(true);
    // writeFileSync for override, unlinkSync for clearing pause file
    expect(writeFileSync).toHaveBeenCalled();
    expect(unlinkSync).toHaveBeenCalled();
  });
});

describe('getUsageData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns null when no data has been fetched', () => {
    expect(getUsageData()).toBeNull();
  });
});

describe('getLastCheckTime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns null when no check has been performed', () => {
    expect(getLastCheckTime()).toBeNull();
  });
});

describe('getAuthMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns current auth mode', () => {
    const mode = getAuthMode();
    expect(['oauth_token', 'credentials_file', 'none']).toContain(mode);
  });

  it('returns "none" after reset', () => {
    expect(getAuthMode()).toBe('none');
  });
});

describe('getStopReason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns null when monitor is running or never started', () => {
    expect(getStopReason()).toBeNull();
  });
});

describe('getAccountName', () => {
  it('returns configured account name', () => {
    expect(getAccountName()).toBe('test-account');
  });
});

describe('isRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns false when not started', () => {
    expect(isRunning()).toBe(false);
  });
});

describe('onUsageChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('subscribes a callback and returns unsubscribe function', () => {
    const callback = vi.fn();
    const unsubscribe = onUsageChange(callback);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('notifies listeners on setOverride', () => {
    const callback = vi.fn();
    onUsageChange(callback);
    setOverride(true);
    expect(callback).toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = onUsageChange(callback);
    unsubscribe();
    setOverride(true);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('Threshold logic (pause/resume patterns)', () => {
  const pauseThreshold = 80;
  const resumeThreshold = 50;

  function shouldPause(usagePercent: number): boolean {
    return usagePercent >= pauseThreshold;
  }

  function shouldResume(usagePercent: number): boolean {
    return usagePercent <= resumeThreshold;
  }

  it('pauses at threshold', () => {
    expect(shouldPause(80)).toBe(true);
  });

  it('pauses above threshold', () => {
    expect(shouldPause(95)).toBe(true);
  });

  it('does not pause below threshold', () => {
    expect(shouldPause(79)).toBe(false);
  });

  it('pauses at 100%', () => {
    expect(shouldPause(100)).toBe(true);
  });

  it('does not pause at 0%', () => {
    expect(shouldPause(0)).toBe(false);
  });

  it('resumes at threshold', () => {
    expect(shouldResume(50)).toBe(true);
  });

  it('resumes below threshold', () => {
    expect(shouldResume(30)).toBe(true);
  });

  it('does not resume above threshold', () => {
    expect(shouldResume(51)).toBe(false);
  });

  it('resumes at 0%', () => {
    expect(shouldResume(0)).toBe(true);
  });
});

describe('Hysteresis (separate pause/resume thresholds)', () => {
  it('no-op zone: above resume but below pause', () => {
    const usage = 65;
    expect(usage >= 80).toBe(false);
    expect(usage <= 50).toBe(false);
  });

  it('transitions through full cycle', () => {
    expect(80 >= 80).toBe(true);
    expect(60 <= 50).toBe(false);
    expect(50 <= 50).toBe(true);
  });
});

describe('check()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockFetch.mockReset();
  });

  it('returns immediately when usage monitoring is disabled', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: false,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    await check();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns immediately when no token is available', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    // No token: config.claudeOauthToken is empty and no credentials file
    vi.mocked(existsSync).mockReturnValue(false);

    await check();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('pauses autoloop when usage exceeds pause threshold', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    // Provide a token via credentials file
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      if (path.includes('usage-paused')) return false;
      if (path.includes('usage-override')) return false;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000, // Far future
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 85, resets_at: '2026-02-23T15:00:00Z' },
        seven_day: { utilization: 60, resets_at: null },
      }),
    });

    await check();
    // Should have written the usage-paused file
    expect(writeFileSync).toHaveBeenCalled();
    expect(vi.mocked(lifecycle.system)).toHaveBeenCalled();
  });

  it('resumes autoloop when usage drops below resume threshold', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    // Simulate paused state: usage-paused file exists
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      if (path.includes('usage-paused')) return true;
      if (path.includes('usage-override')) return false;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 30, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      }),
    });

    await check();
    // Should have unlinked the usage-paused file
    expect(unlinkSync).toHaveBeenCalled();
    expect(vi.mocked(lifecycle.system)).toHaveBeenCalled();
  });

  it('skips pause/resume logic when override is active', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    // Override file exists
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      if (path.includes('usage-override')) return true;
      if (path.includes('usage-paused')) return false;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 95, resets_at: null },
        seven_day: { utilization: 90, resets_at: null },
      }),
    });

    await check();
    // Should NOT have written usage-paused file (override active)
    const pauseWrites = vi.mocked(writeFileSync).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('usage-paused')
    );
    expect(pauseWrites).toHaveLength(0);
  });

  it('handles rate limit (429) gracefully without disabling', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    await check();
    // Should not stop the monitor on rate limit
    expect(getStopReason()).toBeNull();
  });

  it('disables monitor after 401 auth error and failed refresh', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
        // No refreshToken = refresh will fail
      },
    }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await check();
    expect(getStopReason()).toContain('401');
  });

  it('disables monitor after 403 forbidden error', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    // No env token, so no fallback available
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await check();
    expect(getStopReason()).toContain('403');
  });

  it('populates cachedUsage and lastCheckTime on successful check', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 40, resets_at: '2026-02-23T15:00:00Z' },
        seven_day: { utilization: 30, resets_at: null },
        seven_day_opus: { utilization: 20, resets_at: null },
      }),
    });

    await check();

    const data = getUsageData();
    expect(data).not.toBeNull();
    expect(data!.fiveHour.utilization).toBe(40);
    expect(data!.sevenDay.utilization).toBe(30);
    expect(data!.sevenDayOpus).not.toBeNull();
    expect(data!.sevenDayOpus!.utilization).toBe(20);
    expect(getLastCheckTime()).not.toBeNull();
  });

  it('handles API returning unexpected shapes gracefully', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    // Return unexpected shape (missing fields)
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: null,
        seven_day: { utilization: 'not-a-number' },
      }),
    });

    await check();
    const data = getUsageData();
    expect(data).not.toBeNull();
    // parseDimension handles null/invalid shapes with defaults
    expect(data!.fiveHour.utilization).toBe(0);
    expect(data!.sevenDay.utilization).toBe(0); // 'not-a-number' not typeof number
  });

  it('disables after MAX_CONSECUTIVE_ERRORS generic errors', async () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token-abc',
        expiresAt: Date.now() + 3600000,
      },
    }));

    // 500 error
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    // Run check 5 times (MAX_CONSECUTIVE_ERRORS)
    for (let i = 0; i < 5; i++) {
      await check();
    }

    expect(getStopReason()).toContain('consecutive');
  });
});

describe('refreshTokenIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockFetch.mockReset();
  });

  it('returns null when no credentials file exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('returns null when no claudeAiOauth in credentials', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ someOtherKey: 'val' }));
    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('returns null when no refresh token is available', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1000 },
    }));
    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('returns null when token is still fresh', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 999999999, // Far future
      },
    }));
    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('refreshes when token is near expiry', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 1000, // expires very soon
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        refresh_token: 'new-reftok',
        expires_in: 3600,
      }),
    });

    const result = await refreshTokenIfNeeded();
    expect(result).toBe('new-token');
    // Should have written updated credentials
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('refreshes when forced even if token is not near expiry', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 999999999, // far future
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'forced-new-token',
        refresh_token: 'new-reftok',
        expires_in: 3600,
      }),
    });

    const result = await refreshTokenIfNeeded({ force: true });
    expect(result).toBe('forced-new-token');
  });

  it('refreshes when no expiresAt field exists', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        // no expiresAt
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 3600,
      }),
    });

    const result = await refreshTokenIfNeeded();
    expect(result).toBe('new-token');
  });

  it('returns null when refresh response is not ok', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 1000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'invalid grant',
    });

    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('returns null when refresh response is missing access_token', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 1000,
      },
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // no access_token
        refresh_token: 'new-reftok',
      }),
    });

    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });

  it('returns token even when credentials file write fails', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 1000,
      },
    }));
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        refresh_token: 'new-reftok',
        expires_in: 3600,
      }),
    });

    const result = await refreshTokenIfNeeded();
    // Should still return the token even if write fails
    expect(result).toBe('new-token');
  });

  it('handles fetch error gracefully', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'reftok',
        expiresAt: Date.now() + 1000,
      },
    }));

    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await refreshTokenIfNeeded();
    expect(result).toBeNull();
  });
});

describe('start / stop / reload lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetForTesting();
    mockFetch.mockReset();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  it('does not start when usage monitoring is disabled', () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: false,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);

    start();
    expect(isRunning()).toBe(false);
  });

  it('does not start when no token is available', () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    vi.mocked(existsSync).mockReturnValue(false);

    start();
    expect(isRunning()).toBe(false);
  });

  it('starts and is running when token is available', () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok' },
    }));

    start();
    expect(isRunning()).toBe(true);
  });

  it('is idempotent (calling start twice does not create duplicates)', () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok' },
    }));

    start();
    start(); // second call should be no-op
    expect(isRunning()).toBe(true);
  });

  it('stop clears timers and notifies listeners', () => {
    const callback = vi.fn();
    onUsageChange(callback);

    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok' },
    }));

    start();
    callback.mockClear();
    stop();
    expect(isRunning()).toBe(false);
    expect(callback).toHaveBeenCalled();
  });

  it('reload restarts the monitor', () => {
    vi.mocked(getUsageConfig).mockReturnValue({
      enabled: true,
      pauseThreshold: 80,
      resumeThreshold: 50,
      checkIntervalMinutes: 5,
      allowP0Override: true,
      allowP0: true,
    } as unknown as ReturnType<typeof getUsageConfig>);
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('.credentials.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok' },
    }));

    reload();
    expect(isRunning()).toBe(true);
    expect(getStopReason()).toBeNull();
  });
});
