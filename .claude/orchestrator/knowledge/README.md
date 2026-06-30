# Orchestrator Knowledge

Place daemon-specific knowledge files in this directory.

These files are copied **only** to the orchestrator workspace, not to agent workspaces. Use this for operational context that is relevant to the persistent orchestrator but not to task-oriented agents.

## Examples of what to put here
- Deployment procedures and checklists
- Monitoring and alerting tips
- Known issues and workarounds
- User preferences and communication style notes
- Environment-specific configuration notes

## How it works
1. Files here are copied to the orchestrator's `.fritz/knowledge/` directory at startup
2. They are copied **after** the shared `fritz/knowledge/` files, so they can override same-named files
3. Use `/refresh` in Telegram to reload knowledge without restarting the daemon
