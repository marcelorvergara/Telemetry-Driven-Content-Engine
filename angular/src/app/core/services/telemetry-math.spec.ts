import { ACCLSample, GPS9Sample, GRAVSample } from '../models/telemetry.model';
import { TelemetryMathService } from './telemetry-math';

describe('TelemetryMathService', () => {
  let svc: TelemetryMathService;

  beforeEach(() => {
    svc = new TelemetryMathService();
  });

  // ── findClosestAtom ────────────────────────────────────────────────────────

  describe('findClosestAtom', () => {
    const atoms = [{ t: 0 }, { t: 100 }, { t: 200 }, { t: 300 }];

    it('returns null for an empty array', () => {
      expect(svc.findClosestAtom([], 50)).toBeNull();
    });

    it('returns the exact match', () => {
      expect(svc.findClosestAtom(atoms, 100)).toEqual({ t: 100 });
    });

    it('returns the lower bound when target falls between two samples', () => {
      expect(svc.findClosestAtom(atoms, 150)).toEqual({ t: 100 });
    });

    it('clamps to the first atom when target is before all samples', () => {
      expect(svc.findClosestAtom(atoms, -50)).toEqual({ t: 0 });
    });

    it('clamps to the last atom when target is after all samples', () => {
      expect(svc.findClosestAtom(atoms, 999)).toEqual({ t: 300 });
    });

    it('works on a single-element array', () => {
      expect(svc.findClosestAtom([{ t: 42 }], 0)).toEqual({ t: 42 });
    });
  });

  // ── calculateGForceMagnitude ───────────────────────────────────────────────

  describe('calculateGForceMagnitude', () => {
    it('returns ~0 for a resting sensor reading (magnitude ≈ 9.81)', () => {
      const accl: ACCLSample = { t: 0, x: 0, y: 9.81, z: 0 };
      expect(svc.calculateGForceMagnitude(accl)).toBeCloseTo(0, 5);
    });

    it('returns positive deviation for an impact above 1G', () => {
      // magnitude ≈ 19.62 → deviation ≈ 9.81
      const accl: ACCLSample = { t: 0, x: 0, y: 19.62, z: 0 };
      expect(svc.calculateGForceMagnitude(accl)).toBeCloseTo(9.81, 3);
    });

    it('returns the absolute deviation when magnitude is below 1G (near free-fall)', () => {
      const accl: ACCLSample = { t: 0, x: 0, y: 4.905, z: 0 };
      expect(svc.calculateGForceMagnitude(accl)).toBeCloseTo(4.905, 3);
    });
  });

  // ── calculateLeanAngle ────────────────────────────────────────────────────

  describe('calculateLeanAngle', () => {
    // GoPro frame: X = lateral, Y = vertical (down), Z = fore-aft.
    // Roll = atan2(x, y). Level camera: gravity along +Y, x=0 → 0°.
    it('returns 0° when camera is perfectly level (GRAV points straight down)', () => {
      const grav: GRAVSample = { t: 0, x: 0, y: 1, z: 0 };
      expect(svc.calculateLeanAngle(grav, null)).toBeCloseTo(0, 5);
    });

    it('returns 45° for a 45° lean using GRAV', () => {
      const v = Math.SQRT1_2; // 1/√2 — equal lateral and vertical components
      const grav: GRAVSample = { t: 0, x: v, y: v, z: 0 };
      expect(svc.calculateLeanAngle(grav, null)).toBeCloseTo(45, 3);
    });

    it('returns 90° when fully sideways (GRAV purely lateral, y=0)', () => {
      const grav: GRAVSample = { t: 0, x: 1, y: 0, z: 0 };
      expect(svc.calculateLeanAngle(grav, null)).toBeCloseTo(90, 3);
    });

    it('falls back to ACCL when GRAV is null', () => {
      // ACCL pointing fully laterally → normalised x=1, y=0 → 90°
      const accl: ACCLSample = { t: 0, x: 9.81, y: 0, z: 0 };
      expect(svc.calculateLeanAngle(null, accl)).toBeCloseTo(90, 3);
    });

    it('returns 0 when both GRAV and ACCL are null', () => {
      expect(svc.calculateLeanAngle(null, null)).toBe(0);
    });
  });

  // ── interpolateSpeed ───────────────────────────────────────────────────────

  describe('interpolateSpeed', () => {
    const gps: GPS9Sample[] = [
      { t: 0,   lat: 0, lon: 0, alt: 0, speed2d: 0,  speed3d: 0,  fix: 3, dop: 1 },
      { t: 100, lat: 0, lon: 0, alt: 0, speed2d: 10, speed3d: 11, fix: 3, dop: 1 },
      { t: 200, lat: 0, lon: 0, alt: 0, speed2d: 20, speed3d: 22, fix: 3, dop: 1 },
    ];

    it('returns 0 for an empty GPS array', () => {
      expect(svc.interpolateSpeed([], 50)).toBe(0);
    });

    it('returns the exact value on a sample boundary', () => {
      expect(svc.interpolateSpeed(gps, 100)).toBeCloseTo(10, 5);
    });

    it('linearly interpolates at the midpoint between two samples', () => {
      expect(svc.interpolateSpeed(gps, 50)).toBeCloseTo(5, 5);
    });

    it('linearly interpolates at an off-centre position', () => {
      expect(svc.interpolateSpeed(gps, 75)).toBeCloseTo(7.5, 5);
    });

    it('clamps to the last sample when target exceeds all timestamps', () => {
      expect(svc.interpolateSpeed(gps, 999)).toBeCloseTo(20, 5);
    });

    it('uses speed3d when useSpeed3d=true', () => {
      expect(svc.interpolateSpeed(gps, 50, true)).toBeCloseTo(5.5, 5);
    });

    it('clamps alpha to 0 when target is before the first sample (no negative extrapolation)', () => {
      expect(svc.interpolateSpeed(gps, -9999)).toBeCloseTo(0, 5);
    });

    it('interpolates correctly when GPS carries absolute Unix epoch timestamps', () => {
      // Caller (TelemetryOverlay) aligns targetTimeMs to the GPS epoch before calling.
      const epoch = 1_777_207_094_000;
      const epochGps: GPS9Sample[] = [
        { t: epoch,       lat: 0, lon: 0, alt: 0, speed2d: 0,  speed3d: 0,  fix: 3, dop: 1 },
        { t: epoch + 100, lat: 0, lon: 0, alt: 0, speed2d: 10, speed3d: 11, fix: 3, dop: 1 },
        { t: epoch + 200, lat: 0, lon: 0, alt: 0, speed2d: 20, speed3d: 22, fix: 3, dop: 1 },
      ];
      // Pass the already-aligned target (epoch + 50ms) — midpoint of first bracket → 5 m/s.
      expect(svc.interpolateSpeed(epochGps, epoch + 50)).toBeCloseTo(5, 5);
    });
  });
});
