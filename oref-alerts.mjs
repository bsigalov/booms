import StaticMaps from "staticmaps";
import { readFileSync, writeFileSync, appendFileSync } from "fs";

const ALERT_URL = process.env.ALERT_URL || "https://www.oref.org.il/warningMessages/alert/alerts.json";
const POLL_INTERVAL = 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "@booms_on_the_way";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars");
  process.exit(1);
}
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let lastAlertId = "";
const seenAlertIds = new Map(); // id → timestamp, prevents reprocessing
const SEEN_ID_TTL_MS = 300_000; // 5 min TTL
let lastMapMessageId = null; // for editing map instead of resending
let lastTextMessageId = null;
let eventPhase = null; // null | "early_warning" | "alert" | "waiting" | "ended"
let eventStartTime = null;
let eventStartTimeStr = null;
let eventTitle = "";
let eventType = ""; // alert.cat — for event grouping
let eventSettlements = new Set();
let eventWaves = []; // [{settlements: Set, time: string}] — ordered alert waves for coloring
let eventHistory = []; // [{time, text}]
let eventProtectionMin = 10; // parsed from desc
let eventRiskMsg = ""; // cached risk text
let lastWaveTime = null; // timestamp of most recent alert wave
let feedbackLog = [];
let simActive = false;
let simResponse = "";

// Load feedback log
const FEEDBACK_PATH = new URL("./feedback-log.json", import.meta.url);
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
    { fill: "#C6282899", stroke: "#B71C1C" },  // wave 1 — dark red
    { fill: "#E5393580", stroke: "#C62828" },  // wave 2 — crimson
    { fill: "#EF535070", stroke: "#D32F2F" },  // wave 3 — red
    { fill: "#F4433660", stroke: "#E53935" },  // wave 4 — medium red
    { fill: "#FF515150", stroke: "#EF5347" },  // wave 5 — light red
    { fill: "#FF6E6E45", stroke: "#F44336" },  // wave 6 — pink-red
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

  // Try partial match: "אשקלון - דרום" → match "אשקלון"
  // Sort by longest key first so "קריית שמונה" matches before "קריית"
  const sortedKeys = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const city of sortedKeys) {
    if (place.includes(city)) return CITY_COORDS[city];
  }
  return null;
}

