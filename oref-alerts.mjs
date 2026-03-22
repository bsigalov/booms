import StaticMaps from "staticmaps";
import { readFileSync, writeFileSync, appendFileSync } from "fs";

const ALERT_URL = "https://www.oref.org.il/warningMessages/alert/alerts.json";
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
let lastMapMessageId = null; // for editing map instead of resending

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

// --- Risk analysis for Rehovot ---
const HOME_COORD = [34.8113, 31.8928]; // רחובות, ההולנדית
const HOME_NAME = "רחובות";

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

function analyzeRisk(alertCoords) {
  if (alertCoords.length === 0) return null;

  // Centroid
  const centroid = [
    alertCoords.reduce((s, c) => s + c[0], 0) / alertCoords.length,
    alertCoords.reduce((s, c) => s + c[1], 0) / alertCoords.length,
  ];

  // Distance from home to centroid
  const distToCenter = haversineKm(HOME_COORD, centroid);

  // Spread: average distance from centroid to alert points
  const distances = alertCoords.map((c) => haversineKm(centroid, c));
  const spread = distances.reduce((s, d) => s + d, 0) / distances.length;
  const maxSpread = Math.max(...distances);

  // Closest alert point to home
  const closestDist = Math.min(...alertCoords.map((c) => haversineKm(HOME_COORD, c)));

  // Direction
  const dir = bearing(HOME_COORD, centroid);

  // Risk scoring
  let level, emoji, explanation;

  if (closestDist < 5) {
    level = "גבוה מאוד";
    emoji = "🔴";
    explanation = `${HOME_NAME} נמצאת בתוך אזור ההתרעה!`;
  } else if (closestDist < 15) {
    level = "גבוה";
    emoji = "🔴";
    explanation = `נקודת ההתרעה הקרובה ביותר במרחק ${Math.round(closestDist)} ק״מ בלבד`;
  } else if (closestDist < 30) {
    level = "בינוני";
    emoji = "🟠";
    explanation = spread < 20
      ? "התרעה מרוכזת קרובה — ייתכן שתתרחב"
      : "ההתרעה מפוזרת ומתקרבת לאזור";
  } else if (closestDist < 60) {
    level = "נמוך";
    emoji = "🟡";
    explanation = spread > 40
      ? "התרעה רחבה — ייתכנו התרעות בהמשך"
      : "ההתרעה רחוקה יחסית מהאזור";
  } else {
    level = "מזערי";
    emoji = "🟢";
    explanation = "ההתרעה רחוקה מהאזור";
  }

  return {
    distToCenter: Math.round(distToCenter),
    closestDist: Math.round(closestDist),
    spread: Math.round(spread),
    dir,
    level,
    emoji,
    explanation,
  };
}

function formatRiskMessage(alertCoords) {
  const risk = analyzeRisk(alertCoords);
  if (!risk) return "";

  return (
    `\n\n🏠 <b>ניתוח סיכון ל${HOME_NAME}:</b>\n` +
    `📏 מרחק מנקודה קרובה: ${risk.closestDist} ק״מ\n` +
    `🧭 כיוון: ${risk.dir}\n` +
    `📐 פיזור ההתרעה: ${risk.spread} ק״מ\n` +
    `${risk.emoji} <b>רמת סיכון: ${risk.level}</b>\n` +
    `💡 ${risk.explanation}`
  );
}

// Create red map pin marker PNG
const MARKER_SVG = `<svg width="36" height="48" xmlns="http://www.w3.org/2000/svg">
  <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="1" dy="2" stdDeviation="2" flood-opacity="0.4"/>
  </filter>
  <path d="M18 47 C18 47 3 28 3 18 A15 15 0 1 1 33 18 C33 28 18 47 18 47Z"
        fill="#e53935" stroke="white" stroke-width="2" filter="url(#s)"/>
  <circle cx="18" cy="17" r="6" fill="white" opacity="0.9"/>
</svg>`;
const MARKER_PATH = "/tmp/oref-marker.png";

import sharp from "sharp";

async function ensureMarkerIcon() {
  try {
    readFileSync(MARKER_PATH);
  } catch {
    await sharp(Buffer.from(MARKER_SVG)).png().toFile(MARKER_PATH);
  }
}

// Home marker SVG (blue pin)
const HOME_SVG = `<svg width="36" height="48" xmlns="http://www.w3.org/2000/svg">
  <filter id="hs" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="1" dy="2" stdDeviation="2" flood-opacity="0.4"/>
  </filter>
  <path d="M18 47 C18 47 3 28 3 18 A15 15 0 1 1 33 18 C33 28 18 47 18 47Z"
        fill="#1976D2" stroke="white" stroke-width="2" filter="url(#hs)"/>
  <circle cx="18" cy="17" r="6" fill="white" opacity="0.9"/>
</svg>`;
const HOME_MARKER_PATH = "/tmp/oref-home-marker.png";

