/**
 * FeedbackManager - Coordinates chat mode feedback for agent communication.
 *
 * Provides:
 * - Typing indicators while agent is processing
 * - Periodic progress updates with elapsed time
 * - Timeout warnings when approaching limit
 * - Output previews (optional, for long-running tasks)
 */

import { getTelegramConfig } from './fritz-config.js';

interface FeedbackSession {
  agentName: string;
  chatId: string;
  startTime: number;
  typingTimer: ReturnType<typeof setInterval> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
  lastUpdate: number;
  statusMessageId?: number;  // Track the message to edit for edit-in-place updates
  timeoutWarned: boolean;
  lastEditTime: number;      // Track last edit time for rate limiting
}

// Callbacks for external integrations (Telegram)
interface FeedbackCallbacks {
  sendTypingIndicator: (chatId: string) => Promise<void>;
  sendProgressUpdate: (
    agentName: string,
    elapsedSeconds: number,
    preview?: string,
    options?: { messageId?: number; chatId?: string }
  ) => Promise<number | undefined>;  // Returns message ID for tracking
  sendTimeoutWarning: (
    agentName: string,
    remainingSeconds: number,
    options?: { messageId?: number; chatId?: string }
  ) => Promise<void>;
  editMessage?: (
    chatId: string | number,
    messageId: number,
    text: string
  ) => Promise<boolean>;  // Returns success/failure
}

let callbacks: FeedbackCallbacks | null = null;
const sessions: Map<string, FeedbackSession> = new Map();


function log(msg: string): void {
  console.log(`[feedback-manager] ${msg}`);
}

/**
 * Initialize the feedback manager with Telegram integration callbacks.
 */
export function initFeedbackManager(cbs: FeedbackCallbacks): void {
  callbacks = cbs;
  log('Initialized feedback manager');
}

/**
 * Check if chat feedback is enabled via configuration.
 */
function isFeedbackEnabled(): boolean {
  return getTelegramConfig().chatFeedbackEnabled;
}

/**
 * Start a feedback session for a new message to an agent.
 * This activates typing indicators and progress timers.
 */
export function startFeedback(
  agentName: string,
  chatId: string,
  options?: {
    statusMessageId?: number;
    timeoutMs?: number;
  }
): void {
  if (!isFeedbackEnabled()) {
    log(`Feedback disabled, skipping session for ${agentName}`);
    return;
  }

  const { statusMessageId, timeoutMs = 180000 } = options || {};

  // Stop any existing session for this agent
  stopFeedback(agentName);

  const session: FeedbackSession = {
    agentName,
    chatId,
    startTime: Date.now(),
    typingTimer: null,
    progressTimer: null,
    lastUpdate: Date.now(),
    statusMessageId,
    timeoutWarned: false,
    lastEditTime: 0,
  };

  // Read telegram config once per session start
  const telegramCfg = getTelegramConfig();

  // Start typing indicator timer
  const typingInterval = telegramCfg.typingIndicatorIntervalMs;
  session.typingTimer = setInterval(async () => {
    if (callbacks) {
      try {
        await callbacks.sendTypingIndicator(chatId);
      } catch {
        // Ignore errors - typing indicator is best-effort
      }
    }
  }, typingInterval);

  // Send initial typing indicator immediately
  if (callbacks) {
    callbacks.sendTypingIndicator(chatId).catch(() => {});
  }

  // Start progress update timer
  const progressInterval = telegramCfg.progressUpdateIntervalMs;
  const editMinInterval = telegramCfg.editMinIntervalMs;
  const editInPlaceEnabled = telegramCfg.editInPlaceEnabled;

  session.progressTimer = setInterval(async () => {
    const now = Date.now();
    const elapsedMs = now - session.startTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    // Check for timeout warning
    const threshold = telegramCfg.timeoutWarningThreshold;
    const warningThresholdMs = timeoutMs * threshold;

    if (!session.timeoutWarned && elapsedMs >= warningThresholdMs) {
      session.timeoutWarned = true;
      const remainingSeconds = Math.floor((timeoutMs - elapsedMs) / 1000);
      if (callbacks) {
        try {
          await callbacks.sendTimeoutWarning(
            agentName,
            remainingSeconds,
            editInPlaceEnabled && session.statusMessageId
              ? { messageId: session.statusMessageId, chatId: session.chatId }
              : undefined
          );
        } catch {
          // Best-effort
        }
      }
    }

    // Send progress update (or edit existing message if edit-in-place is enabled)
    if (callbacks) {
      // Rate limit edits to avoid Telegram API limits
      const timeSinceLastEdit = now - session.lastEditTime;
      if (editInPlaceEnabled && session.statusMessageId && timeSinceLastEdit >= editMinInterval) {
        // Edit existing status message in-place
        try {
          const messageId = await callbacks.sendProgressUpdate(
            agentName,
            elapsedSeconds,
            undefined,
            { messageId: session.statusMessageId, chatId: session.chatId }
          );
          session.lastEditTime = now;
          // Update statusMessageId if a new message was created (fallback case)
          if (messageId && messageId !== session.statusMessageId) {
            session.statusMessageId = messageId;
          }
        } catch {
          // Best-effort
        }
      } else if (editInPlaceEnabled && !session.statusMessageId) {
        // Lazy-create: no initial ack message was sent, create a progress message now
        // and capture its ID for subsequent edit-in-place updates
        try {
          const messageId = await callbacks.sendProgressUpdate(agentName, elapsedSeconds);
          if (messageId) {
            session.statusMessageId = messageId;
            session.lastEditTime = now;
          }
        } catch {
          // Best-effort — typing indicator remains as fallback
        }
      } else if (!editInPlaceEnabled) {
        // Legacy: send new message
        try {
          const messageId = await callbacks.sendProgressUpdate(agentName, elapsedSeconds);
          // Track the first status message for potential future edit-in-place
          if (messageId && !session.statusMessageId) {
            session.statusMessageId = messageId;
          }
        } catch {
          // Best-effort
        }
      }
      // Skip update if edit-in-place is enabled but rate limited
    }

    session.lastUpdate = now;
  }, progressInterval);

  sessions.set(agentName, session);
  log(`Started feedback session for ${agentName} (chat: ${chatId})`);
}

/**
 * Stop a feedback session and clean up timers.
 * Call this when the agent response is received.
 */
export function stopFeedback(agentName: string): void {
  const session = sessions.get(agentName);
  if (!session) return;

  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = null;
  }

  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = null;
  }

  sessions.delete(agentName);
  log(`Stopped feedback session for ${agentName}`);
}

/**
 * Update progress with an optional preview from agent output.
 * Called from agent-comms when stdout is received.
 */
export function updateProgress(agentName: string, preview?: string): void {
  const session = sessions.get(agentName);
  if (!session) return;

  // Throttle: only update if at least 5 seconds since last update
  const now = Date.now();
  if (now - session.lastUpdate < 5000) return;

  const elapsedSeconds = Math.floor((now - session.startTime) / 1000);

  if (callbacks) {
    callbacks.sendProgressUpdate(agentName, elapsedSeconds, preview).catch(() => {});
  }

  session.lastUpdate = now;
}

