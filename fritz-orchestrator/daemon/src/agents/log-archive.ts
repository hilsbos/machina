/**
 * Log archive module — persistent storage for agent execution logs.
 *
 * Archives agent.log and a summary.json to {workspacesDir}/logs/archive/{agent-name}/
 * on every agent exit. These archives survive workspace cleanup and enable:
 *   - Viewing logs for completed/stopped agents via /logs <name>
 *   - Retro agent scanning via /api/archive endpoints
 *   - Tool usage pattern analysis
 *
 * All archive writes use fs.promises (async) to avoid blocking the event loop
 * during mass exit scenarios (20+ agents exiting simultaneously).
 */

import { mkdir, copyFile, writeFile, readFile, rm } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { getDaemonConfig, getRoleModel } from './fritz-config.js';
import type { LocalAgent } from '../core/registry.js';
import { findJsonlFiles, formatSessionForTelegram, type SessionSummary } from './session-parser.js';

// Cap the persisted session timeline to keep archive footprint bounded.
// Aligns with formatSessionForTelegram's documented per-archive ceiling.
const SESSION_TXT_MAX_BYTES = 500_000;

// ─── Types ──────────────────────────────────────────────────────────────

export interface AgentLogSummary {
  name: string;
  role: string;
  issue: number | null;
  issueTitle: string | null;
  repo: string | null;
  branch: string | null;
  started: string;
  ended: string;
  exitStatus: 'completed' | 'dead' | 'expired' | 'stopped';
  exitCode: number | null;
  exitReason: string | null;
  duration: string;
  turns: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  subagentCount: number;
  toolUsage: Record<string, number>;
  lastActivity: string | null;
  model: string;
  invocationMode: string;
  lang: string | null;
}

export interface ArchivedAgent {
  name: string;
  summary: AgentLogSummary;
}

// ─── Archive Writer ─────────────────────────────────────────────────────

/**
 * Archive agent logs to persistent storage on agent exit.
 * Non-fatal — errors are logged but never block agent cleanup.
 */
export async function archiveAgentLogs(
  agent: LocalAgent,
  exitStatus: 'completed' | 'dead' | 'expired' | 'stopped',
  exitCode: number | null,
  exitReason: string | null,
  session: SessionSummary | null,
): Promise<void> {
  try {
    const archiveDir = join(config.workspacesDir, 'logs', 'archive', agent.name);
    await mkdir(archiveDir, { recursive: true });

    // Copy agent.log if it exists
    const agentLogSrc = join(agent.workspace, '.fritz', 'agent.log');
    if (existsSync(agentLogSrc)) {
      await copyFile(agentLogSrc, join(archiveDir, 'agent.log'));
    }

    // Extract tool usage from JSONL (best-effort, async)
    const toolUsage = await extractToolUsage(agent.workspace);

    // Write summary.json
    const summary: AgentLogSummary = {
      name: agent.name,
      role: agent.role,
      issue: agent.issue ?? null,
      issueTitle: agent.issueTitle ?? null,
      repo: agent.repo ?? null,
      branch: agent.branch ?? null,
      started: agent.started,
      ended: new Date().toISOString(),
      exitStatus,
      exitCode,
      exitReason,
      duration: session?.duration ?? '0s',
      turns: session?.turns ?? 0,
      inputTokens: session?.totalInputTokens ?? 0,
      cacheReadInputTokens: session?.totalCacheReadInputTokens ?? 0,
      cacheCreationInputTokens: session?.totalCacheCreationInputTokens ?? 0,
      outputTokens: session?.totalOutputTokens ?? 0,
      subagentCount: session?.subagentCount ?? 0,
      toolUsage,
      lastActivity: agent.lastActivity ?? null,
      model: getRoleModel(agent.role),
      invocationMode: agent.invocationMode ?? 'auto',
      lang: agent.lang ?? null,
    };

    await writeFile(join(archiveDir, 'summary.json'), JSON.stringify(summary, null, 2));

    // Persist the parsed session timeline so the dashboard's Session Log panel
    // can render distinct content for archived agents — workspace JSONL is
    // gone after cleanupWorkspaces runs, so this file becomes the only source.
    // Failure here is non-fatal: getSessionTimeline returns null and the panel
    // hides itself (empty-string contract on the endpoint).
    if (session) {
      try {
        const sessionText = formatSessionForTelegram(session, SESSION_TXT_MAX_BYTES);
        await writeFile(join(archiveDir, 'session.txt'), sessionText);
      } catch (err) {
        console.error(`[archive] Failed to write session.txt for ${agent.name}:`, err);
      }
    }

    console.log(`[archive] Archived logs for ${agent.name}`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`[archive] Failed to archive logs for ${agent.name}:`, err);
  }
}

