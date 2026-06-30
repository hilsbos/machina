/**
 * HTTP API server — message broker for agent notifications and questions.
 *
 * Agents call these endpoints; the daemon handles Telegram + GitHub posting.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { execSync } from 'child_process';
import { URL } from 'url';
import { config } from '../config.js';
import * as agents from '../agents/agents.js';
import * as lifecycle from '../core/lifecycle.js';
import * as registry from '../core/registry.js';
import * as github from '../github/github.js';
import * as logArchive from '../agents/log-archive.js';
import { createQuestionButtons } from '../telegram/telegram-buttons.js';
import { sendMessage } from '../telegram/telegram.js';
import { formatHeader } from '../telegram/telegram-helpers.js';
import { getTelegramTopics, getDashboardConfig } from '../agents/fritz-config.js';
import * as dashboard from '../dashboard/dashboard.js';
import { getOrchestratorApiToken, send as orchestratorSend, appendOrchestratorHistory } from '../orchestrator/orchestrator.js';
import { logEvent } from '../core/event-log.js';
import { handleGitHubProxy } from './api-github.js';
import { getCachedIssues, type CachedIssue } from '../github/github-graphql.js';

let server: Server | null = null;

// Pending questions store: questionId → { resolve, reject, timer, options }
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  options: string[];
}>();

let questionCounter = 0;

const VALID_NOTIFY_TYPES = ['progress', 'blocked', 'complete', 'info', 'summary'] as const;
type NotifyType = typeof VALID_NOTIFY_TYPES[number];

function isValidNotifyType(type: string): type is NotifyType {
  return (VALID_NOTIFY_TYPES as readonly string[]).includes(type);
}

/** Get the options for a pending question (used by telegram.ts to look up option text). */
export function getQuestionOptions(questionId: string): string[] | undefined {
  return pendingQuestions.get(questionId)?.options;
}

/** Called by telegram.ts when a user taps an answer button. */
export function resolveQuestion(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pending.resolve(answer);
  pendingQuestions.delete(questionId);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Auth: per-agent API token validation (issue #290)
// ---------------------------------------------------------------------------

/** Extract Bearer token from Authorization header and validate against agent's stored token. */
function validateAgentToken(req: IncomingMessage, res: ServerResponse, agentName: string): boolean {
  const agent = registry.getAgent(agentName);
  if (!agent) {
    json(res, 404, { error: `Agent not found: ${agentName}` });
    return false;
  }

  // If the agent has a stored token, require it
  if (agent.apiToken) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token || token !== agent.apiToken) {
      json(res, 401, { error: 'Unauthorized' });
      return false;
    }
  }

  return true;
}

/** Validate that the caller is any active agent or the orchestrator (for archive read access). */
function validateCallerToken(req: IncomingMessage, res: ServerResponse): boolean {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }

  // Check if token belongs to the orchestrator
  const orchestratorToken = getOrchestratorApiToken();
  if (orchestratorToken && token === orchestratorToken) {
    return true;
  }

  // Check if token belongs to any active agent
  const agentList = registry.listAgents();
  const valid = agentList.some(a => a.apiToken === token);
  if (!valid) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/notify
// ---------------------------------------------------------------------------

