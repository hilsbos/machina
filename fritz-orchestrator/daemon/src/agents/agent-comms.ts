/**
 * Agent communication module — bidirectional messaging with agent containers.
 *
 * All agents use persistent mode by default:
 *   - PERSISTENT (default): A long-running `docker exec -i <container> claude`
 *     process stays alive for the entire session. Messages are piped via stdin,
 *     responses parsed from stdout using `--output-format stream-json`.
 *   - ONE-SHOT (fallback): If a persistent session dies, falls back to spawning
 *     `docker exec <container> claude -p "msg"` per message. Follow-up messages
 *     use `--continue` to resume the conversation.
 *
 * Access is serialized per agent (one message at a time) in both modes.
 *
 * State is modeled as a discriminated union (OneShotState | PersistentState)
 * so each mode only carries its own fields.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import * as registry from '../core/registry.js';
import { getRoleModel, getDefaultModel, getDaemonConfig, getClaudeConfig } from './fritz-config.js';
import { restoreClaudeJsonInContainer, filterClaudeStderr } from '../orchestrator/claude-config-restore.js';

/** Communication mode for an agent. */
export type AgentCommsMode = 'oneshot' | 'persistent';

interface QueuedMessage {
  message: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

// ─── state types (discriminated union) ──────────────────────────────────

interface BaseCommsState {
  mode: AgentCommsMode;
  isBusy: boolean;
  messageQueue: QueuedMessage[];
  activeProcess: ChildProcess | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

export interface OneShotState extends BaseCommsState {
  mode: 'oneshot';
  isFirstMessage: boolean;
}

export interface PersistentState extends BaseCommsState {
  mode: 'persistent';
  stdoutBuffer: string;
  pendingResolve: ((response: string) => void) | null;
  pendingReject: ((error: Error) => void) | null;
  persistentStarted: boolean;
  sessionId: string;
}

export type AgentCommsState = OneShotState | PersistentState;

const agentState: Map<string, AgentCommsState> = new Map();

/** Only allow safe agent names (alphanumeric + hyphens, no shell metacharacters). */
const SAFE_NAME = /^[a-z0-9][a-z0-9\-]*$/;

function log(msg: string): void {
  console.log(`[agent-comms] ${msg}`);
}

const MAX_LOG_ENTRY_CHARS = 4000;

/** Cache workspace paths so we don't hit registry.json on every log append. */
const workspaceCache: Map<string, string> = new Map();

/** Append a log entry to the agent's workspace log file. Non-fatal — errors are logged but never thrown. */
function appendAgentLog(name: string, entry: string): void {
  try {
    let workspace = workspaceCache.get(name);
    if (!workspace) {
      const agent = registry.getAgent(name);
      if (!agent) return;
      workspace = agent.workspace;
      workspaceCache.set(name, workspace);
    }

    const logDir = `${workspace}/.fritz`;
    const logPath = `${logDir}/agent.log`;

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const truncated = entry.length > MAX_LOG_ENTRY_CHARS
      ? entry.slice(0, MAX_LOG_ENTRY_CHARS) + '... (truncated)'
      : entry;
    const timestamp = new Date().toISOString();
    appendFileSync(logPath, `[${timestamp}] ${truncated}\n`);
  } catch (err) {
    // Non-fatal: don't let log writing break agent communication
    console.error(`[agent-comms] Failed to write agent log for ${name}:`, err);
  }
}

// ─── shared helpers ─────────────────────────────────────────────────────

/**
 * Verify that an agent's Docker container is running.
 * Validates the name against SAFE_NAME and checks `docker ps`.
 * Throws if the container is not running.
 */
function verifyContainer(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }

