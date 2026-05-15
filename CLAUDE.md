# Telemetry-Driven Content Engine

## Stack

| Layer | Technology |
|---|---|
| Frontend | Angular + Canvas API |
| Binary parsing | Go compiled to WASM via TinyGo |
| Derived telemetry math | Angular — Telemetry Math Service |
| Persistence | Spring Boot 3 + JPA + PostgreSQL |

The Go-WASM module receives a pre-extracted, pre-concatenated flat `Uint8Array` of the MP4 MET track from Angular. It never sees the full MP4 file.

Only summarised session metadata (start/end GPS, max speed, total distance) is sent to the backend. Full telemetry arrays stay in browser IndexedDB.

---

## Ubiquitous Language

**FourCC** — Four-byte ASCII field identifier (e.g. `DEVC`, `STRM`, `ACCL`). Packed into `uint32` big-endian in Go for allocation-free comparison.

**KLV** — 8-byte header: bytes 0–3 FourCC, byte 4 type, byte 5 size, bytes 6–7 repeat (big-endian). Data length = `size × repeat`, always padded to the next 4-byte boundary.

**Container KLV** — Type `0x00`; `size × repeat` is total nested payload byte length. `DEVC` and `STRM` are containers.

**TelemetryAtom** — Single decoded, timestamp-tagged sensor reading. In Go: `GPS9Sample`, `ACCLSample`, `GRAVSample`. Consumed in rAF loop keyed on `.t` (milliseconds from video start).

**SCAL** — Integer scale factor inside a `STRM` block. Raw integers ÷ SCAL = physical units. GPS9 uses a 9-element SCAL array (one divisor per field).

**STMP** — Sample timestamp in µs since stream start. Currently skipped — timing recovered from GPS UTC (GPS9) or synthesised from sample count (ACCL/GRAV).

**TSMP** — Total sample count for the stream. Currently skipped.

---

## Development Rules

### Binary Parsing
- Use `binary.BigEndian.Uint32`, `binary.BigEndian.Uint16`, or direct byte indexing only.
- **Never** use `binary.Read` with a struct target — requires reflection, unsupported in TinyGo.
- After every KLV field: `pos += 8 + (dataLen+3)&^3` (4-byte boundary pad — never skip).
- See [GPMF Parser](Docs/architecture/gpmf-parser.md) for stride alignment detail and Sprint 1 lessons.

### Unit Data Contract
Every layer passes **base physical units** downstream. Human-readable conversion belongs exclusively in `telemetry-overlay.ts`.

| Layer | Outputs | Forbidden |
|---|---|---|
| Go-WASM parser | Post-SCAL floats: m/s, m/s², degrees, metres | Raw integers; pre-converted km/h or G |
| `TelemetryMathService` | G-force (G), lean angle (degrees), speed (m/s) | `× 3.6` km/h; `toFixed()` rounding |
| `telemetry-overlay.ts` | `speedMs * 3.6` → `fillText`; `gForce.toFixed(2)` → `fillText` | Raw sensor reads; re-derived physics |

Violating this contract is silent at compile time — the discrepancy surfaces only as an order-of-magnitude display error.

### Parser Boundary
No business logic inside the Go parser. Display, aesthetic, or application concerns belong in Angular.

### SCAL — Option B
The parser owns the SCAL divide and emits physical units. Angular receives only decoded values. Never divide by SCAL in Angular.

### Timestamps
- **GPS9**: GPS UTC fields, anchor `GPS2000Epoch = 946684800`. Subtract `videoStartSec * 1000`.
- **ACCL / GRAV**: `(cumulative_index / rate_hz) * 1000` ms (wrong after pause/resume gaps — deferred fix).
- **Strava GPX**: `absoluteUnixMs = new Date(timeStr).getTime()`. Compute `.t = absoluteUnixMs - videoStartEpoch * 1000`. Store `absoluteUnixMs` on `StravaGpsPoint` — the user may upload the GPX before loading the GoPro clip. Re-anchor in `onFileSelected()` after the video parse completes. Never recompute `absoluteUnixMs`.
- All `.t` values: **milliseconds from video start** (`currentTime × 1000`). Never emit seconds, µs, or raw GPS epoch.

### Sensor Scope (MVP)

| Sensor | Tag / Source | Status |
|---|---|---|
| GPS (Hero 11+) | `GPS9` | In scope — primary GoPro GPS |
| GPS (Hero 10 and older) | `GPS5` | In scope — fallback when no GPS9 |
| Accelerometer | `ACCL` | In scope — Slam Detector |
| Gravity vector | `GRAV` | In scope — Slam Detector |
| Heart rate | Strava GPX `gpxtpx:hr` | In scope — displayed on HUD when GPX loaded |
| Cadence (wrist) | Strava GPX `gpxtpx:cad` | In scope — 0 at stops is valid hardware behaviour |
| Elevation | Strava GPX `<ele>` | In scope — metres, displayed on HUD when GPX loaded |
| Camera/image orientation | `CORI`/`IORI` | Out of scope for MVP |

