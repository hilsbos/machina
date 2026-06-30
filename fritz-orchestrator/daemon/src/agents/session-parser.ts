/**
 * Parse Claude Code JSONL session logs and agent.log files into a unified
 * timeline suitable for Telegram display via /logs.
 *
 * JSONL files live at:
 *   <workspace>/.claude/projects/-workspace/<session-id>/*.jsonl
 * Subagent files:
 *   <workspace>/.claude/projects/-workspace/<session-id>/subagents/agent-*.jsonl
 *
 * agent.log lives at:
 *   <workspace>/.fritz/agent.log
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  duration: string;
  turns: number;
  totalInputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalOutputTokens: number;
  entries: SessionEntry[];
  subagentCount: number;
}

export interface SessionEntry {
  timestamp: Date;
  source: 'session' | 'agent-log';
  type: 'text' | 'tool_use' | 'prompt' | 'response' | 'error' | 'timeout';
  summary: string;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/** Recursively find all *.jsonl files under a directory. */
export function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

/** Count subagent JSONL files (files inside a subagents/ directory). */
function countSubagents(files: string[]): number {
  return files.filter(f => f.includes('/subagents/')).length;
}

/** Shape of a content item inside a JSONL assistant/progress message. */
interface JsonlContentItem {
  type?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/** Shape of a message inside a JSONL record. */
interface JsonlMessage {
  role?: string;
  id?: string;
  content?: string | JsonlContentItem[];
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

/** Parsed JSONL record from a Claude Code session log. */
interface JsonlRecord {
  sessionId?: string;
  timestamp?: string;
  type?: string;
  data?: {
    message?: {
      type?: string;
      message?: JsonlMessage;
    };
  };
  message?: JsonlMessage;
}

/** Safely parse one JSONL line. Returns null on failure. */
function parseLine(line: string): JsonlRecord | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Summarise tool_use input into a short string. */
function summariseToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return input.file_path ? truncate(String(input.file_path), 80) : '';
    case 'Write':
      return input.file_path ? truncate(String(input.file_path), 80) : '';
    case 'Edit':
      return input.file_path ? truncate(String(input.file_path), 80) : '';
    case 'Bash':
      return input.command ? truncate(String(input.command), 80) : '';
    case 'Glob':
      return input.pattern ? truncate(String(input.pattern), 60) : '';
    case 'Grep':
      return input.pattern ? truncate(String(input.pattern), 60) : '';
    case 'TodoWrite':
      return input.todos ? `${(input.todos as unknown[]).length} items` : '';
    case 'TaskCreate':
      return input.subject ? truncate(String(input.subject), 60) : '';
    case 'Task':
      return input.description ? truncate(String(input.description), 60) : '';
    case 'WebFetch':
      return input.url ? truncate(String(input.url), 60) : '';
    case 'WebSearch':
      return input.query ? truncate(String(input.query), 60) : '';
    default:
      return '';
  }
}

interface ParsedJsonl {
  entries: SessionEntry[];
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  turns: number;
  sessionId: string;
}

const MAX_JSONL_BYTES = 2 * 1024 * 1024; // 2 MB

