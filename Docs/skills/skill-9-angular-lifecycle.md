# Skill 9 — Angular Input-Lifecycle Diagnostic Probe

**When to use**: A component that receives data via `@Input()` renders incorrectly (stale data, Null Island map, wrong state) and it is unclear whether the fault is in the input binding, `ngOnChanges`, or `ngAfterViewInit`.

**The problem this solves**: Angular fires `ngOnChanges` **before** `ngAfterViewInit`. For components that do expensive initialization in `ngAfterViewInit` (DOM setup, Leaflet map creation, canvas sizing), a change to an `@Input()` before `ngAfterViewInit` completes is silently ignored by the common pattern of "initialize once in `ngAfterViewInit`". The symptoms look like stale data or a missing initial state — not like a lifecycle ordering bug.

---

## Three-Probe Pattern

Add temporarily, remove before committing:

```typescript
// Probe 1 — in the parent, immediately after setting the signal/property
console.log('[PROBE-1] Data set in parent. Length: ' + result.items.length);

// Probe 2 — in the child's ngOnChanges
ngOnChanges(changes: SimpleChanges): void {
  if (changes['items']) {
    console.log('[PROBE-2] Child received items. Length: ' + this.items.length);
  }
}

// Probe 3 — in the child's ngAfterViewInit, before any initialization logic
ngAfterViewInit(): void {
  console.log('[PROBE-3] ngAfterViewInit — items.length: ' + this.items.length);
  this.init();
}
```

---

## Reading the Probe Sequence

| Console sequence | Diagnosis |
|---|---|
| PROBE-1 → PROBE-2 (length > 0) → PROBE-3 (length > 0) | Correct — data was ready before component was created. `init()` runs with real data. |
| PROBE-3 (length = 0) → PROBE-2 (length > 0) — no second PROBE-3 | **Root cause found**: component was created before data arrived. `init()` ran with empty data and will not re-run. Fix: detect data arrival in `ngOnChanges` and re-initialize. |
| PROBE-2 (length = 0) → PROBE-3 (length > 0) | Transient empty input (e.g. `signal.set(null)` before a new value). Guard `ngOnChanges` with `this.items.length > 0` to skip the empty transition. |
| PROBE-2 fires multiple times after PROBE-3 | Re-initialization path is working; verify each call triggers a full teardown before re-init. |

---

## The Fix Pattern

Once root cause is confirmed — split initialization into `setup()` and `teardown()` and call both from `ngOnChanges`:

```typescript
ngOnChanges(changes: SimpleChanges): void {
  if (changes['items'] && !changes['items'].firstChange
      && this.items.length > 0 && this.alreadyInitialized) {
    this.teardown();
    this.setup();
  }
}

ngAfterViewInit(): void {
  this.setup();
}

ngOnDestroy(): void {
  this.teardown();
}
```

The `!firstChange` guard prevents double-initialization: `ngAfterViewInit` owns the first `setup()` call, `ngOnChanges` owns all subsequent ones.
