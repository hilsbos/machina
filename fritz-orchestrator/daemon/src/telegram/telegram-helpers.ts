// Telegram bot helper utilities
import type { MessageMetadata } from './message-formatter.js';
import type { AgentRole } from '../types.js';
import { ROLE_EMOJI } from '../types.js';

// Parse command arguments from Telegram message
export function parseArgs(text: string): string[] {
  return text.split(' ').slice(1);
}

// Create orchestrator metadata with current timestamp
export function createOrchestratorMetadata(): MessageMetadata {
  return {
    source: 'orchestrator',
    timestamp: new Date(),
  };
}

// Format error message from Error object or string
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Escape Telegram Markdown v1 special characters in user-generated text
export function escapeMd(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// Format a consistent message header for agent notifications
// Pattern: `agentName` emoji *role* verb • #N title
//          📦 repo (branch)  [optional second line]
export function formatHeader(
  agentName: string,
  role: AgentRole,
  statusEmoji: string,
  opts?: {
    verb?: string;          // "started", "completed", "failed", "blocked", "timed out"
    issue?: number | null;
    issueTitle?: string;
    repo?: string | null;
    branch?: string | null;
  }
): string {
  const emoji = statusEmoji || ROLE_EMOJI[role] || '🤖';
  const verb = opts?.verb ? ` ${opts.verb}` : '';
  const titleRaw = opts?.issueTitle
    ? (opts.issueTitle.length > 30 ? opts.issueTitle.slice(0, 27) + '…' : opts.issueTitle)
    : '';
  const titleTruncated = titleRaw ? ` ${escapeMd(titleRaw)}` : '';
  const issueStr = opts?.issue
    ? ` • #${opts.issue}${titleTruncated}`
    : '';

  let header = `\`${agentName}\` ${emoji} *${role}*${verb}${issueStr}`;

  // Add repo/branch line if present
  if (opts?.repo) {
    header += `\n📦 ${opts.repo}${opts.branch ? ` (${opts.branch})` : ''}`;
  }

  return header;
}

// Format a time-ago string from an ISO date
export function formatTimeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatFutureTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
