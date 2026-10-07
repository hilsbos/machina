# Pipeline Rules

Documents the invariants and soft defaults machina uses when managing the pipeline. These are enforced in autoloop code and by machina conversationally when planning dependencies.

_Part of the machina [knowledge base](README.md) — read by every agent at boot._

## Invariants (enforced in autoloop code)

> [!IMPORTANT]
> - `fritz.depends-on:N` blocks — an issue with this label will not spawn until issue N is closed. Autoloop checks this every cycle.
> - Agent cap — no more than `maxParallelAgents` active agents run at once.

## Invariants (enforced in agent skills)

- **rebase-only fast-path** — when a review or validate agent is spawned for a PR that
  was previously approved/validated and only contains a rebase (no code diff change),
  the agent re-approves immediately without running a full review/validate cycle.
  This prevents the "rebase loop" pattern where a PR cycles through review+validate
  repeatedly on identical code.
- **merge-conflict context carry-forward** — when an implement agent must create a new
  PR due to merge conflicts, it MUST read all review comments from previous PRs for
  the same issue before starting. This prevents reintroducing previously-caught bugs.
- **fritz.depends-on awareness** — implement agents verify `fritz.depends-on:N` labels at startup
  (defense-in-depth alongside daemon enforcement). Blocked issues report blocked status
  immediately rather than wasting work.

## Soft Defaults (machina uses when planning conversationally)

- Higher priority issues should be chained/promoted before lower priority ones
- When chaining issues, infer order from content — not just issue number
- Issues without `fritz.repo:` target the default repo (`config.githubRepo`)
- Multiple implement agents can run in parallel on the same repo — use `fritz.depends-on:` to serialize when needed

---

_See also: [LABELS.md](LABELS.md) (label and status reference), [ARCHITECTURE.md](ARCHITECTURE.md) (issue workflow), and the [root README](../../README.md)._
