# machina Telegram Setup

Teil des [machina Orchestrators](../README.md). Siehe [TELEGRAM_BOT.md](TELEGRAM_BOT.md) für die Befehlsreferenz.

## 1. Bot erstellen

1. Öffne Telegram, suche **@BotFather**
2. Sende `/newbot`
3. Name: `machina` (oder was du willst)
4. Username: `fritz_agent_bot` (muss einzigartig sein)
5. **Kopiere den Token** → sieht aus wie `123456789:ABCdefGHI...`

## 2. Gruppe erstellen (optional)

1. Erstelle neue Gruppe oder nutze Direct Chat mit dem Bot
2. Füge deinen Bot hinzu (suche nach dem Username)
3. Mache den Bot zum Admin (wichtig für Topics!)

### Optional: Topics aktivieren
- Gruppeneinstellungen → Topics aktivieren

## 3. Chat ID herausfinden

```bash
# Setze deinen Token
export TELEGRAM_BOT_TOKEN="dein-token-hier"

# Sende eine Nachricht an den Bot oder in die Gruppe, dann:
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq .

# Finde chat.id:
# - Positive Zahl für Direct Chat
# - Negative Zahl für Gruppen (z.B. -1001234567890)
```

## 4. Environment konfigurieren

Erstelle `fritz-orchestrator/daemon/.env`:
```bash
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
TELEGRAM_CHAT_ID=-1001234567890
GH_TOKEN=ghp_...
GITHUB_REPO=owner/repo
```

## 5. Daemon starten

```bash
cd fritz-orchestrator/daemon
npm install
npm start
```

## 6. Testen

In Telegram:
```text
fritz hallo
fritz status
fritz help
```

Fertig!
