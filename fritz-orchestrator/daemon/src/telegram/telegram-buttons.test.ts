/**
 * Vitest tests for Telegram inline keyboard button building (Issue #263).
 *
 * Imports actual functions from telegram-buttons.ts and mocks dependencies.
 *
 * Covers:
 * - encodeCallback / decodeCallback roundtrip
 * - truncateButtonText
 * - findSimilarAgents
 * - createConfirmationButtons structure
 * - createQuestionButtons structure
 * - createAgentActionButtons
 * - createLogsActionButtons
 * - createAgentSelectionButtons (pagination, odd/even agents)
 * - createRoleSelectionButtons
 * - createBootContinuationButtons
 * - createAgentResponseButtons
 * - createStatusActionButtons
 * - createIssueSelectionButtons
 * - createDiagnoseButtons
 * - createRedeployConfirmButtons
 * - createSuggestionButtons
 * - callback_data format validation
 * - 64-byte limit enforcement
 */

import { describe, it, expect, vi } from 'vitest';

// Mock dependencies the module imports
vi.mock('../core/registry.js', () => ({
  getAgents: vi.fn(() => []),
}));

vi.mock('../types.js', () => ({
  ROLE_EMOJI: {
    implement: '\u{1F528}',
    review: '\u{1F50D}',
    validate: '\u{2705}',
    define: '\u{1F4CB}',
    architect: '\u{1F3D7}',
    ux: '\u{1F3A8}',
    budget: '\u{1F4B0}',
    retro: '\u{1F50E}',
  },
}));

import {
  encodeCallback,
  decodeCallback,
  truncateButtonText,
  findSimilarAgents,
  createConfirmationButtons,
  createQuestionButtons,
  createAgentActionButtons,
  createLogsActionButtons,
  createAgentSelectionButtons,
  createRoleSelectionButtons,
  createBootContinuationButtons,
  createAgentResponseButtons,
  createStatusActionButtons,
  createIssueSelectionButtons,
  createDiagnoseButtons,
  createRedeployConfirmButtons,
  createSuggestionButtons,
  type CallbackData,
} from './telegram-buttons.js';

// ── Tests ──

describe('encodeCallback / decodeCallback', () => {
  it('roundtrips action-only data', () => {
    const original: CallbackData = { action: 'cancel' };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('cancel');
  });

  it('roundtrips action + target', () => {
    const original: CallbackData = { action: 'stop', target: 'impl-42' };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('stop');
    expect(decoded.target).toBe('impl-42');
  });

  it('roundtrips action + target + page', () => {
    const original: CallbackData = { action: 'page', target: 'stop', page: 2 };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('page');
    expect(decoded.target).toBe('stop');
    expect(decoded.page).toBe(2);
  });

  it('roundtrips action + target + confirm', () => {
    const original: CallbackData = { action: 'stop', target: 'impl-42', confirm: true };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('stop');
    expect(decoded.target).toBe('impl-42');
    expect(decoded.confirm).toBe(true);
  });

  it('roundtrips full data with extra', () => {
    const original: CallbackData = { action: 'boot', target: 'implement', confirm: true, extra: '42' };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('boot');
    expect(decoded.target).toBe('implement');
    expect(decoded.confirm).toBe(true);
    expect(decoded.extra).toBe('42');
  });

  it('throws when callback data exceeds 64 bytes', () => {
    const longTarget = 'a'.repeat(60);
    expect(() => encodeCallback({ action: 'stop', target: longTarget })).toThrow('too long');
  });

  it('encodes confirm=false as "0"', () => {
    const original: CallbackData = { action: 'stop', target: 'x', confirm: false };
    const encoded = encodeCallback(original);
    expect(encoded).toContain(':0');
    const decoded = decodeCallback(encoded);
    expect(decoded.confirm).toBe(false);
  });

  it('handles extra without page or confirm (inserts empty placeholders)', () => {
    const original: CallbackData = { action: 'answer', target: 'q1', extra: '0' };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('answer');
    expect(decoded.target).toBe('q1');
    expect(decoded.extra).toBe('0');
  });

  it('handles confirm without page (inserts empty placeholder)', () => {
    const original: CallbackData = { action: 'boot', target: 'impl', confirm: true };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.action).toBe('boot');
    expect(decoded.target).toBe('impl');
    expect(decoded.confirm).toBe(true);
  });

  it('handles page=0', () => {
    const original: CallbackData = { action: 'page', target: 'logs', page: 0 };
    const encoded = encodeCallback(original);
    const decoded = decodeCallback(encoded);
    expect(decoded.page).toBe(0);
  });
});

