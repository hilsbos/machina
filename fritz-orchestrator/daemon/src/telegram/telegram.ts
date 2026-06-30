import { Telegraf, Context, TelegramError } from 'telegraf';
import { config } from '../config.js';
import * as agents from '../agents/agents.js';
import * as agentComms from '../agents/agent-comms.js';
import * as autoloop from '../agents/autoloop.js';
import * as registry from '../core/registry.js';
import * as watchdog from '../core/watchdog.js';
import * as lifecycle from '../core/lifecycle.js';
import * as orchestrator from '../orchestrator/orchestrator.js';
import { trackAgentMessage, getAgentForMessage, ORCHESTRATOR_ID } from './message-tracker.js';
import { isValidRole } from '../agents/boot.js';
import { getOrchestratorModel, getDaemonConfig, getUsageConfig, getNotificationMode, setNotificationMode, isValidNotificationMode, type NotificationMode } from '../agents/fritz-config.js';
import * as usageMonitor from '../agents/usage-monitor.js';
import type { AgentRole } from '../types.js';
import { ROLE_EMOJI } from '../types.js';
import { formatMessage, type MessageMetadata } from './message-formatter.js';
import {
  parseArgs,
  createOrchestratorMetadata,
  formatError,
  escapeMd,
  formatTimeAgo,
  formatFutureTime,
} from './telegram-helpers.js';
import { stripMarkdown } from './message-sanitizer.js';
import { resolveQuestion, getQuestionOptions, fetchPipelineQueue } from '../api/api.js';
import { logEvent } from '../core/event-log.js';
import { MODE_DESCRIPTIONS } from './notification-mode.js';
import {
  decodeCallback,
  createConfirmationButtons,
  createAgentSelectionButtons,
  createRoleSelectionButtons,
  createBootContinuationButtons,
  createLogsActionButtons,
  createStatusActionButtons,
  createSuggestionButtons,
  createIssueSelectionButtons,
  createDiagnoseButtons,
  createRedeployConfirmButtons,
  findSimilarAgents,
} from './telegram-buttons.js';
import * as github from '../github/github.js';
import * as logArchive from '../agents/log-archive.js';
import * as diagnose from '../core/diagnose.js';
import type { CallbackQuery, InlineKeyboardMarkup } from 'telegraf/types';
import {
  getFocusedAgent,
  setFocusedAgent,
  clearFocusForChat,
} from '../agents/focus.js';
import * as feedbackManager from '../agents/feedback-manager.js';
import { getLatestClaudeCodeVersion } from '../agents/version-utils.js';
import * as scheduler from '../core/scheduler.js';

let bot: Telegraf | null = null;

// Send a message to the configured chat. Returns the last Telegram message ID.
export async function sendMessage(
  text: string,
  metadata?: MessageMetadata,
  topicId?: number,
  replyMarkup?: unknown
): Promise<number | undefined> {
  if (!bot) return undefined;

  // Format with metadata if provided
  const messages = metadata ? formatMessage(text, metadata) : [text];

  const options: {
    message_thread_id?: number;
    parse_mode: 'Markdown';
    reply_markup?: InlineKeyboardMarkup;
  } = {
    parse_mode: 'Markdown',
  };

  if (topicId) {
    options.message_thread_id = topicId;
  }

  if (replyMarkup) {
    options.reply_markup = replyMarkup as InlineKeyboardMarkup;
  }

  let lastMessageId: number | undefined;
  try {
    for (const msg of messages) {
      try {
        const sent = await bot.telegram.sendMessage(config.telegramChatId, msg, options);
        lastMessageId = sent.message_id;
      } catch (error: unknown) {
        // Check for Markdown parse error and retry with plain text
        if (
          error instanceof TelegramError &&
          error.response.error_code === 400 &&
          error.response.description?.includes("can't parse entities")
        ) {
          console.warn('[telegram] Markdown parse failed, retrying as plain text');
          const { parse_mode: _pm, ...plainOptions } = options;
          const plainMsg = stripMarkdown(msg);
          const sent = await bot.telegram.sendMessage(config.telegramChatId, plainMsg, plainOptions);
          lastMessageId = sent.message_id;
        } else {
          throw error;
        }
      }
      // Small delay between chunks to avoid rate limiting
      if (messages.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
  return lastMessageId;
}

/**
 * Edit an existing message in Telegram.
 * Used for edit-in-place progress updates to reduce notification spam.
 * Returns true on success, false on failure (graceful degradation).
 */
export async function editMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  _topicId?: number,  // Note: topicId is not needed for editing (message is already in the topic)
  replyMarkup?: unknown
): Promise<boolean> {
  if (!bot) return false;

  try {
    await bot.telegram.editMessageText(
      chatId,
      messageId,
      undefined, // inline_message_id (not used)
      text,
      {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup as InlineKeyboardMarkup,
      }
    );
    return true;
  } catch (error: unknown) {
    // Handle common Telegram API errors gracefully
    const errorCode = error instanceof TelegramError ? error.response.error_code : undefined;
    const errorDesc = error instanceof TelegramError ? error.response.description : '';

    if (errorCode === 400) {
      // Markdown parse error - retry with plain text
      if (errorDesc.includes("can't parse entities")) {
        console.warn(`[telegram] Markdown parse failed for edit, retrying as plain text`);
        try {
          await bot.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            stripMarkdown(text),
            { reply_markup: replyMarkup as InlineKeyboardMarkup }
          );
          return true;
        } catch (retryError) {
          console.error(`[telegram] Plain text retry also failed:`, retryError);
          return false;
        }
      }
      // Message not modified (content unchanged) - not a real error
      if (errorDesc.includes('message is not modified')) {
        return true;
      }
      // Message deleted or not found - log and continue
      if (errorDesc.includes('message to edit not found') || errorDesc.includes('MESSAGE_ID_INVALID')) {
        console.log(`[telegram] Message ${messageId} not found for edit (may have been deleted)`);
        return false;
      }
    }

    if (errorCode === 429) {
      // Rate limited - log and continue
      console.warn(`[telegram] Rate limited when editing message ${messageId}`);
      return false;
    }

    // Log other errors but don't throw
    console.error(`[telegram] Failed to edit message ${messageId}:`, error);
    return false;
  }
}

// Format local agent list for display (enhanced dashboard)
function formatLocalAgents(agentList: registry.LocalAgent[]): string {
  if (agentList.length === 0) {
    return 'No local agents';
  }

  const lines = agentList.map((a) => {
    const emoji = ROLE_EMOJI[a.role] || '🤖';
    const issue = a.issue ? `#${a.issue}` : 'standby';
    const title = a.issueTitle ? ` ${escapeMd(a.issueTitle.slice(0, 30))}` : '';
    let line = `\`${a.name}\` ${emoji} ${issue}${title}`;

    // Add last activity if available
    if (a.lastActivity) {
      const truncated = a.lastActivity.length > 50
        ? a.lastActivity.slice(0, 47) + '…'
        : a.lastActivity;
      const ago = a.lastActivityAt ? formatTimeAgo(a.lastActivityAt) : '';
      line += `\n   _"${escapeMd(truncated)}"_${ago ? ` • ${ago}` : ''}`;
    }

    return line;
  });

  return lines.join('\n\n');
}

// Format diagnosis report for Telegram (summary mode)
function formatDiagnosisReport(report: diagnose.DiagnosisReport): string {
  const statusEmoji: Record<string, string> = {
    healthy: '✅ Healthy',
    stale: '⚠️ Stale',
    error: '❌ Error',
  };
  const componentEmoji: Record<string, string> = {
    skills: '📚',
    knowledge: '📖',
    config: '📋',
  };
  const statusIcon: Record<string, string> = {
    current: '✅',
    stale: '⚠️',
    error: '❌',
    unknown: '❓',
  };

  let msg = `🩺 *fritZ Diagnosis*\n\nSystem Status: ${statusEmoji[report.overallStatus] || report.overallStatus}\n`;

  for (const comp of report.components) {
    const emoji = componentEmoji[comp.name] || '📄';
    const icon = statusIcon[comp.status] || '❓';
    const fileCount = comp.localState ? ` (${comp.localState.totalFiles} files)` : '';
    msg += `\n${emoji} *${comp.name}*${fileCount}\n  Status: ${icon} ${comp.message}`;

    // Show drift details in summary if stale
    if (comp.status === 'stale' && comp.drift.length > 0) {
      const driftLines = comp.drift.slice(0, 5).map((d) => {
        const typeIcon = d.type === 'modified' ? '~' : d.type === 'added' ? '+' : '-';
        return `    ${typeIcon} ${escapeMd(d.path)}`;
      });
      msg += '\n' + driftLines.join('\n');
      if (comp.drift.length > 5) {
        msg += `\n    _...and ${comp.drift.length - 5} more_`;
      }
    }
  }

  // Active agents
  msg += `\n\n🤖 *Active Agents:* ${report.activeAgents.length}`;
  if (report.activeAgents.length > 0) {
    for (const agent of report.activeAgents) {
      const issue = agent.issue ? ` #${agent.issue}` : '';
      const ago = formatTimeAgo(agent.bootedAt);
      msg += `\n  \`${agent.name}\` (${agent.role}${issue}, booted ${ago})`;
    }
  }

  // Orchestrator
  const orchIcon = report.orchestrator.running ? '✅ Running' : '⏹️ Stopped';
  msg += `\n\n🔄 *Orchestrator:* ${orchIcon}`;

  // Action hint
  const hasStale = report.components.some((c) => c.status === 'stale');
  if (hasStale) {
    msg += '\n\n💡 *Action:* Some components are stale. Redeploy to sync.';
  }

  return msg;
}

// Format verbose diagnosis details for Telegram
function formatDiagnosisVerbose(report: diagnose.DiagnosisReport): string {
  const statusIcon: Record<string, string> = {
    current: '✅',
    stale: '⚠️',
    error: '❌',
    unknown: '❓',
  };

  let msg = '📋 *Detailed Diagnosis*\n';

  for (const comp of report.components) {
    const icon = statusIcon[comp.status] || '❓';
    msg += `\n*${comp.name}* ${icon}\n`;

    if (comp.localState && comp.localState.files.length > 0) {
      for (const file of comp.localState.files) {
        const remotefile = comp.remoteState?.files.find((f) => f.path === file.path);
        const match = remotefile && remotefile.hash === file.hash;
        const fileIcon = match ? '✅' : remotefile ? '⚠️' : '❓';
        msg += `${fileIcon} ${escapeMd(file.path)}`;
        if (!match && remotefile) {
          msg += ` _(stale)_`;
          msg += `\n   Local:  \`${file.hash.slice(0, 7)}\``;
          msg += `\n   Remote: \`${remotefile.hash.slice(0, 7)}\``;
        }
        msg += '\n';
      }

      // Files only in remote (added remotely)
      if (comp.remoteState) {
        const localPaths = new Set(comp.localState.files.map((f) => f.path));
        for (const rf of comp.remoteState.files) {
          if (!localPaths.has(rf.path)) {
            msg += `➕ ${escapeMd(rf.path)} _(missing locally)_\n`;
          }
        }
      }
    } else if (comp.status === 'error') {
      msg += `  ${comp.message}\n`;
    } else {
      msg += `  No files found\n`;
    }
  }

  return msg;
}

// Create and configure bot
export function createBot(): Telegraf {
  bot = new Telegraf(config.telegramBotToken, {
    // Disable Telegraf's default 90s handler timeout — we manage our own
    // timeouts in agent-comms (180s) and the ask endpoint (300s).
    handlerTimeout: Infinity,
  });

  // Security: Only process messages from the configured Telegram group.
  // Silently drops DMs, foreign groups, and any chat that doesn't match
  // the configured TELEGRAM_CHAT_ID. See issue #290.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config.telegramChatId) return;
    return next();
  });

  // Wire up lifecycle notifications — returns message ID for tracking
  lifecycle.setNotifyFunction(async (message: string, topicId?: number, replyMarkup?: unknown) => {
    return await sendMessage(message, undefined, topicId, replyMarkup);
  });

  // Wire up lifecycle edit function for edit-in-place updates
  lifecycle.setEditFunction(async (chatId: string | number, messageId: number, text: string, topicId?: number, replyMarkup?: unknown) => {
    return await editMessage(chatId, messageId, text, topicId, replyMarkup);
  });

  // Initialize feedback manager with Telegram callbacks
  feedbackManager.initFeedbackManager({
    sendTypingIndicator: async (chatId: string) => {
      if (bot) {
        await bot.telegram.sendChatAction(chatId, 'typing');
      }
    },
    sendProgressUpdate: async (
      agentName: string,
      elapsedSeconds: number,
      preview?: string,
      options?: { messageId?: number; chatId?: string }
    ) => {
      return await lifecycle.processingUpdate(agentName, elapsedSeconds, preview, options);
    },
    sendTimeoutWarning: async (
      agentName: string,
      remainingSeconds: number,
      options?: { messageId?: number; chatId?: string }
    ) => {
      await lifecycle.timeoutWarning(agentName, remainingSeconds, options);
    },
    editMessage: async (chatId: string | number, messageId: number, text: string) => {
      return await editMessage(chatId, messageId, text);
    },
  });

  // /start - Welcome message
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `🤖 *fritZ Agent Orchestrator*

*Boot agents:*
\`/boot <role> [issue] [repo] [-chat]\`

Examples:
• \`/boot implement 42\` - Auto-work on issue
• \`/boot implement 42 -chat\` - Has context, waits for you (extended TTL)
• \`/boot implement -chat\` - Standby (no context, extended TTL)

*Other commands:*
/tell <name> <message> - Talk to an agent
/focus <name> - Focus on agent
/status - Show all agents
/stop <name> - Stop an agent
/logs <name> - Get agent logs
/refresh - Reload knowledge + reset session
/help - Show all commands

*Roles:* implement, review, validate, define, architect, ux, budget, retro, security-review, pentest`,
      { parse_mode: 'Markdown' }
    );
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 *fritZ Commands*