  const containerName = `fritz-agent-${name}`;
  try {
    const status = execSync(`docker ps -q -f "name=${containerName}"`, {
      encoding: 'utf-8',
    }).trim();
    if (!status) {
      throw new Error(`Agent container ${containerName} is not running`);
    }
  } catch {
    throw new Error(`Agent container ${containerName} is not running`);
  }
}

/**
 * Race a promise against a timeout. If the timeout fires first, `onTimeout`
 * is called and its return value is used as the resolution.
 * The timeout is cleared when the inner promise settles.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(onTimeout());
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ─── public API ─────────────────────────────────────────────────────────

/**
 * Initialize communication state for a newly booted agent.
 * @param name - Agent name
 * @param mode - Communication mode: 'persistent' (default) or 'oneshot' (fallback only)
 */
export function initAgent(name: string, mode: AgentCommsMode = 'persistent'): void {
  if (mode === 'persistent') {
    agentState.set(name, {
      mode: 'persistent',
      isBusy: false,
      messageQueue: [],
      activeProcess: null,
      drainTimer: null,
      stdoutBuffer: '',
      pendingResolve: null,
      pendingReject: null,
      persistentStarted: false,
      sessionId: 'default',
    });
  } else {
    agentState.set(name, {
      mode: 'oneshot',
      isBusy: false,
      messageQueue: [],
      activeProcess: null,
      drainTimer: null,
      isFirstMessage: true,
    });
  }
  log(`Initialized comms for ${name} (mode: ${mode})`);
}

/** Clean up state when an agent is stopped / deregistered. */
export function destroyAgent(name: string): void {
  const state = agentState.get(name);
  if (!state) return;

  // Clear pending drain timer
  if (state.drainTimer) {
    clearTimeout(state.drainTimer);
  }

  // Reject pending persistent response
  if (state.mode === 'persistent' && state.pendingReject) {
    state.pendingReject(new Error(`Agent ${name} was stopped`));
    state.pendingResolve = null;
    state.pendingReject = null;
  }

  // Kill any running process (one-shot active process or persistent session)
  if (state.activeProcess && !state.activeProcess.killed) {
    state.activeProcess.kill('SIGTERM');
  }

  // Reject queued messages
  for (const queued of state.messageQueue) {
    queued.reject(new Error(`Agent ${name} was stopped`));
  }

  agentState.delete(name);
  workspaceCache.delete(name);
  log(`Destroyed comms for ${name}`);
}

/** Whether the agent is currently processing a message. */
export function isAgentBusy(name: string): boolean {
  return agentState.get(name)?.isBusy ?? false;
}

/**
 * Get queue information for an agent.
 * Returns position (1-indexed) and total queue length, or null if agent not found.
 */
export function getQueueInfo(name: string): { position: number; queueLength: number } | null {
  const state = agentState.get(name);
  if (!state) return null;

  return {
    position: state.messageQueue.length + 1, // +1 because the new message will be added after
    queueLength: state.messageQueue.length,
  };
}

/**
 * Send a message to a running agent and return its response.
 * If the agent is busy, the message is queued and the promise
 * resolves when it is eventually processed.
 *
 * @param name - Agent name
 * @param message - Message to send
 * @param onProgress - Optional callback invoked with output preview during processing
 */
export async function sendToAgent(
  name: string,
  message: string,
  onProgress?: (preview: string) => void,
): Promise<string> {
  const state = agentState.get(name);
  if (!state) {
    throw new Error(`No comms state for agent ${name} — was initAgent() called?`);
  }

  if (state.isBusy) {
    const { maxQueueSize } = getDaemonConfig();
    if (state.messageQueue.length >= maxQueueSize) {
      throw new Error(`Message queue full for ${name} (${maxQueueSize} messages pending)`);
    }
    log(`Agent ${name} is busy — queuing message (${state.messageQueue.length + 1} in queue)`);
    return new Promise<string>((resolve, reject) => {
      state.messageQueue.push({ message, resolve, reject });
    });
  }

  return executeAndDrain(name, state, message, onProgress);
}

// ─── internals ──────────────────────────────────────────────────────────

async function executeAndDrain(
  name: string,
  state: AgentCommsState,
  message: string,
  onProgress?: (preview: string) => void,
): Promise<string> {
  state.isBusy = true;

  try {
    const response = await executeMessage(name, state, message, onProgress);
    // Re-fetch: fallbackToOneShot may have replaced the state in the map
    const currentState = agentState.get(name) ?? state;
    // Mark first message sent for one-shot (enables --continue on subsequent messages)
    if (currentState.mode === 'oneshot') {
      currentState.isFirstMessage = false;
    }
    return response;
  } finally {
    // Re-fetch: fallbackToOneShot may have replaced the state in the map.
    // Without this, isBusy = false would be set on the old (replaced) state,
    // leaving the new state permanently busy and the agent unresponsive.
    const currentState = agentState.get(name) ?? state;
    currentState.isBusy = false;
    // Drain the next queued message (if any) after a short delay
    if (currentState.messageQueue.length > 0) {
      currentState.drainTimer = setTimeout(() => processQueue(name), 1000);
    }
  }
}

async function processQueue(name: string): Promise<void> {
  const state = agentState.get(name);
  if (!state || state.messageQueue.length === 0) return;

  const next = state.messageQueue.shift()!;
  try {
    const response = await executeAndDrain(name, state, next.message);
    next.resolve(response);
  } catch (err) {
    next.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Dispatch message execution based on agent mode.
 */
async function executeMessage(
  name: string,
  state: AgentCommsState,
  message: string,
  onProgress?: (preview: string) => void,
): Promise<string> {
  if (state.mode === 'persistent') {
    return executePersistentMessage(name, state, message, onProgress);
  }
  return executeOneShotMessage(name, state, message, onProgress);
}

/**
 * Build base Claude CLI flags shared by both one-shot and persistent modes.
 * Includes -p (print mode), skip-permissions, and model selection.
 * Mode-specific flags (e.g. --continue, --output-format) are added by the caller.
 */
function buildClaudeFlags(name: string): string[] {
  const flags: string[] = ['-p'];
  if (getClaudeConfig().claudeSkipPermissions) flags.push('--dangerously-skip-permissions');
  const agent = registry.getAgent(name);
  const model = agent ? getRoleModel(agent.role) : getDefaultModel();
  flags.push('--model', model);
  return flags;
}

// ─── ONE-SHOT MODE ──────────────────────────────────────────────────────

async function executeOneShotMessage(
  name: string,
  state: OneShotState,
  message: string,
  onProgress?: (preview: string) => void,
): Promise<string> {
  verifyContainer(name);

  const containerName = `fritz-agent-${name}`;

  // Pre-restore .claude.json before each one-shot message.
  // Claude removes this file on shutdown, so subsequent messages would
  // trigger the backup warning. No-op when the file already exists.
  await restoreClaudeJsonInContainer(containerName);

  // Build docker exec args
  const claudeFlags = buildClaudeFlags(name);
  if (!state.isFirstMessage) claudeFlags.push('--continue');

  const execArgs = [
    'exec',
    containerName,
    'claude',
    ...claudeFlags,
    message,
  ];

  log(`→ ${name}: ${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);
  appendAgentLog(name, `→ PROMPT: ${message}`);

  // Always resolve (never reject) — callers relay responses to Telegram,
  // so we return error descriptions as strings rather than throwing.
  let stdout = '';
  const innerPromise = new Promise<string>((resolve) => {
    let _stderr = '';

    const proc = spawn('docker', execArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    state.activeProcess = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();

      // Emit progress callback with last meaningful line of output
      if (onProgress) {
        const lines = stdout.split('\n').filter((l) => l.trim());
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1].slice(0, 100);
          onProgress(lastLine);
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      _stderr += data.toString();
    });

    proc.on('close', (code) => {
      state.activeProcess = null;

      const clean = cleanResponse(stdout);
      if (clean) {
        log(`← ${name}: ${clean.slice(0, 80)}${clean.length > 80 ? '...' : ''}`);
        appendAgentLog(name, `← RESPONSE: ${clean}`);
        resolve(clean);
      } else if (code !== 0) {
        log(`← ${name}: error exit code ${code}`);
        appendAgentLog(name, `← ERROR: exit code ${code}`);
        resolve(`(agent error, exit code ${code})`);
      } else {
        appendAgentLog(name, `← (empty response)`);
        resolve('(empty response)');
      }
    });

    proc.on('error', (err) => {
      state.activeProcess = null;
      log(`← ${name}: process error: ${err.message}`);
      appendAgentLog(name, `← ERROR: ${err.message}`);
      resolve(`(error: ${err.message})`);
    });
  });

  return withTimeout(innerPromise, getDaemonConfig().agentMessageTimeoutMs, () => {
    if (state.activeProcess && !state.activeProcess.killed) {
      state.activeProcess.kill('SIGTERM');
    }
    const partial = cleanResponse(stdout);
    log(`← ${name}: timeout (partial: ${partial.length} chars)`);
    appendAgentLog(name, `← TIMEOUT: ${partial || '(no response)'}`);
    return partial || '(timeout — no response)';
  });
}

// ─── PERSISTENT MODE (Agent Teams) ─────────────────────────────────────

/**
 * Start a persistent Claude Code session inside the agent's container.
 * Uses `docker exec -i` with `--output-format stream-json` for turn boundary detection.
 * The process stays alive for the entire agent session.
 *
 * Returns a promise that resolves when the process emits its first stdout/stderr
 * output (indicating it's ready), or after a 5s timeout fallback.
 */
function startPersistentSession(name: string, state: PersistentState): Promise<void> {
  const containerName = `fritz-agent-${name}`;

  // Build claude flags for persistent mode.
  // Both --input-format and --output-format stream-json are required:
  // - --input-format stream-json: accepts NDJSON user messages on stdin (line-by-line),
  //   without waiting for EOF. Plain text stdin waits for EOF, causing the session to hang.
  // - --output-format stream-json: emits NDJSON events on stdout for turn boundary detection.
  // -p (print mode) is included by buildClaudeFlags() — required for --input-format/--output-format.
  const claudeFlags = buildClaudeFlags(name);
  claudeFlags.push('--input-format', 'stream-json');
  claudeFlags.push('--output-format', 'stream-json');
  claudeFlags.push('--verbose');

  const execArgs = [
    'exec',
    '-i',              // Interactive — keep stdin open
    containerName,
    'claude',
    ...claudeFlags,
  ];

  log(`Starting persistent session for ${name}`);
  appendAgentLog(name, `→ PERSISTENT SESSION: starting (flags: ${claudeFlags.join(' ')})`);

  const proc = spawn('docker', execArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  state.activeProcess = proc;
  state.persistentStarted = true;
  state.stdoutBuffer = '';

  // Readiness: resolve when the process produces its first output (stdout or stderr),
  // indicating the Claude process has started. Fallback: configurable timeout (was 5s, see #630).
  const { startupReadinessTimeoutMs } = getDaemonConfig();
  let onReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    onReady = () => resolve();
    const fallbackTimer = setTimeout(() => {
      log(`[persistent:${name}] Startup readiness timeout (${startupReadinessTimeoutMs}ms) — proceeding`);
      onReady = null;
      resolve();
    }, startupReadinessTimeoutMs);

    // Clear the fallback timer once readiness fires
    const originalReady = onReady;
    onReady = () => {
      clearTimeout(fallbackTimer);
      onReady = null;
      originalReady();
    };
  });

  // Handle stdout — accumulate and parse stream-json events
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    state.stdoutBuffer += text;

    // Signal readiness on first output
    if (onReady) onReady();

    // Try to parse complete JSON lines from the buffer
    processStreamBuffer(name, state);
  });

  // Handle stderr — filter known-harmless Claude backup warnings before logging
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = filterClaudeStderr(chunk.toString());
    if (text) {
      log(`[persistent:${name}] stderr: ${text.slice(0, 200)}`);
      // Signal readiness on first stderr output too
      if (onReady) onReady();
    }
  });

  // Handle process exit — persistent session died
  proc.on('close', (code) => {
    log(`[persistent:${name}] Process exited with code ${code}`);
    appendAgentLog(name, `← PERSISTENT SESSION ENDED: exit code ${code}`);

    // If there's a pending response, reject it
    if (state.pendingReject) {
      state.pendingReject(new Error(`Persistent session exited (code ${code})`));
      state.pendingResolve = null;
      state.pendingReject = null;
    }

    state.activeProcess = null;
    state.persistentStarted = false;

    // Fall back to one-shot mode for any remaining queued messages.
    // We mutate mode to 'oneshot' — TypeScript allows this on a mutable variable,
    // and the state will be treated as OneShotState from this point. We set
    // isFirstMessage because the persistent session's conversation context lives
    // in a separate process — one-shot's --continue would reference a
    // non-existent conversation ID, so we start fresh.
    if (state.messageQueue.length > 0) {
      log(`[persistent:${name}] Falling back to one-shot mode for ${state.messageQueue.length} queued messages`);
      fallbackToOneShot(name, state);
    }
  });

  proc.on('error', (err) => {
    log(`[persistent:${name}] Process error: ${err.message}`);
    appendAgentLog(name, `← PERSISTENT SESSION ERROR: ${err.message}`);

    if (state.pendingReject) {
      state.pendingReject(new Error(`Persistent session error: ${err.message}`));
      state.pendingResolve = null;
      state.pendingReject = null;
    }

    state.activeProcess = null;
    state.persistentStarted = false;
    fallbackToOneShot(name, state);
  });

  return readyPromise;
}

/**
 * Replace a persistent state with a fresh one-shot state for fallback.
 * After a persistent session dies, remaining queued messages are handled in one-shot mode.
 *
 * Guarded: only performs the replacement if the current map entry is still `state`.
 * This makes double-calls from close/error handlers harmless — the second call
 * sees a different (already-replaced) entry and returns early.
 */
function fallbackToOneShot(name: string, state: PersistentState): void {
  // Guard: only fallback if the state in the map is still this persistent state
  const current = agentState.get(name);
  if (current !== state) return;  // Already replaced by a previous fallback

  // Kill the persistent process if it's still alive — we're done with it
  if (state.activeProcess && !state.activeProcess.killed) {
    state.activeProcess.kill('SIGTERM');
  }

  const oneshotState: OneShotState = {
    mode: 'oneshot',
    isBusy: state.isBusy,
    messageQueue: state.messageQueue,
    activeProcess: null,
    drainTimer: state.drainTimer,
    isFirstMessage: true,
  };
  agentState.set(name, oneshotState);
}

/**
 * Process the stdout buffer for stream-json events.
 * Each line is a JSON object. We look for a `result` event to detect turn completion.
 */
function processStreamBuffer(name: string, state: PersistentState): void {
  // Split buffer into lines, keeping incomplete last line in buffer
  const lines = state.stdoutBuffer.split('\n');
  state.stdoutBuffer = lines.pop() || ''; // Keep incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Not valid JSON — could be partial line or non-JSON output.
      // This is expected during startup or for non-event output.
      continue;
    }

    // Capture session_id from init or result events for subsequent messages.
    // Claude Code emits session_id in early events; we store it so follow-up
    // NDJSON messages reference the correct session.
    // Log-once guard: only log to daemon console when the value is first captured
    // or changes (not on every stream-json event). Session ID is still recorded
    // in agent.log for debugging.
    if (typeof event.session_id === 'string' && event.session_id !== 'default') {
      const isNew = state.sessionId !== event.session_id;
      state.sessionId = event.session_id;
      if (isNew) {
        log(`[persistent:${name}] Captured session_id: ${state.sessionId}`);
        appendAgentLog(name, `→ SESSION_ID: ${state.sessionId}`);
      }
    }

    // Check for result event — signals turn completion.
    // Resolve/reject are kept outside the JSON parse try-catch so that
    // errors from appendAgentLog or state callbacks propagate correctly
    // rather than being silently swallowed.
    if (event.type === 'result') {
      const responseText = extractResponseFromResult(event);
      if (state.pendingResolve) {
        const clean = cleanResponse(responseText);
        log(`← ${name}: ${clean.slice(0, 80)}${clean.length > 80 ? '...' : ''}`);
        appendAgentLog(name, `← RESPONSE: ${clean}`);
        state.pendingResolve(clean || '(empty response)');
        state.pendingResolve = null;
        state.pendingReject = null;
      }
    }
  }
}

/**
 * Extract the text response from a stream-json result event.
 * The result event contains the assistant's response in various formats.
 */
function extractResponseFromResult(event: Record<string, unknown>): string {
  // stream-json result event structure:
  // { type: "result", result: "text response" }
  // or { type: "result", result: { text: "...", ... } }
  // or { type: "result", content: [{ type: "text", text: "..." }] }
  const result = event.result;

  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;

    // Check for text field
    if (typeof r.text === 'string') {
      return r.text;
    }

    // Check for content array
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c: unknown) => {
          const item = c as Record<string, unknown>;
          return item.type === 'text' && typeof item.text === 'string';
        })
        .map((c: unknown) => (c as Record<string, unknown>).text as string)
        .join('\n');
    }
  }

  // Check top-level content array (alternative format)
  if (Array.isArray(event.content)) {
    return event.content
      .filter((c: unknown) => {
        const item = c as Record<string, unknown>;
        return item.type === 'text' && typeof item.text === 'string';
      })
      .map((c: unknown) => (c as Record<string, unknown>).text as string)
      .join('\n');
  }

  // Fallback: stringify result
  if (result !== undefined) {
    return String(result);
  }

  return '';
}

/**
 * Send a message via persistent session (stdin → stdout).
 * Starts the persistent session on first message.
 */
async function executePersistentMessage(
  name: string,
  state: PersistentState,
  message: string,
  _onProgress?: (preview: string) => void,
): Promise<string> {
  // Start persistent session on first message
  if (!state.persistentStarted) {
    verifyContainer(name);
    // Pre-restore .claude.json before starting the persistent session.
    // Claude removes this file on shutdown, so fresh sessions would
    // trigger the backup warning. No-op when the file already exists.
    const containerName = `fritz-agent-${name}`;
    await restoreClaudeJsonInContainer(containerName);
    // Wait for the persistent process to signal readiness (first output event)
    await startPersistentSession(name, state);
  }

  // If persistent session is dead, fall back to one-shot.
  if (!state.activeProcess || state.activeProcess.killed) {
    log(`[persistent:${name}] Session dead, falling back to one-shot`);
    fallbackToOneShot(name, state);
    const oneshotState = agentState.get(name) as OneShotState;
    return executeOneShotMessage(name, oneshotState, message, _onProgress);
  }

  log(`→ ${name} [persistent]: ${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);
  appendAgentLog(name, `→ PROMPT [persistent]: ${message}`);

  const responsePromise = new Promise<string>((resolve, reject) => {
    // Set up pending response handlers
    state.pendingResolve = resolve;
    state.pendingReject = reject;

    // Write message to stdin
    const stdin = state.activeProcess?.stdin;
    if (!stdin || stdin.destroyed) {
      state.pendingResolve = null;
      state.pendingReject = null;
      log(`[persistent:${name}] stdin unavailable, falling back to one-shot`);
      fallbackToOneShot(name, state);
      const oneshotState = agentState.get(name) as OneShotState;
      executeOneShotMessage(name, oneshotState, message, _onProgress).then(resolve).catch(reject);
      return;
    }

    // Send message as NDJSON (required by --input-format stream-json).
    // Each line is a JSON object representing a user turn.
    // sessionId is "default" for the first message, then captured from Claude's init event.
    const writeOk = stdin.write(buildStreamJsonMessage(message, state.sessionId) + '\n');
    if (!writeOk) {
      // Backpressure — wait for drain before proceeding
      stdin.once('drain', () => {
        log(`[persistent:${name}] stdin drained`);
      });
    }
  });

  return withTimeout(responsePromise, getDaemonConfig().agentMessageTimeoutMs, () => {
    const bufferLen = state.stdoutBuffer.length;
    const partial = cleanResponse(state.stdoutBuffer);
    log(`← ${name} [persistent]: timeout (buffer: ${bufferLen} chars, readable: ${partial.length} chars)`);
    appendAgentLog(name, `← TIMEOUT [persistent]: ${partial || '(no response)'}`);

    state.pendingResolve = null;
    state.pendingReject = null;

    return partial || '(timeout — no response)';
  });
}

// ─── utilities ──────────────────────────────────────────────────────────

function cleanResponse(raw: string): string {
  // Strip ANSI codes first
  const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

  // Try to extract assistant text from NDJSON lines
  const lines = stripped.split('\n');
  const assistantTexts: string[] = [];
  let hasNdjson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(trimmed);
      hasNdjson = true; // At least one valid JSON line = this is NDJSON output

      // Only extract human-readable assistant messages
      if (parsed.type === 'assistant' && parsed.message?.role === 'assistant') {
        const content = parsed.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              assistantTexts.push(block.text);
            }
          }
        } else if (typeof content === 'string') {
          assistantTexts.push(content);
        }
      } else if (parsed.type === 'result') {
        // Extract text from result event (final response)
        const resultText = extractResponseFromResult(parsed);
        if (resultText) assistantTexts.push(resultText);
      } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
        // Extract streaming text fragments
        assistantTexts.push(parsed.delta.text);
      }
      // Skip: toolresult, tool_use, user messages, system events — these are internal
    } catch {
      // Malformed JSON line that starts with '{' — ignore it
    }
  }

  // If we extracted assistant text, use that
  if (assistantTexts.length > 0) {
    return assistantTexts.join('\n\n');
  }

  // If the buffer was NDJSON but had no assistant/result text, never return raw —
  // it likely contains tool results with file contents / secrets
  if (hasNdjson) {
    return '(agent working — no text response yet)';
  }

  // Non-NDJSON output (plain text) — return as-is
  return stripped;
}

/** Build an NDJSON user message for --input-format stream-json. */
function buildStreamJsonMessage(content: string, sessionId: string = 'default'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
}

// ─── test helpers ───────────────────────────────────────────────────────

/** Exported for unit testing only — not part of the public API. */
export const _testing = {
  extractResponseFromResult,
  processStreamBuffer,
  cleanResponse,
  buildStreamJsonMessage,
  verifyContainer,
  withTimeout,
  fallbackToOneShot,
  executeAndDrain,
  agentState,
};
