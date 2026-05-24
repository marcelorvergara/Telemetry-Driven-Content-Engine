# Map Feature Architecture — Sprint 6+

## Ghost Vector Map Rule

The native Canvas vector map (`drawVectorMap()` in `telemetry-overlay.ts`) is the **sole map implementation** for this project. It handles both the live HUD and the WebM export from one code path.

**DOM-based map libraries are permanently forbidden.** The reasons are structural, not aesthetic:

| Concern | DOM map (Leaflet / Mapbox) | Ghost Vector Map |
|---|---|---|
| WebM export | Requires `ctx.drawImage()` with tiles → CORS canvas taint → black frames | Native `ctx.lineTo()` — no external fetch, no taint |
| JS heap | Tile cache + library runtime competes with the 64 MB WASM budget | Zero allocation beyond the GPS array already in memory |
| Render path | Two separate systems (DOM + Canvas) must be kept in sync | Single Canvas draw call, same frame, same clock |
| Aesthetic | Tile style is fixed by the provider | Full control via `ThemeConfig` colours and stroke width |

**Any future spatial feature must extend `drawVectorMap()`**, not introduce a new DOM-based library.

---

## CORS Canvas Taint Rule

Drawing a cross-origin image onto a Canvas element (via `ctx.drawImage()`) marks that canvas as **origin-dirty**, even if the image server sends permissive CORS headers, unless `crossOrigin = 'anonymous'` is set before the image loads. Once origin-dirty:

- `canvas.captureStream()` yields a `MediaStream` whose frames are opaque black.
- `canvas.toDataURL()` and `canvas.toBlob()` throw `SecurityError`.

This silently breaks the WebM export without any thrown exception at the `MediaRecorder` layer. **The HUD canvas must never have `ctx.drawImage()` called on it with external content.** All visual elements in `telemetry-overlay.ts` must use native Canvas 2D primitives only (`lineTo`, `arc`, `fillRect`, `fillText`).

**Quick taint test** (run in browser DevTools after adding a new visual element):

```javascript
const c = document.querySelector('canvas');
try { c.toDataURL(); console.log('CLEAN'); }
catch(e) { console.error('TAINTED', e); }
```

---

## GPS Fix Fallback Rule

`GPS9Sample.fix` values may be 0 or 1 for all samples even in valid outdoor recordings (early-boot GPS, firmware behaviour, or recording starting before satellite lock). Do not treat `fix < 2` as an error.

The correct pattern anywhere GPS samples are filtered:

```typescript
const locked = gps.filter(s => s.fix >= 2);
const working = locked.length > 0 ? locked : gps; // fall back to all GPS
```

**Strava GPX points have no `fix` field.** They are always treated as locked:

```typescript
// Works for both GPS9Sample (fix required) and StravaGpsPoint (no fix field)
const locked = pts.filter(p => p.fix === undefined || p.fix >= 2);
```

Using `working` for path rendering prevents Null Island `[0, 0]` renders. Never sentinel-check for Null Island as a display-time fix — the fallback belongs at the data-preparation site.

---

## Vector Map Projection Formula

`projectLatLon()` in `TelemetryOverlay` maps geographic coordinates to canvas pixel coordinates using linear interpolation within a fixed bounding box:

```
x = bx + ((lon − minLon) / (maxLon − minLon)) × bw
y = by + ((maxLat − lat) / (maxLat − minLat)) × bh
```

Y is inverted because canvas Y grows downward while latitude grows upward. `maxLat` maps to the top of the box (`by`), `minLat` to the bottom (`by + bh`).

**Division-by-zero guard**: when `maxLat === minLat` or `maxLon === minLon`, return the centre of the bounding box. Never emit `Infinity` or `NaN` as a canvas coordinate — it silently corrupts the current path and all subsequent `lineTo` calls in the same frame.

The map bounding box in `drawVectorMap()` is fixed at `18% of canvas width`, positioned `16 px` from the top-right corner with a 5% inset. This scales correctly from the live display canvas (~700 px) to the 1920 px ghost export canvas without a separate layout branch.

