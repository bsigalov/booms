# Core Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the monolithic `oref-alerts.mjs` into a modular Core Service with REST API, WebSocket hub, SQLite persistence, and push notifications — enabling the React Native mobile app (Plan 2).

**Architecture:** Node.js ESM service using Express + Socket.IO. The existing bot logic is extracted into focused modules: geocoding, risk engine, event manager. SQLite via `better-sqlite3` replaces in-memory state and JSON files. The Telegram bot becomes an adapter that consumes the same WebSocket API as the mobile app.

**Tech Stack:** Node.js 22, Express, Socket.IO, better-sqlite3, firebase-admin (FCM), Vitest (testing)

**Spec:** `docs/superpowers/specs/2026-03-23-booms-mobile-app-design.md`

---

## File Structure

```
server/
  package.json
  src/
    index.mjs              - Entry point, wires everything together
    config.mjs             - Environment variables and constants
    db.mjs                 - SQLite setup, migrations, query helpers
    geo/
      coords.mjs           - CITY_COORDS + coords-cache loading + geocode()
      haversine.mjs        - haversineKm(), bearing()
      regions.mjs          - REGION_MAP loading, summarizeAreas()
    risk/
      ellipse.mjs          - fitEllipse(), classifyHomePosition()
      probabilities.mjs    - calculatePAlert/PImpact/PDebris/PBoom
      engine.mjs           - computeRiskForDevice() orchestrator
    events/
      ingester.mjs         - Polls Oref API, deduplicates, emits raw alerts
      lifecycle.mjs        - Event state machine (4 phases), merge window
      manager.mjs          - Orchestrates ingester + lifecycle + risk + DB
    api/
      router.mjs           - Express router: /v1/devices, /v1/events
      middleware.mjs        - X-Device-UUID auth + rate limiting
    ws/
      hub.mjs              - Socket.IO server: event broadcasts, feedback persistence + broadcast
    push/
      service.mjs          - FCM push notification sender
    map/
      generator.mjs        - Static map PNG generation (staticmaps + sharp)
    telegram/
      adapter.mjs          - Connects to event manager, formats for Telegram
  data/
    coords-cache.json      - Copied from root
    oref-regions-official.json
  test/
    geo/haversine.test.mjs
    geo/coords.test.mjs
    geo/regions.test.mjs
    risk/ellipse.test.mjs
    risk/engine.test.mjs
    events/ingester.test.mjs
    events/lifecycle.test.mjs
    events/manager.test.mjs
    push/service.test.mjs
    api/router.test.mjs
    ws/hub.test.mjs
    db.test.mjs
    integration.test.mjs
```

**Key extraction mapping from oref-alerts.mjs:**
- Lines 39-159 (CITY_COORDS, coords-cache) to server/src/geo/coords.mjs
- Lines 170-230 (REGION_MAP, summarizeAreas) to server/src/geo/regions.mjs
- Lines 278-310 (haversineKm, bearing) to server/src/geo/haversine.mjs
- Lines 312-370 (fitEllipse, PCA) to server/src/risk/ellipse.mjs
- Lines 372-530 (classifyHomePosition, probabilities) to server/src/risk/probabilities.mjs
- Lines 530-600 (analyzeRisk) to server/src/risk/engine.mjs
- Lines 840-975 (fetchAlerts, event lifecycle) to server/src/events/
- Lines 698-776 (sendTelegram) to server/src/telegram/adapter.mjs

---

## Tasks

### Task 1: Project Scaffold + Config

**Files:**
- Create: `server/package.json`
- Create: `server/src/config.mjs`
- Copy: data files to `server/data/`

- [ ] Step 1: Create server/package.json with dependencies: better-sqlite3, express, socket.io, firebase-admin, uuid. DevDeps: vitest, socket.io-client, supertest.
- [ ] Step 2: Create server/src/config.mjs exporting: ALERT_URL, POLL_INTERVAL_MS, PORT, EVENT_MERGE_WINDOW_MS, TELEGRAM_*, FCM_SERVICE_ACCOUNT, FEEDBACK_COOLDOWN_MS, RATE_LIMIT_PER_MIN
- [ ] Step 3: Copy coords-cache.json and oref-regions-official.json to server/data/
- [ ] Step 4: Run npm install in server/
- [ ] Step 5: Commit "scaffold: core service project with config and data files"

---

### Task 2: Geo Module - haversine + bearing

**Files:**
- Create: `server/src/geo/haversine.mjs`
- Create: `server/test/geo/haversine.test.mjs`