*Boot agents:*
\`/boot implement 42\` - Auto-work on issue #42
\`/boot implement 42 -chat\` - Load #42, wait for instructions (extended TTL)
\`/boot implement -chat\` - Standby (no context, extended TTL)
\`/boot implement 42 owner/repo\` - Work on issue in specific repo

_Chat-mode agents get a longer TTL (defaults.chatTtl in fritz.yaml) so interactive sessions don't get killed mid-conversation. Auto-mode agents use the role's configured TTL._

*Talk to agents:*
\`/tell impl-42 fix the tests too\` - Send message to agent
Or reply to any agent or Fritz message in Telegram
Tap ↩️ Reply for native reply UI

*Focus mode:*
\`/focus impl-42\` - Focus on agent (messages route to it)
\`/unfocus\` - Stop focusing

*Manage:*
\`/status\` - Show all agents
\`/stop impl-123\` - Stop specific agent
\`/stopall\` - Stop all agents
\`/logs impl-123\` - View agent logs
\`/logs -list\` - Browse archived agents
\`/cleanup\` - Remove old workspaces
\`/cleanup 48\` - Remove workspaces older than 48h
\`/diagnose\` - System freshness check
\`/diagnose verbose\` - Detailed file comparison
\`/refresh\` - Reload orchestrator knowledge + reset session
\`fritz pause\` - Pause autoloop (no new agents)
\`fritz resume\` - Resume autoloop
\`fritz usage\` - Show API usage & limits
\`fritz override\` - Override usage pause
\`fritz override off\` - Re-engage usage limits
\`fritz mode\` - Show notification mode
\`fritz mode essential\` - Only questions/problems
\`fritz mode quiet\` - Only warnings/errors
\`fritz mode compact\` - One message per agent
\`fritz mode verbose\` - All notifications
\`fritz queue\` - Show pipeline queue
\`fritz express #N\` - Mark issue N as express (priority:p0)
\`fritz hold #N\` - Put issue N on manual hold (fritz.manual)
\`fritz release #N\` - Release issue N from manual hold
\`fritz unblock #N\` - Remove all fritz.depends-on labels from issue N
\`fritz retro scan\` - Scan agent logs, propose improvements
\`fritz retro report\` - Full retrospective + PRs
\`fritz retro investigate <issue>\` - Deep-dive into a specific issue
\`fritz retro metrics\` - Show metrics dashboard
\`fritz schedule\` - List scheduled jobs
\`fritz schedule trigger <id>\` - Run job now
\`fritz schedule enable/disable <id>\` - Toggle job

*Roles:*
implement, review, validate, define, architect, ux, budget, retro, security-review, pentest`,
      { parse_mode: 'Markdown' }
    );
  });

  // /boot <role> [issue] [repo] [-chat] [--force]
  bot.command('boot', async (ctx) => {
    const args = parseArgs(ctx.message.text);

    // Check for -chat flag anywhere in args (single dash to avoid mobile keyboard issues)
    const chatMode = args.includes('-chat');
    // Check for --force flag (double dash — intentionally different from -chat)
    const forceMode = args.includes('--force');
    const filteredArgs = args.filter(a => a !== '-chat' && a !== '--force');

    if (filteredArgs.length === 0) {
      // No args - show role picker
      await ctx.reply('🚀 *Select agent role:*', {
        parse_mode: 'Markdown',
        reply_markup: createRoleSelectionButtons(),
      });
      return;
    }

    const role = filteredArgs[0];
    const issue = filteredArgs[1] ? parseInt(filteredArgs[1], 10) : undefined;
    // Only pass repo if explicitly specified by user — let bootAgent() handle label lookup and defaults
    const repo = filteredArgs[2] || undefined;

    if (!isValidRole(role)) {
      // Invalid role - show role picker button
      await ctx.reply(
        `❌ Invalid role: \`${role}\`\n\nUse the button below to select a valid role:`,
        {
          parse_mode: 'Markdown',
          reply_markup: createRoleSelectionButtons(),
        }
      );
      return;
    }

    const effectiveMode = chatMode ? 'chat' : (issue ? 'auto' : 'chat');
    const modeLabel = effectiveMode === 'chat' ? ' in chat mode' : '';

    if (forceMode) {
      const activeCount = agents.getActiveAgentCount();
      await ctx.reply(`⚠️ Force-boot: bypassing parallel limit (currently ${activeCount}/${agents.getMaxParallel()})`);
    }

    await ctx.reply(`🚀 Booting ${role} agent${modeLabel}...`);

    try {
      await agents.startAgent({
        role: role as AgentRole,
        issue,
        repo,
        mode: effectiveMode,
        force: forceMode || undefined,
      });
      // lifecycle.hello() inside startAgent() sends the confirmation with buttons
    } catch (error) {
      await ctx.reply(`❌ Failed to boot agent: ${formatError(error)}`);
    }
  });

  // /status
  bot.command('status', async (ctx) => {
    const status = await watchdog.getStatus();

    const ccVersion = getLatestClaudeCodeVersion(status.local);

    const manualPaused = autoloop.isManuallyPaused();
    const usagePausedFlag = usageMonitor.isUsagePaused();
    const overrideFlag = usageMonitor.hasOverride();
    let autoloopStatus: string;
    if (manualPaused) {
      autoloopStatus = '⏸️ Paused (manual)';
    } else if (usagePausedFlag && !overrideFlag) {
      autoloopStatus = '⏸️ Paused (usage)';
    } else {
      autoloopStatus = '▶️ Running';
    }

    let message = `*fritZ Status*

*Model:* ${escapeMd(getOrchestratorModel())}`;
    if (ccVersion) message += `\n*Claude Code:* ${escapeMd(ccVersion)}`;
    message += `\n*Autoloop:* ${autoloopStatus}`;

    // Show usage summary if available
    const usageData = usageMonitor.getUsageData();
    if (usageData) {
      const maxUtil = Math.max(
        usageData.fiveHour.utilization,
        usageData.sevenDay.utilization,
        usageData.sevenDayOpus?.utilization ?? 0
      );
      const accountName = usageMonitor.getAccountName();
      const accountLabel = accountName ? ` (${accountName})` : '';
      message += `\n*Usage:* ${maxUtil.toFixed(0)}%${accountLabel} (5h: ${usageData.fiveHour.utilization.toFixed(0)}%, 7d: ${usageData.sevenDay.utilization.toFixed(0)}%)`;
      if (overrideFlag) message += ' ⚠️ override';
    }

    message += `

*Local Agents:* ${status.local.length}
${formatLocalAgents(status.local)}

*GitHub Active:* ${status.github.length}`;

    if (status.github.length > 0) {
      message +=
        '\n' +
        status.github
          .map(
            (g) =>
              `🟢 ${ROLE_EMOJI[g.role] || '🤖'} #${g.issue} - ${escapeMd(g.title.slice(0, 30))}`
          )
          .join('\n');
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: createStatusActionButtons(),
    });
  });

  // /stop <name>
  bot.command('stop', async (ctx) => {
    const args = parseArgs(ctx.message.text);

    if (args.length === 0) {
      // No args - show agent selection menu
      const status = await watchdog.getStatus();

      if (status.local.length === 0) {
        await ctx.reply('ℹ️ No agents running');
        return;
      }

      await ctx.reply('⏹️ *Select agent to stop:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'stop'),
      });
      return;
    }

    const name = args[0];
    const agent = registry.getAgent(name);

    if (!agent) {
      // Agent not found - suggest similar agents
      const status = await watchdog.getStatus();
      const similar = findSimilarAgents(name, status.local, 3);

      if (similar.length > 0) {
        await ctx.reply(
          `❌ Agent not found: \`${name}\`\n\n*Did you mean:*`,
          {
            parse_mode: 'Markdown',
            reply_markup: createSuggestionButtons(similar, 'stop'),
          }
        );
      } else {
        await ctx.reply(`❌ Agent not found: \`${name}\``, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Show confirmation dialog
    const emoji = ROLE_EMOJI[agent.role] || '🤖';
    const issue = agent.issue ? `#${agent.issue}` : 'standby';
    await ctx.reply(
      `⚠️ Stop agent?\n\n${emoji} \`${agent.name}\`\n${issue}\n\nThis will terminate the running agent.`,
      {
        parse_mode: 'Markdown',
        reply_markup: createConfirmationButtons('stop', name),
      }
    );
  });

  // /stopall
  bot.command('stopall', async (ctx) => {
    const status = await watchdog.getStatus();

    if (status.local.length === 0) {
      await ctx.reply('ℹ️ No agents running');
      return;
    }

    // Show confirmation with agent list
    const agentList = formatLocalAgents(status.local);
    await ctx.reply(
      `⚠️ Stop all agents?\n\n*Running agents:*\n${agentList}\n\nThis will stop all ${status.local.length} agent(s).`,
      {
        parse_mode: 'Markdown',
        reply_markup: createConfirmationButtons('stopall', 'all'),
      }
    );
  });

  // /logs <name> | /logs -list [role]
  bot.command('logs', async (ctx) => {
    const args = parseArgs(ctx.message.text);

    if (args.length === 0) {
      // No args - show agent selection menu
      const status = await watchdog.getStatus();

      if (status.local.length === 0) {
        await ctx.reply('ℹ️ No agents running');
        return;
      }

      await ctx.reply('📋 *Select agent to view logs:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'logs'),
      });
      return;
    }

    // Handle --list flag: browse archived agents
    if (args[0] === '-list') {
      const roleFilter = args[1]; // optional role filter
      const archived = logArchive.listArchivedAgents(roleFilter ? { role: roleFilter } : undefined);

      if (archived.length === 0) {
        await ctx.reply(roleFilter
          ? `ℹ️ No archived \`${roleFilter}\` agents found`
          : 'ℹ️ No archived agents found',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const lines = archived.slice(0, 20).map(a => {
        const s = a.summary;
        const issue = s.issue ? `#${s.issue}` : '—';
        return `\`${a.name}\` ${s.role} ${issue} ${s.exitStatus} ${s.duration}`;
      });

      await ctx.reply(
        `📋 *Archived agents* (${archived.length} total):\n\n${lines.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // View logs for a specific agent (active or archived — no early bail)
    const name = args[0];
    const logs = agents.getAgentLogs(name, 30);

    if (logs.length > 4000) {
      await ctx.reply(
        `📋 *Logs for ${name}* (truncated):\n\n\`\`\`\n${logs.slice(-4000)}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: createLogsActionButtons(name),
        }
      );
    } else {
      await ctx.reply(`📋 *Logs for ${name}*:\n\n\`\`\`\n${logs}\n\`\`\``, {
        parse_mode: 'Markdown',
        reply_markup: createLogsActionButtons(name),
      });
    }
  });

  // /cleanup [hours] — remove old workspace directories
  bot.command('cleanup', async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const maxAge = args[0] ? parseInt(args[0], 10) : getDaemonConfig().workspaceMaxAgeHours;

    if (args[0] && (isNaN(maxAge) || maxAge < 0)) {
      await ctx.reply('Usage: `/cleanup [hours]`\n\nExamples:\n`/cleanup` — remove workspaces older than default\n`/cleanup 48` — older than 48 hours\n`/cleanup 0` — all non-active workspaces', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const ageLabel = maxAge === 0 ? 'all non-active' : `older than ${maxAge}h`;
    await ctx.reply(
      `⚠️ Clean up workspaces?\n\nThis will remove ${ageLabel} workspace directories that are not associated with a running agent.`,
      {
        parse_mode: 'Markdown',
        reply_markup: createConfirmationButtons('cleanup', String(maxAge)),
      }
    );
  });

  // /tell <name> <message> — send a message to a running agent
  bot.command('tell', async (ctx) => {
    const args = parseArgs(ctx.message.text);

    if (args.length === 0) {
      // No args — show agent picker
      const status = await watchdog.getStatus();
      if (status.local.length === 0) {
        await ctx.reply('No agents running. Boot one first with /boot');
        return;
      }
      await ctx.reply('💬 *Select agent to message:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'tell'),
      });
      return;
    }

    if (args.length < 2) {
      await ctx.reply('Usage: `/tell <agent-name> <message>`', { parse_mode: 'Markdown' });
      return;
    }

    const agentName = args[0];
    const message = args.slice(1).join(' ');

    const agent = registry.getAgent(agentName);
    if (!agent) {
      const status = await watchdog.getStatus();
      const similar = findSimilarAgents(agentName, status.local, 3);
      if (similar.length > 0) {
        await ctx.reply(
          `Agent not found: \`${agentName}\`\n\n*Did you mean:*`,
          {
            parse_mode: 'Markdown',
            reply_markup: createSuggestionButtons(similar, 'tell'),
          }
        );
      } else {
        await ctx.reply(`Agent not found: \`${agentName}\``, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (!agents.isAgentRunning(agentName)) {
      await ctx.reply(`Agent \`${agentName}\` is not running`, { parse_mode: 'Markdown' });
      return;
    }

    // Reset TTL — user is actively communicating with this agent
    registry.touchAgent(agentName);

    const busy = agents.isAgentBusy(agentName);
    const chatId = ctx.chat.id.toString();

    // Improved acknowledgment with queue feedback
    if (busy) {
      const queueInfo = agentComms.getQueueInfo(agentName);
      const position = queueInfo ? queueInfo.position : '?';
      await ctx.reply(
        `📋 Queued (#${position} in line) for \`${agentName}\``,
        { parse_mode: 'Markdown' }
      );
    } else {
      // Start feedback session — typing indicator provides immediate feedback,
      // progress message will be lazy-created at ~30s if agent is still working
      feedbackManager.startFeedback(agentName, chatId);
    }

    // Fire-and-forget — response posted asynchronously
    agents.sendToAgent(agentName, message, (preview) => {
      // Progress callback from agent-comms
      feedbackManager.updateProgress(agentName, preview);
    }).then(async (response) => {
      // Stop feedback session when response received
      feedbackManager.stopFeedback(agentName);
      const messageId = await lifecycle.agentResponse(agentName, response);
      if (messageId) {
        trackAgentMessage(messageId, agentName);
      }
    }).catch(async (error) => {
      feedbackManager.stopFeedback(agentName);
      await ctx.reply(`Failed to communicate with agent: ${formatError(error)}`);
    });
  });

  // /focus <name> - Route all messages to an agent
  bot.command('focus', async (ctx) => {
    const args = parseArgs(ctx.message.text);

    if (args.length === 0) {
      // Show agent picker
      const status = await watchdog.getStatus();
      if (status.local.length === 0) {
        await ctx.reply('No agents running. Boot one first with /boot');
        return;
      }
      await ctx.reply('🎯 *Select agent to focus:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'focus'),
      });
      return;
    }

    const agentName = args[0];
    const agent = registry.getAgent(agentName);
    if (!agent || !agents.isAgentRunning(agentName)) {
      await ctx.reply(`Agent \`${agentName}\` not found or not running`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const chatId = ctx.chat.id.toString();
    setFocusedAgent(chatId, agentName);
    const emoji = ROLE_EMOJI[agent.role] || '🤖';
    await ctx.reply(
      `🎯 *Focused on* ${emoji} \`${agentName}\`\n\nYour messages will be sent to this agent.\nType /unfocus to stop.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /unfocus - Stop focusing on an agent
  bot.command('unfocus', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const was = clearFocusForChat(chatId);

    if (was) {
      await ctx.reply(`🔚 Unfocused from \`${was}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('Not focused on any agent.');
    }
  });


  // /diagnose [verbose] — system freshness diagnosis
  bot.command('diagnose', async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const verbose = args.length > 0 && args[0].toLowerCase() === 'verbose';

    const chatId = ctx.chat.id.toString();
    const sessionId = `diagnose-${Date.now()}`;
    feedbackManager.startFeedback(sessionId, chatId);

    try {
      await ctx.reply('🔍 Running diagnosis...');
      const report = await diagnose.runDiagnosis();
      feedbackManager.stopFeedback(sessionId);
      const message = verbose
        ? formatDiagnosisVerbose(report)
        : formatDiagnosisReport(report);

      // Only show action buttons when there is drift to act on (summary mode)
      const hasStale = report.components.some((c) => c.status === 'stale');
      const replyMarkup = !verbose && hasStale ? createDiagnoseButtons() : undefined;

      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
    } catch (error) {
      feedbackManager.stopFeedback(sessionId);
      await ctx.reply(`❌ Diagnosis failed: ${formatError(error)}`);
    }
  });

  // /refresh — reload orchestrator knowledge and identity
  bot.command('refresh', async (ctx) => {
    const result = orchestrator.refresh();
    await ctx.reply(result);
  });

  // Callback query handlers
  async function handleStopCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target, confirm } = data;

    if (!target) {
      await ctx.answerCbQuery('Invalid callback data');
      return;
    }

    const agent = registry.getAgent(target);

    if (!agent) {
      await ctx.answerCbQuery('Agent not found');
      await ctx.editMessageText(`❌ Agent \`${target}\` no longer exists`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    if (!confirm) {
      // Show confirmation dialog
      const emoji = ROLE_EMOJI[agent.role] || '🤖';
      const issue = agent.issue ? `#${agent.issue}` : 'standby';
      await ctx.editMessageText(
        `⚠️ Stop agent?\n\n${emoji} \`${agent.name}\`\n${issue}\n\nThis will terminate the running agent.`,
        {
          parse_mode: 'Markdown',
          reply_markup: createConfirmationButtons('stop', target),
        }
      );
      await ctx.answerCbQuery();
      return;
    }

    // Confirmed - stop the agent
    await ctx.answerCbQuery('Stopping agent...');
    await ctx.editMessageText(`⏹️ Stopping ${target}...`);

    try {
      await agents.stopAgent(target);
      await ctx.editMessageText(`✅ Agent stopped: \`${target}\``, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      await ctx.editMessageText(`❌ Failed to stop agent: ${formatError(error)}`);
    }
  }

  async function handleStopAllCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { confirm } = data;
    const status = await watchdog.getStatus();

    if (status.local.length === 0) {
      await ctx.answerCbQuery('No agents to stop');
      await ctx.editMessageText('ℹ️ No agents running');
      return;
    }

    if (!confirm) {
      // Show confirmation with agent list
      const agentList = formatLocalAgents(status.local);
      await ctx.editMessageText(
        `⚠️ Stop all agents?\n\n*Running agents:*\n${agentList}\n\nThis will stop all ${status.local.length} agent(s).`,
        {
          parse_mode: 'Markdown',
          reply_markup: createConfirmationButtons('stopall', 'all'),
        }
      );
      await ctx.answerCbQuery();
      return;
    }

    // Confirmed - stop all agents
    await ctx.answerCbQuery('Stopping all agents...');
    await ctx.editMessageText('⏹️ Stopping all agents...');

    try {
      await agents.stopAllAgents();
      await ctx.editMessageText('✅ All agents stopped');
    } catch (error) {
      await ctx.editMessageText(`❌ Failed to stop agents: ${formatError(error)}`);
    }
  }

  async function handleCleanupCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target, confirm } = data;
    const maxAge = target ? parseInt(target, 10) : getDaemonConfig().workspaceMaxAgeHours;

    if (!confirm) {
      const ageLabel = maxAge === 0 ? 'all non-active' : `older than ${maxAge}h`;
      await ctx.editMessageText(
        `⚠️ Clean up workspaces?\n\nThis will remove ${ageLabel} workspace directories that are not associated with a running agent.`,
        {
          parse_mode: 'Markdown',
          reply_markup: createConfirmationButtons('cleanup', String(maxAge)),
        }
      );
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery('Cleaning up...');
    await ctx.editMessageText('🧹 Cleaning up workspaces...');

    try {
      const result = agents.cleanupWorkspaces(maxAge);
      let message = '🧹 *Workspace Cleanup Complete*\n\n';
      message += `Removed: ${result.removed.length}\n`;
      message += `Skipped: ${result.skipped.length}`;

      if (result.removed.length > 0) {
        message += '\n\n*Removed:*\n' + result.removed.map(r => `• \`${r}\``).join('\n');
      }
      if (result.errors.length > 0) {
        message += '\n\n*Errors:*\n' + result.errors.map(e => `• ${e}`).join('\n');
      }

      await ctx.editMessageText(message, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.editMessageText(`❌ Cleanup failed: ${formatError(error)}`);
    }
  }

  async function handleLogsCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target } = data;

    if (!target) {
      await ctx.answerCbQuery('Invalid callback data');
      return;
    }

    // Don't bail on missing registry entry — getAgentLogs handles archive fallback
    const logs = agents.getAgentLogs(target, 30);

    try {
      if (logs.length > 4000) {
        await ctx.editMessageText(
          `📋 *Logs for ${target}* (truncated):\n\n\`\`\`\n${logs.slice(-4000)}\n\`\`\``,
          {
            parse_mode: 'Markdown',
            reply_markup: createLogsActionButtons(target),
          }
        );
      } else {
        await ctx.editMessageText(`📋 *Logs for ${target}*:\n\n\`\`\`\n${logs}\n\`\`\``, {
          parse_mode: 'Markdown',
          reply_markup: createLogsActionButtons(target),
        });
      }
      await ctx.answerCbQuery('Logs refreshed');
    } catch (err: unknown) {
      // Handle case where message content hasn't changed
      if (err instanceof TelegramError && err.response.error_code === 400 && err.response.description?.includes('message is not modified')) {
        await ctx.answerCbQuery('No new logs yet');
      } else {
        await ctx.answerCbQuery('Failed to load logs');
        throw err;
      }
    }
  }

  async function handleBootCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target, confirm } = data;

    if (!target) {
      // No role selected - show role picker
      await ctx.editMessageText('🚀 *Select agent role:*', {
        parse_mode: 'Markdown',
        reply_markup: createRoleSelectionButtons(),
      });
      await ctx.answerCbQuery();
      return;
    }

    const role = target as AgentRole;

    if (!isValidRole(role)) {
      await ctx.answerCbQuery('Invalid role');
      await ctx.editMessageText(
        `❌ Invalid role: ${role}\n\nUse /boot to start over`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!confirm) {
      // Try to show issue suggestions (smart boot)
      const emoji = ROLE_EMOJI[role] || '🤖';
      const issues = await github.getBootableIssues(5);
      if (issues.length > 0) {
        await ctx.editMessageText(
          `${emoji} *${role}* agent\n\nSelect issue or boot without one:`,
          {
            parse_mode: 'Markdown',
            reply_markup: createIssueSelectionButtons(issues, role),
          }
        );
      } else {
        // Fallback to existing flow if no issues available
        await ctx.editMessageText(
          `${emoji} *${role}* agent selected\n\nDo you want to specify an issue number?`,
          {
            parse_mode: 'Markdown',
            reply_markup: createBootContinuationButtons(role),
          }
        );
      }
      await ctx.answerCbQuery();
      return;
    }

    // Boot with issue from extra field (smart boot) or without
    const bootIssue = data.extra ? parseInt(data.extra, 10) : undefined;

    await ctx.answerCbQuery('Booting agent...');
    await ctx.editMessageText(`🚀 Booting ${role} agent${bootIssue ? ` for #${bootIssue}` : ''}...`);

    try {
      // Don't pass repo — let bootAgent() handle label lookup and defaults
      await agents.startAgent({
        role,
        issue: bootIssue || undefined,
        mode: bootIssue ? undefined : 'chat',
      });
      // lifecycle.hello() inside startAgent() sends the confirmation with buttons
    } catch (error) {
      await ctx.editMessageText(`❌ Failed to boot agent: ${formatError(error)}`);
    }
  }

  async function handleBootWaitCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target } = data;

    if (!target) {
      await ctx.answerCbQuery('Invalid callback data');
      return;
    }

    const emoji = ROLE_EMOJI[target as AgentRole] || '🤖';
    await ctx.editMessageText(
      `${emoji} *${target}* agent selected\n\nPlease enter the issue number:\n\`/boot ${target} <issue> [repo]\`\n\nExample: \`/boot ${target} 42\``,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery();
  }

  async function handlePageCallback(ctx: Context, data: ReturnType<typeof decodeCallback>) {
    const { target, page } = data;

    if (target === undefined || page === undefined) {
      await ctx.answerCbQuery('Invalid pagination data');
      return;
    }

    const status = await watchdog.getStatus();

    // Re-render the agent selection with new page
    if (target === 'stop' || target === 'stop_select') {
      if (status.local.length === 0) {
        await ctx.answerCbQuery('No agents to stop');
        await ctx.editMessageText('ℹ️ No agents running');
        return;
      }

      await ctx.editMessageText('⏹️ *Select agent to stop:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'stop', page),
      });
    } else if (target === 'logs' || target === 'logs_select') {
      if (status.local.length === 0) {
        await ctx.answerCbQuery('No agents available');
        await ctx.editMessageText('ℹ️ No agents running');
        return;
      }

      await ctx.editMessageText('📋 *Select agent to view logs:*', {
        parse_mode: 'Markdown',
        reply_markup: createAgentSelectionButtons(status.local, 'logs', page),
      });
    }

    await ctx.answerCbQuery();
  }

  async function handleStatusCallback(ctx: Context) {
    await ctx.answerCbQuery('Refreshing status...');

    const status = await watchdog.getStatus();

    const ccVersion = getLatestClaudeCodeVersion(status.local);
    const manualPaused = autoloop.isManuallyPaused();
    const usagePausedFlag = usageMonitor.isUsagePaused();
    const overrideFlag = usageMonitor.hasOverride();
    let autoloopStatus: string;
    if (manualPaused) {
      autoloopStatus = '⏸️ Paused (manual)';
    } else if (usagePausedFlag && !overrideFlag) {
      autoloopStatus = '⏸️ Paused (usage)';
    } else {
      autoloopStatus = '▶️ Running';
    }

    let message = `*fritZ Status*

*Model:* ${escapeMd(getOrchestratorModel())}`;
    if (ccVersion) message += `\n*Claude Code:* ${escapeMd(ccVersion)}`;
    message += `\n*Autoloop:* ${autoloopStatus}`;

    // Show usage summary if available
    const usageData = usageMonitor.getUsageData();
    if (usageData) {
      const maxUtil = Math.max(
        usageData.fiveHour.utilization,
        usageData.sevenDay.utilization,
        usageData.sevenDayOpus?.utilization ?? 0
      );
      const accountName = usageMonitor.getAccountName();
      const accountLabel = accountName ? ` (${accountName})` : '';
      message += `\n*Usage:* ${maxUtil.toFixed(0)}%${accountLabel} (5h: ${usageData.fiveHour.utilization.toFixed(0)}%, 7d: ${usageData.sevenDay.utilization.toFixed(0)}%)`;
      if (overrideFlag) message += ' ⚠️ override';
    }

    message += `

*Local Agents:* ${status.local.length}
${formatLocalAgents(status.local)}

*GitHub Active:* ${status.github.length}`;

    if (status.github.length > 0) {
      message +=
        '\n' +
        status.github
          .map(
            (g) =>
              `🟢 ${ROLE_EMOJI[g.role] || '🤖'} #${g.issue} - ${escapeMd(g.title.slice(0, 30))}`
          )
          .join('\n');
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: createStatusActionButtons(),
    });
  }

  async function handleStopSelectCallback(ctx: Context) {
    const status = await watchdog.getStatus();

    if (status.local.length === 0) {
      await ctx.answerCbQuery('No agents to stop');
      await ctx.editMessageText('ℹ️ No agents running');
      return;
    }

    await ctx.editMessageText('⏹️ *Select agent to stop:*', {
      parse_mode: 'Markdown',
      reply_markup: createAgentSelectionButtons(status.local, 'stop'),
    });
    await ctx.answerCbQuery();
  }

  async function handleLogsSelectCallback(ctx: Context) {
    const status = await watchdog.getStatus();

    if (status.local.length === 0) {
      await ctx.answerCbQuery('No agents available');
      await ctx.editMessageText('ℹ️ No agents running');
      return;
    }

    await ctx.editMessageText('📋 *Select agent to view logs:*', {
      parse_mode: 'Markdown',
      reply_markup: createAgentSelectionButtons(status.local, 'logs'),
    });
    await ctx.answerCbQuery();
  }

  // Handle callback queries from inline buttons
  bot.on('callback_query', async (ctx) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

    const data = decodeCallback(ctx.callbackQuery.data);

    try {
      switch (data.action) {
        case 'stop':
          await handleStopCallback(ctx, data);
          break;
        case 'stopall':
          await handleStopAllCallback(ctx, data);
          break;
        case 'cleanup':
          await handleCleanupCallback(ctx, data);
          break;
        case 'logs':
          await handleLogsCallback(ctx, data);
          break;
        case 'boot':
          await handleBootCallback(ctx, data);
          break;
        case 'boot_wait':
          await handleBootWaitCallback(ctx, data);
          break;
        case 'page':
          await handlePageCallback(ctx, data);
          break;
        case 'status':
          await handleStatusCallback(ctx);
          break;
        case 'stop_select':
          await handleStopSelectCallback(ctx);
          break;
        case 'logs_select':
          await handleLogsSelectCallback(ctx);
          break;
        case 'reply': {
          // Reply sets focus on the agent (same as Focus button)
          // Previously used ForceReply which opened an unwanted input field popup
          const replyAgentName = data.target;
          if (!replyAgentName) break;

          const replyAgent = registry.getAgent(replyAgentName);
          if (!replyAgent || !agents.isAgentRunning(replyAgentName)) {
            await ctx.answerCbQuery('Agent not running');
            break;
          }

          const replyChatId = ctx.chat?.id?.toString();
          if (replyChatId) {
            setFocusedAgent(replyChatId, replyAgentName);
          }
          const replyEmoji = ROLE_EMOJI[replyAgent.role] || '🤖';
          await ctx.editMessageText(
            `🎯 *Focused on* ${replyEmoji} \`${replyAgentName}\`\n\nYour messages will be sent to this agent.\nType /unfocus to stop.`,
            { parse_mode: 'Markdown' }
          );
          await ctx.answerCbQuery();
          break;
        }
        case 'tell':
          // Legacy: Prompt user to type a /tell command for this agent
          if (data.target) {
            await ctx.editMessageText(
              `💬 Send a message to \`${data.target}\`:\n\n\`/tell ${data.target} <your message>\``,
              { parse_mode: 'Markdown' }
            );
          }
          await ctx.answerCbQuery();
          break;
        case 'focus': {
          // Focus mode: route all messages to selected agent
          const focusAgentName = data.target;
          if (!focusAgentName) break;

          const focusAgent = registry.getAgent(focusAgentName);
          if (!focusAgent || !agents.isAgentRunning(focusAgentName)) {
            await ctx.answerCbQuery('Agent not running');
            break;
          }

          const focusChatId = ctx.chat?.id?.toString();
          if (focusChatId) {
            setFocusedAgent(focusChatId, focusAgentName);
          }
          const focusEmoji = ROLE_EMOJI[focusAgent.role] || '🤖';
          await ctx.editMessageText(
            `🎯 *Focused on* ${focusEmoji} \`${focusAgentName}\`\n\nYour messages will be sent to this agent.\nType /unfocus to stop.`,
            { parse_mode: 'Markdown' }
          );
          await ctx.answerCbQuery();
          break;
        }
        case 'answer': {
          // Answer to an /api/ask question
          const questionId = data.target;
          const optionIdx = data.extra !== undefined ? parseInt(data.extra, 10) : -1;
          if (!questionId || optionIdx < 0) {
            await ctx.answerCbQuery('Invalid answer data');
            break;
          }
          // Look up option text from the pending questions store (reliable)
          const options = getQuestionOptions(questionId);
          const chosenText = options?.[optionIdx] ?? `Option ${optionIdx}`;
          const resolved = resolveQuestion(questionId, chosenText);
          if (resolved) {
            const cbQuery = ctx.callbackQuery as CallbackQuery.DataQuery;
            const cbMessage = cbQuery.message;
            const originalText = cbMessage && 'text' in cbMessage ? cbMessage.text : '';
            await ctx.editMessageText(
              originalText + `\n\n✅ *Answer:* ${chosenText}`,
              { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery(`Answered: ${chosenText}`);
          } else {
            await ctx.answerCbQuery('Question already answered or expired');
          }
          break;
        }
        case 'diagnose_detail': {
          await ctx.answerCbQuery('Loading details...');
          try {
            const detailReport = await diagnose.runDiagnosis();
            const detailMessage = formatDiagnosisVerbose(detailReport);
            await ctx.editMessageText(detailMessage, { parse_mode: 'Markdown' });
          } catch (error) {
            await ctx.editMessageText(`❌ Diagnosis failed: ${formatError(error)}`);
          }
          break;
        }
        case 'redeploy': {
          if (!data.confirm) {
            await ctx.editMessageText(
              '⚠️ *Redeploy fritZ?*\n\nThis will trigger the build-and-deploy workflow on GitHub Actions.',
              {
                parse_mode: 'Markdown',
                reply_markup: createRedeployConfirmButtons(),
              }
            );
            await ctx.answerCbQuery();
            break;
          }

          await ctx.answerCbQuery('Triggering redeploy...');
          await ctx.editMessageText('🔄 Triggering redeploy...');

          try {
            const { execSync } = await import('child_process');
            const repo = config.githubRepo;
            if (!repo) {
              await ctx.editMessageText('❌ Cannot redeploy — GITHUB_REPO not configured');
              break;
            }
            const deployWorkflow = getDaemonConfig().deployWorkflow;
            execSync(
              `gh workflow run ${deployWorkflow} --repo ${repo}`,
              { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            await ctx.editMessageText('✅ Redeploy triggered. Check GitHub Actions for progress.');
          } catch (error) {
            await ctx.editMessageText(`❌ Redeploy failed: ${formatError(error)}`);
          }
          break;
        }
        case 'cancel':
          await ctx.editMessageText('❌ Cancelled');
          await ctx.answerCbQuery();
          break;
        case 'noop':
          await ctx.answerCbQuery();
          break;
        default:
          await ctx.answerCbQuery(`Unknown action: ${data.action}`);
      }
    } catch (error) {
      console.error('Callback query error:', error);
      await ctx.answerCbQuery(`Error: ${formatError(error)}`);
    }
  });

  // Handle messages starting with "fritz" + reply-to-agent routing
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // Skip commands (already handled above)
    if (text.startsWith('/')) return;

    // Check if this is a reply to an agent or orchestrator message
    const replyTo = ctx.message.reply_to_message;
    if (replyTo && 'message_id' in replyTo) {
      const targetName = getAgentForMessage(replyTo.message_id);
      if (targetName) {
        // Check if reply is to Fritz/orchestrator
        if (targetName === ORCHESTRATOR_ID) {
          const replyChatId = ctx.chat.id.toString();
          const sessionId = `orchestrator-reply-${Date.now()}`;
          feedbackManager.startFeedback(sessionId, replyChatId);
          try {
            const response = await orchestrator.send(text);
            feedbackManager.stopFeedback(sessionId);
            const msgId = await sendMessage(
              response || '(no response)',
              createOrchestratorMetadata()
            );
            if (msgId) trackAgentMessage(msgId, ORCHESTRATOR_ID);
          } catch (error) {
            feedbackManager.stopFeedback(sessionId);
            const msgId = await sendMessage(
              `❌ ${formatError(error)}`,
              createOrchestratorMetadata()
            );
            if (msgId) trackAgentMessage(msgId, ORCHESTRATOR_ID);
          }
          return; // Handled as orchestrator reply
        }

        // Reply to agent message
        const agent = registry.getAgent(targetName);
        if (agent && agents.isAgentRunning(targetName)) {
          // Reset TTL — user is actively communicating with this agent
          registry.touchAgent(targetName);

          const busy = agents.isAgentBusy(targetName);
          const replyChatId = ctx.chat.id.toString();

          // Improved acknowledgment with queue feedback
          if (busy) {
            const queueInfo = agentComms.getQueueInfo(targetName);
            const position = queueInfo ? queueInfo.position : '?';
            await ctx.reply(
              `📋 Queued (#${position} in line) for \`${targetName}\``,
              { parse_mode: 'Markdown' }
            );
          } else {
            // Start feedback session — typing indicator provides immediate feedback,
            // progress message will be lazy-created at ~30s if agent is still working
            feedbackManager.startFeedback(targetName, replyChatId);
          }

          // Fire-and-forget — response posted asynchronously
          agents.sendToAgent(targetName, text, (preview) => {
            feedbackManager.updateProgress(targetName, preview);
          }).then(async (response) => {
            feedbackManager.stopFeedback(targetName);
            const messageId = await lifecycle.agentResponse(targetName, response);
            if (messageId) {
              trackAgentMessage(messageId, targetName);
            }
          }).catch(async (error) => {
            feedbackManager.stopFeedback(targetName);
            await ctx.reply(`Failed to send to ${targetName}: ${formatError(error)}`);
          });
          return; // Don't pass to orchestrator
        }
      }
    }

    // Focus mode routing — messages go to focused agent
    const chatId = ctx.chat.id.toString();
    const focused = getFocusedAgent(chatId);
    if (focused && !text.toLowerCase().startsWith('fritz')) {
      const focusAgent = registry.getAgent(focused);
      if (focusAgent && agents.isAgentRunning(focused)) {
        const busy = agents.isAgentBusy(focused);

        // Improved acknowledgment with queue feedback
        if (busy) {
          const queueInfo = agentComms.getQueueInfo(focused);
          const position = queueInfo ? queueInfo.position : '?';
          await ctx.reply(
            `📋 Queued (#${position}) for \`${focused}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          // Start feedback session — typing indicator provides immediate feedback,
          // progress message will be lazy-created at ~30s if agent is still working
          feedbackManager.startFeedback(focused, chatId);
        }

        agents.sendToAgent(focused, text, (preview) => {
          feedbackManager.updateProgress(focused, preview);
        }).then(async (response) => {
          feedbackManager.stopFeedback(focused);
          const messageId = await lifecycle.agentResponse(focused, response);
          if (messageId) trackAgentMessage(messageId, focused);
        }).catch(async (error) => {
          feedbackManager.stopFeedback(focused);
          await ctx.reply(`Failed: ${formatError(error)}`);
        });
        return;
      } else {
        // Agent no longer running — auto-clear focus
        clearFocusForChat(chatId);
        await ctx.reply(
          `🔚 \`${focused}\` is no longer running. Focus cleared.`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Check for "fritz" prefix (case insensitive)
    const lowerText = text.toLowerCase();
    if (!lowerText.startsWith('fritz')) return;

    // Extract the message after "fritz"
    const message = text.slice(5).trim();

    if (!message) {
      const msgId = await sendMessage(
        '🤖 Yes? Try: "fritz status" or use /help',
        createOrchestratorMetadata()
      );
      if (msgId) trackAgentMessage(msgId, ORCHESTRATOR_ID);
      return;
    }

    // Handle "fritz auto-pipeline" as built-in command
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.startsWith('auto-pipeline') || lowerMessage.startsWith('autopipeline')) {
      const pipelineArgs = message.split(/\s+/).slice(1);

      if (pipelineArgs.length === 0) {
        await ctx.reply(
          `🔄 *Auto-Pipeline*\n\nUsage:\n\`fritz auto-pipeline #123\` — Enable for issue\n\`fritz auto-pipeline #123 #124\` — Enable for multiple\n\`fritz auto-pipeline off #123\` — Disable for issue`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const isOff = pipelineArgs[0].toLowerCase() === 'off';
      const issueArgs = isOff ? pipelineArgs.slice(1) : pipelineArgs;

      // Parse issue numbers (strip # prefix)
      const issueNumbers = issueArgs
        .map(a => parseInt(a.replace('#', ''), 10))
        .filter(n => !isNaN(n));

      if (issueNumbers.length === 0) {
        await ctx.reply('No valid issue numbers provided.\n\nExample: `fritz auto-pipeline #123`', {
          parse_mode: 'Markdown',
        });
        return;
      }

      const results: string[] = [];
      for (const issueNum of issueNumbers) {
        try {
          await github.setAutoPipeline(issueNum, !isOff);
          const action = isOff ? 'Disabled' : 'Enabled';
          results.push(`#${issueNum}: ${action}`);
        } catch (error: unknown) {
          results.push(`#${issueNum}: Failed — ${formatError(error)}`);
        }
      }

      const action = isOff ? 'disabled' : 'enabled';
      await ctx.reply(
        `🔄 *Auto-Pipeline ${action}*\n\n${results.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Handle "fritz diagnose" and "fritz diag" as built-in commands
    if (lowerMessage === 'diagnose' || lowerMessage === 'diag' || lowerMessage.startsWith('diagnose ') || lowerMessage.startsWith('diag ')) {
      const diagArgs = message.split(/\s+/).slice(1);
      const verbose = diagArgs.length > 0 && diagArgs[0].toLowerCase() === 'verbose';

      const diagChatId = ctx.chat.id.toString();
      const diagSessionId = `diagnose-${Date.now()}`;
      feedbackManager.startFeedback(diagSessionId, diagChatId);
      try {
        await ctx.reply('🔍 Running diagnosis...');
        const report = await diagnose.runDiagnosis();
        feedbackManager.stopFeedback(diagSessionId);
        const diagMsg = verbose
          ? formatDiagnosisVerbose(report)
          : formatDiagnosisReport(report);
        const hasStale = report.components.some((c) => c.status === 'stale');
        await ctx.reply(diagMsg, {
          parse_mode: 'Markdown',
          reply_markup: !verbose && hasStale ? createDiagnoseButtons() : undefined,
        });
      } catch (error) {
        feedbackManager.stopFeedback(diagSessionId);
        await ctx.reply(`❌ Diagnosis failed: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz refresh" — reload orchestrator knowledge
    if (lowerMessage === 'refresh') {
      const result = orchestrator.refresh();
      await ctx.reply(result);
      return;
    }

    // Handle "fritz pause" — pause the autoloop
    if (lowerMessage === 'pause') {
      autoloop.pause();
      await ctx.reply('⏸️ Autoloop *paused*. Agents will not be spawned until resumed.\n\nResume with: `fritz resume`', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Handle "fritz resume" — resume the autoloop
    if (lowerMessage === 'resume') {
      autoloop.resume();
      await ctx.reply('▶️ Autoloop *resumed*. Agent spawning is active again.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Handle "fritz retro" — boot retro agent with sub-command
    if (lowerMessage === 'retro' || lowerMessage.startsWith('retro ')) {
      const retroArgs = message.split(/\s+/).slice(1); // everything after "retro"

      if (retroArgs.length === 0) {
        await ctx.reply(
          `🔄 *Retro Agent*\n\n` +
          `Usage:\n` +
          `\`fritz retro scan\` — Scan agent logs, propose improvements\n` +
          `\`fritz retro scan --since=YYYY-MM-DD\` — Scan from date\n` +
          `\`fritz retro report\` — Full retrospective (logs + GitHub data)\n` +
          `\`fritz retro analyze\` — Analysis only (no PRs)\n` +
          `\`fritz retro metrics\` — Show metrics dashboard\n` +
          `\`fritz retro investigate <issue>\` — Deep-dive into a specific issue\n` +
          `\`fritz retro experiment [name]\` — Start new experiment`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Validate "investigate" requires an issue number
      if (retroArgs[0]?.toLowerCase() === 'investigate') {
        const issueNum = retroArgs[1];
        if (!issueNum || !/^\d+$/.test(issueNum) || parseInt(issueNum, 10) < 1) {
          await ctx.reply(
            `🔍 *Retro Investigate*\n\n` +
            `Usage: \`fritz retro investigate <issue-number>\`\n\n` +
            `Deep-dives into a specific issue — analyzes all agent runs, logs, rework causes, and failure patterns.\n\n` +
            `Example: \`fritz retro investigate 357\``,
            { parse_mode: 'Markdown' }
          );
          return;
        }
      }

      // Check if a retro agent is already running
      const activeAgents = registry.listAgents();
      const existingRetro = activeAgents.find(a => a.role === 'retro');
      if (existingRetro) {
        await ctx.reply(
          `⚠️ Retro agent already running: \`${existingRetro.name}\`\n\nStop it first with \`/stop ${existingRetro.name}\` or wait for it to finish.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const subCommand = retroArgs.join(' ');
      await ctx.reply(`🔄 Booting retro agent: \`${subCommand}\`...`, { parse_mode: 'Markdown' });

      try {
        await agents.startAgent({
          role: 'retro',
          mode: 'auto',
          retroCommand: subCommand,
        });
      } catch (error) {
        await ctx.reply(`❌ Failed to boot retro agent: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz usage" — show current usage stats
    if (lowerMessage === 'usage' || lowerMessage === 'budget') {
      const data = usageMonitor.getUsageData();
      const usageCfg = getUsageConfig();
      const usagePausedNow = usageMonitor.isUsagePaused();
      const override = usageMonitor.hasOverride();
      const running = usageMonitor.isRunning();
      const lastCheck = usageMonitor.getLastCheckTime();

      if (!running && !data) {
        await ctx.reply(
          `📊 *Usage Monitor*\n\nStatus: ⏹️ Not running\n` +
          (usageCfg.enabled
            ? `No OAuth token available — set CLAUDE\_CODE\_OAUTH\_TOKEN`
            : `Disabled in fritz.yaml (usage.enabled: false)`),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let msg = `📊 *Usage Monitor*\n\n`;

      if (data) {
        msg += `*5-hour:* ${data.fiveHour.utilization.toFixed(1)}%`;
        if (data.fiveHour.resetsAt) {
          const resetIn = Math.max(0, Math.floor((new Date(data.fiveHour.resetsAt).getTime() - Date.now()) / 60000));
          msg += ` (resets in ${resetIn}m)`;
        }
        msg += `\n*7-day:* ${data.sevenDay.utilization.toFixed(1)}%`;
        if (data.sevenDay.resetsAt) {
          const resetIn = Math.max(0, Math.floor((new Date(data.sevenDay.resetsAt).getTime() - Date.now()) / 3600000));
          msg += ` (resets in ${resetIn}h)`;
        }
        if (data.sevenDayOpus) {
          msg += `\n*7-day Opus:* ${data.sevenDayOpus.utilization.toFixed(1)}%`;
        }
      } else {
        msg += `_No data yet (first check pending)_\n`;
      }

      msg += `\n\n*Autoloop:* ${usagePausedNow ? '⏸️ Usage-paused' : '▶️ Active'}`;
      if (override) msg += ` (override)`;
      msg += `\n*Threshold:* pause at ${usageCfg.pauseThreshold}%, resume at ${usageCfg.resumeThreshold}%`;
      msg += `\n*P0 bypass:* ${usageCfg.allowP0 ? 'yes' : 'no'}`;
      if (lastCheck) {
        const ago = Math.floor((Date.now() - new Date(lastCheck).getTime()) / 1000);
        msg += `\n*Last check:* ${ago}s ago`;
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }

    // Handle "fritz override" — toggle usage override
    if (lowerMessage === 'override' || lowerMessage === 'override on') {
      usageMonitor.setOverride(true);
      await ctx.reply(
        '🔓 *Usage override enabled* — usage limits ignored.\n' +
        'Agents will spawn regardless of API usage.\n\n' +
        'Disable with: `fritz override off`',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if (lowerMessage === 'override off') {
      usageMonitor.setOverride(false);
      await ctx.reply(
        '🔒 *Usage override disabled* — usage limits re-engaged.\n' +
        'An immediate check will run to determine pause state.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Handle "fritz mode [essential|quiet|compact|verbose]" — notification mode toggle
    if (lowerMessage === 'mode' || lowerMessage.startsWith('mode ')) {
      const modeArgs = message.split(/\s+/).slice(1);

      if (modeArgs.length === 0) {
        const current = getNotificationMode();
        const modeList = (Object.entries(MODE_DESCRIPTIONS) as [NotificationMode, { emoji: string; description: string }][])
          .map(([mode, { description }]) => `• \`${mode}\` — ${description}`)
          .join('\n');
        await ctx.reply(
          `🔔 *Notification Mode:* \`${current}\`\n\n` +
          `Available modes:\n${modeList}\n\n` +
          `Use \`fritz mode <mode>\` to switch`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const requestedMode = modeArgs[0].toLowerCase();
      if (!isValidNotificationMode(requestedMode)) {
        await ctx.reply(
          `❌ Invalid mode: \`${requestedMode}\`\n\n` +
          `Valid modes: \`essential\`, \`quiet\`, \`compact\`, \`verbose\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      setNotificationMode(requestedMode);
      const modeEmoji = MODE_DESCRIPTIONS[requestedMode].emoji;
      await ctx.reply(
        `${modeEmoji} Notification mode set to *${requestedMode}*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Handle "fritz queue" / "fritz pipeline" — show pipeline queue
    if (lowerMessage === 'queue' || lowerMessage === 'pipeline') {
      try {
        const queue = fetchPipelineQueue();
        if (queue.length === 0) {
          await ctx.reply('📋 Pipeline is empty — no active issues.', { parse_mode: 'Markdown' });
          return;
        }
        const lines = queue.map(issue => {
          let prefix = '   ';
          if (issue.express) prefix = '⚡';
          else if (issue.manual) prefix = '🔒';
          else if (issue.blockedBy) prefix = '⛓';
          const blocked = issue.blockedBy ? ` ← #${issue.blockedBy}` : '';
          const repoLabel = `[${issue.repo.split('/').pop() ?? issue.repo}]`;
          return `${prefix} #${issue.number} [${issue.status}] ${repoLabel}${blocked} — ${issue.title}`;
        });
        await ctx.reply(
          `📋 *Pipeline (${queue.length}):*\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        await ctx.reply(`❌ Failed to fetch pipeline queue: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz express #N" — add priority:p0 to issue
    if (lowerMessage.startsWith('express ')) {
      const match = message.match(/fritz\s+express\s+#(\d+)/i) || message.match(/^express\s+#(\d+)/i);
      const issueNum = match ? parseInt(match[1], 10) : NaN;
      if (isNaN(issueNum)) {
        await ctx.reply('Usage: `fritz express #N`', { parse_mode: 'Markdown' });
        return;
      }
      try {
        github.gh(`issue edit ${issueNum} --add-label "priority:p0" --repo ${config.githubRepo}`);
        logEvent('pipeline.express', `Issue #${issueNum} marked express via Telegram`, { issue: issueNum });
        await ctx.reply(`⚡ Issue #${issueNum} marked *express* (priority:p0).`, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply(`❌ Failed to express #${issueNum}: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz hold #N" — add fritz.manual to issue
    if (lowerMessage.startsWith('hold ')) {
      const match = message.match(/fritz\s+hold\s+#(\d+)/i) || message.match(/^hold\s+#(\d+)/i);
      const issueNum = match ? parseInt(match[1], 10) : NaN;
      if (isNaN(issueNum)) {
        await ctx.reply('Usage: `fritz hold #N`', { parse_mode: 'Markdown' });
        return;
      }
      try {
        github.gh(`issue edit ${issueNum} --add-label "fritz.manual" --repo ${config.githubRepo}`);
        logEvent('pipeline.hold', `Issue #${issueNum} placed on manual hold via Telegram`, { issue: issueNum });
        await ctx.reply(`🔒 Issue #${issueNum} placed on *manual hold* (fritz.manual).`, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply(`❌ Failed to hold #${issueNum}: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz release #N" — remove fritz.manual from issue
    if (lowerMessage.startsWith('release ')) {
      const match = message.match(/fritz\s+release\s+#(\d+)/i) || message.match(/^release\s+#(\d+)/i);
      const issueNum = match ? parseInt(match[1], 10) : NaN;
      if (isNaN(issueNum)) {
        await ctx.reply('Usage: `fritz release #N`', { parse_mode: 'Markdown' });
        return;
      }
      try {
        github.gh(`issue edit ${issueNum} --remove-label "fritz.manual" --repo ${config.githubRepo}`);
        logEvent('pipeline.release', `Issue #${issueNum} released from manual hold via Telegram`, { issue: issueNum });
        await ctx.reply(`🔓 Issue #${issueNum} *released* from manual hold.`, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply(`❌ Failed to release #${issueNum}: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz unblock #N" — remove all fritz.depends-on:* labels from issue
    if (lowerMessage.startsWith('unblock ')) {
      const match = message.match(/fritz\s+unblock\s+#(\d+)/i) || message.match(/^unblock\s+#(\d+)/i);
      const issueNum = match ? parseInt(match[1], 10) : NaN;
      if (isNaN(issueNum)) {
        await ctx.reply('Usage: `fritz unblock #N`', { parse_mode: 'Markdown' });
        return;
      }
      try {
        const repo = config.githubRepo;
        const labelsRaw = github.gh(`issue view ${issueNum} --json labels --jq '.labels[].name' --repo ${repo}`);
        const dependsLabels = labelsRaw.split('\n').filter((l: string) => l.startsWith(github.DEPENDS_ON_PREFIX));
        if (dependsLabels.length === 0) {
          await ctx.reply(`ℹ️ Issue #${issueNum} has no \`fritz.depends-on\` labels.`, { parse_mode: 'Markdown' });
          return;
        }
        github.gh(`issue edit ${issueNum} --remove-label "${dependsLabels.join(',')}" --repo ${repo}`);
        logEvent('pipeline.unblock', `Issue #${issueNum} unblocked via Telegram (removed: ${dependsLabels.join(', ')})`, { issue: issueNum });
        await ctx.reply(`🔗 Issue #${issueNum} *unblocked* — removed: \`${dependsLabels.join(', ')}\``, { parse_mode: 'Markdown' });
      } catch (error) {
        await ctx.reply(`❌ Failed to unblock #${issueNum}: ${formatError(error)}`);
      }
      return;
    }

    // Handle "fritz schedule" — scheduler management commands
    if (lowerMessage === 'schedule' || lowerMessage.startsWith('schedule ')) {
      const scheduleArgs = message.split(/\s+/).slice(1);
      const subCmd = scheduleArgs[0]?.toLowerCase();

      if (!subCmd || subCmd === 'list') {
        // List all jobs
        const jobs = scheduler.getJobs();
        if (jobs.length === 0) {
          await ctx.reply(
            `📅 *Scheduler*\n\nNo jobs configured.\nAdd jobs in \`fritz.yaml\` under the \`scheduler\` section.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          const lines = jobs.map(j => {
            const status = j.enabled ? '▶️' : '⏸️';
            const nextRunDate = new Date(j.nextRun);
            const nextRun = j.enabled
              ? formatFutureTime(nextRunDate)
              : 'disabled';
            const lastInfo = j.lastRun
              ? `last: ${formatTimeAgo(j.lastRun)}${j.lastIssue ? ` #${j.lastIssue}` : ''}`
              : 'never run';
            return `${status} \`${j.id}\` — ${j.role} (${j.frequency})\n   next: ${nextRun} • ${lastInfo}`;
          });
          await ctx.reply(
            `📅 *Scheduler* (${scheduler.isRunning() ? 'running' : 'stopped'})\n\n${lines.join('\n\n')}`,
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      if (subCmd === 'trigger') {
        const jobId = scheduleArgs[1];
        if (!jobId) {
          await ctx.reply('Usage: `fritz schedule trigger <job-id>`', { parse_mode: 'Markdown' });
          return;
        }
        const result = await scheduler.triggerJob(jobId);
        if (result.success) {
          await ctx.reply(
            `📅 Triggered job \`${jobId}\` — created issue #${result.issueNumber}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(`❌ ${result.reason}`, { parse_mode: 'Markdown' });
        }
        return;
      }

      if (subCmd === 'enable') {
        const jobId = scheduleArgs[1];
        if (!jobId) {
          await ctx.reply('Usage: `fritz schedule enable <job-id>`', { parse_mode: 'Markdown' });
          return;
        }
        if (scheduler.enableJob(jobId)) {
          await ctx.reply(`📅 Job \`${jobId}\` *enabled*`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`❌ Job \`${jobId}\` not found in scheduler config`, { parse_mode: 'Markdown' });
        }
        return;
      }

      if (subCmd === 'disable') {
        const jobId = scheduleArgs[1];
        if (!jobId) {
          await ctx.reply('Usage: `fritz schedule disable <job-id>`', { parse_mode: 'Markdown' });
          return;
        }
        if (scheduler.disableJob(jobId)) {
          await ctx.reply(`📅 Job \`${jobId}\` *disabled*`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`❌ Job \`${jobId}\` not found in scheduler config`, { parse_mode: 'Markdown' });
        }
        return;
      }

      // Unknown sub-command — show help
      await ctx.reply(
        `📅 *Scheduler Commands*\n\n` +
        `\`fritz schedule\` — List all jobs\n` +
        `\`fritz schedule trigger <id>\` — Run job now\n` +
        `\`fritz schedule enable <id>\` — Enable a job\n` +
        `\`fritz schedule disable <id>\` — Disable a job`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const fritzChatId = ctx.chat.id.toString();
    const fritzSessionId = `fritz-${Date.now()}`;
    feedbackManager.startFeedback(fritzSessionId, fritzChatId);

    // Route all messages to orchestrator with rich metadata
    try {
      const response = await orchestrator.send(message);
      feedbackManager.stopFeedback(fritzSessionId);
      const msgId = await sendMessage(
        response || '(no response)',
        createOrchestratorMetadata()
      );
      if (msgId) trackAgentMessage(msgId, ORCHESTRATOR_ID);
    } catch (error) {
      feedbackManager.stopFeedback(fritzSessionId);
      const msgId = await sendMessage(
        `❌ ${formatError(error)}`,
        createOrchestratorMetadata()
      );
      if (msgId) trackAgentMessage(msgId, ORCHESTRATOR_ID);
    }
  });

  // Handle errors
  bot.catch((err) => {
    console.error('Telegram bot error:', err);
  });

  return bot;
}

// Start bot
export async function start(): Promise<void> {
  if (!bot) {
    createBot();
  }

  // Launch returns immediately for long-polling, but we don't await
  // because sendMessage would block until first poll completes
  bot!.launch();

  // Small delay to ensure bot is ready
  await new Promise(resolve => setTimeout(resolve, 500));

  // Notify startup
  sendMessage(`🤖 *fritZ* is online\nModel: ${escapeMd(getOrchestratorModel())}`);
}

// Stop bot
export function stop(): void {
  if (bot) {
    bot.stop();
    console.log('🤖 Telegram bot stopped');
  }
}
