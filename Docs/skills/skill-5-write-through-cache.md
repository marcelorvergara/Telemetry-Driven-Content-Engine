# Skill 5 — Write-Through Cache Flow

**When to use**: Before implementing or debugging any Angular code that triggers WASM parsing or calls the backend API.

**The invariant**: The three steps below must always execute in strict order. Breaking the sequence creates an inconsistency between the IndexedDB Vault and the PostgreSQL Library Catalog that is invisible until the user closes the tab or clears storage.

---

## Exact Order of Operations

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

---

## Cache-Hit Path (skip all three steps)

```
App load → GET /api/clips → render dashboard clip library.
User opens clip → GET /api/clips/lookup?filename=&fileSize=
  200 → load arrays from IndexedDB → proceed to rAF overlay (no WASM).
  404 → run steps 1–3 above (cache miss).
```

---

## Angular Lookup Contract

The `GET /api/clips/lookup` 200 response guarantees the summary exists in Postgres. It does **not** guarantee the Vault arrays are present (user may have cleared IndexedDB). The Angular service must handle the case where IndexedDB returns `undefined` even after a 200 from the API, falling back to re-running WASM.
