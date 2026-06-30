/**
 * Utilities for parsing and querying Claude Code version strings.
 *
 * Shared between agents.ts (production) and version-capture.test.ts (tests)
 * to avoid logic duplication. See PR #318 review warning #2.
 */

import type { LocalAgent } from '../core/registry.js';

/**
 * Parse the raw output of `claude --version` into a clean version string.
 *
 * Handles:
 *   - Standard output: "claude v2.1.39" → "2.1.39"
 *   - Without "v": "claude 2.1.39" → "2.1.39"
 *   - Plain version: "2.1.39" → "2.1.39"
 *   - Multiline output (e.g. update banners before version line): uses first line only
 *   - Leading/trailing whitespace and newlines
 */
export function parseClaudeVersion(raw: string): string {
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.replace(/^claude\s+v?/i, '').trim();
}

/**
 * Find the Claude Code version from the most recently booted agent.
 * Used by /status command and its callback handler. Extracted to avoid
 * code duplication (PR #318 review warning #1).
 */
export function getLatestClaudeCodeVersion(agents: LocalAgent[]): string | undefined {
  return agents
    .filter(a => a.claudeCodeVersion)
    .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime())
    [0]?.claudeCodeVersion;
}