async function geocode(place) {
  const key = place.trim();
  const fuzzy = fuzzyMatch(key);
  if (fuzzy) return fuzzy;
  if (geoCache.has(key)) return geoCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key + ", ישראל")}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "OrefAlertBot/1.0" },
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return null;
    const data = await res.json();
    if (data.length > 0) {
      const coords = [parseFloat(data[0].lon), parseFloat(data[0].lat)];
      geoCache.set(key, coords);
      return coords;
    }
  } catch (e) {
    console.error(`[גיאוקוד] ${e.message}`);
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
  correlationIndex = JSON.parse(readFileSync(new URL("./correlation-index.json", import.meta.url), "utf8"));
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
  if (missed.length > 0) {
    console.error(`[גיאוקוד] חסרים ${missed.length}/${areas.length}: ${missed.slice(0, 10).join(", ")}`);
  }
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

// Determine which wave a settlement belongs to (0-based index, or -1 for early warning only)
function getSettlementWaveIndex(settlement) {
  for (let i = eventWaves.length - 1; i >= 0; i--) {
    if (eventWaves[i].settlements.has(settlement)) return i;
  }
  return -1; // early warning / not in any wave
}

// Generate map with polygon areas for large settlements and dots for small ones
async function generateAlertMap(areas) {
  await ensureMarkers();
  if (areas.length === 0) return null;

  const map = new StaticMaps({
    width: 800,
    height: 600,
    paddingX: 50,
    paddingY: 50,
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  });

  const isEarlyWarning = eventPhase === "early_warning";

  // Group settlements by wave for coloring
  const earlyWarningSettlements = []; // no wave yet
  const waveGroups = eventWaves.map(() => []); // per-wave arrays

  for (const area of areas) {
    const waveIdx = getSettlementWaveIndex(area);
    if (waveIdx >= 0 && waveIdx < waveGroups.length) {
      waveGroups[waveIdx].push(area);
    } else {
      earlyWarningSettlements.push(area);
    }
  }

  // Render function: add polygon or dot for a settlement
  const renderSettlement = (area, colors) => {
    // Check if we have boundary data for this settlement (>10K population)
    const boundaryData = SETTLEMENT_BOUNDARIES[area];
    // Also check partial match for subdivisions like "אשקלון - דרום" → "אשקלון"
    const parentName = !boundaryData ? Object.keys(SETTLEMENT_BOUNDARIES).find(k => area.includes(k)) : null;
    const bd = boundaryData || (parentName ? SETTLEMENT_BOUNDARIES[parentName] : null);

    if (bd?.boundary && bd.population >= 10000) {
      // Render as filled polygon
      const geojson = bd.boundary;
      const rings = geojson.type === "MultiPolygon"
        ? geojson.coordinates.flat()
        : geojson.coordinates;
      for (const ring of rings) {
        map.addPolygon({
          coords: ring, // [lng, lat] pairs — matches staticmaps convention
          color: colors.stroke,
          fill: colors.fill,
          width: 1.5,
        });
      }
    } else {
      // Render as small dot for settlements <10K or without boundary
      const coord = fuzzyMatch(area) || CITY_COORDS[area];
      if (coord) {
        map.addMarker({
          coord,
          img: DOT_MARKER_PATH,
          height: 10,
          width: 10,
          offsetX: 5,
          offsetY: 5,
        });
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

    // Edit existing message if messageId provided
    if (opts.editMessageId) {
      body.message_id = opts.editMessageId;
      const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await res.json();
    }

    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error(`[טלגרם שגיאה] ${err.message}`);
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

// Telegram: send or update photo
async function sendTelegramPhoto(filePath, caption, chatId = TELEGRAM_CHANNEL_ID) {
  try {
    const fileBuffer = readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: "image/png" });

    // Try to edit existing map message
    if (lastMapMessageId && chatId === TELEGRAM_CHANNEL_ID) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("message_id", lastMapMessageId);
      form.append("media", JSON.stringify({ type: "photo", media: "attach://photo", caption, parse_mode: "HTML" }));
      form.append("photo", blob, "map.png");

      const res = await fetch(`${TELEGRAM_API}/editMessageMedia`, { method: "POST", body: form });
      const result = await res.json();
      if (result.ok) return result;
      // Edit failed — log but do NOT fall through to new message (prevents duplicates)
      console.error(`[טלגרם עריכה] editMessageMedia failed: ${JSON.stringify(result)}`);
      return null;
    }

    // Send new photo (only when no existing message to edit)
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", blob, "map.png");
    form.append("caption", caption);
    form.append("parse_mode", "HTML");

    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: "POST", body: form });
    const result = await res.json();
    if (result.ok && chatId === TELEGRAM_CHANNEL_ID) {
      lastMapMessageId = result.result.message_id;
    }
    return result;
  } catch (err) {
    console.error(`[טלגרם תמונה] ${err.message}`);
  }
}

// --- Event lifecycle helpers ---

const BOOM_BUTTONS = { inline_keyboard: [[
  { text: "💥 בום!", callback_data: "fb_boom" },
  { text: "💥💥 חזק!", callback_data: "fb_boom_strong" },
]] };

function parseProtectionMinutes(desc) {
  const m = desc.match(/(\d+)\s*דקות/);
  if (m) return parseInt(m[1]);
  if (desc.includes("דקה וחצי")) return 1.5;
  if (desc.includes("דקה")) return 1;
  return 10;
}

