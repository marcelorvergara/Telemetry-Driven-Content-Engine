# Skill 6 — Theme Engine Checklist

**When to use**: Before adding a new theme preset, a new layout variant, or any change to the Canvas rendering pipeline that touches `theme.colors`, `theme.layout`, or `theme.font`.

**What it does**: Ensures the `ThemeConfig` strategy contract is not broken and that new themes are self-consistent before the rAF loop consumes them.

---

## Checklist — New Theme Preset

- [ ] All 7 `colors` fields populated (`primary`, `secondary`, `accent`, `text`, `success`, `warning`, `danger`). Missing keys produce `undefined` in Canvas `fillStyle`, which silently renders as black.
- [ ] `layout` is one of the union members: `'spread' | 'stacked' | 'dashboard' | 'tiktok-cover'`. Any other string hits the `default:` case in `resolveLayout` and renders as `spread`.
- [ ] `speedUpdateIntervalMs` is `0` for instantaneous display or a positive integer (ms) for throttled updates. Negative values freeze the display permanently.
- [ ] `gForceBehavior` is `'instant'` or `'max-hold'`. Any other string defaults to `instant` (no peak latch).
- [ ] Preset exported and appended to `ALL_THEMES` in `theme.model.ts`.

---

## Checklist — New Layout Variant

- [ ] Add the literal string to the `layout` union type in `ThemeConfig`.
- [ ] Add a `case` to `resolveLayout` returning a valid `LayoutAnchors`. Round all computed pixel values — never pass floating-point coordinates to `fillRect` / `fillText`.
- [ ] Add an early-return branch in **all three** of `drawSpeedReadout`, `drawGForceBar`, and `drawBiometrics`. Each branch must be self-contained and end with `ctx.shadowBlur = 0; return;`.
- [ ] Do not modify the `default:` / `spread` path when adding a new layout. The `spread` layout is the reference rendering and must remain untouched.

---

## Context-Leak Guard Prompt

After writing a new layout branch, ask:

> "If this branch ran on frame N and the theme switched to `spread` before frame N+1, would any Canvas context property be in a non-default state?"

Properties to check: `shadowBlur`, `shadowColor`, `globalAlpha`, `textBaseline`, `lineWidth`.
