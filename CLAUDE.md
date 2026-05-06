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

Use these terms consistently across code, comments, and conversation.

**FourCC** — A four-byte ASCII identifier that names every GPMF field (e.g. `DEVC`, `STRM`, `ACCL`). In Go, FourCCs are packed into a `uint32` big-endian for allocation-free comparison.

**KLV** — Key-Length-Value: the 8-byte header that precedes every GPMF field.
- Bytes 0–3: FourCC key
- Byte 4: type (`'s'` = int16, `'l'` = int32, `'f'` = float32, `'J'` = uint64, `0x00` = container)
- Byte 5: size — bytes per single element
- Bytes 6–7: repeat — number of elements (big-endian)

Data length in bytes = `size × repeat`. Data is always padded to the next 4-byte boundary before the next KLV begins.

**Container KLV** — A KLV with type `0x00`. Its `size × repeat` is the total byte length of its nested payload, not an element count. `DEVC` and `STRM` are containers.

**TelemetryAtom** — A single decoded, timestamp-tagged reading from one sensor. In Go: `GPS9Sample`, `ACCLSample`, `GRAVSample`. In Angular, consumed in the `requestAnimationFrame` loop keyed on `.t` (milliseconds from video start).

**SCAL** — An integer scale factor emitted by GoPro inside a `STRM` block. Raw integer sensor values must be divided by SCAL before use. When `SCAL.repeat == 1` it applies to every field; when `repeat == N` each field has its own divisor (GPS9 uses a 9-element SCAL array).

**STMP** — Sample timestamp in microseconds since stream start; appears at the head of each `STRM`. Currently skipped — timing is recovered from GPS UTC fields (GPS9) or synthesised from cumulative sample count (ACCL/GRAV).

**TSMP** — Total sample count for the stream to date. Currently skipped.

---

## Development Rules

### Binary parsing — manual BigEndian only

All reads from a GPMF byte slice must use `binary.BigEndian.Uint32`, `binary.BigEndian.Uint16`, or direct byte indexing. **Never** use `binary.Read` with a struct target: it requires reflection, which TinyGo does not support at full runtime scale and violates the 64 MB memory budget constraint.

```go
// correct
key := binary.BigEndian.Uint32(buf[pos:])
rep := binary.BigEndian.Uint16(buf[pos+6:])

// forbidden
binary.Read(r, binary.BigEndian, &myStruct)
```

### SCAL application — Option B (parser applies scaling)

The parser is responsible for dividing every raw integer by its SCAL factor and emitting `float64` values. Angular receives only decoded physical units (m/s², degrees, metres). Angular's Telemetry Math Service is responsible for derived quantities (tilt angle, G-force magnitude, heading smoothing) but never for raw-to-physical conversion.

### Parsing boundary

No business logic inside the Go parser. If it requires knowledge of video aesthetics, display state, or application features, it belongs in Angular.

### Unit Data Contract

Every layer in the pipeline must pass values in **base physical units** to its downstream consumer. Unit conversion for human readability is the exclusive responsibility of the Canvas presentation layer (`telemetry-overlay.ts`).

| Layer | Responsibility | Forbidden |
|---|---|---|
| Go-WASM parser | Emit post-SCAL floats: m/s, m/s², degrees, metres | Raw integer counts; pre-converted km/h or G |
| `TelemetryMathService` | Derive G-force magnitude (G units), lean angle (degrees), interpolated speed (m/s) | `× 3.6` km/h conversion; display rounding |
| `telemetry-overlay.ts` | `Math.round(speedMs * 3.6)` before `fillText`; `gForce.toFixed(2)` before `fillText` | Reading raw sensor integers; re-deriving physical values |

Violating this contract is silent at compile time. A value that looks plausible in isolation (e.g. `2.0`) can mean m/s or km/h depending on which layer produced it; the discrepancy only surfaces visually as an order-of-magnitude display error (e.g. showing "2 KM/H" instead of "7 KM/H").

### Sensor scope (MVP)

