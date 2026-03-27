# News Channel Integration Spec

## Context
Post-event verification is critical for calibrating the risk model. News channels report impact locations, interception results, missile types, and damage assessments within minutes of an event. By scraping multiple Telegram news channels, we can build a ground-truth dataset that feeds back into pattern detection and probability calibration.

An existing `scrapeImpactChannel` function scrapes one channel. This spec expands it to multiple channels with richer data extraction.

## 1. Channels to Scrape

| Channel | Username | Content type |
|---|---|---|
| אהרון חדשות | @aharonyediotnews | Primary news, impact reports |
| ללא צנזורה | @lelotsenzura | Uncensored reports, fast updates |
| ידיעות 25 | @yediotnews25 | News aggregation |

All are public Telegram channels accessible via `https://t.me/s/<username>`.

### Scraping method:
- HTTP GET to `https://t.me/s/<username>` (public web view)
- Parse HTML for message text + message ID
- Track `lastScrapedMsgId` per channel to avoid reprocessing
- Frequency: every 60 seconds per channel (staggered: channel 1 at t=0, channel 2 at t=20, channel 3 at t=40)

## 2. Data Extraction

### Categories to detect:

| Category | Hebrew keywords | Example |
|---|---|---|
| **Impact** | נפילה, נפל טיל, פגיעה ישירה, רקטה נפלה, פגיעה | "נפילה בשטח פתוח באזור אשקלון" |
| **Interception** | יירוט, יורט, מיירט, יירוטים | "3 יירוטים מעל חיפה" |
| **Debris** | רסיס, רסיסים, שברי, רסיסי יירוט | "רסיסי יירוט נפלו באזור נתניה" |
| **Missile type** | טיל בליסטי, טיל שיוט, רקטה, מל"ט, כטב"מ, טיל מתפצל | "טיל בליסטי יורט מעל ים המלח" |
| **Casualties** | פצועים, נפגעים, הרוגים, נהרג | "4 פצועים קל מרסיסים" |
| **Damage** | נזק, פגיעה במבנה, פגיעה ברכב, שריפה | "נזק לבניין מגורים" |

### Missile type classification:

| Hebrew term | Type | Characteristics |
|---|---|---|
| טיל בליסטי | Ballistic | Long range, high altitude, Arrow intercepts |
| טיל שיוט / טיל מעופף | Cruise | Medium range, low altitude, David's Sling |
| רקטה | Rocket | Short range, Iron Dome |
| מל"ט / כטב"מ / רחפן | Drone/UAV | Slow, Iron Dome or manual |
| טיל מתפצל / MIRV | MIRV | Multiple warheads, complex interception |

### Location extraction:
- Search message text for known settlement names (from coords-cache)
- Sort by longest name first (avoid partial matches)
- If found: compute distance to home
- If multiple locations: create separate reports

### Count extraction:
- Look for numbers near keywords: "3 יירוטים", "נפילה אחת"
- Default to 1 if no count found

## 3. Report Data Model

```javascript
{
  channel: string,          // channel username
  msgId: number,
  timestamp: ISO string,
  text: string,             // raw text (max 300 chars)
  category: "impact" | "interception" | "debris" | "casualty" | "damage",
  missileType: "ballistic" | "cruise" | "rocket" | "drone" | "mirv" | null,
  location: string | null,  // settlement name if matched
  locationCoord: [lng, lat] | null,
  distToHome: number | null,
  count: number,            // number of impacts/interceptions
  relatedEventId: string | null,  // matched to an active or recent event
}
```

## 4. Event Correlation

After extracting reports, match them to recent alert events:

### Matching logic:
1. Report timestamp within 30 minutes of event start/end → candidate
2. Report location within 50km of event centroid → confirmed match
3. If matched: add report to `evt.newsReports[]`

### Per-event aggregation:
```javascript
evt.newsReports = [{...report}];
evt.newsStats = {
  impacts: number,
  interceptions: number,
  debrisReports: number,
  casualties: number,
  missileTypes: string[],    // unique types mentioned
  impactLocations: string[], // settlement names
};
```

## 5. Feedback to Risk Model

After event ends, use news reports to calibrate:

### What we learn per event:
- **Actual interception rate**: `interceptions / (interceptions + impacts)`
- **Debris frequency**: `debrisReports / interceptions`
- **Impact-in-populated-area rate**: impacts with known settlement location / total impacts
- **Missile type**: affects which interception rate to use

### Calibration update:
- Store per-origin (Iran/Lebanon/Gaza) running averages
- Weight recent events higher (exponential decay)
- Update `INTERCEPTION_RATE` constants when enough data (20+ events)
- Store in `/data/calibration.json`

## 6. Storage

- `/data/news-reports.json` — rolling buffer of last 1000 reports
- `/data/calibration.json` — running averages per origin
- Per-channel `lastScrapedMsgId` stored in `/data/scraper-state.json`

## 7. Files to Modify

- `oref-alerts.mjs` — expand `scrapeImpactChannel` to multi-channel, richer extraction, event correlation
- `/data/news-reports.json` — new persistent file
- `/data/calibration.json` — new persistent file
- `/data/scraper-state.json` — new persistent file

## 8. Verification

1. Verify all 3 channels are scraped (check logs for `[scraper]` entries)
2. After real event → verify news reports matched to event
3. Verify missile type extraction from sample messages
4. Verify location extraction matches known settlements
5. After 20+ events → verify calibration data updates interception rates
