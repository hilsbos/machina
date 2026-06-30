# Contributing to fritZ

Thanks for your interest in contributing! This document covers how to set up the
project and the conventions we follow.

## Project layout

```
fritz-orchestrator/   # Node.js/TypeScript orchestration daemon (the core)
  daemon/             #   src, tests, package.json
  Dockerfile*         #   daemon + agent container images
  docker-compose*.yml #   local + production compose
.claude/
  skills/             # Agent role definitions (implement, review, ux, ...)
  orchestrator/       # Orchestrator skill + knowledge
fritz/
  knowledge/          # Shared agent knowledge base (architecture, patterns)
docs/                 # Architecture and evolution docs
```

## Development setup

Requirements: Node.js 20+, Docker, and (optionally) the Claude Code CLI.

```bash
cd fritz-orchestrator/daemon
npm ci
npm run build
npm test
```

Copy `.env.example` to `.env` and fill in your own values (Telegram bot token,
chat ID, optional GitHub token). See `.env.example` for the full list.

## Quality gate

CI runs the following — please make sure they pass locally before opening a PR:

```bash
npm run typecheck   # tsc --noEmit
npm run lint
npm run build
npm test
```

## Conventions

- **Branches:** `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- **Commits:** short imperative subject lines.
- **Pull requests:** describe the change and link any related issue. Keep PRs
  focused and reasonably small.
- **Agent skills** live in `.claude/skills/` — each is a `SKILL.md` describing a
  role. Improvements to these are welcome.

## Secrets

Never commit real secrets. `.env`, runtime state, and agent workspaces are
git-ignored. Running a secret scanner (e.g. `gitleaks`) before pushing is
encouraged.

## Code of Conduct

Be respectful and constructive. By participating you agree to uphold a welcoming
and harassment-free environment for everyone.
