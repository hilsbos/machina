/**
 * Lifecycle notifications - Telegram updates for agent events
 *
 * GitHub is the source of truth for status.
 * This module only handles Telegram notifications.
 */

import { config } from '../config.js';
import * as registry from './registry.js';
import type { AgentRole, BootContext } from '../types.js';
import { getTelegramTopics, getTelegramConfig, getNotificationMode } from '../agents/fritz-config.js';
import { ROLE_EMOJI } from '../types.js';
import { createAgentActionButtons, createAgentResponseButtons } from '../telegram/telegram-buttons.js';
import { escapeMd, formatHeader } from '../telegram/telegram-helpers.js';
import { sanitize } from '../telegram/message-sanitizer.js';
import {
  shouldNotify,
  type NotificationEvent,
  trackCompactMessage,
  getCompactEditTarget,
  touchCompactMessage,
  clearCompactMessage,
} from '../telegram/notification-mode.js';

// Telegram notification function (will be injected).
// Returns the Telegram message ID so callers can track it.
let notifyFn: ((message: string, topicId?: number, replyMarkup?: unknown) => Promise<number | undefined>) | null = null;

// Telegram edit function (will be injected for edit-in-place updates).
let editNotifyFn: ((chatId: string | number, messageId: number, text: string, topicId?: number, replyMarkup?: unknown) => Promise<boolean>) | null = null;

export function setNotifyFunction(
  fn: (message: string, topicId?: number, replyMarkup?: unknown) => Promise<number | undefined>
): void {
  notifyFn = fn;
}

export function setEditFunction(
  fn: (chatId: string | number, messageId: number, text: string, topicId?: number, replyMarkup?: unknown) => Promise<boolean>
): void {
  editNotifyFn = fn;
}

async function notify(message: string, topicId?: number, replyMarkup?: unknown): Promise<number | undefined> {
  let messageId: number | undefined;
  if (notifyFn) {
    messageId = await notifyFn(message, topicId, replyMarkup);
  }
  // Also log
  console.log(`[lifecycle] ${message.replace(/\n/g, ' | ')}`);
  return messageId;
}

async function editNotify(chatId: string | number, messageId: number, message: string, topicId?: number, replyMarkup?: unknown): Promise<boolean> {
  if (editNotifyFn) {
    const success = await editNotifyFn(chatId, messageId, message, topicId, replyMarkup);
    if (success) {
      console.log(`[lifecycle] (edited) ${message.replace(/\n/g, ' | ')}`);
    }
    return success;
  }
  return false;
}

/**
 * Format elapsed seconds into human-readable duration (Xm Xs or Xs).
 */
function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function getTopicForRole(role: AgentRole): number | undefined {
  const topics = getTelegramTopics();
  if (!topics) return undefined;

  switch (role) {
    case 'define':
    case 'ux':
    case 'architect':
    case 'budget':
      return topics.define;
    case 'implement':
      return topics.implement;
    case 'review':
      return topics.review;
    case 'validate':
      return topics.validate;
    case 'retro':
      return topics.retro;
    default:
      return topics.questions;
  }
}

