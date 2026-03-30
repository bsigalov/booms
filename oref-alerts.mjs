import StaticMaps from "staticmaps";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { fork } from "child_process";

let ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/warningMessages/alert/alerts.json";
const POLL_INTERVAL = 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "@booms_on_the_way";
let TELEGRAM_DISCUSSION_ID = process.env.TELEGRAM_DISCUSSION_ID || ""; // linked discussion group (auto-detected if not set)

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars");
  process.exit(1);
}
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let lastAlertId = "";
const seenAlertIds = new Map(); // id → timestamp, prevents reprocessing
const SEEN_ID_TTL_MS = 300_000; // 5 min TTL
let feedbackLog = [];
let simActive = false;
let lastUpdateId = 0; // shared between pollTelegramCommands and resolveDiscussionThread
const pendingThreadDetection = new Map(); // channelMsgId → evt, for discussion thread detection

// Persistent data directory — /data/ when Azure File Share is mounted, fallback to app dir
const DATA_DIR = existsSync("/data") ? "/data" : new URL(".", import.meta.url).pathname;
console.log(`Data directory: ${DATA_DIR}`);

// All persistent file paths
const ALERT_HISTORY_PATH = `${DATA_DIR}/alert-history.json`;
const IMPACT_HISTORY_PATH = `${DATA_DIR}/impact-history.json`;
const CORRELATION_PATH = `${DATA_DIR}/correlation-index.json`;

// Multi-event support: each geographic region can have its own active event
const activeEvents = new Map(); // regionKey → event object

// Check if Oref alert is an early warning (vs actual siren)
function isEarlyWarningAlert(alert) {
  const t = alert.title || "";
  // Real Oref early warning: "בדקות הקרובות צפויות להתקבל התרעות באזורך" (cat=10)
  return t.includes("בדקות הקרובות") || t.includes("התרעה מוקדמת");
}

function createEvent(regionKey, title, cat, settlements, time, protectionMin, alert) {
  const earlyWarn = isEarlyWarningAlert(alert);
  const phase = earlyWarn ? "early_warning" : "alert";
  const emoji = earlyWarn ? "⚠️" : "🚨";
  const label = earlyWarn ? "התרעה מוקדמת" : "אזעקה";
  return {
    regionKey,
    phase,
    startTime: Date.now(),
    startTimeStr: time,
    title,
    type: cat,
    settlements: new Set(settlements),
    currentWaveSettlements: new Set(settlements),
    waves: earlyWarn ? [] : [{ settlements: new Set(settlements), time, ...computeWaveEllipse(settlements) }],
    history: [{ time, text: `${emoji} ${label}: ${summarizeAreas(settlements)} (${settlements.length})` }],
    protectionMin: protectionMin,
    riskMsg: "",
    expansionVector: null,
    ewSettlements: earlyWarn ? new Set(settlements) : new Set(),
    ewEllipse: null,
    ewHull: null,
    ewAreaKm2: 0,
    isDirect: false,
    ewToAlarmSeconds: null,
    patternClusterId: null,
    origin: null,
    predictedAlarmTime: null,
    predictionConfidence: null,
    predictionBasedOn: null,
    launchAzimuth: null,
    estimatedImpact: null,
    interception: null,
    lastWaveTime: Date.now(),
    lastTextMessageId: null,
    lastMapMessageId: null,
    boomButtonMessageId: null,
    emptyCount: 0,
    isTest: simActive,
  };
}

// Find which active event a set of settlements belongs to (by geographic proximity)
const EVENT_MERGE_DISTANCE_KM = 50;

function findNearestEvent(settlements) {
  if (activeEvents.size === 0) return null;

  // Compute centroid of incoming settlements
  const inCoords = [];
  for (const s of settlements) {
    const c = fuzzyMatch(s) || CITY_COORDS[s];
    if (c) inCoords.push(c);
  }
  if (inCoords.length === 0) return null;
  const inCentroid = [
    inCoords.reduce((s, c) => s + c[0], 0) / inCoords.length,
    inCoords.reduce((s, c) => s + c[1], 0) / inCoords.length,
  ];

  let nearest = null;
  let nearestDist = Infinity;
  for (const [key, evt] of activeEvents) {
    if (evt.phase === "ended") continue;
    // Never merge tests with real events or vice versa
    if (evt.isTest !== simActive) continue;
    // Compute centroid of existing event
    const evtCoords = [];
    for (const s of evt.settlements) {
      const c = fuzzyMatch(s) || CITY_COORDS[s];
      if (c) evtCoords.push(c);
    }
    if (evtCoords.length === 0) continue;
    const evtCentroid = [
      evtCoords.reduce((s, c) => s + c[0], 0) / evtCoords.length,
      evtCoords.reduce((s, c) => s + c[1], 0) / evtCoords.length,
    ];

    const dist = haversineKm(inCentroid, evtCentroid);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = { key, event: evt, dist };
    }
  }

  if (nearest && nearestDist < EVENT_MERGE_DISTANCE_KM) return nearest;
  return null;
}

// Load feedback log
const FEEDBACK_PATH = `${DATA_DIR}/feedback-log.json`;
try { feedbackLog = JSON.parse(readFileSync(FEEDBACK_PATH, "utf8")); } catch {}

// [lng, lat] format (staticmaps convention)
const CITY_COORDS = {
  // צפון
  "קריית שמונה": [35.5713, 33.2075],
  "מטולה": [35.5730, 33.2778],
  "יובל": [35.5800, 33.2200],
  "מרגליות": [35.5580, 33.2400],
  "שדה נחמיה": [35.5570, 33.2300],
  "כפר גלעדי": [35.5680, 33.2500],
  "דן": [35.6520, 33.2470],
  "דפנה": [35.6380, 33.2330],
  "שאר ישוב": [35.6350, 33.2560],
  "חצור הגלילית": [35.5460, 33.0150],
  "ראש פינה": [35.5410, 32.9690],
  "צפת": [35.4960, 32.9646],
  "כרמיאל": [35.3044, 32.9187],
  "מעלות-תרשיחא": [35.2714, 33.0167],
  "נהריה": [35.0978, 33.0061],
  "עכו": [35.0764, 32.9274],
  "שלומי": [35.1400, 33.0800],
  "חיפה": [34.9896, 32.7940],
  "טירת כרמל": [34.9713, 32.7600],
  "נשר": [35.0380, 32.7700],
  "קריית אתא": [35.1100, 32.8000],
  "קריית ביאליק": [35.0850, 32.8300],
  "קריית ים": [35.0700, 32.8400],
  "קריית מוצקין": [35.0750, 32.8350],
  "טבריה": [35.5312, 32.7922],
  "עפולה": [35.2893, 32.6085],
  "נצרת": [35.3035, 32.6996],
  "נצרת עילית": [35.3280, 32.7220],
  "נוף הגליל": [35.3280, 32.7220],
  "מגדל העמק": [35.2449, 32.6764],
  "יוקנעם עילית": [35.1097, 32.6593],
  "בית שאן": [35.5020, 32.5050],
  "כפר תבור": [35.4180, 32.6870],
  "טמרה": [35.1960, 32.8530],
  // גוש דן ומרכז
  "תל אביב - מרכז העיר": [34.7718, 32.0853],
  "תל אביב - יפו": [34.7818, 32.0653],
  "תל אביב - דרום העיר": [34.7700, 32.0500],
  "תל אביב - עבר הירקון": [34.7900, 32.1000],
  "רמת גן": [34.8148, 32.0880],
  "גבעתיים": [34.8124, 32.0716],
  "בני ברק": [34.8337, 32.0840],
  "פתח תקווה": [34.8878, 32.0841],
  "חולון": [34.7805, 32.0234],
  "בת ים": [34.7503, 32.0173],
  "ראשון לציון": [34.7925, 31.9730],
  "הרצליה": [34.8447, 32.1629],
  "רעננה": [34.8709, 32.1849],
  "כפר סבא": [34.9066, 32.1751],
  "הוד השרון": [34.8884, 32.1500],
  "נתניה": [34.8532, 32.3215],
  "רמת השרון": [34.8400, 32.1460],
  "גבעת שמואל": [34.8500, 32.0770],
  "אור יהודה": [34.8600, 32.0290],
  "יהוד-מונוסון": [34.8800, 32.0330],
  "לוד": [34.8952, 31.9515],
  "רמלה": [34.8685, 31.9275],
  "מודיעין-מכבים-רעות": [35.0101, 31.8969],
  "רחובות": [34.8113, 31.8928],
  "נס ציונה": [34.7983, 31.9293],
  // שפלה ודרום
  "אשדוד": [34.6553, 31.8044],
  "אשקלון": [34.5743, 31.6688],
  "קריית גת": [34.7642, 31.6100],
  "קריית מלאכי": [34.7486, 31.7300],
  "שדרות": [34.5959, 31.5251],
  "נתיבות": [34.5878, 31.4217],
  "אופקים": [34.6200, 31.3150],
  "באר שבע": [34.7915, 31.2530],
  "ערד": [35.2126, 31.2588],
  "דימונה": [35.0338, 31.0680],
  "אילת": [34.9519, 29.5577],
  "מצפה רמון": [34.8015, 30.6100],
  "ירוחם": [34.9300, 30.9870],
  // ירושלים והסביבה
  "ירושלים": [35.2137, 31.7683],
  "בית שמש": [34.9888, 31.7510],
  "מעלה אדומים": [35.3000, 31.7700],
  // עוטף עזה
  "עוטף עזה": [34.4500, 31.4500],
  "ניר עם": [34.5700, 31.4800],
  "כפר עזה": [34.4700, 31.3780],
  "נחל עוז": [34.4700, 31.4000],
  "סעד": [34.5100, 31.3950],
  "רעים": [34.4500, 31.3650],
  "אורים": [34.5200, 31.2600],
  "תקומה": [34.5400, 31.4300],
  "יד מרדכי": [34.5600, 31.5900],
  "זיקים": [34.5100, 31.5700],
  // נגב צפוני ושפלה
  "נתיבות": [34.5878, 31.4217],
  "אופקים": [34.6200, 31.3150],
  "נתיב העשרה": [34.5200, 31.5500],
  "יד מרדכי": [34.5600, 31.5900],
  "זיקים": [34.5100, 31.5700],
  "ניצנים": [34.6200, 31.7100],
  "גן יבנה": [34.7050, 31.7850],
  "יבנה": [34.7390, 31.8780],
  "גדרה": [34.7790, 31.8130],
  "קריית מלאכי": [34.7486, 31.7300],
  "כפר אחים": [34.7100, 31.7000],
  "נחלה": [34.6100, 31.6100],
  "ברור חיל": [34.5900, 31.6100],
  "כרמיה": [34.5500, 31.5500],
  "מרכז שפירא": [34.7200, 31.6900],
  "נגבה": [34.6300, 31.6400],
  "גברעם": [34.5800, 31.6200],
  "בית שמש": [34.9888, 31.7510],
  "בית גוברין": [34.8930, 31.6130],
  "לכיש": [34.8480, 31.5640],
  // שרון
  "חדרה": [34.9190, 32.4340],
  "אור עקיבא": [34.9200, 32.5080],
  "קיסריה": [34.8960, 32.5000],
  "זכרון יעקב": [34.9530, 32.5710],
  "פרדס חנה-כרכור": [34.9670, 32.4720],
  "בנימינה-גבעת עדה": [34.9480, 32.5180],
};

// Load extended coordinate cache from file
try {
  const ext = JSON.parse(readFileSync(new URL("./coords-cache.json", import.meta.url), "utf8"));
  Object.assign(CITY_COORDS, ext);
  console.log(`נטענו ${Object.keys(ext).length} ישובים מ-coords-cache.json`);
} catch {
  console.log("coords-cache.json לא נמצא — משתמשים במילון מובנה בלבד");
}

// Load settlement boundary data (polygons for >10K population)
let SETTLEMENT_BOUNDARIES = {};
try {
  SETTLEMENT_BOUNDARIES = JSON.parse(readFileSync(new URL("./settlement-boundaries.json", import.meta.url), "utf8"));
  console.log(`נטענו גבולות ל-${Object.keys(SETTLEMENT_BOUNDARIES).length} ישובים מ-settlement-boundaries.json`);
} catch {
  console.log("settlement-boundaries.json לא נמצא — מפות ללא שטחים");
}

// Wave color palette: early_warning = orange, waves 1-6 = dark→light red
const WAVE_COLORS = {
  early_warning: { fill: "#FF980080", stroke: "#E65100" },  // orange
  waves: [
    { fill: "#D32F2F90", stroke: "#B71C1C" },  // wave 1 — red
    { fill: "#7B1FA290", stroke: "#4A148C" },  // wave 2 — purple
    { fill: "#1565C090", stroke: "#0D47A1" },  // wave 3 — blue
    { fill: "#00838F90", stroke: "#006064" },  // wave 4 — teal
    { fill: "#2E7D3290", stroke: "#1B5E20" },  // wave 5 — green
    { fill: "#E6510090", stroke: "#BF360C" },  // wave 6 — deep orange
    { fill: "#AD145790", stroke: "#880E4F" },  // wave 7 — pink
    { fill: "#4527A090", stroke: "#311B92" },  // wave 8 — deep purple
  ],
};

// Major cities (recognized by name) and region mapping
const MAJOR_CITIES = new Set([
  "תל אביב", "ירושלים", "חיפה", "באר שבע", "אשדוד", "אשקלון",
  "נתניה", "רמת גן", "פתח תקווה", "חולון", "בני ברק", "בת ים",
  "הרצליה", "רעננה", "כפר סבא", "ראשון לציון", "רחובות", "לוד",
  "רמלה", "מודיעין", "נצרת", "עפולה", "טבריה", "צפת", "עכו",
  "נהריה", "כרמיאל", "קריית שמונה", "חדרה", "שדרות", "נתיבות",
  "אופקים", "דימונה", "אילת", "ערד", "קריית גת", "קריית מלאכי",
  "שלומי", "מגדל העמק", "קצרין", "מטולה", "בית שמש",
]);

// Load official region mapping from Oref document
const REGION_MAP = {};
try {
  const regionsData = JSON.parse(readFileSync(new URL("./oref-regions-official.json", import.meta.url), "utf8"));
  for (const [region, settlements] of Object.entries(regionsData.regions)) {
    for (const s of settlements) {
      REGION_MAP[s] = region;
    }
  }
  console.log(`נטענו ${Object.keys(REGION_MAP).length} ישובים ב-${Object.keys(regionsData.regions).length} אזורים מהמסמך הרשמי`);
} catch (e) {
  console.error("שגיאה בטעינת אזורים:", e.message);
}

// Compute region adjacency: two regions are neighbors if any settlements within 15km
const REGION_ADJACENCY = {};
{
  const regionSettlements = {};
  try {
    const regionsData = JSON.parse(readFileSync(new URL("./oref-regions-official.json", import.meta.url), "utf8"));
    for (const [region, settlements] of Object.entries(regionsData.regions)) {
      regionSettlements[region] = settlements
        .map(s => ({ name: s, coord: CITY_COORDS[s] }))
        .filter(s => s.coord);
    }
  } catch {}

  const regionNames = Object.keys(regionSettlements);
  for (const r of regionNames) REGION_ADJACENCY[r] = new Set();

  for (let i = 0; i < regionNames.length; i++) {
    for (let j = i + 1; j < regionNames.length; j++) {
      const rA = regionNames[i], rB = regionNames[j];
      let adjacent = false;
      for (const sA of regionSettlements[rA]) {
        if (adjacent) break;
        for (const sB of regionSettlements[rB]) {
          if (haversineKm(sA.coord, sB.coord) < 15) {
            adjacent = true;
            break;
          }
        }
      }
      if (adjacent) {
        REGION_ADJACENCY[rA].add(rB);
        REGION_ADJACENCY[rB].add(rA);
      }
    }
  }
  const totalPairs = Object.values(REGION_ADJACENCY).reduce((s, v) => s + v.size, 0) / 2;
  console.log(`[adjacency] ${totalPairs} adjacent region pairs from ${regionNames.length} regions`);
}

const GAZA_REGIONS = new Set(["עוטף עזה", "מערב הנגב", "שדות נגב", "שער הנגב", "אשקלון"]);

// 13 simplified macro-regions for message titles
const MACRO_REGION_MAP = {
  "גולן צפון": "הגולן", "גולן דרום": "הגולן",
  "קו העימות": "הגליל העליון", "גליל עליון": "הגליל העליון",
  "המפרץ": "חיפה והקריות", "הכרמל": "חיפה והקריות",
  "העמקים": "הגליל התחתון", "מרכז הגליל": "הגליל המערבי", "גליל תחתון": "הגליל התחתון", "בקעת בית שאן": "הגליל התחתון",
  "ואדי ערה": "שומרון", "מנשה": "שומרון", "שומרון": "שומרון",
  "שרון": "השרון", "דן": "המרכז", "ירקון": "המרכז",
  "השפלה": "המרכז", "שפלת יהודה": "הלכיש והשפלה", "לכיש": "הלכיש והשפלה", "מערב לכיש": "הלכיש והשפלה",
  "ירושלים": "ירושלים",
  "עוטף עזה": "באר שבע והנגב הצפוני", "מערב הנגב": "באר שבע והנגב הצפוני", "מרכז הנגב": "באר שבע והנגב הצפוני", "דרום הנגב": "באר שבע והנגב הצפוני",
  "בקעה": "ים המלח", "יהודה": "ים המלח", "ים המלח": "ים המלח",
  "ערבה": "אילת והערבה", "אילת": "אילת והערבה",
};