- [ ] Step 1: Write tests for haversineKm (same point=0, Rehovot-TLV=~20km, Rehovot-KiryatShmona=~163km) and bearing (north, south, NE)
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Extract haversineKm and bearing from oref-alerts.mjs lines 278-310. All coords are [lng, lat] internally.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: extract haversine and bearing geo functions"

---

### Task 3: Geo Module - coords + geocoding

**Files:**
- Create: `server/src/geo/coords.mjs`
- Create: `server/test/geo/coords.test.mjs`

- [ ] Step 1: Write tests for getCoord (known city returns [lng,lat], unknown returns null), fuzzyMatch (matches "אשקלון - דרום"), getAllCoords (>100 entries)
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Extract CITY_COORDS (full dict from lines 40-158), coords-cache loading, fuzzyMatch, geocode (with Nominatim rate limit). Export getCoord, fuzzyMatch, geocode, getAllCoords.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: extract geocoding module with coords cache"

---

### Task 4: Geo Module - regions + summarizeAreas

**Files:**
- Create: `server/src/geo/regions.mjs`
- Create: `server/test/geo/regions.test.mjs`

- [ ] Step 1: Write tests for getRegionsForAreas (maps known settlements to region names) and summarizeAreas (reduces ["אשקלון - דרום","אשקלון - צפון","שדרות","נתיבות"] to "דרום הנגב (אשקלון, שדרות, נתיבות)")
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Extract MAJOR_CITIES set, REGION_MAP loading from oref-regions-official.json, getRegionsForAreas(), summarizeAreas() from lines 170-230.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: extract regions and summarizeAreas"

---

### Task 5: Risk Module - ellipse + classification

**Files:**
- Create: `server/src/risk/ellipse.mjs`
- Create: `server/test/risk/ellipse.test.mjs`

- [ ] Step 1: Write tests for fitEllipse (<3 points default, 5 northern points produces valid ellipse) and classifyHomePosition (far home = FAR, >100km)
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Extract projectToLocalKm, fitEllipse, classifyHomePosition from lines 312-430
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: extract PCA ellipse fitting and position classification"

---

### Task 6: Risk Module - probabilities + engine

**Files:**
- Create: `server/src/risk/probabilities.mjs`
- Create: `server/src/risk/engine.mjs`
- Create: `server/test/risk/engine.test.mjs`

- [ ] Step 1: Write tests for computeRiskForDevice: low risk for far home (Rehovot vs northern alerts, <10%), high risk for nearby home (>50%)
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Extract probability functions from lines 430-580 into probabilities.mjs. Create engine.mjs with computeRiskForDevice(alertCoords, homeCoord, alertRegions) returning {riskPct, distanceKm, direction, ellipse, probabilities}
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: extract risk engine with probability calculations"

---

### Task 7: SQLite Database

**Files:**
- Create: `server/src/db.mjs`
- Create: `server/test/db.test.mjs`

- [ ] Step 1: Write tests: creates all 4 tables (events, devices, feedback, event_risk_cache), insert/retrieve device with default alert_radius_km=100, insert/retrieve event with JSON settlements
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement createDb(path) with WAL mode, foreign keys, all CREATE TABLE statements and indexes per spec schema
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: SQLite database with schema and migrations"

---

### Task 8: Alert Ingester

**Files:**
- Create: `server/src/events/ingester.mjs`
- Create: `server/test/events/ingester.test.mjs`

- [ ] Step 1: Write tests: emits "new-alert" for new ID, deduplicates same ID, emits "empty" for empty response
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement createIngester() as EventEmitter with _processResponse (for testing), start() (polling loop), stop(). Extract polling logic from oref-alerts.mjs lines 842-855.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: alert ingester with deduplication"

---

### Task 9: Event Lifecycle State Machine

**Files:**
- Create: `server/src/events/lifecycle.mjs`
- Create: `server/test/events/lifecycle.test.mjs`

- [ ] Step 1: Write tests: starts null, first alert -> early_warning, second alert -> alert with merged settlements, different cat within merge window -> absorbed, 120 empties -> waiting, getState() returns snapshot
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement EventLifecycle class with handleAlert(alert), handleEmpty(), getState(), getPhase(), getSettlements(). Extract logic from lines 840-975 including merge window, protection time parsing, and all phase transitions.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: event lifecycle state machine with merge window"

---

### Task 10: Event Manager (orchestrator)

**Files:**
- Create: `server/src/events/manager.mjs`
- Create: `server/test/events/manager.test.mjs`

