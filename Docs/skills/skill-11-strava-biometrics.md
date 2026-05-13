# Skill 11 — Strava Biometrics Checklist

**When to use**: Before modifying `drawBiometrics()`, `interpolateBiometrics()`, adding new GPX fields, changing HR zone thresholds, or adding a new layout variant that must render biometric data.

---

## Checklist — Modifying `interpolateBiometrics()`

- [ ] Binary search uses `.t` (ms from video start) as the sort key — same contract as `findClosestAtom`.
- [ ] `alpha` clamp: `alpha = Math.max(0, Math.min(1, (timeMs - lo.t) / (hi.t - lo.t)))` — never let it exceed `[0, 1]`.
- [ ] Function returns `null` when `pts` is empty or `timeMs` is outside the array range. Callers must handle `null`.
- [ ] No `performance.now()` inside the function — time is passed in from the rAF tick.

---

## Checklist — Modifying `drawBiometrics()`

- [ ] All three layout branches are present: `spread`, `stacked`, `tiktok-cover`.
- [ ] Each branch ends with `ctx.shadowBlur = 0; return;` — context-leak guard (see Skill 10).
- [ ] `ctx.globalAlpha` mutations (if any) are wrapped in `ctx.save()` / `ctx.restore()`.
- [ ] HR value text colour is `hrColor(bio.hr, theme)` — not hardcoded.
- [ ] `tiktok-cover` branch uses zero `shadowBlur` — consistent with `drawSpeedReadout` tiktok constraint.
- [ ] Coordinate arithmetic rounds to integers: `Math.round(x)` before `fillRect`, `fillText`, `arc`.

---

## Checklist — Adding a New GPX Field

- [ ] Field added to `StravaGpsPoint` interface in `telemetry.model.ts`.
- [ ] Field extracted in `StravaTelemetryService.parseGpx()` using `getElementsByTagNameNS(NS_TPX, 'fieldName')` — **not** `querySelector('gpxtpx:fieldName')` (namespace prefix is not resolved in DOMParser).
- [ ] Field survives the re-anchor spread in `app.ts`: `{ ...p, t: …, relativeTimeSec: … }` — all other fields carry through automatically.
- [ ] Field interpolated in `interpolateBiometrics()` alongside `hr`, `cad`, `ele`, `speed`.

---

## Checklist — Adding a New Layout Variant (bio-aware)

- [ ] Branch added to `drawBiometrics()`.
- [ ] Branch added to `drawSpeedReadout()` (per Skill 6).
- [ ] Branch added to `drawGForceBar()` (per Skill 6).
- [ ] Context-leak guard on all three branches (Skill 10 prompt applied).

---

## Checklist — Speed Source Switching

- [ ] `useStrava = telemetrySource() === 'Strava' && stravaGps().length > 0` — both conditions required.
- [ ] `speed = bio ? Math.max(bio.speed, SPEED_FLOOR_MS) : 0` — floor always applied.
- [ ] `drawGForceBar()` is called unconditionally — never gated on `useStrava`.
- [ ] Export `onFrame` recomputes `interpolateBiometrics()` fresh — does not read `this.lastSpeed` from the live rAF loop.

---

## HR Zone Thresholds — Do Not Change

| Zone | BPM range | `theme.colors` key |
|---|---|---|
| Recovery | < 100 | `success` |
| Aerobic | 100 – 139 | `primary` |
| Threshold | 140 – 159 | `warning` |
| Anaerobic | ≥ 160 | `danger` |

These are established sport-science zones. They are not aesthetic preferences and must not be adjusted per-theme or per-request without explicit user confirmation.