| Sensor | Tag | Status |
|---|---|---|
| GPS (Hero 11+) | `GPS9` | In scope — primary |
| GPS (Hero 10 and older) | `GPS5` | In scope — fallback when no GPS9 seen |
| Accelerometer | `ACCL` | In scope — Slam Detector |
| Gravity vector | `GRAV` | In scope — Slam Detector |
| Camera/image orientation | `CORI`/`IORI` | Out of scope for MVP |

### Error codes

`ErrSuccess=0`, `ErrMalformedGPMF=1`, `ErrMemLimit=2`, `ErrNoSupportedStream=3`. No silent truncations — every malformed-length condition returns `ErrMalformedGPMF` immediately.

### Timestamps

- **GPS9**: use the embedded GPS UTC fields (days since Jan 1 2000 + seconds of day). Anchor: `GPS2000Epoch = 946684800`.
- **ACCL / GRAV**: synthesise from `cumulative_sample_index / nominal_rate_Hz × 1000` ms. This is wrong after a recording pause/resume gap — fix deferred until Angular can send per-DEVC chunk timestamps from the MP4 `stts` box.
- All `.t` values are milliseconds from video start, matching `HTMLVideoElement.currentTime × 1000`.

### WASM exports (TinyGo `//export`)

```
allocBuffer(size uint32) uint32        // returns linear-memory pointer to input buffer
parseGPMF(length, videoStartSec uint32) uint32  // returns ErrXxx code
getResultPtr() uint32
getResultLen() uint32
```

JS writes the MET binary into the pointer returned by `allocBuffer`, calls `parseGPMF`, then reads JSON from `getResultPtr/Len` on success.

---

## Lessons Learned — Sprint 1

Patterns discovered during implementation that are not obvious from the spec alone. These extend the Development Rules above with the *why* behind each constraint.

### Stride Alignment Rule

After reading `size × repeat` data bytes for a KLV field, advance the cursor to the **next 4-byte boundary** before reading the next KLV. GPMF pads every field's data; skipping this silently misaligns every subsequent read.

```go
// correct
dataLen := int(size) * int(repeat)
padded  := (dataLen + 3) &^ 3
pos     += 8 + padded   // 8-byte header + padded data

// wrong — all reads after the first field are from the wrong offset
pos += 8 + dataLen
```

Symptom when violated: the second `STRM` block's FourCC decodes as garbage bytes. The parser either returns `ErrMalformedGPMF` or — worse — silently interprets a data byte as a type byte and produces numerically plausible but wrong output.

### Timestamp Precision Rule

All `.t` values emitted to Angular **must be milliseconds from video start**, matching `HTMLVideoElement.currentTime × 1000`. A unit mismatch is silent at compile time but causes the rAF interpolator to clip every sample to the first or last atom in the array.

- GPS9 UTC → subtract `videoStartSec * 1000` after converting the GPS 2000-epoch to Unix ms.
- ACCL / GRAV synthetic → `(cumulative_index / rate_hz) * 1000`.
- Never emit seconds, microseconds, or raw GPS 2000-epoch values to Angular.

**Sprint 1 discovery**: The G-force bar was glitching because `calculateGForceMagnitude` returned the m/s² deviation from 1 G (correct math, wrong unit), but the overlay threshold constants (`SPIKE_THRESHOLD = 1.5`, etc.) expected G units. The fix was a single `/ G` in `TelemetryMathService`. Same class of error as a timestamp unit mismatch — correct in isolation, silent and catastrophic at the consumer.

### 64 MB WASM Budget — Hard Ceiling

The Go-WASM module shares the browser's main-thread JS heap alongside the 4K video decoder. 64 MB is not aspirational; exceeding it causes Chrome to OOM-kill the tab mid-export.

Back-of-envelope: a 60-minute ride at 200 Hz ACCL = 720 000 samples × ~48 bytes ≈ 34 MB. That leaves ~30 MB for GPS9 + GRAV + the JSON serialisation scratch buffer — tight. Pre-allocate slices at parser startup with known upper bounds; never `append` inside an unbounded STRM loop.

### Option B is the Source of Truth for Units