async function ensureHomeMarker() {
  try {
    readFileSync(HOME_MARKER_PATH);
  } catch {
    await sharp(Buffer.from(HOME_SVG)).png().toFile(HOME_MARKER_PATH);
  }
}

// Resolve areas to coordinates
async function resolveCoords(areas) {
  const coords = [];
  for (const area of areas) {
    const coord = await geocode(area);
    if (coord) coords.push(coord);
  }
  return coords;
}

// Generate map image with alert markers + home marker
async function generateAlertMap(areas, alertCoords = null) {
  await ensureMarkerIcon();
  await ensureHomeMarker();

  const coords = alertCoords || await resolveCoords(areas);
  if (coords.length === 0) return null;

  const map = new StaticMaps({
    width: 800,
    height: 600,
    paddingX: 50,
    paddingY: 50,
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  });

  for (const coord of coords) {
    map.addMarker({
      coord,
      img: MARKER_PATH,
      height: 48,
      width: 36,
      offsetX: 18,
      offsetY: 48,
    });
  }

  // Add home marker (blue pin for Rehovot)
  map.addMarker({
    coord: HOME_COORD,
    img: HOME_MARKER_PATH,
    height: 48,
    width: 36,
    offsetX: 18,
    offsetY: 48,
  });

  await map.render();
  const mapPath = "/tmp/oref-alert-map.png";
  await map.image.save(mapPath);
  return mapPath;
}

// Telegram: send text
async function sendTelegram(message, chatId = TELEGRAM_CHANNEL_ID) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
    return await res.json();
  } catch (err) {
    console.error(`[טלגרם שגיאה] ${err.message}`);
  }
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
      // If edit fails, fall through to send new
    }

    // Send new photo
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

// Poll alerts
async function fetchAlerts() {
  try {
    const res = await fetch(ALERT_URL, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.oref.org.il/",
      },
    });

    const text = await res.text();
    if (!text.trim()) return;

    const parsed = JSON.parse(text);
    const alerts = Array.isArray(parsed) ? parsed : [parsed];
    for (const alert of alerts) {
      if (alert.id !== lastAlertId) {
        lastAlertId = alert.id;
        const time = new Date().toLocaleTimeString("he-IL");

        console.log(`\n[${time}] ${alert.title}`);
        console.log(`  סוג: ${alert.cat}`);
        console.log(`  תיאור: ${alert.desc}`);
        console.log(`  אזורים: ${alert.data.join(", ")}`);

        // Resolve coordinates once, reuse for map + risk
        const alertCoords = await resolveCoords(alert.data);

        const riskMsg = formatRiskMessage(alertCoords);

        const msg =
          `🚨 <b>${alert.title}</b>\n` +
          `⏰ ${time}\n` +
          `📋 ${alert.desc}\n` +
          `📍 ${summarizeAreas(alert.data)}` +
          riskMsg;

        await sendTelegram(msg);

        // Generate and send map (with home marker)
        const mapPath = await generateAlertMap(alert.data, alertCoords);
        if (mapPath) {
          await sendTelegramPhoto(mapPath, `📍 מפת התרעות - ${time}`);
        }
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

async function sendTestAlert() {
  const scenario = TEST_SCENARIOS[Math.floor(Math.random() * TEST_SCENARIOS.length)];
  const time = new Date().toLocaleTimeString("he-IL");

  const alertCoords = await resolveCoords(scenario.areas);
  const riskMsg = formatRiskMessage(alertCoords);

  const msg =
    `🧪 <b>[בדיקה] ${scenario.title}</b>\n` +
    `⏰ ${time}\n` +
    `📋 ${scenario.desc}\n` +
    `📍 ${summarizeAreas(scenario.areas)}` +
    riskMsg;

  await sendTelegram(msg);
  await sendTelegram(msg, TELEGRAM_CHAT_ID);
  const mapPath = await generateAlertMap(scenario.areas, alertCoords);
  if (mapPath) {
    await sendTelegramPhoto(mapPath, `🧪 מפת התרעות (בדיקה) - ${time}`);
    await sendTelegramPhoto(mapPath, `🧪 מפת התרעות (בדיקה) - ${time}`, TELEGRAM_CHAT_ID);
  }
  console.log(`[בדיקה] נשלחה התרעת בדיקה: ${scenario.areas.length} אזורים`);
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
        await sendTestAlert();
      } else if (text === "/status") {
        const uptime = Math.floor(process.uptime());
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = uptime % 60;
        await sendTelegram(
          `✅ <b>הבוט פעיל</b>\n` +
          `⏱ זמן ריצה: ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}\n` +
          `📡 סורק כל ${POLL_INTERVAL / 1000} שנייה\n` +
          `🗺 ישובים במילון: ${Object.keys(CITY_COORDS).length}`,
          TELEGRAM_CHAT_ID
        );
      } else if (text === "/help") {
        await sendTelegram(
          `📋 <b>פקודות זמינות:</b>\n\n` +
          `/test — שלח התרעת בדיקה אקראית עם מפה\n` +
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
