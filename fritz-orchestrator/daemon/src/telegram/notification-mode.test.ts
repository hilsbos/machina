/**
 * Unit tests for notification-mode.ts
 *
 * Covers: shouldNotifyForMode (pure function), compact message tracking,
 *         getCompactEditTarget, MODE_DESCRIPTIONS
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the fritz-config module so we can control getNotificationMode
vi.mock('../agents/fritz-config.js', () => ({
  getNotificationMode: vi.fn(() => 'verbose'),
}));

import {
  shouldNotifyForMode,
  trackCompactMessage,
  getCompactMessage,
  clearCompactMessage,
  touchCompactMessage,
  getCompactEditTarget,
  MODE_DESCRIPTIONS,
  type NotificationEvent,
} from './notification-mode.js';

import { getNotificationMode } from '../agents/fritz-config.js';

// Cast the mock for easy control
const mockGetNotificationMode = vi.mocked(getNotificationMode);

// ---------------------------------------------------------------------------
// shouldNotifyForMode (pure function - no mocks needed)
// ---------------------------------------------------------------------------

describe('shouldNotifyForMode', () => {
  describe('verbose mode', () => {
    it('sends all events', () => {
      const events: NotificationEvent[] = [
        'hello', 'hello_chat', 'completed', 'failed', 'blocked', 'timeout',
        'progress', 'complete_report', 'info', 'agent_response',
        'skill_summary', 'processing_update', 'timeout_warning', 'system',
      ];

      for (const event of events) {
        expect(shouldNotifyForMode(event, 'verbose')).toBe(true);
      }
    });
  });

  describe('quiet mode', () => {
    it('suppresses non-critical events', () => {
      const suppressed: NotificationEvent[] = [
        'hello', 'completed', 'progress', 'complete_report',
        'info', 'processing_update', 'timeout_warning',
      ];

      for (const event of suppressed) {
        expect(shouldNotifyForMode(event, 'quiet')).toBe(false);
      }
    });

    it('always sends critical events', () => {
      const alwaysSent: NotificationEvent[] = [
        'blocked', 'failed', 'timeout', 'agent_response', 'hello_chat', 'system',
      ];

      for (const event of alwaysSent) {
        expect(shouldNotifyForMode(event, 'quiet')).toBe(true);
      }
    });

    it('sends skill_summary in quiet mode', () => {
      expect(shouldNotifyForMode('skill_summary', 'quiet')).toBe(true);
    });
  });

  describe('essential mode', () => {
    it('only sends blocked, failed, agent_response, and hello_chat', () => {
      const sent: NotificationEvent[] = [
        'blocked', 'failed', 'agent_response', 'hello_chat',
      ];

      for (const event of sent) {
        expect(shouldNotifyForMode(event, 'essential')).toBe(true);
      }
    });

    it('suppresses skill_summary (automated lifecycle messages)', () => {
      expect(shouldNotifyForMode('skill_summary', 'essential')).toBe(false);
    });

    it('suppresses all other events including timeout and system (but not hello_chat)', () => {
      const suppressed: NotificationEvent[] = [
        'hello', 'completed', 'timeout', 'progress', 'complete_report',
        'info', 'skill_summary', 'processing_update', 'timeout_warning', 'system',
      ];

      for (const event of suppressed) {
        expect(shouldNotifyForMode(event, 'essential')).toBe(false);
      }
    });
  });

  describe('compact mode', () => {
    it('sends all events (edit-in-place handled elsewhere)', () => {
      const events: NotificationEvent[] = [
        'hello', 'hello_chat', 'completed', 'failed', 'blocked', 'timeout',
        'progress', 'complete_report', 'info', 'agent_response',
        'skill_summary', 'processing_update', 'timeout_warning', 'system',
      ];

      for (const event of events) {
        expect(shouldNotifyForMode(event, 'compact')).toBe(true);
      }
    });
  });

  describe('hello_chat event (chat-mode agent hello)', () => {
    it('is delivered in essential mode (chat agents must be visible)', () => {
      expect(shouldNotifyForMode('hello_chat', 'essential')).toBe(true);
    });

    it('is delivered in quiet mode (ALWAYS_NOTIFY)', () => {
      expect(shouldNotifyForMode('hello_chat', 'quiet')).toBe(true);
    });

    it('is delivered in compact mode', () => {
      expect(shouldNotifyForMode('hello_chat', 'compact')).toBe(true);
    });

    it('is delivered in verbose mode', () => {
      expect(shouldNotifyForMode('hello_chat', 'verbose')).toBe(true);
    });

    it('auto-mode hello is still suppressed in essential mode', () => {
      expect(shouldNotifyForMode('hello', 'essential')).toBe(false);
    });
  });

  describe('critical events across all modes', () => {
    it('always sends blocked, failed, timeout, agent_response, hello_chat, system in quiet/compact/verbose', () => {
      const criticalEvents: NotificationEvent[] = [
        'blocked', 'failed', 'timeout', 'agent_response', 'hello_chat', 'system',
      ];
      const modes = ['quiet', 'compact', 'verbose'] as const;

      for (const mode of modes) {
        for (const event of criticalEvents) {
          expect(shouldNotifyForMode(event, mode)).toBe(true);
        }
      }
    });

    it('always sends blocked, failed, agent_response, hello_chat in essential mode', () => {
      const essentialCritical: NotificationEvent[] = [
        'blocked', 'failed', 'agent_response', 'hello_chat',
      ];

      for (const event of essentialCritical) {
        expect(shouldNotifyForMode(event, 'essential')).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Compact message tracking lifecycle
// ---------------------------------------------------------------------------

describe('compact message tracking', () => {
  beforeEach(() => {
    // Clean up any tracked messages from previous tests
    clearCompactMessage('test-agent-1');
    clearCompactMessage('test-agent-2');
    clearCompactMessage('agent-a');
    clearCompactMessage('agent-b');
  });

  it('returns undefined for untracked agent', () => {
    expect(getCompactMessage('nonexistent')).toBeUndefined();
  });

  it('tracks a message and retrieves it', () => {
    trackCompactMessage('test-agent-1', 42);
    const tracked = getCompactMessage('test-agent-1');
    expect(tracked).toBeDefined();
    expect(tracked!.messageId).toBe(42);
    expect(tracked!.lastEditedAt).toBeGreaterThan(0);
  });

  it('clears tracked message', () => {
    trackCompactMessage('test-agent-1', 42);
    clearCompactMessage('test-agent-1');
    expect(getCompactMessage('test-agent-1')).toBeUndefined();
  });

  it('tracks multiple agents independently', () => {
    trackCompactMessage('agent-a', 100);
    trackCompactMessage('agent-b', 200);

    expect(getCompactMessage('agent-a')!.messageId).toBe(100);
    expect(getCompactMessage('agent-b')!.messageId).toBe(200);

    clearCompactMessage('agent-a');
    expect(getCompactMessage('agent-a')).toBeUndefined();
    expect(getCompactMessage('agent-b')).toBeDefined();

    clearCompactMessage('agent-b');
  });

  it('touchCompactMessage updates lastEditedAt', () => {
    trackCompactMessage('test-agent-1', 42);
    const before = getCompactMessage('test-agent-1')!.lastEditedAt;

    // Advance time slightly
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    touchCompactMessage('test-agent-1');
    const after = getCompactMessage('test-agent-1')!.lastEditedAt;

    expect(after).toBeGreaterThanOrEqual(before);
    vi.useRealTimers();
  });

  it('touchCompactMessage is no-op for untracked agent', () => {
    // Should not throw
    expect(() => touchCompactMessage('nonexistent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getCompactEditTarget
// ---------------------------------------------------------------------------

describe('getCompactEditTarget', () => {
  beforeEach(() => {
    clearCompactMessage('test-agent-2');
    clearCompactMessage('test-agent-3');
    mockGetNotificationMode.mockReturnValue('compact');
  });

  it('returns undefined when no message is tracked', () => {
    expect(getCompactEditTarget('test-agent-2', 5000)).toBeUndefined();
  });

  it('returns undefined when throttled (within minIntervalMs)', () => {
    trackCompactMessage('test-agent-2', 99);
    // Just tracked, so lastEditedAt is ~now. 5000ms throttle should suppress.
    expect(getCompactEditTarget('test-agent-2', 5000)).toBeUndefined();
    clearCompactMessage('test-agent-2');
  });

  it('returns messageId after throttle interval has elapsed', () => {
    trackCompactMessage('test-agent-2', 99);

    // Simulate passage of time
    const tracked = getCompactMessage('test-agent-2');
    if (tracked) {
      tracked.lastEditedAt = Date.now() - 10_000; // 10 seconds ago
    }

    expect(getCompactEditTarget('test-agent-2', 5000)).toBe(99);
    clearCompactMessage('test-agent-2');
  });

  it('returns undefined when throttled again after touchCompactMessage', () => {
    trackCompactMessage('test-agent-2', 99);

    // Simulate time passing
    const tracked = getCompactMessage('test-agent-2');
    if (tracked) {
      tracked.lastEditedAt = Date.now() - 10_000;
    }

    // Verify edit target is available
    expect(getCompactEditTarget('test-agent-2', 5000)).toBe(99);

    // Touch to reset throttle
    touchCompactMessage('test-agent-2');
    expect(getCompactEditTarget('test-agent-2', 5000)).toBeUndefined();

    clearCompactMessage('test-agent-2');
  });

  it('returns undefined when not in compact mode (verbose)', () => {
    mockGetNotificationMode.mockReturnValue('verbose');
    trackCompactMessage('test-agent-3', 55);
    expect(getCompactEditTarget('test-agent-3', 0)).toBeUndefined();
    clearCompactMessage('test-agent-3');
  });

  it('returns undefined when not in compact mode (quiet)', () => {
    mockGetNotificationMode.mockReturnValue('quiet');
    trackCompactMessage('test-agent-3', 55);
    expect(getCompactEditTarget('test-agent-3', 0)).toBeUndefined();
    clearCompactMessage('test-agent-3');
  });

  it('returns undefined when not in compact mode (essential)', () => {
    mockGetNotificationMode.mockReturnValue('essential');
    trackCompactMessage('test-agent-3', 55);
    expect(getCompactEditTarget('test-agent-3', 0)).toBeUndefined();
    clearCompactMessage('test-agent-3');
  });

  it('returns messageId when in compact mode with 0 throttle', () => {
    mockGetNotificationMode.mockReturnValue('compact');
    trackCompactMessage('test-agent-3', 55);

    // Make lastEditedAt old enough
    const tracked = getCompactMessage('test-agent-3');
    if (tracked) {
      tracked.lastEditedAt = Date.now() - 10_000;
    }

    expect(getCompactEditTarget('test-agent-3', 5000)).toBe(55);
    clearCompactMessage('test-agent-3');
  });
});

// ---------------------------------------------------------------------------
// MODE_DESCRIPTIONS
// ---------------------------------------------------------------------------

describe('MODE_DESCRIPTIONS', () => {
  it('has entries for essential, quiet, compact, and verbose', () => {
    expect(MODE_DESCRIPTIONS).toHaveProperty('essential');
    expect(MODE_DESCRIPTIONS).toHaveProperty('quiet');
    expect(MODE_DESCRIPTIONS).toHaveProperty('compact');
    expect(MODE_DESCRIPTIONS).toHaveProperty('verbose');
  });

  it('each entry has emoji and description', () => {
    for (const mode of ['essential', 'quiet', 'compact', 'verbose'] as const) {
      expect(MODE_DESCRIPTIONS[mode]).toHaveProperty('emoji');
      expect(MODE_DESCRIPTIONS[mode]).toHaveProperty('description');
      expect(typeof MODE_DESCRIPTIONS[mode].emoji).toBe('string');
      expect(typeof MODE_DESCRIPTIONS[mode].description).toBe('string');
    }
  });
});
