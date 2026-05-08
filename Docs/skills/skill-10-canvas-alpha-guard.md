# Skill 10 — Canvas Alpha Guard

**When to use**: Before adding any new Canvas primitive that sets `ctx.globalAlpha` to a non-1.0 value, or before changing `backgroundAlpha` in any `ThemeConfig.map` preset.

**The risk**: `ctx.globalAlpha` is sticky context state. A single un-restored alpha assignment silently dims every subsequent draw call on that context for the rest of the frame — and every frame after, because `clearRect` does not reset context state. The failure presents as a translucent HUD, not a console error.

---

## Checklist — Before Committing Any Alpha Draw Call

- [ ] **`ctx.save()` before / `ctx.restore()` after.** Every block that mutates `globalAlpha` must be wrapped. An explicit `ctx.globalAlpha = 1.0` reset is an acceptable fallback only if no other state (clip, transform, composite) was modified in the same block.
- [ ] **`backgroundAlpha` sourced exclusively from `ThemeConfig.map`.** Never hardcode an alpha value in `telemetry-overlay.ts`. The value must live in `theme.model.ts` where it is visible to the strategy pattern and the runtime slider.
- [ ] **`fillStyle` colour sourced from a theme property.** Currently `drawVectorMap` reads `theme.colors.secondary`. If you change `colors.secondary` in any preset, verify it does not break the G-force bar outline — that property is shared. See the Known Debt section below.
- [ ] **Optical-mix check for light colours.** A light hex value (e.g. `#FFFFFF`) at `backgroundAlpha < 0.5` over dark video pixels optically mixes to muddy gray. Minimum safe floor for light-coloured backgrounds: **0.7**. `CLEAN_SPORT` uses `0.85` for this reason.
- [ ] **`Math.round()` on all bounding-box coordinates.** Sub-pixel coordinates on every rAF tick are measurable overhead at 1080p ghost canvas resolution.

---

## Verification Step — Alpha Leak Test

After wiring a new alpha draw call, run this in the browser DevTools Console during live playback:

```javascript
// Snapshot globalAlpha immediately after a draw frame completes.
// Monkey-patch clearRect — it fires at the top of every drawFrame().
const ctx = document.querySelector('canvas').getContext('2d');
const orig = ctx.clearRect.bind(ctx);
ctx.clearRect = function(...args) {
  if (ctx.globalAlpha !== 1) console.warn('ALPHA LEAK entering frame:', ctx.globalAlpha);
  orig(...args);
};
```

If the console stays silent during theme switches and G-force spikes, the guard is clean.

---

## Known Architectural Debt — `colors.secondary` Dual Use

`drawVectorMap` uses `theme.colors.secondary` as the map background `fillStyle`. This property is also read by `drawGForceBar` for the bar outline and peak marker stroke. They are not isolated.

**Impact**: Changing `colors.secondary` in any preset changes both the map background colour and the G-force bar aesthetics simultaneously.

**Planned fix**: Add `color: string` to `ThemeConfig.map` and update the single `ctx.fillStyle = theme.colors.secondary` line in `drawVectorMap` to `ctx.fillStyle = theme.map.color`. Until that fix lands, document any `colors.secondary` change with an explicit note that both surfaces were reviewed.

---

## Signal Patch Pattern — Surgical Alpha Update

Use `ThemeService.updateMapAlpha(alpha)` to change alpha without overwriting `strokeWidth` or `showGrid`:

```typescript
// Correct — deep spread preserves sibling map properties.
this.currentTheme.update(t => ({ ...t, map: { ...t.map, backgroundAlpha: alpha } }));

// Wrong — reconstructing the full ThemeConfig object risks desync if new map
// properties are added to the interface but not to the call site.
this.currentTheme.set({ ...theme, map: { backgroundAlpha: alpha, strokeWidth: 2, showGrid: false } });
```