// Azimuth bounds for fire direction from each origin (degrees, measured from east counterclockwise)
// These represent the expected major axis direction of the ellipsoid for each origin
// Iran: NE of Israel, azimuth ~30-60° (missiles come from the northeast)
// Yemen: SE of Israel, azimuth ~130-170° (missiles/drones come from the southeast)
// Lebanon: N of Israel, azimuth ~350-20° (rockets come from the north)
const ORIGIN_AZIMUTH = {
  iran: { min: 20, max: 70, default: 45 },
  yemen: { min: 120, max: 170, default: 145 },
  lebanon: { min: 340, max: 30, default: 5 },    // wraps around 0°
  gaza: { min: 190, max: 230, default: 210 },
};

// Yemen-adjacent regions (southern and eastern Israel)
const YEMEN_REGIONS = new Set(["ערבה", "אילת", "דרום הנגב", "ים המלח", "מרכז הנגב"]);

function correctAzimuthForOrigin(azimuthDeg, origin) {
  const bounds = ORIGIN_AZIMUTH[origin];
  if (!bounds) return azimuthDeg;

  // Normalize azimuth to 0-360
  const az = ((azimuthDeg % 360) + 360) % 360;

  // Check if azimuth is within bounds (handle wraparound for lebanon)
  if (bounds.min < bounds.max) {
    // Normal range (no wraparound)
    if (az >= bounds.min && az <= bounds.max) return azimuthDeg; // already correct
  } else {
    // Wraparound range (e.g., 340-30 for lebanon)
    if (az >= bounds.min || az <= bounds.max) return azimuthDeg; // already correct
  }

  // Azimuth is outside bounds — clamp to nearest bound
  let distToMin, distToMax;
  if (bounds.min < bounds.max) {
    distToMin = Math.min(Math.abs(az - bounds.min), 360 - Math.abs(az - bounds.min));
    distToMax = Math.min(Math.abs(az - bounds.max), 360 - Math.abs(az - bounds.max));
  } else {
    distToMin = Math.min(Math.abs(az - bounds.min), 360 - Math.abs(az - bounds.min));
    distToMax = Math.min(Math.abs(az - bounds.max), 360 - Math.abs(az - bounds.max));
  }

  return distToMin < distToMax ? bounds.min : bounds.max;
}

function classifyOrigin(evt) {
  // Check news reports for origin hints
  if (evt.newsReports) {
    for (const r of evt.newsReports) {
      const text = r.text || "";
      if (text.includes("תימן") || text.includes("חות'י") || text.includes("חות׳י") || text.includes("אנסאר אללה") || text.includes("yemen") || text.includes("houthi")) return "yemen";
      if (text.includes("איראן") || text.includes("iran")) return "iran";
    }
  }
  // Iran: massive EW with 100+ settlements
  if (evt.ewSettlements.size >= 100) return "iran";
  // Yemen: alarms in southern/eastern regions without EW
  if (evt.isDirect) {
    const regions = new Set();
    for (const s of evt.settlements) {
      const r = REGION_MAP[s] || REGION_MAP[s.split(" - ")[0].trim()];
      if (r) regions.add(r);
    }
    // Check Yemen regions first (southern/eastern)
    let hasYemen = false;
    for (const r of regions) {
      if (YEMEN_REGIONS.has(r)) { hasYemen = true; break; }
    }
    if (hasYemen) return "yemen";
    // Gaza regions
    for (const r of regions) {
      if (GAZA_REGIONS.has(r)) return "gaza";
    }
    return "lebanon";
  }
  if (evt.ewSettlements.size > 0) return "iran";
  return "unknown";
}

function summarizeAreas(areas) {
  const regions = new Set();
  const majors = [];

  for (const area of areas) {
    // Check region mapping — exact match or base-name-before-dash only
    if (REGION_MAP[area]) {
      regions.add(REGION_MAP[area]);
    } else {
      const baseName = area.split(" - ")[0].trim();
      if (baseName !== area && REGION_MAP[baseName]) {
        regions.add(REGION_MAP[baseName]);
      }
    }
    // Check if major city (exact or partial)
    for (const city of MAJOR_CITIES) {
      if (area.includes(city) && !majors.includes(city)) {
        majors.push(city);
      }
    }
  }

  const regionStr = regions.size > 0 ? [...regions].join(", ") : "";
  const majorStr = majors.slice(0, 3).join(", ");

  if (regionStr && majorStr) return `${regionStr} (${majorStr} ועוד)`;
  if (regionStr) return regionStr;
  if (majorStr) return majorStr;
  return areas.slice(0, 3).join(", ");
}

function summarizeAreasMacro(areas) {
  const macroRegions = new Map(); // macro → count of settlements
  for (const area of areas) {
    const region = REGION_MAP[area] || REGION_MAP[area.split(" - ")[0].trim()];
    if (region) {
      const macro = MACRO_REGION_MAP[region] || region;
      macroRegions.set(macro, (macroRegions.get(macro) || 0) + 1);
    }
  }
  if (macroRegions.size === 0) return summarizeAreas(areas);
  // Sort by settlement count (most affected first), take top 2-3
  const sorted = [...macroRegions.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, sorted.length > 3 ? 2 : 3).map(e => e[0]);
  if (sorted.length > top.length) {
    return `${top.join(", ")} ועוד`;
  }
  return top.join(", ");
}

// Fallback geocoding via Nominatim
const geoCache = new Map();

function fuzzyMatch(place) {
  // Try exact match first
  if (CITY_COORDS[place]) return CITY_COORDS[place];

  // Only match on base name before " - " separator
  // e.g. "אשקלון - דרום" → "אשקלון", "תל אביב - מרכז העיר" → "תל אביב"
  const baseName = place.split(" - ")[0].trim();
  if (baseName !== place && CITY_COORDS[baseName]) return CITY_COORDS[baseName];

  // Also try the reverse: if a CITY_COORDS key's base name matches our base name
  for (const city of Object.keys(CITY_COORDS)) {
    const cityBase = city.split(" - ")[0].trim();
    if (cityBase === baseName) return CITY_COORDS[city];
  }

  return null;
}

async function geocode(place) {
  const key = place.trim();
  const fuzzy = fuzzyMatch(key);
  if (fuzzy) {
    console.log(`[geocode] "${key}" → fuzzy match [${fuzzy}]`);
    return fuzzy;
  }
  if (geoCache.has(key)) {
    console.log(`[geocode] "${key}" → cache hit [${geoCache.get(key)}]`);
    return geoCache.get(key);
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key + ", ישראל")}&format=json&limit=1`;
    console.log(`[geocode] "${key}" → Nominatim lookup...`);
    const res = await fetch(url, {
      headers: { "User-Agent": "OrefAlertBot/1.0" },
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      console.warn(`[geocode] "${key}" → Nominatim returned non-JSON: ${contentType}`);
      return null;
    }
    const data = await res.json();
    if (data.length > 0) {
      const coords = [parseFloat(data[0].lon), parseFloat(data[0].lat)];
      geoCache.set(key, coords);
      console.log(`[geocode] "${key}" → Nominatim result [${coords}] (${data[0].display_name})`);
      return coords;
    }
    console.warn(`[geocode] "${key}" → Nominatim: no results`);
  } catch (e) {
    console.error(`[geocode] "${key}" → error: ${e.message}`);
  }
  return null;
}

// --- Advanced Risk Analysis Engine ---
const HOME_COORD = JSON.parse(process.env.HOME_COORD || "[34.8113, 31.8928]");
const HOME_NAME = process.env.HOME_NAME || "רחובות";

// Load correlation index (rebuilt periodically)
let correlationIndex = { regionCorrelation: {}, impactGivenAlert: { pImpact: 0.18 }, debrisGivenAlert: { pDebris: 0.30 } };
try {
  correlationIndex = JSON.parse(readFileSync(CORRELATION_PATH, "utf8"));
} catch {}

function haversineKm(coord1, coord2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(from, to) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  if (deg < 22.5 || deg >= 337.5) return "צפון";
  if (deg < 67.5) return "צפון-מזרח";
  if (deg < 112.5) return "מזרח";
  if (deg < 157.5) return "דרום-מזרח";
  if (deg < 202.5) return "דרום";
  if (deg < 247.5) return "דרום-מערב";
  if (deg < 292.5) return "מערב";
  return "צפון-מערב";
}

// --- PCA-Based Ellipse Fitting ---

function projectToLocalKm(coords) {
  const n = coords.length;
  const centroid = [
    coords.reduce((s, c) => s + c[0], 0) / n,
    coords.reduce((s, c) => s + c[1], 0) / n,
  ];
  const K_LAT = 111.32;
  const K_LNG = 111.32 * Math.cos(centroid[1] * Math.PI / 180);
  const projected = coords.map(([lng, lat]) => [
    (lng - centroid[0]) * K_LNG,
    (lat - centroid[1]) * K_LAT,
  ]);
  return { centroid, projected, K_LAT, K_LNG };
}

function fitEllipse(coords) {
  if (coords.length < 3) {
    const { centroid, K_LNG, K_LAT } = projectToLocalKm(coords);
    return { centroid, semiMajor: 5, semiMinor: 5, azimuthDeg: 0, eccentricity: 0, K_LNG, K_LAT, azimuthRad: 0 };
  }

  const { centroid, projected, K_LNG, K_LAT } = projectToLocalKm(coords);
  const n = projected.length;

  // 2x2 covariance matrix
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of projected) {
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  sxx /= n; syy /= n; sxy /= n;

  // Eigenvalue decomposition of 2x2 symmetric matrix
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda1 = trace / 2 + disc; // larger eigenvalue
  const lambda2 = Math.max(0.01, trace / 2 - disc); // smaller eigenvalue

  // Semi-axes (2σ covers ~95% of points)
  const semiMajor = 2 * Math.sqrt(lambda1);
  const semiMinor = 2 * Math.sqrt(lambda2);

  // Eigenvector for larger eigenvalue → azimuth direction
  let azimuthRad;
  if (Math.abs(sxy) > 0.001) {
    azimuthRad = Math.atan2(lambda1 - sxx, sxy);
  } else {
    azimuthRad = sxx >= syy ? 0 : Math.PI / 2;
  }
  const azimuthDeg = ((azimuthRad * 180 / Math.PI) + 360) % 360;

  const eccentricity = Math.sqrt(1 - (semiMinor * semiMinor) / (semiMajor * semiMajor));

  return { centroid, semiMajor, semiMinor, azimuthDeg, eccentricity, K_LNG, K_LAT, azimuthRad };
}

function ellipseToPolygon(ellipse, numPoints = 36) {
  const { centroid, semiMajor, semiMinor, azimuthRad, K_LNG, K_LAT } = ellipse;
  if (!K_LNG || !K_LAT) return null;
  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const theta = (2 * Math.PI * i) / numPoints;
    const x = semiMajor * Math.cos(theta);
    const y = semiMinor * Math.sin(theta);
    const xr = x * Math.cos(azimuthRad) - y * Math.sin(azimuthRad);
    const yr = x * Math.sin(azimuthRad) + y * Math.cos(azimuthRad);
    points.push([centroid[0] + xr / K_LNG, centroid[1] + yr / K_LAT]);
  }
  points.push(points[0]); // close polygon
  return points;
}

function convexHull(coords) {
  if (coords.length <= 2) return coords.length === 2 ? [...coords, coords[0]] : [...coords];
  // Graham scan — find bottom-most point, sort by polar angle, scan
  const sorted = [...coords].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const pivot = sorted[0];
  const rest = sorted.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a[1] - pivot[1], a[0] - pivot[0]);
    const angleB = Math.atan2(b[1] - pivot[1], b[0] - pivot[0]);
    if (Math.abs(angleA - angleB) < 1e-10) {
      const dA = (a[0] - pivot[0]) ** 2 + (a[1] - pivot[1]) ** 2;
      const dB = (b[0] - pivot[0]) ** 2 + (b[1] - pivot[1]) ** 2;
      return dA - dB;
    }
    return angleA - angleB;
  });
  const hull = [pivot];
  for (const p of rest) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cross <= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  hull.push(hull[0]); // close polygon
  return hull;
}

function computeWaveEllipse(waveSettlements) {
  const coords = [];
  for (const s of waveSettlements) {
    const c = fuzzyMatch(s) || CITY_COORDS[s];
    if (c) coords.push(c);
  }
  if (coords.length === 0) return { ellipse: null, hull: null, useHull: false };

  const ellipse = fitEllipse(coords);
  const useHull = ellipse.eccentricity < 0.5;
  const hull = useHull ? convexHull(coords) : null;
  return { ellipse, hull, useHull };
}

function applyAzimuthCorrection(evt) {
  if (!evt.origin || evt.origin === "unknown") return;
  for (const wave of evt.waves) {
    if (wave.ellipse) {
      const corrected = correctAzimuthForOrigin(wave.ellipse.azimuthDeg, evt.origin);
      if (corrected !== wave.ellipse.azimuthDeg) {
        wave.ellipse.azimuthDeg = corrected;
        wave.ellipse.azimuthRad = corrected * Math.PI / 180;
      }
    }
  }
  if (evt.ewEllipse) {
    const corrected = correctAzimuthForOrigin(evt.ewEllipse.azimuthDeg, evt.origin);
    if (corrected !== evt.ewEllipse.azimuthDeg) {
      evt.ewEllipse.azimuthDeg = corrected;
      evt.ewEllipse.azimuthRad = corrected * Math.PI / 180;
    }
  }
}

function hullAreaKm2(hull) {
  if (!hull || hull.length < 4) return 0; // need at least 3 points + closing
  const K_LAT = 111.32;
  const centroidLat = hull.reduce((s, c) => s + c[1], 0) / hull.length;
  const K_LNG = 111.32 * Math.cos(centroidLat * Math.PI / 180);
  // Shoelace formula on projected km coordinates
  let area = 0;
  for (let i = 0; i < hull.length - 1; i++) {
    const x1 = hull[i][0] * K_LNG, y1 = hull[i][1] * K_LAT;
    const x2 = hull[i + 1][0] * K_LNG, y2 = hull[i + 1][1] * K_LAT;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// --- EW→Alarm Pattern Statistics ---

function extractPatternFeatures(evt) {
  if (!evt.ewEllipse || evt.waves.length === 0) return null;
  const alarmEllipse = fitEllipse(
    [...evt.settlements].map(s => fuzzyMatch(s) || CITY_COORDS[s]).filter(Boolean)
  );
  const alarmAreaKm2 = alarmEllipse.semiMajor * alarmEllipse.semiMinor * Math.PI;

  return {
    ewAreaKm2: evt.ewAreaKm2,
    ewEccentricity: evt.ewEllipse.eccentricity,
    ewAxisRatio: evt.ewEllipse.semiMajor / Math.max(0.1, evt.ewEllipse.semiMinor),
    ewAzimuth: evt.ewEllipse.azimuthDeg,
    alarmAreaKm2,
    alarmEccentricity: alarmEllipse.eccentricity,
    ewAlarmAreaRatio: evt.ewAreaKm2 / Math.max(0.1, alarmAreaKm2),
    vectorAzimuth: evt.expansionVector?.direction || null,
    ewToAlarmSeconds: evt.ewToAlarmSeconds,
    regions: [...new Set([...evt.settlements].map(s => REGION_MAP[s] || REGION_MAP[s.split(" - ")[0].trim()]).filter(Boolean))],
    settlementCount: evt.settlements.size,
    waveCount: evt.waves.length,
    origin: evt.origin,
    timestamp: new Date().toISOString(),
  };
}

function patternDistance(a, b) {
  const weights = {
    ewAreaKm2: 1.0, ewEccentricity: 1.5, ewAxisRatio: 0.8,
    ewAzimuth: 1.5, alarmAreaKm2: 1.0, alarmEccentricity: 1.5,
    ewAlarmAreaRatio: 1.2, ewToAlarmSeconds: 1.0,
  };
  let sumSq = 0, count = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (a[key] == null || b[key] == null) continue;
    let diff;
    if (key === "ewAzimuth") {
      diff = Math.abs(a[key] - b[key]);
      diff = Math.min(diff, 360 - diff) / 180;
    } else {
      const max = Math.max(Math.abs(a[key]), Math.abs(b[key]), 0.01);
      diff = Math.abs(a[key] - b[key]) / max;
    }
    sumSq += (diff * w) ** 2;
    count++;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : Infinity;
}

function updatePatternClusters(features) {
  const PATTERNS_PATH = `${DATA_DIR}/ew-alarm-patterns.json`;
  let clusters = [];
  try { clusters = JSON.parse(readFileSync(PATTERNS_PATH, "utf8")); } catch {}

  const THRESHOLD = 0.5;
  let bestCluster = null, bestDist = Infinity;
  for (const c of clusters) {
    const d = patternDistance(features, c);
    if (d < bestDist) { bestDist = d; bestCluster = c; }
  }

  if (bestCluster && bestDist < THRESHOLD) {
    const n = bestCluster.eventCount;
    for (const key of ["ewAreaKm2", "alarmAreaKm2", "ewToAlarmSeconds", "ewEccentricity", "alarmEccentricity", "ewAzimuth"]) {
      if (features[key] != null && bestCluster[`avg_${key}`] != null) {
        bestCluster[`avg_${key}`] = (bestCluster[`avg_${key}`] * n + features[key]) / (n + 1);
      }
    }
    bestCluster.eventCount = n + 1;
    bestCluster.lastSeen = features.timestamp;
    const homeAlerted = (features.regions || []).some(r => r === REGION_MAP[HOME_NAME]);
    bestCluster.homeAlarmCount = (bestCluster.homeAlarmCount || 0) + (homeAlerted ? 1 : 0);
    bestCluster.pAlarmAtHome = bestCluster.homeAlarmCount / bestCluster.eventCount;
    console.log(`[patterns] Updated cluster #${clusters.indexOf(bestCluster)} (${bestCluster.eventCount} events, dist=${bestDist.toFixed(2)})`);
  } else {
    const homeAlerted = (features.regions || []).some(r => r === REGION_MAP[HOME_NAME]);
    const newCluster = {
      clusterId: `c${Date.now()}`,
      eventCount: 1,
      avg_ewAreaKm2: features.ewAreaKm2,
      avg_alarmAreaKm2: features.alarmAreaKm2,
      avg_ewToAlarmSeconds: features.ewToAlarmSeconds,
      avg_ewEccentricity: features.ewEccentricity,
      avg_alarmEccentricity: features.alarmEccentricity,
      avg_ewAzimuth: features.ewAzimuth,
      regions: features.regions,
      origin: features.origin,
      homeAlarmCount: homeAlerted ? 1 : 0,
      pAlarmAtHome: homeAlerted ? 1 : 0,
      lastSeen: features.timestamp,
    };
    clusters.push(newCluster);
    console.log(`[patterns] New cluster ${newCluster.clusterId} (regions: ${features.regions.join(", ")})`);
  }

  try { writeFileSync(PATTERNS_PATH, JSON.stringify(clusters, null, 2)); } catch {}
  return bestCluster?.clusterId || clusters[clusters.length - 1].clusterId;
}

