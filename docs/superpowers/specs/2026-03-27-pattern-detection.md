# Missile Pattern Detection & Timing Prediction Spec

## Context
Different attack origins (Iran, Lebanon, Gaza) have fundamentally different characteristics. Iran attacks have massive early warnings and predictable timing. Lebanon is direct fire with no warning. Gaza is localized to the south. By classifying the origin and matching to historical patterns, we can predict alarm timing and impact zones.

## 1. Origin Classification

Automatic classification based on simple rules:

| Origin | Has EW? | Area | Settlements | Detection |
|---|---|---|---|---|
| **Iran** | Yes (massive) | All Israel | 100+ EW settlements | cat=10 + settlement count > 100 |
| **Lebanon** | No | North / Center | Any | No EW within 5 min in same/adjacent regions |
| **Gaza** | No | South only | 10-20km from Gaza | No EW + southern regions (עוטף עזה, שער הנגב, מערב הנגב, אשקלון) |

### Event flag:
```javascript
evt.origin = "iran" | "lebanon" | "gaza" | "unknown"
```

### Detection logic:
1. If event has EW phase with 100+ settlements → `"iran"`
2. Else if `evt.isDirect` (no EW) and settlements are in southern Gaza-range regions → `"gaza"`
3. Else if `evt.isDirect` → `"lebanon"`
4. Else → `"unknown"`

## 2. Iran Pattern Detection

Iran attacks are the only type with early warnings. They have predictable patterns based on missile type and launch location.

### Pattern Features (from EW→Alarm spec):
- EW area size + shape (eccentricity, semi-major/minor ratio)
- EW ellipse azimuth (attack corridor direction)
- Alarm area size + shape
- EW/Alarm area ratio
- Vector direction
- Time EW→Alarm (seconds)

### Launch Origin Inference:
The ellipse azimuth indicates where the missiles come from:
- **NE direction** (azimuth ~30-60°) → western Iran (closest, shortest flight time)
- **E direction** (azimuth ~80-100°) → central Iran (medium distance)
- **SE direction** (azimuth ~120-150°) → southern Iran / Yemen (longest flight time, different missile type)

Different azimuths imply different:
- Missile types (ballistic vs cruise)
- Flight times (affects EW→alarm gap)
- Interception methods (Arrow vs David's Sling)
- Impact patterns (different warhead types)

### Timing Prediction:
After 10+ Iran events accumulated:
1. New EW arrives → compute feature vector
2. Match to closest pattern cluster (from EW→Alarm spec)
3. Use cluster's `avgTimingSeconds` to predict alarm time
4. Display: `צפי לאזעקה ב-21:22` (EW time + predicted gap)
5. Confidence based on cluster size and variance: `(±X דקות, מבוסס על Y אירועים)`

### Minimum Data Requirement:
- Do NOT predict until cluster has 10+ events
- Show: `אין מספיק נתונים לחיזוי` until threshold met

## 3. Lebanon / Gaza Treatment

### Lebanon (direct fire):
- No EW layer on map
- Origin label: `ירי מלבנון`
- Higher certainty of impact zone (smaller area, known trajectory)
- Shorter protection time (typically 0-60 seconds)
- Interception: Iron Dome (~85% for rockets)

### Gaza (direct fire):
- No EW layer on map
- Origin label: `ירי מעזה`
- Very localized (10-20km range)
- Short protection time (15-45 seconds depending on distance)
- Interception: Iron Dome (~90% for short-range)

## 4. Risk Message Changes

### Iran attack (with EW):
```
🏠 רחובות | ירי מאיראן
צפי לאזעקה ב-21:22 (±3 דק', מבוסס על 15 אירועים)
🟡 אזעקה 70% | נפילה ב-5ק"מ 2% | רסיס ב-5ק"מ 8% | בום ב-25ק"מ 85%
```

### Lebanon (direct fire, no EW):
```
🏠 רחובות | ירי מלבנון (ללא התרעה מוקדמת)
🟢 אזעקה 5% | נפילה ב-5ק"מ 0% | בום ב-25ק"מ 3%
```

### Gaza (direct fire):
```
🏠 רחובות | ירי מעזה
🟢 אזעקה 1% | נפילה ב-5ק"מ 0% | בום ב-25ק"מ 0%
```

## 5. Data Model Changes

### Per event (new fields):
```javascript
{
  origin: "iran" | "lebanon" | "gaza" | "unknown",
  predictedAlarmTime: Date | null,     // for Iran attacks only
  predictionConfidence: number | null,  // ±minutes
  predictionBasedOn: number | null,     // number of historical events in cluster
  launchAzimuth: number | null,        // inferred direction to launch origin
}
```

### Persistent data:
- Pattern clusters already in `/data/ew-alarm-patterns.json` (from EW spec)
- Add `origin` field to each cluster

## 6. Files to Modify

- `oref-alerts.mjs` — origin classification, timing prediction, risk message formatting
- `/data/ew-alarm-patterns.json` — add origin field to clusters

## 7. Verification

1. Iran attack (with massive EW) → verify `origin="iran"`, timing prediction shown
2. Northern direct fire → verify `origin="lebanon"`, no EW layer, correct label
3. Southern direct fire → verify `origin="gaza"`, correct label
4. After 10+ Iran events → verify timing prediction appears with confidence interval
5. Different azimuth Iran attacks → verify they cluster separately
