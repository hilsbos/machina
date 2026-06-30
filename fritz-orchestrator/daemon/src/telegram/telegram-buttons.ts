/**
 * Telegram button infrastructure
 * Handles inline keyboard buttons and callback data encoding
 */

import type { InlineKeyboardMarkup, InlineKeyboardButton } from 'telegraf/types';
import type { LocalAgent } from '../core/registry.js';
import { ROLE_EMOJI, type AgentRole } from '../types.js';

// Callback data structure (must fit in 64 bytes)
export interface CallbackData {
  action: string;       // 'stop', 'logs', 'boot', 'stopall', 'page', 'cancel'
  target?: string;      // Agent name or role
  page?: number;        // For pagination
  confirm?: boolean;    // Confirmation state
  extra?: string;       // Extra data (issue, repo, etc.)
}

// Encode callback data to compact string format
// Format: action:target:page:confirm:extra
// Example: "stop:impl-42:0:1" = stop impl-42, page 0, confirmed
export function encodeCallback(data: CallbackData): string {
  const parts: string[] = [data.action];

  if (data.target !== undefined) {
    parts.push(data.target);
  }

  if (data.page !== undefined) {
    parts.push(String(data.page));
  } else if (data.confirm !== undefined || data.extra !== undefined) {
    parts.push('');
  }

  if (data.confirm !== undefined) {
    parts.push(data.confirm ? '1' : '0');
  } else if (data.extra !== undefined) {
    parts.push('');
  }

  if (data.extra !== undefined) {
    parts.push(data.extra);
  }

  const encoded = parts.join(':');

  // Ensure we don't exceed Telegram's 64-byte limit
  if (encoded.length > 64) {
    throw new Error(`Callback data too long: ${encoded.length} bytes`);
  }

  return encoded;
}

// Decode callback data from string
export function decodeCallback(data: string): CallbackData {
  const parts = data.split(':');
  const result: CallbackData = {
    action: parts[0],
  };

  if (parts[1] !== undefined && parts[1] !== '') {
    result.target = parts[1];
  }

  if (parts[2] !== undefined && parts[2] !== '') {
    result.page = parseInt(parts[2], 10);
  }

  if (parts[3] !== undefined && parts[3] !== '') {
    result.confirm = parts[3] === '1';
  }

  if (parts[4] !== undefined && parts[4] !== '') {
    result.extra = parts[4];
  }

  return result;
}

// Create confirmation buttons (Yes/Cancel)
export function createConfirmationButtons(
  action: string,
  target: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Yes',
          callback_data: encodeCallback({ action, target, confirm: true }),
        },
        {
          text: '❌ Cancel',
          callback_data: encodeCallback({ action: 'cancel' }),
        },
      ],
    ],
  };
}

// Create agent selection buttons (2 per row, paginated)
export function createAgentSelectionButtons(
  agents: LocalAgent[],
  action: string,
  page: number = 0,
  itemsPerPage: number = 5
): InlineKeyboardMarkup {
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  const pageAgents = agents.slice(start, end);
  const totalPages = Math.ceil(agents.length / itemsPerPage);

  const buttons: InlineKeyboardButton[][] = [];

  // Agent buttons (2 per row)
  for (let i = 0; i < pageAgents.length; i += 2) {
    const row: InlineKeyboardButton[] = [];

    const agent1 = pageAgents[i];
    const emoji1 = ROLE_EMOJI[agent1.role] || '🤖';
    const issue1 = agent1.issue ? `#${agent1.issue}` : '';
    const label1 = truncateButtonText(`${emoji1} ${agent1.name} ${issue1}`, 30);

    row.push({
      text: label1,
      callback_data: encodeCallback({ action, target: agent1.name }),
    });

    if (i + 1 < pageAgents.length) {
      const agent2 = pageAgents[i + 1];
      const emoji2 = ROLE_EMOJI[agent2.role] || '🤖';
      const issue2 = agent2.issue ? `#${agent2.issue}` : '';
      const label2 = truncateButtonText(`${emoji2} ${agent2.name} ${issue2}`, 30);

      row.push({
        text: label2,
        callback_data: encodeCallback({ action, target: agent2.name }),
      });
    }

    buttons.push(row);
  }

  // Pagination buttons (if needed)
  if (totalPages > 1) {
    const paginationRow: InlineKeyboardButton[] = [];

    if (page > 0) {
      paginationRow.push({
        text: '◀️ Previous',
        callback_data: encodeCallback({ action: 'page', target: action, page: page - 1 }),
      });
    }

    paginationRow.push({
      text: `${page + 1}/${totalPages}`,
      callback_data: encodeCallback({ action: 'noop' }),
    });

    if (page < totalPages - 1) {
      paginationRow.push({
        text: 'Next ▶️',
        callback_data: encodeCallback({ action: 'page', target: action, page: page + 1 }),
      });
    }

    buttons.push(paginationRow);
  }

  // Cancel button
  buttons.push([
    {
      text: '❌ Cancel',
      callback_data: encodeCallback({ action: 'cancel' }),
    },
  ]);

  return { inline_keyboard: buttons };
}

