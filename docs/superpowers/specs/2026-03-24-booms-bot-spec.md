# Booms On The Way — Bot Specification

## 1. System Overview

**"בומים בדרך" (Booms On The Way)** — a Telegram bot that monitors IDF Home Front Command (Oref) alerts in real-time, enriches them with risk analysis, maps, and geographic context, and broadcasts to a Telegram channel with a linked discussion group.

**Architecture:** Single-file Node.js ESM application (`oref-alerts.mjs`), long-lived process, no framework. Polls two sources:
- Oref alert API (every 1 second)
- Telegram bot updates via `getUpdates` (every 3 seconds)

**Deployment:** Azure Container Instance (Israel Central), Docker image built in ACR, deployed via GitHub Actions on push to `main`. Persistent storage via Azure File Share mounted at `/data/`.

**Audience:** Personal/family use. Technical detail is acceptable.

**Bot value:** The combination of risk analysis, visual mapping, and fast aggregation of alert waves into a single evolving message.

### Module Boundaries (future extraction candidates)

| Module | Responsibility |
|---|---|
| Geocoding | coords-cache, fuzzyMatch, Nominatim fallback, outlier detection |
| Regions | oref-regions, REGION_MAP, summarizeAreas |
| Risk Engine | PCA ellipse, home position, probability calculations |
| Map Generator | staticmaps, polygons, circles, wave coloring |
| Event Lifecycle | multi-event state machine, merge/split logic |
| Telegram | sendMessage, sendPhoto, editMessage, polling |
| Discussion Group | cross-chat replies, comments on channel posts |
| Simulation | mock Oref server, scenario replay |
| Persistence | /data/ file I/O, scenario saving |

---

## 2. Event Lifecycle State Machine

Each geographic event is an independent object in `activeEvents` Map with its own state, channel messages, and lifecycle.

### States

- **null** — no active event
- **early_warning** — Oref sent `cat=10` with title "בדקות הקרובות צפויות להתקבל התרעות באזורך"
- **alert** — actual siren: `cat=1` "ירי רקטות וטילים", `cat=6` "חדירת כלי טיס עוין"
- **ended** detection: `cat=10` with title "האירוע הסתיים"

**Oref API categories (from raw data analysis 2026-03-24):**
| cat | title | meaning |
|---|---|---|
| 1 | ירי רקטות וטילים | Rocket/missile siren |
| 6 | חדירת כלי טיס עוין | Hostile aircraft siren |
| 10 | בדקות הקרובות צפויות להתקבל התרעות באזורך | Early warning |
| 10 | האירוע הסתיים | Event ended |
- **waiting** — no new alerts for 2 minutes. **Only reachable from `alert`**, not from `early_warning`.
- **ended** — Oref sent explicit "event ended" message, OR 20-minute safety timeout from `waiting` with no activity
- **cleanup** — 15 minutes after ended, event removed from `activeEvents`

### State Diagram

```
null → early_warning → alert → waiting → ended → cleanup
null → alert → waiting → ended → cleanup
                 ↑         |
                 └─────────┘  (new alert during waiting)
```

### Transitions

| From | To | Trigger |
|---|---|---|
| null | early_warning | Oref alert with early warning title |
| null | alert | Oref alert with siren title |
| early_warning | alert | Oref alert with siren title (same geographic area) |
| alert | waiting | 2 minutes of empty API responses (15 seconds in simulation) |
| waiting | alert | New Oref alert arrives for this event |
| waiting | ended | Explicit Oref "event ended" message (cat/title match) |
| waiting | ended | 20-minute safety timeout with no activity |
| ended | cleanup | 15 minutes after ended |

### Key Rules

- **`early_warning` does NOT transition to `waiting`** — stays until a real alert arrives or gets cleaned up
- **`ended` is final** — no reopening. New alerts in the same region always create a fresh event
- **No merge window for ended events** — once ended, the event is done

### Multi-Event Splitting

- When a new alert arrives, compute centroid of its settlements
- Compare to centroid of each active event's **cumulative** settlements
- If within **50km** → merge into existing event
- If >50km or no active events → create new event
- Test events (`isTest: true`) never merge with real events and vice versa

### Merge Window

Dynamic, scales with event size: `Math.min(15, 5 + floor(settlements / 50))` minutes. Only applies to `waiting → alert` transitions (reopening during waiting). Does NOT apply to ended events.

---

## 3. Telegram Channel Behavior

### Channel Posts Per Event

- **1 text message** — created on first alert, edited in place with every update
- **1 map image** — created on first alert, edited in place with every map update

### Text Message Headers

| Phase | Header |
|---|---|
| early_warning | ⚠️ התרעה מוקדמת באזורים: ... |
| alert | 🚨 אזעקה באזורים: ... |
| waiting | 🟡 שהייה במקלטים ב: ... |
| ended | ✅ אירוע הסתיים ב: ... |

### History Timeline

Appended to the message as a blockquote. Each entry shows:
- Timestamp
- Correct emoji based on **actual Oref content** (⚠️ for early warning, 🚨 for siren) — NOT based on arrival order
- Description with region/settlement summary

