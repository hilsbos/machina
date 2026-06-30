# machina

**AI agent orchestration via Telegram.** Talk to Claude Code from your phone.

> The orchestration daemon and its container images are named `fritz-orchestrator`
> internally (the project's original codename). "machina" is the public project name.

```
You (Telegram) → "fritz erstelle ein issue für dark mode"
                          ↓
                  fritZ orchestrator
                          ↓
               Creates GitHub issue #47
                          ↓
You (Telegram) ← "✅ Issue #47 erstellt: Dark mode feature"
```

## Quick Start

```bash
cd fritz-orchestrator/daemon
npm install
npm run build
npm start
```

Then in Telegram: `fritz hallo`

## Features

- **Chat with Claude Code** via Telegram
- **Spawn agents** for GitHub issues (`fritz boot implement 42`)
- **Monitor agents** with watchdog
- **Two modes**: Quick API chat or full Claude Code

## Documentation

### Main Documentation
- [fritZ Daemon Documentation](fritz-orchestrator/README.md)
- [Quick Start Guide](fritz-orchestrator/docs/QUICK-START.md)
- [Deployment Guide](fritz-orchestrator/docs/DEPLOYMENT.md)

### Additional Resources
- [HTTP API Reference](fritz-orchestrator/docs/API.md)
- [Telegram Setup](fritz-orchestrator/docs/TELEGRAM_SETUP.md)
- [Security Best Practices](fritz-orchestrator/docs/SECURITY.md)
- [CI/CD Setup](fritz-orchestrator/docs/CI-CD.md)
- [Skills Reference](.claude/skills/)
- [Knowledge Base](fritz/knowledge/)
- [Operations & Data Lifecycle](fritz/knowledge/OPERATIONS.md)

## Architecture

```
fritz-orchestrator/   # Node.js orchestration daemon
.claude/
├── skills/           # Agent role definitions (implement, review, etc.)
└── orchestrator/     # Orchestrator skill + knowledge
fritz/
└── knowledge/        # Shared agent knowledge base
docs/                 # Architecture & evolution docs
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions, and
[SECURITY.md](SECURITY.md) for the security policy and deployment trust boundary.

## License

[MIT](LICENSE) © Patrick Hilsbos

> **Naming note:** "fritZ" is an internal project name. It is unaffiliated with
> AVM GmbH or the "FRITZ!" product family. If you fork this for wider
> distribution, consider choosing a distinct name.