// Get regions that had actual alerts (not just early warnings)
function getAlertRegions() {
  const alertSettlements = new Set();
  for (const wave of eventWaves) {
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

function buildEventMessage() {
  const now = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
  const allRegionsSummary = summarizeAreas([...eventSettlements]);
  const alertRegions = getAlertRegions();
  const alertRegionStr = alertRegions.length > 0 ? alertRegions.join(", ") : allRegionsSummary;

  let header, timeLine;
  if (eventPhase === "early_warning") {
    header = `⚠️ <b>התרעה מוקדמת באזורים:</b> ${allRegionsSummary}`;
    timeLine = `⏰ ${eventStartTimeStr}`;
  } else if (eventPhase === "alert") {
    header = `🚨 <b>אזעקה באזורים:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${eventStartTimeStr}`;
  } else if (eventPhase === "waiting") {
    header = `🟡 <b>שהייה במקלטים ב:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${eventStartTimeStr}`;
  } else if (eventPhase === "ended") {
    const sec = Math.round((Date.now() - eventStartTime) / 1000);
    header = `✅ <b>אירוע הסתיים ב:</b> ${alertRegionStr}`;
    timeLine = `⏰ ${eventStartTimeStr}–${now} (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")})`;
  }

  let msg = `${header}\n${timeLine}`;

  // Risk analysis only during active phases
  if (eventPhase === "early_warning" || eventPhase === "alert") {
    msg += eventRiskMsg;
  }

  // History blockquote (skip for first early_warning — nothing past yet)
  if (eventHistory.length > 1 || eventPhase !== "early_warning") {
    const lines = eventHistory.map(h => `${h.time} — ${h.text}`).join("\n");
    msg += `\n\n<blockquote>📜 היסטוריה:\n${lines}</blockquote>`;
  }

  return msg;
}

async function updateEventMessage() {
  const msg = buildEventMessage();
  if (lastTextMessageId) {
    await sendTelegram(msg, TELEGRAM_CHANNEL_ID, { editMessageId: lastTextMessageId, replyMarkup: BOOM_BUTTONS });
  } else {
    const result = await sendTelegram(msg, TELEGRAM_CHANNEL_ID, { replyMarkup: BOOM_BUTTONS });
    if (result?.ok) lastTextMessageId = result.result.message_id;
  }
}

// Poll alerts with event lifecycle
let emptyCount = 0;

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

    // No active alert
    if (!text.trim()) {
      emptyCount++;
      const emptyThreshold = simActive ? 15 : 120; // 2 min (or 15s in sim)

      // early_warning/alert → waiting
      if ((eventPhase === "early_warning" || eventPhase === "alert") && emptyCount >= emptyThreshold) {
        const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
        eventPhase = "waiting";
        eventHistory.push({ time, text: "🟡 ממתינים במרחב מוגן" });
        await updateEventMessage();
      }

      // waiting → ended (protection time expired)
      if (eventPhase === "waiting" && lastWaveTime) {
        const protMin = simActive ? 0.5 : eventProtectionMin;
        if (Date.now() - lastWaveTime > protMin * 60000) {
          const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });
          eventPhase = "ended";
          eventHistory.push({ time, text: "✅ האירוע הסתיים" });
          await updateEventMessage();
        }
      }
      return;
    }

    emptyCount = 0;
    const parsed = JSON.parse(text);
    const alerts = Array.isArray(parsed) ? parsed : [parsed];

    // Purge expired seen IDs
    const now = Date.now();
    for (const [id, ts] of seenAlertIds) {
      if (now - ts > SEEN_ID_TTL_MS) seenAlertIds.delete(id);
    }

    for (const alert of alerts) {
      if (!seenAlertIds.has(alert.id)) {
        seenAlertIds.set(alert.id, now);
        lastAlertId = alert.id;
        const time = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });

        // Different event type while active → end current event, start fresh
        if (eventPhase && eventPhase !== "ended" && eventType && alert.cat !== eventType) {
          eventHistory.push({ time, text: "✅ האירוע הסתיים" });
          eventPhase = "ended";
          await updateEventMessage();
          eventPhase = null;
          lastTextMessageId = null;
          lastMapMessageId = null;
        }

        const isNew = eventPhase === null || eventPhase === "ended";

        if (isNew) {
          // New event — early warning
          eventPhase = "early_warning";
          eventStartTime = Date.now();
          eventStartTimeStr = time;
          eventTitle = alert.title;
          eventType = alert.cat;
          eventProtectionMin = parseProtectionMinutes(alert.desc);
          eventSettlements = new Set(alert.data);
          eventWaves = []; // no waves yet — settlements are in early warning
          eventHistory = [{ time, text: `⚠️ התרעה מוקדמת: ${summarizeAreas(alert.data)} (${alert.data.length})` }];
          lastWaveTime = Date.now();
          lastTextMessageId = null;
          lastMapMessageId = null;
        } else {
          // Continuing event — escalate to alert and track waves
          const wasEarlyWarning = eventPhase === "early_warning";
          if (wasEarlyWarning) eventPhase = "alert";
          if (eventPhase === "waiting") {
            eventPhase = "alert";
            eventHistory.push({ time, text: "🚨 אזעקות חודשו" });
          }

          // Create a new wave for this alert batch
          const waveSettlements = new Set(alert.data);
          eventWaves.push({ settlements: waveSettlements, time });

          const newSettlements = alert.data.filter(s => !eventSettlements.has(s));
          for (const s of alert.data) eventSettlements.add(s);
          lastWaveTime = Date.now();

          const newProt = parseProtectionMinutes(alert.desc);
          if (newProt > eventProtectionMin) eventProtectionMin = newProt;

          if (newSettlements.length > 0) {
            const list = newSettlements.slice(0, 5).join(", ");
            const more = newSettlements.length > 5 ? ` ועוד ${newSettlements.length - 5}` : "";
            eventHistory.push({ time, text: `🚨 התרחבות: ${list}${more} (${eventSettlements.size} סה"כ)` });
          } else {
            eventHistory.push({ time, text: `🚨 אזעקה: ${summarizeAreas(alert.data)}` });
          }
        }

        // Compute & cache risk
        const allAreas = [...eventSettlements];
        const alertCoords = await resolveCoords(allAreas);
        const alertRegions = new Set();
        for (const area of allAreas) {
          if (REGION_MAP[area]) alertRegions.add(REGION_MAP[area]);
          for (const [key, region] of Object.entries(REGION_MAP)) {
            if (area.includes(key)) { alertRegions.add(region); break; }
          }
        }
        eventRiskMsg = formatRiskMessage(alertCoords, alertRegions, allAreas);

        console.log(`\n[${time}] ${alert.title} [${eventPhase}] ${eventSettlements.size} ישובים, ${eventWaves.length} גלים`);

        await updateEventMessage();

        // Map with polygons + dots — split into clusters if geographically distinct
        const clusters = clusterSettlements(allAreas);
        if (clusters.length >= 2) {
          console.log(`[מפה] ${clusters.length} אשכולות גיאוגרפיים: ${clusters.map(c => c.length).join(", ")} ישובים`);
          for (let ci = 0; ci < clusters.length; ci++) {
            const clusterAreas = clusters[ci];
            const clusterRegions = summarizeAreas(clusterAreas);
            const mapPath = await generateAlertMap(clusterAreas);
            if (mapPath) {
              await sendTelegramPhoto(mapPath, `📍 ${clusterRegions} - ${time} (${clusterAreas.length} ישובים)`);
            }
          }
        } else {
          const mapPath = await generateAlertMap(allAreas);
          if (mapPath) {
            await sendTelegramPhoto(mapPath, `📍 מפת התרעות - ${time} (${allAreas.length} ישובים)`);
          }
        }

        try {
          appendFileSync("/tmp/alert-timestamps.jsonl", JSON.stringify({
            time, timestamp: Date.now(), alertId: alert.id,
            phase: eventPhase, regions: [...alertRegions],
            settlementCount: eventSettlements.size,
          }) + "\n");
        } catch {}
      }
    }
  } catch (err) {
    console.error(`[שגיאה] ${err.message}`);
  }
}