---

## Strava GPX Integration

The map accepts two GPS data sources: GoPro `GPS9Sample[]` (from the GPMF parser) and Strava `StravaGpsPoint[]` (from a `.gpx` file upload). The `telemetrySource` input selects which array `drawVectorMap()` receives.

`StravaGpsPoint` is defined alongside `GPS9Sample` in `telemetry.model.ts`:

```typescript
export interface StravaGpsPoint {
  t: number;               // ms from video start (render-loop compatible with GPS9Sample.t)
  lat: number;
  lon: number;
  ele: number;             // metres
  hr: number;              // beats per minute (0 if sensor absent)
  cad: number;             // wrist-derived RPM (0 at stops — valid)
  speed: number;           // m/s, Haversine-derived at parse time
  relativeTimeSec: number; // seconds from video start (for debugging)
  absoluteUnixMs: number;  // wall-clock ms from GPX <time> element — survives re-anchoring
}
```

The `fix` field is absent. The GPS Fix Fallback Rule (`p.fix === undefined || p.fix >= 2`) handles this transparently.

`hr`, `cad`, and `speed` are used by `drawBiometrics()` and the speed substitution path — they are irrelevant to map rendering but share the same array to avoid separate lookup structures. See [strava-biometrics.md](strava-biometrics.md) for the full biometrics architecture.

---

## `absoluteUnixMs` Re-Anchoring

**Problem:** The user may upload the GPX before loading the GoPro MP4. When GPX is parsed first, `videoStartSec = 0` (no video loaded), so `.t` values become absolute Unix ms (~1.78 × 10¹² ms). When `renderTimeMs ≈ 20,000 ms`, the binary search ceiling always returns `lo = 0`, pinning the position dot to the first point regardless of playback position.

**Fix:** `StravaGpsPoint` stores `absoluteUnixMs` — the raw wall-clock timestamp from the GPX `<time>` element. After the GoPro video finishes parsing, `onFileSelected()` re-anchors all Strava points:

```typescript
// app.ts — inside onFileSelected(), after this.telemetry.set(result)
if (this.stravaGps().length > 0) {
  const videoStartMs = result.videoStartEpoch * 1000;
  this.stravaGps.update(pts => pts.map(p => ({
    ...p,
    t:               p.absoluteUnixMs - videoStartMs,
    relativeTimeSec: (p.absoluteUnixMs - videoStartMs) / 1000,
  })));
}
```

`absoluteUnixMs` is never recomputed — it is read from the GPX exactly once and preserved through every signal update. Both load orders (GPX-first, video-first) converge to correct `.t` values after re-anchoring.

---

## Temporal Clip Rule

`drawVectorMap()` clips the input array to the video's actual duration before building path geometry:

```typescript
const durationMs = (videoEl.duration ?? 0) * 1000;
const clipped = durationMs > 0
  ? base.filter(p => p.t >= 0 && p.t <= durationMs)
  : base;
```

**Why:** Strava GPX files commonly cover a full ride (1–3 hours) while the GoPro clip covers only a few minutes. Rendering the full route compresses the relevant section to a few screen pixels and clutters the HUD with the rider's journey to and from the filming location.

- Points with `t < 0` are before the video start (camera off, pre-roll).
- Points with `t > durationMs` are after the video end.
- Bounds (`minLat`, `maxLat`, `minLon`, `maxLon`) are computed from `clipped`, not `base`, so the projection fills the map box with only the in-video portion.
- The full `stravaGps` signal is never mutated — only the local `clipped` slice fed to the Path2D builder.

---

## Path2D Geometry Caching

Building a path by iterating over N GPS points is O(N) and must not run on every 60 Hz frame. `drawVectorMap()` caches a `Path2D` object and the computed bounds; the 60 Hz loop calls only `ctx.stroke(path2D)` — one native call with no array iteration.

**Cache structure:**

