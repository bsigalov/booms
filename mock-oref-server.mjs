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
const totalSettlements = waves.flat().length;

// Calculate timing: 5s minimum between waves, total adapts to wave count
const waveInterval = Math.max(MIN_WAVE_INTERVAL_MS, 8000); // 8s default, 5s minimum
const waveWindowMs = waves.length > 1 ? waveInterval * (waves.length - 1) : 0;
const totalMs = Math.max(60000, waveWindowMs + 30000); // waves + 30s for waiting/ended
const alertDuration = Math.round(waveInterval * 0.6); // alert active for 60% of interval

console.log(`[mock] scenario: "${scenario.title}" — ${totalSettlements} settlements, ${waves.length} waves`);
console.log(`[mock] timing: ${waveInterval/1000}s between waves, ${Math.round(totalMs/1000)}s total`);

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
  waves.forEach((waveAreas, i) => {
    const delay = i * waveInterval;

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

    // Clear alert after duration
    setTimeout(() => {
      currentResponse = "";
    }, delay + alertDuration);
  });

  // End event 20s after last wave
  const endDelay = waveWindowMs + 20000;
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

  // Clear end event after 5s
  setTimeout(() => {
    currentResponse = "";
  }, endDelay + 5000);

  // Shutdown
  setTimeout(() => {
    console.log("[mock] replay complete, shutting down");
    server.close();
    process.exit(0);
  }, totalMs);
}