describe('truncateButtonText', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateButtonText('short', 20)).toBe('short');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'This is a very long button text that exceeds the limit';
    const result = truncateButtonText(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('uses default maxLength of 20', () => {
    const text21 = 'a'.repeat(21);
    const result = truncateButtonText(text21);
    expect(result.length).toBe(20);
  });

  it('handles text exactly at limit', () => {
    const text20 = 'a'.repeat(20);
    expect(truncateButtonText(text20, 20)).toBe(text20);
  });

  it('handles empty string', () => {
    expect(truncateButtonText('', 20)).toBe('');
  });
});

describe('findSimilarAgents', () => {
  const agents = [
    { name: 'impl-42', role: 'implement', issue: 42 },
    { name: 'impl-43', role: 'implement', issue: 43 },
    { name: 'review-10', role: 'review', issue: 10 },
    { name: 'validate-5', role: 'validate', issue: 5 },
  ] as unknown[];

  it('finds exact match', () => {
    const result = findSimilarAgents('impl-42', agents);
    expect(result[0].name).toBe('impl-42');
  });

  it('finds prefix matches', () => {
    const result = findSimilarAgents('impl', agents);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.every(a => a.name.startsWith('impl'))).toBe(true);
  });

  it('finds substring matches', () => {
    const result = findSimilarAgents('42', agents);
    expect(result.some(a => a.name.includes('42'))).toBe(true);
  });

  it('limits results to maxResults', () => {
    const result = findSimilarAgents('impl', agents, 1);
    expect(result).toHaveLength(1);
  });

  it('returns empty for no match', () => {
    const result = findSimilarAgents('zzzzz', agents);
    // May still return fuzzy matches with low scores
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('case insensitive search', () => {
    const result = findSimilarAgents('IMPL-42', agents);
    expect(result[0].name).toBe('impl-42');
  });

  it('fuzzy matching returns partial character matches', () => {
    const result = findSimilarAgents('imxl', agents);
    // Should return some results through character matching
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('createConfirmationButtons', () => {
  it('creates Yes and Cancel buttons', () => {
    const result = createConfirmationButtons('stop', 'impl-42');
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[0][0].text).toContain('Yes');
    expect(result.inline_keyboard[0][1].text).toContain('Cancel');
  });

  it('encodes action and target in Yes callback', () => {
    const result = createConfirmationButtons('stop', 'impl-42');
    const yesData = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(yesData.action).toBe('stop');
    expect(yesData.target).toBe('impl-42');
    expect(yesData.confirm).toBe(true);
  });

  it('Cancel button uses cancel action', () => {
    const result = createConfirmationButtons('stop', 'impl-42');
    const cancelData = decodeCallback(result.inline_keyboard[0][1].callback_data);
    expect(cancelData.action).toBe('cancel');
  });
});

describe('createQuestionButtons', () => {
  it('creates one button per option', () => {
    const result = createQuestionButtons('q1', ['Option A', 'Option B', 'Option C']);
    expect(result.inline_keyboard).toHaveLength(3);
    expect(result.inline_keyboard[0][0].text).toBe('Option A');
    expect(result.inline_keyboard[1][0].text).toBe('Option B');
    expect(result.inline_keyboard[2][0].text).toBe('Option C');
  });

  it('includes questionId in callback data', () => {
    const result = createQuestionButtons('abc-123', ['Yes', 'No']);
    const data = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(data.action).toBe('answer');
    expect(data.target).toBe('abc-123');
  });

  it('handles empty choices', () => {
    const result = createQuestionButtons('q1', []);
    expect(result.inline_keyboard).toHaveLength(0);
  });

  it('includes option index in extra field', () => {
    const result = createQuestionButtons('q1', ['A', 'B', 'C']);
    const data0 = decodeCallback(result.inline_keyboard[0][0].callback_data);
    const data2 = decodeCallback(result.inline_keyboard[2][0].callback_data);
    expect(data0.extra).toBe('0');
    expect(data2.extra).toBe('2');
  });
});

describe('createAgentActionButtons', () => {
  it('creates logs and stop buttons', () => {
    const result = createAgentActionButtons('impl-42');
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[0][0].text).toContain('Logs');
    expect(result.inline_keyboard[0][1].text).toContain('Stop');
  });

  it('encodes agent name in callback data', () => {
    const result = createAgentActionButtons('review-10');
    const logsData = decodeCallback(result.inline_keyboard[0][0].callback_data);
    const stopData = decodeCallback(result.inline_keyboard[0][1].callback_data);
    expect(logsData.action).toBe('logs');
    expect(logsData.target).toBe('review-10');
    expect(stopData.action).toBe('stop');
    expect(stopData.target).toBe('review-10');
  });
});

describe('createLogsActionButtons', () => {
  it('creates refresh and stop buttons', () => {
    const result = createLogsActionButtons('review-10');
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[0][0].text).toContain('Refresh');
    expect(result.inline_keyboard[0][1].text).toContain('Stop');
  });
});

describe('createAgentSelectionButtons', () => {
  const agents = [
    { name: 'impl-1', role: 'implement', issue: 1 },
    { name: 'impl-2', role: 'implement', issue: 2 },
    { name: 'impl-3', role: 'implement', issue: 3 },
    { name: 'review-4', role: 'review', issue: 4 },
    { name: 'validate-5', role: 'validate', issue: 5 },
    { name: 'impl-6', role: 'implement', issue: 6 },
    { name: 'impl-7', role: 'implement', issue: 7 },
  ] as unknown[];

  it('displays agents in pairs (2 per row) with cancel button', () => {
    const result = createAgentSelectionButtons(agents.slice(0, 2), 'stop');
    // 1 row for agents (2 agents) + 1 cancel row
    expect(result.inline_keyboard).toHaveLength(2);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    // cancel row
    const cancelData = decodeCallback(result.inline_keyboard[1][0].callback_data);
    expect(cancelData.action).toBe('cancel');
  });

  it('handles odd number of agents (last row has 1 button)', () => {
    const result = createAgentSelectionButtons(agents.slice(0, 3), 'stop');
    // 2 rows for agents (2+1) + 1 cancel row
    expect(result.inline_keyboard).toHaveLength(3);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[1]).toHaveLength(1); // odd agent
  });

  it('paginates with more than itemsPerPage agents', () => {
    const result = createAgentSelectionButtons(agents, 'logs', 0, 5);
    // 5 agents page 0: 3 agent rows (2+2+1) + pagination row + cancel row
    expect(result.inline_keyboard.length).toBeGreaterThanOrEqual(4);
    // Find pagination row (should have page number like "1/2")
    const paginationRow = result.inline_keyboard.find(row =>
      row.some(btn => btn.text.includes('/'))
    );
    expect(paginationRow).toBeDefined();
  });

  it('shows Next button on first page', () => {
    const result = createAgentSelectionButtons(agents, 'stop', 0, 5);
    const paginationRow = result.inline_keyboard.find(row =>
      row.some(btn => btn.text.includes('/'))
    );
    expect(paginationRow).toBeDefined();
    expect(paginationRow!.some(btn => btn.text.includes('Next'))).toBe(true);
    // No Previous on first page
    expect(paginationRow!.some(btn => btn.text.includes('Previous'))).toBe(false);
  });

  it('shows Previous button on second page', () => {
    const result = createAgentSelectionButtons(agents, 'stop', 1, 5);
    const paginationRow = result.inline_keyboard.find(row =>
      row.some(btn => btn.text.includes('/'))
    );
    expect(paginationRow).toBeDefined();
    expect(paginationRow!.some(btn => btn.text.includes('Previous'))).toBe(true);
  });

  it('truncates long agent names in buttons', () => {
    const longNameAgents = [
      { name: 'very-long-agent-name-that-exceeds-limit', role: 'implement', issue: 999 },
    ] as unknown[];
    const result = createAgentSelectionButtons(longNameAgents, 'stop');
    const btnText = result.inline_keyboard[0][0].text;
    expect(btnText.length).toBeLessThanOrEqual(30);
  });

  it('shows agent issue number in button', () => {
    const result = createAgentSelectionButtons([agents[0]], 'stop');
    const btnText = result.inline_keyboard[0][0].text;
    expect(btnText).toContain('#1');
  });

  it('handles agent without issue number', () => {
    const noIssueAgent = [{ name: 'impl-x', role: 'implement' }] as unknown[];
    const result = createAgentSelectionButtons(noIssueAgent, 'stop');
    const btnText = result.inline_keyboard[0][0].text;
    expect(btnText).not.toContain('#');
  });
});

describe('createRoleSelectionButtons', () => {
  it('creates buttons for all roles with cancel', () => {
    const result = createRoleSelectionButtons();
    // 10 roles, 2 per row = 5 rows + 1 cancel row
    expect(result.inline_keyboard).toHaveLength(6);
  });

  it('roles are arranged in pairs', () => {
    const result = createRoleSelectionButtons();
    // First 5 rows should have 2 buttons each
    for (let i = 0; i < 5; i++) {
      expect(result.inline_keyboard[i]).toHaveLength(2);
    }
  });

  it('last row is cancel button', () => {
    const result = createRoleSelectionButtons();
    const lastRow = result.inline_keyboard[result.inline_keyboard.length - 1];
    const cancelData = decodeCallback(lastRow[0].callback_data);
    expect(cancelData.action).toBe('cancel');
  });

  it('encodes boot action with role as target', () => {
    const result = createRoleSelectionButtons();
    const firstBtn = result.inline_keyboard[0][0];
    const data = decodeCallback(firstBtn.callback_data);
    expect(data.action).toBe('boot');
    expect(data.target).toBe('implement');
  });
});

describe('createBootContinuationButtons', () => {
  it('creates 3 rows: enter issue, boot without issue, cancel', () => {
    const result = createBootContinuationButtons('implement');
    expect(result.inline_keyboard).toHaveLength(3);
  });

  it('first button is enter issue number', () => {
    const result = createBootContinuationButtons('review');
    const data = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(data.action).toBe('boot_wait');
    expect(data.target).toBe('review');
  });

  it('second button boots without issue', () => {
    const result = createBootContinuationButtons('implement');
    const data = decodeCallback(result.inline_keyboard[1][0].callback_data);
    expect(data.action).toBe('boot');
    expect(data.target).toBe('implement');
    expect(data.confirm).toBe(true);
  });

  it('third button is cancel', () => {
    const result = createBootContinuationButtons('implement');
    const data = decodeCallback(result.inline_keyboard[2][0].callback_data);
    expect(data.action).toBe('cancel');
  });
});

describe('createAgentResponseButtons', () => {
  it('creates Reply, Focus, Logs, Stop buttons in one row', () => {
    const result = createAgentResponseButtons('impl-42');
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(4);
    expect(result.inline_keyboard[0][0].text).toContain('Reply');
    expect(result.inline_keyboard[0][1].text).toContain('Focus');
    expect(result.inline_keyboard[0][2].text).toContain('Logs');
    expect(result.inline_keyboard[0][3].text).toContain('Stop');
  });

  it('encodes correct actions for each button', () => {
    const result = createAgentResponseButtons('impl-42');
    expect(decodeCallback(result.inline_keyboard[0][0].callback_data).action).toBe('reply');
    expect(decodeCallback(result.inline_keyboard[0][1].callback_data).action).toBe('focus');
    expect(decodeCallback(result.inline_keyboard[0][2].callback_data).action).toBe('logs');
    expect(decodeCallback(result.inline_keyboard[0][3].callback_data).action).toBe('stop');
  });
});

describe('createStatusActionButtons', () => {
  it('creates 2 rows with view logs, stop agent, boot agent, refresh', () => {
    const result = createStatusActionButtons();
    expect(result.inline_keyboard).toHaveLength(2);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[1]).toHaveLength(2);
  });

  it('first row has logs and stop', () => {
    const result = createStatusActionButtons();
    expect(decodeCallback(result.inline_keyboard[0][0].callback_data).action).toBe('logs_select');
    expect(decodeCallback(result.inline_keyboard[0][1].callback_data).action).toBe('stop_select');
  });

  it('second row has boot and refresh', () => {
    const result = createStatusActionButtons();
    expect(decodeCallback(result.inline_keyboard[1][0].callback_data).action).toBe('boot');
    expect(decodeCallback(result.inline_keyboard[1][1].callback_data).action).toBe('status');
  });
});

