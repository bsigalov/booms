# Booms On The Way

Real-time Israel Home Front Command (Oref) alert bot for Telegram with advanced risk prediction.

## Features

- **Real-time alerts** — Polls Oref API every second, sends to Telegram channel
- **Alert maps** — Static map with red pins on alert locations + blue pin on home
- **PCA ellipse analysis** — Fits ellipse to alert pattern to determine missile trajectory
- **4 probability predictions**:
  - P(alert) — Will an alert reach your area?
  - P(impact) — Missile landing near you?
  - P(debris) — Interception shrapnel near you?
  - P(boom) — Will you hear explosions?
- **Expansion tracking** — Detects if alerts are expanding toward your location
- **Single updating message** — Edits existing map in channel instead of spamming
- **1,183 geocoded settlements** with coordinate cache
- **30 official Oref regions** mapped from IDF Home Front Command document

## Setup

```bash
npm install
```

### Environment Variables

```bash
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your private chat id>
TELEGRAM_CHANNEL_ID=@your_channel    # optional, defaults to @booms_on_the_way
HOME_COORD=[34.8113,31.8928]          # optional, [lng,lat] defaults to Rehovot
HOME_NAME=רחובות                       # optional
```

### Run Locally

```bash
cp .env.example .env  # edit with your values
node --env-file=.env oref-alerts.mjs
```

### Deploy to Azure (Israel Central)

```bash
az group create --name oref-bot-rg --location israelcentral
az acr create --name orefbotacr --resource-group oref-bot-rg --sku Basic
az acr build --registry orefbotacr --image oref-bot:latest .
az container create \
  --resource-group oref-bot-rg --name oref-bot \
  --image orefbotacr.azurecr.io/oref-bot:latest \
  --location israelcentral --os-type Linux \
  --cpu 0.5 --memory 0.5 --restart-policy Always \
  --environment-variables TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/test` | Send a random test alert with map + risk analysis |
| `/status` | Check bot uptime and settlement count |
| `/help` | Show available commands |

## Algorithm

The risk prediction uses:

1. **PCA ellipse fitting** on alert coordinates to determine missile trajectory azimuth
2. **Position classification** — where you are relative to the ellipse (START=debris, END=missile)
3. **Expansion tracking** — are alerts moving toward or away from you?
4. **Historical correlation** — region co-occurrence and impact base rates

## Data Files

| File | Description |
|------|-------------|
| `coords-cache.json` | 1,183 geocoded settlement coordinates |
| `oref-regions-official.json` | 30 Oref alert regions with settlement mapping |
| `oref-regions.pdf` | Source: IDF Home Front Command policy document |

## Channel

Telegram: [@booms_on_the_way](https://t.me/booms_on_the_way)
