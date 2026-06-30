/**
 * Knowledge and identity loading utilities for the orchestrator.
 *
 * Extracted to allow direct testing without importing config-dependent modules.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Intentionally minimal fallback identity, used only when SKILL.md is missing.
 * This is NOT kept in sync with SKILL.md — it provides basic functionality
 * so the orchestrator can boot without the external file. The full identity
 * (including /refresh docs, Kontext section, etc.) lives in SKILL.md.
 */
export const DEFAULT_IDENTITY = `Du bist fritZ, dein AI Orchestrator.

## Wer du bist
- Persistenter Claude Code Agent
- Kommunizierst mit dem Owner via Telegram
- Kannst andere Agents spawnen für Tasks
- Voller Zugriff auf Code, Git, GitHub

## Fähigkeiten
- GitHub Issues (gh CLI)
- Code lesen/verstehen
- Git Operationen
- Agents spawnen: implement, review, validate, define, architect, ux, budget, retro
- Daemon API abfragen (Logs, Archive, Agent-Summaries)

## Daemon API Zugriff

Du kannst die Daemon API via curl aufrufen:
\`\`\`bash
curl -s -H "Authorization: Bearer \$FRITZ_API_TOKEN" \$FRITZ_API_URL/api/archive              # Alle archivierten Agents
curl -s -H "Authorization: Bearer \$FRITZ_API_TOKEN" \$FRITZ_API_URL/api/archive/{name}/log    # Agent-Log
curl -s -H "Authorization: Bearer \$FRITZ_API_TOKEN" \$FRITZ_API_URL/api/archive/{name}/summary # Agent-Summary (JSON)
\`\`\`

Verfügbare Endpoints:
- GET /api/archive — Liste aller archivierten Agents (params: role, issue, since, limit)
- GET /api/archive/:name/log — Vollständiger Log (param: lines, default 50)
- GET /api/archive/:name/summary — JSON Summary (tokens, tools, duration)

## Telegram Commands
Der Owner kann folgende Befehle direkt in Telegram nutzen:
- /boot <role> [issue] [repo] — Agent starten
- /tell <agent-name> <nachricht> — Nachricht an laufenden Agent senden
- /stop <agent-name> — Agent stoppen
- /logs <agent-name> — Agent-Logs anzeigen
- /status — Alle Agents anzeigen
Wenn der Owner dich bittet, einem Agent etwas zu sagen, weise ihn auf /tell hin.
Er kann auch auf Agent-Nachrichten in Telegram antworten (reply-to).

## Regeln
- Kurze Antworten (Telegram!)
- Proaktiv und hilfreich
- Repo: {{GITHUB_REPO}}
- Bei größeren Tasks: Agent spawnen`;

/**
 * Load orchestrator identity from SKILL.md with hardcoded fallback.
 * @param fritzRoot - Root directory of the fritZ project
 * @param githubRepo - GitHub repo identifier to inject
 * @param logFn - Optional logging function (defaults to no-op)
 */
export function loadOrchestratorIdentity(
  fritzRoot: string,
  githubRepo: string | undefined,
  logFn: (msg: string) => void = () => {}
): string {
  const skillPath = resolve(fritzRoot, '.claude/orchestrator/SKILL.md');
  let identity: string;
  if (existsSync(skillPath)) {
    identity = readFileSync(skillPath, 'utf-8');
    logFn('Loaded orchestrator identity from SKILL.md');
  } else {
    identity = DEFAULT_IDENTITY;
    logFn('SKILL.md not found, using hardcoded fallback identity');
  }
  // Inject runtime values
  return identity.replaceAll('{{GITHUB_REPO}}', githubRepo || '(not configured)');
}

/**
 * Copy knowledge files from source directory to target directory.
 * @param srcDir - Source directory to copy from
 * @param targetDir - Target directory to copy to
 * @param logFn - Optional logging function (defaults to no-op)
 */
export function copyKnowledge(
  srcDir: string,
  targetDir: string,
  logFn: (msg: string) => void = () => {}
): void {
  if (!existsSync(srcDir)) return;

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    const files = readdirSync(srcDir);
    let copied = 0;
    for (const file of files) {
      const srcPath = join(srcDir, file);
      const targetPath = join(targetDir, file);
      try {
        cpSync(srcPath, targetPath, { recursive: true });
        copied++;
      } catch (err: unknown) {
        logFn(`⚠ Failed to copy knowledge file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (copied > 0) {
      logFn(`Copied ${copied} knowledge file(s) from ${srcDir}`);
    }
  } catch (err: unknown) {
    logFn(`⚠ Failed to read knowledge directory ${srcDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
