# Phase 1: Fix Event Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the event lifecycle state machine with the spec — fix transition rules, ended behavior, multi-event splitting threshold, and early warning detection.

**Architecture:** All changes in `oref-alerts.mjs`. No new files. The event lifecycle is managed by `fetchAlerts()` (empty response handling + alert processing) and `createEvent()`.

**Tech Stack:** Node.js ESM, Telegram Bot API

**Spec reference:** `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` Section 2

---

### Task 1: Remove ended-event reopening

The spec says: "ended is final. No reopening. New alerts in the same region always create a fresh event."

Currently `findNearestEvent` skips ended events, but there's still explicit reopening code at lines ~1320-1324.

**Files:**
- Modify: `oref-alerts.mjs` — `fetchAlerts()` alert processing block (~line 1319-1331)

- [ ] **Step 1: Remove the reopening block**

In `fetchAlerts()`, find the block after `findNearestEvent` that checks `evt.phase === "ended" && withinMerge` and reopens. Replace the entire ended-event handling:

```javascript
// REMOVE THIS BLOCK:
// Reopen ended event if within merge window
if (evt.phase === "ended" && withinMerge) {
  console.log(`[lifecycle][${nearest.key}] ended → alert (reopened)`);
  evt.phase = "alert";
  evt.history.push({ time, text: "🚨 אזעקות חודשו" });
}

// KEEP THIS (but simplify — always create fresh for ended):
if (evt.phase === "ended") {
  console.log(`[lifecycle][${nearest.key}] ended → creating fresh event`);
  activeEvents.delete(nearest.key);
  evt = null;
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check oref-alerts.mjs`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add oref-alerts.mjs
git commit -m "fix: ended events are final, no reopening"
```

---

### Task 2: Make waiting only reachable from alert

The spec says: "waiting is only reachable from alert, not from early_warning."

Currently the empty-response handler transitions both `early_warning` and `alert` to `waiting`.

**Files:**
- Modify: `oref-alerts.mjs` — `fetchAlerts()` empty response handler (~line 1241-1252)

- [ ] **Step 1: Change the waiting transition condition**

Find:
```javascript
if ((evt.phase === "early_warning" || evt.phase === "alert") && evt.emptyCount >= emptyThreshold) {
```

Replace with:
```javascript
if (evt.phase === "alert" && evt.emptyCount >= emptyThreshold) {
```

- [ ] **Step 2: Add early_warning cleanup**

After the waiting transition block, add cleanup for stale early_warning events (no alert arrived after 20 minutes):

```javascript
// early_warning with no follow-up alert → clean up after 20 min
if (evt.phase === "early_warning" && evt.emptyCount * POLL_INTERVAL > 20 * 60000) {
  const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  console.log(`[lifecycle][${key}] early_warning → cleanup (20min timeout, no alert followed)`);
  evt.phase = "ended";
  evt.history.push({ time, text: "✅ ההתרעה הסתיימה (לא הוסלמה לאזעקה)" });
  await updateEventMessage(evt);
  await sendDiscussionUpdate(evt, "ended", `ההתרעה המוקדמת הסתיימה ללא אזעקה.`);
}
```

- [ ] **Step 3: Verify syntax**

Run: `node --check oref-alerts.mjs`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add oref-alerts.mjs
git commit -m "fix: waiting only reachable from alert, early_warning cleans up after 20min"
```

---

### Task 3: Ended by explicit Oref message + 20min safety timeout

The spec says: "ended only when Oref sends explicit end event, OR 20-minute safety timeout from waiting."

Currently ended is triggered by protection-time timeout. Need to:
1. Check for explicit Oref "event ended" message (cat/title)
2. Replace protection-time timeout with 20-minute safety timeout

**Files:**
- Modify: `oref-alerts.mjs` — `fetchAlerts()` alert processing + empty response handler

- [ ] **Step 1: Add Oref end-event detection in alert processing**

In the alert processing loop (where new alerts are handled), add detection for end-event alerts. These are alerts with specific cat/title that signal the event is over. Add before the `findNearestEvent` call:

```javascript
// Detect Oref "event ended" message
const isEndEvent = alert.cat === "10" || (alert.title || "").includes("האירוע הסתיים");
if (isEndEvent) {
  console.log(`[alert][${mode}] END EVENT detected: "${alert.title}"`);
  // Find and end matching active events
  for (const [key, evt] of activeEvents) {
    if (evt.phase === "waiting" || evt.phase === "alert") {
      const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
      console.log(`[lifecycle][${key}] → ended (explicit Oref end event)`);
      evt.phase = "ended";
      evt.history.push({ time, text: "✅ האירוע הסתיים (פיקוד העורף)" });
      await updateEventMessage(evt);
      await sendDiscussionUpdate(evt, "ended", `פיקוד העורף הודיע: האירוע הסתיים.\nסה"כ ${evt.settlements.size} ישובים, ${evt.waves.length} גלים.`);
      if (!evt.isTest) saveScenario(evt);
    }
  }
  continue; // Don't process end events as regular alerts
}
```

- [ ] **Step 2: Replace protection-time timeout with 20-minute safety timeout**

Find the `waiting → ended` block:
```javascript
if (evt.phase === "waiting" && evt.lastWaveTime) {
  const protMin = simActive ? 0.5 : Math.max(evt.protectionMin, 3);
  if (evt.emptyCount * POLL_INTERVAL > (protMin + 2) * 60000) {
```

Replace with:
```javascript
if (evt.phase === "waiting") {
  const safetyTimeoutMs = simActive ? 30000 : 20 * 60000; // 20min real, 30s sim
  if (evt.emptyCount * POLL_INTERVAL > safetyTimeoutMs) {
```

Update the log message:
```javascript
console.log(`[lifecycle][${key}] waiting → ended (20min safety timeout, no Oref end message received)`);
```

Update the history text:
```javascript
evt.history.push({ time, text: "✅ האירוע הסתיים (זמן המתנה מקסימלי)" });
```

- [ ] **Step 3: Verify syntax**

Run: `node --check oref-alerts.mjs`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add oref-alerts.mjs
git commit -m "fix: ended by explicit Oref message + 20min safety timeout"
```

---

### Task 4: Fix multi-event splitting threshold

The spec says: "50km threshold (currently 100km), cumulative centroid."

**Files:**
- Modify: `oref-alerts.mjs` — `EVENT_MERGE_DISTANCE_KM` constant (~line 72)

- [ ] **Step 1: Change threshold**

Find:
```javascript
const EVENT_MERGE_DISTANCE_KM = 100;
```

Replace with:
```javascript
const EVENT_MERGE_DISTANCE_KM = 50;
```

- [ ] **Step 2: Verify the centroid uses cumulative settlements**

Read `findNearestEvent()` and confirm it iterates `evt.settlements` (cumulative). Currently it does — no change needed. Just verify.

- [ ] **Step 3: Commit**

```bash
git add oref-alerts.mjs
git commit -m "fix: multi-event splitting threshold 100km → 50km"
```

---

### Task 5: Fix circle radius 1km and wave colors

The spec says: "1km radius circles" and "visually distinct colors, not shades of same hue."

**Files:**
- Modify: `oref-alerts.mjs` — circle radius (~line 869) and WAVE_COLORS (~line 263)

- [ ] **Step 1: Change circle radius**

Find:
```javascript
radius: 3000, // 3km in meters
```

Replace with:
```javascript
radius: 1000, // 1km in meters
```

- [ ] **Step 2: Verify wave colors are distinct**

Read `WAVE_COLORS` and confirm colors use different hues (red, purple, blue, teal, green, orange, pink, deep purple). This was already changed in commit `5a7af72` — verify it's still there and looks correct.

- [ ] **Step 3: Commit (if radius changed)**

```bash
git add oref-alerts.mjs
git commit -m "fix: circle radius 3km → 1km per spec"
```

---

### Task 6: Deploy and verify

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

- [ ] **Step 2: Wait for deploy**

```bash
gh run list --limit 1 --json status,conclusion
```

Wait until status is "completed" and conclusion is "success".

- [ ] **Step 3: Verify startup logs**

```bash
az container logs --resource-group oref-bot-rg --name oref-bot | head -15
```

Expected: `Data directory: /data`, boundaries loaded, discussion group auto-detected.

- [ ] **Step 4: Run /test and verify**

Send `/test` to bot. Verify:
- Test message has `🧪 [טסט]` label
- Test does NOT merge with any real event
- State transitions follow: alert → waiting → ended (no reopening)
- Map shows distinct wave colors

- [ ] **Step 5: Verify with next real alert**

When the next real alert arrives, check logs:
```bash
az container logs --resource-group oref-bot-rg --name oref-bot | grep "\[lifecycle\]"
```

Verify:
- `early_warning` or `alert` based on Oref title (not arrival order)
- `waiting` only follows `alert`
- `ended` by Oref message or 20min timeout
- No reopening of ended events