### Discussion Group (Comments)

**Critical requirement.** All updates must appear as **comments on the channel post**, not standalone messages.

Implementation: `reply_parameters` with cross-chat reply (`reply_parameters.chat_id` = channel ID, `reply_parameters.message_id` = channel post message ID). If this approach fails, must switch to webhook mode.

- Each lifecycle event gets a comment: new alert, expansion, wave, waiting, ended
- Comments include full settlement list and raw Oref text in blockquote
- **Boom button ("💥 שמעתם בום?") posted after every comment**
- Discussion comments skipped only if `TELEGRAM_DISCUSSION_ID` is not set

### Test Messages

- Labeled: `🧪 [טסט — אין להסתמך על הודעה זו]`
- **Identical to real events in every other way** — same channel posts, same maps, same discussion comments
- Never merge with real events
- Based on real recorded scenarios with full settlement lists

---

## 4. Map Generation

### Settlement Rendering

- **Polygons** for all settlements that have boundary data in `settlement-boundaries.json`
  - Start with >10K population settlements (78 currently)
  - Expand to all settlements over time
- **1km radius circles** for settlements without polygon data
- **Early warning** areas rendered with distinct background color (orange fill) separate from alert colors

### Wave Coloring

Each wave rendered in a **visually distinct color**. Colors must be clearly distinguishable — not shades of the same hue. Example palette: red, purple, blue, teal, green, deep orange, pink, deep purple.

### Map Settings

- 800x600 PNG
- OpenStreetMap tiles
- Home marker: blue dot
- Zoom range: min 7, max 15
- Shows **current wave** settlements only (resets when entering `waiting`)

### Outlier Detection

After resolving all settlements in an alert batch:
1. Compute centroid and standard deviation of resolved coordinates
2. Any settlement >3 standard deviations from centroid is **suspicious**
3. Suspicious settlements: logged with `[geocode:outlier]`, **excluded from map**, still counted in text
4. Prevents misplaced markers from bad geocoding

---

## 5. Geocoding & Coordinate Resolution

### Resolution Chain

1. **Exact match** in `coords-cache.json` (1252+ settlements)
2. **Base-name match** — split on " - " separator only (e.g., "אשקלון - דרום" → "אשקלון")
3. **Nominatim OSM API** fallback (1 req/sec rate limit)
4. If all fail → log as missing, skip from map

### Rules

- **No substring matching.** Only exact match or base-name-before-dash match. The old `place.includes(city)` pattern caused 88 dangerous mismatches.
- **Coordinate convention:** All coordinates are `[longitude, latitude]` (GeoJSON convention).

### Settlement Boundaries

- `settlement-boundaries.json` — polygon data from Nominatim OSM
- Currently 78 settlements with polygons (>10K population)
- Goal: expand to all settlements over time
- Stored in container image (rebuilt on deploy)

---

## 6. Risk Analysis Engine

### Pipeline

1. `fitEllipse(coords)` — PCA on alert settlement coordinates → semi-axes + azimuth
2. `classifyHomePosition(ellipse, home)` — home relative to alert ellipse: START, END, CENTER, NEAR, FAR
3. `trackExpansion(coords)` — detect if centroid drifts toward home over successive waves
4. Four probability functions:
   - `calculatePAlert` — probability of siren at home
   - `calculatePImpact` — probability of missile impact near home
   - `calculatePDebris` — probability of debris/shrapnel
   - `calculatePBoom` — probability of audible explosion
5. `analyzeRisk()` — orchestrates all above, returns combined result
6. `formatRiskMessage()` — formats for Telegram (distance, direction, probabilities with emoji indicators)

### Display Rules

- Risk analysis shown during `early_warning` and `alert` phases only
- Removed during `waiting` and `ended`
- Correlation index rebuilt periodically from `/data/alert-history.json`

---

## 7. Logging & Persistence

### Persistent Storage

Azure File Share mounted at `/data/`. Fallback to app directory if not available.

### Persistent Files

| File | Purpose |
|---|---|
| `/data/oref-raw-alerts.jsonl` | Raw Oref JSON — every alert as received, timestamped |
| `/data/alert-timestamps.jsonl` | Alert metadata — time, phase, regions, settlement count |
| `/data/test-scenarios.json` | Top 10 biggest real events for test replay |
| `/data/feedback-log.json` | Boom questionnaire reports |
| `/data/alert-history.json` | Historical events for correlation |
| `/data/correlation-index.json` | Risk probability calibration data |
| `/data/oref-forwarded-msgs.jsonl` | Forwarded Telegram messages for analysis |

### Log Tags (stdout)

| Tag | Content |
|---|---|
| `[alert][REAL/TEST]` | Every new alert — ID, category, title, full settlement list |
| `[lifecycle][regionKey]` | State transitions with context |
| `[geocode]` | Every resolution — method used, coordinates |
| `[geocode:outlier]` | Suspicious settlements far from alert centroid |
| `[map]` | Every rendered settlement — POLYGON/CIRCLE, coordinates, color |
| `[telegram]` | Every API call — method, chat, message ID, success/failure |
| `[discussion]` | Discussion group comment status |
| `[sim]` | Simulation wave timing and progress |
| `[scenarios]` | Scenario save/load operations |

