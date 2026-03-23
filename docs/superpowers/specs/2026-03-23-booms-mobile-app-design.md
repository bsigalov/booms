# Booms On The Way — Mobile App Design Spec

## Overview

React Native mobile app (iOS + Android) that provides real-time Oref rocket alert monitoring with personal risk analysis, interactive map, event history, and community feedback. Published on App Store. UI in Hebrew (RTL) with iOS frosted glass design language.

## Target Users

Friends and family — personal risk analysis is the core value. Fun, not life-saving. Prominent disclaimer required.

## System Architecture

### Two-Service Split

The existing monolithic bot (`oref-alerts.mjs`) is split into:

1. **Core Service** (Node.js) — the brain
   - Alert Ingester: polls Oref API every 1s, deduplicates, triggers event lifecycle
   - Risk Engine: extracted PCA ellipse analysis, runs per-device (each has own home coord)
   - Event Manager: 4-phase lifecycle (early_warning → alert → waiting → ended), stores to SQLite
   - Push Service: FCM/APNs on every event state change. iOS Critical Alerts when risk > threshold
   - Express REST API: device registration, event history, settings
   - WebSocket Hub: real-time event updates, feedback (boom/missile sighting)

2. **Telegram Adapter** — lightweight WS client that connects to Core Service and forwards to Telegram channel. Replaces current `sendTelegram` logic. The existing Telegram bot becomes just another consumer.

```
┌─────────────┐     ┌──────────────────────────────────────┐
│  Oref API   │────>│          Core Service (Node.js)       │
└─────────────┘     │                                      │
                    │  Alert Ingester → Risk Engine          │
                    │       ↓                               │
                    │  Event Manager → Push Service (FCM)    │
                    │       ↓                               │
                    │    SQLite                              │
                    │       ↓                               │
                    │  Express REST + WebSocket Hub          │
                    └──────┬─────────────┬──────────────────┘
                           │             │
               ┌───────────▼──┐   ┌──────▼───────────┐
               │  React Native│   │ Telegram Adapter  │
               │  App         │   │                   │
               └──────────────┘   └───────────────────┘
```

### Data Transport

- **WebSocket** (Socket.IO) for live events: sub-second delivery of event state changes, feedback broadcast
- **REST** for history: paginated event list (cursor-based, 20 items per page), device registration, settings updates
- **Push notifications** (FCM/APNs): sent alongside WS for when app is backgrounded

### WebSocket Reconnection

Socket.IO handles reconnection automatically. Configuration:
- Reconnect with exponential backoff: 1s, 2s, 4s, 8s... max 30s
- On reconnect: client sends last known event timestamp, server sends missed updates
- After 5 failed reconnects: show "מנותק" banner on Live Event screen, fall back to REST polling every 5s
- On app foreground: force immediate reconnect + full state sync via `GET /events/current`

### Push Notifications

iOS Critical Alerts bypass DND — requires Apple entitlement application. **Fallback plan:** if Apple rejects the Critical Alerts entitlement, use iOS Time-Sensitive notifications (available without special entitlement, can break through Focus modes with user permission). Apply for Critical Alerts separately; the app ships with Time-Sensitive as baseline.

**Payload structure:**
```json
{
  "notification": { "title": "🚨 ירי רקטות", "body": "קו העימות — 14 ישובים — 34% סיכון" },
  "data": { "event_id": "...", "phase": "alert", "risk_pct": 34, "distance_km": 38 },
  "apns": { "payload": { "aps": { "sound": { "critical": 1, "volume": 1.0, "name": "alert.caf" } } } }
}
```
Notifications with the same `event_id` replace previous ones (collapse key).

### Risk Engine Scaling

Risk calculation is NOT per-device-per-second. Instead:
1. On each alert update, the server computes the **event geometry** once (PCA ellipse, centroid, expansion direction)
2. Per-device risk is a lightweight function: `distance(home, centroid)` + `classifyHomePosition(ellipse, home)` — O(1) per device
3. Results cached in `event_risk_cache` table, invalidated on event phase/settlement changes
4. For v1 (friends only, <100 devices), this runs synchronously. For scale: move to worker thread with batch computation

### Identity

Anonymous device UUID. No user accounts. Server stores device UUID → push token + home location. Accounts can be added later if needed.

### API Security

- All REST endpoints require `X-Device-UUID` header (validated against registered devices)
- WebSocket authenticated by UUID on connect — server rejects unknown UUIDs
- Feedback submissions: 10-second cooldown per type per device (client-side debounce + server-side enforcement)
- Rate limiting: 60 requests/minute per device on REST endpoints
- No sensitive data exposed: risk is returned only to the requesting device

### Coordinate Convention