- [ ] Step 1: Write tests using mock ingester (direct _processResponse calls): (a) alert flows through lifecycle, persists event to DB, emits "event:update" with state and riskByDevice; (b) empty transitions update DB phase; (c) risk cache is populated per device and invalidated on settlement changes
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement createEventManager(db, opts) as EventEmitter. On ingester "new-alert": call lifecycle.handleAlert(), resolve coords via geocode(), query all devices with home coords from DB, compute per-device risk via computeRiskForDevice(), persist/update event in events table (INSERT on new, UPDATE on existing eventId), write to event_risk_cache (INSERT OR REPLACE), emit "event:update" with {state, alertCoords, regions, riskByDevice}. Handle geocode failures gracefully (skip settlement, log warning).
- [ ] Step 4: Implement empty flow: on ingester "empty": call lifecycle.handleEmpty(), if transition returned ("waiting"/"ended"): update events table phase and ended_at, emit appropriate event.
- [ ] Step 5: Run tests, verify PASS
- [ ] Step 6: Commit "feat: event manager orchestrating ingester, lifecycle, risk, and DB"

---

### Task 11: REST API

**Files:**
- Create: `server/src/api/middleware.mjs`
- Create: `server/src/api/router.mjs`
- Create: `server/test/api/router.test.mjs`

**Coordinate convention:** All incoming API payloads use `lat, lng` order. The router converts to `[lng, lat]` at the boundary for internal use. All outgoing responses convert `[lng, lat]` back to `{ lat, lng }`. This is the ONLY conversion point.

- [ ] Step 1: Write tests: (a) POST /v1/devices returns 201 — this endpoint is exempt from UUID auth; (b) PUT /v1/devices/:uuid/location with {lat: 31.89, lng: 34.81} stores internally as home_lat=31.89, home_lng=34.81; (c) GET /v1/events returns empty list; (d) GET /v1/events/current returns 204 when no event; (e) GET /v1/events/:id returns 404 for unknown ID, returns event detail for known ID; (f) requests without X-Device-UUID header return 401 (except POST /devices); (g) requests with unknown UUID return 401
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement deviceAuth middleware: extracts X-Device-UUID header, validates against devices table, returns 401 if missing/unknown. POST /v1/devices is exempt. Implement rateLimiter (60 req/min per device UUID).
- [ ] Step 4: Implement createRouter(db, eventManager) with all 5 endpoints: POST /v1/devices, PUT /v1/devices/:uuid/location, GET /v1/events (cursor-based, 20/page), GET /v1/events/:id (with per-device risk from cache), GET /v1/events/current. Add GET /v1/health returning {status: "ok", uptime: process.uptime()}. Enrich event responses with risk and feedback counts.
- [ ] Step 5: Run tests, verify PASS
- [ ] Step 6: Commit "feat: REST API with auth, all endpoints, and pagination"

---

### Task 12: WebSocket Hub

**Files:**
- Create: `server/src/ws/hub.mjs`
- Create: `server/test/ws/hub.test.mjs`

- [ ] Step 1: Write tests: (a) rejects unknown device UUID on connect; (b) accepts registered device; (c) on feedback:boom, persists to feedback table in DB and broadcasts feedback:new to all connected clients with {type, lat, lng, timestamp}; (d) second feedback:boom within 10s is rejected (cooldown enforcement)
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement createWsHub(httpServer, db). Auth middleware validates UUID against devices table. On feedback:boom/feedback:missile: enforce 10s cooldown per device+type, persist to feedback table (device_uuid, event_id from current active event, type, lat, lng, timestamp), then broadcast feedback:new to ALL connected clients (anonymized: no device_uuid). Expose broadcastEvent() and broadcastEventWithRisk(state, riskByDevice) methods — the latter sends per-device risk to each socket.
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: Socket.IO WebSocket hub with auth, feedback persistence, and broadcast"

---

### Task 13: Push Notification Service

**Files:**
- Create: `server/src/push/service.mjs`
- Create: `server/test/push/service.test.mjs`

- [ ] Step 1: Write tests (mock firebase-admin messaging): (a) devices within alert_radius_km receive push; (b) devices outside radius are skipped; (c) stale token (registration-token-not-registered) clears push_token in DB; (d) APNs payload includes critical alert fields and collapse key; (e) initPush() is no-op when FCM_SERVICE_ACCOUNT not set
- [ ] Step 2: Run tests, verify FAIL
- [ ] Step 3: Implement initPush() and sendPushToDevices(db, eventState, riskByDevice). For each device with push_token: compare risk.distanceKm to device.alert_radius_km, skip if outside. Build payload per spec: notification title/body in Hebrew, data with event_id/phase/risk_pct/distance_km, android high priority, apns with interruption-level "critical" + sound + collapse-id=event_id. Handle stale tokens by clearing push_token. No retry on temporary failure (fire-and-forget for v1).
- [ ] Step 4: Run tests, verify PASS
- [ ] Step 5: Commit "feat: FCM push notification service with Critical Alerts"

