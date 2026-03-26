# Risk Model — Base Rates & Algorithm Design

## Published Data (Initial Base Rates)

### Interception Rates by System
| System | Target type | Claimed rate | Realistic estimate | Source |
|---|---|---|---|---|
| Iron Dome | Short-range rockets (4-70km) | 90% | 85-90% | IDF, Wikipedia |
| David's Sling | Medium-range rockets, cruise missiles (40-300km) | ~80% | 70-80% | IDF statements |
| Arrow 2/3 | Ballistic missiles (>300km) | ~90% | 80-90% | IDF statements |
| All systems | Drones/UAVs | ~70% | 50-70% | Estimated from recent conflicts |

### Oref Alert Categories → Threat Type
| cat | title | threat | defense system | interception rate |
|---|---|---|---|---|
| 1 | ירי רקטות וטילים | Rockets/missiles | Iron Dome / David's Sling | 85% |
| 6 | חדירת כלי טיס עוין | Drones/UAVs | Iron Dome / manual | 60% |
| 10 | בדקות הקרובות... | Early warning | N/A | N/A |

### Impact Distribution (when interception fails)
- Populated area: ~15% of unintercepted rockets (most land in open areas)
- Within 5km of home (given populated area impact): depends on area density
- Debris from interception: ~30% of interceptions produce noticeable debris, radius ~5km

### Boom Audibility
- Interception boom: audible within ~20-30km
- Impact boom: audible within ~10-15km
- Debris: usually not audible

## New Algorithm Design

### Probability Definitions (all radius-based)
- **P(alarm)**: probability of siren at home location
- **P(impact within 5km)**: probability of missile/rocket impact within 5km of home
- **P(debris within 5km)**: probability of interception debris falling within 5km of home
- **P(boom within 20km)**: probability of audible explosion within 20km

### P(alarm) — Will I get a siren?
```
if (home already in alert zone): 100%
if (home region in alert regions): 95%
if (expansion toward home):
  base = 40%
  + distance_decay (closer = higher)
  + expansion_velocity_factor
  + event_size_factor (large events spread more)
else:
  distance_decay only (drops to 0 at 100km)
```

### P(impact within 5km) — Will a missile land near me?
```
P(impact) = P(alarm) × P(not_intercepted) × P(hits_populated) × P(within_5km)

Where:
  P(not_intercepted) = 1 - interception_rate[cat]
    cat=1 (rockets): 0.15
    cat=6 (drones): 0.40
  P(hits_populated) = 0.15 (most land in open areas)
  P(within_5km) = populated_density_factor
    dense urban: 0.3
    suburban: 0.15
    rural: 0.05
```

### P(debris within 5km) — Will interceptor debris fall near me?
```
P(debris) = P(alarm) × interception_rate × P(debris_notable) × P(within_5km_debris)

Where:
  P(debris_notable) = 0.30
  P(within_5km_debris) = distance_decay from interception point
    interception typically happens 5-15km before target
```

### P(boom within 20km) — Will I hear an explosion?
```
P(boom) = 1 - (1 - P(interception_nearby)) × (1 - P(impact_nearby))

Where:
  P(interception_nearby) = alerts_within_30km / total_alerts × interception_rate
  P(impact_nearby) = P(impact) scaled to 20km radius
```

## Data Collection Pipeline (for calibration)

### Automatic (per event)
- Early warning → did alarm follow? (Y/N, which settlements)
- Alert distance from home
- Event type (cat), size (settlements), duration
- Expansion direction and velocity

### Manual/Scraped (post-event)
- Impact reports (location, type)
- Interception reports (location, count)
- Debris reports (location, damage)
- Source: news channels, IDF statements
