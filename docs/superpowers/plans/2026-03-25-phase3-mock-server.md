# Phase 3: Mock Oref Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the internal simulation (`simResponse` hack) with a proper mock HTTP server that replays real recorded Oref scenarios, so tests go through the exact same code path as real alerts.

**Architecture:** Rewrite `mock-oref-server.mjs` to read from `/data/test-scenarios.json`, serve realistic Oref JSON responses on a local HTTP port, compress timing to 2 minutes. Update `startSimulation()` in `oref-alerts.mjs` to spawn the mock server process and redirect `ALERT_URL`. Remove the `simResponse` hack.

**Tech Stack:** Node.js `http` module, `child_process.fork()`

**Spec reference:** `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` Section 8

---

### Task 1: Rewrite mock-oref-server.mjs

The mock server must:
- Accept a scenario JSON file path as CLI argument
- Serve Oref-format JSON on port 3333
- Replay waves with compressed timing (2 min total)
- Serve "event ended" at the end (title: "האירוע הסתיים")
- Between waves, return empty string (like real Oref API)
- Exit cleanly when done

**Files:**
- Rewrite: `mock-oref-server.mjs`

- [ ] **Step 1: Rewrite the mock server**

```javascript
#!/usr/bin/env node
import { createServer } from "http";
import { readFileSync } from "fs";

const SIM_TOTAL_MS = 120000; // 2 minutes
const scenarioPath = process.argv[2] || "/data/test-scenarios.json";
const scenarioIndex = parseInt(process.argv[3] || "-1");

// Load scenario
let scenarios;
try {
  scenarios = JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch (e) {
  console.error(`[mock] failed to load scenarios: ${e.message}`);
  process.exit(1);
}

const scenario = scenarioIndex >= 0
  ? scenarios[scenarioIndex]
  : scenarios[Math.floor(Math.random() * scenarios.length)];

const waves = scenario.waves || [];
const totalSettlements = waves.flat().length;
console.log(`[mock] scenario: "${scenario.title}" — ${totalSettlements} settlements, ${waves.length} waves`);

let currentResponse = ""; // empty = no active alert
let waveIndex = 0;

// HTTP server
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(currentResponse);
});

server.listen(3333, () => {
  console.log("[mock] serving on http://localhost:3333");
  scheduleWaves();
});

function scheduleWaves() {
  const waveWindow = SIM_TOTAL_MS * 0.55; // 55% for waves
  const waveInterval = waves.length > 1 ? waveWindow / (waves.length - 1) : 0;
  const alertDuration = Math.max(3000, waveInterval * 0.7); // how long each alert stays active

  waves.forEach((waveAreas, i) => {
    const delay = Math.round(i * waveInterval);

    // Show alert
    setTimeout(() => {
      currentResponse = JSON.stringify({
        id: String(Date.now()),
        cat: "1",
        title: scenario.title,
        desc: scenario.desc || "היכנסו למרחב המוגן ושהו בו 10 דקות",
        data: waveAreas,
      });
      console.log(`[mock] wave ${i + 1}/${waves.length} (t+${Math.round(delay/1000)}s): ${waveAreas.length} settlements`);
    }, delay);

    // Clear alert after duration (before next wave)
    setTimeout(() => {
      currentResponse = "";
    }, delay + alertDuration);
  });

  // At 70%: send "event ended"
  const endDelay = Math.round(SIM_TOTAL_MS * 0.7);
  setTimeout(() => {
    currentResponse = JSON.stringify({
      id: String(Date.now()),
      cat: "1",
      title: "האירוע הסתיים",
      desc: "",
      data: [],
    });
    console.log(`[mock] end event sent (t+${Math.round(endDelay/1000)}s)`);
  }, endDelay);

  // At 75%: clear end event
  setTimeout(() => {
    currentResponse = "";
  }, Math.round(SIM_TOTAL_MS * 0.75));

  // At 100%: shutdown
  setTimeout(() => {
    console.log("[mock] replay complete, shutting down");
    server.close();
    process.exit(0);
  }, SIM_TOTAL_MS);
}
```

- [ ] **Step 2: Verify it runs standalone**

Run: `node mock-oref-server.mjs`
Expected: starts, prints scenario info, serves on port 3333, exits after 2 min.
Kill it early with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add mock-oref-server.mjs
git commit -m "feat: rewrite mock-oref-server to replay test-scenarios.json"
```

---

### Task 2: Update startSimulation to spawn mock server

Replace the `simResponse` hack with spawning the mock server process and redirecting `ALERT_URL`.

**Files:**
- Modify: `oref-alerts.mjs` — `startSimulation()`, `stopSimulation()`, top-level imports

- [ ] **Step 1: Add child_process import**

At the top of the file, add:
```javascript
import { fork } from "child_process";
```

- [ ] **Step 2: Rewrite startSimulation**

Replace the entire `startSimulation()` function:

```javascript
let mockServerProcess = null;
const MOCK_PORT = 3333;
const REAL_ALERT_URL = ALERT_URL;