// Create role selection buttons
export function createRoleSelectionButtons(): InlineKeyboardMarkup {
  const roles: AgentRole[] = [
    'implement',
    'review',
    'validate',
    'define',
    'architect',
    'ux',
    'budget',
    'retro',
    'security-review',
    'pentest',
  ];

  const buttons: InlineKeyboardButton[][] = [];

  // 2 roles per row
  for (let i = 0; i < roles.length; i += 2) {
    const row: InlineKeyboardButton[] = [];

    const role1 = roles[i];
    const emoji1 = ROLE_EMOJI[role1] || '🤖';
    row.push({
      text: `${emoji1} ${role1}`,
      callback_data: encodeCallback({ action: 'boot', target: role1 }),
    });

    if (i + 1 < roles.length) {
      const role2 = roles[i + 1];
      const emoji2 = ROLE_EMOJI[role2] || '🤖';
      row.push({
        text: `${emoji2} ${role2}`,
        callback_data: encodeCallback({ action: 'boot', target: role2 }),
      });
    }

    buttons.push(row);
  }

  // Cancel button
  buttons.push([
    {
      text: '❌ Cancel',
      callback_data: encodeCallback({ action: 'cancel' }),
    },
  ]);

  return { inline_keyboard: buttons };
}

// Create boot continuation buttons (with/without issue)
export function createBootContinuationButtons(
  role: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '🔢 Enter Issue Number',
          callback_data: encodeCallback({ action: 'boot_wait', target: role }),
        },
      ],
      [
        {
          text: '▶️ Boot Without Issue',
          callback_data: encodeCallback({ action: 'boot', target: role, confirm: true }),
        },
      ],
      [
        {
          text: '❌ Cancel',
          callback_data: encodeCallback({ action: 'cancel' }),
        },
      ],
    ],
  };
}

// Create quick action buttons for agent (logs, stop)
export function createAgentActionButtons(agentName: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '📋 View Logs',
          callback_data: encodeCallback({ action: 'logs', target: agentName }),
        },
        {
          text: '⏹️ Stop',
          callback_data: encodeCallback({ action: 'stop', target: agentName }),
        },
      ],
    ],
  };
}

// Create buttons for agent response messages and chat mode (Reply, Focus, Logs, Stop)
export function createAgentResponseButtons(agentName: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '↩️ Reply',
          callback_data: encodeCallback({ action: 'reply', target: agentName }),
        },
        {
          text: '🎯 Focus',
          callback_data: encodeCallback({ action: 'focus', target: agentName }),
        },
        {
          text: '📋 Logs',
          callback_data: encodeCallback({ action: 'logs', target: agentName }),
        },
        {
          text: '⏹️ Stop',
          callback_data: encodeCallback({ action: 'stop', target: agentName }),
        },
      ],
    ],
  };
}

// Create logs action buttons (refresh, stop)
export function createLogsActionButtons(agentName: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '🔄 Refresh',
          callback_data: encodeCallback({ action: 'logs', target: agentName }),
        },
        {
          text: '⏹️ Stop',
          callback_data: encodeCallback({ action: 'stop', target: agentName }),
        },
      ],
    ],
  };
}

