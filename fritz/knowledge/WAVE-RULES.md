# Pipeline Rules

> **Purpose:** Documents the invariants and soft defaults fritZ uses when managing
> the pipeline. These are enforced in autoloop code and by fritZ conversationally
> when planning dependencies.

---

## Invariants (enforced in autoloop code)

- **fritz.depends-on blocks** — an issue with `fritz.depends-on:N` will not spawn until issue N
  is closed. Autoloop checks this every cycle.
- **agent-cap** — no more than `maxParallelAgents` active agents at once.

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

## Soft Defaults (fritZ uses when planning conversationally)

- Higher priority issues should be chained/promoted before lower priority ones
- When chaining issues, infer order from content — not just issue number
- Issues without `fritz.repo:` target the default repo (`config.githubRepo`)
- Multiple implement agents can run in parallel on the same repo — use `fritz.depends-on:` to serialize when needed
