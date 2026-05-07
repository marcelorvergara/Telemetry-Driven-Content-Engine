# GPMF Parser Architecture — Sprint 1

Detailed rationale and constraints for the Go-WASM binary parser. Rules summary is in `CLAUDE.md`.

---

## Stride Alignment Rule

After reading `size × repeat` data bytes for a KLV field, advance the cursor to the **next 4-byte boundary** before reading the next KLV. GPMF pads every field's data; skipping this silently misaligns every subsequent read.

```go
// correct
dataLen := int(size) * int(repeat)
padded  := (dataLen + 3) &^ 3
pos     += 8 + padded   // 8-byte header + padded data

// wrong — all reads after the first field are from the wrong offset
pos += 8 + dataLen
```

**Symptom when violated**: the second `STRM` block's FourCC decodes as garbage bytes. The parser either returns `ErrMalformedGPMF` or — worse — silently interprets a data byte as a type byte and produces numerically plausible but wrong output.

---

## Timestamp Precision Rule

All `.t` values emitted to Angular **must be milliseconds from video start**, matching `HTMLVideoElement.currentTime × 1000`. A unit mismatch is silent at compile time but causes the rAF interpolator to clip every sample to the first or last atom in the array.

- GPS9 UTC → subtract `videoStartSec * 1000` after converting the GPS 2000-epoch to Unix ms.
- ACCL / GRAV synthetic → `(cumulative_index / rate_hz) * 1000`.
- Never emit seconds, microseconds, or raw GPS 2000-epoch values to Angular.

**Sprint 1 discovery**: The G-force bar was glitching because `calculateGForceMagnitude` returned the m/s² deviation from 1 G (correct math, wrong unit), but the overlay threshold constants (`SPIKE_THRESHOLD = 1.5`, etc.) expected G units. The fix was a single `/ G` in `TelemetryMathService`. Same class of error as a timestamp unit mismatch — correct in isolation, silent and catastrophic at the consumer.

---

## 64 MB WASM Budget — Hard Ceiling

The Go-WASM module shares the browser's main-thread JS heap alongside the 4K video decoder. 64 MB is not aspirational; exceeding it causes Chrome to OOM-kill the tab mid-export.

Back-of-envelope: a 60-minute ride at 200 Hz ACCL = 720 000 samples × ~48 bytes ≈ 34 MB. That leaves ~30 MB for GPS9 + GRAV + the JSON serialisation scratch buffer — tight. Pre-allocate slices at parser startup with known upper bounds; never `append` inside an unbounded STRM loop.

For every `make([]T, n)` added to the parser, confirm `n` is bounded by a known constant (max sensor rate × max clip duration), not by a value read from the file. A malformed GPMF `repeat` field of `0xFFFF` must never drive a heap allocation.

---

## Option B — Parser Owns the SCAL Divide

The parser is responsible for dividing every raw integer by its SCAL factor and emitting `float64` values. Angular receives only decoded physical units (m/s², degrees, metres).

```go
// correct — Option B satisfied
sample.Lat = float64(rawLat) / float64(scal[0])

// wrong — raw integer reaching Angular
sample.Lat = float64(rawLat)
```

If a number looks wrong in the frontend, check this boundary first:
1. Is the Go parser emitting post-SCAL floats? (`lat / scal[0]`, not `lat`)
2. Is the Angular service treating the value as already-physical? (it must)

Mixing these in either direction produced the G-force unit bug in Sprint 1.

---

## Binary Diagnostic Probe

Insert inside the GPMF walk loop to expose stride misalignment (remove before committing):

```go
fourcc  := buf[pos : pos+4]
typ     := buf[pos+4]
size    := buf[pos+5]
rep     := binary.BigEndian.Uint16(buf[pos+6:])
dataLen := int(size) * int(rep)
padded  := (dataLen + 3) &^ 3
fmt.Printf("[KLV] pos=%d  key=%q  type=0x%02X  size=%d  rep=%d  dataLen=%d  nextPos=%d\n",
    pos, fourcc, typ, size, rep, dataLen, pos+8+padded)
```

| Observation | Diagnosis |
|---|---|
| `key` is not printable ASCII | Cursor misaligned — Stride Alignment Rule violated upstream |
| `nextPos` ≥ buffer length | `size × repeat` overflow — malformed or truncated file |
| Every other FourCC is wrong but alternating ones are correct | Data length is odd and `&^ 3` pad was omitted |
| `size=0, rep=0` on a non-container field | SCAL was consumed as a data row; STRM state machine has a bug |

---

## WASM Exports Reference

```
allocBuffer(size uint32) uint32        // returns linear-memory pointer to input buffer
parseGPMF(length, videoStartSec uint32) uint32  // returns ErrXxx code
getResultPtr() uint32
getResultLen() uint32
```

JS writes the MET binary into the pointer returned by `allocBuffer`, calls `parseGPMF`, then reads JSON from `getResultPtr/Len` on success.

Forbidden inside WASM exports: `fmt.Sprintf` in rAF-adjacent hot paths (heap allocation inside the 64 MB budget).

---

## Sprint 1 Decisions That Survived Grilling

- GPS9-primary / GPS5-fallback split
- SCAL responsibility on the parser side (Option B)
- IndexedDB composite cache key (filename + filesize + lastModified)