/** Parse entries from a single JSONL file. */
function parseJsonlFile(filePath: string): ParsedJsonl | null {
  const result: ParsedJsonl = {
    entries: [],
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    turns: 0,
    sessionId: '',
  };

  // Skip very large files to avoid blocking the event loop
  try {
    if (statSync(filePath).size > MAX_JSONL_BYTES) return null;
  } catch {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  // Track which message IDs we've already extracted text/tool entries from,
  // because streaming produces multiple lines per assistant message.
  const seenTextForMessage = new Set<string>();
  const seenToolsForMessage = new Map<string, Set<string>>();
  // Track which message IDs we've already counted usage for.
  const countedUsage = new Set<string>();
  // Deduplicate subagent tool calls (progress entries re-stream the same content).
  const seenSubagentTools = new Set<string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const obj = parseLine(line);
    if (!obj) continue;

    // Capture session ID from any line that has it
    if (obj.sessionId && !result.sessionId) {
      result.sessionId = obj.sessionId;
    }

    const ts = obj.timestamp ? new Date(obj.timestamp) : null;

    // Handle subagent progress entries
    if (obj.type === 'progress' && obj.data?.message?.type === 'assistant') {
      const subMsg = obj.data.message.message;
      if (subMsg && Array.isArray(subMsg.content) && ts) {
        for (const item of subMsg.content) {
          if (item.type === 'tool_use' && item.name && item.name !== 'thinking') {
            const toolKey = item.id || item.name;
            if (seenSubagentTools.has(toolKey)) continue;
            seenSubagentTools.add(toolKey);

            const detail = summariseToolInput(item.name, item.input || {});
            const summary = detail
              ? `[sub] ${item.name}: ${detail}`
              : `[sub] ${item.name}`;
            result.entries.push({
              timestamp: ts,
              source: 'session',
              type: 'tool_use',
              summary,
            });
          }
        }
      }
      continue;
    }

    // Skip non-message types
    if (obj.type !== 'assistant' && obj.type !== 'user') continue;

    const msg = obj.message;
    if (!msg) continue;

    // Count turns (each user message = 1 turn)
    if (obj.type === 'user' && msg.role === 'user') {
      // Only count external user messages, not tool_results
      if (typeof msg.content === 'string') {
        result.turns++;
      } else if (Array.isArray(msg.content)) {
        // If content is an array and has at least one text item, count it
        const hasText = msg.content.some((c) => c.type === 'text');
        if (hasText) result.turns++;
      }
    }

    // Process assistant messages
    if (obj.type === 'assistant' && msg.role === 'assistant') {
      const msgId = msg.id || '';

      // Accumulate usage (only once per unique message id)
      if (msg.usage && msgId && !countedUsage.has(msgId)) {
        countedUsage.add(msgId);
        const u = msg.usage;
        result.inputTokens += u.input_tokens || 0;
        result.cacheReadInputTokens += u.cache_read_input_tokens || 0;
        result.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
        result.outputTokens += u.output_tokens || 0;
      }

      // Extract content items
      if (!Array.isArray(msg.content)) continue;

      for (const item of msg.content) {
        if (!ts) continue;

        if (item.type === 'text' && item.text) {
          // Skip "(no content)" placeholder
          if (item.text === '(no content)') continue;

          // Only emit one text entry per message ID
          if (msgId && seenTextForMessage.has(msgId)) continue;
          if (msgId) seenTextForMessage.add(msgId);

          result.entries.push({
            timestamp: ts,
            source: 'session',
            type: 'text',
            summary: truncate(item.text, 120),
          });
        }

        if (item.type === 'tool_use' && item.name) {
          // Deduplicate tool uses by message ID + tool use ID
          const toolId = item.id || item.name;
          if (msgId) {
            if (!seenToolsForMessage.has(msgId)) {
              seenToolsForMessage.set(msgId, new Set());
            }
            const seen = seenToolsForMessage.get(msgId)!;
            if (seen.has(toolId)) continue;
            seen.add(toolId);
          }

          // Skip thinking content
          if (item.name === 'thinking') continue;

          const detail = summariseToolInput(item.name, item.input || {});
          const summary = detail ? `${item.name}: ${detail}` : item.name;

          result.entries.push({
            timestamp: ts,
            source: 'session',
            type: 'tool_use',
            summary,
          });
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// agent.log parsing
// ---------------------------------------------------------------------------

const AGENT_LOG_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s*(.+)$/;

function parseAgentLog(workspace: string): SessionEntry[] {
  const logPath = join(workspace, '.fritz', 'agent.log');
  if (!existsSync(logPath)) return [];

  let content: string;
  try {
    const fileSize = statSync(logPath).size;
    if (fileSize > MAX_JSONL_BYTES) {
      // File too large – read only the last ~2 MB so we still get recent entries
      const buf = Buffer.alloc(MAX_JSONL_BYTES);
      const fd = openSync(logPath, 'r');
      try {
        readSync(fd, buf, 0, MAX_JSONL_BYTES, fileSize - MAX_JSONL_BYTES);
      } finally {
        closeSync(fd);
      }
      // Drop the first (likely partial) line
      const raw = buf.toString('utf-8');
      const firstNewline = raw.indexOf('\n');
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = readFileSync(logPath, 'utf-8');
    }
  } catch {
    return [];
  }

  const entries: SessionEntry[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = AGENT_LOG_RE.exec(line);
    if (!match) continue;

    const ts = new Date(match[1]);
    const body = match[2];

    let type: SessionEntry['type'];
    let summary: string;

    if (body.startsWith('\u2192 PROMPT:') || body.startsWith('-> PROMPT:')) {
      type = 'prompt';
      summary = '\u2192 PROMPT: ' + truncate(body.replace(/^(?:\u2192|->)\s*PROMPT:\s*/, ''), 120);
    } else if (body.startsWith('\u2190 RESPONSE:') || body.startsWith('<- RESPONSE:')) {
      type = 'response';
      summary = '\u2190 RESPONSE: ' + truncate(body.replace(/^(?:\u2190|<-)\s*RESPONSE:\s*/, ''), 120);
    } else if (body.startsWith('\u2190 TIMEOUT:') || body.startsWith('<- TIMEOUT:')) {
      type = 'timeout';
      summary = '\u2190 TIMEOUT: ' + truncate(body.replace(/^(?:\u2190|<-)\s*TIMEOUT:\s*/, ''), 120);
    } else if (body.startsWith('\u2190 ERROR:') || body.startsWith('<- ERROR:')) {
      type = 'error';
      summary = '\u2190 ERROR: ' + truncate(body.replace(/^(?:\u2190|<-)\s*ERROR:\s*/, ''), 120);
    } else {
      // Unknown line format, include as text
      type = 'text';
      summary = truncate(body, 120);
    }

    entries.push({ timestamp: ts, source: 'agent-log', type, summary });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an agent workspace and return a merged session summary.
 * Returns null if no JSONL session data is found.
 */
export function parseAgentSession(workspace: string): SessionSummary | null {
  // Find JSONL files under .claude/projects/
  const claudeProjectsDir = join(workspace, '.claude', 'projects');
  const jsonlFiles = findJsonlFiles(claudeProjectsDir);

  if (jsonlFiles.length === 0) return null;

  // Parse all JSONL files (main session + subagents)
  const allEntries: SessionEntry[] = [];
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalOutput = 0;
  let totalTurns = 0;
  let sessionId = '';
  const subagentCount = countSubagents(jsonlFiles);

  for (const file of jsonlFiles) {
    const parsed = parseJsonlFile(file);
    if (!parsed) continue;
    allEntries.push(...parsed.entries);
    totalInput += parsed.inputTokens;
    totalCacheRead += parsed.cacheReadInputTokens;
    totalCacheCreation += parsed.cacheCreationInputTokens;
    totalOutput += parsed.outputTokens;
    totalTurns += parsed.turns;
    if (!sessionId && parsed.sessionId) {
      sessionId = parsed.sessionId;
    }
  }

  // Parse agent.log
  const agentLogEntries = parseAgentLog(workspace);
  allEntries.push(...agentLogEntries);

  // Sort all entries chronologically
  allEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Compute duration
  let duration = '0s';
  if (allEntries.length >= 2) {
    const first = allEntries[0].timestamp.getTime();
    const last = allEntries[allEntries.length - 1].timestamp.getTime();
    duration = formatDuration(last - first);
  }

  return {
    sessionId: sessionId || basename(jsonlFiles[0], '.jsonl'),
    duration,
    turns: totalTurns,
    totalInputTokens: totalInput,
    totalCacheReadInputTokens: totalCacheRead,
    totalCacheCreationInputTokens: totalCacheCreation,
    totalOutputTokens: totalOutput,
    entries: allEntries,
    subagentCount,
  };
}

/**
 * Format a SessionSummary into a Telegram-friendly string.
 * Output is plain text (wrapped in a code block by the caller).
 */
export function formatSessionForTelegram(
  summary: SessionSummary,
  maxLength: number = 3800,
): string {
  const baseTokens = summary.totalInputTokens + summary.totalOutputTokens;
  const cacheTokens = summary.totalCacheReadInputTokens + summary.totalCacheCreationInputTokens;
  const tokenStr = cacheTokens > 0
    ? `${formatTokenCount(baseTokens)} (+${formatTokenCount(cacheTokens)} cache)`
    : formatTokenCount(baseTokens);
  const subagentStr = summary.subagentCount > 0
    ? ` | ${summary.subagentCount} subagent${summary.subagentCount > 1 ? 's' : ''}`
    : '';

  const header = `Session: ${summary.duration} | ${summary.turns} turns | ${tokenStr} tokens${subagentStr}`;

  const lines: string[] = [header, ''];

  for (const entry of summary.entries) {
    const time = formatTime(entry.timestamp);
    let line: string;

    const prefix = `[${time}]`;
    if (entry.type === 'text' && entry.source === 'session') {
      line = `${prefix} "${entry.summary}"`;
    } else {
      line = `${prefix} ${entry.summary}`;
    }

    lines.push(line);
  }

  let result = lines.join('\n');

  // Truncate from the front (keep most recent) if over limit
  if (result.length > maxLength) {
    // Keep header + as many recent lines as fit
    const headerBlock = lines.slice(0, 2).join('\n');
    const entryLines = lines.slice(2);

    const kept: string[] = [];
    let total = headerBlock.length + 20; // reserve for "... (truncated)\n"

    // Build from the end
    for (let i = entryLines.length - 1; i >= 0; i--) {
      const lineLen = entryLines[i].length + 1; // +1 for newline
      if (total + lineLen > maxLength) break;
      total += lineLen;
      kept.unshift(entryLines[i]);
    }

    result = headerBlock + '\n... (truncated)\n' + kept.join('\n');
  }

  // Strip backticks — the caller wraps this in a triple-backtick code block,
  // so embedded backticks would break the Markdown fence.
  return result.replace(/`/g, "'");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  // Collapse newlines/whitespace for display
  const clean = str.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + '...';
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;

  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
