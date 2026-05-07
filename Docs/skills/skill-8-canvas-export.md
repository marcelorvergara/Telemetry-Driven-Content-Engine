# Skill 8 — Canvas Export Safety Checklist

**When to use**: Before adding any new visual element to `telemetry-overlay.ts` — whether a new gauge, the vector map, an icon, or any image-based decoration.

**The risk**: A single `ctx.drawImage()` call with a cross-origin image marks the HUD canvas as origin-dirty. `canvas.captureStream()` continues to return a `MediaStream` with no error, but the `MediaRecorder` receives opaque-black frames. The export appears to complete successfully (the `.webm` file downloads) but plays back as solid black. This failure is silent and timing-dependent.

---

## Checklist — Before Committing Any New Draw Call

- [ ] **No `ctx.drawImage()` with external content.** Tile PNGs, CDN-hosted icons, and `fetch()`-loaded images are forbidden on the HUD canvas. Only same-origin `<canvas>` or `<img>` elements with `crossOrigin = 'anonymous'` set before `.src` are safe.
- [ ] **No `ctx.drawImage(videoEl, …)` for background fill.** Drawing the video frame into the canvas taints it immediately. The black-background export strategy (`fillRect('#000000')`) exists to avoid this.
- [ ] **`shadowBlur` reset to 0 before returning** from every new draw method. Canvas context state persists across frames; leaking `shadowBlur` produces bloom corruption visible only under specific theme + G-force combinations.
- [ ] **No `performance.now()` inside new draw helpers.** The clock is captured once per rAF tick in `drawFrame()` and passed in. A second `performance.now()` call inside a draw helper produces a different timestamp for the same frame, breaking interpolation.
- [ ] **Coordinate arithmetic rounds to integers.** Pass `Math.round(x)` to `fillRect`, `fillText`, `arc`, `moveTo`, `lineTo`. Sub-pixel coordinates force the browser into anti-aliased slow paths on every frame — measurable at 1080p ghost canvas resolution.

---

## Verification Step — Cross-Origin Tile Check

Before committing any visual enhancement, verify that no external image assets or cross-origin tiles are being drawn to the Canvas:

1. Search the diff for `ctx.drawImage` — any call must be reviewed. Only same-origin `<canvas>` or `<img>` elements with `crossOrigin = 'anonymous'` set **before** `.src` are safe.
2. Search the diff for `new Image()` or `fetch(` inside `telemetry-overlay.ts` — any network fetch whose result flows into the Canvas is a taint risk.
3. Confirm no DOM-based map library (`leaflet`, `mapbox-gl`, `@googlemaps/*`) has been added to `package.json`. These cannot render into a Canvas stream without tainting it.

If all three checks pass, `captureStream()` remains un-tainted and the WebM export is safe.

---

## Quick Taint Test

Run in browser DevTools after adding a new visual element to the export:

```javascript
// Paste into Console while the export is running, then stop it.
const c = document.querySelector('canvas'); // the display canvas
try { c.toDataURL(); console.log('CLEAN'); }
catch(e) { console.error('TAINTED', e); }
```

If the HUD canvas is not accessible directly, trigger a 1-second export and inspect the downloaded `.webm` — if the first frame is black, the canvas was tainted before recording started.
