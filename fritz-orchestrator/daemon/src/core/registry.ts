/**
 * Local registry - only tracks local state (process, workspace)
 * GitHub is the source of truth for agent coordination.
 *
 * Uses an in-memory cache as the source of truth during runtime.
 * File persistence is debounced (at most every 1s) to avoid
 * blocking the event loop on every state change.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import type { AgentRole, InvocationMode } from '../types.js';
import { getRoleTtl, getDaemonConfig } from '../agents/fritz-config.js';

const REGISTRY_FILE = `${config.workspacesDir}/registry.json`;

// ---------------------------------------------------------------------------
// Change event hooks (used by dashboard SSE)
// ---------------------------------------------------------------------------

type AgentChangeEvent = 'registered' | 'updated' | 'deregistered';
type AgentChangeCallback = (agent: LocalAgent, event: AgentChangeEvent) => void;
const changeListeners = new Set<AgentChangeCallback>();

/** Subscribe to agent change events. Returns an unsubscribe function. */
export function onAgentChange(callback: AgentChangeCallback): () => void {
  changeListeners.add(callback);
  return () => { changeListeners.delete(callback); };
}

/**
 * Notify listeners asynchronously via setImmediate() so the registry
 * operation returns immediately. Shallow-copies the agent to prevent
 * mutation between dispatch and execution.
 */
function notifyChange(agent: LocalAgent, event: AgentChangeEvent): void {
  if (changeListeners.size === 0) return;
  const snapshot = { ...agent };
  setImmediate(() => {
    for (const cb of changeListeners) {
      try { cb(snapshot, event); } catch (e) { console.error('[registry] Change listener error:', e); }
    }
  });
}

// In-memory state (source of truth during runtime)
let registryCache: LocalRegistry = { agents: {} };
let isDirty = false;
let persistTimer: NodeJS.Timeout | null = null;
let initialized = false;

// Local agent info (what we need to manage processes)
export interface LocalAgent {
  name: string;
  role: AgentRole;
  issue: number | null;
  repo: string | null;
  branch: string | null;     // Target branch (for lifecycle message display)
  workspace: string;
  pid?: number;
  containerId?: string; // For Docker mode
  started: string;
  ttl: number;
  issueTitle?: string;       // Fetched from GitHub on boot
  lastActivity?: string;     // Last status message text
  lastActivityAt?: string;   // ISO timestamp of last activity (display only — does not affect TTL)
  invocationMode?: InvocationMode;  // 'standalone' or 'orchestrated' (default: 'orchestrated')
  apiToken?: string;  // Per-agent API token for authenticating daemon API calls (issue #290)
  claudeCodeVersion?: string;  // Claude Code CLI version running in container
  lang?: string | null;          // Language variant (e.g. 'java', 'cpp'), null = base image
  exitCode?: number | null;      // Set before deregistration so SSE events include it
  exitStatus?: 'completed' | 'dead' | 'expired' | 'stopped';  // Set before deregistration
}

