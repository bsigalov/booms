# Booms On The Way — Oref Alerts Bot

## IMPORTANT: Read the spec first
The full specification is at `docs/superpowers/specs/2026-03-24-booms-bot-spec.md`. Read it before making ANY changes. It defines the event lifecycle, Telegram behavior, map generation, geocoding, and testing requirements.

## Critical Rules
- **NEVER overwrite working code with inferior versions.** Always check existing implementations before writing new code.
- **NEVER treat the first alert as "early warning" by default.** Check the actual Oref title/category.
- **NEVER merge test events with real events.**
- **`ended` events are FINAL.** No reopening. New alerts create new events.
- **`waiting` is only reachable from `alert`**, not from `early_warning`.

## Architecture
Single-file Node.js ESM application (`oref-alerts.mjs`). Runs as a long-lived process polling:
- Oref alert API (every 1s)
- Telegram bot commands (every 3s)

## Multi-Event System
`activeEvents` Map — each geographic region gets its own event object with independent lifecycle, channel messages, and map. Events split when settlement centroid is >50km apart (cumulative).

## Coordinate Convention
All coordinates are `[longitude, latitude]` (GeoJSON/staticmaps convention, NOT `[lat, lng]`).

## Persistent Storage
Azure File Share at `/data/`. All logs, scenarios, feedback, history written there. Falls back to app dir if `/data/` not mounted.

## Key Files
- `oref-alerts.mjs` — main bot (single file)
- `coords-cache.json` — 1252+ settlement coordinates
- `settlement-boundaries.json` — polygon data for 78+ settlements
- `oref-regions-official.json` — 30 IDF Home Front Command zones
- `mock-oref-server.mjs` — test scenario replay server
- `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` — full specification

## Deployment
Azure Container Instance, Israel Central. GitHub Actions on push to main.
`az acr build` → `az container create` with `/data/` volume mount.

## Testing
`/test` command redirects alert URL to mock server that replays real recorded scenarios. Test events labeled with `🧪 [טסט]` and isolated from real events.
