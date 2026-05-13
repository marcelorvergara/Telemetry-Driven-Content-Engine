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
  clippedPoints:  Array<{ t: number; lat: number; lon: number; fix?: number }>;
  bounds:         { minLat: number; maxLat: number; minLon: number; maxLon: number };
  cacheKey:       { width: number; srcLen: number; srcT0: number; durationMs: number };
} | null = null;
```

**Cache key:** `{ width, srcLen, srcT0, durationMs }` — invalidated by:
- `width` — canvas resize (live vs. 1920 px ghost export canvas)
- `srcLen` — new data loaded (different number of points)
- `srcT0` — re-anchored Strava points (first point's `.t` changed)
- `durationMs` — new video loaded (different clip duration changes the temporal clip)

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

## Canvas Zoom via Transform

The ZOOM slider (`1×` to `8×`, step `0.5`) is exposed in `app.html` and bound to `mapZoom = signal<number>(1)`. It is passed to `TelemetryOverlay` as `readonly mapZoom = input<number>(1)`.

**Transform sequence:**

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

**Why draw the dot after `restore()`:** The dot is the current position indicator. It should always sit at its correct projected pixel and at a fixed visual size. If drawn inside the zoom transform, it would both move (because the route shifts around it) and scale up, producing a large off-centre circle.

**`lineWidth` at zoom:** `ctx.scale(zoom)` scales all coordinates including `lineWidth`. At `lineWidth = 2` and `zoom = 4`, the stroke visually appears 8 px wide. This is intentional — slightly thicker lines at high zoom improve legibility against the video background.

**`ctx.clip()` is mandatory.** Without it, a zoomed route at 8× will extend far outside the map box and overwrite the speed bar, G-force bar, and other HUD elements.
