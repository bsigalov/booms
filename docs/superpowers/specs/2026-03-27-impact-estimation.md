# Impact Point Estimation Spec

## Context
The ellipse shape and expansion pattern contain information about where the missile is heading and where it might land. A clear elongated ellipse pointing in one direction suggests a focused attack corridor. When the shape expands non-uniformly after the initial pattern, it likely indicates interception — with debris spreading in a wider area around the interception point.

## 1. Impact Point Estimation

### Method:
The estimated impact point is at the **leading edge** of the ellipse along its major axis, projected forward by expansion velocity:

```
impact_point = ellipse_centroid + (semiMajor × direction_unit_vector × projection_factor)
```

Where:
- `direction_unit_vector` = unit vector along major axis, pointing in expansion direction
- `projection_factor` = 0.5 (default) — places impact at the far end of the ellipse

### Confidence (uncertainty radius):
- **High confidence** (small circle): eccentricity > 0.7, clear direction, stable expansion → radius = semiMinor
- **Medium confidence**: eccentricity 0.5-0.7 → radius = semiMinor × 2
- **Low confidence** (large circle): eccentricity < 0.5, scattered → radius = semiMajor (very uncertain)

### Map visualization:
- Red crosshair marker (⊕) at estimated impact point
- Red circle around it showing uncertainty radius
- Circle opacity: 30% fill, solid stroke
- Label: `נקודת נפילה משוערת`

## 2. Interception Detection

### How to detect:
Compare the shape of wave N to wave N+1:
1. Compute ellipse for each wave
2. If wave N+1's area is significantly larger (>2x) than wave N AND the shape becomes less eccentric (more circular) → likely interception happened between waves
3. The interception point is estimated between the two wave centroids, closer to where the shape change occurred

### Detection criteria:
```
isInterception = (area_N+1 / area_N > 2.0) AND (eccentricity_N+1 < eccentricity_N × 0.7)
```

Meaning: the area more than doubled AND the shape became significantly rounder.

### Interception point estimation:
```
interception_point = centroid_N + 0.7 × (centroid_N+1 - centroid_N)
```
Placed 70% of the way between the two wave centroids (interception typically happens ahead of the approaching front).

### Debris zone:
- Radius: `semiMajor_N+1` (the expanded wave's size represents debris spread)
- Green crosshair marker at interception point
- Green circle showing debris zone
- Circle opacity: 20% fill, dashed stroke
- Label: `נקודת יירוט משוערת (פיזור רסיסים)`

## 3. Map Layers (complete stack)

Bottom to top:
1. Base map (OSM tiles)
2. EW zone (yellow convex hull) — if exists
3. Wave ellipses / convex hulls (fading opacity)
4. Settlement polygons / circles
5. **Debris zone** (green dashed circle) — if interception detected
6. **Impact uncertainty circle** (red circle)
7. **Interception crosshair** (green ⊕) — if interception detected
8. **Impact crosshair** (red ⊕)
9. Expansion vector arrow
10. Home marker

## 4. Risk Message Changes

### Normal attack (no interception detected):
```
🎯 נקודת נפילה משוערת: דרום אשקלון (ודאות בינונית, ±8 ק"מ)
```

### After interception detected:
```
🛡️ יירוט זוהה — נקודת יירוט משוערת: צפון אשדוד
🎯 פיזור רסיסים: רדיוס ~12 ק"מ סביב נקודת היירוט
```

## 5. Data Model Changes

### Per event (new fields):
```javascript
{
  estimatedImpact: {
    point: [lng, lat],
    uncertaintyKm: number,
    confidence: "high" | "medium" | "low",
    label: string,  // nearest settlement name
  } | null,
  interception: {
    detected: boolean,
    point: [lng, lat] | null,
    debrisRadiusKm: number | null,
    detectedAtWave: number | null,  // which wave transition triggered detection
  },
}
```

## 6. Limitations

- Impact estimation is a **guess** based on geometry — not physics simulation
- Works best for elongated, directional attacks. Scattered attacks → low confidence
- Interception detection is heuristic — could be false positive from multi-salvo attacks
- Should always show confidence level and never present as certain

## 7. Files to Modify

- `oref-alerts.mjs` — impact estimation logic, interception detection, map rendering, risk message
- Reuses `fitEllipse`, `projectToLocalKm`, `haversineKm` from existing code

## 8. Verification

1. Elongated directional attack → verify impact crosshair at leading edge
2. Scattered attack → verify large uncertainty circle, low confidence label
3. Attack with sudden area expansion → verify interception detection, green marker + debris zone
4. Single wave (no expansion) → verify no impact estimation shown
5. Multiple waves, steady expansion → verify impact point moves forward with each wave
