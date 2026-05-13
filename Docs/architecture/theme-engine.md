# Theme Engine Architecture — Sprint 5

Rules governing the Angular-side theme strategy pattern. These constraints apply to every feature that touches visual presentation, Canvas rendering, or theme-aware math.

---

## ThemeConfig Strategy Pattern

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

Three concrete presets live in `theme.model.ts`:
- `VERGARA_YOUTUBE` — cyan/magenta, spread, instant
- `CLEAN_SPORT` — white/orange, stacked, 250 ms throttle
- `VERGARA_TIKTOK` — blue/red, tiktok-cover, max-hold

**Add a new preset by adding a new `ThemeConfig` literal to `ALL_THEMES` in `theme.model.ts`.** Do not introduce new fields to `ThemeConfig` for single-preset customisation — use the existing properties.

---

## ThemeService Signal Rule

`ThemeService` holds a single `signal<ThemeConfig>` (`currentTheme`). It is the sole source of truth for active theme state.

The Canvas rAF loop reads `this.themeService.currentTheme()` as a **synchronous call inside `ngZone.runOutsideAngular`**. No subscription, no `effect()`, no change-detection side effect — Angular's change-detection must not fire on every 60 Hz frame.

Do not switch this to an Observable or an `effect()`.

---

## Decoupled Math Rule

`TelemetryMathService` owns all stateful behavioural wrappers. The rAF loop passes `nowMs = performance.now()` into `getDisplaySpeed` and `getDisplayGForce`; the service owns the interval/hold logic internally.

| Method | Behaviour when theme changes |
|---|---|
| `getDisplaySpeed(gps, targetMs, nowMs)` | Reads `speedUpdateIntervalMs` from `currentTheme()` per call. Change is instantaneous. |
| `getDisplayGForce(accl, nowMs)` | Reads `gForceBehavior` from `currentTheme()` per call. Switching from `max-hold` to `instant` snaps to the instantaneous value on the next frame. |

**The caller must own the clock**: `nowMs` must be `performance.now()` captured once per rAF tick and passed to both methods. Never call `performance.now()` inside the service.

---

## Canvas Layout Rule

`resolveLayout(layout, width, height)` returns a `LayoutAnchors` struct (`{ speedX, gfBarX, gfBarY }`) computed once per frame. Both `drawSpeedReadout` and `drawGForceBar` consume the same struct — no drawing code duplicates coordinate arithmetic.

`drawSpeedReadout`, `drawGForceBar`, and `drawBiometrics` use **early-return branching** on `theme.layout`. Each layout variant is a fully isolated code path:

| Layout | Visual style | Code path |
|---|---|---|
| `spread` | Glow text, bloom shadows, chromatic-aberration glitch at high G | Default (fallthrough) |
| `stacked` | Same glow style; both elements left-aligned at 75% height | Default (fallthrough) |
| `tiktok-cover` | Solid `fillRect` geometry, no `shadowBlur`, flat opaque colour blocks + three-colour branding stripe | Early-return branch |

**The `tiktok-cover` constraint**: this layout never sets `shadowBlur > 0`. The three-colour branding stripe (secondary / success / warning) is drawn in `drawSpeedReadout` — do not move it to `drawGForceBar`. The `drawBiometrics` tiktok-cover branch draws its own stripe segments for the three bio boxes (ELE / CAD / HR) that are visually continuous with the `drawSpeedReadout` stripe.

**Three functions share the same layout contract**: `drawSpeedReadout`, `drawGForceBar`, and `drawBiometrics`. Adding a new layout variant requires a branch in all three. Omitting one produces a layout that works for speed and G-force but falls back to `spread` rendering for the bio panel.

**Context-leak guard**: every layout branch must end with `ctx.shadowBlur = 0` before returning. Canvas context state is persistent across frames; failing to reset it produces cumulative visual corruption.

---

## Checklist — New Theme Preset

- [ ] All 7 `colors` fields populated (`primary`, `secondary`, `accent`, `text`, `success`, `warning`, `danger`). Missing keys produce `undefined` in Canvas `fillStyle`, silently rendering as black.
- [ ] `layout` is one of the union members: `'spread' | 'stacked' | 'dashboard' | 'tiktok-cover'`.
- [ ] `speedUpdateIntervalMs` is `0` or a positive integer. Negative values freeze the display permanently.
- [ ] `gForceBehavior` is `'instant'` or `'max-hold'`.
- [ ] Preset exported and appended to `ALL_THEMES` in `theme.model.ts`.

---

## Checklist — New Layout Variant

- [ ] Add the literal string to the `layout` union type in `ThemeConfig`.
- [ ] Add a `case` to `resolveLayout` returning a valid `LayoutAnchors`. Round all pixel values.
- [ ] Add an early-return branch in **both** `drawSpeedReadout` and `drawGForceBar`. Each branch ends with `ctx.shadowBlur = 0; return;`.
- [ ] Do not modify the `default:` / `spread` path — it is the reference rendering.

**Context-leak guard prompt**: "If this branch ran on frame N and the theme switched to `spread` before frame N+1, would any Canvas context property be in a non-default state?" Check: `shadowBlur`, `shadowColor`, `globalAlpha`, `textBaseline`, `lineWidth`.
