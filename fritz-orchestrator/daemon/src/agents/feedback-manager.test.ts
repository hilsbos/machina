/**
 * Vitest tests for the feedback manager (Issue #304, #513).
 *
 * Imports actual functions from feedback-manager.ts and mocks dependencies.
 *
 * Covers:
 * - initFeedbackManager callback registration
 * - startFeedback session management
 * - stopFeedback cleanup
 * - updateProgress throttling
 * - Feedback disabled path
 * - Lazy-create progress message when no initial statusMessageId (Issue #513)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fritz-config.js before importing the module under test
vi.mock('./fritz-config.js', () => ({
  getTelegramConfig: vi.fn(() => ({
    chatFeedbackEnabled: true,
    typingIndicatorIntervalMs: 5000,
    progressUpdateIntervalMs: 15000,
    editMinIntervalMs: 3000,
    editInPlaceEnabled: false,
    timeoutWarningThreshold: 0.8,
  })),
}));

import {
  initFeedbackManager,
  startFeedback,
  stopFeedback,
  updateProgress,
} from './feedback-manager.js';

import { getTelegramConfig } from './fritz-config.js';

// ── Tests ──

describe('FeedbackManager', () => {
  let mockSendTyping: ReturnType<typeof vi.fn>;
  let mockSendProgress: ReturnType<typeof vi.fn>;
  let mockSendTimeout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendTyping = vi.fn().mockResolvedValue(undefined);
    mockSendProgress = vi.fn().mockResolvedValue(undefined);
    mockSendTimeout = vi.fn().mockResolvedValue(undefined);

    initFeedbackManager({
      sendTypingIndicator: mockSendTyping,
      sendProgressUpdate: mockSendProgress,
      sendTimeoutWarning: mockSendTimeout,
    });
  });

  afterEach(() => {
    stopFeedback('test-agent');
    vi.useRealTimers();
  });

  it('sends typing indicator immediately on startFeedback', () => {
    startFeedback('test-agent', 'chat-123');
    expect(mockSendTyping).toHaveBeenCalledWith('chat-123');
  });

  it('sends typing indicator periodically', async () => {
    startFeedback('test-agent', 'chat-123');
    // Initial call
    expect(mockSendTyping).toHaveBeenCalledTimes(1);

    // Advance past typing interval (5000ms)
    await vi.advanceTimersByTimeAsync(5001);
    expect(mockSendTyping.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sends progress updates periodically', async () => {
    startFeedback('test-agent', 'chat-123');

    // Advance past progress interval (15000ms)
    await vi.advanceTimersByTimeAsync(15001);
    expect(mockSendProgress).toHaveBeenCalled();
  });

  it('stopFeedback cleans up timers', async () => {
    startFeedback('test-agent', 'chat-123');
    stopFeedback('test-agent');

    const callCount = mockSendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    // No more typing indicators after stop
    expect(mockSendTyping.mock.calls.length).toBe(callCount);
  });

  it('stopFeedback is safe when no session exists', () => {
    // Should not throw
    stopFeedback('nonexistent-agent');
  });

  it('does not start session when feedback is disabled', () => {
    vi.mocked(getTelegramConfig).mockReturnValue({
      chatFeedbackEnabled: false,
      typingIndicatorIntervalMs: 5000,
      progressUpdateIntervalMs: 15000,
      editMinIntervalMs: 3000,
      editInPlaceEnabled: false,
      timeoutWarningThreshold: 0.8,
    } as unknown as ReturnType<typeof getTelegramConfig>);

    mockSendTyping.mockClear();
    startFeedback('disabled-agent', 'chat-123');
    // Should not have sent any typing indicators (beyond what happened before)
    expect(mockSendTyping).not.toHaveBeenCalled();

    // Reset mock
    vi.mocked(getTelegramConfig).mockReturnValue({
      chatFeedbackEnabled: true,
      typingIndicatorIntervalMs: 5000,
      progressUpdateIntervalMs: 15000,
      editMinIntervalMs: 3000,
      editInPlaceEnabled: false,
      timeoutWarningThreshold: 0.8,
    } as unknown as ReturnType<typeof getTelegramConfig>);
  });

  it('startFeedback stops existing session for same agent', () => {
    startFeedback('test-agent', 'chat-123');
    // Starting again should not throw
    startFeedback('test-agent', 'chat-456');
    // Should send new typing indicator for the new chat
    const chatIds = mockSendTyping.mock.calls.map(c => c[0]);
    expect(chatIds).toContain('chat-456');
  });

  it('updateProgress does nothing when no session exists', () => {
    updateProgress('nonexistent-agent', 'preview text');
    expect(mockSendProgress).not.toHaveBeenCalled();
  });

  it('sends timeout warning when approaching limit', async () => {
    // Start with a short timeout (10 seconds)
    startFeedback('test-agent', 'chat-123', { timeoutMs: 10000 });

    // Advance past the timeout warning threshold (80% of 10s = 8s)
    // Progress timer fires at 15s intervals, so we need to get past at least one
    await vi.advanceTimersByTimeAsync(15001);

    expect(mockSendTimeout).toHaveBeenCalled();
  });
});

// ── Lazy-create tests (Issue #513) ──

describe('FeedbackManager — edit-in-place lazy-create', () => {
  let mockSendTyping: ReturnType<typeof vi.fn>;
  let mockSendProgress: ReturnType<typeof vi.fn>;
  let mockSendTimeout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendTyping = vi.fn().mockResolvedValue(undefined);
    mockSendProgress = vi.fn().mockResolvedValue(undefined);
    mockSendTimeout = vi.fn().mockResolvedValue(undefined);

    // Enable edit-in-place mode
    vi.mocked(getTelegramConfig).mockReturnValue({
      chatFeedbackEnabled: true,
      typingIndicatorIntervalMs: 5000,
      progressUpdateIntervalMs: 15000,
      editMinIntervalMs: 3000,
      editInPlaceEnabled: true,
      timeoutWarningThreshold: 0.8,
    } as unknown as ReturnType<typeof getTelegramConfig>);

    initFeedbackManager({
      sendTypingIndicator: mockSendTyping,
      sendProgressUpdate: mockSendProgress,
      sendTimeoutWarning: mockSendTimeout,
    });
  });

  afterEach(() => {
    stopFeedback('test-agent');
    vi.useRealTimers();
    // Reset to default config
    vi.mocked(getTelegramConfig).mockReturnValue({
      chatFeedbackEnabled: true,
      typingIndicatorIntervalMs: 5000,
      progressUpdateIntervalMs: 15000,
      editMinIntervalMs: 3000,
      editInPlaceEnabled: false,
      timeoutWarningThreshold: 0.8,
    } as unknown as ReturnType<typeof getTelegramConfig>);
  });

  it('does not send progress before first interval when no statusMessageId', async () => {
    startFeedback('test-agent', 'chat-123');

    // Advance 5s — only typing indicators, no progress yet
    await vi.advanceTimersByTimeAsync(5001);
    expect(mockSendProgress).not.toHaveBeenCalled();
  });

  it('lazy-creates progress message on first progress tick without statusMessageId', async () => {
    // Return a fake message ID to simulate Telegram sending a new message
    mockSendProgress.mockResolvedValue(42);

    startFeedback('test-agent', 'chat-123');

    // Advance past progress interval (15s)
    await vi.advanceTimersByTimeAsync(15001);

    // Should have called sendProgressUpdate without messageId/chatId options (lazy-create)
    expect(mockSendProgress).toHaveBeenCalledTimes(1);
    // Lazy-create: called with agent name and elapsed seconds only (no edit-in-place options)
    expect(mockSendProgress).toHaveBeenCalledWith('test-agent', expect.any(Number));
  });

  it('edits in-place after lazy-create captures message ID', async () => {
    // First call returns a message ID (lazy-create), subsequent calls return undefined (edit)
    mockSendProgress.mockResolvedValueOnce(42).mockResolvedValue(undefined);

    startFeedback('test-agent', 'chat-123');

    // First progress tick — lazy-create
    await vi.advanceTimersByTimeAsync(15001);
    expect(mockSendProgress).toHaveBeenCalledTimes(1);

    // Second progress tick — should now edit in-place using captured message ID
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockSendProgress).toHaveBeenCalledTimes(2);
    const secondCall = mockSendProgress.mock.calls[1];
    expect(secondCall[0]).toBe('test-agent');
    // Should have options with messageId and chatId (edit-in-place)
    expect(secondCall[3]).toEqual({ messageId: 42, chatId: 'chat-123' });
  });

  it('skips lazy-create gracefully if sendProgressUpdate returns no ID', async () => {
    // Return undefined — no message ID captured
    mockSendProgress.mockResolvedValue(undefined);

    startFeedback('test-agent', 'chat-123');

    // First progress tick — lazy-create attempt, but no ID returned
    await vi.advanceTimersByTimeAsync(15001);
    expect(mockSendProgress).toHaveBeenCalledTimes(1);

    // Second progress tick — should still attempt lazy-create (no ID stored)
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockSendProgress).toHaveBeenCalledTimes(2);
    // Both calls should be without messageId (lazy-create path, not edit-in-place)
    expect(mockSendProgress).toHaveBeenCalledWith('test-agent', expect.any(Number));
  });

  it('edits existing statusMessageId when provided upfront', async () => {
    mockSendProgress.mockResolvedValue(undefined);

    // Start with an explicit statusMessageId (old behavior, e.g. queue message)
    startFeedback('test-agent', 'chat-123', { statusMessageId: 99 });

    // First progress tick — should edit existing message
    await vi.advanceTimersByTimeAsync(15001);
    expect(mockSendProgress).toHaveBeenCalledTimes(1);
    const call = mockSendProgress.mock.calls[0];
    expect(call[3]).toEqual({ messageId: 99, chatId: 'chat-123' });
  });

  it('starts feedback without statusMessageId (no ack message)', () => {
    startFeedback('test-agent', 'chat-123');

    // Only typing indicator should be sent immediately
    expect(mockSendTyping).toHaveBeenCalledWith('chat-123');
    expect(mockSendProgress).not.toHaveBeenCalled();
  });
});