function findMatchingPattern(evt) {
  if (!evt.ewEllipse) return null;
  const PATTERNS_PATH = `${DATA_DIR}/ew-alarm-patterns.json`;
  let clusters = [];
  try { clusters = JSON.parse(readFileSync(PATTERNS_PATH, "utf8")); } catch { return null; }
  if (clusters.length === 0) return null;

  const ewFeatures = {
    ewAreaKm2: evt.ewAreaKm2,
    ewEccentricity: evt.ewEllipse.eccentricity,
    ewAxisRatio: evt.ewEllipse.semiMajor / Math.max(0.1, evt.ewEllipse.semiMinor),
    ewAzimuth: evt.ewEllipse.azimuthDeg,
  };

  let bestCluster = null, bestDist = Infinity;
  for (const c of clusters) {
    if (c.eventCount < 3) continue;
    const d = patternDistance(ewFeatures, {
      ewAreaKm2: c.avg_ewAreaKm2,
      ewEccentricity: c.avg_ewEccentricity,
      ewAzimuth: c.avg_ewAzimuth,
    });
    if (d < bestDist) { bestDist = d; bestCluster = c; }
  }

  if (bestCluster && bestDist < 0.8) {
    return {
      clusterId: bestCluster.clusterId,
      pAlarmAtHome: bestCluster.pAlarmAtHome,
      eventCount: bestCluster.eventCount,
      distance: bestDist,
    };
  }
  return null;
}

function predictAlarmTiming(evt) {
  if (evt.origin !== "iran" || !evt.ewEllipse) return null;
  const match = findMatchingPattern(evt);
  if (!match || match.eventCount < 10) return null;

  const PATTERNS_PATH = `${DATA_DIR}/ew-alarm-patterns.json`;
  let clusters = [];
  try { clusters = JSON.parse(readFileSync(PATTERNS_PATH, "utf8")); } catch { return null; }
  const cluster = clusters.find(c => c.clusterId === match.clusterId);
  if (!cluster || !cluster.avg_ewToAlarmSeconds) return null;

  const avgSeconds = cluster.avg_ewToAlarmSeconds;
  const predictedTime = new Date(evt.startTime + avgSeconds * 1000);
  const confidenceSeconds = Math.max(60, avgSeconds * 0.2);

  return {
    predictedTime,
    confidenceMinutes: Math.round(confidenceSeconds / 60),
    basedOn: match.eventCount,
    clusterId: match.clusterId,
  };
}

function nearestSettlement(coord) {
  let best = null, bestDist = Infinity;
  for (const [name, c] of Object.entries(CITY_COORDS)) {
    const d = haversineKm(coord, c);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

function estimateImpactPoint(evt) {
  if (evt.waves.length === 0) return null;
  const latestWave = evt.waves[evt.waves.length - 1];
  const ellipse = latestWave.ellipse;
  if (!ellipse || !ellipse.K_LNG || !ellipse.K_LAT) return null;

  // Direction: use expansion vector if available, otherwise ellipse major axis
  let dirRad;
  if (evt.expansionVector && evt.expansionVector.magnitude > 0.5) {
    const { origin, target } = evt.expansionVector;
    dirRad = Math.atan2(
      (target[1] - origin[1]) * ellipse.K_LAT,
      (target[0] - origin[0]) * ellipse.K_LNG
    );
  } else {
    dirRad = ellipse.azimuthRad;
  }

  // Impact at leading edge of ellipse (0.5 × semiMajor beyond centroid)
  const projectionFactor = 0.5;
  const dxKm = ellipse.semiMajor * projectionFactor * Math.cos(dirRad);
  const dyKm = ellipse.semiMajor * projectionFactor * Math.sin(dirRad);
  const impactLng = ellipse.centroid[0] + dxKm / ellipse.K_LNG;
  const impactLat = ellipse.centroid[1] + dyKm / ellipse.K_LAT;
  const point = [impactLng, impactLat];

  // Confidence based on eccentricity
  let confidence, uncertaintyKm;
  if (ellipse.eccentricity > 0.7) {
    confidence = "high";
    uncertaintyKm = ellipse.semiMinor;
  } else if (ellipse.eccentricity > 0.5) {
    confidence = "medium";
    uncertaintyKm = ellipse.semiMinor * 2;
  } else {
    confidence = "low";
    uncertaintyKm = ellipse.semiMajor;
  }

  const label = nearestSettlement(point);

  return { point, uncertaintyKm, confidence, label };
}

function detectInterception(evt) {
  if (evt.waves.length < 2) return null;

  for (let i = 1; i < evt.waves.length; i++) {
    const prev = evt.waves[i - 1];
    const curr = evt.waves[i];
    if (!prev.ellipse || !curr.ellipse) continue;

    const prevArea = prev.ellipse.semiMajor * prev.ellipse.semiMinor * Math.PI;
    const currArea = curr.ellipse.semiMajor * curr.ellipse.semiMinor * Math.PI;
    const areaRatio = currArea / Math.max(0.01, prevArea);
    const eccRatio = curr.ellipse.eccentricity / Math.max(0.01, prev.ellipse.eccentricity);

    // Interception: area > 2x AND eccentricity dropped to < 70% of previous
    if (areaRatio > 2.0 && eccRatio < 0.7) {
      // Interception point: 70% of the way between wave centroids
      const pC = prev.ellipse.centroid;
      const cC = curr.ellipse.centroid;
      const point = [
        pC[0] + 0.7 * (cC[0] - pC[0]),
        pC[1] + 0.7 * (cC[1] - pC[1]),
      ];
      const debrisRadiusKm = curr.ellipse.semiMajor;

      return {
        detected: true,
        point,
        debrisRadiusKm,
        detectedAtWave: i,
        label: nearestSettlement(point),
      };
    }
  }
  return null;
}

// --- Position-in-Ellipse Classification ---

function classifyHomePosition(ellipse, homeCoord) {
  const K_LNG = ellipse.K_LNG || 94.92;
  const K_LAT = ellipse.K_LAT || 111.32;
  const dx = (homeCoord[0] - ellipse.centroid[0]) * K_LNG;
  const dy = (homeCoord[1] - ellipse.centroid[1]) * K_LAT;

  // Rotate to ellipse frame
  const cosA = Math.cos(-ellipse.azimuthRad || 0);
  const sinA = Math.sin(-ellipse.azimuthRad || 0);
  const u = dx * cosA - dy * sinA; // along major axis
  const v = dx * sinA + dy * cosA; // along minor axis

  // Normalize by semi-axes
  const a = Math.max(ellipse.semiMajor, 1);
  const b = Math.max(ellipse.semiMinor, 1);
  const nu = u / a;
  const nv = v / b;
  const d = nu * nu + nv * nv; // <1 inside, >1 outside

  let positionType;
  if (d < 1.0 && nu > 0.3) positionType = "END";
  else if (d < 1.0 && nu < -0.3) positionType = "START";
  else if (d < 1.0) positionType = "CENTER";
  else if (d < 2.25) positionType = "NEAR"; // within 1.5x ellipse
  else positionType = "FAR";

  return {
    isInside: d < 1.0,
    normalizedDistance: Math.sqrt(d),
    positionType,
    alongAxis: nu, // negative=start, positive=end
  };
}

// --- Expansion Tracking ---

let alertTimeline = []; // [{timestamp, coords}]

function trackExpansion(currentCoords) {
  const now = Date.now();
  alertTimeline.push({ timestamp: now, coords: currentCoords });
  // Keep last 5 minutes
  alertTimeline = alertTimeline.filter(e => now - e.timestamp < 300000);

  if (alertTimeline.length < 2) {
    return { expandingTowardHome: false, velocity: 0, eta: Infinity };
  }

  const first = alertTimeline[0];
  const last = alertTimeline[alertTimeline.length - 1];
  const dt = (last.timestamp - first.timestamp) / 60000; // minutes
  if (dt < 0.1) return { expandingTowardHome: false, velocity: 0, eta: Infinity };

  const c1 = [
    first.coords.reduce((s, c) => s + c[0], 0) / first.coords.length,
    first.coords.reduce((s, c) => s + c[1], 0) / first.coords.length,
  ];
  const c2 = [
    last.coords.reduce((s, c) => s + c[0], 0) / last.coords.length,
    last.coords.reduce((s, c) => s + c[1], 0) / last.coords.length,
  ];

  const expansionDist = haversineKm(c1, c2);
  const velocity = expansionDist / dt; // km/min

  // Dot product of expansion vector and home direction vector
  const K = 100; // rough scale factor
  const expVec = [(c2[0] - c1[0]) * K, (c2[1] - c1[1]) * K];
  const homeVec = [(HOME_COORD[0] - c1[0]) * K, (HOME_COORD[1] - c1[1]) * K];
  const dot = expVec[0] * homeVec[0] + expVec[1] * homeVec[1];
  const expandingTowardHome = dot > 0;

  const distToHome = haversineKm(c2, HOME_COORD);
  const eta = velocity > 0.1 ? distToHome / velocity : Infinity;

  return { expandingTowardHome, velocity: Math.round(velocity * 10) / 10, eta: Math.round(eta) };
}

// --- Risk Model: Probability Functions (radius-based) ---
// All probabilities mean "within X km radius of home", not "at exact location"
// Base rates from published IDF data + research (see docs/risk-model.md)

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Interception rates — defaults, overridden by calibration data from news scraping
const DEFAULT_INTERCEPTION_RATE = {
  "1": 0.85,  // cat=1 rockets/missiles → Iron Dome ~85%
  "6": 0.60,  // cat=6 drones/UAVs → lower interception rate
};
const DEBRIS_REACH_KM = 10;
const IMPACT_RADIUS_KM = 5;
const BOOM_RADIUS_KM = 25;

// Load calibration data from news scraping (updated after each event)
let calibrationData = {};
try { calibrationData = JSON.parse(readFileSync(`${DATA_DIR}/calibration.json`, "utf8")); } catch {}

function getInterceptionRate(alertCat, origin) {
  // Use calibrated rate if we have enough data (20+ total observations)
  if (origin && calibrationData[origin]) {
    const cal = calibrationData[origin];
    const total = (cal.interceptions || 0) + (cal.impacts || 0);
    if (total >= 20 && cal.computedInterceptionRate !== undefined) {
      console.log(`[risk] using calibrated rate for ${origin}: ${(cal.computedInterceptionRate * 100).toFixed(0)}% (n=${total})`);
      return cal.computedInterceptionRate;
    }
  }
  return DEFAULT_INTERCEPTION_RATE[String(alertCat)] || 0.80;
}

// Reload calibration after each event ends
function reloadCalibration() {
  try { calibrationData = JSON.parse(readFileSync(`${DATA_DIR}/calibration.json`, "utf8")); } catch {}
}

function calculatePAlert(alertRegions, alertSettlements, ellipse, homePosition, expansion, closestDist) {
  // Already alerted at home
  for (const s of alertSettlements) {
    if (s.includes(HOME_NAME) || HOME_NAME.includes(s)) return 1.0;
  }
  const homeRegion = REGION_MAP[HOME_NAME];
  if (homeRegion && alertRegions.has(homeRegion)) return 0.95;

  // Distance-based decay (primary factor)
  let pDistance;
  if (closestDist < 10) pDistance = 0.80;
  else if (closestDist < 30) pDistance = 0.50 - (closestDist - 10) * 0.015;
  else if (closestDist < 80) pDistance = 0.20 - (closestDist - 30) * 0.003;
  else pDistance = Math.max(0.01, 0.05 - (closestDist - 80) * 0.0005);

  // Expansion boost: if alerts are expanding toward home
  let expansionBoost = 0;
  if (expansion.expandingTowardHome && expansion.velocity > 0.3) {
    expansionBoost = clamp(0.15 + expansion.velocity * 0.05, 0, 0.35);
  }

  // Event size boost: large attacks spread wider
  const sizeBoost = alertSettlements.length > 50 ? 0.10 :
                    alertSettlements.length > 20 ? 0.05 : 0;

  return clamp(pDistance + expansionBoost + sizeBoost, 0, 1);
}

function calculatePImpact(pAlert, closestDist, alertCat, origin) {
  const pNotIntercepted = 1 - getInterceptionRate(alertCat, origin);
  const pHitsPopulated = 0.15;
  const pWithin5km = closestDist < 5 ? 0.30 :
                     closestDist < 15 ? 0.15 :
                     closestDist < 30 ? 0.08 : 0.03;

  return clamp(pAlert * pNotIntercepted * pHitsPopulated * pWithin5km, 0, 1);
}

function calculatePDebris(pAlert, closestDist, alertCat, origin) {
  const pIntercepted = getInterceptionRate(alertCat, origin);
  const pNotableDebris = 0.30;
  const pWithinRange = closestDist < DEBRIS_REACH_KM
    ? 0.25 * (1 - closestDist / DEBRIS_REACH_KM)
    : closestDist < 20 ? 0.05 : 0.01;

  return clamp(pAlert * pIntercepted * pNotableDebris * pWithinRange, 0, 1);
}

function calculatePBoom(alertCoords, pAlert, closestDist, alertCat, origin) {
  const nearbyCount = alertCoords.filter(c => haversineKm(c, HOME_COORD) < BOOM_RADIUS_KM).length;
  const nearbyRatio = nearbyCount / Math.max(alertCoords.length, 1);

  const pInterceptionBoom = nearbyRatio * getInterceptionRate(alertCat, origin);
  const pImpactBoom = nearbyRatio * (1 - getInterceptionRate(alertCat, origin)) * 0.15;

  let pBoom = 1 - (1 - pInterceptionBoom) * (1 - pImpactBoom);
  if (nearbyRatio > 0.3 && closestDist < 30) pBoom = Math.max(pBoom, 0.90);

  return clamp(pBoom, 0, 1);
}

// --- Combined Risk Analysis ---

function analyzeRisk(alertCoords, alertRegions, alertSettlements, alertCat, origin) {
  if (alertCoords.length === 0) return null;

  const ellipse = fitEllipse(alertCoords);
  const homePosition = classifyHomePosition(ellipse, HOME_COORD);
  const expansion = trackExpansion(alertCoords);
  const closestDist = Math.min(...alertCoords.map(c => haversineKm(HOME_COORD, c)));
  const dir = bearing(HOME_COORD, ellipse.centroid);
  const cat = alertCat || "1";

  const regions = alertRegions instanceof Set ? alertRegions : new Set(alertRegions || []);
  const settlements = alertSettlements || [];

  const pAlert = calculatePAlert(regions, settlements, ellipse, homePosition, expansion, closestDist);
  const pImpact = calculatePImpact(pAlert, closestDist, cat, origin);
  const pDebris = calculatePDebris(pAlert, closestDist, cat, origin);
  const pBoom = calculatePBoom(alertCoords, pAlert, closestDist, cat, origin);

  const threatType = cat === "6" ? "כלי טיס" : "רקטות";
  const interceptRate = Math.round(getInterceptionRate(cat, origin) * 100);

  return {
    closestDist: Math.round(closestDist),
    dir,
    threatType,
    interceptRate,
    ellipse: {
      azimuth: Math.round(ellipse.azimuthDeg),
      eccentricity: Math.round(ellipse.eccentricity * 100) / 100,
      area: Math.round(Math.PI * ellipse.semiMajor * ellipse.semiMinor),
    },
    homePosition: homePosition.positionType,
    expansion,
    probabilities: {
      alert: Math.round(pAlert * 100),
      impact: Math.round(pImpact * 100),
      debris: Math.round(pDebris * 100),
      boom: Math.round(pBoom * 100),
    },
  };
}

function formatRiskMessage(alertCoords, alertRegions, alertSettlements, alertCat, origin, isDirect = false, prediction = null, impact = null, interception = null) {
  // Skip risk analysis for drone attacks (cat=6) — not relevant
  if (String(alertCat) === "6") return "";
  const risk = analyzeRisk(alertCoords, alertRegions, alertSettlements, alertCat, origin);
  if (!risk) return "";

  const p = risk.probabilities;
  const pEmoji = (v) => v >= 70 ? "🔴" : v >= 40 ? "🟠" : v >= 15 ? "🟡" : "🟢";

  let expansionNote = "";
  if (risk.expansion.expandingTowardHome && risk.expansion.velocity > 0.5) {
    expansionNote = `\n⚡ מתרחב לכיוונך (${risk.expansion.eta} דק׳)`;
  }

  const directNote = isDirect ? "\n⚡ ירי ישיר (ללא התרעה מוקדמת)" : "";

  const originLabels = { iran: "ירי מאיראן", yemen: "ירי מתימן", lebanon: "ירי מלבנון", gaza: "ירי מעזה" };
  const originLabel = originLabels[origin] || "";
  let predictionNote = "";
  if (prediction?.predictedTime) {
    const timeStr = prediction.predictedTime.toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });
    predictionNote = `\nצפי לאזעקה ב-${timeStr} (±${prediction.confidenceMinutes} דק׳, מבוסס על ${prediction.basedOn} אירועים)`;
  }

  const confidenceLabels = { high: "ודאות גבוהה", medium: "ודאות בינונית", low: "ודאות נמוכה" };
  let impactNote = "";
  if (interception?.detected && interception.label) {
    impactNote = `\n🛡️ יירוט זוהה — ${interception.label}`;
    if (interception.debrisRadiusKm) impactNote += ` | רסיסים ~${Math.round(interception.debrisRadiusKm)} ק״מ`;
  } else if (impact?.point && impact.label) {
    impactNote = `\n🎯 נפילה משוערת: ${impact.label} (${confidenceLabels[impact.confidence] || ""}, ±${Math.round(impact.uncertaintyKm)} ק״מ)`;
  }

  // Compact format: threat type, distance, probabilities (all within radius)
  return (
    `\n\n🏠 ${HOME_NAME} | ${risk.closestDist} ק״מ ${risk.dir}${originLabel ? ` | ${originLabel}` : ""} | ${risk.threatType} (יירוט ${risk.interceptRate}%)` +
    `\n${pEmoji(p.alert)} אזעקה ${p.alert}% | נפילה ב-5ק״מ ${p.impact}% | רסיס ב-5ק״מ ${p.debris}% | בום ב-25ק״מ ${p.boom}%` +
    expansionNote +
    directNote +
    predictionNote +
    impactNote
  );
}