async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: { agent: string; type: string; message: string; outcome?: string };

  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { agent: agentName, type, message } = payload;

  if (!agentName || !type || !message) {
    json(res, 400, { error: 'Missing required fields: agent, type, message' });
    return;
  }

  if (!isValidNotifyType(type)) {
    json(res, 400, { error: `Invalid type: ${type}. Must be one of: ${VALID_NOTIFY_TYPES.join(', ')}` });
    return;
  }

  // Validate per-agent API token
  if (!validateAgentToken(req, res, agentName)) return;

  // Reset TTL countdown — agent is actively communicating
  registry.touchAgent(agentName);

  // Send to Telegram via lifecycle.issueComment
  const agent = registry.getAgent(agentName);
  const issue = agent?.issue;
  const repo = agent?.repo;

  await lifecycle.issueComment(agentName, issue, message, type);

  // Store last activity in registry
  registry.updateActivity(agentName, message);

  // Post to GitHub issue if agent has one (gated by comment level)
  if (issue && repo && config.ghToken) {
    // Map notify types to GitHub comment types for gating
    const commentTypeMap: Record<string, import('../github/github.js').GitHubCommentType> = {
      progress: 'progress',
      blocked: 'blocked',
      complete: 'complete',
      info: 'progress',
      summary: 'skill-summary',
    };
    const commentType = commentTypeMap[type] ?? 'progress';

    if (github.shouldPostComment(commentType)) {
      const emoji = type === 'complete' ? '✅' : type === 'blocked' ? '⚠️' : type === 'summary' ? '📋' : '🔄';
      const label = type === 'complete' ? 'Work Complete' : type === 'blocked' ? 'Blocked' : type === 'summary' ? 'Summary' : 'Progress Update';
      // Format numbered items like (1)...(2)... as a markdown list
      const formatted = message.replace(/\s*\((\d+)\)\s*/g, '\n$1. ');
      const comment = `${emoji} **${label}**\n\n${formatted}\n\n_Agent: ${agentName}_`;
      try {
        await github.postComment(issue, comment);
      } catch (err) {
        console.error(`[api] Failed to post GitHub comment for #${issue}:`, err);
      }
    } else {
      console.log(`[api] Skipping ${type} GitHub comment for #${issue} (commentType: ${commentType})`);
    }
  }

  // Return response immediately so the agent's curl gets a clean 200
  json(res, 200, { ok: true });

  // Stop the agent asynchronously — triggers releaseAgent() → label transition
  if (type === 'complete') {
    const outcome = payload.outcome || 'approved';
    agents.stopAgent(agentName, 'completed', outcome).catch(err => {
      console.error(`[api] Failed to stop agent ${agentName} on completion:`, err);
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// POST /api/ask
// ---------------------------------------------------------------------------

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: { agent: string; question: string; options: string[] };

  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { agent: agentName, question, options } = payload;

  if (!agentName || !question) {
    json(res, 400, { error: 'Missing required fields: agent, question' });
    return;
  }

  if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
    json(res, 400, { error: 'options must be an array with 2-10 items' });
    return;
  }

  if (options.some(opt => typeof opt !== 'string' || opt.length === 0 || opt.length > 40)) {
    json(res, 400, { error: 'Each option must be a non-empty string, max 40 characters' });
    return;
  }

  // Validate per-agent API token
  if (!validateAgentToken(req, res, agentName)) return;

  // Reset TTL countdown — agent is actively communicating
  registry.touchAgent(agentName);

  const questionId = String(++questionCounter);

  // Build Telegram message
  const agent = registry.getAgent(agentName);
  const role = agent?.role ?? 'implement';
  const issue = agent?.issue;
  const title = agent?.issueTitle;

  const header = formatHeader(agentName, role, '❓', { issue, issueTitle: title });
  // Tag user when input is needed
  const tagLine = config.telegramTagHandle ? `\n\n${config.telegramTagHandle}` : '';
  const text = `${header}\n\n${question}${tagLine}`;

  const topicId = getTelegramTopics()?.questions;
  const replyMarkup = createQuestionButtons(questionId, options);

  await sendMessage(text, undefined, topicId, replyMarkup);

  // Hold the connection open until answered or timeout (5 minutes)
  const TIMEOUT_MS = 5 * 60 * 1000;

  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQuestions.delete(questionId);
        reject(new Error('timeout'));
      }, TIMEOUT_MS);

      pendingQuestions.set(questionId, { resolve, reject, timer, options });
    });

    json(res, 200, { answer });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'shutdown') {
      json(res, 503, { error: 'daemon_shutdown' });
    } else {
      json(res, 408, { error: 'timeout' });
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/archive — list archived agents
// GET /api/archive/:name/log — get archived agent log
// GET /api/archive/:name/summary — get archived agent summary
// ---------------------------------------------------------------------------

function handleArchiveList(req: IncomingMessage, res: ServerResponse): void {
  if (!validateCallerToken(req, res)) return;

  try {
    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host}`);
    const role = parsedUrl.searchParams.get('role') ?? undefined;
    const issueStr = parsedUrl.searchParams.get('issue');
    const issue = issueStr ? parseInt(issueStr, 10) : undefined;
    const since = parsedUrl.searchParams.get('since') ?? undefined;
    // Pagination logic — mirrored in api-security.test.ts paginateArchives(). Keep in sync.
    const limitStr = parsedUrl.searchParams.get('limit');
    const rawLimit = limitStr ? parseInt(limitStr, 10) : 50;
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 500);
    const offsetStr = parsedUrl.searchParams.get('offset');
    const rawOffset = offsetStr ? parseInt(offsetStr, 10) : 0;
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    const archives = logArchive.listArchivedAgents({
      role,
      issue: issue && !isNaN(issue) ? issue : undefined,
      since,
    });

    json(res, 200, {
      archives: archives.slice(offset, offset + limit),
      total: archives.length,
    });
  } catch (err) {
    console.error('[api] Archive list error:', err);
    json(res, 500, { error: 'Failed to list archives' });
  }
}

function handleArchiveLog(req: IncomingMessage, res: ServerResponse, agentName: string): void {
  if (!validateCallerToken(req, res)) return;

  try {
    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host}`);
    const linesStr = parsedUrl.searchParams.get('lines');
    const lines = linesStr ? parseInt(linesStr, 10) : 50;

    const result = logArchive.getArchivedLog(agentName, lines);
    if (result === null) {
      json(res, 404, { error: `No logs found for agent: ${agentName}` });
      return;
    }

    json(res, 200, { log: result.log });
  } catch (err) {
    console.error(`[api] Archive log error for ${agentName}:`, err);
    json(res, 500, { error: 'Failed to read archive log' });
  }
}

