# Map Feature Architecture — Sprint 6

## Ghost Vector Map Rule

The native Canvas vector map (`drawVectorMap()` in `telemetry-overlay.ts`) is the **sole map implementation** for this project. It handles both the live HUD and the WebM export from one code path.

**DOM-based map libraries are permanently decommissioned.** The reasons are structural, not aesthetic:

| Concern | DOM map (Leaflet / Mapbox) | Ghost Vector Map |
|---|---|---|
| WebM export | Requires `ctx.drawImage()` with tiles → CORS canvas taint → black frames | Native `ctx.lineTo()` — no external fetch, no taint |
| JS heap | Tile cache + library runtime competes with the 64 MB WASM budget | Zero allocation beyond the GPS array already in memory |
| Render path | Two separate systems (DOM + Canvas) must be kept in sync | Single Canvas draw call, same frame, same clock |
| Aesthetic | Tile style is fixed by the provider | Full control via `ThemeConfig` colours and stroke width |

**Any future spatial feature must extend `drawVectorMap()`**, not introduce a new DOM-based library.

---

Rules governing the dual-layer map system: a Leaflet DOM overlay for interactive live viewing and a Canvas vector renderer for export-safe WebM recording.

---

## Dual-Layer Rule

There are two completely separate map implementations. They must never be merged.

| Layer | Component | Purpose | Tile images |
|---|---|---|---|
| Leaflet DOM | `MapOverlayComponent` | Interactive map, live view only, positioned over the `<video>` element | Yes — CartoDB Positron tiles |
| Canvas vector | `drawVectorMap()` in `TelemetryOverlay` | Export-safe geometric path drawn into the HUD canvas | Never |

- `MapOverlayComponent` must never be imported into `telemetry-overlay.ts`.
- `telemetry-overlay.ts` must never import Leaflet.
- The Canvas vector renderer must never call `ctx.drawImage()` with an externally fetched image.

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

Using `working` for path rendering prevents Null Island `[0, 0]` renders.

**Never sentinel-check for Null Island as a display-time fix.** The fallback belongs at the data-preparation site (`setup()` in `MapOverlayComponent`, `drawVectorMap()` in `TelemetryOverlay`), not in the draw call.

---

## MapOverlay Lifecycle Rule

`MapOverlay` uses a `setup()` / `teardown()` split so that re-initialization on new video data follows the same code path as first initialization.

```
ngAfterViewInit → setup()
ngOnChanges (non-first, gps.length > 0, map !== null) → teardown() + setup()
ngOnDestroy → teardown()
```

`teardown()` must call `cancelAnimationFrame(this.rafId)` **before** `this.map.remove()`. Reversing this order allows a rAF tick to fire against a removed Leaflet instance, producing a timing-dependent `Cannot read properties of null` error.

The `ngOnChanges` guard has three conditions that must all be true:
1. `!changes['gps'].firstChange` — `ngAfterViewInit` owns first init; avoid double-init.
2. `this.gps.length > 0` — ignore the transient empty array that `telemetry.set(null)` emits between video loads.
3. `this.map !== null` — `ngOnChanges` fires before `ngAfterViewInit`; skip if Leaflet is not yet initialized.

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

## Tile Provider and Flash Colour Rule

The Leaflet `MapOverlay` uses **CartoDB Positron** (`light_all`) tiles. The `::ng-deep .leaflet-container` background colour in `map-overlay.scss` must match Positron's base tile colour (`#f2f0eb`) so the map is visually seamless before tiles load. A mismatched background produces a colour flash that is not fixable in JavaScript — CSS-only fix.

If the tile provider changes, update the `background` value to match.

**Colour constants are independent — do not unify:**
- Leaflet polyline: `#0066cc` (blue) — visible against Positron's light-grey base.
- Canvas vector path: `#00FFFF` (cyan) — visible against the dark HUD canvas.
- Cyan on Positron and blue on the HUD canvas are both invisible. Keep them separate.
