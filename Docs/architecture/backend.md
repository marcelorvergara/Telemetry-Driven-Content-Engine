# Backend Architecture — Sprint 4

Rules governing the Spring Boot 3 + PostgreSQL persistence layer. These constraints apply to every feature that touches the API or Angular's network calls.

---

## Data Boundary Rule

The Angular frontend is **strictly forbidden** from sending full telemetry arrays to PostgreSQL. The 200 Hz ACCL, GPS9, and GRAV sample arrays are heavy by design — a 60-minute ride at 200 Hz ACCL produces ~720 000 rows. They live permanently in the browser's IndexedDB **Vault**.

PostgreSQL is the **Library Catalog**: it stores only the `ClipMetadata` summary (max speed, total distance, start/end GPS, highlights array of up to 5 peak timestamps). If a proposed backend field requires iterating over raw samples to compute, it belongs in Angular's `TelemetryMathService`, not in a new database column.

---

## Identity Rule

This is a single-user MVP. There is no authentication, no user ID, and no multi-tenant isolation. The composite key `(filename, fileSize)` is the sole identity for a clip. Do not introduce a `userId` column, a `deviceId`, or any other ownership concept until multi-user requirements are explicit.

The upsert in `ClipMetadataService` relies on this uniqueness: `findByFilenameAndFileSize` before save. Adding a third dimension to the key without updating the upsert path will silently create duplicates.

---

## Highlight Array Rule

The `highlights` field stores up to 5 peak G-force event timestamps as a native PostgreSQL `bigint[]` column. No join table, no separate `Highlight` entity, no JSON serialisation. Hibernate 6.4 (Spring Boot 3.3+) maps `Long[]` to `bigint[]` natively with `@Column(columnDefinition = "bigint[]")`.

If the number of highlights per clip needs to grow beyond ~20 elements, reconsider this approach — array columns are not individually indexable. For MVP scope, the native array is strictly simpler than a join table.

---

## Neon Cold-Start Trap

`ddl-auto: update` asks Hibernate to diff the schema on every application startup. On a serverless Neon database, the first connection after a cold-start takes 1–3 seconds. If Hibernate opens multiple connections during the `update` diff it races against Neon's connection pool warming and can fail with `PSQLException: connection refused` or produce a half-applied schema diff.

**Current state**: `ddl-auto: update` with `flyway.enabled: false` is intentional for early prototyping. It is **not safe for production**.

**Migration path** (do this when the schema stabilises):
1. Set `ddl-auto: validate` — Hibernate verifies schema only, never modifies it.
2. Set `flyway.enabled: true`.
3. Author `V1__create_schema.sql` matching entity definitions exactly.
4. Verify `mvn flyway:migrate` succeeds against Neon before deploying.

**Danger signal**: If a startup log shows `HHH90000031: DDL via Hibernate SchemaManagementTool` on a Neon URL, the trap is active.

---

## Write-Through Cache Flow

The three steps below must always execute in strict order. Breaking the sequence creates an inconsistency between the IndexedDB Vault and the PostgreSQL Library Catalog.

```
1. WASM Parse
   Angular extracts the MET track → passes Uint8Array to Go-WASM → receives ParsedClip JSON.
   On failure: surface error to user, abort all subsequent steps.

2. Save Arrays to IndexedDB (Vault)
   Store the full GPS9[], ACCL[], GRAV[] arrays keyed by (filename + fileSize + lastModified).
   This step must complete (resolved Promise) before step 3 starts.
   Rationale: if the backend POST succeeds but IndexedDB write fails, future lookups
   will find the summary in Postgres but no arrays in the Vault — a broken state.

3. POST Summary to Backend (Library Catalog)
   POST /api/clips with the ClipMetadata summary derived from the ParsedClip.
   On failure: silent degradation is acceptable for MVP — log the error, do not block the UI.
```

**Cache-hit path** (skip all three steps):

```
App load → GET /api/clips → render dashboard clip library.
User opens clip → GET /api/clips/lookup?filename=&fileSize=
  200 → load arrays from IndexedDB → proceed to rAF overlay (no WASM).
  404 → run steps 1–3 above (cache miss).
```

**Angular lookup contract**: the `GET /api/clips/lookup` 200 response guarantees the summary exists in Postgres. It does **not** guarantee the Vault arrays are present (user may have cleared IndexedDB). The Angular service must handle `undefined` from IndexedDB even after a 200, falling back to re-running WASM.