function handleArchiveSummary(req: IncomingMessage, res: ServerResponse, agentName: string): void {
  if (!validateCallerToken(req, res)) return;

  try {
    const summary = logArchive.getArchivedSummary(agentName);

    if (!summary) {
      json(res, 404, { error: `Agent not found in archive: ${agentName}` });
      return;
    }

    json(res, 200, summary);
  } catch (err) {
    console.error(`[api] Archive summary error for ${agentName}:`, err);
    json(res, 500, { error: 'Failed to read archive summary' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/pipeline/queue
// POST /api/pipeline/express  { issue: N }
// POST /api/pipeline/hold     { issue: N }
// POST /api/pipeline/release  { issue: N }
// ---------------------------------------------------------------------------

interface PipelineIssue {
  number: number;
  title: string;
  status: string;
  priority: string;
  repo: string;
  express: boolean;
  blockedBy: number | null;
  manual: boolean;
}

const PIPELINE_STATUSES = [
  'for-define',
  'for-implement',
  'active',
  'for-review',
  'for-validate',
  'for-rework',
];

/**
 * Transform a CachedIssue into the pipeline's PipelineIssue format.
 */
function cachedIssueToPipelineIssue(issue: CachedIssue, status: string, repo: string): PipelineIssue {
  const labelNames = issue.labels;

  // Priority: p0, p1, p2, p3 or empty
  const priorityLabel = labelNames.find((l: string) => l.startsWith('priority:'));
  const priority = priorityLabel ? priorityLabel.replace('priority:', '') : '';

  // Express: has priority:p0
  const express = labelNames.includes('priority:p0');

  // Manual hold: has fritz.manual
  const manual = labelNames.includes('fritz.manual');

  // Blocked by: fritz.depends-on:N label
  const dependsLabel = labelNames.find((l: string) => l.startsWith(github.DEPENDS_ON_PREFIX));
  const blockedBy = dependsLabel ? parseInt(dependsLabel.replace(github.DEPENDS_ON_PREFIX, ''), 10) : null;

  return {
    number: issue.number,
    title: issue.title,
    status,
    priority,
    repo,
    express,
    blockedBy: blockedBy && !isNaN(blockedBy) ? blockedBy : null,
    manual,
  };
}

export function fetchPipelineQueue(): PipelineIssue[] {
  const repo = config.githubRepo;
  if (!repo) return [];

  // Try the shared GraphQL cache first (avoids 6 separate gh CLI calls)
  const cached = getCachedIssues();
  if (cached) {
    const result: PipelineIssue[] = [];

    for (const status of PIPELINE_STATUSES) {
      const statusLabel = `fritz.status:${status}`;
      const matching = cached.filter(issue => issue.labels.includes(statusLabel));
      for (const issue of matching) {
        result.push(cachedIssueToPipelineIssue(issue, status, repo));
      }
    }

    // Sort: express first, then by issue number descending
    result.sort((a, b) => {
      if (a.express && !b.express) return -1;
      if (!a.express && b.express) return 1;
      return b.number - a.number;
    });

    return result;
  }

  // Fallback: direct gh CLI calls (cache not yet populated)
  const result: PipelineIssue[] = [];

  for (const status of PIPELINE_STATUSES) {
    try {
      const raw = execSync(
        `gh issue list --label "fritz.status:${status}" --state open --json number,title,labels --limit 50 --repo ${repo}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const issues: Array<{ number: number; title: string; labels: Array<{ name: string }> }> = JSON.parse(raw || '[]');

      for (const issue of issues) {
        const labelNames = issue.labels.map((l: { name: string }) => l.name);

        // Priority: p0, p1, p2, p3 or empty
        const priorityLabel = labelNames.find((l: string) => l.startsWith('priority:'));
        const priority = priorityLabel ? priorityLabel.replace('priority:', '') : '';

        // Express: has priority:p0
        const express = labelNames.includes('priority:p0');

        // Manual hold: has fritz.manual
        const manual = labelNames.includes('fritz.manual');

        // Blocked by: fritz.depends-on:N label
        const dependsLabel = labelNames.find((l: string) => l.startsWith(github.DEPENDS_ON_PREFIX));
        const blockedBy = dependsLabel ? parseInt(dependsLabel.replace(github.DEPENDS_ON_PREFIX, ''), 10) : null;

        result.push({
          number: issue.number,
          title: issue.title,
          status,
          priority,
          repo,
          express,
          blockedBy: blockedBy && !isNaN(blockedBy) ? blockedBy : null,
          manual,
        });
      }
    } catch {
      // Status might have no issues — continue
    }
  }

  // Sort: express first, then by issue number descending
  result.sort((a, b) => {
    if (a.express && !b.express) return -1;
    if (!a.express && b.express) return 1;
    return b.number - a.number;
  });

  return result;
}

async function handlePipelineQueue(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!validateCallerToken(req, res)) return;

  try {
    const queue = fetchPipelineQueue();
    json(res, 200, { queue, total: queue.length });
  } catch (err) {
    console.error('[api] Pipeline queue error:', err);
    json(res, 500, { error: 'Failed to fetch pipeline queue' });
  }
}

async function handlePipelineExpress(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!validateCallerToken(req, res)) return;

  const raw = await readBody(req);
  let payload: { issue?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const issueNum = payload.issue;
  if (!issueNum || typeof issueNum !== 'number') {
    json(res, 400, { error: 'Missing required field: issue' });
    return;
  }

  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  try {
    execSync(`gh issue edit ${issueNum} --add-label "priority:p0" --repo ${repo}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logEvent('pipeline.express', `Issue #${issueNum} marked express (priority:p0)`, { issue: issueNum });
    json(res, 200, { ok: true, issue: issueNum, label: 'priority:p0' });
  } catch (err) {
    console.error(`[api] Failed to add priority:p0 to #${issueNum}:`, err);
    json(res, 500, { error: 'Failed to add priority:p0 label' });
  }
}

async function handlePipelineHold(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!validateCallerToken(req, res)) return;

  const raw = await readBody(req);
  let payload: { issue?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const issueNum = payload.issue;
  if (!issueNum || typeof issueNum !== 'number') {
    json(res, 400, { error: 'Missing required field: issue' });
    return;
  }

  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  try {
    execSync(`gh issue edit ${issueNum} --add-label "fritz.manual" --repo ${repo}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logEvent('pipeline.hold', `Issue #${issueNum} placed on manual hold (fritz.manual)`, { issue: issueNum });
    json(res, 200, { ok: true, issue: issueNum, label: 'fritz.manual' });
  } catch (err) {
    console.error(`[api] Failed to add fritz.manual to #${issueNum}:`, err);
    json(res, 500, { error: 'Failed to add fritz.manual label' });
  }
}

async function handlePipelineRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!validateCallerToken(req, res)) return;

  const raw = await readBody(req);
  let payload: { issue?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const issueNum = payload.issue;
  if (!issueNum || typeof issueNum !== 'number') {
    json(res, 400, { error: 'Missing required field: issue' });
    return;
  }

  const repo = config.githubRepo;
  if (!repo) {
    json(res, 500, { error: 'GITHUB_REPO not configured' });
    return;
  }

  try {
    execSync(`gh issue edit ${issueNum} --remove-label "fritz.manual" --repo ${repo}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logEvent('pipeline.release', `Issue #${issueNum} released from manual hold`, { issue: issueNum });
    json(res, 200, { ok: true, issue: issueNum });
  } catch (err) {
    console.error(`[api] Failed to remove fritz.manual from #${issueNum}:`, err);
    json(res, 500, { error: 'Failed to remove fritz.manual label' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/orchestrator/message
// ---------------------------------------------------------------------------

const MAX_ORCHESTRATOR_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_ORCHESTRATOR_TIMEOUT_MS = 180000; // 3 minutes

async function handleOrchestratorMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!validateCallerToken(req, res)) return;

  const raw = await readBody(req);
  let payload: { message?: string; commandHint?: string; timeoutMs?: number; source?: 'bridge' | 'telegram' };

  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { message, commandHint, timeoutMs: rawTimeout } = payload;

  if (!message || typeof message !== 'string') {
    json(res, 400, { error: 'Missing required field: message' });
    return;
  }

  // Cap timeoutMs to prevent abuse
  const timeoutMs = Math.min(
    typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
    MAX_ORCHESTRATOR_TIMEOUT_MS
  );

  logEvent('orchestrator.message-relay', `Message: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`, {
    commandHint,
    timeoutMs,
  });

  const source = payload.source === 'bridge' ? 'bridge' : 'telegram';

  // Extract issue reference from message (e.g. #123)
  const issueMatch = message.match(/#(\d+)/);
  const issueRef = issueMatch ? parseInt(issueMatch[1], 10) : undefined;

  try {
    const response = await orchestratorSend(message, commandHint, timeoutMs);

    // Append to orchestrator conversation history
    appendOrchestratorHistory({
      source,
      question: message,
      reply: response,
      issueRef,
    });

    json(res, 200, { response });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('timeout')) {
      json(res, 408, { error: 'Orchestrator timed out' });
    } else {
      console.error('[api] Orchestrator message error:', err);
      json(res, 500, { error: 'Failed to send message to orchestrator' });
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  // GitHub cache proxy routes (no auth required — internal network only)
  if (url.startsWith('/api/github/')) {
    return handleGitHubProxy(req, res);
  }

  // Dashboard routes (no auth required — local network only)
  if (url === '/dashboard' || url.startsWith('/api/dashboard/')) {
    if (getDashboardConfig().enabled) {
      await dashboard.handleDashboardRequest(req, res);
    } else {
      json(res, 404, { error: 'Dashboard disabled' });
    }
    return;
  }

  if (method === 'GET' && url === '/api/pipeline/queue') {
    await handlePipelineQueue(req, res);
  } else if (method === 'POST' && url === '/api/pipeline/express') {
    await handlePipelineExpress(req, res);
  } else if (method === 'POST' && url === '/api/pipeline/hold') {
    await handlePipelineHold(req, res);
  } else if (method === 'POST' && url === '/api/pipeline/release') {
    await handlePipelineRelease(req, res);
  } else if (method === 'POST' && url === '/api/orchestrator/message') {
    await handleOrchestratorMessage(req, res);
  } else if (method === 'POST' && url === '/api/notify') {
    await handleNotify(req, res);
  } else if (method === 'POST' && url === '/api/ask') {
    await handleAsk(req, res);
  } else if (method === 'GET' && url.startsWith('/api/archive')) {
    // Route archive endpoints
    const path = url.split('?')[0];
    if (path === '/api/archive') {
      handleArchiveList(req, res);
    } else {
      // Parse /api/archive/:name/log or /api/archive/:name/summary
      const match = path.match(/^\/api\/archive\/([^/]+)\/(log|summary)$/);
      if (match) {
        const [, agentName, resource] = match;

        // Validate agent name to prevent path traversal (e.g. ".." in name)
        if (!/^[a-z0-9][a-z0-9-]*$/.test(agentName)) {
          json(res, 400, { error: 'Invalid agent name' });
          return;
        }

        if (resource === 'log') {
          handleArchiveLog(req, res, agentName);
        } else {
          handleArchiveSummary(req, res, agentName);
        }
      } else {
        json(res, 404, { error: 'Not found' });
      }
    }
  } else {
    json(res, 404, { error: 'Not found' });
  }
}

export function start(): Promise<void> {
  // Initialize dashboard (SSE, heartbeats, registry subscription)
  if (getDashboardConfig().enabled) {
    dashboard.init();
  }

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        console.error('[api] Request error:', err);
        if (!res.headersSent) {
          json(res, 500, { error: 'Internal server error' });
        }
      });
    });

    server.listen(config.apiPort, () => {
      console.log(`[api] HTTP server listening on port ${config.apiPort}`);
      resolve();
    });
  });
}

export function stop(): void {
  // Destroy dashboard (SSE clients, timers, registry subscription)
  dashboard.destroy();

  if (server) {
    server.close();
    server = null;
  }

  // Reject pending questions so HTTP responses are sent with 503
  for (const [id, pending] of pendingQuestions) {
    clearTimeout(pending.timer);
    pending.reject(new Error('shutdown'));
    pendingQuestions.delete(id);
  }
}
