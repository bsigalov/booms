# Early Warning vs Alert Zone Differentiation Spec

## Context
Early warnings (התרעה מוקדמת) and actual alarms (אזעקה) are fundamentally different. Early warnings cover the maximum possible threat area — much larger. Alarms indicate where sirens actually sound — more focused. Currently both are rendered similarly on the map. This feature visually separates them and builds pattern-based statistics to predict alarm probability from early warning shape.

## 1. Map Visualization

### Layers (bottom to top):
1. **EW zone** — yellow/amber (#FFC107) convex hull wrapping all early warning settlements
2. **Alarm ellipses** — red, per ellipsoid spec (wave-based with fading opacity)
3. **Settlement dots/polygons** — on top of everything
4. **Expansion vector** — topmost

### EW Zone Rendering:
- Convex hull of all early warning settlement coordinates
- Color: yellow/amber (#FFC107) fill, darker amber (#FF8F00) stroke
- Opacity fades per EW expansion wave (same formula as alarm ellipsoids: `baseOpacity / (totalWaves - waveIndex)`)
- When alarm arrives, EW zone remains visible underneath — showing the contrast between warned area and actual alarm zone
- EW zone always rendered BELOW alarm ellipses

### Visual Result:
Large amber area (EW) with smaller red ellipses (alarms) on top. User immediately sees: "the warning was this big, but the actual attack was this focused."

## 2. Direct Fire Detection (Lebanon-type)

Attacks from Lebanon typically arrive without early warning — direct sirens.

### Detection:
- If alarm (cat=1 or cat=6) arrives without ANY early warning (cat=10 "בדקות הקרובות") in the same OR adjacent Oref regions within the previous 5 minutes → classified as **direct fire**

### Adjacent Regions:
- Pre-computed adjacency map: for each Oref region, list its geographic neighbors
- Derived from settlement coordinates: if any two settlements from different regions are within 15km, those regions are adjacent
- Static data, computed once at startup from `oref-regions-official.json` + `coords-cache.json`

### Direct Fire Treatment:
- No EW layer on map (there was no early warning)
- Tighter impact zone estimation (higher certainty)
- Different risk message: "ירי ישיר (ללא התרעה מוקדמת)"
- Event flag: `evt.isDirect = true`

## 3. EW→Alarm Pattern Statistics

### Goal:
Build clusters of similar EW→alarm events and track per-cluster: how often does this pattern lead to alarm at home? What's the typical timing?

### Pattern Features (for clustering):

| Feature | Weight | What it captures |
|---|---|---|
| EW area size (km²) | High | Attack scale |
| EW shape eccentricity | High | Elongated vs scattered |
| EW semi-major/semi-minor ratio | Medium | How elongated |
| EW ellipse azimuth (major axis angle) | High | Attack corridor orientation |
| Alarm area size (km²) | High | Impact zone scale |
| Alarm shape eccentricity | High | Focused vs spread |
| EW/Alarm area ratio | High | How much EW narrows to alarm |
| Vector direction (azimuth) | High | Launch origin direction |
| Time EW→Alarm (seconds) | High | Missile type / flight distance |
| Region overlap (which regions) | Low | General area |
| Exact settlement locations | Low | Fine-tuning only |

### Clustering Algorithm:
- Normalize each feature to 0-1 range
- Apply weights as multipliers
- Use simple distance metric (weighted Euclidean) between event feature vectors
- Cluster with threshold-based grouping: if distance < threshold → same pattern
- No fixed number of clusters — grows organically as new patterns emerge

### Per-Cluster Statistics:
```javascript
{
  clusterId: string,
  eventCount: number,
  avgEWAreaKm2: number,
  avgAlarmAreaKm2: number,
  avgTimingSeconds: number,
  avgAzimuth: number,
  avgEccentricity: number,
  pAlarmGivenEW: number,        // how often EW leads to alarm (0-1)
  pAlarmAtHome: number,         // how often alarm reaches home area
  regions: string[],            // most common regions
  lastSeen: ISO timestamp,
}
```

### Storage:
- `/data/ew-alarm-patterns.json` — array of cluster objects
- Updated after each event ends
- Continuously refined as more events accumulate

### Usage in Risk Model:
When a new EW arrives:
1. Compute its feature vector (area, shape, direction)
2. Find closest matching cluster
3. Use cluster's `pAlarmGivenEW` and `pAlarmAtHome` as calibrated probabilities
4. Show in risk message: "based on X similar events, Y% chance of alarm here"

## 4. Data Model Changes

### Per event (new fields):
```javascript
{
  ewSettlements: Set<string>,       // settlements from early warning
  ewEllipse: { centroid, semiMajor, semiMinor, azimuthDeg, eccentricity },
  ewHull: [[lng,lat], ...],         // convex hull of EW settlements
  ewAreaKm2: number,               // area of EW convex hull
  isDirect: boolean,                // true = no EW preceded this alarm
  ewToAlarmSeconds: number | null,  // time from first EW to first alarm
  patternClusterId: string | null,  // matched cluster from statistics
}
```

## 5. Files to Modify

- `oref-alerts.mjs` — EW zone rendering, direct fire detection, pattern recording
- `oref-alerts.mjs` — region adjacency computation at startup
- `/data/ew-alarm-patterns.json` — persistent pattern statistics (new file)

## 6. Verification

1. Event with EW → verify amber convex hull on map, red alarm ellipses on top
2. Northern alert without EW → verify `isDirect=true`, no amber zone
3. After 10+ events → verify pattern clusters form and `pAlarmGivenEW` is computed
4. Risk message shows pattern-based probability when EW matches known cluster
