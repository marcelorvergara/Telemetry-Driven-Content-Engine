# Strava Biometrics Architecture

Covers HR, cadence, elevation, and Strava-derived speed on the HUD. These are sourced exclusively from the `.gpx` file uploaded by the user — not from GoPro GPMF.

---

## Hardware Context

The user rides with a GoPro camera + **Amazfit TRex 3** smartwatch. The watch syncs to Strava, which exports a `.gpx` file containing:

- `<trkpt lat lon>` — 1 Hz GPS coordinates
- `<ele>` — elevation in metres
- `<time>` — ISO 8601 wall-clock timestamp
- `gpxtpx:hr` — heart rate in BPM (Garmin TrackPointExtension v1 namespace)
- `gpxtpx:cad` — wrist-derived cadence in RPM

**Cadence zero-reads**: The Amazfit derives cadence from wrist accelerometer, not a crank sensor. Zero values at stops (~2–3% of records) are valid hardware behaviour — do not treat them as sensor errors or suppress them.

---

## `StravaGpsPoint` Interface

Defined in `telemetry.model.ts`. All biometric fields are populated at parse time by `StravaTelemetryService.parseGpx()`:

```typescript
export interface StravaGpsPoint {
  t: number;               // ms from video start (render-loop compatible with GPS9Sample.t)
  lat: number;
  lon: number;
  ele: number;             // metres, from <ele>
  hr: number;              // beats per minute (0 if sensor absent)
  cad: number;             // wrist-derived RPM (0 at stops — valid)
  speed: number;           // m/s, Haversine-derived between adjacent points (set at parse time)
  relativeTimeSec: number; // seconds from video start (debugging only)
  absoluteUnixMs: number;  // wall-clock ms from <time> — survives re-anchoring
}
```

`hr` and `cad` are extracted using `getElementsByTagNameNS` with the full Garmin namespace URI:

```typescript
const NS_TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const hr  = parseInt(pt.getElementsByTagNameNS(NS_TPX, 'hr')[0]?.textContent  ?? '0', 10) || 0;
const cad = parseInt(pt.getElementsByTagNameNS(NS_TPX, 'cad')[0]?.textContent ?? '0', 10) || 0;
```

`querySelector('gpxtpx:hr')` does **not** work in `DOMParser` documents — the namespace prefix is not resolved. Always use `getElementsByTagNameNS` with the full URI.

---

## Speed Derivation (Haversine)

Strava GPS data is 1 Hz. Speed is derived at parse time (second pass), not at 60 Hz render time:

```typescript
for (let i = 1; i < data.length; i++) {
  const dt = (data[i].absoluteUnixMs - data[i - 1].absoluteUnixMs) / 1000;
  data[i].speed = dt > 0
    ? haversineMetres(data[i-1].lat, data[i-1].lon, data[i].lat, data[i].lon) / dt
    : 0;
}
if (data.length > 1) data[0].speed = data[1].speed; // point 0 inherits point 1's speed
```

Point 0 inherits point 1's speed so the display starts non-zero at the beginning of the clip.

**Speed floor**: `SPEED_FLOOR_MS = 8.0 / 3.6` is applied in `drawFrame()` when consuming Strava speed — `Math.max(bio.speed, SPEED_FLOOR_MS)`. The same floor applies to GoPro GPS9 speed. See [sensor-deadzones.md](sensor-deadzones.md).

---

## Speed Source Switching

`telemetrySource: signal<'GoPro' | 'Strava'>` in `app.ts` controls which GPS source feeds the speed readout and map path.

| Condition | Speed source | Map GPS source |
|---|---|---|
| `telemetrySource === 'GoPro'` | `interpolateSpeed(telemetry.gps, …)` (GPS9) | `telemetry.gps` |
| `telemetrySource === 'Strava'` AND `stravaGps.length > 0` | `interpolateBiometrics(stravaGps, …).speed` clamped to `SPEED_FLOOR_MS` | `stravaGps` |
| `telemetrySource === 'Strava'` AND `stravaGps.length === 0` | `interpolateSpeed(telemetry.gps, …)` (fallback) | `telemetry.gps` |

**G-force bar is always rendered.** ACCL is a GoPro-only stream; it never appears in a GPX file. `drawGForceBar()` must never be gated on `telemetrySource` or `stravaGps.length`.

---

## `interpolateBiometrics()`

Binary search (O(log N)) on `StravaGpsPoint[]` by `.t`, then linear interpolation between the two surrounding points:

```typescript
interpolateBiometrics(pts: StravaGpsPoint[], timeMs: number): { hr: number; cad: number; ele: number; speed: number } | null
```

Returns `null` if `pts` is empty or `timeMs` is out of range. The caller checks for `null` before drawing.

Linear interpolation weight: `alpha = (timeMs - lo.t) / (hi.t - lo.t)`. The same `alpha` applies to all four fields.

---

## HR Training Zones

`hrColor(hr, theme)` maps BPM to theme colours. Zone boundaries are fixed — do not adjust per-theme:

| Zone | BPM range | `theme.colors` key |
|---|---|---|
| Recovery | < 100 | `success` |
| Aerobic | 100 – 139 | `primary` |
| Threshold | 140 – 159 | `warning` |
| Anaerobic | ≥ 160 | `danger` |

HR coloring only affects the displayed HR value text — it does not change the background fill or icon colour.

---

## `drawBiometrics()` Layout Variants

One branch per layout. Each branch is self-contained and ends with `ctx.shadowBlur = 0`.

### `spread` layout (VERGARA_YOUTUBE)
- Top-left glowing panel, below the speed readout
- Right-aligned value columns with icon + value + dimmed unit
- `shadowBlur` glow on values using `theme.colors.primary`

### `stacked` layout (CLEAN_SPORT)
- Bottom-right clean panel, above or adjacent to the G-force bar
- Accent colour icons, no `shadowBlur`, thin 1 px separator line
- White/orange palette, compact spacing

### `tiktok-cover` layout (VERGARA_TIKTOK)
- Three solid `fillRect` blocks above the speed box: **ELE / CAD / HR**
- Each block carries a colored left stripe (matching the branding stripe colour for its zone/position)
- No `shadowBlur` (same constraint as `drawSpeedReadout` tiktok-cover branch)
- The stripe segments in `drawBiometrics` are visually continuous with the stripe in `drawSpeedReadout`

**Adding a new layout**: add a branch to `drawBiometrics()`, `drawSpeedReadout()`, and `drawGForceBar()` together. Never leave one of the three unsupported for a given layout string — the Canvas renderer calls all three unconditionally.

---

## Export (Ghost Canvas)

The ghost export canvas (`EXPORT_W = 1920`, `EXPORT_H = 1080`) uses the same `drawBiometrics()` path as the live HUD. The export `onFrame` callback re-calls `interpolateBiometrics()` fresh per frame — it does not re-use `lastSpeed` or any cached biometric value from the live rAF loop.

This is intentional: the live display runs at 60 Hz with potential frame skips; the export drives `videoEl.currentTime` discretely via `requestVideoFrameCallback`. Using the live rAF cache for export would produce stale values whenever the export frame rate diverges from the display frame rate.
