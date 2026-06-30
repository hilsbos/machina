/**
 * Notification mode — controls Telegram notification verbosity.
 *
 * Four modes:
 *   - essential: Only questions and problems (blocked, failed, agent_response, hello_chat) — minimal interruptions
 *   - quiet:     Only warnings and errors (blocked, failed, timeout, usage warnings)
 *   - compact:   One message per agent, updated in-place via editMessageText
 *   - verbose:   Every event gets a new message
 *
 * Configured via fritz.yaml (telegram.notificationMode) or runtime toggle (fritz mode <mode>).
 */

import { getNotificationMode, type NotificationMode } from '../agents/fritz-config.js';

/**
 * Human-readable descriptions and emoji for each notification mode.
 * Single source of truth used by help text, mode display, and mode set responses.
 */
export const MODE_DESCRIPTIONS: Record<NotificationMode, { emoji: string; description: string }> = {
  essential: { emoji: '⚡', description: 'Only questions, problems, and direct replies (minimal interruptions)' },
  quiet: { emoji: '🔇', description: 'Only warnings and errors' },
  compact: { emoji: '📦', description: 'One message per agent, updated in-place' },
  verbose: { emoji: '🔔', description: 'Every event gets a new message' },
};

/**
 * Lifecycle event types that map to notification decisions.
 */
export type NotificationEvent =
  | 'hello'             // Agent started (auto-mode)
  | 'hello_chat'        // Chat-mode agent started (always delivered — user needs to know agent is ready)
  | 'completed'         // Agent completed successfully
  | 'failed'            // Agent failed
  | 'blocked'           // Agent blocked (needs input)
  | 'timeout'           // Agent timed out
  | 'progress'          // Progress update (from report.sh)
  | 'complete_report'   // Completion report (from report.sh)
  | 'info'              // Informational update
  | 'agent_response'    // Agent response to user message
  | 'skill_summary'     // Skill deliverable summary (tech spec, review, validation report)
  | 'processing_update' // Processing status update
  | 'timeout_warning'   // Approaching timeout
  | 'system';           // System notification

/**
 * Events that are always sent regardless of mode (except essential).
 * These are critical events that the user must always see.
 */
const ALWAYS_NOTIFY: NotificationEvent[] = [
  'blocked',
  'failed',
  'timeout',
  'agent_response',  // Direct responses to user messages must always be delivered
  'hello_chat',      // Chat-mode hello always delivered (user needs to know agent is ready)
  'system',
];

/**
 * Events sent in essential mode — only questions and problems that need user attention.
 * This is the most minimal mode: no progress, no lifecycle, no timeouts.
 *
 * Automated agent lifecycle messages (define complete, implement progress, review findings,
 * skill summaries, etc.) are suppressed — only direct user interactions and critical alerts
 * get through. Approval requests use the /api/ask path which bypasses this filter entirely.
 */
const ESSENTIAL_NOTIFY: NotificationEvent[] = [
  'blocked',          // Agent blocked — needs user input (questions, problems)
  'failed',           // Agent failed — something went wrong
  'agent_response',   // Direct response to user message
  'hello_chat',       // Chat-mode hello always delivered in essential mode
];

/**
 * Events suppressed in quiet mode.
 * Quiet mode only shows warnings/errors — suppress start, progress, completion.
 */
const QUIET_SUPPRESSED: NotificationEvent[] = [
  'hello',
  'completed',
  'progress',
  'complete_report',
  'info',
  'processing_update',
  'timeout_warning',
];

/**
 * Determine whether a notification should be sent based on the current mode.
 *
 * @param event - The lifecycle event type
 * @returns true if the notification should be sent, false if suppressed
 */
export function shouldNotify(event: NotificationEvent): boolean {
  const mode = getNotificationMode();
  return shouldNotifyForMode(event, mode);
}

/**
 * Pure logic: determine whether a notification should be sent for a given mode.
 * Exported for testing.
 */
export function shouldNotifyForMode(event: NotificationEvent, mode: NotificationMode): boolean {
  // Essential mode uses an allow-list (most restrictive — overrides ALWAYS_NOTIFY)
  if (mode === 'essential') {
    return ESSENTIAL_NOTIFY.includes(event);
  }

  // Always-notify events bypass mode filtering for all other modes
  if (ALWAYS_NOTIFY.includes(event)) {
    return true;
  }

  switch (mode) {
    case 'verbose':
      // Verbose: everything gets sent
      return true;

    case 'quiet':
      // Quiet: suppress non-critical events
      return !QUIET_SUPPRESSED.includes(event);

    case 'compact':
      // Compact: send all events, but lifecycle.ts handles edit-in-place aggregation.
      // The decision of whether to send vs edit is handled in the compact message tracker.
      return true;

    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Compact mode: per-agent message tracking for edit-in-place updates
// ---------------------------------------------------------------------------

interface CompactMessage {
  messageId: number;
  lastEditedAt: number;
}

// Map of agent name → tracked Telegram message for compact mode
const compactMessages = new Map<string, CompactMessage>();

/**
 * Track a Telegram message ID for compact mode edit-in-place.
 */
export function trackCompactMessage(agentName: string, messageId: number): void {
  compactMessages.set(agentName, {
    messageId,
    lastEditedAt: Date.now(),
  });
}

/**
 * Get the tracked compact message for an agent.
 * Returns undefined if no message is being tracked.
 */
export function getCompactMessage(agentName: string): CompactMessage | undefined {
  return compactMessages.get(agentName);
}

/**
 * Remove compact message tracking for an agent (on completion/failure/timeout).
 */
export function clearCompactMessage(agentName: string): void {
  compactMessages.delete(agentName);
}

/**
 * Check if we should edit the existing compact message or send a new one.
 * Returns the messageId to edit, or undefined if a new message should be sent.
 *
 * @param agentName - The agent name
 * @param minIntervalMs - Minimum interval between edits (rate limit protection)
 */
export function getCompactEditTarget(agentName: string, minIntervalMs: number): number | undefined {
  if (getNotificationMode() !== 'compact') {
    return undefined;
  }

  const tracked = compactMessages.get(agentName);
  if (!tracked) {
    return undefined;
  }

  // Throttle: don't edit more frequently than minIntervalMs
  const elapsed = Date.now() - tracked.lastEditedAt;
  if (elapsed < minIntervalMs) {
    return undefined; // Skip this update (throttled)
  }

  return tracked.messageId;
}

/**
 * Update the last-edited timestamp after a successful edit.
 */
export function touchCompactMessage(agentName: string): void {
  const tracked = compactMessages.get(agentName);
  if (tracked) {
    tracked.lastEditedAt = Date.now();
  }
}
