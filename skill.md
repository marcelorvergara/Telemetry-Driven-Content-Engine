# Sprint Skill Library

Run the relevant skill before touching any subsystem listed below. Full prompts, diagnostic tables, and code snippets are in `Docs/skills/`.

| # | Skill | When to use | Detail |
|---|---|---|---|
| 1 | Grill Me Interview | Before any load-bearing architecture decision (new sensor, new WASM export, new Angular service boundary) | [Docs/skills/skill-1-grill-me.md](Docs/skills/skill-1-grill-me.md) |
| 2 | Binary Diagnostic Probe | KLV walk produces garbage FourCCs, wrong sample count, or unexpected `ErrMalformedGPMF` | [Docs/skills/skill-2-binary-diagnostic.md](Docs/skills/skill-2-binary-diagnostic.md) |
| 3 | Manual BigEndian Audit | Before every PR that modifies the Go parser | [Docs/skills/skill-3-bigendian-audit.md](Docs/skills/skill-3-bigendian-audit.md) |
| 4 | Neon Cold-Start Trap | Before any change to `spring.jpa.hibernate.ddl-auto` or `spring.flyway.enabled` | [Docs/skills/skill-4-neon-coldstart.md](Docs/skills/skill-4-neon-coldstart.md) |
| 5 | Write-Through Cache Flow | Before implementing or debugging WASM parsing or backend API calls | [Docs/skills/skill-5-write-through-cache.md](Docs/skills/skill-5-write-through-cache.md) |
| 6 | Theme Engine Checklist | Before adding a new theme preset, layout variant, or Canvas pipeline change. Must include `map: { backgroundAlpha, strokeWidth, showGrid }` for every new preset. Verify `colors.secondary` is safe to change (shared with G-force bar). | [Docs/skills/skill-6-theme-checklist.md](Docs/skills/skill-6-theme-checklist.md) |
| 7 | Drill Me (Layer Isolation) | Before modifying `TelemetryMathService`, `telemetry-overlay.ts`, or the Go-WASM parser | [Docs/skills/skill-7-drill-me.md](Docs/skills/skill-7-drill-me.md) |
| 8 | Canvas Export Safety | Before adding any new visual element to `telemetry-overlay.ts` | [Docs/skills/skill-8-canvas-export.md](Docs/skills/skill-8-canvas-export.md) |
| 9 | Angular Input-Lifecycle Probe | Component receives `@Input()` data but renders incorrectly (stale data, Null Island, wrong state) | [Docs/skills/skill-9-angular-lifecycle.md](Docs/skills/skill-9-angular-lifecycle.md) |
| 10 | Canvas Alpha Guard | Before adding any new Canvas primitive that uses `globalAlpha` or transparency. Checklist: (1) Is the draw wrapped in `ctx.save()`/`ctx.restore()`? (2) Is `backgroundAlpha` sourced from `ThemeConfig.map` — not hardcoded? (3) Does the hex colour optically mix acceptably at the chosen alpha over dark video? Light colours below 0.5 alpha over dark video = muddy gray. | [Docs/skills/skill-10-canvas-alpha-guard.md](Docs/skills/skill-10-canvas-alpha-guard.md) |