interface LocalRegistry {
  agents: Record<string, LocalAgent>;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Load registry from file on first access, then return in-memory cache. */
function loadRegistry(): LocalRegistry {
  if (!initialized) {
    init();
  }
  return registryCache;
}

/** Update in-memory cache and schedule debounced persistence. */
function saveRegistry(registry: LocalRegistry): void {
  registryCache = registry;
  isDirty = true;
  schedulePersist();
}

/** Schedule a debounced write to disk. */
function schedulePersist(): void {
  if (persistTimer) return; // Already scheduled
  persistTimer = setTimeout(() => {
    if (isDirty) {
      try {
        ensureDir(REGISTRY_FILE);
        writeFileSync(REGISTRY_FILE, JSON.stringify(registryCache, null, 2));
        isDirty = false;
      } catch (err) {
        console.warn(`[registry] Failed to persist registry to disk: ${err}`);
      }
    }
    persistTimer = null;
  }, getDaemonConfig().persistDebounceMs);
}

/** Initialize registry cache from file. Called once on first access or explicitly on startup. */
export function init(): void {
  ensureDir(REGISTRY_FILE);
  if (existsSync(REGISTRY_FILE)) {
    try {
      const data = readFileSync(REGISTRY_FILE, 'utf-8');
      registryCache = JSON.parse(data);
    } catch {
      registryCache = { agents: {} };
    }
  } else {
    registryCache = { agents: {} };
  }
  initialized = true;
}

/** Flush pending writes to disk immediately. Call on graceful shutdown. */
export function flush(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (isDirty) {
    try {
      ensureDir(REGISTRY_FILE);
      writeFileSync(REGISTRY_FILE, JSON.stringify(registryCache, null, 2));
    } catch (err) {
      console.warn(`[registry] Failed to flush registry to disk: ${err}`);
    }
    isDirty = false;
  }
}

// Register a new local agent
export function registerAgent(
  name: string,
  role: AgentRole,
  options: {
    issue?: number;
    repo?: string;
    branch?: string;
    ttl?: number;
    workspace?: string;
    invocationMode?: InvocationMode;
    apiToken?: string;
  } = {}
): LocalAgent {
  const registry = loadRegistry();

  const agent: LocalAgent = {
    name,
    role,
    issue: options.issue || null,
    repo: options.repo || null,
    branch: options.branch || null,
    workspace: options.workspace || `${config.workspacesDir}/${name}`,
    ttl: options.ttl ?? getRoleTtl(role),
    started: new Date().toISOString(),
    invocationMode: options.invocationMode,
    apiToken: options.apiToken,
  };

  registry.agents[name] = agent;
  saveRegistry(registry);
  notifyChange(agent, 'registered');

  return agent;
}

// Update container ID (for Docker mode)
export function updateContainer(name: string, containerId: string): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].containerId = containerId;
    saveRegistry(registry);
    notifyChange(registry.agents[name], 'updated');
  }
}

// Update issue title (fetched from GitHub on boot)
export function updateIssueTitle(name: string, title: string): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].issueTitle = title;
    saveRegistry(registry);
    notifyChange(registry.agents[name], 'updated');
  }
}

// Update last activity (from agent notifications)
export function updateActivity(name: string, message: string): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].lastActivity = message;
    registry.agents[name].lastActivityAt = new Date().toISOString();
    saveRegistry(registry);
    notifyChange(registry.agents[name], 'updated');
  }
}

// Update language variant (set once at boot from fritz.lang: label)
export function updateLang(name: string, lang: string | null): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].lang = lang;
    saveRegistry(registry);
  }
}

// Update Claude Code version (captured from container after boot)
export function updateClaudeCodeVersion(name: string, version: string): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].claudeCodeVersion = version;
    saveRegistry(registry);
    notifyChange(registry.agents[name], 'updated');
  }
}

// Update exit info on agent before deregistration (so SSE events include it).
// No save/notify — this is always followed immediately by deregisterAgent,
// which persists and notifies. If the daemon crashes between updateExitInfo
// and deregisterAgent, exit info is lost from disk — acceptable because the
// agent entry itself would also be stale (not a regression from pre-#651).
export function updateExitInfo(name: string, exitCode: number | null, exitStatus: 'completed' | 'dead' | 'expired' | 'stopped'): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].exitCode = exitCode;
    registry.agents[name].exitStatus = exitStatus;
  }
}

// Remove agent from local registry
export function deregisterAgent(name: string): LocalAgent | null {
  const registry = loadRegistry();
  const agent = registry.agents[name];
  if (agent) {
    delete registry.agents[name];
    saveRegistry(registry);
    notifyChange(agent, 'deregistered');
  }
  return agent || null;
}

// Get a specific agent
export function getAgent(name: string): LocalAgent | null {
  const registry = loadRegistry();
  return registry.agents[name] || null;
}

// List all local agents
export function listAgents(): LocalAgent[] {
  const registry = loadRegistry();
  return Object.values(registry.agents);
}

// Record activity for an agent (updates lastActivityAt for display only — does not affect TTL).
export function touchAgent(name: string): void {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    registry.agents[name].lastActivityAt = new Date().toISOString();
    saveRegistry(registry);
  }
}

// Get expired agents — wall-clock TTL from agent.started.
// Agents with TTL=0 (long-running mode) never expire via TTL.
export function getExpiredAgents(): LocalAgent[] {
  const now = Date.now();
  return listAgents().filter(a => {
    if (a.ttl === 0) return false; // Long-running: never expires via TTL
    const expires = new Date(a.started).getTime() + a.ttl * 1000;
    return now > expires;
  });
}

// Clear all local agents
export function clearAll(): void {
  saveRegistry({ agents: {} });
}