### Log Access

```bash
az container logs --resource-group oref-bot-rg --name oref-bot
```

Container logs reset on restart. Critical data persists in `/data/` files.

---

## 8. Simulation & Testing

### Architecture

A mock Oref server replays recorded real scenarios. The bot's `ALERT_URL` is temporarily redirected — all processing goes through the normal `fetchAlerts()` pipeline.

### Recording

- Every real alert saved to `/data/oref-raw-alerts.jsonl` with timestamp
- When a real event ends, its wave structure saved to `/data/test-scenarios.json`
- Top 10 biggest events kept (by settlement count), smallest dropped when exceeded

### Mock Server

- Standalone script (`mock-oref-server.mjs`) serving pre-recorded Oref JSON
- Reads a scenario from `test-scenarios.json`
- Replays waves with realistic timing, compressed to 2 minutes total
- Serves the "event ended" message at the end
- Runs on a local port inside the container

### Test Flow

1. User sends `/test`
2. Bot starts mock server, switches `ALERT_URL` to `http://localhost:<port>`
3. Bot processes through normal `fetchAlerts()` — same code path as real alerts
4. Events created with `isTest: true` → label added to all messages
5. Channel posts, maps, discussion comments — all identical to real, except label
6. Mock server finishes → sends end event → bot switches `ALERT_URL` back
7. `/stop` to abort early

### Test Isolation

- `isTest` flag stored on event object (persists after sim ends)
- Test events never merge with real events
- Scenario selection: random from `test-scenarios.json`, fallback to built-in seeds

---

## 9. Implementation Status

| # | Improvement | Status |
|---|---|---|
| 1 | Discussion comments as replies to channel posts | DONE — `reply_to_message_id` + `pendingThreadDetection` + `allowed_updates` in POST |
| 2 | `ended` only by explicit Oref message (+ 20min safety timeout) | DONE |
| 3 | `waiting` only reachable from `alert`, not `early_warning` | DONE |
| 4 | No reopening of ended events | DONE |
| 5 | Multi-event splitting: cumulative centroid, 50km threshold | DONE |
| 6 | Outlier detection in geocoding (3σ + Israel bounds) | DONE |
| 7 | Mock Oref server replacing internal simulation | DONE — `mock-oref-server.mjs` |
| 8 | Expand settlement polygons to all settlements | DONE — 1569 polygons from tzevadom + gov shapefile + Nominatim |
| 9 | Circle radius 500m | DONE |
| 10 | More distinct wave colors (8 hues) | DONE |
| 11 | Early warning with distinct orange polygon color | DONE |
| 12 | Boom button in discussion comments | DONE |
| 13 | Analyze Oref alert titles — cat=1 rockets, cat=6 drones, cat=10 early warning/ended | DONE |
| 14 | Risk model rewrite — real base rates, radius-based, cat-specific interception rates | DONE |
| 15 | Deploy pipeline — SHA tags, delete+recreate, health check | DONE |
| 16 | Message style switcher (/style A/B/C/D) | DONE |
| 17 | Geocoding: 1873 coords, cross-validated against Google Places | DONE |
| 18 | Interactive map review tool (map-review.html) | DONE |
| 19 | Skip risk analysis for drone attacks (cat=6) | DONE |

### Remaining / Future
| # | Improvement | Priority |
|---|---|---|
| 20 | News scraping for real impact/interception data | Medium |
| 21 | Accumulate event outcomes for probability calibration | Medium |
| 22 | Stream logs to Azure Log Analytics | Low |
| 23 | Extract modules into separate files | Low |

---

## 10. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token |
| `TELEGRAM_CHAT_ID` | Yes | Private chat ID for bot commands |
| `TELEGRAM_CHANNEL_ID` | No | Channel username (default: @booms_on_the_way) |
| `TELEGRAM_DISCUSSION_ID` | No | Auto-detected from linked channel group |
| `HOME_COORD` | No | Home coordinates [lng, lat] (default: Rehovot) |
| `HOME_NAME` | No | Home city name (default: רחובות) |
| `ALERT_URL` | No | Oref API URL (overridden during tests) |
| `TZ` | No | Timezone (default: Asia/Jerusalem) |

---

## 11. Deployment

### Infrastructure

- **Container:** Azure Container Instance, Israel Central region
- **Registry:** Azure Container Registry (`orefbotacr`)
- **Storage:** Azure File Share (`orefbotstorage/oref-data`) mounted at `/data/`
- **CI/CD:** GitHub Actions — build image in ACR, recreate container with volume mount

### Deploy Pipeline

```
push to main → GitHub Actions → az acr build → az container create (with /data/ mount)
```

### Important Notes

- Oref API may block non-Israeli IPs — container must be in Israel Central
- Container restart policy: Always
- Secrets stored in GitHub: `AZURE_CREDENTIALS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AZURE_STORAGE_KEY`, `ACR_PASSWORD`
