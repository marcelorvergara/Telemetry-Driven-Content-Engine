# Skill 3 — Manual BigEndian Audit

**When to use**: Before every PR that modifies the Go parser. TinyGo compiles reflection-based reads without error but produces silent wrong output inside WASM; the failure surfaces only when Angular consumes the corrupted data.

---

## Step 1 — Grep for Forbidden Patterns

Run from `go/`:

```bash
grep -rn "binary\.Read\b" .
grep -rn "json\.Unmarshal" .
grep -rn "encoding/json" .
```

Zero matches required. Any hit is a merge blocker.

---

## Step 2 — Allowed-Pattern Checklist

| Pattern | Status | Note |
|---|---|---|
| `binary.BigEndian.Uint32(buf[pos:])` | Allowed | KLV key read |
| `binary.BigEndian.Uint16(buf[pos+6:])` | Allowed | KLV repeat field |
| `buf[pos]` | Allowed | Single-byte type / size |
| `binary.Read(r, …, &struct)` | **Blocked** | Reflection — TinyGo runtime failure |
| `json.Unmarshal` | **Blocked** | Reflection — build JSON manually |
| `fmt.Sprintf` in rAF-adjacent hot path | **Blocked** | Heap allocation inside 64 MB budget |

---

## Step 3 — Option B Checkpoint

After every sensor's decode block, verify the last assignment before appending to the result slice is a `float64` produced by a SCAL divide:

```go
// correct — Option B satisfied
sample.Lat = float64(rawLat) / float64(scal[0])

// wrong — raw integer reaching Angular
sample.Lat = float64(rawLat)
```

If the final assignment is still an integer type or the divide is absent, Option B has been violated and Angular's `TelemetryMathService` will receive raw counts instead of physical units.

---

## Step 4 — 64 MB Budget Spot-Check

For every `make([]T, n)` added to the parser, confirm `n` is bounded by a known constant (max sensor rate × max clip duration), not by a value read from the file. A malformed GPMF `repeat` field of `0xFFFF` must never drive a heap allocation.
