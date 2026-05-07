import { Injectable } from '@angular/core';
import { ACCLSample, GPS9Sample, GRAVSample, LatLonBounds } from '../models/telemetry.model';
import { ThemeService } from './theme.service';

// Perpendicular distance from a point to the infinite line defined by lineStart→lineEnd.
// Operates on flat [lat, lon] pairs — valid for ride-scale distances where the
// planar approximation error is negligible (< 0.01 % within a 50 km bounding box).
function perpendicularDistance(
  point:     [number, number],
  lineStart: [number, number],
  lineEnd:   [number, number],
): number {
  const dx = lineEnd[0]   - lineStart[0];
  const dy = lineEnd[1]   - lineStart[1];
  if (dx === 0 && dy === 0) {
    return Math.sqrt((point[0] - lineStart[0]) ** 2 + (point[1] - lineStart[1]) ** 2);
  }
  const area = Math.abs(
    dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0],
  );
  return area / Math.sqrt(dx ** 2 + dy ** 2);
}

const G = 9.81;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_HOLD_MS = 1500;
// GPS multipath error floor: readings below this are indistinguishable from drift.
const SPEED_FLOOR_MS = 8.0 / 3.6;

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
    const g = Math.abs(magnitude - G) / G;
    return g < 0.25 ? 0 : g;
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
    if (gps.length === 1) {
      const s = useSpeed3d ? gps[0].speed3d : gps[0].speed2d;
      return s < SPEED_FLOOR_MS ? 0 : s;
    }

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
    if (lo >= gps.length - 1) {
      const s = useSpeed3d ? prev.speed3d : prev.speed2d;
      return s < SPEED_FLOOR_MS ? 0 : s;
    }
    const next = gps[lo + 1];

    const dt = next.t - prev.t;
    if (dt === 0) {
      const s = useSpeed3d ? prev.speed3d : prev.speed2d;
      return s < SPEED_FLOOR_MS ? 0 : s;
    }

    // Clamp alpha to [0, 1]: prevents extrapolation if target drifts outside the bracket.
    const alpha = Math.max(0, Math.min(1, (targetTimeMs - prev.t) / dt));
    const prevSpeed = useSpeed3d ? prev.speed3d : prev.speed2d;
    const nextSpeed = useSpeed3d ? next.speed3d : next.speed2d;
    const speed = prevSpeed + (nextSpeed - prevSpeed) * alpha;
    return speed < SPEED_FLOOR_MS ? 0 : speed;
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

  // Returns [lat, lon] pairs for every GPS-locked sample (fix >= 2).
  // Values are post-SCAL decimal degrees straight from the parser — no unit conversion.
  getRawPath(gps: GPS9Sample[]): [number, number][] {
    return gps.filter(s => s.fix >= 2).map(s => [s.lat, s.lon]);
  }

  // Returns the geographic bounding box of all GPS-locked samples, or null when
  // no locked samples exist. Null is the expected result for a clip with no GPS fix
  // and must be checked by the caller before passing to a map engine.
  getGeoBounds(gps: GPS9Sample[]): LatLonBounds | null {
    const locked = gps.filter(s => s.fix >= 2);
    if (locked.length === 0) return null;

    let minLat = locked[0].lat, maxLat = locked[0].lat;
    let minLon = locked[0].lon, maxLon = locked[0].lon;

    for (let i = 1; i < locked.length; i++) {
      const { lat, lon } = locked[i];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    return { minLat, maxLat, minLon, maxLon };
  }

  // Ramer-Douglas-Peucker path simplification. Tolerance is in decimal degrees;
  // 0.0001° ≈ 11 m at mid-latitudes — a safe default for ride-scale paths.
  // One-time call on clip load, not in the rAF loop.
  simplifyPath(path: [number, number][], tolerance: number): [number, number][] {
    if (path.length <= 2) return path;

    const start = path[0];
    const end   = path[path.length - 1];
    let maxDist = 0;
    let maxIdx  = 0;

    for (let i = 1; i < path.length - 1; i++) {
      const d = perpendicularDistance(path[i], start, end);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist <= tolerance) return [start, end];

    const left  = this.simplifyPath(path.slice(0, maxIdx + 1), tolerance);
    const right = this.simplifyPath(path.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
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
