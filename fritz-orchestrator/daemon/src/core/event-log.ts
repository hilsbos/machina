/**
 * Persistent structured event log.
 *
 * Appends events to {workspacesDir}/logs/events.jsonl.
 * Capped at 500 entries (trimmed on daemon startup).
 * Supports SSE push via onEventLogEntry callbacks.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

export interface EventLogEntry {
  seq: number;                         // Monotonically incrementing sequence number, starts at 1
  ts: string;                          // ISO timestamp
  type: string;                        // 'agent.started', 'agent.stopped', etc.
  msg: string;                         // Human-readable one-liner
  meta?: Record<string, unknown>;      // Optional structured metadata
}

const MAX_ENTRIES = 500;
const entryCallbacks = new Set<(entry: EventLogEntry) => void>();

let eventSeq = 0;  // increments on every logEvent() call
const EVENT_BUFFER_SIZE = 200;
const eventRingBuffer: EventLogEntry[] = [];

function getLogsDir(): string {
  return join(config.workspacesDir, 'logs');
}

function getEventLogPath(): string {
  return join(getLogsDir(), 'events.jsonl');
}

function ensureLogsDir(): void {
  const dir = getLogsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a structured event to the log file (synchronous, non-fatal on error).
 * Also notifies registered SSE callbacks.
 */
export function logEvent(type: string, msg: string, meta?: Record<string, unknown>): void {
  const seq = ++eventSeq;
  const entry: EventLogEntry = {
    seq,
    ts: new Date().toISOString(),
    type,
    msg,
    ...(meta !== undefined ? { meta } : {}),
  };

  try {
    ensureLogsDir();
    appendFileSync(getEventLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Non-fatal — event log is best-effort
  }

  // Notify SSE callbacks regardless of file write success
  for (const cb of entryCallbacks) {
    try { cb(entry); } catch { /* ignore */ }
  }

  // Add to ring buffer (after callbacks so consumers see disk-consistent data)
  eventRingBuffer.push(entry);
  if (eventRingBuffer.length > EVENT_BUFFER_SIZE) {
    eventRingBuffer.shift();
  }
}

/**
 * Read recent events from disk, newest first.
 */
export function getRecentEvents(limit = 50): EventLogEntry[] {
  try {
    const path = getEventLogPath();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const entries: EventLogEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as EventLogEntry); } catch { /* skip malformed */ }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/**
 * Returns all buffered events with seq > sinceSeq.
 * Used by the SSE handler to replay missed events on reconnect.
 */
export function getEventsSince(sinceSeq: number): EventLogEntry[] {
  return eventRingBuffer.filter(e => e.seq > sinceSeq);
}

/**
 * Register a callback to be called on every new event (for SSE push).
 * Returns an unsubscribe function.
 */
export function onEventLogEntry(cb: (entry: EventLogEntry) => void): () => void {
  entryCallbacks.add(cb);
  return () => { entryCallbacks.delete(cb); };
}

/**
 * Trim the event log to the last MAX_ENTRIES entries.
 * Call once at daemon startup to prevent unbounded growth.
 */
export function trimOnStartup(): void {
  try {
    const path = getEventLogPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > MAX_ENTRIES) {
      const trimmed = lines.slice(-MAX_ENTRIES);
      writeFileSync(path, trimmed.join('\n') + '\n', 'utf-8');
    }
  } catch {
    // Non-fatal
  }

  // Hydrate ring buffer from disk so reconnecting clients can get catch-up events
  const existing = getRecentEvents(EVENT_BUFFER_SIZE);
  // getRecentEvents returns newest-first; reverse to get chronological order
  for (const entry of existing.slice().reverse()) {
    // Assign seq numbers to historical entries if they don't have one
    if (!entry.seq) {
      (entry as EventLogEntry).seq = ++eventSeq;
    } else {
      eventSeq = Math.max(eventSeq, entry.seq);
    }
    eventRingBuffer.push(entry);
  }
}
