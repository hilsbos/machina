# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Report a vulnerability) on this repository, or email the maintainer
at the address listed on their GitHub profile.

We aim to acknowledge reports within 5 business days.

## Trust boundary — read before deploying

This project **executes AI-generated code and shell commands inside Docker
containers** and exposes an HTTP API and dashboard. Treat it as a powerful tool
that can take real actions (create issues/PRs, run commands, push images).

Operational guidance:

- **Never expose the daemon's HTTP port or dashboard directly to the public
  internet.** It assumes a trusted network (localhost / VPN / reverse proxy with
  authentication). Put it behind your own auth (mTLS, a VPN such as Tailscale,
  or an authenticating reverse proxy).
- **Scope your tokens.** The Telegram bot token, `GH_TOKEN`, and any API keys
  grant real privileges. Use least-privilege GitHub tokens and restrict the bot
  to your own chat ID (`TELEGRAM_CHAT_ID`).
- **The Kali / pentest agent image is for authorized testing only.** Only point
  it at systems you own or are explicitly authorized to test.
- Secrets live in `.env` files that are git-ignored. Never commit real secrets;
  a pre-commit secret scanner (e.g. `gitleaks`) is recommended.
