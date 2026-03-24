# Phase 2: Geocoding Outlier Detection + Discussion Comments + Map Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add geocoding outlier detection to prevent misplaced map markers, verify discussion comments threading works, add boom button after every comment, and add early warning distinct color.

**Architecture:** All changes in `oref-alerts.mjs`. No new files.

**Tech Stack:** Node.js ESM, Telegram Bot API, staticmaps

**Spec reference:** `docs/superpowers/specs/2026-03-24-booms-bot-spec.md` Sections 4, 5, 3

---

### Task 1: Geocoding outlier detection

After resolving all settlements in an alert batch, detect and exclude settlements whose coordinates are far from the alert's centroid. This prevents misplaced markers from bad geocoding (e.g., "אשכולות" resolving to Haifa instead of the Negev).

**Files:**
- Modify: `oref-alerts.mjs` — `resolveCoords()` function (~line 706)

- [ ] **Step 1: Add outlier detection to resolveCoords**

The current `resolveCoords` resolves coordinates and returns them. Add outlier detection after resolution:

```javascript
async function resolveCoords(areas) {
  const coords = [];
  const coordMap = new Map(); // area → coord
  const missed = [];
  for (const area of areas) {
    const coord = await geocode(area);
    if (coord) {
      coords.push(coord);
      coordMap.set(area, coord);
    } else {
      missed.push(area);
    }
  }
  console.log(`[resolveCoords] ${coords.length}/${areas.length} resolved${missed.length > 0 ? `, MISSING: ${missed.join(", ")}` : ""}`);

  // Outlier detection: exclude settlements >3 std devs from centroid
  if (coords.length >= 3) {
    const centroid = [
      coords.reduce((s, c) => s + c[0], 0) / coords.length,
      coords.reduce((s, c) => s + c[1], 0) / coords.length,
    ];
    const distances = coords.map(c => haversineKm(centroid, c));
    const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
    const stdDev = Math.sqrt(distances.reduce((s, d) => s + (d - mean) ** 2, 0) / distances.length);

    if (stdDev > 0) {
      const outlierThreshold = mean + 3 * stdDev;
      const outliers = [];
      for (const [area, coord] of coordMap) {
        const dist = haversineKm(centroid, coord);
        if (dist > outlierThreshold) {
          outliers.push(area);
          coordMap.delete(area);
          console.warn(`[geocode:outlier] "${area}" at [${coord}] is ${dist.toFixed(0)}km from centroid (threshold: ${outlierThreshold.toFixed(0)}km) — excluded from map`);
        }
      }
    }
  }

  return { coords: [...coordMap.values()], coordMap, missed };
}
```

**Note:** This changes the return type from `coord[]` to `{ coords, coordMap, missed }`. All callers need to be updated.

- [ ] **Step 2: Update all callers of resolveCoords**

Find all calls to `resolveCoords` and update them to destructure the new return type:

In `fetchAlerts()`, find:
```javascript
const alertCoords = await resolveCoords(allAreas);
```
Replace with:
```javascript
const { coords: alertCoords } = await resolveCoords(allAreas);
```

Check for any other callers with `Grep`.

- [ ] **Step 3: Use coordMap in map generation to skip outliers**

In `generateAlertMap`, the `renderSettlement` function resolves coordinates independently via `fuzzyMatch`. Instead, pass the validated `coordMap` from `resolveCoords` so outliers are already excluded. Add `coordMap` as an optional parameter to `generateAlertMap`:

In `renderSettlement`, for the circle case, change:
```javascript
const coord = fuzzyMatch(area) || CITY_COORDS[area];
```
To:
```javascript
const coord = validCoords?.get(area) || fuzzyMatch(area) || CITY_COORDS[area];
```

Where `validCoords` is the coordMap passed through.

- [ ] **Step 4: Verify syntax**

Run: `node --check oref-alerts.mjs`

- [ ] **Step 5: Commit**

```bash
git add oref-alerts.mjs
git commit -m "feat: geocoding outlier detection — exclude settlements >3σ from centroid"
```

---

### Task 2: Boom button after every discussion comment

Currently the boom button is posted only once (as first comment). The spec says it should be posted after every discussion update.

**Files:**
- Modify: `oref-alerts.mjs` — `sendDiscussionUpdate()` function

- [ ] **Step 1: Add boom button to every discussion update**

At the end of `sendDiscussionUpdate`, after `await sendTelegram(msg, ...)`, add:

```javascript
  // Post boom button after every comment
  if (evt.lastTextMessageId) {
    await sendTelegram("💥 שמעתם בום? דווחו כאן:", TELEGRAM_DISCUSSION_ID, {
      replyMarkup: BOOM_BUTTONS,
      replyToMsgId: evt.lastTextMessageId,
      replyChatId: TELEGRAM_CHANNEL_ID,
    });
  }
```

Remove the separate `sendBoomButtonToThread` function and its call from `updateEventMessage` since the boom button is now sent with every discussion update.

- [ ] **Step 2: Verify syntax**

Run: `node --check oref-alerts.mjs`

- [ ] **Step 3: Commit**

```bash
git add oref-alerts.mjs
git commit -m "feat: boom button posted after every discussion comment"
```

---

### Task 3: Early warning distinct background color on map

Early warning settlements should render with orange fill (distinct from alert wave colors).

**Files:**
- Modify: `oref-alerts.mjs` — `generateAlertMap()` rendering logic

- [ ] **Step 1: Verify early warning color is used**

In `generateAlertMap`, check that `earlyWarningSettlements` are rendered with `WAVE_COLORS.early_warning` (orange). The current code at ~line 908:

```javascript
renderSettlement(area, isEarlyWarning ? WAVE_COLORS.early_warning : WAVE_COLORS.waves[0]);
```

This renders ALL settlements as early_warning color when the event phase is early_warning. But it should render early_warning settlements with orange even when the event later escalates to alert (they keep their original color).

The fix: track which settlements arrived during early_warning vs alert phases. The event object already has `waves` (alert waves) and settlements not in any wave are early_warning. This logic is already in `getWaveIndex` which returns -1 for early_warning settlements. Verify the rendering code uses the right color for -1 index settlements.

- [ ] **Step 2: Commit if changes needed**

```bash
git add oref-alerts.mjs
git commit -m "feat: early warning settlements render with distinct orange color"
```

---

### Task 4: Verify discussion comments threading

The cross-chat `reply_parameters` approach was deployed. Need to verify it works with a real alert or test.

- [ ] **Step 1: Check logs after next alert**

```bash
az container logs --resource-group oref-bot-rg --name oref-bot | grep "\[telegram\].*sendMessage.*discussion\|reply_parameters\|FAILED"
```

- [ ] **Step 2: If cross-chat reply fails**

If the Telegram API rejects `reply_parameters` with cross-chat `chat_id`, the fallback is to switch to webhook mode. Document findings and create a follow-up task.

- [ ] **Step 3: If cross-chat reply works**

Mark item 1 from the spec as complete. No further action needed.

---

### Task 5: Deploy and verify

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Wait for deploy, restart container if needed**

- [ ] **Step 3: Send /test and verify**

Check:
- Outlier settlements excluded from map (check logs for `[geocode:outlier]`)
- Boom button appears after discussion comments
- Discussion comments appear as replies to channel post
- Early warning settlements show orange color
