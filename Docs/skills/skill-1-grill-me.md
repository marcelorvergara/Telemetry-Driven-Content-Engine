# Skill 1 — The "Grill Me" Interview

**When to use**: Before any architecture decision becomes load-bearing — new sensor, new WASM export, new Angular service boundary.

**What it does**: Forces adversarial stress-testing of a decision before it is implemented, surfacing hidden assumptions, failure modes, and unit mismatches while they are still cheap to fix.

---

## Prompt

> You are a senior systems engineer preparing to challenge all of our architectural assumptions for the Telemetry-Driven Content Engine. I will describe one decision we have made. Your job is to ask me the hardest questions you can think of — edge cases, failure modes, hidden assumptions, and design traps — until the decision either survives every challenge or we find a flaw. Be adversarial. Lead with the most dangerous question.
>
> Decision: [one sentence]
>
> Constraints always in scope:
> - 64 MB WASM linear memory ceiling (hard, not aspirational)
> - TinyGo — no reflection, no `binary.Read` with struct targets
> - Option B: the parser emits post-SCAL floats; Angular never sees raw integers
> - All `.t` values are milliseconds from video start (`currentTime × 1000`)

---

## Sprint 1 Decisions That Survived Grilling

- GPS9-primary / GPS5-fallback split
- SCAL responsibility on the parser side (Option B)
- IndexedDB composite cache key (filename + filesize + lastModified)
