# Booms On The Way — Oref Alerts Bot

## Architecture
Single-file Node.js ESM application (`oref-alerts.mjs`) with no framework. Runs as a long-lived process polling two sources:
- Oref alert API (every 1s)
- Telegram bot commands (every 3s)

## Key Components

### Alert Flow
`fetchAlerts()` → `resolveCoords()` → `analyzeRisk()` → `sendTelegram()` + `sendTelegramPhoto()`

### Risk Engine (lines ~247-580)
- `fitEllipse(coords)` — PCA on alert coordinates, returns semi-axes + azimuth
- `classifyHomePosition(ellipse, home)` — Where is home relative to ellipse (START/END/CENTER/NEAR/FAR)
- `trackExpansion(coords)` — Detect if alerts expand toward home using centroid drift
- `calculatePAlert/PImpact/PDebris/PBoom` — Four probability functions
- `analyzeRisk()` — Orchestrator that calls all above and returns combined result

### Geocoding
- `CITY_COORDS` — Hardcoded ~130 major cities
- `coords-cache.json` — Extended cache with 1,183 settlements (loaded at startup via `Object.assign`)
- `fuzzyMatch(place)` — Partial string matching for variants like "אשקלון - דרום"
- `geocode(place)` — Falls back to Nominatim OSM API (1 req/sec rate limit)

### Regions
- `oref-regions-official.json` — 30 zones from IDF Home Front Command document
- `REGION_MAP` — Loaded at startup: settlement name → region name
- `summarizeAreas(areas)` — Reduces 100+ settlements to "region (city1, city2 ועוד)"

### Telegram
- Channel (`TELEGRAM_CHANNEL_ID`) — Public alert broadcasts
- Private chat (`TELEGRAM_CHAT_ID`) — Bot commands + personal notifications
- `sendTelegramPhoto()` — Uses `editMessageMedia` to update existing map in channel
- `lastMapMessageId` — Tracks which message to edit

### Map Generation
- Uses `staticmaps` package with OpenStreetMap tiles
- Red pins (alert locations) + blue pin (home)
- SVG markers rendered to PNG via `sharp`
- Output: 800x600 PNG at `/tmp/oref-alert-map.png`

## Coordinate Convention
All coordinates are `[longitude, latitude]` (GeoJSON/staticmaps convention, NOT `[lat, lng]`).

## Environment Variables
Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
Optional: `TELEGRAM_CHANNEL_ID`, `HOME_COORD`, `HOME_NAME`

## Testing
Send `/test` to bot in private chat — picks random scenario, generates map + risk analysis, sends to both channel and private chat.

## Deployment
Azure Container Instance in Israel Central region (important: Oref API may block non-Israeli IPs).
Docker image built via `az acr build`. Container has `--restart-policy Always`.

## Dependencies
- `staticmaps` — Static map generation from OSM tiles
- `sharp` — SVG to PNG rendering (transitive via staticmaps)