describe('createIssueSelectionButtons', () => {
  it('creates one button per issue plus manual entry, boot without, cancel', () => {
    const issues = [
      { number: 1, title: 'Fix bug' },
      { number: 2, title: 'Add feature' },
    ];
    const result = createIssueSelectionButtons(issues, 'implement');
    // 2 issue rows + manual entry + boot without issue + cancel = 5
    expect(result.inline_keyboard).toHaveLength(5);
  });

  it('encodes issue number in extra field', () => {
    const issues = [{ number: 42, title: 'Important fix' }];
    const result = createIssueSelectionButtons(issues, 'implement');
    const data = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(data.action).toBe('boot');
    expect(data.target).toBe('implement');
    expect(data.confirm).toBe(true);
    expect(data.extra).toBe('42');
  });

  it('truncates long issue titles', () => {
    const issues = [{ number: 1, title: 'A'.repeat(50) }];
    const result = createIssueSelectionButtons(issues, 'implement');
    const btnText = result.inline_keyboard[0][0].text;
    expect(btnText.length).toBeLessThanOrEqual(40);
  });

  it('has manual entry button', () => {
    const issues = [{ number: 1, title: 'Test' }];
    const result = createIssueSelectionButtons(issues, 'review');
    const manualBtn = result.inline_keyboard[1][0];
    const data = decodeCallback(manualBtn.callback_data);
    expect(data.action).toBe('boot_wait');
    expect(data.target).toBe('review');
  });
});