```typescript
private _path2DCache: {
  path2D:         Path2D;
  fullPath2D:     Path2D | null;   // ghost path (all base points) — null when !showMap
  clippedPoints:  Array<{ t: number; lat: number; lon: number; fix?: number }>;
  bounds:         { minLat: number; maxLat: number; minLon: number; maxLon: number };
  cacheKey:       { width: number; srcLen: number; srcT0: number; durationMs: number; mode: 'segment' | 'full'; zoom: number };
} | null = null;
```

**Cache key:** `{ width, srcLen, srcT0, durationMs, mode, zoom }` — invalidated by:
- `width` — canvas resize (live vs. 1920 px ghost export canvas)
- `srcLen` — new data loaded (different number of points)
- `srcT0` — re-anchored Strava points (first point's `.t` changed)
- `durationMs` — new video loaded (different clip duration changes the temporal clip)
- `mode` — switching between SEGMENT and FULL ROUTE changes the temporal clip
- `zoom` — named scope presets change the bounding box, which changes all projected pixel coordinates in the cached `Path2D`

**Build on cache miss:**

```typescript
const p2d = new Path2D();
p2d.moveTo(projectLatLon(clipped[0]));
for (let i = 1; i < clipped.length; i++) {
  p2d.lineTo(projectLatLon(clipped[i]));
}
this._path2DCache = { path2D: p2d, clippedPoints: clipped, bounds, cacheKey };
```

**Stroke in 60 Hz loop (no iteration):**

```typescript
ctx.stroke(path2D);  // one native call
```

The ghost export canvas uses `EXPORT_W = 1920` as width. Its different `width` from the live canvas forces a cache rebuild on the first export frame — this is correct; the export path2D uses 1920 px projection coordinates.

---

## Ghost Path (`fullPath2D`)

When `mapMode === 'full'`, `drawVectorMap()` builds a second `Path2D` — `fullPath2D` — that projects all `base` points (the full GPX ride) through the **same bounding box** as the segment path. This ghost path is stroked at reduced opacity before the segment path, giving the rider a visual reference of how the active clip fits within the full route.

**Construction:** `fullPath2D` is built immediately after the bbox expansion block (zoom sentinel logic), using the same `projectLatLon()` helper. Points that fall outside the bounding box still project to coordinates outside the canvas clip region and are naturally hidden — no explicit bounds check needed.

**Caching:** `fullPath2D` is stored alongside `path2D` in `_path2DCache` and rebuilt on the same cache miss conditions. It is `null` when the map is hidden (`showMap === false`) to avoid unnecessary work.

**Rendering order:** ghost path → segment path → position dot. The ghost is drawn at `ctx.globalAlpha ≈ 0.3` inside `ctx.save()/ctx.restore()`.

---

## Canvas Zoom — Dual Approach

`mapZoom` is a `WritableSignal<number>` that encodes two distinct zoom strategies via its value range. It is passed to `TelemetryOverlay` as `readonly mapZoom = input<number>(1)`.

### Zoom Slider

`mapZoom` is driven by a single continuous `<input type="range" min="-2" max="8" step="0.1">` in `app.html`. The `[min]` attribute is dynamic: `-2` in `full` map mode, `1` in `segment` mode — bbox presets are unreachable in segment scope.

A `zoomLabel` computed signal in `AppComponent` translates the float to a display string (FULL / MID / LOCAL / N×). The float itself passes directly into `drawVectorMap()`.

### `cacheZoom` — Decoupling the Cache Key from the Slider Float

**Never store the raw `zoom` float in the Path2D cache key.** The slider emits a new float on every `input` event (up to 60+ per second during drag). Storing it as-is causes a 100% cache miss rate and an O(N) `Path2D` rebuild on every frame during drag.

```typescript
const zoom      = this.mapZoom();
const cacheZoom = zoom <= 0 ? Math.round(zoom) : 1;
```

- `zoom ≤ 0` → named scope zone. `Math.round()` snaps the float to the nearest integer sentinel used by the bbox expansion block (`-2`, `-1`, `0`).
- `zoom > 0` → matrix zone. All values collapse to `cacheZoom = 1` — the bbox is identical for any positive zoom; only the `ctx.scale` matrix changes at render time, not the `Path2D` geometry.

The cache key field `zoom` always stores `cacheZoom`. Dragging the slider from 1.0 to 7.9 causes **zero cache misses**.

### Named Scope Presets (zoom ≤ 0) — Bounding Box Expansion

Values `-2`, `-1`, and `0` are sentinel integers that expand the geographic bounding box before Path2D coordinates are projected. This brings new geographic context into view — unlike `ctx.scale`, which only resizes what was already visible.

| Value | Label | Strategy |
|---|---|---|
| `-2` | FULL | Replace segment bbox with the entire ride's lat/lon extent (all `base` points) |
| `-1` | MID | Widen segment bbox by ×4 (pad each side by `1.5 × segment extent`) |
| `0` | LOCAL | Widen segment bbox by 50% (pad each side by `0.25 × segment extent`) |

**Why bbox expansion, not `ctx.scale`:** `ctx.scale(0.3)` compresses the already-projected path to 30% of its size — it does not reveal geographic data outside the original clip's extent. Named scope presets change the coordinate space at cache-build time, making the full ride's geography the projection reference. The ghost path (`fullPath2D`) projects all `base` points through this same expanded bbox, so distant road segments become visible within the map box.

**Critical:** Because bbox expansion changes all projected pixel coordinates, `zoom` (stored as `cacheZoom`) is part of the Path2D cache key. Switching scope triggers a one-time O(N) cache rebuild, not 60 Hz work.

Slider `[min]` is set to `1` in segment mode, preventing bbox presets. Switching back to SEGMENT resets zoom to 1 if the current value is < 1 (handled in `setMapMode()`).

### Numeric Zoom-In (zoom > 1) — Canvas Scale Transform

Continuous slider values above `1` zoom in around the current position dot using `ctx.translate/scale/translate`:

```typescript
const zoom = this.mapZoom();
ctx.save();
// Clip to map box — prevents zoomed route bleeding into the speed/G-force HUD
ctx.beginPath();
ctx.rect(width - mapW - 16, 16, mapW, mapH);
ctx.clip();

if (zoom > 1) {
  ctx.translate(dotX, dotY);   // move origin to dot position
  ctx.scale(zoom, zoom);       // scale around that origin
  ctx.translate(-dotX, -dotY); // shift route so dot stays at its natural pixel position
}

ctx.stroke(path2D);  // route zooms around the dot
ctx.restore();

// Dot drawn after restore — always at its projected, un-zoomed position
ctx.beginPath();
ctx.arc(dotX, dotY, DOT_RADIUS, 0, Math.PI * 2);
ctx.fill();
```

**Why draw the dot after `restore()`:** The dot must always sit at its correct projected pixel and at a fixed visual size. Inside the zoom transform, it would both move and scale up, producing a large off-centre circle.

**`lineWidth` at zoom:** `ctx.scale(zoom)` scales all coordinates including `lineWidth`. At `lineWidth = 2` and `zoom = 4`, the stroke visually appears 8 px wide — intentional, improves legibility.

**`ctx.clip()` is mandatory.** Without it, a zoomed route will extend outside the map box and overwrite the speed bar and G-force HUD elements.

---

## Street Name HUD — `drawStreetName()`

The street name overlay displays the current road name above the speed readout. It is driven by a `streetTimeline: StreetTimelineEntry[]` input (an array of `{ t: number; streetName: string }` objects sorted ascending by `t`) and a `showStreetName: boolean` input that gates rendering.

### Data Flow

```
POST /api/clips (GPS snapshots)
  → GeocodingService.resolveTimeline()   (Spring Boot, virtual threads, 3 s cap)
  → ClipMetadataDto.streetTimeline
  → AppComponent.streetTimeline signal
  → TelemetryOverlay [streetTimeline] input
  → drawStreetName() every 60 Hz frame
```

`SHOWCASE_STREET_TIMELINE` in `app.ts` is a hardcoded constant that bypasses the geocoding API for the public showcase clip, preserving API quota.

### `findStreetAtTime()` — O(log N) Floor Search

```typescript
private findStreetAtTime(timeMs: number): string | null {
  const timeline = this.streetTimeline();
  if (timeline.length === 0) return null;
  let lo = 0, hi = timeline.length - 1, result: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].t <= timeMs) { result = timeline[mid].streetName; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}
```

Returns the `streetName` of the **last entry whose `.t <= timeMs`** — the road the rider is currently on. Returns `null` before the first entry. This is a pure read with no allocations; safe to call on every 60 Hz frame.

### `showStreetName` Toggle

`AppComponent` owns `readonly showStreetName = signal<boolean>(true)`. The MAP control zone renders a STREET toggle before the PATH toggle. The signal is passed as `[showStreetName]="showStreetName()"` to the overlay. Both the live `drawFrame()` path and the export `onFrame` path guard `drawStreetName()` behind `if (this.showStreetName())`.

### Rendering — Layout Branches

`drawStreetName()` uses `ctx.save()` / `ctx.restore()` to isolate all font, fill, shadow, and alignment state. Two layout branches:

**`tiktok-cover`** — centered above the G-force box (at 80% height). Draws a `rgba(0,0,0,0.65)` pill behind the text for contrast against the solid color blocks.

**`spread` / `stacked` / `dashboard`** — positioned above the speed digit column. No background rectangle — the theme primary color with a matching glow (`shadowBlur: 10`) provides sufficient contrast against video content. The dark pill was removed to keep these layouts clean.

### Geocoding Density Rule

`SNAPSHOT_INTERVAL_MS = 15_000` (15 s) in `clip-api.service.ts`. At this interval a 75-second clip produces ~6 geocoding points, capturing street transitions within a 15-second window. **Do not raise this value above 30 000** — the previous value of `60 000` produced only 2 points for a 71-second clip, both often falling on the same street, causing the name to never change during playback.

Note: existing clips in the database were geocoded at the old interval. Re-uploading a clip triggers fresh geocoding at the current density.

---

## Double-Stroke Contrast Outline

The active route path uses a **double-stroke** technique to render a Google Maps-style high-contrast border. Each `Path2D` is stroked twice using the **same cached object** — no additional allocation.

**Stroke order (both segment and ghost paths):**

1. **Outline** — `rgba(0,0,0,0.8)`, `lineWidth = theme.map.strokeWidth + 4`, stroked first (underneath).
2. **Primary** — `theme.colors.primary`, `lineWidth = theme.map.strokeWidth`, stroked second (on top).

Each stroke is wrapped in its own `ctx.save()` / `ctx.restore()` pair so alpha and style resets are guaranteed:

```typescript
// Outline
ctx.save();
ctx.strokeStyle = 'rgba(0,0,0,0.8)';
ctx.lineWidth   = theme.map.strokeWidth + 4;
ctx.lineJoin    = 'round';
ctx.lineCap     = 'round';
ctx.stroke(path2D);
ctx.restore();

// Primary
ctx.save();
ctx.strokeStyle = theme.colors.primary;
ctx.lineWidth   = theme.map.strokeWidth;
ctx.lineJoin    = 'round';
ctx.lineCap     = 'round';
ctx.stroke(path2D);
ctx.restore();
```

**Ghost path** additionally sets `ctx.globalAlpha = 0.25` inside each of its two `save()`/`restore()` pairs.

**Maximum `save()` nesting depth inside `drawVectorMap()` is 2:** the outer clip/transform envelope, plus one stroke block at a time. The stroke blocks close before the clip envelope closes — they do not stack.

**Do not use `theme.colors.background`** — `ThemeConfig` has no `background` colour token. The outline is always the hardcoded `rgba(0,0,0,0.8)`, which provides sufficient contrast on any theme over any video content.