All API payloads use **`lat, lng` order** (WGS84). The server internally converts to `[lng, lat]` for GeoJSON/staticmaps compatibility. This is the ONLY place the conversion happens.

### Offline Behavior

- App caches last known event state and recent history locally (AsyncStorage)
- When offline: shows cached data with "מנותק — מציג נתונים ישנים" banner
- Feedback submissions queued locally, sent when connection restores (max 50 queued items, FIFO)
- Map tiles cached by react-native-maps for recently viewed areas

### App Lifecycle

- **Foreground**: WebSocket active, real-time updates
- **Background**: WebSocket disconnects (iOS kills it). Push notifications are the delivery mechanism. On push tap → app opens → reconnects WS → syncs state
- **Killed**: Same as background — push only. First launch reconnects and syncs
- **Return to foreground**: immediate WS reconnect + `GET /events/current` to sync state before WS delivers

## Screens

### 1. Live Event (עכשיו)

Default tab. Two states:

**Idle ("הכל בסדר"):**
- Green checkmark with glow
- Risk level card: 0% + city name
- Last event summary card (type, region, time ago, distance)
- Today's stats: events count, settlements count, near-you count

**Active Alert:**
- Red gradient header: event type, start time, current phase
- Risk display: **semi-circle gauge** with gradient (green→yellow→red) + percentage
  - Emoji scale below: 😴 → 😌 → 😐 → 😬 → 😱 → 🤯
  - Humorous vibe text per level:
    - 0%: "לילה טוב 😴"
    - ~20%: "שתה קפה, הכל בסדר ☕"
    - ~35%: "כדאי להתקרב לממ״ד"
    - ~50%: "תתחיל לרוץ 🏃"
    - ~75%: "מה אתה עדיין עושה פה?!"
    - 100%: "!בומים בדרך 💥"
  - Distance + direction + expansion trend below
- Inline live map showing affected settlements
- Event timeline (scrollable, chronological entries)
- Protection countdown timer (זמן שהייה במרחב מוגן)
- **3 feedback buttons** at bottom:
  - 🚀 רואה טיל (secondary, 52px) — missile sighting with GPS
  - 💥 בום! (primary FAB, 76px, red gradient with glow) — tap for boom
  - 💥💥 בום חזק (secondary, 52px) — strong boom
  - All feedback is geo-tagged using device precise location

### 2. Map (מפה)

Full-screen interactive map (react-native-maps). Always available, not just during events.

**Markers:**
- Red pulsing dots: active alert settlements
- 💥 Boom reports from users
- 🚀 Missile sighting reports
- Blue dot: user's home location
- Amber faded dots: impact reports (last 24h)

**Controls:**
- Time filter pills: עכשיו / 24 שעות / שבוע
- Legend overlay (bottom-right)
- Center on home button

### 3. History (היסטוריה)

iOS grouped list with frosted glass material (`backdrop-filter: blur`).

**Design:**
- Large title navigation bar (iOS native)
- Grouped by date sections (היום / אתמול / dates)
- Each event row:
  - Icon thumbnail (tinted background: red for rockets, blue for UAV)
  - Title: event type + region
  - Subtitle: time range, settlement count, distance from home
  - Feedback badges as subtle pills (💥 N בומים, 🚀 N צפיות, 💨 N נפילות)
  - Risk percentage in color (iOS system colors: red/orange/green)
  - Chevron disclosure indicator → opens event detail
- Translucent card backgrounds with blur
- Ultra-thin separators (0.33px)
- Supports both light and dark mode with frosted glass treatment

### 4. Settings (הגדרות)

Standard iOS Settings pattern:

- **מיקום הבית**: searchable city picker (from CITY_COORDS ~1183 settlements) OR pin on map with GPS "use my location" button
- **התראות**: push notification toggle, Critical Alerts toggle (iOS), quiet hours
- **רדיוס התרעה**: slider — 50km / 100km / כל הארץ
- **דיסקליימר**: always-visible link to full disclaimer
- **אודות**: version, credits, Telegram channel link

## Onboarding (First Launch)

3-step flow:

1. **Welcome + Disclaimer** — full screen, must tap "הבנתי" to proceed
   - Tone: "⚠️ האפליקציה הזו לא תציל אותך. היא נבנתה לשעשוע, סקרנות, ולהעברת הזמן בממ"ד. חישובי הסיכון מבוססים על מתמטיקה יפה שאולי נכונה ואולי לא. לפיקוד העורף יש אפליקציה רשמית — השתמשו בה. אנחנו פה בשביל הכיף. 🎲"
2. **Set home location** — city picker or map pin + request GPS permission
3. **Enable notifications** — push permission request + explain Critical Alerts

## Data Model (SQLite)

