# Ellipsoid Visualization & Expansion Vector Spec

## Context
The bot currently renders alert settlements as colored polygons/circles on a static map. There's no visual representation of the attack's spatial pattern, direction, or expansion over time. The existing `fitEllipse` function computes PCA-based ellipses but they're only used for risk probability calculations, never rendered.

This feature adds visual ellipses per wave, fading opacity history, expansion vectors, and convex hull fallback — giving users an immediate visual understanding of where the attack is heading.

## 1. Ellipse Per Wave

Each wave in an event computes its own ellipse via the existing `fitEllipse(coords)` function. Ellipses are rendered on the map as semi-transparent filled shapes.

**Opacity rule:** Newest wave always gets `baseOpacity` (default 50%). Each new wave reduces all previous waves' opacity:

```
opacity(wave_i) = baseOpacity / (totalWaves - waveIndex)
```

| After wave | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| 1 wave | 50% | | | |
| 2 waves | 25% | 50% | | |
| 3 waves | 17% | 25% | 50% | |
| 4 waves | 12% | 17% | 25% | 50% |

`baseOpacity` is configurable. Each wave uses its color from the existing `WAVE_COLORS` palette (red, purple, blue, teal, green, orange, pink, deep purple).

All ellipses must be transparent enough that the underlying map (roads, labels, terrain) remains visible.

## 2. Convex Hull Fallback

When the ellipse fit is poor — eccentricity < 0.5 (nearly circular, no clear direction):
- Render the **convex hull** of wave settlement coordinates instead of an ellipse
- Same opacity and color rules apply
- Expansion vector is capped at 50% length to signal lower confidence
- Visual meaning: "attack is scattered, direction uncertain"

**Threshold:**
- Eccentricity > 0.5 → render ellipse
- Eccentricity < 0.5 → render convex hull

## 3. Expansion Vector

Arrow drawn from first wave centroid to latest wave centroid.

**Properties:**
- **Length:** proportional to `semiMajor × expansionVelocity` (capped at reasonable map max)
- **Color:** orange (#FF9800) by default
- **Color override:** red (#F44336) when strongly pointing toward home (dot product > 0.7)
- **Arrowhead:** filled triangle at tip
- **Label:** direction in Hebrew (צפון-מזרח etc.)

**Special cases:**
- Single wave (no expansion): no vector drawn
- Convex hull mode: vector drawn at 50% max length
- Toward home: color changes to red + risk message `⚡ מתרחב לכיוונך`

## 4. Rendering Backends

Two backends, switchable via `/renderer` bot command:

### staticmaps (default)
- Approximate each ellipse as a 36-point polygon
- Uses existing `map.addPolygon()` API
- Fast rendering (<1s), no new dependencies
- Convex hull renders natively as polygon
- Vector arrow approximated as thin polygon with triangle head

### leaflet+puppeteer (optional)
- Server-side Leaflet rendered to PNG via puppeteer
- Real SVG ellipses with CSS opacity/gradients
- Proper arrowhead markers
- 2-5 second render time, +300MB Docker image
- Better quality for all planned future features

**Bot command:** `/renderer static` or `/renderer leaflet`

## 5. Data Model Changes

### Per wave (new fields on `evt.waves[i]`):
```javascript
{
  settlements: Set<string>,
  time: string,
  ellipse: {
    centroid: [lng, lat],
    semiMajor: km,
    semiMinor: km,
    azimuthDeg: 0-360,
    eccentricity: 0-1,
    azimuthRad: radians,
  },
  hull: [[lng,lat], ...] | null,
  useHull: boolean,
}
```

### Per event (new fields on `evt`):
```javascript
{
  expansionVector: {
    origin: [lng, lat],
    target: [lng, lat],
    magnitude: number,
    direction: string,
    towardHome: boolean,
  }
}
```

## 6. Map Generation Changes

In `generateAlertMap(areas, evt)`:

1. **Before rendering settlements:** render wave ellipses/hulls (bottom layer)
2. For each wave (oldest to newest):
   a. Compute opacity: `baseOpacity / (totalWaves - waveIndex)`
   b. If `wave.useHull`: render hull polygon
   c. Else: render 36-point ellipse polygon
   d. Apply wave color + computed opacity
3. **After ellipses:** render settlement polygons/circles (on top)
4. **After settlements:** render expansion vector arrow
5. **After vector:** render home marker (if within range)

## 7. Integration with Existing Code

**`fitEllipse`** — already exists, no changes needed. Called per wave instead of per event.

**`trackExpansion`** — still used for risk analysis. Expansion vector for rendering computed separately from wave centroids.

**`generateAlertMap`** — major changes: add ellipse/hull/vector rendering layers.

**`createEvent` / alert processing** — add ellipse computation when wave is added. Store in wave object.

**Risk message** — no changes, still uses existing probability model.

## 8. Bot Commands

- `/renderer static` — use staticmaps with polygon-approximated ellipses (default)
- `/renderer leaflet` — use puppeteer+Leaflet with real SVG ellipses

## 9. Files to Modify

- `oref-alerts.mjs` — generateAlertMap, wave processing, new /renderer command
- `Dockerfile` — add puppeteer (optional, for leaflet renderer)
- `package.json` — add puppeteer dependency (optional)

## 10. Verification

1. Send `/test` → verify ellipses render per wave with fading opacity
2. Verify expansion vector arrow direction and length
3. Force a scattered alert (low eccentricity) → verify convex hull renders
4. Switch renderers via `/renderer` → verify both produce correct output
5. Verify map remains readable (text, roads visible through ellipses)