// Create status quick action buttons
export function createStatusActionButtons(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '📋 View Logs',
          callback_data: encodeCallback({ action: 'logs_select' }),
        },
        {
          text: '⏹️ Stop Agent',
          callback_data: encodeCallback({ action: 'stop_select' }),
        },
      ],
      [
        {
          text: '🚀 Boot Agent',
          callback_data: encodeCallback({ action: 'boot' }),
        },
        {
          text: '🔄 Refresh',
          callback_data: encodeCallback({ action: 'status' }),
        },
      ],
    ],
  };
}

// Create question buttons for /api/ask
// Callback format: answer:${questionId}:${optionIndex}
export function createQuestionButtons(
  questionId: string,
  options: string[]
): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = options.map((option, idx) => [
    {
      text: option,
      callback_data: encodeCallback({ action: 'answer', target: questionId, extra: String(idx) }),
    },
  ]);

  return { inline_keyboard: buttons };
}

// Truncate button text to fit in button
export function truncateButtonText(text: string, maxLength: number = 20): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + '…';
}

// Find similar agent names (for suggestions)
export function findSimilarAgents(
  name: string,
  agents: LocalAgent[],
  maxResults: number = 3
): LocalAgent[] {
  const nameLower = name.toLowerCase();

  // Calculate similarity score
  const scored = agents.map((agent) => {
    const agentNameLower = agent.name.toLowerCase();
    let score = 0;

    // Exact match
    if (agentNameLower === nameLower) {
      score = 100;
    }
    // Starts with
    else if (agentNameLower.startsWith(nameLower)) {
      score = 80;
    }
    // Contains
    else if (agentNameLower.includes(nameLower)) {
      score = 60;
    }
    // Levenshtein-like simple distance
    else {
      let matches = 0;
      for (let i = 0; i < Math.min(nameLower.length, agentNameLower.length); i++) {
        if (nameLower[i] === agentNameLower[i]) matches++;
      }
      score = (matches / Math.max(nameLower.length, agentNameLower.length)) * 40;
    }

    return { agent, score };
  });

  // Sort by score and return top results
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.agent);
}

// Create issue selection buttons for smart boot flow
export function createIssueSelectionButtons(
  issues: Array<{ number: number; title: string }>,
  role: string
): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = issues.map(issue => [{
    text: truncateButtonText(`#${issue.number} ${issue.title}`, 40),
    callback_data: encodeCallback({
      action: 'boot',
      target: role,
      confirm: true,
      extra: String(issue.number),
    }),
  }]);

  // Manual entry option
  buttons.push([{
    text: '🔢 Enter issue number',
    callback_data: encodeCallback({ action: 'boot_wait', target: role }),
  }]);

  // Boot without issue
  buttons.push([{
    text: '▶️ Boot without issue',
    callback_data: encodeCallback({ action: 'boot', target: role, confirm: true }),
  }]);

  // Cancel
  buttons.push([{
    text: '❌ Cancel',
    callback_data: encodeCallback({ action: 'cancel' }),
  }]);

  return { inline_keyboard: buttons };
}

// Create diagnosis action buttons (Redeploy, Details)
export function createDiagnoseButtons(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '🔄 Redeploy',
          callback_data: encodeCallback({ action: 'redeploy' }),
        },
        {
          text: '📋 Details',
          callback_data: encodeCallback({ action: 'diagnose_detail' }),
        },
      ],
    ],
  };
}

// Create redeploy confirmation buttons
export function createRedeployConfirmButtons(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Yes, redeploy',
          callback_data: encodeCallback({ action: 'redeploy', target: '_', confirm: true }),
        },
        {
          text: '❌ Cancel',
          callback_data: encodeCallback({ action: 'cancel' }),
        },
      ],
    ],
  };
}

// Create suggestion buttons for similar agents
export function createSuggestionButtons(
  agents: LocalAgent[],
  action: string
): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = [];

  for (const agent of agents) {
    const emoji = ROLE_EMOJI[agent.role] || '🤖';
    const issue = agent.issue ? `#${agent.issue}` : '';
    const label = truncateButtonText(`${emoji} ${agent.name} ${issue}`, 30);

    buttons.push([
      {
        text: label,
        callback_data: encodeCallback({ action, target: agent.name }),
      },
    ]);
  }

  // Cancel button
  buttons.push([
    {
      text: '❌ Cancel',
      callback_data: encodeCallback({ action: 'cancel' }),
    },
  ]);

  return { inline_keyboard: buttons };
}