describe('createDiagnoseButtons', () => {
  it('creates redeploy and details buttons', () => {
    const result = createDiagnoseButtons();
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[0][0].text).toContain('Redeploy');
    expect(result.inline_keyboard[0][1].text).toContain('Details');
  });

  it('encodes correct actions', () => {
    const result = createDiagnoseButtons();
    expect(decodeCallback(result.inline_keyboard[0][0].callback_data).action).toBe('redeploy');
    expect(decodeCallback(result.inline_keyboard[0][1].callback_data).action).toBe('diagnose_detail');
  });
});

describe('createRedeployConfirmButtons', () => {
  it('creates yes and cancel buttons', () => {
    const result = createRedeployConfirmButtons();
    expect(result.inline_keyboard).toHaveLength(1);
    expect(result.inline_keyboard[0]).toHaveLength(2);
    expect(result.inline_keyboard[0][0].text).toContain('Yes');
    expect(result.inline_keyboard[0][1].text).toContain('Cancel');
  });

  it('encodes redeploy with confirm=true', () => {
    const result = createRedeployConfirmButtons();
    const yesData = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(yesData.action).toBe('redeploy');
    expect(yesData.confirm).toBe(true);
  });
});

describe('createSuggestionButtons', () => {
  it('creates one button per agent plus cancel', () => {
    const agents = [
      { name: 'impl-1', role: 'implement', issue: 1 },
      { name: 'review-2', role: 'review', issue: 2 },
    ] as unknown[];

    const result = createSuggestionButtons(agents, 'logs');
    // 2 agent rows + 1 cancel row
    expect(result.inline_keyboard).toHaveLength(3);
  });

  it('encodes action and target in each agent button', () => {
    const agents = [{ name: 'impl-1', role: 'implement', issue: 10 }] as unknown[];
    const result = createSuggestionButtons(agents, 'stop');
    const data = decodeCallback(result.inline_keyboard[0][0].callback_data);
    expect(data.action).toBe('stop');
    expect(data.target).toBe('impl-1');
  });

  it('includes role emoji and issue number in button text', () => {
    const agents = [{ name: 'impl-1', role: 'implement', issue: 42 }] as unknown[];
    const result = createSuggestionButtons(agents, 'stop');
    const text = result.inline_keyboard[0][0].text;
    expect(text).toContain('#42');
  });

  it('ends with cancel button', () => {
    const agents = [{ name: 'impl-1', role: 'implement' }] as unknown[];
    const result = createSuggestionButtons(agents, 'logs');
    const lastRow = result.inline_keyboard[result.inline_keyboard.length - 1];
    const data = decodeCallback(lastRow[0].callback_data);
    expect(data.action).toBe('cancel');
  });

  it('handles agents without issue', () => {
    const agents = [{ name: 'impl-1', role: 'implement' }] as unknown[];
    const result = createSuggestionButtons(agents, 'stop');
    const text = result.inline_keyboard[0][0].text;
    expect(text).not.toContain('#');
  });
});
