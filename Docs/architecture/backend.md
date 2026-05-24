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

## GPS Snapshot → Street Timeline Pipeline

When Angular POSTs a clip summary to `/api/clips`, it includes a sparse `gpsSnapshots` array — one GPS coordinate per `SNAPSHOT_INTERVAL_MS` (15 seconds) of video duration. The controller passes these to `GeocodingService.resolveTimeline()` before the database upsert, returning a `streetTimeline` array with the response.

### `SNAPSHOT_INTERVAL_MS = 15 000`

Angular's `buildGpsSnapshots()` in `clip-api.service.ts` selects one GPS point every 15 seconds using a binary floor search. A 71-second clip produces ~5 snapshot points — enough to capture street transitions within that window. Increasing this interval risks missing transitions; the previous value of `60 000` (60 s) only produced 2 points for a 71-second clip, both often on the same street.

**GPS source priority:**
1. GoPro `GPS9` locked samples (`fix >= 2`) — preferred
2. Strava `StravaGpsPoint[]` — fallback when GoPro GPS is absent
3. `null` — when neither source exists

### `GeocodingService` — Concurrent Reverse Geocoding

Spring Boot geocodes all snapshot points in parallel using **virtual threads** (Java 21). Each point makes a synchronous HTTP call to `https://maps.googleapis.com/maps/api/geocode/json`. A `CompletableFuture.allOf()` with a **3-second hard deadline** caps the total wall-clock time regardless of network latency — slow or failed individual geocodes are silently skipped.

Result: `List<StreetTimelineEntry>` sorted ascending by `t` (ms from video start). Each entry pairs a timestamp with the `route` component of the Google Maps response (street name without numbers).

### Transaction Boundary

`ClipMetadataController.create()` calls `geocodingService.resolveTimeline()` **before** `service.upsert()`. Geocoding runs entirely outside the JPA transaction — no database connection is held open during the Google Maps network calls. This is intentional: holding a Neon serverless connection open for 3 seconds would exhaust the Hikari pool under moderate load.

### Angular Consumption

The `ClipMetadataDto` response includes `streetTimeline: StreetTimelineEntry[]`. Angular sets `this.streetTimeline.set(saved.streetTimeline ?? [])` in the `clipApi.upsert()` subscription. The `streetTimeline` signal is passed to `TelemetryOverlay` as an input and consumed by `findStreetAtTime()` in the 60 Hz render loop.

**Showcase bypass:** `loadDefaultAssets()` never calls the geocoding API — it sets `SHOWCASE_STREET_TIMELINE` directly to avoid consuming API quota on every public page load.

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