**Strava cadence note:** The Amazfit TRex 3 derives cadence from wrist accelerometer, not a crank sensor. Zero-cadence readings at stops (~2.3% of records observed) are legitimate — do not treat them as sensor errors.

### Strava Biometrics — Speed Substitution

When `telemetrySource === 'Strava'` **and** `stravaGps.length > 0`:
- Speed displayed on the HUD is `interpolateBiometrics().speed` clamped to `SPEED_FLOOR_MS`.
- The GoPro GPS9 `speed2d` field is **not used** for the speed readout.
- Switching back to `'GoPro'` source reverts to GPS9 speed immediately.

When `telemetrySource === 'GoPro'` or no GPX file is loaded:
- Speed is sourced exclusively from `interpolateSpeed(telemetry.gps, timeMs)` (GPS9 path).

**G-force bar is always rendered** regardless of `telemetrySource`. The ACCL stream is a GoPro-only sensor; a Strava GPX file never carries accelerometer data. Never suppress `drawGForceBar()` based on source selection.

`SPEED_FLOOR_MS = 8.0 / 3.6` applies to **both** GoPro GPS9 and Strava Haversine-derived speed. The floor is a hardware noise floor, not a GoPro-specific one.

### Strava Biometrics — HR Training Zones

`hrColor(hr, theme)` maps heart rate to theme colours:

| Zone | BPM range | Color source |
|---|---|---|
| Recovery | < 100 | `theme.colors.success` |
| Aerobic | 100 – 139 | `theme.colors.primary` |
| Threshold | 140 – 159 | `theme.colors.warning` |
| Anaerobic | ≥ 160 | `theme.colors.danger` |

These zone boundaries are fixed. Do not adjust them per-theme.

### Strava Biometrics — `drawBiometrics()` Layout Contract

`drawBiometrics()` has one branch per layout, exactly mirroring `drawSpeedReadout()` and `drawGForceBar()`:

| Layout | Visual style |
|---|---|
| `spread` | Top-left glowing panel, right-aligned value columns, icon + value + dimmed unit |
| `stacked` | Bottom-right clean panel, accent icons, no glow, thin separator line |
| `tiktok-cover` | Three solid blocks (ELE / CAD / HR) above the speed box; colored left stripe matches branding stripe |

Any new layout variant **must** add a branch to `drawBiometrics()` — see Skill 11.

### Error Codes
`ErrSuccess=0`, `ErrMalformedGPMF=1`, `ErrMemLimit=2`, `ErrNoSupportedStream=3`. No silent truncations — every malformed-length condition returns `ErrMalformedGPMF` immediately.

### WASM API
```
allocBuffer(size uint32) uint32
parseGPMF(length, videoStartSec uint32) uint32
getResultPtr() uint32
getResultLen() uint32
```

### Showcase Auto-Load — Split-Asset Strategy

The public showcase at `vergaraverse.web.app` auto-loads a GoPro clip + Strava GPX on page open without user interaction. Three static assets are served from `angular/src/assets/`:

| Asset | Purpose |
|---|---|
| `tiny_showcase.mp4` | Compressed video for the `<video>` player only — **no telemetry track** |
| `telemetry_sample.bin` | Raw GPMF binary extracted from the original clip (pre-demux) |
| `strava 10052026.gpx` | Full-ride Strava GPX (not trimmed to clip length) |

**Why split?** FFmpeg re-encodes the container when producing a compressed MP4, which drops the proprietary GoPro `gpmd` track tag. The `Mp4DemuxerService` searches for this tag by FourCC; when it is absent, demuxing returns zero bytes and the WASM parse produces no data. Separating the video from the telemetry binary sidesteps this entirely.

**Demuxer bypass**: `loadDefaultAssets()` skips `Mp4DemuxerService`. It fetches `telemetry_sample.bin` as `ArrayBuffer`, converts it to `Uint8Array`, and passes it directly to `GpmfParserService.parse(metBytes, SHOWCASE_VIDEO_START_SEC)`.

**`SHOWCASE_VIDEO_START_SEC`**: Unix epoch seconds of the showcase clip's first frame. Derivation:
1. Load the **original** GoPro MP4 in the app (the full, uncompressed file).
2. Read `videoStartSec` from the demuxer console output: `[DEMUXER] … videoStartSec=NNNN`.
3. Add the clip's start-offset in seconds (e.g. `+ 60` if `tiny_showcase.mp4` starts at 1:00 of the original).
4. Update the constant in `app.ts`. Current value: `1778407717` (GX011209.MP4 start `1778407657` + 60 s).

**Load order constraint**: `processGpxFile()` must be called **after** `this.telemetry.set(result)`. It reads `this.telemetry()?.videoStartEpoch` to anchor Strava `.t` values. Calling it before the parser runs leaves `videoStartEpoch = 0`, making all Strava timestamps absolute Unix ms (~1.7 T ms) and breaking every biometric interpolation.

