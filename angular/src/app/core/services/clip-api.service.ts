import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ClipMetadataDto, CreateClipRequest, GpsSnapshotPoint } from '../models/clip.model';
import { TelemetryResult, GPS9Sample, ACCLSample, StravaGpsPoint } from '../models/telemetry.model';

// ── Extraction constants ─────────────────────────────────────────────────────

const G                    = 9.80665; // m/s²
const TOP_HIGHLIGHTS       = 5;
const SNAPSHOT_INTERVAL_MS = 5_000;   // one geocode point per 5 s of video

// ── Public extraction helper ─────────────────────────────────────────────────
// Derives the ClipMetadata summary from the raw WASM parse result and the
// original File object. All heavy arrays stay in the caller — only scalars,
// a tiny highlights array, and a sparse GPS snapshot array leave here.

export function buildClipRequest(
  file: File,
  result: TelemetryResult,
  stravaGps: StravaGpsPoint[] = [],
): CreateClipRequest {
  const lockedGps = result.gps.filter(g => g.fix >= 2);

  const maxSpeed = result.gps.length > 0
    ? result.gps.reduce((m, g) => Math.max(m, g.speed2d), 0)
    : null;

  const start = lockedGps[0]                      ?? null;
  const end   = lockedGps[lockedGps.length - 1]   ?? null;

  // Approximate duration from the furthest telemetry timestamp (ms → s).
  const lastT = Math.max(
    result.gps.at(-1)?.t  ?? 0,
    result.accl.at(-1)?.t ?? 0,
  );

  // For geocoding: prefer locked GPS, then GPS9 samples with non-zero coords
  // (fix<2 but receiver still output a real position). Zero lat/lon means the
  // receiver had no position data — sending 0,0 to Google Maps returns the Gulf
  // of Guinea, so those samples are excluded and Strava becomes the fallback.
  const snapshotGps = lockedGps.length > 0
    ? lockedGps
    : result.gps.filter(g => g.lat !== 0 || g.lon !== 0);

  return {
    filename:         file.name,
    fileSize:         file.size,
    maxSpeed,
    totalDistanceM:   calcTotalDistanceM(lockedGps),
    videoDurationSec: lastT > 0 ? lastT / 1000 : null,
    startLat:         start?.lat ?? null,
    startLon:         start?.lon ?? null,
    endLat:           end?.lat   ?? null,
    endLon:           end?.lon   ?? null,
    // GPS source is not yet surfaced by the parser; default to GPS9 when
    // samples exist. Add a gpsSource field to TelemetryResult when GPS5
    // fallback clips need to be distinguished in the Library.
    gpsSource:        result.gps.length > 0 ? 'GPS9' : null,
    highlights:       calcHighlights(result.accl),
    sessionId:        null,
    gpsSnapshots:     buildGpsSnapshots(snapshotGps, stravaGps, lastT),
  };
}

// ── Private helpers ──────────────────────────────────────────────────────────

// Samples one GPS coordinate per SNAPSHOT_INTERVAL_MS for geocoding.
// Strava is preferred over GoPro when available — firmware-smoothed wearable
// coordinates produce cleaner street name resolution than GoPro GPS multipath.
// Strava .t is already anchored to video start (ms), so no remapping is needed;
// filtering to [0, durationMs] ensures only clip-window points are geocoded.
// Returns null when no valid source exists (e.g. file has neither GPS track).
function buildGpsSnapshots(
  goProGps: GPS9Sample[],
  stravaGps: StravaGpsPoint[],
  durationMs: number,
): GpsSnapshotPoint[] | null {
  const useStrava = stravaGps.length > 0;
  const useGoPro  = !useStrava && goProGps.length > 0;
  if (!useStrava && !useGoPro) return null;

  const source: { t: number; lat: number; lon: number }[] = useStrava
    ? stravaGps.filter(p => p.t >= 0 && p.t <= durationMs)
    : goProGps;

  if (source.length === 0) return null;

  const snapshots: GpsSnapshotPoint[] = [];
  const seen = new Set<number>();

  for (let targetT = 0; targetT <= durationMs; targetT += SNAPSHOT_INTERVAL_MS) {
    const point = floorSearch(source, targetT);
    if (point && !seen.has(point.t)) {
      seen.add(point.t);
      snapshots.push({ t: point.t, lat: point.lat, lon: point.lon });
    }
  }

  return snapshots.length > 0 ? snapshots : null;
}

// Binary search: returns the last element whose .t <= targetT, or null.
function floorSearch(
  arr: { t: number; lat: number; lon: number }[],
  targetT: number,
): { t: number; lat: number; lon: number } | null {
  let lo = 0, hi = arr.length - 1;
  let result: { t: number; lat: number; lon: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= targetT) { result = arr[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

// Trapezoidal integration of speed2d over time for locked GPS points.
// More accurate than summing raw haversine deltas at 18 Hz sample rate.
function calcTotalDistanceM(locked: GPS9Sample[]): number | null {
  if (locked.length < 2) return null;
  let total = 0;
  for (let i = 1; i < locked.length; i++) {
    const dt = (locked[i].t - locked[i - 1].t) / 1000; // ms → s
    total += ((locked[i].speed2d + locked[i - 1].speed2d) / 2) * dt;
  }
  return total;
}

// Top-5 peak G-force events by magnitude, returned as ms-from-video-start
// timestamps so the overlay can seek directly to them.
function calcHighlights(accl: ACCLSample[]): number[] | null {
  if (accl.length === 0) return null;
  return accl
    .map(a => ({ t: a.t, g: Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / G }))
    .sort((a, b) => b.g - a.g)
    .slice(0, TOP_HIGHLIGHTS)
    .map(s => s.t);
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ClipApiService {
  private readonly base = `${environment.apiBaseUrl}/api/clips`;

  constructor(private readonly http: HttpClient) {}

  getAll(): Observable<ClipMetadataDto[]> {
    return this.http.get<ClipMetadataDto[]>(this.base);
  }

  upsert(req: CreateClipRequest): Observable<ClipMetadataDto> {
    return this.http.post<ClipMetadataDto>(this.base, req);
  }
}
