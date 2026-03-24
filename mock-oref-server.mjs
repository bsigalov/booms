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
  const waveWindow = SIM_TOTAL_MS * 0.55;
  const waveInterval = waves.length > 1 ? waveWindow / (waves.length - 1) : 0;
  const alertDuration = Math.max(3000, waveInterval * 0.7);

  waves.forEach((waveAreas, i) => {
    const delay = Math.round(i * waveInterval);

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

    setTimeout(() => {
      currentResponse = "";
    }, delay + alertDuration);
  });

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

  setTimeout(() => {
    currentResponse = "";
  }, Math.round(SIM_TOTAL_MS * 0.75));

  setTimeout(() => {
    console.log("[mock] replay complete, shutting down");
    server.close();
    process.exit(0);
  }, SIM_TOTAL_MS);
}
