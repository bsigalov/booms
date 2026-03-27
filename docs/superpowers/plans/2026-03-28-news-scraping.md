# News Channel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing single-channel news scraper to 3 channels with richer data extraction (missile type, casualties, damage), event correlation, and risk model calibration.

**Architecture:** Rewrite scrapeImpactChannel in oref-alerts.mjs to support multiple channels with staggered polling. Add missile type classification, event correlation, and calibration data persistence. Reuse existing HTML parsing and keyword matching patterns.

**Tech Stack:** Node.js fetch, regex HTML parsing, JSON persistence in /data/

**Spec reference:** docs/superpowers/specs/2026-03-27-news-integration.md

---

### Task 1: Multi-channel scraper with staggered polling

Replace the single-channel scraper with a multi-channel system.

**Files:**
- Modify: oref-alerts.mjs — scrapeImpactChannel, scraper state, startup interval

- [ ] **Step 1:** Replace `let lastScrapedMsgId = 0;` with multi-channel state: NEWS_CHANNELS array (aharonyediotnews, lelotsenzura, yediotnews25), scraperState object loaded from /data/scraper-state.json, saveScraperState function.

- [ ] **Step 2:** Rewrite scrapeImpactChannel as scrapeChannel(channel) that accepts a channel object, uses per-channel lastMsgId from scraperState.

- [ ] **Step 3:** Replace setInterval(scrapeImpactChannel, 60000) with staggered polling: each channel offset by 20 seconds, all on 60s intervals.

- [ ] **Step 4:** Run node --check oref-alerts.mjs

- [ ] **Step 5:** Commit: "feat: multi-channel news scraper (3 channels, staggered polling)"

---

### Task 2: Rich data extraction

Add classifyReport function with missile type, casualties, damage extraction.

**Files:**
- Modify: oref-alerts.mjs — add classifyReport, update keyword sets

- [ ] **Step 1:** Replace IMPACT_KEYWORDS with REPORT_KEYWORDS (impact, interception, debris, casualty, damage) and MISSILE_TYPES (ballistic, cruise, rocket, drone, mirv).

- [ ] **Step 2:** Add classifyReport(text, channel, msgId) that returns: category, missileType, location (longest city match from CITY_COORDS), count (number extraction), distToHome.

- [ ] **Step 3:** Update scrapeChannel to call classifyReport instead of inline keyword matching.

- [ ] **Step 4:** Run node --check oref-alerts.mjs

- [ ] **Step 5:** Commit: "feat: rich news extraction — missile type, casualties, damage, count"

---

### Task 3: Report persistence and event correlation

Save reports to /data/news-reports.json and match to recent events.

**Files:**
- Modify: oref-alerts.mjs — add saveReports, correlateReport

- [ ] **Step 1:** Add saveReports(newReports) — loads existing from /data/news-reports.json, calls correlateReport on each, appends, keeps max 1000 reports.

- [ ] **Step 2:** Add correlateReport(report) — checks all activeEvents, matches if report timestamp within 30 min of event AND location within 50km of event centroid. Sets report.relatedEventId and adds to evt.newsReports array.

- [ ] **Step 3:** Run node --check oref-alerts.mjs

- [ ] **Step 4:** Commit: "feat: news report persistence + event correlation"

---

### Task 4: Risk model calibration from news data

After events end, use news reports to update interception rates.

**Files:**
- Modify: oref-alerts.mjs — add updateCalibration, call on event end

- [ ] **Step 1:** Add updateCalibration(evt) — reads /data/calibration.json, updates per-origin (iran/lebanon/gaza) counts: interceptions, impacts, debrisReports, missileTypes. Computes interceptionRate = interceptions / (interceptions + impacts).

- [ ] **Step 2:** Call updateCalibration(evt) at each "event ended" transition (search for `evt.phase = "ended"`, add call after each one, skip if evt.isTest).

- [ ] **Step 3:** Run node --check oref-alerts.mjs

- [ ] **Step 4:** Commit: "feat: risk model calibration from news reports"

---

### Task 5: Deploy and verify

- [ ] **Step 1:** git push origin main

- [ ] **Step 2:** Wait for deploy, verify container running

- [ ] **Step 3:** Check scraper logs: az container logs | grep scraper

- [ ] **Step 4:** Check persistent files exist in /data/

- [ ] **Step 5:** After real alert, verify news reports have relatedEventId