The parser owns the SCAL divide. Angular owns derived math. If a number looks wrong in the frontend, check this boundary first:

1. Is the Go parser emitting post-SCAL floats? (`lat / scal[0]`, not `lat`)
2. Is the Angular service treating the value as already-physical? (it must)

Mixing these in either direction produced the G-force unit bug in Sprint 1. The rule is enforced by the "Option B checkpoint" in `skill.md`.

---

## Backend Architecture (Sprint 4)

Rules governing the Spring Boot 3 + PostgreSQL persistence layer. These constraints apply to every feature that touches the API or Angular's network calls.

### Data Boundary Rule

The Angular frontend is **strictly forbidden** from sending full telemetry arrays to PostgreSQL. The 200 Hz ACCL, GPS9, and GRAV sample arrays are heavy by design — a 60-minute ride at 200 Hz ACCL produces ~720 000 rows. They live permanently in the browser's IndexedDB **Vault**.

PostgreSQL is the **Library Catalog**: it stores only the `ClipMetadata` summary (max speed, total distance, start/end GPS, highlights array of up to 5 peak timestamps). If a proposed backend field requires iterating over raw samples to compute, it belongs in Angular's `TelemetryMathService`, not in a new database column.

### Identity Rule

This is a single-user MVP. There is no authentication, no user ID, and no multi-tenant isolation. The composite key `(filename, fileSize)` is the sole identity for a clip. Do not introduce a `userId` column, a `deviceId`, or any other ownership concept until multi-user requirements are explicit.

The upsert in `ClipMetadataService` relies on this uniqueness: `findByFilenameAndFileSize` before save. Adding a third dimension to the key without updating the upsert path will silently create duplicates.

### Highlight Array Rule

The `highlights` field stores up to 5 peak G-force event timestamps as a native PostgreSQL `bigint[]` column. No join table, no separate `Highlight` entity, no JSON serialisation. Hibernate 6.4 (Spring Boot 3.3+) maps `Long[]` to `bigint[]` natively with `@Column(columnDefinition = "bigint[]")`.

If the number of highlights per clip needs to grow beyond ~20 elements, reconsider this approach — array columns are not individually indexable. For MVP scope, the native array is strictly simpler than a join table.

---

## Theme Engine Architecture (Sprint 5)

Rules governing the Angular-side theme strategy pattern. These constraints apply to every feature that touches visual presentation, Canvas rendering, or theme-aware math.

### ThemeConfig Strategy Pattern

`ThemeConfig` is the strategy contract. Every visual decision the Canvas renderer makes is derived from the active `ThemeConfig` — never from hardcoded hex values, font strings, or layout constants outside of theme presets.

```typescript
interface ThemeConfig {
  id: string;
  colors: { primary, secondary, accent, text, success, warning, danger };
  font:   { primary, secondary };
  layout: 'spread' | 'stacked' | 'dashboard' | 'tiktok-cover';
  speedUpdateIntervalMs: number;   // 0 = instantaneous; >0 = throttled update
  gForceBehavior: 'instant' | 'max-hold';
}
```

Three concrete presets live in `theme.model.ts`: `VERGARA_YOUTUBE` (cyan/magenta, spread, instant), `CLEAN_SPORT` (white/orange, stacked, 250 ms throttle), `VERGARA_TIKTOK` (blue/red, tiktok-cover, max-hold).

**Add a new preset by adding a new `ThemeConfig` literal to `ALL_THEMES` in `theme.model.ts`.** Do not introduce new fields to `ThemeConfig` for single-preset customisation — use the existing `colors` / `layout` / `speedUpdateIntervalMs` properties.

### ThemeService Signal Rule

`ThemeService` holds a single `signal<ThemeConfig>` (`currentTheme`). It is the sole source of truth for active theme state.

The Canvas rAF loop reads `this.themeService.currentTheme()` as a **synchronous call inside `ngZone.runOutsideAngular`**. No subscription, no `effect()`, no change-detection side effect. This is intentional — Angular's change-detection must not fire on every 60 Hz frame.

