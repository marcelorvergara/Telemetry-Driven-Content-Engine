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
- All `.t` values: **milliseconds from video start** (`currentTime × 1000`). Never emit seconds, µs, or raw GPS epoch.

### Sensor Scope (MVP)

| Sensor | Tag | Status |
|---|---|---|
| GPS (Hero 11+) | `GPS9` | In scope — primary |
| GPS (Hero 10 and older) | `GPS5` | In scope — fallback when no GPS9 |
| Accelerometer | `ACCL` | In scope — Slam Detector |
| Gravity vector | `GRAV` | In scope — Slam Detector |
| Camera/image orientation | `CORI`/`IORI` | Out of scope for MVP |

### Error Codes
`ErrSuccess=0`, `ErrMalformedGPMF=1`, `ErrMemLimit=2`, `ErrNoSupportedStream=3`. No silent truncations — every malformed-length condition returns `ErrMalformedGPMF` immediately.

### WASM API
```
allocBuffer(size uint32) uint32
parseGPMF(length, videoStartSec uint32) uint32
getResultPtr() uint32
getResultLen() uint32
```

### Canvas Rendering — Ghost Vector Map Rule

**DOM-based map libraries (Leaflet, Mapbox, Google Maps) are permanently forbidden** in this project.

- All spatial routing must be rendered via native Canvas 2D primitives (`ctx.lineTo`, `ctx.arc`, `ctx.fillRect`) by projecting lat/lon into pixel space mathematically. See [Map Feature](Docs/architecture/map-feature.md) for the projection formula.
- `MediaRecorder` captures frames from `canvas.captureStream()` — DOM elements are invisible to it. Getting a DOM map into the WebM export would require `ctx.drawImage()` with tile images. This marks the canvas **origin-dirty**, causing `captureStream()` to emit opaque-black frames with no thrown exception.
- The Canvas vector path is the single implementation for both the live HUD and the WebM export. No dual-layer, no synchronisation overhead, no tile cache competing against the 64 MB JS heap.

### Sensor Noise Floors — Do Not Lower
- **ACCL deadzone**: readings < **0.25 G** are indistinguishable from MEMS noise. Set in `calculateGForceMagnitude`.
- **GPS speed floor**: `SPEED_FLOOR_MS = 8.0 / 3.6` (~2.22 m/s). Applied at all 4 return paths in `interpolateSpeed`.
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
| Map feature — Leaflet + Canvas vector (Sprint 6) | [Docs/architecture/map-feature.md](Docs/architecture/map-feature.md) |
| Sensor noise floors — hardware realities | [Docs/architecture/sensor-deadzones.md](Docs/architecture/sensor-deadzones.md) |

---

## Skills Library

Reusable diagnostic patterns and pre-decision grilling prompts → [skill.md](skill.md)
