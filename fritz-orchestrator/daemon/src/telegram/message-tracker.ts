/**
 * Tracks which Telegram messages belong to which agent.
 * Used for reply-to-message routing in telegram.ts.
 *
 * Extracted to its own module to avoid a circular dependency
 * between agents.ts and telegram.ts.
 */

// Special identifier for orchestrator messages (Fritz)
export const ORCHESTRATOR_ID = '__orchestrator__';

// Map: Telegram message_id → agent name (or ORCHESTRATOR_ID)
const MAX_TRACKED_MESSAGES = 1000;
const TRIM_TARGET = 900;
const messageToAgentMap: Map<number, string> = new Map();

/** Record that a Telegram message belongs to an agent. */
export function trackAgentMessage(messageId: number, agentName: string): void {
  messageToAgentMap.set(messageId, agentName);
  // Trim oldest entries when exceeded, down to TRIM_TARGET to amortize cost
  if (messageToAgentMap.size > MAX_TRACKED_MESSAGES) {
    const entriesToDelete = messageToAgentMap.size - TRIM_TARGET;
    let deleted = 0;
    for (const key of messageToAgentMap.keys()) {
      if (deleted >= entriesToDelete) break;
      messageToAgentMap.delete(key);
      deleted++;
    }
  }
}

/** Look up which agent sent a given Telegram message. */
export function getAgentForMessage(messageId: number): string | undefined {
  return messageToAgentMap.get(messageId);
}
