# Sensor Noise Floors — Hardware Realities

GoPro sensors are consumer-grade MEMS hardware. Even at standstill they produce non-zero readings. The thresholds below were established empirically in this recording environment and are enforced inside `TelemetryMathService`. **Do not remove or lower them** — they silence hardware noise, not real events.

---

## MEMS Accelerometer Drift

The ACCL sensor has thermal noise and micro-vibration pickup that produces a constant G-force deviation from the 1G baseline even when the camera is physically stationary. Readings below **0.25 G** are indistinguishable from sensor noise in this environment.

```typescript
// calculateGForceMagnitude — telemetry-math.ts
const g = Math.abs(magnitude - G) / G;
return g < 0.25 ? 0 : g;   // ← never lower this threshold
```

---

## GPS Multipath Drift

Stationary GPS receivers report non-zero speed because satellite signals reflect off buildings and terrain (multipath interference). In this environment, multipath drift peaks at approximately 7 km/h. The speed floor is set at **8.0 km/h (≈ 2.22 m/s)** to absorb the full drift envelope.

```typescript
// telemetry-math.ts module constant
const SPEED_FLOOR_MS = 8.0 / 3.6;   // ← never lower this threshold
```

This constant is applied at **all four return paths** in `interpolateSpeed`:
1. Single-sample path
2. Past-end clamp
3. Zero-dt guard
4. Interpolated result

Any refactor that adds a new return path must apply the same floor.

**Also applied to Strava-derived speed**: when `telemetrySource === 'Strava'`, `drawFrame()` clamps the Haversine speed from `interpolateBiometrics()` using the same constant — `Math.max(bio.speed, SPEED_FLOOR_MS)`. Multipath GPS drift affects Strava 1 Hz data for the same hardware reason it affects GoPro GPS9.

---

## Why These Are Not Tunable Per-Theme

The noise floors are hardware facts, not display preferences. They belong in `TelemetryMathService` as module-level constants, not in `ThemeConfig`. A theme change must never affect whether a ghost reading is suppressed.