// Small dot marker for settlements <10K population
const DOT_SVG = `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">
  <circle cx="5" cy="5" r="4" fill="#e53935" stroke="white" stroke-width="1" opacity="0.85"/>
</svg>`;
const DOT_MARKER_PATH = "/tmp/oref-dot-marker.png";

// Home marker (blue dot, larger)
const HOME_SVG = `<svg width="18" height="18" xmlns="http://www.w3.org/2000/svg">
  <circle cx="9" cy="9" r="7" fill="#1976D2" stroke="white" stroke-width="2" opacity="0.95"/>
</svg>`;
const HOME_MARKER_PATH = "/tmp/oref-home-marker.png";

// Impact crosshair marker (red ⊕)
const IMPACT_SVG = `<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <circle cx="10" cy="10" r="8" fill="none" stroke="#F44336" stroke-width="2"/>
  <line x1="10" y1="2" x2="10" y2="18" stroke="#F44336" stroke-width="2"/>
  <line x1="2" y1="10" x2="18" y2="10" stroke="#F44336" stroke-width="2"/>
</svg>`;
const IMPACT_MARKER_PATH = "/tmp/oref-impact-marker.png";

// Interception crosshair marker (green ⊕)
const INTERCEPT_SVG = `<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <circle cx="10" cy="10" r="8" fill="none" stroke="#4CAF50" stroke-width="2"/>
  <line x1="10" y1="2" x2="10" y2="18" stroke="#4CAF50" stroke-width="2"/>
  <line x1="2" y1="10" x2="18" y2="10" stroke="#4CAF50" stroke-width="2"/>
</svg>`;
const INTERCEPT_MARKER_PATH = "/tmp/oref-intercept-marker.png";

import sharp from "sharp";

async function ensureMarkers() {
  try { await sharp(Buffer.from(DOT_SVG)).png().toFile(DOT_MARKER_PATH); } catch {}
  try { await sharp(Buffer.from(HOME_SVG)).png().toFile(HOME_MARKER_PATH); } catch {}
  try { await sharp(Buffer.from(IMPACT_SVG)).png().toFile(IMPACT_MARKER_PATH); } catch {}
  try { await sharp(Buffer.from(INTERCEPT_SVG)).png().toFile(INTERCEPT_MARKER_PATH); } catch {}
}

// Resolve areas to coordinates
async function resolveCoords(areas) {
  const coordMap = new Map();
  const missed = [];
  for (const area of areas) {
    const coord = await geocode(area);
    if (coord) coordMap.set(area, coord);
    else missed.push(area);
  }
  console.log(`[resolveCoords] ${coordMap.size}/${areas.length} resolved${missed.length > 0 ? `, MISSING: ${missed.join(", ")}` : ""}`);

  // Outlier detection: exclude settlements >3 std devs from centroid
  if (coordMap.size >= 3) {
    const coords = [...coordMap.values()];
    const centroid = [
      coords.reduce((s, c) => s + c[0], 0) / coords.length,
      coords.reduce((s, c) => s + c[1], 0) / coords.length,
    ];
    const distances = coords.map(c => haversineKm(centroid, c));
    const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
    const stdDev = Math.sqrt(distances.reduce((s, d) => s + (d - mean) ** 2, 0) / distances.length);

    if (stdDev > 0) {
      const threshold = mean + 3 * stdDev;
      for (const [area, coord] of coordMap) {
        const dist = haversineKm(centroid, coord);
        if (dist > threshold) {
          console.warn(`[geocode:outlier] "${area}" at [${coord}] is ${dist.toFixed(0)}km from centroid (threshold: ${threshold.toFixed(0)}km) — excluded from map`);
          coordMap.delete(area);
        }
      }
    }
  }

  return [...coordMap.values()];
}

// Cluster detection: split settlements into geographically distinct groups
// Uses single-linkage clustering with 60km threshold
const CLUSTER_DISTANCE_KM = 60;

function clusterSettlements(areas) {
  // Resolve coordinates for each area
  const items = [];
  for (const area of areas) {
    const coord = fuzzyMatch(area) || CITY_COORDS[area];
    if (coord) items.push({ area, coord });
  }
  if (items.length === 0) return [areas];

  // Single-linkage clustering: union-find
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (haversineKm(items[i].coord, items[j].coord) < CLUSTER_DISTANCE_KM) {
        union(i, j);
      }
    }
  }

  // Group by cluster root
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i].area);
  }

  // Only split if we get 2+ clusters with meaningful size (at least 3 settlements each)
  const clusters = [...groups.values()].filter(g => g.length >= 3);
  if (clusters.length < 2) return [areas];

  // Don't split if one cluster dominates (>75% of total) — it's one massive event
  const total = clusters.reduce((s, c) => s + c.length, 0);
  if (clusters.some(c => c.length / total > 0.75)) return [areas];

  return clusters;
}

function waveOpacityHex(waveIndex, totalWaves, baseOpacity = 0x80) {
  const alpha = Math.round(baseOpacity / (totalWaves - waveIndex));
  return alpha.toString(16).padStart(2, "0");
}

// Generate map with polygon areas for large settlements and dots for small ones
async function generateAlertMap(areas, evt = null) {
  await ensureMarkers();
  if (areas.length === 0) return null;

  // Israel geographic bounds — map never shows outside these
  const IL_BOUNDS = { minLon: 34.2, maxLon: 35.9, minLat: 29.4, maxLat: 33.4 };

  // Calculate bounding box — only include coords within Israel
  const areaCoords = areas.map(a => fuzzyMatch(a) || CITY_COORDS[a]).filter(Boolean)
    .filter(c => c[0] >= IL_BOUNDS.minLon && c[0] <= IL_BOUNDS.maxLon && c[1] >= IL_BOUNDS.minLat && c[1] <= IL_BOUNDS.maxLat);
  if (areaCoords.length === 0) return null;

  const lons = areaCoords.map(c => c[0]);
  const lats = areaCoords.map(c => c[1]);
  const center = [
    Math.max(IL_BOUNDS.minLon, Math.min(IL_BOUNDS.maxLon, (Math.min(...lons) + Math.max(...lons)) / 2)),
    Math.max(IL_BOUNDS.minLat, Math.min(IL_BOUNDS.maxLat, (Math.min(...lats) + Math.max(...lats)) / 2)),
  ];
  const spanLon = Math.max(...lons) - Math.min(...lons);
  const spanLat = Math.max(...lats) - Math.min(...lats);
  const span = Math.max(spanLon, spanLat);

  // Zoom: pick level that fits all settlements with margin
  let zoom;
  if (span < 0.05) zoom = 13;
  else if (span < 0.15) zoom = 12;
  else if (span < 0.4) zoom = 11;
  else if (span < 1.0) zoom = 10;
  else zoom = 9; // very large events (100+ settlements across Israel)

  // Use portrait ratio for tall spans (north-south), landscape for wide
  const isPortrait = spanLat > spanLon * 1.3;
  const mapW = isPortrait ? 1024 : 1280;
  const mapH = isPortrait ? 1280 : 1024;

  const map = new StaticMaps({
    width: mapW,
    height: mapH,
    paddingX: 40,
    paddingY: 40,
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  });

  const waves = evt ? evt.waves : [];
  const isEarlyWarning = evt ? evt.phase === "early_warning" : false;

  // Determine which wave a settlement belongs to
  const getWaveIndex = (settlement) => {
    for (let i = waves.length - 1; i >= 0; i--) {
      if (waves[i].settlements.has(settlement)) return i;
    }
    return -1;
  };

  // Group settlements by wave for coloring
  const earlyWarningSettlements = [];
  const waveGroups = waves.map(() => []);

  for (const area of areas) {
    const waveIdx = getWaveIndex(area);
    if (waveIdx >= 0 && waveIdx < waveGroups.length) {
      waveGroups[waveIdx].push(area);
    } else {
      earlyWarningSettlements.push(area);
    }
  }

  // Track already-rendered boundaries to avoid drawing the same polygon twice
  // (e.g. "תל אביב - מרכז" and "תל אביב - דרום" both map to תל אביב polygon)
  const renderedBoundaries = new Set();

  // Find boundary data for a settlement, with fuzzy matching for subdivisions
  const findBoundary = (area) => {
    if (SETTLEMENT_BOUNDARIES[area]?.boundary) return SETTLEMENT_BOUNDARIES[area];
    // Check if area name contains a boundary key: "אשקלון - דרום".includes("אשקלון")
    // Also check if boundary key contains area: for shared base names
    // Sort by longest key first to prefer more specific matches
    const keys = Object.keys(SETTLEMENT_BOUNDARIES).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (!SETTLEMENT_BOUNDARIES[k]?.boundary) continue;
      // Extract base name before " - " separator for both sides
      const areaBase = area.split(" - ")[0].trim();
      const keyBase = k.split(" - ")[0].trim();
      if (areaBase === keyBase || area.includes(k) || k.includes(area)) {
        return SETTLEMENT_BOUNDARIES[k];
      }
    }
    return null;
  };

  // Render function: add polygon or dot for a settlement
  const renderSettlement = (area, colors) => {
    const bd = findBoundary(area);

    if (bd?.boundary) {
      // Skip polygons outside Israel
      if (bd.coords && (bd.coords[0] < IL_BOUNDS.minLon || bd.coords[0] > IL_BOUNDS.maxLon || bd.coords[1] < IL_BOUNDS.minLat || bd.coords[1] > IL_BOUNDS.maxLat)) {
        console.warn(`[map] "${area}" → SKIPPED polygon (outside Israel: [${bd.coords}])`);
        return;
      }
      // Skip if this boundary was already rendered (e.g. Tel Aviv subdivisions)
      const boundaryKey = bd.name || area;
      if (renderedBoundaries.has(boundaryKey)) {
        console.log(`[map] "${area}" → skip (already rendered as "${boundaryKey}")`);
        return;
      }
      renderedBoundaries.add(boundaryKey);

      // Render as filled polygon
      const geojson = bd.boundary;
      const rings = geojson.type === "MultiPolygon"
        ? geojson.coordinates.flat()
        : geojson.coordinates;
      console.log(`[map] "${area}" → POLYGON "${boundaryKey}" (pop=${bd.population}, ${rings.length} rings, fill=${colors.fill})`);
      for (const ring of rings) {
        map.addPolygon({
          coords: ring, // [lng, lat] pairs — matches staticmaps convention
          color: colors.stroke,
          fill: colors.fill,
          width: 1.5,
        });
      }
    } else {
      // Render as circle area for settlements <10K (3km radius — visible at any zoom)
      const coord = fuzzyMatch(area) || CITY_COORDS[area];
      if (coord && (coord[0] < IL_BOUNDS.minLon || coord[0] > IL_BOUNDS.maxLon || coord[1] < IL_BOUNDS.minLat || coord[1] > IL_BOUNDS.maxLat)) {
        console.warn(`[map] "${area}" → SKIPPED circle (outside Israel: [${coord}])`);
        return;
      }
      if (coord) {
        console.log(`[map] "${area}" → CIRCLE at [${coord}] (${bd ? `pop=${bd.population}, no boundary` : "no boundary data"}, fill=${colors.fill})`);
        map.addCircle({
          coord,
          radius: 500, // 500m in meters
          color: colors.stroke,
          fill: colors.fill,
          width: 1,
        });
      } else {
        console.warn(`[map] "${area}" → SKIPPED (no coords found)`);
      }
    }
  };

  // --- EW zone (bottom-most layer) — amber convex hull of early warning area ---
  if (evt?.ewHull && evt.ewHull.length >= 3) {
    const ewFill = "#FFC10740"; // yellow/amber at ~25% opacity
    const ewStroke = "#FF8F0060"; // darker amber at ~37% opacity
    map.addPolygon({
      coords: evt.ewHull,
      color: ewStroke,
      fill: ewFill,
      width: 1.5,
    });
  }

  // --- Ellipse / hull visualization (bottom layer, rendered before settlements) ---
  if (evt && waves.length > 0) {
    const totalWaves = waves.length;
    for (let i = 0; i < totalWaves; i++) {
      const wave = waves[i];
      if (!wave.ellipse && !wave.hull) continue;

      const waveColor = WAVE_COLORS.waves[Math.min(i, WAVE_COLORS.waves.length - 1)];
      const alphaHex = waveOpacityHex(i, totalWaves);
      // Extract RGB from stroke color (e.g. "#B71C1C" → "B71C1C")
      const rgb = waveColor.stroke.replace("#", "");
      const fillColor = `#${rgb}${alphaHex}`;
      const strokeColor = `#${rgb}60`; // subtle stroke at ~37% opacity

      let polyCoords;
      if (wave.useHull && wave.hull) {
        polyCoords = wave.hull;
      } else if (wave.ellipse) {
        polyCoords = ellipseToPolygon(wave.ellipse);
      }

      if (polyCoords && polyCoords.length >= 3) {
        map.addPolygon({
          coords: polyCoords,
          color: strokeColor,
          fill: fillColor,
          width: 1,
        });
      }
    }
  }

  // Render early warning settlements (orange) — always orange regardless of current phase
  for (const area of earlyWarningSettlements) {
    renderSettlement(area, WAVE_COLORS.early_warning);
  }

  // Render each wave with its color
  for (let i = 0; i < waveGroups.length; i++) {
    const colors = WAVE_COLORS.waves[Math.min(i, WAVE_COLORS.waves.length - 1)];
    for (const area of waveGroups[i]) {
      renderSettlement(area, colors);
    }
  }

  // --- Debris zone (green dashed circle) --- if interception detected
  if (evt?.interception?.detected && evt.interception.point) {
    const ic = evt.interception;
    map.addCircle({
      coord: ic.point,
      radius: ic.debrisRadiusKm * 1000, // km to meters
      color: "#4CAF50",
      fill: "#4CAF5033", // 20% opacity
      width: 1.5,
    });
  }

  // --- Impact uncertainty circle (red) ---
  if (evt?.estimatedImpact?.point) {
    const impact = evt.estimatedImpact;
    map.addCircle({
      coord: impact.point,
      radius: impact.uncertaintyKm * 1000, // km to meters
      color: "#F44336",
      fill: "#F4433650", // ~30% opacity
      width: 1.5,
    });
  }

  // --- Expansion vector arrow ---
  if (evt?.expansionVector && evt.expansionVector.magnitude > 0.5) {
    const { origin, target, towardHome, magnitude } = evt.expansionVector;
    const useHull = evt.waves[evt.waves.length - 1]?.useHull;

    // Arrow color: red if toward home, orange otherwise
    const arrowColor = towardHome ? "#F44336" : "#FF9800";

    // Extend arrow beyond target proportional to magnitude (capped at 30km visual)
    const latestEllipse = evt.waves[evt.waves.length - 1]?.ellipse;
    const extendKm = useHull
      ? Math.min(magnitude * 0.5, 15) // hull mode: 50% cap
      : Math.min((latestEllipse?.semiMajor || 10) * 1.5, 30);
    const totalDist = haversineKm(origin, target);
    const scale = totalDist > 0 ? (totalDist + extendKm) / totalDist : 1;
    const tipLng = origin[0] + (target[0] - origin[0]) * scale;
    const tipLat = origin[1] + (target[1] - origin[1]) * scale;
    const tip = [tipLng, tipLat];

    // Arrow shaft
    map.addLine({
      coords: [origin, tip],
      color: arrowColor,
      width: 3,
    });

    // Arrowhead: triangle at tip, perpendicular to shaft direction
    // Correct for longitude compression at Israel's latitude
    const cosLat = Math.cos((tip[1] + origin[1]) / 2 * Math.PI / 180);
    const dx = (tip[0] - origin[0]) * cosLat;
    const dy = tip[1] - origin[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const headSize = len * 0.15; // 15% of shaft length
      const ux = dx / len; // unit vector along shaft (in corrected space)
      const uy = dy / len;
      const px = -uy; // perpendicular
      const py = ux;
      // Convert back to degree-space for coordinates
      const base1 = [tip[0] - (ux * headSize - px * headSize * 0.5) / cosLat, tip[1] - uy * headSize + py * headSize * 0.5];
      const base2 = [tip[0] - (ux * headSize + px * headSize * 0.5) / cosLat, tip[1] - uy * headSize - py * headSize * 0.5];
      map.addPolygon({
        coords: [tip, base1, base2, tip],
        color: arrowColor,
        fill: arrowColor,
        width: 1,
      });
    }
  }

  // --- Interception crosshair (green ⊕) ---
  if (evt?.interception?.detected && evt.interception.point) {
    map.addMarker({
      coord: evt.interception.point,
      img: INTERCEPT_MARKER_PATH,
      height: 20,
      width: 20,
      offsetX: 10,
      offsetY: 10,
    });
  }

  // --- Impact crosshair (red ⊕) ---
  if (evt?.estimatedImpact?.point) {
    map.addMarker({
      coord: evt.estimatedImpact.point,
      img: IMPACT_MARKER_PATH,
      height: 20,
      width: 20,
      offsetX: 10,
      offsetY: 10,
    });
  }

  // Add home marker (blue dot) only if within 80km of alert area
  // Otherwise it pulls the map center away from the alerts
  const alertCenterCoords = areas.map(a => fuzzyMatch(a) || CITY_COORDS[a]).filter(Boolean);
  if (alertCenterCoords.length > 0) {
    const alertCentroid = [
      alertCenterCoords.reduce((s, c) => s + c[0], 0) / alertCenterCoords.length,
      alertCenterCoords.reduce((s, c) => s + c[1], 0) / alertCenterCoords.length,
    ];
    const homeDistKm = haversineKm(HOME_COORD, alertCentroid);
    if (homeDistKm <= 80) {
      map.addMarker({
        coord: HOME_COORD,
        img: HOME_MARKER_PATH,
        height: 18,
        width: 18,
        offsetX: 9,
        offsetY: 9,
      });
    }
  }

  try {
    await map.render(center, zoom);
    const mapPath = "/tmp/oref-alert-map.png";
    await map.image.save(mapPath);
    console.log(`[map] rendered: center=[${center[0].toFixed(3)},${center[1].toFixed(3)}] zoom=${zoom} span=${span.toFixed(3)}° (${areas.length} settlements)`);
    return mapPath;
  } catch (e) {
    console.error("[מפה] שגיאה ברנדור:", e.message);
    return null;
  }
}

