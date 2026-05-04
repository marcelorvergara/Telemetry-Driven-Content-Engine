import { Injectable } from '@angular/core';
import { ACCLSample, GPS9Sample, GRAVSample } from '../models/telemetry.model';
import { ThemeService } from './theme.service';

const G = 9.81;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_HOLD_MS = 1500;

@Injectable({ providedIn: 'root' })
export class TelemetryMathService {

  private _lastSpeedUpdateTime = 0;
  private _lastSpeedValue      = 0;
  private _gPeakValue          = 0;
  private _gPeakHeldUntil      = 0;

  constructor(private readonly themeService: ThemeService) {}

  // Lower-bound binary search: returns the atom with the largest .t ≤ targetTimeMs.
  // Called inside a 60 Hz rAF loop so must not allocate. Returns the first atom when
  // targetTimeMs is before all samples, the last atom when it is after — never null
  // for a non-empty array.
  findClosestAtom<T extends { t: number }>(atoms: T[], targetTimeMs: number): T | null {
    if (atoms.length === 0) return null;

    let lo = 0;
    let hi = atoms.length - 1;

    // Ceiling-mid lower-bound: after the loop, lo === hi === the largest index
    // whose .t is ≤ targetTimeMs (or 0 if targetTimeMs is before all samples).
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (atoms[mid].t <= targetTimeMs) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return atoms[lo];
  }

  // Slam detection: total G-force deviation from the 1G baseline.
  // ACCL measures specific force, which includes gravity; at rest the vector
  // magnitude is ~9.81 m/s². Math.abs captures deviations in both directions
  // (hard braking ↓ and hard impact ↑) as a single unsigned G-force reading.
  calculateGForceMagnitude(accl: ACCLSample): number {
    const magnitude = Math.sqrt(accl.x ** 2 + accl.y ** 2 + accl.z ** 2);
    return Math.abs(magnitude - G) / G;
  }

  // Lean/tilt angle in degrees, preferring the GRAV unit vector.
  // GoPro camera frame: X = lateral, Y = vertical (down), Z = fore-aft.
  // Roll (lean) is rotation around the Z axis — compare lateral X to vertical Y.
  // Falls back to a normalised ACCL vector when GRAV is absent (Hero 10 and older).
  calculateLeanAngle(grav: GRAVSample | null, accl: ACCLSample | null): number {
    if (grav) {
      return Math.atan2(grav.x, grav.y) * RAD_TO_DEG;
    }
    if (accl) {
      const mag = Math.sqrt(accl.x ** 2 + accl.y ** 2 + accl.z ** 2);
      if (mag < 1e-9) return 0;
      return Math.atan2(accl.x / mag, accl.y / mag) * RAD_TO_DEG;
    }
    return 0;
  }

  // Linear interpolation of GPS speed between the two samples that bracket
  // targetTimeMs. Fills the perceptible gap between 18 Hz GPS samples in a
  // 60 Hz rAF loop, giving speed gauges a smooth sweep instead of visible steps.
  // Returns m/s; pass useSpeed3d=true for the 3-D magnitude (includes vertical).
  interpolateSpeed(
    gps: GPS9Sample[],
    targetTimeMs: number,
    useSpeed3d = false,
  ): number {
    if (gps.length === 0) return 0;
    if (gps.length === 1) return useSpeed3d ? gps[0].speed3d : gps[0].speed2d;

    // Inline lower-bound search — avoids the function-call overhead of
    // findClosestAtom in this hot-path method.
    // Time-domain alignment is the caller's responsibility: targetTimeMs must
    // already be in the same epoch as the GPS atom timestamps (see TelemetryOverlay
    // baseOffset logic).
    let lo = 0;
    let hi = gps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (gps[mid].t <= targetTimeMs) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const prev = gps[lo];
    if (lo >= gps.length - 1) return useSpeed3d ? prev.speed3d : prev.speed2d;
    const next = gps[lo + 1];

    const dt = next.t - prev.t;
    if (dt === 0) return useSpeed3d ? prev.speed3d : prev.speed2d;

    // Clamp alpha to [0, 1]: prevents extrapolation if target drifts outside the bracket.
    const alpha = Math.max(0, Math.min(1, (targetTimeMs - prev.t) / dt));
    const prevSpeed = useSpeed3d ? prev.speed3d : prev.speed2d;
    const nextSpeed = useSpeed3d ? next.speed3d : next.speed2d;
    return prevSpeed + (nextSpeed - prevSpeed) * alpha;
  }

  // Theme-aware speed for display. When speedUpdateIntervalMs === 0 the result is
  // instantaneous; when > 0 the output is frozen until the interval elapses.
  // nowMs must be performance.now() at frame time — the caller owns the clock.
  getDisplaySpeed(
    gps: GPS9Sample[],
    targetTimeMs: number,
    nowMs: number,
    useSpeed3d = false,
  ): number {
    const intervalMs = this.themeService.currentTheme().speedUpdateIntervalMs;
    if (intervalMs === 0) {
      return this.interpolateSpeed(gps, targetTimeMs, useSpeed3d);
    }
    if (nowMs - this._lastSpeedUpdateTime >= intervalMs) {
      this._lastSpeedValue      = this.interpolateSpeed(gps, targetTimeMs, useSpeed3d);
      this._lastSpeedUpdateTime = nowMs;
    }
    return this._lastSpeedValue;
  }

  // Theme-aware G-force for display. 'instant' passes through directly; 'max-hold'
  // latches the peak for MAX_HOLD_MS then snaps back to the instantaneous value.
  // nowMs must be performance.now() at frame time — the caller owns the clock.
  getDisplayGForce(accl: ACCLSample | null, nowMs: number): number {
    if (!accl) return 0;
    const instantG = this.calculateGForceMagnitude(accl);
    if (this.themeService.currentTheme().gForceBehavior === 'instant') {
      return instantG;
    }
    // max-hold: a new peak resets and extends the hold window
    if (instantG >= this._gPeakValue) {
      this._gPeakValue     = instantG;
      this._gPeakHeldUntil = nowMs + MAX_HOLD_MS;
    }
    if (nowMs < this._gPeakHeldUntil) {
      return this._gPeakValue;
    }
    // Hold expired — snap back and reset
    this._gPeakValue     = instantG;
    this._gPeakHeldUntil = 0;
    return instantG;
  }
}