**`isProcessing` management**: `loadDefaultAssets()` manages the signal manually (set true at entry, false in `finally`). `processFile()` is not called — do not add a second `isProcessing` toggle inside `processGpxFile()` when called from the auto-load path.

### Canvas Rendering — Ghost Vector Map Rule

**DOM-based map libraries (Leaflet, Mapbox, Google Maps) are permanently forbidden** in this project.

- All spatial routing must be rendered via native Canvas 2D primitives (`ctx.lineTo`, `ctx.arc`, `ctx.fillRect`) by projecting lat/lon into pixel space mathematically. See [Map Feature](Docs/architecture/map-feature.md) for the projection formula.
- `MediaRecorder` captures frames from `canvas.captureStream()` — DOM elements are invisible to it. Getting a DOM map into the WebM export would require `ctx.drawImage()` with tile images. This marks the canvas **origin-dirty**, causing `captureStream()` to emit opaque-black frames with no thrown exception.
- The Canvas vector path is the single implementation for both the live HUD and the WebM export. No dual-layer, no synchronisation overhead, no tile cache competing against the 64 MB JS heap.

### Canvas Rendering — globalAlpha Leak Guard

**Any draw call that mutates `ctx.globalAlpha` must be wrapped in `ctx.save()` / `ctx.restore()`.**

- A leaked alpha silently dims the entire 60 Hz HUD with no thrown error and no console warning — it is invisible until someone screenshots the overlay.
- `ctx.restore()` is the only reliable reset. An explicit `ctx.globalAlpha = 1.0` after the draw is an acceptable fallback only if no other state (transform, clip, composite) was modified.
- This rule applies to the map background block in `drawVectorMap` and to every future Canvas primitive that needs transparency.

### ThemeConfig.map — Aesthetics Sub-object

`ThemeConfig` carries a `map` sub-object that owns all map background aesthetics:

```typescript
map: { backgroundAlpha: number; strokeWidth: number; showGrid: boolean; }
```

- `backgroundAlpha` is the sole input to `ctx.globalAlpha` in `drawVectorMap`. It is the only legal place to control map transparency.
- **`ctx.fillStyle` for the map background reads `theme.colors.secondary`.** This is a known shared dependency: `colors.secondary` is also consumed by the G-force bar outline and peak-marker stroke in `drawGForceBar`. Changing `colors.secondary` in any preset will affect both. Future fix: add `color: string` to the `map` sub-object and update the single `ctx.fillStyle` assignment in `drawVectorMap`.
- **Optical-mix trap**: a light hex colour (e.g. `#FFFFFF`) at `backgroundAlpha < 0.5` over dark video pixels optically mixes to muddy gray. `CLEAN_SPORT` sets `backgroundAlpha: 0.85` as its floor for exactly this reason. Never lower a light-coloured preset below `0.7`.
- The `ThemeService.updateMapAlpha(alpha: number)` method patches the active signal without overwriting `strokeWidth` or `showGrid`. Use it — do not call `setTheme()` with a reconstructed object just to change alpha.

### Sensor Noise Floors — Do Not Lower
- **ACCL deadzone**: readings < **0.25 G** are indistinguishable from MEMS noise. Set in `calculateGForceMagnitude`.
- **GPS speed floor**: `SPEED_FLOOR_MS = 8.0 / 3.6` (~2.22 m/s). Applied at all 4 return paths in `interpolateSpeed` **and** to Strava Haversine-derived speed in `drawFrame()`.
- These are hardware facts, not display preferences. A theme change must never affect whether a ghost reading is suppressed.
- See [Sensor Deadzones](Docs/architecture/sensor-deadzones.md) for empirical rationale.

---

## Subsystem Architecture

Detailed rules, rationale, and constraints for each subsystem live in dedicated docs. Read the relevant file before touching that subsystem.

| Subsystem | Rules document |
|---|---|
| GPMF parser + WASM (Sprint 1) | [Docs/architecture/gpmf-parser.md](Docs/architecture/gpmf-parser.md) |
| Backend — Spring Boot + PostgreSQL (Sprint 4) | [Docs/architecture/backend.md](Docs/architecture/backend.md) |
| Theme engine — Canvas strategy (Sprint 5) | [Docs/architecture/theme-engine.md](Docs/architecture/theme-engine.md) |
| Map feature — Canvas vector, Strava GPX, Path2D cache, zoom (Sprint 6+) | [Docs/architecture/map-feature.md](Docs/architecture/map-feature.md) |
| Strava biometrics — HR/CAD/ELE HUD, speed substitution, zone colours | [Docs/architecture/strava-biometrics.md](Docs/architecture/strava-biometrics.md) |
| Sensor noise floors — hardware realities | [Docs/architecture/sensor-deadzones.md](Docs/architecture/sensor-deadzones.md) |

---

## Skills Library

Reusable diagnostic patterns and pre-decision grilling prompts → [skill.md](skill.md)