Do not switch this to an Observable or an `effect()`. The synchronous read inside the rAF callback is the correct pattern.

### Decoupled Math Rule

`TelemetryMathService` owns all stateful behavioral wrappers. The rAF loop passes `nowMs = performance.now()` into `getDisplaySpeed` and `getDisplayGForce`; the service owns the interval/hold logic internally.

| Method | Behavior when theme changes |
|---|---|
| `getDisplaySpeed(gps, targetMs, nowMs)` | Reads `speedUpdateIntervalMs` from `currentTheme()` per call. Change is instantaneous — next frame uses the new interval. |
| `getDisplayGForce(accl, nowMs)` | Reads `gForceBehavior` from `currentTheme()` per call. Switching from `max-hold` to `instant` mid-ride snaps to the instantaneous value on the next frame. |

**The caller must own the clock**: `nowMs` must be `performance.now()` captured once per rAF tick and passed to both methods. Never call `performance.now()` inside the service — doing so makes the service untestable and hides the time source from the caller.

### Canvas Layout Rule

`resolveLayout(layout, width, height)` returns a `LayoutAnchors` struct (`{ speedX, gfBarX, gfBarY }`) computed once per frame. Both `drawSpeedReadout` and `drawGForceBar` consume the same struct — no drawing code duplicates coordinate arithmetic.

`drawSpeedReadout` and `drawGForceBar` use **early-return branching** on `theme.layout`. Each layout variant is a fully isolated code path:

| Layout | Visual style | Code path |
|---|---|---|
| `spread` | Glow text, bloom shadows, chromatic-aberration glitch at high G | Default (fallthrough) |
| `stacked` | Same glow style; both elements left-aligned at 75% height | Default (fallthrough) |
| `tiktok-cover` | Solid `fillRect` geometry, no `shadowBlur`, flat opaque colour blocks + three-colour branding stripe | Early-return branch |

**The `tiktok-cover` constraint**: this layout never sets `shadowBlur > 0`. Any modification that introduces bloom or glow into the `tiktok-cover` branch violates the flat-aesthetic contract. The three-colour branding stripe (secondary / success / warning) is drawn in `drawSpeedReadout` because it spans the combined block height of both boxes — do not move it to `drawGForceBar`.

**Context-leak guard**: every layout branch must end with `ctx.shadowBlur = 0` before returning. Canvas context state is persistent across frames; failing to reset it produces cumulative visual corruption that is invisible in single-frame screenshots but compounds over time.

---

## Hardware Realities & Sensor Deadzones

GoPro sensors are consumer-grade MEMS hardware. Even at standstill they produce non-zero readings. The thresholds below were established empirically in this recording environment and are enforced inside `TelemetryMathService`. **Do not remove or lower them** — they silence hardware noise, not real events.

### MEMS Accelerometer Drift

The ACCL sensor has thermal noise and micro-vibration pickup that produces a constant G-force deviation from the 1G baseline even when the camera is physically stationary. Readings below **0.25 G** are indistinguishable from sensor noise in this environment.

```typescript
// calculateGForceMagnitude — telemetry-math.ts
const g = Math.abs(magnitude - G) / G;
return g < 0.25 ? 0 : g;   // ← never lower this threshold
```

### GPS Multipath Drift

Stationary GPS receivers report non-zero speed because satellite signals reflect off buildings and terrain (multipath interference). In this environment, multipath drift peaks at approximately 7 km/h. The speed floor is set at **8.0 km/h (≈ 2.22 m/s)** to absorb the full drift envelope.

```typescript
// telemetry-math.ts module constant
const SPEED_FLOOR_MS = 8.0 / 3.6;   // ← never lower this threshold
```

This constant is applied at **all four return paths** in `interpolateSpeed` (single sample, past-end clamp, zero-dt guard, and the interpolated result). Any refactor that adds a new return path must apply the same floor.

### Why These Are Not Tunable Per-Theme

The noise floors are hardware facts, not display preferences. They belong in `TelemetryMathService` as module-level constants, not in `ThemeConfig`. A theme change must never affect whether a ghost reading is suppressed.