---

### Task 13.5: Map Generation Module

**Files:**
- Create: `server/src/map/generator.mjs`

- [ ] Step 1: Extract map generation from oref-alerts.mjs lines 601-696. Includes: MARKER_SVG/HOME_SVG constants, ensureMarkerIcon() (renders SVG to PNG via sharp), generateAlertMap(areas, alertCoords, homeCoord) returning PNG file path. Uses staticmaps with OSM tiles, red pins for alerts, blue pin for home. Output: 800x600 PNG.
- [ ] Step 2: Commit "feat: extract static map generation module"

---

### Task 14: Telegram Adapter

**Files:**
- Create: `server/src/telegram/adapter.mjs`

**Note:** This adapter listens directly to event manager emissions (in-process). This is an intentional v1 simplification — both run in the same container. The adapter could be extracted to a separate WS client process later per spec architecture.

- [ ] Step 1: Implement startTelegramAdapter(eventManager). Listens to "event:update" and "event:ended" emissions. Formats messages with Hebrew text, edits existing message or sends new. Includes buildMessage(), sendTelegram(), sendTelegramPhoto() using map/generator.mjs. Also handles bot commands (/test, /status, /help) via Telegram polling. Extract from oref-alerts.mjs lines 698-end.
- [ ] Step 2: Commit "feat: Telegram adapter consuming event manager events"

---

### Task 15: Entry Point - Wire Everything

**Files:**
- Create: `server/src/index.mjs`

- [ ] Step 1: Implement index.mjs: create DB, Express app, HTTP server, REST router (with auth + rate limit middleware), WS hub, event manager, push service, Telegram adapter. Wire event manager emissions to WS broadcasts and push sends.
- [ ] Step 2: Add graceful shutdown: handle SIGTERM/SIGINT — stop ingester polling, close WS hub, close DB connection, then process.exit(0). Log "Shutting down gracefully...".
- [ ] Step 3: Manual smoke test: PORT=3000 node src/index.mjs, verify startup logs, curl /v1/health returns {status:"ok"}, curl /v1/events returns 401 (no UUID), Ctrl+C shows graceful shutdown log
- [ ] Step 4: Commit "feat: wire entry point with graceful shutdown"

---

### Task 16: Dockerfile + Deployment

**Files:**
- Create: `server/Dockerfile`
- Modify: `.github/workflows/deploy.yml`

- [ ] Step 1: Create server/Dockerfile (FROM node:22-slim, COPY package*.json, npm ci, COPY src/ and data/, CMD node src/index.mjs)
- [ ] Step 2: Update deploy.yml to build from server/ directory
- [ ] Step 3: Commit "feat: Dockerfile and deploy workflow for core service"

---

### Task 17: Integration Smoke Test

**Files:**
- Create: `server/test/integration.test.mjs`

- [ ] Step 1: Write integration test scenario 1 (setup): register device via REST (POST /v1/devices), set location (PUT /v1/devices/:uuid/location), connect via WS, verify connection, GET /v1/events returns empty list
- [ ] Step 2: Write integration test scenario 2 (golden path): inject mock alert via ingester._processResponse(), verify WS client receives "event:update" with risk data for the registered device, verify GET /v1/events now returns 1 event, verify GET /v1/events/current returns the active event with risk
- [ ] Step 3: Write integration test scenario 3 (feedback): connected client sends feedback:boom, verify it is persisted in DB, verify other connected clients receive feedback:new broadcast
- [ ] Step 4: Run full test suite: npx vitest run (all tests pass)
- [ ] Step 5: Commit "test: integration tests covering setup, golden path, and feedback"

---

### Task 18: Data Retention Cleanup

**Files:**
- Create: `server/src/retention.mjs`

- [ ] Step 1: Implement runRetentionCleanup(db) that: deletes events older than 90 days (and their event_risk_cache entries), deletes feedback older than 90 days, clears push_token for devices with no activity (no feedback) for 30 days. Returns counts of cleaned items.
- [ ] Step 2: In index.mjs, schedule runRetentionCleanup to run once per day (setInterval with 24h, also run on startup).
- [ ] Step 3: Commit "feat: data retention cleanup for events, feedback, and stale devices"