### events
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Server-generated UUID (NOT Oref alert ID — Oref IDs may collide across merges) |
| cat | INTEGER | Alert category |
| title | TEXT | e.g., "ירי רקטות וטילים" |
| started_at | INTEGER | Unix timestamp |
| ended_at | INTEGER | Nullable until ended |
| phase | TEXT | early_warning/alert/waiting/ended |
| settlements | TEXT | JSON array |
| regions | TEXT | JSON array |
| protection_min | REAL | From alert desc |

### devices
| Column | Type | Notes |
|---|---|---|
| uuid | TEXT PK | Device-generated UUID |
| push_token | TEXT | FCM/APNs token |
| platform | TEXT | ios/android |
| home_lat | REAL | |
| home_lng | REAL | |
| home_city | TEXT | Display name |
| alert_radius_km | INTEGER | Default 100 |
| created_at | INTEGER | |

### feedback
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Autoincrement |
| device_uuid | TEXT FK | → devices |
| event_id | TEXT FK | → events |
| type | TEXT | boom/boom_strong/missile_sighting |
| lat | REAL | GPS coords |
| lng | REAL | GPS coords |
| timestamp | INTEGER | |

### event_risk_cache
| Column | Type | Notes |
|---|---|---|
| event_id | TEXT | → events |
| device_uuid | TEXT | → devices |
| risk_pct | REAL | Calculated risk |
| distance_km | REAL | |
| direction | TEXT | e.g., "דרום-מערב" |
| PK | | (event_id, device_uuid) |

## API

### REST Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /devices | Register device (uuid, push_token, platform) |
| PUT | /devices/:uuid/location | Update home location (lat, lng, city) |
| GET | /events | Event history (paginated, newest first) |
| GET | /events/:id | Event detail with risk for requesting device |
| GET | /events/current | Active event or 204 if none |

### WebSocket Messages

Connect: `ws://host/?device=UUID`

| Direction | Type | Payload |
|---|---|---|
| Server→Client | `event:update` | Full event state (phase, settlements, risk for this device) |
| Server→Client | `event:ended` | Event ended summary |
| Client→Server | `feedback:boom` | `{ type, lat, lng }` |
| Client→Server | `feedback:missile` | `{ lat, lng }` |
| Server→Client | `feedback:new` | Broadcast: someone reported boom/sighting (anonymized) |

## Design Language

- **iOS frosted glass** (translucent materials with `backdrop-filter: blur`) throughout
- **RTL Hebrew** — all text, layout direction
- **Follow system appearance** by default, with manual override in settings. Dark mode recommended for alerts context
- **iOS system colors** for semantic meaning: red (#ff453a) danger, green (#30d158) safe, orange (#ff9f0a) caution, blue (#0a84ff) info
- **SF-style tab bar** with 4 tabs: עכשיו / מפה / היסטוריה / הגדרות

## Key Dependencies (React Native)

- `react-native-maps` — interactive maps
- `@react-native-community/blur` or Expo `BlurView` — frosted glass effects
- `@react-native-firebase/messaging` — FCM push notifications
- `react-native-geolocation-service` — precise GPS for feedback
- `socket.io-client` — WebSocket connection (matches `socket.io` on server)
- `better-sqlite3` (server) — SQLite database
- `@react-native-async-storage/async-storage` — local cache for offline support

## Deployment

- **Core Service**: Azure Container Instance (same as current bot, Israel Central region)
- **Telegram Adapter**: runs in-process with Core Service (same container, spawned as a module)
- **App**: App Store (iOS) + Google Play (Android)
- Apple Critical Alerts entitlement must be applied for separately

## Disclaimer

Must appear in: onboarding (blocking), settings screen, App Store description.
The app is explicitly for entertainment and curiosity. Risk calculations are approximate and not a substitute for official Home Front Command alerts.

## REST API Versioning

All endpoints prefixed with `/v1/` (e.g., `/v1/devices`, `/v1/events`). Versioning from day one to avoid breaking deployed clients.

## Data Retention

- Events older than 90 days: archived (removed from SQLite, optionally backed up)
- Feedback older than 90 days: deleted
- Devices with no activity for 30 days: push token cleared (re-registers on next app open)
- `event_risk_cache`: pruned when parent event is archived

## Error States

All screens show contextual error handling:
- **Live Event**: WS disconnect → "מנותק" banner + connection status dot (green/red) in header. REST fallback polling.
- **Map**: tile load failure → show cached tiles + "חלק מהמפה לא זמין" toast
- **History**: REST error → show cached history + pull-to-refresh with error message
- **Feedback**: GPS denied → still allow submission without coords, show "לא ניתן לקבל מיקום" toast
- **General**: no network → offline banner across all screens
