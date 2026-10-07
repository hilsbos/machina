# Shared Knowledge Base

A collective memory that all agents contribute to and learn from.

_Every machina agent reads this knowledge base at boot before starting work. See the [root README](../../README.md) for the full system overview._

## Structure

```text
fritz/knowledge/
├── README.md              # This file
├── ARCHITECTURE.md        # System architecture & component design
├── CODEBASE.md            # Project-specific knowledge
├── DECISIONS.md           # Architectural decisions log
├── GOTCHAS.md             # Known issues & workarounds
├── LABELS.md              # GitHub label system reference
├── LANGUAGES.md           # Language support & Docker images
├── OPERATIONS.md          # Data lifecycle, retention & cleanup mechanisms
├── PRINCIPLES.md          # Core engineering principles
├── SKILL-MODES.md         # Orchestrated vs standalone skill modes
└── entries/               # Individual knowledge entries
    └── *.yaml
```

## How It Works

1. **Agents contribute** - After completing tasks, agents add knowledge
2. **Knowledge is reviewed** - Major additions trigger Telegram notification
3. **Agents consume** - All agents read knowledge base before starting work
4. **Knowledge evolves** - Outdated entries are pruned or updated

## Entry Format

```yaml
# fritz/knowledge/entries/{id}.yaml

id: kb-20250125-001
type: pattern          # pattern | gotcha | decision | context
category: testing      # testing | architecture | tooling | api | etc.
title: "Mock external APIs in tests"
content: |
  When testing code that calls external APIs, always use mocks.
  Our project uses msw (Mock Service Worker) for this.

  Example setup in: src/test/mocks/handlers.ts
created_by: implement-agent
created_at: 2025-01-25T10:30:00Z
source_issue: 42
confidence: high       # high | medium | low
verified: true         # Human verified
tags:
  - testing
  - mocking
  - api
```

## Categories

| Category | Description |
|----------|-------------|
| `architecture` | System design, structure decisions |
| `patterns` | Reusable solutions, best practices |
| `gotchas` | Known issues, workarounds |
| `tooling` | Build tools, dev environment |
| `api` | API contracts, integrations |
| `testing` | Test strategies, fixtures |
| `security` | Auth, permissions, secrets |
| `performance` | Optimization patterns |
| `conventions` | Code style, naming |

## Notification Rules

Major edits trigger Telegram notification:
- New `architecture` or `security` entries
- Changes to `decision` type entries
- Entries marked `confidence: high`
- Deletions of verified entries

---

_See also: [ARCHITECTURE.md](ARCHITECTURE.md) (system design), [LABELS.md](LABELS.md) (label system), [OPERATIONS.md](OPERATIONS.md) (data lifecycle), and the [root README](../../README.md)._