// ─── Tool Usage Extraction ──────────────────────────────────────────────

/**
 * Extract tool call counts from JSONL files in the agent's workspace.
 * Uses async readFile to avoid blocking the event loop during mass exit.
 * JSONL files are bounded at ~2MB by session-parser.
 * Returns a map of tool name → call count.
 */
async function extractToolUsage(workspace: string): Promise<Record<string, number>> {
  const toolUsage: Record<string, number> = {};
  const claudeProjectsDir = join(workspace, '.claude', 'projects');

  if (!existsSync(claudeProjectsDir)) return toolUsage;

  const jsonlFiles = findJsonlFiles(claudeProjectsDir);

  for (const file of jsonlFiles) {
    // Deduplicate per file: streaming produces multiple JSONL lines per assistant
    // message, so the same tool_use ID can appear in multiple snapshots.
    const seenToolCalls = new Set<string>();

    try {
      const content = await readFile(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);

          // Claude Code nests tool_use inside message.content[] for assistant messages
          if (entry.type === 'assistant' && entry.message?.content) {
            const msgId = entry.message.id;
            const contentItems = Array.isArray(entry.message.content) ? entry.message.content : [];
            for (const item of contentItems) {
              if (item.type === 'tool_use' && item.name && item.name !== 'thinking') {
                const key = `${msgId || ''}:${item.id || item.name}`;
                if (seenToolCalls.has(key)) continue;
                seenToolCalls.add(key);
                toolUsage[item.name] = (toolUsage[item.name] || 0) + 1;
              }
            }
          }

          // Subagent progress entries also contain tool_use in data.message.message.content[]
          if (entry.type === 'progress' && entry.data?.message?.type === 'assistant') {
            const subMsg = entry.data.message.message;
            const subContent = subMsg?.content;
            if (Array.isArray(subContent)) {
              const subMsgId = subMsg?.id;
              for (const item of subContent) {
                if (item.type === 'tool_use' && item.name && item.name !== 'thinking') {
                  const key = `progress:${subMsgId || ''}:${item.id || item.name}`;
                  if (seenToolCalls.has(key)) continue;
                  seenToolCalls.add(key);
                  toolUsage[item.name] = (toolUsage[item.name] || 0) + 1;
                }
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return toolUsage;
}

// ─── Archive Reader ─────────────────────────────────────────────────────

/**
 * Read archived log for a completed agent.
 * Returns formatted log text with a header showing agent metadata,
 * or null if no archive exists for this agent.
 */
export function getArchivedLog(name: string, lines: number = 50): { log: string; totalLines: number } | null {
  const archiveDir = join(config.workspacesDir, 'logs', 'archive', name);
  const archiveLog = join(archiveDir, 'agent.log');
  const archiveSummary = join(archiveDir, 'summary.json');

  if (!existsSync(archiveDir)) {
    return null;
  }

  let header = '(archived)';
  if (existsSync(archiveSummary)) {
    try {
      const meta = JSON.parse(readFileSync(archiveSummary, 'utf-8'));
      const issue = meta.issue ? `#${meta.issue}` : '—';
      header = `(archived) ${meta.role} | issue ${issue} | ${meta.exitStatus} | ${meta.duration} | ${meta.turns} turns`;
    } catch { /* ignore */ }
  }

  if (!existsSync(archiveLog)) {
    return { log: `${header}\n(no log file in archive)`, totalLines: 0 };
  }

  const content = readFileSync(archiveLog, 'utf-8');
  const allLines = content.split('\n').filter(l => l.trim());
  const lastLines = allLines.slice(-lines);
  const log = `${header}\n${(lastLines.join('\n') || '(no output)').replace(/`/g, "'")}`;
  return { log, totalLines: allLines.length };
}

/**
 * Get archived summary for a single agent by name (O(1) lookup).
 * Returns null if no archive exists for this agent.
 */
export function getArchivedSummary(name: string): AgentLogSummary | null {
  const summaryPath = join(config.workspacesDir, 'logs', 'archive', name, 'summary.json');
  if (!existsSync(summaryPath)) return null;

  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Archive Listing ────────────────────────────────────────────────────

/**
 * List archived agents, optionally filtered by role, issue, or date.
 * Returns agents sorted by ended timestamp (newest first).
 */
export function listArchivedAgents(filter?: {
  role?: string;
  issue?: number;
  since?: string;
}): ArchivedAgent[] {
  const archiveDir = join(config.workspacesDir, 'logs', 'archive');
  if (!existsSync(archiveDir)) return [];

  const results: ArchivedAgent[] = [];

  let entries: string[];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const summaryPath = join(archiveDir, entry, 'summary.json');
    if (!existsSync(summaryPath)) continue;

    try {
      const summary: AgentLogSummary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

      // Apply filters
      if (filter?.role && summary.role !== filter.role) continue;
      if (filter?.issue && summary.issue !== filter.issue) continue;
      if (filter?.since) {
        const sinceMs = new Date(filter.since).getTime();
        const endedMs = new Date(summary.ended).getTime();
        if (endedMs < sinceMs) continue;
      }

      results.push({ name: entry, summary });
    } catch { /* skip malformed entries */ }
  }

  // Sort by ended timestamp, newest first
  results.sort((a, b) => {
    const aMs = new Date(a.summary.ended).getTime();
    const bMs = new Date(b.summary.ended).getTime();
    return bMs - aMs;
  });

  return results;
}

// ─── Build Artifact Stripping ───────────────────────────────────────────

/**
 * Strip build artifact directories from a workspace's project/ subdirectory.
 * Called after archiveAgentLogs on agent exit to reclaim disk space.
 * Non-fatal — errors are logged but never block agent cleanup.
 *
 * Uses daemon.cleanupArtifactGlobs from fritz.yaml (default: target, node_modules, build, .venv).
 */
export async function stripBuildArtifacts(workspace: string): Promise<{ stripped: string[]; errors: string[] }> {
  const result: { stripped: string[]; errors: string[] } = { stripped: [], errors: [] };
  const projectDir = join(workspace, 'project');

  if (!existsSync(projectDir)) return result;

  const globs = getDaemonConfig().cleanupArtifactGlobs;
  for (const glob of globs) {
    const artifactPath = join(projectDir, glob);
    if (!existsSync(artifactPath)) continue;

    try {
      await rm(artifactPath, { recursive: true, force: true });
      result.stripped.push(glob);
    } catch (err) {
      result.errors.push(`Failed to strip ${glob}: ${err}`);
    }
  }

  if (result.stripped.length > 0) {
    console.log(`[cleanup] Stripped build artifacts from ${workspace.split('/').pop()}: ${result.stripped.join(', ')}`);
  }

  return result;
}

// ─── Archive Cleanup ────────────────────────────────────────────────────

export interface ArchiveCleanupResult {
  removed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Remove archived logs older than maxAgeDays.
 * Uses summary.ended timestamp for age (not filesystem mtime).
 * Runs as part of the watchdog check cycle.
 */
export function cleanupLogArchive(maxAgeDays: number): ArchiveCleanupResult {
  const result: ArchiveCleanupResult = { removed: [], skipped: [], errors: [] };
  const archiveDir = join(config.workspacesDir, 'logs', 'archive');

  if (!existsSync(archiveDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return result;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const fullPath = join(archiveDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch { continue; }

    if (maxAgeDays > 0) {
      // Use summary.json 'ended' timestamp for age (not filesystem mtime)
      const summaryPath = join(fullPath, 'summary.json');
      let endedMs = 0;
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        endedMs = new Date(summary.ended).getTime();
      } catch {
        // No valid summary — fall back to directory mtime
        try { endedMs = statSync(fullPath).mtimeMs; } catch { continue; }
      }

      if (now - endedMs < maxAgeMs) {
        result.skipped.push(entry);
        continue;
      }
    }

    try {
      rmSync(fullPath, { recursive: true, force: true });
      result.removed.push(entry);
      console.log(`[cleanup] Removed archived logs: ${entry}`);
    } catch (err) {
      result.errors.push(`Failed to remove archive ${entry}: ${err}`);
    }
  }

  return result;
}
