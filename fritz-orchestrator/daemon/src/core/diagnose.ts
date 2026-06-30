/**
 * Diagnosis module — computes local file hashes, fetches remote state from
 * GitHub tree API, compares, and produces a freshness report.
 *
 * Runs entirely within the daemon process (no containers spawned).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import * as registry from './registry.js';
import * as watchdog from './watchdog.js';
import {
  gitBlobHash,
  hashDirectory,
  compareStates,
  type FileHash,
  type DirectoryState,
  type DriftItem,
} from './diagnose-utils.js';

// Re-export pure utilities and types so existing imports (e.g. telegram.ts)
// continue to work without changes.
export {
  gitBlobHash,
  hashDirectory,
  compareStates,
} from './diagnose-utils.js';
export type {
  FileHash,
  DirectoryState,
  DriftItem,
} from './diagnose-utils.js';

// ---------------------------------------------------------------------------
// Types (diagnosis-specific, not shared with utils)
// ---------------------------------------------------------------------------

export interface ComponentDiagnosis {
  name: 'skills' | 'knowledge' | 'config';
  status: 'current' | 'stale' | 'error' | 'unknown';
  localState: DirectoryState | null;
  remoteState: DirectoryState | null;
  drift: DriftItem[];
  message: string;
}

export interface AgentSnapshot {
  name: string;
  role: string;
  bootedAt: string;
  issue?: number;
}

export interface DiagnosisReport {
  overallStatus: 'healthy' | 'stale' | 'error';
  components: ComponentDiagnosis[];
  activeAgents: AgentSnapshot[];
  orchestrator: { running: boolean; uptime?: string };
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Remote state from GitHub tree API
// ---------------------------------------------------------------------------

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

/**
 * Fetch the full GitHub tree for a branch (recursive).
 * Uses: GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
 *
 * Call once, then pass the result to filterTreeToDirectory() for each prefix.
 */
