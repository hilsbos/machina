// Focus mode state — tracks which agent each chat is focused on.
// Extracted to avoid circular dependency between telegram.ts and agents.ts.

// chatId → agentName
const focusedAgent = new Map<string, string>();

export function getFocusedAgent(chatId: string): string | undefined {
  return focusedAgent.get(chatId);
}

export function setFocusedAgent(chatId: string, agentName: string): void {
  focusedAgent.set(chatId, agentName);
}

export function clearFocusForChat(chatId: string): string | undefined {
  const was = focusedAgent.get(chatId);
  focusedAgent.delete(chatId);
  return was;
}

// Called when an agent stops — clear focus for all chats targeting it
export function clearFocus(agentName: string): void {
  for (const [chatId, focused] of focusedAgent) {
    if (focused === agentName) {
      focusedAgent.delete(chatId);
    }
  }
}