// Telegram: send text (with optional inline keyboard and edit support)
async function sendTelegram(message, chatId = TELEGRAM_CHANNEL_ID, opts = {}) {
  try {
    const body = {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    };
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    if (opts.threadId) body.message_thread_id = opts.threadId;
    if (opts.replyToMsgId) {
      body.reply_parameters = { message_id: opts.replyToMsgId };
      if (opts.replyChatId) body.reply_parameters.chat_id = opts.replyChatId;
    }

    // Edit existing message if messageId provided
    if (opts.editMessageId) {
      body.message_id = opts.editMessageId;
      console.log(`[telegram] editMessageText → chat=${chatId} msg=${opts.editMessageId}`);
      const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.ok) console.error(`[telegram] editMessageText FAILED: ${JSON.stringify(result)}`);
      return result;
    }

    const replyInfo = body.reply_parameters ? ` reply_to=${body.reply_parameters.message_id} in chat=${body.reply_parameters.chat_id || 'same'}` : '';
    const threadInfo = body.message_thread_id ? ` thread=${body.message_thread_id}` : '';
    console.log(`[telegram] sendMessage → chat=${chatId} (${message.length} chars)${replyInfo}${threadInfo}`);
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`[telegram] sendMessage OK → msg_id=${result.result.message_id}`);
      if (body.reply_parameters) {
        const r = result.result;
        console.log(`[telegram] reply result: msg_id=${r.message_id}, thread=${r.message_thread_id}, reply_to=${r.reply_to_message?.message_id}, is_topic=${r.is_topic_message}`);
      }
    }
    else console.error(`[telegram] sendMessage FAILED: ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    console.error(`[telegram] sendMessage error: ${err.message}`);
  }
}

// Telegram: answer callback query
async function answerCallback(callbackId, text) {
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
  } catch {}
}

// Telegram: send or update photo (evt parameter for per-event map tracking)
async function sendTelegramPhoto(filePath, caption, chatId = TELEGRAM_CHANNEL_ID, evt = null) {
  try {
    const fileBuffer = readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: "image/png" });

    // Try to edit existing map message for this event
    const mapMsgId = evt ? evt.lastMapMessageId : null;
    if (mapMsgId && chatId === TELEGRAM_CHANNEL_ID) {
      console.log(`[telegram] editMessageMedia → chat=${chatId} msg=${mapMsgId}`);
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("message_id", mapMsgId);
      form.append("media", JSON.stringify({ type: "photo", media: "attach://photo", caption, parse_mode: "HTML" }));
      form.append("photo", blob, "map.png");

      const res = await fetch(`${TELEGRAM_API}/editMessageMedia`, { method: "POST", body: form });
      const result = await res.json();
      if (result.ok) {
        console.log(`[telegram] editMessageMedia OK`);
        return result;
      }
      console.error(`[telegram] editMessageMedia FAILED: ${JSON.stringify(result)}`);
      return null;
    }

    // Send new photo with boom button
    console.log(`[telegram] sendPhoto → chat=${chatId} caption="${caption}"`);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", blob, "map.png");
    form.append("caption", caption);
    form.append("parse_mode", "HTML");

    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: "POST", body: form });
    const result = await res.json();
    if (result.ok) {
      console.log(`[telegram] sendPhoto OK → msg_id=${result.result.message_id}`);
      if (evt && chatId === TELEGRAM_CHANNEL_ID) {
        evt.lastMapMessageId = result.result.message_id;
      }
    } else {
      console.error(`[telegram] sendPhoto FAILED: ${JSON.stringify(result)}`);
    }
    return result;
  } catch (err) {
    console.error(`[telegram] sendPhoto error: ${err.message}`);
  }
}

// --- Event lifecycle helpers ---

// Boom button — URL deep link transfers user to bot chat, callback_data as fallback
let BOOM_BUTTONS = { inline_keyboard: [[
  { text: "💥 שמעתי בום!", callback_data: "fb_boom_start" },
]] };

// Auto-detect bot username + discussion group at startup
(async () => {
  try {
    const res = await fetch(`${TELEGRAM_API}/getMe`);
    const data = await res.json();
    if (data.ok && data.result.username) {
      BOOM_BUTTONS = { inline_keyboard: [[
        { text: "💥 שמעתי בום!", url: `https://t.me/${data.result.username}?start=boom` },
      ]] };
      console.log(`Bot username: @${data.result.username}`);
    }
  } catch {}

  // Auto-detect linked discussion group from channel
  if (!TELEGRAM_DISCUSSION_ID) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getChat?chat_id=${encodeURIComponent(TELEGRAM_CHANNEL_ID)}`);
      const data = await res.json();
      if (data.ok && data.result.linked_chat_id) {
        TELEGRAM_DISCUSSION_ID = data.result.linked_chat_id.toString();
        console.log(`Discussion group auto-detected: ${TELEGRAM_DISCUSSION_ID} ("${data.result.title}" → linked chat)`);
      }
    } catch (e) {
      console.warn(`[discussion] auto-detect failed: ${e.message}`);
    }
  }
})();

// Message style: A=minimal, B=clean, C=balanced, D=emoji-rich
let messageStyle = "B";
let activeRenderer = "static"; // "static" = staticmaps polygon approximation, "leaflet" = future puppeteer+Leaflet

function buildEventMessageStyleA(evt) {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const regionStr = summarizeAreasMacro([...evt.settlements]);

  const phaseLabel = { early_warning: "התרעה מוקדמת", alert: "אזעקה", waiting: "המתנה במרחב מוגן", ended: "אירוע הסתיים" }[evt.phase] || "";
  const timeRange = evt.phase === "ended" ? `${evt.startTimeStr}–${now}` : evt.startTimeStr;

  let msg = `<b>${phaseLabel} | ${regionStr}</b>\n${timeRange} | ${evt.settlements.size} ישובים | ${evt.waves.length} גלים`;

  if (evt.riskMsg) {
    // Compact risk: one line
    msg += `\n\nרחובות: ${evt.riskMsg.replace(/\n/g, " ").replace(/<[^>]+>/g, "").trim().substring(0, 120)}`;
  }
  const { short: newsShort } = formatNewsForUpdate(evt);
  if (newsShort) msg += newsShort;

  if (evt.history.length > 1 || evt.phase !== "early_warning") {
    const lines = evt.history.map(h => `${h.time} — ${h.text.replace(/[⚠️🚨🟡✅]/g, "").trim()}`).join("\n");
    msg += `\n\n${lines}`;
  }
  return msg;
}

function buildEventMessageStyleB(evt) {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const regionStr = summarizeAreasMacro([...evt.settlements]);

  const phaseMap = { early_warning: "⚠️ התרעה מוקדמת", alert: "🔴 אזעקה", waiting: "🟡 המתנה", ended: "✅ הסתיים" };
  const timeRange = evt.phase === "ended"
    ? `${evt.startTimeStr}–${now} (${Math.floor((Date.now() - evt.startTime) / 60000)} דק')`
    : evt.startTimeStr;

  let msg = `${phaseMap[evt.phase] || ""} <b>${regionStr}</b>\n⏰ ${timeRange} — ${evt.settlements.size} ישובים`;

  if (evt.riskMsg) msg += evt.riskMsg;
  const { short: newsShort } = formatNewsForUpdate(evt);
  if (newsShort) msg += newsShort;

  if (evt.history.length > 1 || evt.phase !== "early_warning") {
    const lines = evt.history.map(h => `${h.time} ${h.text}`).join("\n");
    msg += `\n\n<blockquote>${lines}</blockquote>`;
  }
  return msg;
}

function buildEventMessageStyleC(evt) {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const regionStr = summarizeAreasMacro([...evt.settlements]);

  const phaseMap = { early_warning: "⚠️", alert: "🚨", waiting: "🟡", ended: "✅" };
  const labelMap = { early_warning: "התרעה מוקדמת", alert: "אזעקה", waiting: "שהייה במקלטים", ended: "אירוע הסתיים" };
  const timeRange = evt.phase === "ended"
    ? `${evt.startTimeStr}–${now} (${Math.floor((Date.now() - evt.startTime) / 60000)} דק')`
    : evt.startTimeStr;

  let msg = `${phaseMap[evt.phase]} <b>${labelMap[evt.phase]} | ${regionStr}</b>\n⏰ ${timeRange} | ${evt.settlements.size} ישובים | ${evt.waves.length} גלים`;

  if (evt.riskMsg) msg += evt.riskMsg;
  const { short: newsShort } = formatNewsForUpdate(evt);
  if (newsShort) msg += newsShort;

  if (evt.history.length > 1 || evt.phase !== "early_warning") {
    const lines = evt.history.map(h => `${h.time} — ${h.text}`).join("\n");
    msg += `\n\n<blockquote>📜 היסטוריה:\n${lines}</blockquote>`;
  }
  return msg;
}

function parseProtectionMinutes(desc) {
  const m = desc.match(/(\d+)\s*דקות/);
  if (m) return parseInt(m[1]);
  if (desc.includes("דקה וחצי")) return 1.5;
  if (desc.includes("דקה")) return 1;
  return 10;
}

// Get regions that had actual alerts (not just early warnings)
function getAlertRegions(evt) {
  const alertSettlements = new Set();
  for (const wave of evt.waves) {
    for (const s of wave.settlements) alertSettlements.add(s);
  }
  const regions = new Set();
  for (const s of alertSettlements) {
    if (REGION_MAP[s]) regions.add(REGION_MAP[s]);
    else {
      const base = s.split(" - ")[0].trim();
      if (base !== s && REGION_MAP[base]) regions.add(REGION_MAP[base]);
    }
  }
  return [...regions];
}

// Style D: emoji-rich (original)
function buildEventMessageStyleD(evt) {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const alertRegionStr = summarizeAreasMacro([...evt.settlements]);

  let header, timeLine;
  if (evt.phase === "early_warning") {
    header = `⚠️ <b>התרעה מוקדמת באזורים:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${evt.startTimeStr}`;
  } else if (evt.phase === "alert") {
    header = `🚨 <b>אזעקה באזורים:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${evt.startTimeStr}`;
  } else if (evt.phase === "waiting") {
    header = `🟡 <b>שהייה במקלטים ב:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${evt.startTimeStr}`;
  } else if (evt.phase === "ended") {
    const sec = Math.round((Date.now() - evt.startTime) / 1000);
    header = `✅ <b>אירוע הסתיים ב:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${evt.startTimeStr}–${now} (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")})`;
  }

  let msg = `${header}\n${timeLine}`;
  if (evt.riskMsg) msg += evt.riskMsg;
  const { short: newsShort } = formatNewsForUpdate(evt);
  if (newsShort) msg += newsShort;

  if (evt.history.length > 1 || evt.phase !== "early_warning") {
    const lines = evt.history.map(h => `${h.time} — ${h.text}`).join("\n");
    msg += `\n\n<blockquote>📜 היסטוריה:\n${lines}</blockquote>`;
  }
  return msg;
}

function buildEventMessage(evt) {
  switch (messageStyle) {
    case "A": return buildEventMessageStyleA(evt);
    case "B": return buildEventMessageStyleB(evt);
    case "C": return buildEventMessageStyleC(evt);
    case "D": return buildEventMessageStyleD(evt);
    default: return buildEventMessageStyleB(evt);
  }
}

async function updateEventMessage(evt) {
  let msg = buildEventMessage(evt);
  if (evt.isTest) msg = `🧪 <b>[טסט — אין להסתמך על הודעה זו]</b>\n${msg}`;
  if (evt.lastTextMessageId) {
    await sendTelegram(msg, TELEGRAM_CHANNEL_ID, { editMessageId: evt.lastTextMessageId });
  } else {
    const result = await sendTelegram(msg, TELEGRAM_CHANNEL_ID);
    if (result?.ok) {
      evt.lastTextMessageId = result.result.message_id;

      // Find the auto-forwarded message in the discussion group
      // This is the ONLY way to get the thread ID for posting comments
      if (TELEGRAM_DISCUSSION_ID) {
        await findDiscussionThread(evt);
      }
    }
  }
}