async function fetchFullTree(
  repoSlug: string,
  branch: string
): Promise<GitHubTreeEntry[]> {
  const url = `https://api.github.com/repos/${repoSlug}/git/trees/${branch}?recursive=1`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'fritZ-daemon',
  };

  if (config.ghToken) {
    headers.Authorization = `token ${config.ghToken}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as { tree: GitHubTreeEntry[]; truncated: boolean };
  return data.tree;
}

/**
 * Filter pre-fetched tree entries to files under a given prefix,
 * returning a DirectoryState.
 */
function filterTreeToDirectory(
  tree: GitHubTreeEntry[],
  dirPrefix: string
): DirectoryState {
  // Normalise prefix: ensure it ends with /
  const prefix = dirPrefix.endsWith('/') ? dirPrefix : dirPrefix + '/';

  const files: FileHash[] = tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({
      path: e.path.slice(prefix.length),
      hash: e.sha,
      size: e.size ?? 0,
    }));

  return {
    files,
    totalFiles: files.length,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Config freshness
// ---------------------------------------------------------------------------

function getConfigFreshness(): ComponentDiagnosis {
  try {
    // In Docker, config lives at /app/config/fritz.yaml
    // Locally, at fritz-orchestrator/config/fritz.yaml
    const isDocker = existsSync('/.dockerenv');
    const configPath = isDocker
      ? '/app/config/fritz.yaml'
      : join(config.fritzRoot, 'fritz-orchestrator', 'config', 'fritz.yaml');

    if (!existsSync(configPath)) {
      return {
        name: 'config',
        status: 'error',
        localState: null,
        remoteState: null,
        drift: [],
        message: 'Config file not found',
      };
    }

    const content = readFileSync(configPath);
    const hash = gitBlobHash(content);

    return {
      name: 'config',
      status: 'current',
      localState: {
        files: [{ path: 'fritz.yaml', hash, size: content.length }],
        totalFiles: 1,
        computedAt: new Date().toISOString(),
      },
      remoteState: null,
      drift: [],
      message: 'Config loaded',
    };
  } catch (err) {
    return {
      name: 'config',
      status: 'error',
      localState: null,
      remoteState: null,
      drift: [],
      message: `Config check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main diagnosis
// ---------------------------------------------------------------------------

export async function runDiagnosis(): Promise<DiagnosisReport> {
  const components: ComponentDiagnosis[] = [];
  const isDocker = existsSync('/.dockerenv');

  // Determine local paths for skills and knowledge
  const skillsDir = isDocker
    ? '/app/.claude/skills'
    : join(config.fritzRoot, '.claude', 'skills');
  const knowledgeDir = isDocker
    ? '/app/fritz/knowledge'
    : join(config.fritzRoot, 'fritz', 'knowledge');

  // GitHub repo and branch for remote comparison
  const repoSlug = config.githubRepo;
  const branch = 'main';
  const canCompareRemote = !!repoSlug && !!config.ghToken;

  // Fetch the full GitHub tree once and reuse for all three components
  let tree: GitHubTreeEntry[] | null = null;
  if (canCompareRemote) {
    try {
      tree = await fetchFullTree(repoSlug!, branch);
    } catch {
      // Tree fetch failed — all remote comparisons will degrade gracefully
      tree = null;
    }
  }

  // --- Skills ---
  try {
    const localSkills = hashDirectory(skillsDir);

    if (tree) {
      const remoteSkills = filterTreeToDirectory(tree, '.claude/skills');
      const drift = compareStates(localSkills, remoteSkills);
      const status = drift.length === 0 ? 'current' : 'stale';
      components.push({
        name: 'skills',
        status,
        localState: localSkills,
        remoteState: remoteSkills,
        drift,
        message:
          status === 'current'
            ? `All ${localSkills.totalFiles} files current`
            : `${drift.length} file(s) differ from ${branch}`,
      });
    } else {
      components.push({
        name: 'skills',
        status: canCompareRemote ? 'error' : 'unknown',
        localState: localSkills,
        remoteState: null,
        drift: [],
        message: canCompareRemote
          ? 'GitHub API request failed'
          : cannotCompareMessage(),
      });
    }
  } catch (err) {
    components.push({
      name: 'skills',
      status: 'error',
      localState: null,
      remoteState: null,
      drift: [],
      message: `Skills check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // --- Knowledge ---
  try {
    const localKnowledge = hashDirectory(knowledgeDir);

    if (tree) {
      const remoteKnowledge = filterTreeToDirectory(tree, 'fritz/knowledge');
      const drift = compareStates(localKnowledge, remoteKnowledge);
      const status = drift.length === 0 ? 'current' : 'stale';
      components.push({
        name: 'knowledge',
        status,
        localState: localKnowledge,
        remoteState: remoteKnowledge,
        drift,
        message:
          status === 'current'
            ? `All ${localKnowledge.totalFiles} files current`
            : `${drift.length} file(s) differ from ${branch}`,
      });
    } else {
      components.push({
        name: 'knowledge',
        status: canCompareRemote ? 'error' : 'unknown',
        localState: localKnowledge,
        remoteState: null,
        drift: [],
        message: canCompareRemote
          ? 'GitHub API request failed'
          : cannotCompareMessage(),
      });
    }
  } catch (err) {
    components.push({
      name: 'knowledge',
      status: 'error',
      localState: null,
      remoteState: null,
      drift: [],
      message: `Knowledge check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // --- Config ---
  const configDiag = getConfigFreshness();

  // If we have the remote tree, also check config against GitHub
  if (tree && configDiag.localState) {
    const remoteConfig = filterTreeToDirectory(tree, 'fritz-orchestrator/config');
    const drift = compareStates(configDiag.localState, remoteConfig);
    configDiag.remoteState = remoteConfig;
    configDiag.drift = drift;
    configDiag.status = drift.length === 0 ? 'current' : 'stale';
    configDiag.message =
      drift.length === 0
        ? 'Config is current'
        : `Config differs from ${branch}`;
  }
  components.push(configDiag);

  // --- Active agents ---
  const localAgents = registry.listAgents();
  const activeAgents: AgentSnapshot[] = localAgents.map((a) => ({
    name: a.name,
    role: a.role,
    bootedAt: a.started,
    issue: a.issue ?? undefined,
  }));

  // --- Orchestrator status ---
  const watchdogStatus = await watchdog.getStatus();
  const orchestratorInfo = {
    running: watchdogStatus.running,
    uptime: undefined as string | undefined,
  };

  // --- Overall status ---
  const hasStale = components.some((c) => c.status === 'stale');
  const hasError = components.some((c) => c.status === 'error');
  const overallStatus: DiagnosisReport['overallStatus'] = hasError
    ? 'error'
    : hasStale
      ? 'stale'
      : 'healthy';

  return {
    overallStatus,
    components,
    activeAgents,
    orchestrator: orchestratorInfo,
    generatedAt: new Date().toISOString(),
  };
}

function cannotCompareMessage(): string {
  if (!config.githubRepo) return 'Cannot compare — GITHUB_REPO not configured';
  if (!config.ghToken) return 'Cannot compare — GH_TOKEN not configured';
  return 'Cannot compare against remote';
}
