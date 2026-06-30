/**
 * Claude Code config restore utility.
 *
 * Claude Code backs up `.claude.json` and removes the original on shutdown.
 * On the next startup it warns about the missing file before restoring from
 * backup. Since the orchestrator container is long-lived and sessions start/stop
 * frequently, this produces noisy logs (3 warnings per session start).
 *
 * This module provides two defenses:
 * 1. **Pre-restore**: Before spawning Claude, restore `.claude.json` from the
 *    latest backup so the warning never fires. This is a no-op when the file
 *    already exists.
 * 2. **Stderr filter**: Strip known-harmless backup warning lines from stderr
 *    output as defense-in-depth.
 */

import { execFile } from 'child_process';
import type { ChildProcess, ExecFileOptions } from 'child_process';

/**
 * Shell script that restores `.claude.json` from Claude Code's backup directory.
 * Safe to run when the file already exists (the `if` guard makes it a no-op).
 * Safe to run when no backups exist (ls fails silently).
 *
 * Backup filenames are `.claude.json.backup.<timestamp>` — `ls | tail -1`
 * picks the lexicographically last (most recent) one. This is safe because
 * backup filenames use numeric timestamps with no special characters.
 */
const RESTORE_SCRIPT = [
  'if [ ! -f "$HOME/.claude.json" ]; then',
  '  BACKUP_DIR="$HOME/.claude/backups"',
  '  if [ -d "$BACKUP_DIR" ]; then',
  '    LATEST=$(ls "$BACKUP_DIR" 2>/dev/null | tail -1)',
  '    if [ -n "$LATEST" ]; then',
  '      cp "$BACKUP_DIR/$LATEST" "$HOME/.claude.json" 2>/dev/null',
  '    fi',
  '  fi',
  'fi',
// '\n' not '&&': shell if/then/fi requires newlines between keywords and body commands.
].join('\n');

/**
 * Run the restore script, optionally prefixed with a command (e.g. `docker exec <container>`).
 * Uses `execFile` to avoid shell interpolation — the script is passed as a single
 * argument to `sh -c`, so `&&` is interpreted by the inner shell as intended.
 *
 * Best-effort: resolves on success, error, or timeout (5s). Never rejects.
 */
function runRestoreScript(prefix: string[] = []): Promise<void> {
  const args = [...prefix, 'sh', '-c', RESTORE_SCRIPT];
  const file = args[0];
  const rest = args.slice(1);
  const opts: ExecFileOptions = { timeout: 5000 };

  return new Promise<void>((resolve) => {
    const child: ChildProcess = execFile(file, rest, opts, () => resolve());
    child.on('error', () => resolve());
  });
}

/**
 * Pre-restore `.claude.json` inside a Docker container.
 * Runs `docker exec <containerName> sh -c <restore-script>`.
 * Best-effort — never throws.
 */
export async function restoreClaudeJsonInContainer(containerName: string): Promise<void> {
  return runRestoreScript(['docker', 'exec', containerName]);
}

/**
 * Pre-restore `.claude.json` on the local filesystem (native mode).
 * Runs `sh -c <restore-script>` directly.
 * Best-effort — never throws.
 */
export async function restoreClaudeJsonLocal(): Promise<void> {
  return runRestoreScript();
}

/**
 * Regex matching Claude Code's `.claude.json` backup warning lines.
 * Three variants are emitted per session start:
 * 1. "Claude configuration file not found at: ..."
 * 2. "A backup file exists at: ..."
 * 3. "You can manually restore it by running: cp ..."
 *
 * Each pattern is anchored to avoid false positives.
 */
const CLAUDE_BACKUP_WARNING = /^Claude configuration file not found at:|^A backup file exists at:|^You can manually restore it by running: cp/;

/**
 * Filter known-harmless Claude Code backup warning lines from stderr output.
 *
 * Operates per-chunk (best-effort): splits on newlines and removes matching
 * lines. Partial lines at chunk boundaries may not be caught — this is
 * acceptable as defense-in-depth alongside the pre-restore fix.
 *
 * @returns Filtered stderr text with warning lines removed. May be empty.
 */
export function filterClaudeStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !CLAUDE_BACKUP_WARNING.test(line.trim()))
    .join('\n')
    .trim();
}

/** Exported for unit testing only. */
export const _testing = {
  RESTORE_SCRIPT,
  CLAUDE_BACKUP_WARNING,
};
