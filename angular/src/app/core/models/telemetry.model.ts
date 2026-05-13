// TelemetryAtom types — mirror the JSON emitted by the Go-WASM parser.
// Field names match the manual JSON marshaler in main.go exactly.

export interface GPS9Sample {
  t: number;       // ms from video start
  lat: number;
  lon: number;
  alt: number;     // metres
  speed2d: number; // m/s
  speed3d: number; // m/s
  fix: number;     // 0 = no lock, 2 = 2-D, 3 = 3-D
  dop: number;
}

export interface ACCLSample {
  t: number; // ms from video start
  x: number; // m/s²
  y: number;
  z: number;
}

export interface GRAVSample {
  t: number; // ms from video start
  x: number; // unit vector component
  y: number;
  z: number;
}

export interface TelemetryResult {
  status: number;
  videoStartEpoch: number; // Unix seconds from MP4 mvhd box
  gps: GPS9Sample[];
  accl: ACCLSample[];
  grav: GRAVSample[];
}

export interface StravaGpsPoint {
  t: number;              // ms from video start (matches GPS9Sample.t for render-loop compat)
  lat: number;
  lon: number;
  ele: number;            // metres
  hr: number;             // beats per minute (0 if sensor absent)
  cad: number;            // pedal RPM (0 if sensor absent)
  speed: number;          // m/s derived from Haversine between adjacent points
  relativeTimeSec: number; // seconds from video start (pre-ms conversion, kept for debugging)
  absoluteUnixMs: number; // wall-clock ms from the GPX <time> element — survives re-anchoring
}

export interface LatLonBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

// ---------- Worker message protocol ----------

export interface WorkerRequest {
  metBytes: Uint8Array;   // Pre-extracted, pre-concatenated MET track bytes
  videoStartSec: number;  // Unix timestamp from MP4 mvhd (uint32 range)
}

export type WorkerResponse =
  | { ok: true; result: TelemetryResult }
  | { ok: false; code: number; message: string };
