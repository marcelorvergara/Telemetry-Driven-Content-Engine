# Sprint Skill Library

Reusable prompts and diagnostic patterns proven effective during Sprint 1.
Run the relevant skill at the start of any new sub-system before touching code.

---

## 1 — The "Grill Me" Interview

**When to use**: Before any architecture decision becomes load-bearing — new sensor, new WASM export, new Angular service boundary.

**What it does**: Forces adversarial stress-testing of a decision before it is implemented, surfacing hidden assumptions, failure modes, and unit mismatches while they are still cheap to fix.

**Prompt**:

> You are a senior systems engineer preparing to challenge all of our architectural assumptions for the Telemetry-Driven Content Engine. I will describe one decision we have made. Your job is to ask me the hardest questions you can think of — edge cases, failure modes, hidden assumptions, and design traps — until the decision either survives every challenge or we find a flaw. Be adversarial. Lead with the most dangerous question.
>
> Decision: [one sentence]
>
> Constraints always in scope:
> - 64 MB WASM linear memory ceiling (hard, not aspirational)
> - TinyGo — no reflection, no `binary.Read` with struct targets
> - Option B: the parser emits post-SCAL floats; Angular never sees raw integers
> - All `.t` values are milliseconds from video start (`currentTime × 1000`)

**Sprint 1 decisions that survived grilling**: GPS9-primary / GPS5-fallback split; SCAL responsibility on the parser side (Option B); IndexedDB composite cache key (filename + filesize + lastModified).

---

## 2 — Binary Diagnostic Probe

**When to use**: A KLV walk produces garbage FourCCs, a wrong sample count, or an unexpected `ErrMalformedGPMF` that does not map to a known bad offset.

**What it does**: Prints the full parse state at every field boundary, making stride misalignment and size/repeat overflow immediately visible without a debugger.

**Insert inside the GPMF walk loop** (remove before committing):

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

**Reading the output**:

| Observation | Diagnosis |
|---|---|
| `key` is not printable ASCII | Cursor misaligned — Stride Alignment Rule violated upstream |
| `nextPos` ≥ buffer length | `size × repeat` overflow — malformed or truncated file |
| Every other FourCC is wrong but alternating ones are correct | Data length is odd and `&^ 3` pad was omitted |
| `size=0, rep=0` on a non-container field | SCAL was consumed as a data row; STRM state machine has a bug |

**Stride formula** (the rule the probe validates):

```go
pos += 8 + (int(size)*int(repeat)+3)&^3
```

---

## 3 — Manual BigEndian Audit

**When to use**: Before every PR that modifies the Go parser. TinyGo compiles reflection-based reads without error but produces silent wrong output inside WASM; the failure surfaces only when Angular consumes the corrupted data.

**Step 1 — grep for forbidden patterns** (run from `go/`):

```bash
grep -rn "binary\.Read\b" .
grep -rn "json\.Unmarshal" .
grep -rn "encoding/json" .
```

Zero matches required. Any hit is a merge blocker.

**Step 2 — allowed-pattern checklist**:

| Pattern | Status | Note |
|---|---|---|
| `binary.BigEndian.Uint32(buf[pos:])` | Allowed | KLV key read |
| `binary.BigEndian.Uint16(buf[pos+6:])` | Allowed | KLV repeat field |
| `buf[pos]` | Allowed | Single-byte type / size |
| `binary.Read(r, …, &struct)` | **Blocked** | Reflection — TinyGo runtime failure |
| `json.Unmarshal` | **Blocked** | Reflection — build JSON manually |
| `fmt.Sprintf` in rAF-adjacent hot path | **Blocked** | Heap allocation inside 64 MB budget |

**Step 3 — Option B checkpoint**:

After every sensor's decode block, verify the last assignment before appending to the result slice is a `float64` produced by a SCAL divide:

```go
// correct — Option B satisfied
sample.Lat = float64(rawLat) / float64(scal[0])

// wrong — raw integer reaching Angular
sample.Lat = float64(rawLat)
```

If the final assignment is still an integer type or the divide is absent, Option B has been violated and the Angular `TelemetryMathService` will receive raw counts instead of physical units.

**Step 4 — 64 MB budget spot-check**:

For every `make([]T, n)` added to the parser, confirm `n` is bounded by a known constant (max sensor rate × max clip duration), not by a value read from the file. A malformed GPMF `repeat` field of `0xFFFF` must never drive a heap allocation.

---

## 4 — Neon Cold-Start Trap

**When to use**: Before any change to `spring.jpa.hibernate.ddl-auto` or `spring.flyway.enabled` in `application.yml`.

**The trap**: `ddl-auto: update` asks Hibernate to diff the schema on every application startup. On a serverless Neon database, the first connection after a cold-start takes 1–3 seconds. If Hibernate opens multiple connections during the `update` diff (to inspect existing columns, read constraints, lock tables) it races against Neon's connection pool warming and can fail with `PSQLException: connection refused` or produce a half-applied schema diff with no clear error.

**Current state**: `ddl-auto: update` with `flyway.enabled: false` is intentional for early prototyping while the schema is still changing sprint-to-sprint. It is **not safe for production** and must be replaced before any non-local environment is used.

**The migration path** (do this when the schema stabilises):
1. Set `ddl-auto: validate` — Hibernate verifies schema only, never modifies it.
2. Set `flyway.enabled: true`.
3. Author `V1__create_schema.sql` matching the entity definitions exactly.
4. Verify `mvn flyway:migrate` succeeds against Neon before deploying.

**Danger signal**: If a startup log shows `HHH90000031: DDL via Hibernate SchemaManagementTool` on a Neon URL, the trap is active. Investigate before the next deploy.

---

## 5 — Write-Through Cache Flow

**When to use**: Before implementing or debugging any Angular code that triggers WASM parsing or calls the backend API.

**The invariant**: The three steps below must always execute in strict order. Breaking the sequence creates an inconsistency between the IndexedDB Vault and the PostgreSQL Library Catalog that is invisible until the user closes the tab or clears storage.

**Exact order of operations**:

```
1. WASM Parse
   Angular extracts the MET track → passes Uint8Array to Go-WASM → receives ParsedClip JSON.
   On failure: surface error to user, abort all subsequent steps.

2. Save Arrays to IndexedDB (Vault)
   Store the full GPS9[], ACCL[], GRAV[] arrays keyed by (filename + fileSize + lastModified).
   This step must complete (resolved Promise) before step 3 starts.
   Rationale: if the backend POST succeeds but IndexedDB write fails, future lookups
   will find the summary in Postgres but no arrays in the Vault, producing a broken state.

3. POST Summary to Backend (Library Catalog)
   POST /api/clips with the ClipMetadata summary derived from the ParsedClip.
   On failure: silent degradation is acceptable for MVP — log the error, do not block the UI.
   The user still has the full clip data in IndexedDB for the current session.
```

**Cache-hit path** (skip all three steps):

```
App load → GET /api/clips → render dashboard clip library.
User opens clip → GET /api/clips/lookup?filename=&fileSize=
  200 → load arrays from IndexedDB → proceed to rAF overlay (no WASM).
  404 → run step 1–3 above (cache miss).
```

**Angular lookup contract**: the `GET /api/clips/lookup` 200 response guarantees the summary exists in Postgres. It does **not** guarantee the Vault arrays are present (user may have cleared IndexedDB). The Angular service must handle the case where IndexedDB returns `undefined` even after a 200 from the API, falling back to re-running WASM.