// Test alert scenarios
const TEST_SCENARIOS = [
  {
    title: "ירי רקטות וטילים",
    desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
    areas: ["אשקלון - דרום", "אשקלון - צפון", "קריית גת", "שדרות", "נתיבות", "יד מרדכי", "זיקים", "כרמיה", "ברור חיל", "נגבה", "גברעם"],
  },
  {
    title: "ירי רקטות וטילים",
    desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
    areas: ["תל אביב - מרכז העיר", "תל אביב - דרום העיר", "רמת גן", "גבעתיים", "חולון", "בת ים", "ראשון לציון", "הרצליה", "רעננה"],
  },
  {
    title: "ירי רקטות וטילים",
    desc: "היכנסו למרחב המוגן ושהו בו דקה וחצי",
    areas: ["קריית שמונה", "מטולה", "דפנה", "שאר ישוב", "כפר גלעדי", "מרגליות", "שדה נחמיה", "כפר יובל"],
  },
  {
    title: "ירי רקטות וטילים",
    desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
    areas: ["חיפה", "קריית אתא", "קריית ביאליק", "קריית ים", "נשר", "טירת כרמל", "עכו", "נהריה"],
  },
  {
    title: "חדירת כלי טיס עוין",
    desc: "היכנסו למרחב המוגן ושהו בו 10 דקות",
    areas: ["ירושלים", "בית שמש", "מודיעין-מכבים-רעות", "רחובות", "אשדוד", "לוד", "רמלה"],
  },
];

// Simulation: split areas into waves and schedule over 3 minutes
let simTimers = [];

