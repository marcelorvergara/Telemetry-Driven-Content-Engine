import { Injectable } from '@angular/core';
import { ACCLSample, GPS9Sample, GRAVSample } from '../models/telemetry.model';

const G = 9.81;
const RAD_TO_DEG = 180 / Math.PI;

@Injectable({ providedIn: 'root' })
export class TelemetryMathService {

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
}