// After sending a channel post, find the corresponding auto-forwarded message
// in the discussion group by polling getUpdates directly.
async function findDiscussionThread(evt) {
  const channelMsgId = evt.lastTextMessageId;
  console.log(`[discussion] looking for auto-forward of channel msg ${channelMsgId}...`);

  // Wait for Telegram to create the auto-forward
  await new Promise(r => setTimeout(r, 3000));

  // Poll recent updates — look for auto-forwarded message from our channel
  try {
    const res = await fetch(`${TELEGRAM_API}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: -10, timeout: 3, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.ok || !data.result) {
      console.log(`[discussion] getUpdates failed: ${data.description || "no data"}`);
      return;
    }

    for (const u of data.result) {
      lastUpdateId = Math.max(lastUpdateId, u.update_id);
      const m = u.message;
      if (!m || !m.is_automatic_forward) continue;
      if (m.chat?.id?.toString() !== TELEGRAM_DISCUSSION_ID) continue;

      const origMsgId = m.forward_origin?.message_id || m.forward_from_message_id;
      if (origMsgId === channelMsgId) {
        evt.discussionThreadId = m.message_id;
        console.log(`[discussion] FOUND thread=${m.message_id} for channel msg ${channelMsgId}`);
        return;
      }
    }
    console.log(`[discussion] auto-forward not found for channel msg ${channelMsgId}`);
  } catch (e) {
    console.warn(`[discussion] error: ${e.message}`);
  }
}

// Send update to the channel's discussion group (comment section)
async function sendDiscussionUpdate(evt, updateType, details, alert = null) {
  if (!TELEGRAM_DISCUSSION_ID) return;
  const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });

  let emoji, label;
  switch (updateType) {
    case "new":          emoji = "🚨"; label = "התרעה חדשה"; break;
    case "escalate":     emoji = "🔴"; label = "אזעקה — גל ראשון"; break;
    case "expand":       emoji = "📢"; label = "האזעקה מתרחבת"; break;
    case "wave":         emoji = "🔁"; label = "גל נוסף"; break;
    case "resume":       emoji = "🚨"; label = "אזעקות חודשו"; break;
    case "waiting":      emoji = "🟡"; label = "המתנה — שהו במרחב מוגן"; break;
    case "ended":        emoji = "✅"; label = "האירוע הסתיים"; break;
    default:             emoji = "ℹ️"; label = "עדכון"; break;
  }

  let msg = `${emoji} <b>עדכון ${time} — ${label}</b>\n`;

  if (details) {
    msg += `${details}\n`;
  }

  if (alert?.data && alert.data.length > 0) {
    msg += `\n📋 <b>${alert.title}</b>\n`;
    msg += `${alert.desc}\n`;
    msg += `\n<blockquote expandable><b>ישובים (${alert.data.length}):</b>\n`;
    msg += alert.data.join(", ");
    msg += `</blockquote>`;
  }

  if (!alert && evt.settlements.size > 0) {
    const duration = Math.round((Date.now() - evt.startTime) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;
    msg += `\n📊 סיכום: ${evt.settlements.size} ישובים, ${evt.waves.length} גלים, ${min}:${String(sec).padStart(2, "0")} דקות`;
  }

  // Add news reports if available
  const { detailed: newsDetailed } = formatNewsForUpdate(evt);
  if (newsDetailed) msg += newsDetailed;

  // Reply to the auto-forwarded message in discussion group (appears as comment on channel post)
  const opts = {};
  if (evt.discussionThreadId) {
    opts.replyToMsgId = evt.discussionThreadId;
  }
  opts.replyMarkup = BOOM_BUTTONS;
  await sendTelegram(msg, TELEGRAM_DISCUSSION_ID, opts);
}

function formatNewsForUpdate(evt) {
  if (!evt.newsReports || evt.newsReports.length === 0) return { short: "", detailed: "" };

  let interceptions = 0, impacts = 0, debris = 0, casualties = 0;
  const details = [];

  for (const r of evt.newsReports) {
    if (r.category === "interception") { interceptions += r.count; details.push(`🛡️ יירוט${r.location ? ` — ${r.location}` : ""}${r.count > 1 ? ` (${r.count})` : ""}`); }
    if (r.category === "impact") { impacts += r.count; details.push(`💥 נפילה${r.location ? ` — ${r.location}` : ""}${r.count > 1 ? ` (${r.count})` : ""}`); }
    if (r.category === "debris") { debris += r.count; details.push(`🔩 רסיסים${r.location ? ` — ${r.location}` : ""}`); }
    if (r.category === "casualty") { casualties += r.count; details.push(`🚑 ${r.count} פצועים${r.location ? ` — ${r.location}` : ""}`); }
    if (r.category === "damage") { details.push(`🏚️ נזק${r.location ? ` — ${r.location}` : ""}`); }
  }

  // Short version for channel post (one line)
  const parts = [];
  if (interceptions > 0) parts.push(`${interceptions} יירוטים`);
  if (impacts > 0) parts.push(`${impacts} נפילות`);
  if (casualties > 0) parts.push(`${casualties} פצועים`);
  const short = parts.length > 0 ? `\n📰 ${parts.join(" | ")}` : "";

  // Detailed version for discussion comments
  const detailed = details.length > 0 ? `\n<blockquote expandable>📰 <b>דיווחים (${details.length}):</b>\n${details.join("\n")}</blockquote>` : "";

  return { short, detailed };
}

// Poll alerts with multi-event lifecycle
async function fetchAlerts() {
  try {
    const res = await fetch(ALERT_URL, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.oref.org.il/",
      },
    });
    const text = await res.text();

    // No active alert — advance lifecycle for all active events
    if (!text.trim()) {
      const emptyThreshold = simActive ? 15 : 120;
      for (const [key, evt] of activeEvents) {
        evt.emptyCount++;

        // alert → waiting
        if (evt.phase === "alert" && evt.emptyCount >= emptyThreshold) {
          const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
          console.log(`[lifecycle][${key}] ${evt.phase} → waiting (empty ${evt.emptyCount}/${emptyThreshold}), settlements=${evt.settlements.size}`);
          evt.phase = "waiting";
          evt.currentWaveSettlements = new Set();
          evt.history.push({ time, text: "🟡 ממתינים במרחב מוגן" });
          await updateEventMessage(evt);
          await sendDiscussionUpdate(evt, "waiting", `אין אזעקות נוספות כרגע.\nיש להישאר במרחב מוגן ${evt.protectionMin} דקות מרגע האזעקה האחרונה.`);
          continue;
        }

        // waiting → ended
        if (evt.phase === "waiting") {
          const safetyTimeoutMs = simActive ? 30000 : 20 * 60000;
          if (evt.emptyCount * POLL_INTERVAL > safetyTimeoutMs) {
            const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
            console.log(`[lifecycle][${key}] waiting → ended (20min safety timeout)`);
            evt.phase = "ended";
            if (!evt.isTest) { updateCalibration(evt); reloadCalibration(); }
            const features = extractPatternFeatures(evt);
            if (features) evt.patternClusterId = updatePatternClusters(features);
            evt.history.push({ time, text: "✅ האירוע הסתיים (זמן המתנה מקסימלי)" });
            await updateEventMessage(evt);
            await sendDiscussionUpdate(evt, "ended", `ניתן לצאת מהמרחב המוגן.\nסה"כ ${evt.settlements.size} ישובים, ${evt.waves.length} גלים.`);
            if (!simActive) saveScenario(evt);
          }
        }

        // early_warning with no follow-up alert → clean up after 20 min
        if (evt.phase === "early_warning" && evt.emptyCount * POLL_INTERVAL > 20 * 60000) {
          const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
          console.log(`[lifecycle][${key}] early_warning → cleanup (20min timeout, no alert followed)`);
          evt.phase = "ended";
          if (!evt.isTest) { updateCalibration(evt); reloadCalibration(); }
          const features = extractPatternFeatures(evt);
          if (features) evt.patternClusterId = updatePatternClusters(features);
          evt.history.push({ time, text: "✅ ההתרעה הסתיימה (לא הוסלמה לאזעקה)" });
          await updateEventMessage(evt);
          await sendDiscussionUpdate(evt, "ended", `ההתרעה המוקדמת הסתיימה ללא אזעקה.`);
        }

        // Clean up old ended events (>15 min since ended)
        if (evt.phase === "ended" && evt.emptyCount * POLL_INTERVAL > 15 * 60000) {
          console.log(`[lifecycle][${key}] removing ended event`);
          activeEvents.delete(key);
        }
      }
      return;
    }

    // Parse alerts
    const parsed = JSON.parse(text);
    const alerts = Array.isArray(parsed) ? parsed : [parsed];
    const mode = simActive ? "TEST" : "REAL";
    console.log(`[alert][${mode}] received ${alerts.length} alert(s), active events: ${activeEvents.size}`);

    // Save raw Oref data for debugging
    if (!simActive) {
      try {
        appendFileSync(`${DATA_DIR}/oref-raw-alerts.jsonl`, JSON.stringify({
          timestamp: new Date().toISOString(), raw: parsed,
        }) + "\n");
      } catch {}
    }

    const now = Date.now();
    for (const [id, ts] of seenAlertIds) {
      if (now - ts > SEEN_ID_TTL_MS) seenAlertIds.delete(id);
    }

    for (const alert of alerts) {
      if (seenAlertIds.has(alert.id)) continue;
      seenAlertIds.set(alert.id, now);
      lastAlertId = alert.id;
      const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
      const settlements = alert.data || [];

      console.log(`[alert][${mode}] NEW id=${alert.id} cat="${alert.cat}" title="${alert.title}" settlements=${settlements.length}: ${settlements.join(", ")}`);

      // Detect Oref "event ended" message
      const isEndEvent = (alert.title || "").includes("האירוע הסתיים");
      if (isEndEvent) {
        console.log(`[alert][${mode}] END EVENT detected: "${alert.title}"`);
        for (const [key, evt] of activeEvents) {
          if (evt.phase === "waiting" || evt.phase === "alert") {
            const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
            console.log(`[lifecycle][${key}] → ended (explicit Oref end event)`);
            evt.phase = "ended";
            if (!evt.isTest) { updateCalibration(evt); reloadCalibration(); }
            const features = extractPatternFeatures(evt);
            if (features) evt.patternClusterId = updatePatternClusters(features);
            evt.history.push({ time, text: "✅ האירוע הסתיים (פיקוד העורף)" });
            await updateEventMessage(evt);
            await sendDiscussionUpdate(evt, "ended", `פיקוד העורף הודיע: האירוע הסתיים.\nסה"כ ${evt.settlements.size} ישובים, ${evt.waves.length} גלים.`);
            if (!evt.isTest) saveScenario(evt);
          }
        }
        continue;
      }

      // Find or create the right event for these settlements
      // Special case: if there's an active early_warning event within 10 min, always merge alarm into it
      // (EW covers the whole country, centroid distance would be >50km but it's the same attack)
      let nearest = null;
      const isThisEW = isEarlyWarningAlert(alert);
      if (!isThisEW) {
        for (const [, e] of activeEvents) {
          if (e.phase === "early_warning" && e.isTest === simActive && (now - e.lastWaveTime < 10 * 60000)) {
            nearest = { key: e.regionKey, event: e, dist: 0 };
            console.log(`[alert] merging alarm into active early_warning event "${e.regionKey}"`);
            break;
          }
        }
      }
      if (!nearest) nearest = findNearestEvent(settlements);
      let evt;

      if (nearest) {
        // Merge into existing event
        evt = nearest.event;
        evt.emptyCount = 0;
        const mergeWindowMs = Math.min(15, 5 + Math.floor(evt.settlements.size / 50)) * 60000;
        const withinMerge = evt.lastWaveTime && (now - evt.lastWaveTime < mergeWindowMs);
        console.log(`[alert] matched event "${nearest.key}" (dist=${nearest.dist.toFixed(0)}km, merge=${withinMerge})`);

        // If ended, always treat as new event (ended events are final)
        if (evt.phase === "ended") {
          console.log(`[lifecycle][${nearest.key}] ended → removing, creating fresh`);
          activeEvents.delete(nearest.key);
          evt = null; // will create new below
        }
      }

      if (!evt) {
        // Create new event
        const regionKey = summarizeAreas(settlements).slice(0, 40);
        evt = createEvent(regionKey, alert.title, alert.cat, settlements, time, parseProtectionMinutes(alert.desc), alert);
        activeEvents.set(regionKey, evt);
        const isEW = evt.phase === "early_warning";
        console.log(`[lifecycle][${regionKey}] NEW EVENT [${isEW ? "EARLY_WARNING" : "ALERT"}]: "${alert.title}", ${settlements.length} settlements`);

        // Compute initial EW geometry
        if (evt.phase === "early_warning") {
          const ewCoords = [...evt.ewSettlements]
            .map(s => fuzzyMatch(s) || CITY_COORDS[s])
            .filter(Boolean);
          if (ewCoords.length >= 3) {
            evt.ewEllipse = fitEllipse(ewCoords);
            evt.ewHull = convexHull(ewCoords);
            evt.ewAreaKm2 = hullAreaKm2(evt.ewHull);
          }
        }

        // Detect direct fire: alarm without preceding EW in same/adjacent regions
        if (evt.phase === "alert") {
          const evtRegions = new Set();
          for (const s of settlements) {
            const r = REGION_MAP[s] || REGION_MAP[s.split(" - ")[0].trim()];
            if (r) evtRegions.add(r);
          }
          let hasRecentEW = false;
          const fiveMinAgo = Date.now() - 5 * 60000;
          for (const [, other] of activeEvents) {
            if (other === evt) continue;
            if (other.phase === "early_warning" && other.startTime > fiveMinAgo) {
              const otherRegions = new Set();
              for (const s of other.settlements) {
                const r = REGION_MAP[s] || REGION_MAP[s.split(" - ")[0].trim()];
                if (r) otherRegions.add(r);
              }
              for (const r of evtRegions) {
                if (otherRegions.has(r)) { hasRecentEW = true; break; }
                for (const adj of (REGION_ADJACENCY[r] || [])) {
                  if (otherRegions.has(adj)) { hasRecentEW = true; break; }
                }
                if (hasRecentEW) break;
              }
            }
            if (hasRecentEW) break;
          }
          if (!hasRecentEW) {
            evt.isDirect = true;
            console.log(`[lifecycle][${evt.regionKey}] DIRECT FIRE detected (no EW in same/adjacent regions)`);
          }
        }

        // Classify attack origin
        evt.origin = classifyOrigin(evt);
        applyAzimuthCorrection(evt);
        if (evt.ewEllipse) evt.launchAzimuth = evt.ewEllipse.azimuthDeg;
        if (evt.origin !== "unknown") console.log(`[lifecycle][${evt.regionKey}] origin=${evt.origin}${evt.launchAzimuth ? ` azimuth=${evt.launchAzimuth.toFixed(0)}°` : ""}`);

        await updateEventMessage(evt);
        await sendDiscussionUpdate(evt, "new", `${isEW ? "התרעה מוקדמת" : "אזעקה"} באזורים: ${summarizeAreas(settlements)}`, alert);

        // Generate map for new event
        const mapPath = await generateAlertMap(settlements, evt);
        if (mapPath) {
          await sendTelegramPhoto(mapPath, `📍 מפת התרעות - ${time} (${settlements.length} ישובים)`, TELEGRAM_CHANNEL_ID, evt);
        }
        continue;
      }

      // Update existing event
      const wasEarlyWarning = evt.phase === "early_warning";
      const thisIsAlert = !isEarlyWarningAlert(alert); // actual alert vs early warning
      let resumedFromWaiting = false;

      if (wasEarlyWarning && thisIsAlert) {
        console.log(`[lifecycle][${evt.regionKey}] early_warning → alert (real siren)`);
        evt.phase = "alert";
        evt.ewToAlarmSeconds = Math.round((Date.now() - evt.startTime) / 1000);
        evt.origin = classifyOrigin(evt);
        applyAzimuthCorrection(evt);
        if (evt.ewEllipse) evt.launchAzimuth = evt.ewEllipse.azimuthDeg;
      }
      if (evt.phase === "waiting") {
        console.log(`[lifecycle][${evt.regionKey}] waiting → alert (resumed)`);
        evt.phase = "alert";
        resumedFromWaiting = true;
        evt.history.push({ time, text: "🚨 אזעקות חודשו" });
      }

      // Update EW geometry if this is an early warning update
      if (isEarlyWarningAlert(alert)) {
        for (const s of settlements) evt.ewSettlements.add(s);
        const ewCoords = [...evt.ewSettlements]
          .map(s => fuzzyMatch(s) || CITY_COORDS[s])
          .filter(Boolean);
        if (ewCoords.length >= 3) {
          evt.ewEllipse = fitEllipse(ewCoords);
          evt.ewHull = convexHull(ewCoords);
          evt.ewAreaKm2 = hullAreaKm2(evt.ewHull);
        }
      }

      const waveSettlements = new Set(settlements);
      const { ellipse: waveEllipse, hull: waveHull, useHull: waveUseHull } = computeWaveEllipse(settlements);
      evt.waves.push({ settlements: waveSettlements, time, ellipse: waveEllipse, hull: waveHull, useHull: waveUseHull });

      const newSettlements = settlements.filter(s => !evt.settlements.has(s));
      for (const s of settlements) {
        evt.settlements.add(s);
        evt.currentWaveSettlements.add(s);
      }
      evt.lastWaveTime = Date.now();

      // Compute expansion vector (first wave centroid → latest wave centroid)
      if (evt.waves.length >= 2) {
        const firstEllipse = evt.waves[0].ellipse;
        const lastEllipse = evt.waves[evt.waves.length - 1].ellipse;
        if (firstEllipse?.centroid && lastEllipse?.centroid) {
          const origin = firstEllipse.centroid;
          const target = lastEllipse.centroid;
          const magnitude = haversineKm(origin, target);
          const direction = bearing(origin, target);
          const cosLat = Math.cos(origin[1] * Math.PI / 180);
          const expVec = [(target[0] - origin[0]) * cosLat, target[1] - origin[1]];
          const homeVec = [(HOME_COORD[0] - origin[0]) * cosLat, HOME_COORD[1] - origin[1]];
          const dot = expVec[0] * homeVec[0] + expVec[1] * homeVec[1];
          const expLen = Math.sqrt(expVec[0] ** 2 + expVec[1] ** 2);
          const homeLen = Math.sqrt(homeVec[0] ** 2 + homeVec[1] ** 2);
          const cosSim = (expLen > 0 && homeLen > 0) ? dot / (expLen * homeLen) : 0;
          evt.expansionVector = {
            origin, target, magnitude,
            direction,
            towardHome: cosSim > 0.7,
          };
        }
      } else {
        evt.expansionVector = null;
      }

      const newProt = parseProtectionMinutes(alert.desc);
      if (newProt > evt.protectionMin) evt.protectionMin = newProt;
      if (alert.title !== evt.title) evt.title = alert.title;

      // Use correct emoji/label based on Oref data
      const emoji = thisIsAlert ? "🚨" : "⚠️";
      const label = thisIsAlert ? "אזעקה" : "התרעה מוקדמת";

      console.log(`[lifecycle][${evt.regionKey}] wave ${evt.waves.length} [${label}]: +${newSettlements.length} new (${evt.settlements.size} total)`);

      if (newSettlements.length > 0) {
        const list = newSettlements.slice(0, 5).join(", ");
        const more = newSettlements.length > 5 ? ` ועוד ${newSettlements.length - 5}` : "";
        evt.history.push({ time, text: `${emoji} ${label} — התרחבות: ${list}${more} (${evt.settlements.size} סה"כ)` });
      } else {
        evt.history.push({ time, text: `${emoji} ${label}: ${summarizeAreas(settlements)}` });
      }

      // Risk analysis
      const allAreas = [...evt.settlements];
      const alertCoords = await resolveCoords(allAreas);
      const alertRegions = new Set();
      for (const area of allAreas) {
        if (REGION_MAP[area]) alertRegions.add(REGION_MAP[area]);
        else {
          const base = area.split(" - ")[0].trim();
          if (base !== area && REGION_MAP[base]) alertRegions.add(REGION_MAP[base]);
        }
      }
      const prediction = evt.predictedAlarmTime ? { predictedTime: evt.predictedAlarmTime, confidenceMinutes: evt.predictionConfidence, basedOn: evt.predictionBasedOn } : null;
      evt.riskMsg = formatRiskMessage(alertCoords, alertRegions, allAreas, evt.type, evt.origin, evt.isDirect, prediction, evt.estimatedImpact, evt.interception);

      // Pattern-based EW probability + Iran timing prediction
      if (evt.phase === "early_warning" && evt.ewEllipse) {
        const match = findMatchingPattern(evt);
        if (match) {
          const pct = Math.round(match.pAlarmAtHome * 100);
          evt.riskMsg += `\n📊 לפי ${match.eventCount} אירועים דומים: ${pct}% סיכוי לאזעקה באזורך`;
          evt.patternClusterId = match.clusterId;
        }
        if (evt.origin === "iran") {
          const prediction = predictAlarmTiming(evt);
          if (prediction) {
            evt.predictedAlarmTime = prediction.predictedTime;
            evt.predictionConfidence = prediction.confidenceMinutes;
            evt.predictionBasedOn = prediction.basedOn;
          }
        }
      }

      // Impact estimation + interception detection
      if (evt.waves.length >= 1 && evt.phase === "alert") {
        evt.estimatedImpact = estimateImpactPoint(evt);
        evt.interception = detectInterception(evt);
        if (evt.interception?.detected) {
          console.log(`[impact] Interception detected at wave ${evt.interception.detectedAtWave} near ${evt.interception.label}, debris ${evt.interception.debrisRadiusKm.toFixed(1)}km`);
        }
        if (evt.estimatedImpact) {
          console.log(`[impact] Estimated impact near ${evt.estimatedImpact.label} (${evt.estimatedImpact.confidence}, ±${evt.estimatedImpact.uncertaintyKm.toFixed(1)}km)`);
        }
      }

      console.log(`\n[${time}][${mode}] ${alert.title} [${evt.phase}] ${evt.settlements.size} settlements, ${evt.waves.length} waves`);

      await updateEventMessage(evt);

      // Discussion group update
      if (resumedFromWaiting) {
        await sendDiscussionUpdate(evt, "resume", `אזעקות חודשו באזורים: ${summarizeAreas(settlements)}`, alert);
      } else if (wasEarlyWarning) {
        await sendDiscussionUpdate(evt, "escalate", `אזעקה! גל ראשון ב: ${summarizeAreas(settlements)} (${evt.settlements.size} ישובים)`, alert);
      } else if (newSettlements.length > 0) {
        await sendDiscussionUpdate(evt, "expand", `+${newSettlements.length} ישובים חדשים: ${newSettlements.join(", ")} (${evt.settlements.size} סה"כ)`, alert);
      } else {
        await sendDiscussionUpdate(evt, "wave", `גל ${evt.waves.length} — ${summarizeAreas(settlements)}`, alert);
      }

      // Map for all waves (ellipses need full history, settlements colored per-wave)
      const mapAreas = [...evt.settlements];
      const mapPath = await generateAlertMap(mapAreas, evt);
      if (mapPath) {
        await sendTelegramPhoto(mapPath, `📍 מפת התרעות - ${time} (${mapAreas.length} ישובים)`, TELEGRAM_CHANNEL_ID, evt);
      }

      try {
        appendFileSync(`${DATA_DIR}/alert-timestamps.jsonl`, JSON.stringify({
          time, timestamp: Date.now(), alertId: alert.id,
          phase: evt.phase, regionKey: evt.regionKey,
          settlementCount: evt.settlements.size,
        }) + "\n");
      } catch {}
    }
  } catch (err) {
    console.error(`[שגיאה] ${err.message}`);
  }
}

