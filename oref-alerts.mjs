import StaticMaps from "staticmaps";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";

const ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/warningMessages/alert/alerts.json";
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
let simResponse = "";
let lastUpdateId = 0; // shared between pollTelegramCommands and resolveDiscussionThread

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
  const t = (alert.title || "").toLowerCase();
  return t.includes("התרעה מוקדמת") || t.includes("early warning");
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
    waves: earlyWarn ? [] : [{ settlements: new Set(settlements), time }],
    history: [{ time, text: `${emoji} ${label}: ${summarizeAreas(settlements)} (${settlements.length})` }],
    protectionMin: protectionMin,
    riskMsg: "",
    lastWaveTime: Date.now(),
    lastTextMessageId: null,
    lastMapMessageId: null,
    boomButtonMessageId: null,
    emptyCount: 0,
    isTest: simActive,
  };
}

// Find which active event a set of settlements belongs to (by geographic proximity)
const EVENT_MERGE_DISTANCE_KM = 100;

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

function summarizeAreas(areas) {
  const regions = new Set();
  const majors = [];

  for (const area of areas) {
    // Check region mapping (exact + fuzzy)
    if (REGION_MAP[area]) {
      regions.add(REGION_MAP[area]);
    } else {
      for (const [key, region] of Object.entries(REGION_MAP)) {
        if (area.includes(key)) { regions.add(region); break; }
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
const BOOM_RADIUS_KM = 20;
const DEBRIS_REACH_KM = 20;

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
    const { centroid } = projectToLocalKm(coords);
    return { centroid, semiMajor: 5, semiMinor: 5, azimuthDeg: 0, eccentricity: 0 };
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

// --- Four Probability Functions ---

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function calculatePAlert(alertRegions, alertSettlements, ellipse, homePosition, expansion) {
  // Rule 1: Already alerted
  for (const s of alertSettlements) {
    if (s.includes(HOME_NAME) || HOME_NAME.includes(s)) return 1.0;
  }
  // Check home region
  const homeRegion = REGION_MAP[HOME_NAME];
  if (homeRegion && alertRegions.has(homeRegion)) return 0.95;

  // Factor A: Region co-occurrence (40%)
  let pRegion = 0;
  for (const region of alertRegions) {
    const corr = correlationIndex.regionCorrelation?.[region];
    if (corr && corr.probability > pRegion) pRegion = corr.probability;
  }

  // Factor B: Ellipse proximity (30%)
  const posFactors = { END: 0.9, START: 0.85, CENTER: 0.95, NEAR: 0.4, FAR: 0 };
  let pEllipse = posFactors[homePosition.positionType] ?? 0;
  if (homePosition.positionType === "FAR") {
    pEllipse = Math.max(0, 0.2 - homePosition.normalizedDistance * 0.05);
  }

  // Factor C: Expansion direction (30%)
  let pExpansion = 0.1;
  if (expansion.expandingTowardHome) {
    pExpansion = clamp(0.3 + expansion.velocity * 0.1, 0, 0.8);
  } else if (expansion.velocity > 0.5) {
    pExpansion = Math.max(0.05, 0.2 - expansion.velocity * 0.05);
  }

  return clamp(0.4 * pRegion + 0.3 * pEllipse + 0.3 * pExpansion, 0, 1);
}

function calculatePImpact(pAlert, ellipse, homePosition) {
  if (pAlert < 0.1) return pAlert * 0.001;

  const baseRate = correlationIndex.impactGivenAlert?.pImpact ?? 0.18;

  const posFactors = { END: 1.5, CENTER: 1.0, START: 0.3, NEAR: 0.15, FAR: 0.02 };
  const positionFactor = posFactors[homePosition.positionType] ?? 0.02;

  // Small alert zone = precise missile = higher local risk
  const area = Math.PI * ellipse.semiMajor * ellipse.semiMinor;
  const sizeFactor = area < 500 ? 1.3 : area < 2000 ? 1.0 : 0.7;

  return clamp(pAlert * baseRate * positionFactor * sizeFactor, 0, 1);
}

function calculatePDebris(pAlert, ellipse, homePosition, closestDist) {
  const baseRate = correlationIndex.debrisGivenAlert?.pDebris ?? 0.30;

  const posFactors = { START: 1.8, CENTER: 1.2, END: 0.6, NEAR: 0.8, FAR: 0 };
  let positionFactor = posFactors[homePosition.positionType] ?? 0;
  if (homePosition.positionType === "FAR" && closestDist < DEBRIS_REACH_KM) {
    positionFactor = 0.4;
  }

  // Large alert zone = high-altitude interception = wider debris
  const area = Math.PI * ellipse.semiMajor * ellipse.semiMinor;
  const altitudeFactor = area > 2000 ? 1.5 : area > 500 ? 1.0 : 0.6;

  // Debris can reach outside alert zone
  const proximityBoost = closestDist < DEBRIS_REACH_KM
    ? (1 - closestDist / DEBRIS_REACH_KM) * 0.3
    : 0;

  return clamp(pAlert * baseRate * positionFactor * altitudeFactor + proximityBoost, 0, 1);
}

function calculatePBoom(alertCoords, pImpact, pDebris) {
  const nearbyCount = alertCoords.filter(c => haversineKm(c, HOME_COORD) < BOOM_RADIUS_KM).length;
  const nearbyRatio = nearbyCount / Math.max(alertCoords.length, 1);

  // Interceptions are very likely (~90% success rate)
  const pInterceptionNearby = nearbyRatio * 0.9;

  let pBoom = 1 - (1 - pInterceptionNearby) * (1 - pImpact) * (1 - pDebris);
  if (nearbyRatio > 0.5) pBoom = Math.max(pBoom, 0.95);

  return clamp(pBoom, 0, 1);
}

// --- Combined Risk Analysis ---

function analyzeRisk(alertCoords, alertRegions, alertSettlements) {
  if (alertCoords.length === 0) return null;

  const ellipse = fitEllipse(alertCoords);
  const homePosition = classifyHomePosition(ellipse, HOME_COORD);
  const expansion = trackExpansion(alertCoords);
  const closestDist = Math.min(...alertCoords.map(c => haversineKm(HOME_COORD, c)));
  const dir = bearing(HOME_COORD, ellipse.centroid);

  const regions = alertRegions instanceof Set ? alertRegions : new Set(alertRegions || []);
  const settlements = alertSettlements || [];

  const pAlert = calculatePAlert(regions, settlements, ellipse, homePosition, expansion);
  const pImpact = calculatePImpact(pAlert, ellipse, homePosition);
  const pDebris = calculatePDebris(pAlert, ellipse, homePosition, closestDist);
  const pBoom = calculatePBoom(alertCoords, pImpact, pDebris);

  return {
    closestDist: Math.round(closestDist),
    dir,
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

function formatRiskMessage(alertCoords, alertRegions, alertSettlements) {
  const risk = analyzeRisk(alertCoords, alertRegions, alertSettlements);
  if (!risk) return "";

  const p = risk.probabilities;
  const pEmoji = (v) => v >= 70 ? "🔴" : v >= 40 ? "🟠" : v >= 15 ? "🟡" : "🟢";

  let expansionNote = "";
  if (risk.expansion.expandingTowardHome && risk.expansion.velocity > 0.5) {
    expansionNote = `\n⚡ התרעות מתרחבות לכיוונך (${risk.expansion.eta} דק׳)`;
  }

  return (
    `\n\n🏠 <b>ניתוח סיכון ל${HOME_NAME}:</b>\n` +
    `📏 ${risk.closestDist} ק״מ | 🧭 ${risk.dir} | 📐 ${risk.ellipse.area} קמ״ר\n\n` +
    `📊 <b>הסתברויות:</b>\n` +
    `${pEmoji(p.alert)} אזעקה: ${p.alert}%\n` +
    `${pEmoji(p.impact)} נפילת טיל: ${p.impact}%\n` +
    `${pEmoji(p.debris)} נפילת רסיס: ${p.debris}%\n` +
    `${pEmoji(p.boom)} בומים: ${p.boom}%` +
    expansionNote
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

import sharp from "sharp";

async function ensureMarkers() {
  try { await sharp(Buffer.from(DOT_SVG)).png().toFile(DOT_MARKER_PATH); } catch {}
  try { await sharp(Buffer.from(HOME_SVG)).png().toFile(HOME_MARKER_PATH); } catch {}
}

// Resolve areas to coordinates
async function resolveCoords(areas) {
  const coords = [];
  const missed = [];
  for (const area of areas) {
    const coord = await geocode(area);
    if (coord) coords.push(coord);
    else missed.push(area);
  }
  console.log(`[resolveCoords] ${coords.length}/${areas.length} resolved${missed.length > 0 ? `, MISSING: ${missed.join(", ")}` : ""}`);
  return coords;
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

// Generate map with polygon areas for large settlements and dots for small ones
async function generateAlertMap(areas, evt = null) {
  await ensureMarkers();
  if (areas.length === 0) return null;

  const map = new StaticMaps({
    width: 800,
    height: 600,
    paddingX: 50,
    paddingY: 50,
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    zoomRange: { min: 7, max: 15 },
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

    if (bd?.boundary && bd.population >= 10000) {
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
      if (coord) {
        console.log(`[map] "${area}" → CIRCLE at [${coord}] (${bd ? `pop=${bd.population}, no boundary` : "no boundary data"}, fill=${colors.fill})`);
        map.addCircle({
          coord,
          radius: 3000, // 3km in meters
          color: colors.stroke,
          fill: colors.fill,
          width: 1,
        });
      } else {
        console.warn(`[map] "${area}" → SKIPPED (no coords found)`);
      }
    }
  };

  // Render early warning settlements (orange)
  for (const area of earlyWarningSettlements) {
    renderSettlement(area, isEarlyWarning ? WAVE_COLORS.early_warning : WAVE_COLORS.waves[0]);
  }

  // Render each wave with its color
  for (let i = 0; i < waveGroups.length; i++) {
    const colors = WAVE_COLORS.waves[Math.min(i, WAVE_COLORS.waves.length - 1)];
    for (const area of waveGroups[i]) {
      renderSettlement(area, colors);
    }
  }

  // Add home marker (blue dot)
  map.addMarker({
    coord: HOME_COORD,
    img: HOME_MARKER_PATH,
    height: 18,
    width: 18,
    offsetX: 9,
    offsetY: 9,
  });

  try {
    await map.render();
    const mapPath = "/tmp/oref-alert-map.png";
    await map.image.save(mapPath);
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

    console.log(`[telegram] sendMessage → chat=${chatId} (${message.length} chars)`);
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.ok) console.log(`[telegram] sendMessage OK → msg_id=${result.result.message_id}`);
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

    // Send new photo
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
      for (const [key, region] of Object.entries(REGION_MAP)) {
        if (s.includes(key)) { regions.add(region); break; }
      }
    }
  }
  return [...regions];
}

function buildEventMessage(evt) {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const allRegionsSummary = summarizeAreas([...evt.settlements]);
  const alertRegions = getAlertRegions(evt);
  const alertRegionStr = alertRegions.length > 0 ? alertRegions.join(", ") : allRegionsSummary;

  let header, timeLine;
  if (evt.phase === "early_warning") {
    header = `⚠️ <b>התרעה מוקדמת באזורים:</b> ${allRegionsSummary}`;
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

  if (evt.phase === "early_warning" || evt.phase === "alert") {
    msg += evt.riskMsg;
  }

  if (evt.history.length > 1 || evt.phase !== "early_warning") {
    const lines = evt.history.map(h => `${h.time} — ${h.text}`).join("\n");
    msg += `\n\n<blockquote>📜 היסטוריה:\n${lines}</blockquote>`;
  }

  return msg;
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
      if (!evt.isTest && TELEGRAM_DISCUSSION_ID) {
        await sendBoomButtonToThread(evt);
      }
    }
  }
}

// Send boom button as comment on channel post
async function sendBoomButtonToThread(evt) {
  if (!TELEGRAM_DISCUSSION_ID || !evt.lastTextMessageId || evt.boomButtonMessageId) return;
  const btnResult = await sendTelegram("💥 שמעתם בום? דווחו כאן:", TELEGRAM_DISCUSSION_ID, {
    replyMarkup: BOOM_BUTTONS,
    replyToMsgId: evt.lastTextMessageId,
    replyChatId: TELEGRAM_CHANNEL_ID,
  });
  if (btnResult?.ok) evt.boomButtonMessageId = btnResult.result.message_id;
}

// Send update to the channel's discussion group (comment section)
async function sendDiscussionUpdate(evt, updateType, details, alert = null) {
  if (!TELEGRAM_DISCUSSION_ID || evt.isTest) return; // skip discussion updates for tests
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
  msg += `─────────────────────\n`;

  if (details) {
    msg += `${details}\n`;
  }

  if (alert?.data && alert.data.length > 0) {
    msg += `\n<blockquote>`;
    msg += `📋 <b>${alert.title}</b>\n`;
    msg += `${alert.desc}\n\n`;
    msg += `<b>ישובים (${alert.data.length}):</b>\n`;
    msg += alert.data.join(", ");
    msg += `</blockquote>`;
  }

  if (!alert && evt.settlements.size > 0) {
    const duration = Math.round((Date.now() - evt.startTime) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;
    msg += `\n📊 סיכום: ${evt.settlements.size} ישובים, ${evt.waves.length} גלים, ${min}:${String(sec).padStart(2, "0")} דקות`;
  }

  // Reply to the channel post as a comment (cross-chat reply)
  const opts = {};
  if (evt.lastTextMessageId) {
    opts.replyToMsgId = evt.lastTextMessageId;
    opts.replyChatId = TELEGRAM_CHANNEL_ID;
  }
  await sendTelegram(msg, TELEGRAM_DISCUSSION_ID, opts);
}

// Poll alerts with multi-event lifecycle
async function fetchAlerts() {
  try {
    let text;
    if (simActive) {
      text = simResponse;
    } else {
      const res = await fetch(ALERT_URL, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://www.oref.org.il/",
        },
      });
      text = await res.text();
    }

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
        if (evt.phase === "waiting" && evt.lastWaveTime) {
          const protMin = simActive ? 0.5 : Math.max(evt.protectionMin, 3);
          if (evt.emptyCount * POLL_INTERVAL > (protMin + 2) * 60000) {
            const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
            console.log(`[lifecycle][${key}] waiting → ended (protection=${protMin}min)`);
            evt.phase = "ended";
            evt.history.push({ time, text: "✅ האירוע הסתיים" });
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

      // Find or create the right event for these settlements
      // Simulations always create fresh events (never merge with real)
      const nearest = simActive ? null : findNearestEvent(settlements);
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
      }
      if (evt.phase === "waiting") {
        console.log(`[lifecycle][${evt.regionKey}] waiting → alert (resumed)`);
        evt.phase = "alert";
        resumedFromWaiting = true;
        evt.history.push({ time, text: "🚨 אזעקות חודשו" });
      }

      const waveSettlements = new Set(settlements);
      evt.waves.push({ settlements: waveSettlements, time });

      const newSettlements = settlements.filter(s => !evt.settlements.has(s));
      for (const s of settlements) {
        evt.settlements.add(s);
        evt.currentWaveSettlements.add(s);
      }
      evt.lastWaveTime = Date.now();

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
        for (const [key, region] of Object.entries(REGION_MAP)) {
          if (area.includes(key)) { alertRegions.add(region); break; }
        }
      }
      evt.riskMsg = formatRiskMessage(alertCoords, alertRegions, allAreas);

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

      // Map for current wave
      const mapAreas = [...evt.currentWaveSettlements];
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

function startSimulation() {
  if (simActive) return;

  const scenario = TEST_SCENARIOS[Math.floor(Math.random() * TEST_SCENARIOS.length)];
  const waves = scenario.waves || [];
  const totalSettlements = waves.flat().length;

  simActive = true;
  console.log(`[sim] ${scenario.title} — ${totalSettlements} settlements, ${waves.length} waves`);

  sendTelegram(
    `🧪 <b>סימולציה מתחילה</b>\n` +
    `📋 ${scenario.title}\n` +
    `👥 ${totalSettlements} ישובים ב-${waves.length} גלים\n` +
    `⏱ משך: 2 דקות\n\n` +
    `⚠️ התרעות אמיתיות לא ייקלטו בזמן הסימולציה`,
    TELEGRAM_CHAT_ID
  );

  // Spread waves evenly across first 60% of the 2 min window
  const waveWindow = SIM_TOTAL_MS * 0.6; // 72s for waves
  const waveInterval = waves.length > 1 ? waveWindow / (waves.length - 1) : 0;

  waves.forEach((waveAreas, i) => {
    const delay = Math.round(i * waveInterval);
    const timer = setTimeout(() => {
      simResponse = JSON.stringify({
        id: `sim-${Date.now()}`,
        cat: "1",
        title: `🧪 ${scenario.title}`,
        desc: scenario.desc,
        data: waveAreas,
      });
      console.log(`[sim] wave ${i + 1}/${waves.length} (t+${Math.round(delay/1000)}s): ${waveAreas.length} settlements`);
    }, delay);
    simTimers.push(timer);
  });

  // Clear alert at 70% → triggers waiting
  const clearDelay = Math.round(SIM_TOTAL_MS * 0.7);
  simTimers.push(setTimeout(() => {
    simResponse = "";
    console.log(`[sim] cleared (t+${Math.round(clearDelay/1000)}s) — waiting for shelter + end`);
  }, clearDelay));

  // End simulation at 100%
  simTimers.push(setTimeout(() => {
    simActive = false;
    simResponse = "";
    simTimers = [];
    console.log("[sim] done");
    sendTelegram("🧪 הסימולציה הסתיימה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
  }, SIM_TOTAL_MS));
}

function stopSimulation() {
  if (!simActive) return;
  simTimers.forEach(t => clearTimeout(t));
  simTimers = [];
  simActive = false;
  simResponse = "";
  console.log("[סימולציה] בוטלה");
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
    const res = await fetch(`${TELEGRAM_UPDATES_URL}?offset=${lastUpdateId + 1}&timeout=5`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      // Handle callback buttons (boom questionnaire)
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;
        const userChatId = cb.from?.id?.toString();

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
        await sendTelegram(
          `✅ <b>הבוט פעיל</b>\n` +
          `⏱ זמן ריצה: ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}\n` +
          `📡 סורק כל ${POLL_INTERVAL / 1000} שנייה\n` +
          `🗺 ישובים במילון: ${Object.keys(CITY_COORDS).length}` +
          (simActive ? `\n\n🧪 <b>סימולציה פעילה</b> (/stop לביטול)` : "") +
          (activeEvents.size > 0 ? `\n📍 אירועים פעילים: ${[...activeEvents.values()].map(e => `${e.regionKey} [${e.phase}] (${e.settlements.size})`).join(", ")}` : ""),
          TELEGRAM_CHAT_ID
        );
      } else if (text === "/help") {
        await sendTelegram(
          `📋 <b>פקודות זמינות:</b>\n\n` +
          `/test — סימולציה של אירוע אמיתי (3 דקות)\n` +
          `/stop — עצור סימולציה פעילה\n` +
          `/status — בדוק שהבוט פעיל וזמן ריצה\n` +
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

// Scrape impact reports from news channel
const IMPACT_KEYWORDS = {
  impact: ["נפילה", "נפל טיל", "פגיעה ישירה", "רקטה נפלה"],
  debris: ["רסיס", "רסיסים", "שברי", "שברים", "רסיסי יירוט"],
  interception: ["יירוט", "יורט", "מיירט"],
};
let lastScrapedMsgId = 0;

async function scrapeImpactChannel() {
  try {
    const url = "https://t.me/s/aharonyediotoriginal";
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
      if (msgId <= lastScrapedMsgId) continue;

      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (!text) continue;

      let type = null;
      for (const [t, keywords] of Object.entries(IMPACT_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw))) { type = t; break; }
      }
      if (!type) continue;

      let location = null, locationCoord = null;
      const sortedCities = Object.entries(CITY_COORDS).sort((a, b) => b[0].length - a[0].length);
      for (const [city, coord] of sortedCities) {
        if (text.includes(city)) { location = city; locationCoord = coord; break; }
      }

      const distToHome = locationCoord ? Math.round(haversineKm(HOME_COORD, locationCoord)) : null;
      reports.push({ msgId, text: text.substring(0, 200), type, location, distToHome });
      if (msgId > lastScrapedMsgId) lastScrapedMsgId = msgId;
    }

    if (reports.length > 0) {
      let existing = { reports: [] };
      try { existing = JSON.parse(readFileSync(IMPACT_HISTORY_PATH, "utf8")); } catch {}
      existing.reports.push(...reports);
      if (existing.reports.length > 500) existing.reports = existing.reports.slice(-500);
      writeFileSync(IMPACT_HISTORY_PATH, JSON.stringify(existing, null, 2));
      console.log(`[סריקה] ${reports.length} דיווחי נפילה חדשים`);
    }
  } catch {}
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

// Scrape impact channel every 60 seconds
setInterval(scrapeImpactChannel, 60000);
scrapeImpactChannel();

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

console.log("מאזין להתרעות פיקוד העורף... (Ctrl+C לעצירה)");
console.log(`תדירות: כל ${POLL_INTERVAL / 1000} שנייה`);
console.log("התראות טלגרם: פעיל (טקסט + מפה)");
console.log(`קבוצת דיון: ${TELEGRAM_DISCUSSION_ID || "לא מוגדר"}`);
console.log("פקודת בדיקה: /test\n");

setInterval(fetchAlerts, POLL_INTERVAL);
setInterval(pollTelegramCommands, 3000);
fetchAlerts();
