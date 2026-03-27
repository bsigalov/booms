# Booms On The Way — Oref Alerts Bot

## IMPORTANT: Read the spec first
The full specification is at `docs/superpowers/specs/2026-03-24-booms-bot-spec.md`. Read it before making ANY changes.

## Critical Rules
- **NEVER overwrite working code with inferior versions.** Always check existing implementations before writing new code.
- **NEVER treat the first alert as "early warning" by default.** Check the actual Oref title: "בדקות הקרובות" = early warning.
- **NEVER merge test events with real events.** Events have `isTest` flag.
- **`ended` events are FINAL.** No reopening. New alerts create new events.
- **`waiting` is only reachable from `alert`**, not from `early_warning`.
- **NEVER detect end events by `cat` number.** Only by explicit title "האירוע הסתיים". Cat 10 is used for BOTH early warning and ended.
- **NEVER use substring matching** for geocoding or region lookup. Only exact match or base-name-before-dash.
- **After deploying, always verify container start time** — deploy uses SHA-tagged images + delete+recreate.
- **Skip risk analysis for drone attacks (cat=6).** Only analyze rockets (cat=1).
- **Discussion comments use `reply_to_message_id`** (not `message_thread_id`). Thread detection via `pendingThreadDetection` Map in `pollTelegramCommands`.

## Oref API Categories
| cat | title | meaning |
|---|---|---|
| 1 | ירי רקטות וטילים | Rocket/missile siren |
| 6 | חדירת כלי טיס עוין | Hostile aircraft/drone siren (no risk analysis) |
| 10 | בדקות הקרובות צפויות להתקבל התרעות באזורך | Early warning |
| 10 | האירוע הסתיים | Event ended |

## Architecture
Single-file Node.js ESM application (`oref-alerts.mjs`). Polls:
- Oref alert API (every 1s)
- Telegram bot updates via `getUpdates` POST with `allowed_updates` (every 3s)

## Multi-Event System
`activeEvents` Map — each geographic region gets its own event object with independent lifecycle, channel messages, and map. Events split when settlement centroid is >50km apart (cumulative).

## Discussion Group Threading
1. `updateEventMessage` sends channel post → registers in `pendingThreadDetection` Map
2. `pollTelegramCommands` detects auto-forwarded message (`is_automatic_forward`) → sets `evt.discussionThreadId`
3. `sendDiscussionUpdate` uses `reply_to_message_id` pointing to auto-forwarded message (NOT `message_thread_id`)
4. `getUpdates` must use POST body with `allowed_updates: ["message", "callback_query", "channel_post"]` and `timeout: 0`

## Risk Model
- Rocket interception rate: 85% (Iron Dome). Drones: skipped entirely.
- P(impact within 5km) = P(alarm) × P(miss 15%) × P(populated 15%) × P(within range)
- P(debris within 5km) = P(alarm) × P(intercept 85%) × P(notable 30%) × P(within range)
- P(boom within 25km) = based on nearby interceptions + impacts
- All probabilities are radius-based, not point-based
- See `docs/risk-model.md` for full model documentation

## Geocoding
- **1873 settlement coordinates** from: government ITM CSV, Nominatim, Google Geocoding, Google Places, tzevadom.com
- **1569 polygon boundaries** from: government shapefile (municipalities), Nominatim, tzevadom.com (Oref zones + city subdivisions)
- Cross-validated against Google Places API. 85 wrong entries removed.
- Outlier detection: 3σ from centroid + Israel bounds filter
- Regional councils removed from polygons (huge areas, not settlement shapes)

## Coordinate Convention
All coordinates are `[longitude, latitude]` (GeoJSON convention, NOT `[lat, lng]`).

## Persistent Storage
Azure File Share at `/data/`. Falls back to app dir locally.

## Key Files
- `oref-alerts.mjs` — main bot
- `coords-cache.json` — 1873 settlement coordinates
- `settlement-boundaries.json` — 1569 polygon boundaries (including city subdivisions)
- `oref-regions-official.json` — 30 IDF Home Front Command zones
- `mock-oref-server.mjs` — test scenario replay server
- `map-review.html` — interactive geocoding review tool (Leaflet)
- `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` — specification
- `docs/risk-model.md` — risk algorithm documentation

## Deployment
- GitHub Actions on push to main
- SHA-tagged images (no caching issues)
- Delete old container → create new with `/data/` volume mount
- Health check verification step
- Container: Azure Container Instance, Israel Central

## Bot Commands
- `/test` — replay real recorded scenario via mock server
- `/stop` — cancel active test
- `/status` — system info, memory, active events
- `/style A|B|C|D` — switch message layout style
- `/help` — list commands

## Message Styles
- **A** — Minimal (no emojis)
- **B** — Clean Modern (default)
- **C** — Balanced
- **D** — Emoji-Rich (original)
