# machina monitoring

An optional observability stack for machina — **Prometheus** (metrics),
**Grafana** (dashboards), **Loki + Promtail** (logs), **Alertmanager** (Telegram
alerts), plus **node-exporter** and **cAdvisor** for host/container metrics.

It runs as its own Docker Compose project and is wired so the machina daemon can
reach it: the daemon proxies to `fritzmonitor-prometheus` (PromQL) and
`fritzmonitor-static`, so those container names are kept here on purpose.

## Quick start

```bash
cd monitoring
cp .env.example .env        # set GRAFANA_ADMIN_PASSWORD and (optional) Telegram alerting
docker compose up -d
```

| Service | URL (bound to 127.0.0.1) |
|---|---|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| Loki | http://localhost:3100 |

All ports bind to `127.0.0.1` only — put Grafana behind your own
reverse proxy / auth before exposing it (see the repo `SECURITY.md`).

## Connecting it to machina

Both stacks share a Docker network named `monitoring`. Whichever project starts
first creates it; attach the other as an external network. To let the machina
containers reach Prometheus/Grafana, add to machina's compose:

```yaml
networks:
  monitoring:
    external: true
```

and put the relevant machina services `networks: [monitoring]`.

## What's here (v1)

A deliberately **generic** stack: the compose, Prometheus/Loki/Promtail/
Alertmanager configs, Grafana provisioning, and an `.env.example`. The
config files contain example scrape jobs and a sample log-to-metric pipeline —
adapt the container-name patterns to your own services.

**No prebuilt dashboards ship in v1.** Drop your own dashboard JSON into
`grafana/dashboards/` (auto-provisioned) and alert rules into `alerts/`.

## Alerting

`alertmanager.template.yml` is rendered at container start with
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from `.env`. **Never hardcode tokens**
in the template — keep them in `.env` (git-ignored).