function startSimulation() {
  if (simActive) return;

  const scenario = TEST_SCENARIOS[Math.floor(Math.random() * TEST_SCENARIOS.length)];
  if (!scenario) {
    sendTelegram("❌ אין תסריטי בדיקה זמינים", TELEGRAM_CHAT_ID);
    return;
  }

  const totalSettlements = (scenario.waves || []).flat().length;
  simActive = true;

  sendTelegram(
    `🧪 <b>סימולציה מתחילה</b>\n` +
    `📋 ${scenario.title}\n` +
    `👥 ${totalSettlements} ישובים ב-${(scenario.waves || []).length} גלים\n` +
    `⏱ משך: 2 דקות\n\n` +
    `⚠️ התרעות אמיתיות לא ייקלטו בזמן הסימולציה`,
    TELEGRAM_CHAT_ID
  );

  // Find scenario index
  const idx = TEST_SCENARIOS.indexOf(scenario);

  // Spawn mock server
  const mockPath = new URL("./mock-oref-server.mjs", import.meta.url).pathname;
  mockServerProcess = fork(mockPath, [TEST_SCENARIOS_PATH, String(idx)], { silent: true });

  mockServerProcess.stdout?.on("data", d => console.log(`[mock] ${d.toString().trim()}`));
  mockServerProcess.stderr?.on("data", d => console.error(`[mock:err] ${d.toString().trim()}`));

  mockServerProcess.on("exit", (code) => {
    console.log(`[mock] server exited (code=${code})`);
    // Restore real URL
    ALERT_URL = REAL_ALERT_URL;
    simActive = false;
    mockServerProcess = null;
    sendTelegram("🧪 הסימולציה הסתיימה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
  });

  // Redirect alert polling to mock server (after brief delay for server startup)
  setTimeout(() => {
    ALERT_URL = `http://localhost:${MOCK_PORT}`;
    console.log(`[sim] ALERT_URL redirected to ${ALERT_URL}`);
  }, 1000);
}
```

- [ ] **Step 3: Rewrite stopSimulation**

```javascript
function stopSimulation() {
  if (!simActive) return;
  if (mockServerProcess) {
    mockServerProcess.kill();
    mockServerProcess = null;
  }
  ALERT_URL = REAL_ALERT_URL;
  simActive = false;
  simTimers.forEach(t => clearTimeout(t));
  simTimers = [];
  console.log("[sim] cancelled");
  sendTelegram("🧪 הסימולציה בוטלה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
}
```

- [ ] **Step 4: Make ALERT_URL mutable**

At the top of the file, change:
```javascript
const ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/...";
```
To:
```javascript
let ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/...";
```

- [ ] **Step 5: Remove old simResponse references**

Search for `simResponse` and remove all references:
- Remove `let simResponse = "";`
- In `fetchAlerts`, remove the `if (simActive) { text = simResponse; }` block — now `fetchAlerts` always uses `ALERT_URL` (which points to mock server during tests)
- Remove any `simResponse = ...` assignments in the old simulation code
- Keep `simActive` — it's still used for `isTest` flag and `emptyCount` thresholds

- [ ] **Step 6: Add mock-oref-server.mjs to Dockerfile**

In `Dockerfile`, add the mock server script to COPY:
```
COPY oref-alerts.mjs oref-regions-official.json mock-oref-server.mjs ./
```

- [ ] **Step 7: Verify syntax**

Run: `node --check oref-alerts.mjs`

- [ ] **Step 8: Commit**

```bash
git add oref-alerts.mjs Dockerfile
git commit -m "feat: spawn mock server for tests, remove simResponse hack"
```

---

### Task 3: Verify discussion comments threading

After deploying, verify that `reply_parameters` with cross-chat reply actually works. This requires a real test.

- [ ] **Step 1: Deploy**

```bash
git push origin main
```

Wait for deploy, then force restart container:
```bash
az container delete --resource-group oref-bot-rg --name oref-bot --yes
az container create ... (full command from deploy workflow)
```

- [ ] **Step 2: Send /test**

After container starts, send `/test` to the bot.

- [ ] **Step 3: Check discussion group**

Verify:
- Updates appear as **comments** on the channel post (not standalone messages)
- Boom button appears after each comment
- "Leave a Comment" on channel shows comment count

- [ ] **Step 4: Check logs**

```bash
az container logs --resource-group oref-bot-rg --name oref-bot | grep "\[telegram\].*sendMessage\|FAILED\|reply_parameters"
```

If `reply_parameters` fails with a Telegram API error, document the error and create a follow-up task to implement webhook mode.

- [ ] **Step 5: Document findings**

Update spec Section 3 (Discussion Group) with results:
- If working: mark as implemented
- If failing: document error, note webhook mode needed

---

### Task 4: Deploy and verify all Phase 3

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Force recreate container**

```bash
az container delete --resource-group oref-bot-rg --name oref-bot --yes
sleep 5
az container create ... (full command)
```

- [ ] **Step 3: Verify startup**

```bash
az container logs --resource-group oref-bot-rg --name oref-bot | head -15
```

Expected: scenarios loaded, discussion group detected.

- [ ] **Step 4: Run /test**

Send `/test`. Verify:
- Mock server spawns (logs show `[mock] serving on...`)
- Alert URL redirected (logs show `[sim] ALERT_URL redirected`)
- Waves replay through normal pipeline
- Event ends via "האירוע הסתיים" message
- Mock server exits, URL restored
- `🧪 [טסט]` label on all messages
- Single text + single map (editing, not new posts)