// Test scenarios — persistent file stores the 10 biggest real events
const TEST_SCENARIOS_PATH = `${DATA_DIR}/test-scenarios.json`;
const MAX_SCENARIOS = 10;

let TEST_SCENARIOS = [];
try {
  TEST_SCENARIOS = JSON.parse(readFileSync(TEST_SCENARIOS_PATH, "utf8"));
  console.log(`נטענו ${TEST_SCENARIOS.length} תסריטי בדיקה`);
} catch {
  // Seed with built-in scenarios
  TEST_SCENARIOS = [
    {
      title: "ירי רקטות וטילים", desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
      waves: [
        ["אשקלון - דרום", "אשקלון - צפון", "שדרות", "נתיבות"],
        ["קריית גת", "יד מרדכי", "זיקים", "כרמיה"],
        ["ברור חיל", "נגבה", "גברעם"],
      ],
    },
    {
      title: "ירי רקטות וטילים", desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
      waves: [
        ["תל אביב - מרכז העיר", "תל אביב - דרום העיר", "רמת גן"],
        ["גבעתיים", "חולון", "בת ים"],
        ["ראשון לציון", "הרצליה", "רעננה"],
      ],
    },
    {
      title: "ירי רקטות וטילים", desc: "היכנסו למרחב המוגן ושהו בו דקה וחצי",
      waves: [
        ["קריית שמונה", "מטולה", "דפנה"],
        ["שאר ישוב", "כפר גלעדי", "מרגליות"],
        ["שדה נחמיה", "כפר יובל"],
      ],
    },
    {
      title: "ירי רקטות וטילים", desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
      waves: [
        ["חיפה", "קריית אתא", "קריית ביאליק"],
        ["קריית ים", "נשר", "טירת כרמל"],
        ["עכו", "נהריה"],
      ],
    },
    {
      title: "חדירת כלי טיס עוין", desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
      waves: [
        ["ירושלים", "בית שמש", "מודיעין-מכבים-רעות"],
        ["רחובות", "אשדוד"],
        ["לוד", "רמלה"],
      ],
    },
  ];
}

// Save a real event as a test scenario (auto-called when events end)
function saveScenario(evt) {
  if (evt.waves.length < 2) return; // too small
  const totalSettlements = [...new Set(evt.waves.flatMap(w => [...w.settlements]))];
  if (totalSettlements.length < 10) return; // too small

  const scenario = {
    title: evt.title,
    desc: `היכנסו למרחב המוגן ושהו בו ${evt.protectionMin} דקות`,
    waves: evt.waves.map(w => [...w.settlements]),
    savedAt: new Date().toISOString(),
    settlementCount: totalSettlements.length,
  };

  // Check for duplicate (same settlements)
  const key = totalSettlements.sort().join(",");
  const isDupe = TEST_SCENARIOS.some(s => {
    const sKey = (s.waves || []).flat().sort().join(",");
    return sKey === key;
  });
  if (isDupe) return;

  TEST_SCENARIOS.push(scenario);
  // Sort by settlement count descending, keep top MAX_SCENARIOS
  TEST_SCENARIOS.sort((a, b) => (b.settlementCount || b.waves?.flat().length || 0) - (a.settlementCount || a.waves?.flat().length || 0));
  if (TEST_SCENARIOS.length > MAX_SCENARIOS) {
    TEST_SCENARIOS = TEST_SCENARIOS.slice(0, MAX_SCENARIOS);
  }

  try {
    writeFileSync(TEST_SCENARIOS_PATH, JSON.stringify(TEST_SCENARIOS, null, 2));
    console.log(`[scenarios] saved "${evt.title}" (${totalSettlements.length} settlements, ${evt.waves.length} waves). Total: ${TEST_SCENARIOS.length} scenarios`);
  } catch (e) {
    console.error(`[scenarios] save error: ${e.message}`);
  }
}

// Simulation: replay real scenarios compressed to ~2 minutes
const SIM_TOTAL_MS = 120000; // 2 minutes total
let simTimers = [];
let mockServerProcess = null;
const MOCK_PORT = 3333;

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

  const idx = TEST_SCENARIOS.indexOf(scenario);
  const mockPath = new URL("./mock-oref-server.mjs", import.meta.url).pathname;
  mockServerProcess = fork(mockPath, [TEST_SCENARIOS_PATH, String(idx)], { silent: true });

  mockServerProcess.stdout?.on("data", d => console.log(`[mock] ${d.toString().trim()}`));
  mockServerProcess.stderr?.on("data", d => console.error(`[mock:err] ${d.toString().trim()}`));

  mockServerProcess.on("exit", (code) => {
    console.log(`[mock] server exited (code=${code})`);
    ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/warningMessages/alert/alerts.json";
    simActive = false;
    mockServerProcess = null;
    sendTelegram("🧪 הסימולציה הסתיימה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
  });

  // Redirect after brief startup delay
  setTimeout(() => {
    ALERT_URL = `http://localhost:${MOCK_PORT}`;
    console.log(`[sim] ALERT_URL redirected to ${ALERT_URL}`);
  }, 1000);
}

function stopSimulation() {
  if (!simActive) return;
  if (mockServerProcess) {
    mockServerProcess.kill();
    mockServerProcess = null;
  }
  ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/warningMessages/alert/alerts.json";
  simActive = false;
  simTimers.forEach(t => clearTimeout(t));
  simTimers = [];
  console.log("[sim] cancelled");
  sendTelegram("🧪 הסימולציה בוטלה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
}

// --- Boom Questionnaire (button-based) ---
const boomSessions = new Map(); // chatId → { step, report: { intensity, missileType, count, interception }, timestamp }

const BOOM_QUESTIONS = {
  intensity: {
    text: "💥 <b>כמה חזק היה הבום?</b>",
    buttons: { inline_keyboard: [[
      { text: "קל", callback_data: "boom_intensity_1" },
      { text: "בינוני", callback_data: "boom_intensity_2" },
      { text: "חזק מאוד", callback_data: "boom_intensity_3" },
    ]] },
  },
  missileType: {
    text: "🚀 <b>מה סוג הטיל לדעתך?</b>",
    buttons: { inline_keyboard: [[
      { text: "רגיל", callback_data: "boom_type_regular" },
      { text: "מתפצל", callback_data: "boom_type_mirv" },
      { text: "לא יודע", callback_data: "boom_type_unknown" },
    ]] },
  },
  clusterCheck: {
    text: "🔊 <b>שמעת בום אחד גדול או כמה פיצוצים קטנים?</b>",
    buttons: { inline_keyboard: [[
      { text: "אחד גדול", callback_data: "boom_cluster_single" },
      { text: "כמה קטנים", callback_data: "boom_cluster_multi" },
    ]] },
  },
  count: {
    text: "🔢 <b>כמה טילים שמעת?</b>",
    buttons: { inline_keyboard: [[
      { text: "1", callback_data: "boom_count_1" },
      { text: "2-3", callback_data: "boom_count_few" },
      { text: "הרבה", callback_data: "boom_count_many" },
    ]] },
  },
  interception: {
    text: "🛡️ <b>שמעת יירוט?</b>",
    buttons: { inline_keyboard: [[
      { text: "כן", callback_data: "boom_intercept_yes" },
      { text: "לא", callback_data: "boom_intercept_no" },
      { text: "לא בטוח", callback_data: "boom_intercept_maybe" },
    ]] },
  },
};

function startBoomSession(chatId) {
  boomSessions.set(chatId, {
    step: "intensity",
    report: {},
    timestamp: Date.now(),
  });
}

async function advanceBoomSession(chatId, cbData) {
  const session = boomSessions.get(chatId);
  if (!session) return;

  if (session.step === "intensity") {
    session.report.intensity = cbData === "boom_intensity_1" ? 1 : cbData === "boom_intensity_2" ? 2 : 3;
    session.step = "missileType";
  } else if (session.step === "missileType") {
    if (cbData === "boom_type_regular") {
      session.report.missileType = "regular";
      session.step = "count";
    } else if (cbData === "boom_type_mirv") {
      session.report.missileType = "mirv";
      session.step = "count";
    } else {
      session.report.missileType = "unknown";
      session.step = "clusterCheck";
    }
  } else if (session.step === "clusterCheck") {
    session.report.missileType = cbData === "boom_cluster_single" ? "regular" : "mirv";
    session.step = "count";
  } else if (session.step === "count") {
    session.report.count = cbData === "boom_count_1" ? 1 : cbData === "boom_count_few" ? 3 : 10;
    session.step = "interception";
  } else if (session.step === "interception") {
    session.report.interception = cbData === "boom_intercept_yes" ? "yes" : cbData === "boom_intercept_no" ? "no" : "maybe";
    session.step = "done";
  }

  if (session.step === "done") {
    await finishBoomReport(chatId, session);
  } else {
    const q = BOOM_QUESTIONS[session.step];
    await sendTelegram(q.text, chatId, { replyMarkup: q.buttons });
  }
}

async function finishBoomReport(chatId, session) {
  const r = session.report;
  const fbTime = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });

  const intensityText = r.intensity === 1 ? "חלש" : r.intensity === 2 ? "בינוני" : "חזק";
  const typeText = r.missileType === "mirv" ? "מתפצל" : r.missileType === "regular" ? "רגיל" : "לא ידוע";
  const countText = r.count === 1 ? "1" : r.count === 3 ? "2-3" : "הרבה";
  const interceptText = r.interception === "yes" ? "כן" : r.interception === "no" ? "לא" : "לא בטוח";

  feedbackLog.push({
    type: "boom_report", ...r,
    time: fbTime, timestamp: Date.now(),
  });
  writeFileSync(FEEDBACK_PATH, JSON.stringify(feedbackLog, null, 2));

  // Add boom report to all active events
  for (const [, evt] of activeEvents) {
    if (evt.phase && evt.phase !== "ended") {
      const historyLine = `💥 בום (${intensityText}, ${typeText}, x${countText}${r.interception === "yes" ? ", יירוט" : ""})`;
      evt.history.push({ time: fbTime, text: historyLine });
      await updateEventMessage(evt);
    }
  }

  await sendTelegram(
    `✅ <b>הדיווח נשמר!</b>\n\n` +
    `💥 עוצמה: ${intensityText}\n` +
    `🚀 סוג: ${typeText}\n` +
    `🔢 כמות: ${countText}\n` +
    `🛡️ יירוט: ${interceptText}\n\n` +
    `תודה על הדיווח! 🙏`,
    chatId
  );

  boomSessions.delete(chatId);
  console.log(`[משוב] 💥 דיווח בום: ${intensityText}, ${typeText}, x${countText}, יירוט:${interceptText} ${fbTime}`);
}

// Listen for /test command via Telegram polling
const TELEGRAM_UPDATES_URL = `${TELEGRAM_API}/getUpdates`;

async function pollTelegramCommands() {
  try {
    // allowed_updates MUST include "message" to receive auto-forwarded channel posts in discussion group
    const res = await fetch(TELEGRAM_UPDATES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: lastUpdateId + 1,
        timeout: 0,
        allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok) {
      try { appendFileSync(`${DATA_DIR}/poll-updates.log`, `${new Date().toISOString()} ERROR: ${JSON.stringify(data)}\n`); } catch {}
      return;
    }
    if (!data.result || data.result.length === 0) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      // Log every update to persistent file for debugging
      const updKeys = Object.keys(update).filter(k => k !== 'update_id').join(',');
      const updChat = update.message?.chat?.id || update.channel_post?.chat?.id || '';
      const logLine = `${new Date().toISOString()} update=${update.update_id} type=${updKeys} chat=${updChat} is_auto_fwd=${update.message?.is_automatic_forward} fwd_origin=${update.message?.forward_origin?.type}\n`;
      console.log(`[poll] ${logLine.trim()}`);
      try { appendFileSync(`${DATA_DIR}/poll-updates.log`, logLine); } catch {}

      // Handle callback buttons (boom questionnaire)
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;
        const userChatId = cb.from?.id?.toString();

        // Style selection buttons
        if (cbData?.startsWith("style_")) {
          const style = cbData.replace("style_", "");
          if (["A", "B", "C", "D"].includes(style)) {
            messageStyle = style;
            const names = { A: "Minimal", B: "Clean Modern", C: "Balanced", D: "Emoji-Rich" };
            await answerCallback(cb.id, `סגנון: ${style} — ${names[style]}`);
          }
          continue;
        }

        // "שמעתי בום!" button from channel → start questionnaire in private chat
        if (cbData === "fb_boom_start") {
          await answerCallback(cb.id, "💥 עובר לצ'אט פרטי...");
          if (userChatId) {
            startBoomSession(userChatId);
            const q = BOOM_QUESTIONS.intensity;
            try {
              await sendTelegram(q.text, userChatId, { replyMarkup: q.buttons });
            } catch {
              await answerCallback(cb.id, "⚠️ שלח /start לבוט בצ'אט פרטי קודם");
            }
          }
          continue;
        }

        // Boom questionnaire answers (in private chat)
        if (cbData.startsWith("boom_") && userChatId && boomSessions.has(userChatId)) {
          await answerCallback(cb.id, "✓");
          await advanceBoomSession(userChatId, cbData);
          continue;
        }

        continue;
      }

      // Detect auto-forwarded channel posts in discussion group
      const fwdMsg = update.message;
      if (fwdMsg) {
        const fwdChatId = fwdMsg.chat?.id?.toString();
        if (fwdChatId === TELEGRAM_DISCUSSION_ID) {
          // Check if this is an auto-forwarded channel post (per Telegram Bot API guide)
          if (fwdMsg.is_automatic_forward) {
            const origMsgId = fwdMsg.forward_origin?.message_id || fwdMsg.forward_from_message_id;
            const pendingKeys = [...pendingThreadDetection.keys()];
            console.log(`[discussion] auto-forward: disc=${fwdMsg.message_id} chan=${origMsgId} thread=${fwdMsg.message_thread_id} pending=[${pendingKeys}]`);
            try { appendFileSync(`${DATA_DIR}/poll-updates.log`, `${new Date().toISOString()} AUTO-FWD disc=${fwdMsg.message_id} chan=${origMsgId} thread=${fwdMsg.message_thread_id} pending=[${pendingKeys}]\n`); } catch {}

            if (origMsgId && pendingThreadDetection.has(origMsgId)) {
              const pendingEvt = pendingThreadDetection.get(origMsgId);
              pendingEvt.discussionThreadId = fwdMsg.message_id; // the discussion msg ID IS the thread ID
              pendingThreadDetection.delete(origMsgId);
              console.log(`[discussion] LINKED: thread=${pendingEvt.discussionThreadId} for event "${pendingEvt.regionKey}"`);
            }
            continue; // don't process auto-forwards as commands
          }
          // Log other discussion group messages for debugging
          if (pendingThreadDetection.size > 0) {
            console.log(`[discussion] group msg: id=${fwdMsg.message_id}, is_auto_fwd=${fwdMsg.is_automatic_forward}, sender=${fwdMsg.sender_chat?.type}`);
          }
        }
      }

      const umsg = update.message;
      const text = umsg?.text || umsg?.forward_text || "";
      const fwdText = umsg?.forward_from_chat ? text : "";
      const chatId = umsg?.chat?.id?.toString();

      // Handle /start boom from any user (URL deep link from channel button)
      if (text === "/start boom" || text === "/start boom ") {
        startBoomSession(chatId);
        const q = BOOM_QUESTIONS.intensity;
        await sendTelegram(q.text, chatId, { replyMarkup: q.buttons });
        continue;
      }

      if (chatId !== TELEGRAM_CHAT_ID) continue;

      // Save forwarded messages for analysis
      if (fwdText || (text && !text.startsWith("/"))) {
        try {
          const logFile = `${DATA_DIR}/oref-forwarded-msgs.jsonl`;
          const entry = JSON.stringify({
            date: update.message.date,
            forward_date: update.message.forward_date,
            text: text,
            from_channel: update.message.forward_from_chat?.title,
          }) + "\n";
          appendFileSync(logFile, entry);
        } catch {}
      }

      if (text === "/test") {
        startSimulation();
      } else if (text === "/stop") {
        stopSimulation();
      } else if (text === "/status") {
        const uptime = Math.floor(process.uptime());
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = uptime % 60;
        const mem = process.memoryUsage();
        const memMB = (mem.rss / 1024 / 1024).toFixed(1);
        const boundaryCount = Object.keys(SETTLEMENT_BOUNDARIES).length;
        const scenarioCount = TEST_SCENARIOS.length;

        let statusMsg = `✅ <b>הבוט פעיל</b>\n\n`;
        statusMsg += `<b>מערכת:</b>\n`;
        statusMsg += `⏱ זמן ריצה: ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}\n`;
        statusMsg += `💾 זיכרון: ${memMB} MB\n`;
        statusMsg += `📂 אחסון: ${DATA_DIR}\n\n`;

        statusMsg += `<b>נתונים:</b>\n`;
        statusMsg += `🗺 ישובים: ${Object.keys(CITY_COORDS).length} קואורדינטות\n`;
        statusMsg += `📐 גבולות: ${boundaryCount} פוליגונים\n`;
        statusMsg += `🗂 אזורים: ${Object.keys(REGION_MAP).length} ישובים ב-${new Set(Object.values(REGION_MAP)).size} אזורים\n`;
        statusMsg += `🧪 תסריטים: ${scenarioCount} שמורים\n\n`;

        statusMsg += `<b>ערוץ:</b>\n`;
        statusMsg += `📡 סורק כל ${POLL_INTERVAL / 1000} שנייה\n`;
        statusMsg += `💬 קבוצת דיון: ${TELEGRAM_DISCUSSION_ID || "לא מוגדר"}\n`;
        statusMsg += `🏠 בית: ${HOME_NAME} [${HOME_COORD}]\n`;

        if (simActive) {
          statusMsg += `\n🧪 <b>סימולציה פעילה</b> (/stop לביטול)`;
        }

        if (activeEvents.size > 0) {
          statusMsg += `\n\n<b>אירועים פעילים (${activeEvents.size}):</b>\n`;
          for (const [key, e] of activeEvents) {
            const dur = Math.round((Date.now() - e.startTime) / 60000);
            statusMsg += `📍 ${e.regionKey}\n`;
            statusMsg += `   מצב: ${e.phase} | ${e.settlements.size} ישובים | ${e.waves.length} גלים | ${dur} דק'\n`;
            if (e.discussionThreadId) statusMsg += `   💬 thread: ${e.discussionThreadId}\n`;
          }
        } else {
          statusMsg += `\n📍 אין אירועים פעילים`;
        }

        await sendTelegram(statusMsg, TELEGRAM_CHAT_ID);
      } else if (text?.startsWith("/renderer")) {
        const arg = text.split(/\s+/)[1]?.toLowerCase();
        if (arg === "static") {
          activeRenderer = "static";
          await sendTelegram("✅ רנדרר: <b>staticmaps</b> (ברירת מחדל)", TELEGRAM_CHAT_ID);
        } else if (arg === "leaflet") {
          await sendTelegram("⚠️ רנדרר Leaflet עדיין לא זמין — נשאר ב-staticmaps", TELEGRAM_CHAT_ID);
        } else {
          await sendTelegram(`רנדרר נוכחי: <b>${activeRenderer}</b>\nאפשרויות: /renderer static`, TELEGRAM_CHAT_ID);
        }
      } else if (text?.startsWith("/style")) {
        const arg = text.split(" ")[1]?.toUpperCase();
        if (arg && ["A", "B", "C", "D"].includes(arg)) {
          messageStyle = arg;
          const names = { A: "Minimal", B: "Clean Modern", C: "Balanced", D: "Emoji-Rich" };
          await sendTelegram(`✅ סגנון שונה ל: <b>${arg} — ${names[arg]}</b>\nשלח /test לראות`, TELEGRAM_CHAT_ID);
        } else {
          const current = messageStyle;
          await sendTelegram(
            `🎨 <b>בחר סגנון הודעות:</b>\nנוכחי: <b>${current}</b>`,
            TELEGRAM_CHAT_ID,
            { replyMarkup: { inline_keyboard: [
              [
                { text: `${current === "A" ? "✓ " : ""}A Minimal`, callback_data: "style_A" },
                { text: `${current === "B" ? "✓ " : ""}B Clean`, callback_data: "style_B" },
              ],
              [
                { text: `${current === "C" ? "✓ " : ""}C Balanced`, callback_data: "style_C" },
                { text: `${current === "D" ? "✓ " : ""}D Emoji`, callback_data: "style_D" },
              ],
            ] } }
          );
        }
      } else if (text === "/help") {
        await sendTelegram(
          `📋 <b>פקודות זמינות:</b>\n\n` +
          `/test — סימולציה של אירוע אמיתי\n` +
          `/stop — עצור סימולציה פעילה\n` +
          `/status — מצב הבוט\n` +
          `/style — שנה סגנון הודעות (A/B/C/D)\n` +
          `/renderer — שנה רנדרר מפה (static)\n` +
          `/help — הצג תפריט זה`,
          TELEGRAM_CHAT_ID
        );
      }
    }
  } catch (e) {
    // timeout or network error — ignore
  }
}