function startSimulation() {
  if (simActive) return;

  const scenario = TEST_SCENARIOS[Math.floor(Math.random() * TEST_SCENARIOS.length)];
  const areas = [...scenario.areas];

  // Split into 3 waves
  const w1 = Math.ceil(areas.length / 3);
  const w2 = Math.ceil((areas.length - w1) / 2);
  const waves = [
    areas.slice(0, w1),
    areas.slice(w1, w1 + w2),
    areas.slice(w1 + w2),
  ].filter(w => w.length > 0);

  simActive = true;
  console.log(`[סימולציה] ${scenario.title} — ${areas.length} ישובים ב-${waves.length} גלים`);

  sendTelegram(
    `🧪 <b>סימולציה מתחילה</b>\n` +
    `📋 ${scenario.title}\n` +
    `👥 ${areas.length} ישובים ב-${waves.length} גלים\n` +
    `⏱ משך: 3 דקות\n\n` +
    `⚠️ התרעות אמיתיות לא ייקלטו בזמן הסימולציה`,
    TELEGRAM_CHAT_ID
  );

  // Wave timing: t=0, t=30s, t=60s
  // Clear at t=80s → waiting after 15s → ended after 30s protection
  // Total: ~2.5 min
  waves.forEach((waveAreas, i) => {
    const delay = i * 30000;
    const timer = setTimeout(() => {
      simResponse = JSON.stringify({
        id: `sim-${Date.now()}`,
        cat: "1",
        title: scenario.title,
        desc: scenario.desc,
        data: waveAreas,
      });
      console.log(`[סימולציה] גל ${i + 1}/${waves.length}: ${waveAreas.join(", ")}`);
    }, delay);
    simTimers.push(timer);
  });

  // Clear alert → triggers waiting → ended
  const clearTimer = setTimeout(() => {
    simResponse = "";
    console.log("[סימולציה] ניקוי — ממתין לשלבי המתנה וסיום");
  }, 80000);
  simTimers.push(clearTimer);

  // End simulation after all phases complete
  const endTimer = setTimeout(() => {
    simActive = false;
    simResponse = "";
    simTimers = [];
    console.log("[סימולציה] הסתיימה");
    sendTelegram("🧪 הסימולציה הסתיימה — חזרה למצב אמיתי", TELEGRAM_CHAT_ID);
  }, 140000);
  simTimers.push(endTimer);
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

// Listen for /test command via Telegram polling
const TELEGRAM_UPDATES_URL = `${TELEGRAM_API}/getUpdates`;
let lastUpdateId = 0;

async function pollTelegramCommands() {
  try {
    const res = await fetch(`${TELEGRAM_UPDATES_URL}?offset=${lastUpdateId + 1}&timeout=5`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      // Handle boom feedback buttons
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;

        if (cbData === "fb_boom" || cbData === "fb_boom_strong") {
          const strong = cbData === "fb_boom_strong";
          const fbTime = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" });

          await answerCallback(cb.id, `💥 בום נרשם! (${strong ? "חזק" : "רגיל"})`);

          feedbackLog.push({
            type: "boom", intensity: strong ? 3 : 1,
            time: fbTime, timestamp: Date.now(),
          });
          writeFileSync(FEEDBACK_PATH, JSON.stringify(feedbackLog, null, 2));

          // Add to event history and update message
          if (eventPhase) {
            eventHistory.push({ time: fbTime, text: `💥 בום${strong ? " חזק" : ""}` });
            await updateEventMessage();
          }
          console.log(`[משוב] 💥 בום${strong ? " חזק" : ""} ${fbTime}`);
        }
        continue;
      }

      const text = update.message?.text || update.message?.forward_text || "";
      const fwdText = update.message?.forward_from_chat ? text : "";
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== TELEGRAM_CHAT_ID) continue;

      // Save forwarded messages for analysis
      if (fwdText || (text && !text.startsWith("/"))) {
        try {
          const logFile = "/tmp/oref-forwarded-msgs.jsonl";
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
          (eventPhase ? `\n📍 אירוע פעיל: ${eventPhase} (${eventSettlements.size} ישובים)` : ""),
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

const ALERT_HISTORY_PATH = new URL("./alert-history.json", import.meta.url);
const IMPACT_HISTORY_PATH = new URL("./impact-history.json", import.meta.url);
const CORRELATION_PATH = new URL("./correlation-index.json", import.meta.url);

// Backfill alert history from forwarded messages
function backfillAlertHistory() {
  try { readFileSync(ALERT_HISTORY_PATH); return; } catch {} // already exists

  let lines;
  try {
    lines = readFileSync("/tmp/oref-forwarded-msgs.jsonl", "utf8").trim().split("\n");
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
console.log("פקודת בדיקה: /test\n");

setInterval(fetchAlerts, POLL_INTERVAL);
setInterval(pollTelegramCommands, 3000);
fetchAlerts();
