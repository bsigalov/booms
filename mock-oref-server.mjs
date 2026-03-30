#!/usr/bin/env node
import { createServer } from "http";
import { readFileSync } from "fs";

const MIN_WAVE_INTERVAL_MS = 5000; // minimum 5s between waves
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
const ewWaves = scenario.ew || [];
const allPhases = [];

// Add EW phases first
for (const ewAreas of ewWaves) {
  allPhases.push({
    areas: ewAreas,
    cat: "10",
    title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
    desc: "היכנסו למרחב המוגן",
  });
}

// Add alarm phases
for (const waveAreas of waves) {
  allPhases.push({
    areas: waveAreas,
    cat: scenario.cat || "1",
    title: scenario.title,
    desc: scenario.desc || "היכנסו למרחב המוגן ושהו בו 10 דקות",
  });
}

const totalSettlements = allPhases.reduce((sum, p) => sum + p.areas.length, 0);

// Calculate timing: 5s minimum between waves, total adapts to wave count
const waveInterval = Math.max(MIN_WAVE_INTERVAL_MS, 8000); // 8s default, 5s minimum
const waveWindowMs = allPhases.length > 1 ? waveInterval * (allPhases.length - 1) : 0;
const totalMs = Math.max(60000, waveWindowMs + 30000); // waves + 30s for waiting/ended
const alertDuration = Math.round(waveInterval * 0.6); // alert active for 60% of interval

console.log(`[mock] scenario: "${scenario.title}" — ${totalSettlements} settlements, ${ewWaves.length} EW + ${waves.length} waves`);
console.log(`[mock] timing: ${waveInterval/1000}s between phases, ${Math.round(totalMs/1000)}s total`);

let currentResponse = "";

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(currentResponse);
});

server.listen(3333, () => {
  console.log("[mock] serving on http://localhost:3333");
  scheduleWaves();
});

function scheduleWaves() {
  allPhases.forEach((phase, i) => {
    const delay = i * waveInterval;

    setTimeout(() => {
      currentResponse = JSON.stringify({
        id: String(Date.now()),
        cat: phase.cat,
        title: phase.title,
        desc: phase.desc,
        data: phase.areas,
      });
      const label = phase.cat === "10" ? "EW" : `wave ${i - ewWaves.length + 1}`;
      console.log(`[mock] ${label} (t+${Math.round(delay/1000)}s): ${phase.areas.length} settlements`);
    }, delay);

    setTimeout(() => {
      currentResponse = "";
    }, delay + alertDuration);
  });

  const endDelay = (allPhases.length > 0 ? (allPhases.length - 1) * waveInterval : 0) + 20000;
  setTimeout(() => {
    currentResponse = JSON.stringify({
      id: String(Date.now()),
      cat: scenario.cat || "1",
      title: "האירוע הסתיים",
      desc: "",
      data: [],
    });
    console.log(`[mock] end event sent (t+${Math.round(endDelay/1000)}s)`);
  }, endDelay);

  setTimeout(() => {
    currentResponse = "";
  }, endDelay + 5000);

  const totalMs = Math.max(60000, endDelay + 10000);
  setTimeout(() => {
    console.log("[mock] replay complete, shutting down");
    server.close();
    process.exit(0);
  }, totalMs);
}