// --- Historical Data: Backfill, Scraper, Correlation ---

// Backfill alert history from forwarded messages
function backfillAlertHistory() {
  try { readFileSync(ALERT_HISTORY_PATH); return; } catch {} // already exists

  let lines;
  try {
    lines = readFileSync(`${DATA_DIR}/oref-forwarded-msgs.jsonl`, "utf8").trim().split("\n");
  } catch { console.log("אין הודעות מועברות לניתוח"); return; }

  const events = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (!msg.text || !msg.text.includes("צבע אדום")) continue;
      if (msg.text.includes("סיום אירוע")) continue;

      const regions = new Set();
      const settlements = [];
      const regionPattern = /• ([^:]+):/g;
      let match;
      while ((match = regionPattern.exec(msg.text)) !== null) {
        regions.add(match[1].trim());
      }

      const sectionPattern = /• [^:]+:\s*([^\n•]+)/g;
      while ((match = sectionPattern.exec(msg.text)) !== null) {
        const names = match[1].split(",").map(s =>
          s.replace(/\(.*?\)/g, "").trim()
        ).filter(Boolean);
        settlements.push(...names);
      }

      const includesHome = settlements.some(s =>
        s.includes(HOME_NAME) || HOME_NAME.includes(s)
      );
      const homeRegion = REGION_MAP[HOME_NAME];
      const homeRegionIncluded = homeRegion ? regions.has(homeRegion) : false;

      let closestDist = Infinity;
      let coordCount = 0;
      for (const s of settlements) {
        const coord = fuzzyMatch(s);
        if (coord) {
          coordCount++;
          const d = haversineKm(HOME_COORD, coord);
          if (d < closestDist) closestDist = d;
        }
      }

      events.push({
        timestamp: msg.forward_date || msg.date,
        regions: [...regions],
        settlementCount: settlements.length,
        includesHome,
        homeRegionIncluded,
        closestDistToHome: closestDist === Infinity ? 999 : Math.round(closestDist),
        coordCount,
      });
    } catch {}
  }

  writeFileSync(ALERT_HISTORY_PATH, JSON.stringify({ events }, null, 2));
  console.log(`Backfill: ${events.length} אירועים, ${events.filter(e => e.includesHome).length} כוללים ${HOME_NAME}`);
}

// Risk model calibration from news reports
function updateCalibration(evt) {
  if (!evt.newsReports || evt.newsReports.length === 0) return;
  let calibration = {};
  try { calibration = JSON.parse(readFileSync(`${DATA_DIR}/calibration.json`, "utf8")); } catch {}

  const origin = evt.origin || "unknown";
  if (!calibration[origin]) {
    calibration[origin] = { events: 0, interceptions: 0, impacts: 0, debrisReports: 0, missileTypes: {} };
  }
  const cal = calibration[origin];
  cal.events++;

  for (const report of evt.newsReports) {
    if (report.category === "interception") cal.interceptions += report.count;
    if (report.category === "impact") cal.impacts += report.count;
    if (report.category === "debris") cal.debrisReports += report.count;
    if (report.missileType) cal.missileTypes[report.missileType] = (cal.missileTypes[report.missileType] || 0) + 1;
  }

  const total = cal.interceptions + cal.impacts;
  if (total > 0) cal.computedInterceptionRate = cal.interceptions / total;

  try { writeFileSync(`${DATA_DIR}/calibration.json`, JSON.stringify(calibration, null, 2)); } catch {}
  console.log(`[calibration] ${origin}: ${cal.events} events, rate=${((cal.computedInterceptionRate || 0) * 100).toFixed(0)}%`);
}

// Multi-channel news scraper
const NEWS_CHANNELS = [
  { username: "aharonyediotnews", label: "אהרון חדשות" },
  { username: "lelotsenzura", label: "ללא צנזורה" },
  { username: "yediotnews25", label: "ידיעות 25" },
];

const REPORT_KEYWORDS = {
  impact: ["נפילה", "נפל טיל", "פגיעה ישירה", "רקטה נפלה", "פגיעה", "נחת"],
  interception: ["יירוט", "יורט", "מיירט", "יירוטים"],
  debris: ["רסיס", "רסיסים", "שברי", "שברים", "רסיסי יירוט"],
  casualty: ["פצועים", "נפגעים", "הרוגים", "נהרג", "פצוע"],
  damage: ["נזק", "פגיעה במבנה", "פגיעה ברכב", "שריפה", "הרס"],
};

const MISSILE_TYPES = {
  ballistic: ["טיל בליסטי", "טיל באליסטי", "בליסטי"],
  cruise: ["טיל שיוט", "טיל מעופף", "שיוט"],
  rocket: ["רקטה", "רקטות", "ירי רקטות"],
  drone: ["מל\"ט", "כטב\"מ", "רחפן", "מזל\"ט", "כלי טיס"],
  mirv: ["טיל מתפצל", "ראשי נפץ"],
};

let scraperState = {};
try { scraperState = JSON.parse(readFileSync(`${DATA_DIR}/scraper-state.json`, "utf8")); } catch {}
function saveScraperState() {
  try { writeFileSync(`${DATA_DIR}/scraper-state.json`, JSON.stringify(scraperState, null, 2)); } catch {}
}

function classifyReport(text, channel, msgId) {
  let category = null;
  for (const [cat, keywords] of Object.entries(REPORT_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) { category = cat; break; }
  }
  if (!category) return null;

  let missileType = null;
  for (const [type, keywords] of Object.entries(MISSILE_TYPES)) {
    if (keywords.some(kw => text.includes(kw))) { missileType = type; break; }
  }

  let location = null, locationCoord = null;
  const sortedCities = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const city of sortedCities) {
    if (city.length >= 3 && text.includes(city)) {
      location = city;
      locationCoord = CITY_COORDS[city];
      break;
    }
  }

  let count = 1;
  const countMatch = text.match(/(\d+)\s*(?:יירוט|נפילות|פצועים|רקטות|טילים)/);
  if (countMatch) count = parseInt(countMatch[1]);

  const distToHome = locationCoord ? Math.round(haversineKm(HOME_COORD, locationCoord)) : null;

  return {
    channel, msgId,
    timestamp: new Date().toISOString(),
    text: text.substring(0, 300),
    category, missileType,
    location, locationCoord, distToHome, count,
    relatedEventId: null,
  };
}

function correlateReport(report) {
  const reportTime = Date.now();
  for (const [key, evt] of activeEvents) {
    const timeDiff = Math.abs(reportTime - evt.startTime);
    if (timeDiff > 30 * 60000) continue;
    if (report.locationCoord) {
      const evtCoords = [...evt.settlements].map(s => CITY_COORDS[s]).filter(Boolean);
      if (evtCoords.length === 0) continue;
      const cx = evtCoords.reduce((s, c) => s + c[0], 0) / evtCoords.length;
      const cy = evtCoords.reduce((s, c) => s + c[1], 0) / evtCoords.length;
      if (haversineKm(report.locationCoord, [cx, cy]) < 50) {
        report.relatedEventId = key;
        if (!evt.newsReports) evt.newsReports = [];
        evt.newsReports.push(report);
        console.log(`[scraper] matched "${report.category}" to event "${key}"`);
        return;
      }
    }
  }
}

function saveReports(newReports) {
  for (const r of newReports) correlateReport(r);
  let existing = [];
  try { existing = JSON.parse(readFileSync(`${DATA_DIR}/news-reports.json`, "utf8")); } catch {}
  existing.push(...newReports);
  if (existing.length > 1000) existing = existing.slice(-1000);
  try { writeFileSync(`${DATA_DIR}/news-reports.json`, JSON.stringify(existing, null, 2)); } catch {}
}

async function scrapeChannel(channel) {
  try {
    const state = scraperState[channel.username] || { lastMsgId: 0 };
    const url = `https://t.me/s/${channel.username}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OrefBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();

    const msgPattern = /data-post="[^/]+\/(\d+)"[\s\S]*?tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g;
    const reports = [];
    let m;
    while ((m = msgPattern.exec(html)) !== null) {
      const msgId = parseInt(m[1]);
      if (msgId <= state.lastMsgId) continue;
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (!text) continue;
      const report = classifyReport(text, channel.username, msgId);
      if (report) reports.push(report);
      if (msgId > state.lastMsgId) state.lastMsgId = msgId;
    }

    scraperState[channel.username] = state;
    if (reports.length > 0) {
      saveReports(reports);
      saveScraperState();
      console.log(`[scraper] ${channel.label}: ${reports.length} new reports`);
    }
  } catch (e) {
    console.warn(`[scraper] ${channel.label}: ${e.message}`);
  }
}


// Build correlation index from historical data
function buildCorrelationIndex() {
  let alertHistory;
  try { alertHistory = JSON.parse(readFileSync(ALERT_HISTORY_PATH, "utf8")); } catch { return; }

  const events = alertHistory.events || [];
  if (events.length === 0) return;

  const totalEvents = events.length;
  const homeAlertEvents = events.filter(e => e.includesHome).length;
  const homeRegionEvents = events.filter(e => e.homeRegionIncluded).length;

  const regionCounts = {};
  const regionWithHome = {};
  for (const evt of events) {
    for (const region of evt.regions) {
      regionCounts[region] = (regionCounts[region] || 0) + 1;
      if (evt.includesHome || evt.homeRegionIncluded) {
        regionWithHome[region] = (regionWithHome[region] || 0) + 1;
      }
    }
  }

  const regionCorrelation = {};
  for (const [region, count] of Object.entries(regionCounts)) {
    regionCorrelation[region] = {
      totalAlerts: count,
      homeAlsoAlerted: regionWithHome[region] || 0,
      probability: count > 0 ? Math.round(((regionWithHome[region] || 0) / count) * 100) / 100 : 0,
    };
  }

  let impactHistory;
  try { impactHistory = JSON.parse(readFileSync(IMPACT_HISTORY_PATH, "utf8")); } catch { impactHistory = { reports: [] }; }

  const impactsNearHome = impactHistory.reports.filter(r => r.distToHome !== null && r.distToHome < 15 && r.type === "impact").length;
  const debrisNearHome = impactHistory.reports.filter(r => r.distToHome !== null && r.distToHome < 20 && r.type === "debris").length;

  const pImpact = homeAlertEvents > 0 ? Math.round((impactsNearHome / Math.max(homeAlertEvents, 1)) * 100) / 100 : 0.18;
  const pDebris = homeAlertEvents > 0 ? Math.round((debrisNearHome / Math.max(homeAlertEvents, 1)) * 100) / 100 : 0.30;

  const index = {
    homeLocation: { name: HOME_NAME, coord: HOME_COORD },
    totalAlertEvents: totalEvents,
    homeAlertEvents,
    homeRegionEvents,
    regionCorrelation,
    impactGivenAlert: { impactsNearHome, total: homeAlertEvents, pImpact: Math.max(pImpact, 0.05) },
    debrisGivenAlert: { debrisNearHome, total: homeAlertEvents, pDebris: Math.max(pDebris, 0.10) },
    lastUpdated: new Date().toISOString(),
  };

  writeFileSync(CORRELATION_PATH, JSON.stringify(index, null, 2));
  correlationIndex = index;
  console.log(`[אינדקס] ${totalEvents} אירועים, ${homeAlertEvents} כוללים ${HOME_NAME}, ${Object.keys(regionCorrelation).length} אזורים`);
}

// --- Startup: load historical data ---
backfillAlertHistory();
buildCorrelationIndex();

// Scrape news channels every 60 seconds, staggered by 20s
NEWS_CHANNELS.forEach((ch, i) => {
  setTimeout(() => {
    scrapeChannel(ch);
    setInterval(() => scrapeChannel(ch), 60000);
  }, i * 20000);
});

// Rebuild correlation index every hour
setInterval(buildCorrelationIndex, 3600000);

// Register bot menu commands
await fetch(`${TELEGRAM_API}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    commands: [
      { command: "test", description: "🧪 שלח התרעת בדיקה אקראית" },
      { command: "status", description: "✅ בדוק שהבוט פעיל" },
      { command: "help", description: "📋 הצג פקודות זמינות" },
    ],
  }),
});

// Clear any stale webhook before starting polling (they're mutually exclusive)
fetch(`${TELEGRAM_API}/deleteWebhook`).then(() => console.log("Webhook cleared")).catch(() => {});

console.log("מאזין להתרעות פיקוד העורף... (Ctrl+C לעצירה)");
console.log(`תדירות: כל ${POLL_INTERVAL / 1000} שנייה`);
console.log("התראות טלגרם: פעיל (טקסט + מפה)");
console.log(`קבוצת דיון: ${TELEGRAM_DISCUSSION_ID || "לא מוגדר"}`);
console.log("פקודת בדיקה: /test\n");

setInterval(fetchAlerts, POLL_INTERVAL);
setInterval(pollTelegramCommands, 3000);
fetchAlerts();