// Agent starting
export async function hello(
  name: string,
  role: AgentRole,
  issue?: number,
  repo?: string,
  branch?: string,
  mode?: 'auto' | 'chat',
  bootContext?: BootContext,
  model?: string,
  claudeCodeVersion?: string
): Promise<void> {
  // Chat-mode hello is always delivered (user needs to interact)
  // Auto-mode hello is filtered by notification mode
  const helloEvent = mode === 'chat' ? 'hello_chat' : 'hello';
  if (!shouldNotify(helloEvent)) return;

  const agent = registry.getAgent(name);
  const title = agent?.issueTitle;
  const topic = getTopicForRole(role);

  const header = formatHeader(name, role, '🚀', {
    verb: 'started',
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  let message = header;
  if (model) message += `\n🤖 Model: \`${model}\``;
  if (claudeCodeVersion) message += `\n🔧 Claude Code: \`${claudeCodeVersion}\``;

  // Long-running mode indicator
  if (agent?.ttl === 0) {
    message += `\n⏳ *Long-running mode* — no TTL expiration`;
  }

  // Chat mode with context: show what was loaded
  if (mode === 'chat') {
    message += `\n💬 *Chat mode* — waiting for your instructions`;

    // Add context summary for chat mode with issue context
    if (bootContext?.type === 'issue' && bootContext.issue) {
      const ctx = bootContext.issue;
      const commentCount = ctx.comments.length;
      const prCount = ctx.linkedPrs.length;

      if (commentCount > 0 || prCount > 0) {
        message += `\n\n📋 *Context Loaded:*`;
        if (commentCount > 0) {
          // Show preview of latest comment
          const latestComment = ctx.comments[ctx.comments.length - 1];
          const preview = latestComment.body.length > 50
            ? latestComment.body.slice(0, 50) + '...'
            : latestComment.body;
          message += `\n• ${commentCount} comment${commentCount > 1 ? 's' : ''} (_"${escapeMd(preview)}"_)`;
        }
        if (prCount > 0) {
          message += `\n• ${prCount} related PR${prCount > 1 ? 's' : ''}: ${ctx.linkedPrs.map(p => `#${p.number}`).join(', ')}`;
        }
      }
    }

    message += `\n\nReply to this message or use /tell to give instructions.`;
  }

  // Use response buttons (with Reply) when in chat mode, otherwise standard action buttons
  const buttons = mode === 'chat' ? createAgentResponseButtons(name) : createAgentActionButtons(name);
  const messageId = await notify(message, topic, buttons);

  // Track message for compact mode edit-in-place
  if (messageId !== undefined && getNotificationMode() === 'compact') {
    trackCompactMessage(name, messageId);
  }
}

// Agent responded to a message — send output to Telegram
// Always sent regardless of notification mode (direct user interaction).
export async function agentResponse(
  name: string,
  response: string,
): Promise<number | undefined> {
  // Skip timeout messages entirely — they provide no actionable info
  // and buttons (Reply, Stop) don't make sense for a non-response
  if (response === '(timeout — no response)' || response === '(timeout - no response)') {
    return undefined;
  }

  // Skip any raw NDJSON that leaked through cleanResponse — check first few lines,
  // not just the start (response may have a non-JSON prefix like a banner/progress line).
  // Claude Code CLI uses "toolresult"/"tooluseid" (no underscore);
  // Anthropic API uses "tool_result"/"tool_use" — catch both variants.
  const firstLines = response.slice(0, 500);
  if (firstLines.includes('{"type":"') && /("toolresult"|"tool_result"|"tool_use"|"tooluseid"|"content_block")/.test(firstLines)) {
    console.log(`[lifecycle] Skipping raw NDJSON for ${name} (${response.length} chars)`);
    return undefined;
  }

  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;
  const topic = getTopicForRole(role);

  const emoji = ROLE_EMOJI[role] || '🤖';
  const header = formatHeader(name, role, emoji, { issue, issueTitle: title, repo, branch });

  // Use new robust sanitizer for agent responses
  const sanitized = sanitize(response);
  if (sanitized.warnings.length > 0) {
    console.log(`[lifecycle] Sanitization warnings for ${name}:`, sanitized.warnings);
  }

  let message = `${header}\n\n${sanitized.text}`;

  // Truncate if too long for Telegram
  if (message.length > 4000) {
    message = message.slice(0, 3990) + '\n\n_(truncated)_';
  }

  return await notify(message, topic, createAgentResponseButtons(name));
}

// Agent completed successfully
export async function completed(name: string, summary?: string, teammateCount?: number): Promise<void> {
  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;

  const topic = getTopicForRole(role);

  const header = formatHeader(name, role, '✅', {
    verb: 'completed',
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  let message = header;
  if (teammateCount !== undefined && teammateCount > 0) {
    message += `\n🤝 *${teammateCount} teammate${teammateCount > 1 ? 's' : ''} spawned*`;
  }
  if (summary) {
    // Use new robust sanitizer for agent summaries
    const sanitized = sanitize(summary);
    if (sanitized.warnings.length > 0) {
      console.log(`[lifecycle] Sanitization warnings for ${name}:`, sanitized.warnings);
    }
    message += `\n\n${sanitized.text}`;
  }

  // Only add "View Logs" button (no stop since agent is completed)
  const viewLogsButton = {
    inline_keyboard: [
      [
        {
          text: '📋 View Logs',
          callback_data: `logs:${name}`,
        },
      ],
    ],
  };

  // Compact mode: try to edit the tracked message instead of sending a new one
  const compactTarget = getCompactEditTarget(name, getTelegramConfig().editMinIntervalMs);
  if (compactTarget !== undefined) {
    const success = await editNotify(config.telegramChatId, compactTarget, message, topic, viewLogsButton);
    if (success) {
      clearCompactMessage(name);
      return;
    }
    // Fall through to send new message if edit failed
  }

  // Clean up compact tracking on completion
  clearCompactMessage(name);

  if (!shouldNotify('completed')) return;

  await notify(message, topic, viewLogsButton);
}

// Agent failed — always sent (critical event, not mode-filtered)
export async function failed(name: string, error?: string): Promise<void> {
  clearCompactMessage(name); // Clean up compact tracking
  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;

  const topic = getTelegramTopics()?.questions;

  const header = formatHeader(name, role, '❌', {
    verb: 'failed',
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  let message = header;
  if (error) {
    message += `\n\n\`\`\`\n${error}\n\`\`\``;
  }

  // Add "View Logs" button for failed agents
  const viewLogsButton = {
    inline_keyboard: [
      [
        {
          text: '📋 View Logs',
          callback_data: `logs:${name}`,
        },
      ],
    ],
  };

  await notify(message, topic, viewLogsButton);
}

// Agent blocked — always sent (critical event, not mode-filtered)
export async function blocked(name: string, reason?: string): Promise<void> {
  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;

  const topic = getTelegramTopics()?.questions;

  const header = formatHeader(name, role, '🚫', {
    verb: 'blocked',
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  // Use new robust sanitizer for blocked reasons
  const sanitized = sanitize(reason || 'Waiting for input');
  if (sanitized.warnings.length > 0) {
    console.log(`[lifecycle] Sanitization warnings for ${name}:`, sanitized.warnings);
  }

  let message = header;
  message += `\n\n${sanitized.text}`;

  // Tag user when input is needed
  if (config.telegramTagHandle) {
    message += `\n\n${config.telegramTagHandle}`;
  }

  await notify(message, topic);
}

// Agent timed out
export async function timeout(name: string): Promise<void> {
  clearCompactMessage(name); // Clean up compact tracking

  if (!shouldNotify('timeout')) return;

  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;

  const topic = getTelegramTopics()?.questions;

  const header = formatHeader(name, role, '⏰', {
    verb: 'timed out',
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  await notify(header, topic);
}

// Processing update - periodic update while agent is working on a message
// Supports edit-in-place to reduce notification spam
export async function processingUpdate(
  name: string,
  elapsedSeconds: number,
  preview?: string,
  options?: {
    messageId?: number;
    chatId?: string;
  }
): Promise<number | undefined> {
  if (!shouldNotify('processing_update')) return undefined;
  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const topic = getTopicForRole(role);

  const timeStr = formatElapsedTime(elapsedSeconds);
  let message = `⏳ \`${name}\`\nWorking... (${timeStr})`;
  if (preview) {
    message += `\n📝 ${escapeMd(preview.slice(0, 100))}`;
  }

  // Try edit-in-place if messageId is provided
  if (options?.messageId && options?.chatId) {
    const success = await editNotify(options.chatId, options.messageId, message, topic);
    if (success) {
      return options.messageId;
    }
    // Fall through to send new message if edit failed
  }

  // Send new message (fallback or legacy mode)
  return await notify(message, topic);
}

// Timeout warning - alert when approaching message timeout
// Supports edit-in-place to show warning inline in the status message
export async function timeoutWarning(
  name: string,
  remainingSeconds: number,
  options?: {
    messageId?: number;
    chatId?: string;
  }
): Promise<void> {
  if (!shouldNotify('timeout_warning')) return;
  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;

  const topic = getTelegramTopics()?.questions;

  // Try edit-in-place: update the status message with timeout warning inline
  if (options?.messageId && options?.chatId) {
    const message = `⏳ \`${name}\`\nWorking... ⚠️ timeout in ${remainingSeconds}s`;
    const success = await editNotify(options.chatId, options.messageId, message, topic);
    if (success) {
      return;
    }
    // Fall through to send new message if edit failed
  }

  // Send new message (fallback or legacy mode)
  const header = formatHeader(name, role, '⚠️', {
    issue,
    issueTitle: title,
    repo,
    branch,
  });

  const message = `${header}\n\nResponse taking longer than expected.\nAgent may be working on a complex task.\nWill timeout in ${remainingSeconds}s.`;

  await notify(message, topic);
}

// Agent issue comment — centralized notification from report.sh via daemon API
// `issue` accepts null because registry.agents[].issue is typed as `number | null`
export async function issueComment(
  name: string,
  issue: number | null | undefined,
  body: string,
  type: 'blocked' | 'progress' | 'complete' | 'info' | 'summary'
): Promise<void> {
  // Map report.sh type to notification event for mode filtering
  const eventMap: Record<typeof type, NotificationEvent> = {
    blocked: 'blocked',
    progress: 'progress',
    complete: 'complete_report',
    info: 'info',
    summary: 'skill_summary',  // Skill deliverables (specs, reviews) — suppressed in essential mode (automated lifecycle)
  };
  const event = eventMap[type];

  const agent = registry.getAgent(name);
  const role = agent?.role || 'implement';
  const title = agent?.issueTitle;
  const repo = agent?.repo;
  const branch = agent?.branch;
  const emoji = type === 'complete' ? '✅'
    : type === 'blocked' ? '🚫'
    : type === 'progress' ? '🔄'
    : type === 'summary' ? '📋'
    : 'ℹ️';

  const header = formatHeader(name, role, emoji, { issue, issueTitle: title, repo, branch });

  // Format numbered items like (1)...(2)... as line-separated entries
  const structured = body.replace(/\s*\((\d+)\)\s*/g, '\n$1. ');
  const truncated = structured.length > 300 ? structured.slice(0, 297) + '…' : structured;

  // Use new robust sanitizer for agent messages
  const sanitized = sanitize(truncated);
  if (sanitized.warnings.length > 0) {
    console.log(`[lifecycle] Sanitization warnings for ${name}:`, sanitized.warnings);
  }

  const issueLink = (issue && config.githubRepo)
    ? `\n🔗 [GitHub](https://github.com/${config.githubRepo}/issues/${issue})`
    : '';

  // Tag user when input is needed (blocked notifications)
  const tagLine = (type === 'blocked' && config.telegramTagHandle)
    ? `\n\n${config.telegramTagHandle}`
    : '';

  const message = `${header}\n\n${sanitized.text}${issueLink}${tagLine}`;

  const topic = type === 'blocked'
    ? getTelegramTopics()?.questions
    : getTopicForRole(role);

  // Compact mode: try to edit the tracked message for progress/complete updates
  if (getNotificationMode() === 'compact' && (type === 'progress' || type === 'complete')) {
    const compactTarget = getCompactEditTarget(name, getTelegramConfig().editMinIntervalMs);
    if (compactTarget !== undefined) {
      const success = await editNotify(config.telegramChatId, compactTarget, message, topic);
      if (success) {
        touchCompactMessage(name);
        return;
      }
      // Fall through to send new message if edit failed
    }
  }

  // Check mode filter (after compact handling, so compact edits aren't blocked)
  if (!shouldNotify(event)) return;

  const messageId = await notify(message, topic);

  // Track new message for compact mode
  if (messageId !== undefined && getNotificationMode() === 'compact') {
    trackCompactMessage(name, messageId);
  }
}

// System notification
export async function system(message: string): Promise<void> {
  if (!shouldNotify('system')) return;
  await notify(`🤖 *fritZ* ${message}`);
}

// Stale deployment reminder — always sent (critical, bypasses notification mode)
export async function staleDeploymentReminder(
  repo: string,
  issueUrl: string,
  ageDays: number,
): Promise<void> {
  const message = `⚠️ *Deployment pending — ${escapeMd(repo)}*\n` +
    `Open for ${ageDays} day${ageDays !== 1 ? 's' : ''}\\. Deploy when ready:\n${issueUrl}`;
  await notify(message);
}
