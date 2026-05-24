import { Component, OnDestroy, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TelemetryResult, StravaGpsPoint } from './core/models/telemetry.model';
import { ClipMetadataDto, StreetTimelineEntry } from './core/models/clip.model';
import { Mp4DemuxerService } from './core/services/mp4-demuxer';
import { GpmfParserService } from './core/services/gpmf-parser.service';
import { TelemetryMathService } from './core/services/telemetry-math';
import { ClipApiService, buildClipRequest } from './core/services/clip-api.service';
import { TelemetryVaultService } from './core/services/telemetry-vault.service';
import { StravaTelemetryService } from './core/services/strava-telemetry.service';
import { TelemetryOverlay } from './core/components/telemetry-overlay/telemetry-overlay';
import { ThemeService } from './core/services/theme.service';
import { ALL_THEMES } from './core/models/theme.model';

// Unix epoch (seconds) of the exact moment tiny_showcase.mp4 starts recording.
// Extracted once from the original GX011209.MP4 via the demuxer's videoStartSec
// output — replace [PLACEHOLDER] with that value before deploying.
const SHOWCASE_VIDEO_START_SEC = 1778407717; // videoStartSec of GX011209.MP4 (1778407657) + 60 s clip offset

// Hardcoded street timeline for the showcase clip — bypasses Google Maps API quota.
// Replace streetName values after reviewing the actual footage route.
const SHOWCASE_STREET_TIMELINE: StreetTimelineEntry[] = [
  { t:      0, streetName: 'Avenida das Américas'    },
  { t:  30000, streetName: 'Estrada dos Bandeirantes' },
  { t:  60000, streetName: 'Rua Engenheiro Trindade'  },
];

interface FeedEntry {
  t: number;        // ms from video start
  speedKmh: number;
  gForce: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [TelemetryOverlay],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  readonly telemetry    = signal<TelemetryResult | null>(null);
  readonly videoSrc     = signal<string>('assets/tiny_showcase.mp4');
  readonly isProcessing = signal<boolean>(false);
  readonly feedEntries      = signal<FeedEntry[]>([]);
  readonly library          = signal<ClipMetadataDto[]>([]);
  readonly streetTimeline   = signal<StreetTimelineEntry[]>([]);
  pipelineError: string | null = null;

  readonly allThemes       = ALL_THEMES;
  readonly showStreetName = signal<boolean>(true);
  readonly showMapPath    = signal<boolean>(false);
  readonly mapZoom      = signal<number>(1);
  readonly zoomLabel    = computed(() => {
    const z = this.mapZoom();
    if (z < -1.5) return 'FULL';
    if (z < -0.5) return 'MID';
    if (z <= 0)   return 'LOCAL';
    if (z <= 1)   return '1×';
    return `${z.toFixed(1)}×`;
  });
  readonly mapMode         = signal<'segment' | 'full'>('segment');
  readonly telemetrySource = signal<'GoPro' | 'Strava'>('GoPro');
  readonly stravaGps          = signal<StravaGpsPoint[]>([]);
  readonly syncOffsetMs       = signal<number>(0);
  readonly hasGoProTelemetry  = computed(() => {
    const t = this.telemetry();
    return !!(t && (t.gps.length > 0 || t.accl.length > 0));
  });

  private objectUrl: string | null = null;

  constructor(
    private readonly demuxer:        Mp4DemuxerService,
    private readonly parser:         GpmfParserService,
    private readonly math:           TelemetryMathService,
    private readonly clipApi:        ClipApiService,
    private readonly vault:          TelemetryVaultService,
    private readonly stravaService:  StravaTelemetryService,
    readonly         themeService:   ThemeService,
    private readonly http:           HttpClient,
  ) {}

  ngOnInit(): void {
    this.clipApi.getAll().subscribe({
      next:  clips => this.library.set(
        [...clips].sort((a, b) => new Date(b.parsedAt).getTime() - new Date(a.parsedAt).getTime()),
      ),
      error: err => console.warn('[API] GET /api/clips failed:', err),
    });
    this.loadDefaultAssets();
  }

  private async loadDefaultAssets(): Promise<void> {
    this.telemetrySource.set('Strava');
    this.isProcessing.set(true);
    this.videoSrc.set('assets/tiny_showcase.mp4');

    try {
      const [binBuffer, gpxBlob] = await Promise.all([
        firstValueFrom(this.http.get('assets/telemetry_sample.bin', { responseType: 'arraybuffer' })),
        firstValueFrom(this.http.get('assets/strava%2010052026.gpx', { responseType: 'blob' })),
      ]);

      // Bypass the demuxer — feed the pre-extracted GPMF binary directly to WASM.
      const metBytes = new Uint8Array(binBuffer);
      const result = await this.parser.parse(metBytes, SHOWCASE_VIDEO_START_SEC);
      this.telemetry.set(result);

      await this.vault.save('tiny_showcase.mp4', 0, result);

      const showcaseFile = new File([], 'tiny_showcase.mp4', { type: 'video/mp4' });
      this.clipApi.upsert(buildClipRequest(showcaseFile, result)).subscribe({
        next: saved => this.library.update(existing => {
          const idx = existing.findIndex(c => c.id === saved.id);
          return idx >= 0
            ? [...existing.slice(0, idx), saved, ...existing.slice(idx + 1)]
            : [saved, ...existing];
        }),
        error: err => console.warn('[API] POST /api/clips failed (silent degradation):', err),
      });

      // GPX parsed after MP4 so videoStartEpoch is known — no re-anchor needed.
      const gpxFile = new File([gpxBlob], 'strava 10052026.gpx', { type: 'application/gpx+xml' });
      await this.processGpxFile(gpxFile);

      // Showcase bypasses the geocoding API — use the hardcoded constant instead.
      this.streetTimeline.set(SHOWCASE_STREET_TIMELINE);

      this.showMapPath.set(true);
      this.mapMode.set('full');

    } catch (err) {
      this.pipelineError = String(err);
      console.warn('[AUTO-LOAD] Failed to load default assets:', err);
    } finally {
      this.isProcessing.set(false);
    }
  }

  async onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await this.processFile(file);
  }

  private async processFile(file: File): Promise<void> {
    this.syncOffsetMs.set(0);
    this.telemetry.set(null);
    this.feedEntries.set([]);
    this.streetTimeline.set([]);
    this.pipelineError = null;
    this.isProcessing.set(true);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.videoSrc.set(this.objectUrl);

    try {
      // Stage 1 — In-browser MP4 demux: extract the lean GPMF binary payload.
      // Reads the file in 1 MB chunks; only the telemetry track bytes accumulate
      // in memory (~1–5 MB). Video/audio mdat bytes are never materialised.
      const { metBytes, videoStartSec } = await this.demuxer.extract(file);

      // Stage 2 — Ephemeral Worker: send the flat Uint8Array to Go-WASM.
      // The worker instantiates a clean gpmf.wasm, runs manual BigEndian
      // decoding + Option B SCAL application, then self-terminates (Nuke Option).
      // Short-circuit for standard (non-GoPro) MP4s: demuxer returns empty bytes
      // when no gpmd track exists. Set an empty result so the no-telemetry banner
      // fires and the user can proceed with a Strava GPX only.
      if (metBytes.length === 0) {
        this.telemetry.set({ status: 3, videoStartEpoch: videoStartSec, gps: [], accl: [], grav: [] });
        return;
      }
      const result = await this.parser.parse(metBytes, videoStartSec);
      this.telemetry.set(result);

      // Re-anchor Strava points if they were loaded before this video.
      // When GPX is uploaded first, videoStartSec=0 is used and .t values become
      // absolute Unix ms (~1.7T ms). Re-anchor using the actual videoStartEpoch.
      if (this.stravaGps().length > 0) {
        const videoStartMs = result.videoStartEpoch * 1000;
        this.stravaGps.update(pts => pts.map(p => ({
          ...p,
          t:               p.absoluteUnixMs - videoStartMs,
          relativeTimeSec: (p.absoluteUnixMs - videoStartMs) / 1000,
        })));
      }

      // Stage 3 — Vault write: persist heavy arrays to IndexedDB.
      // Must complete before the Library POST — if the POST succeeds but the
      // Vault write fails, a future lookup would find the summary in Postgres
      // but no arrays for playback. See Write-Through Cache Flow in skill.md.
      await this.vault.save(file.name, file.size, result);

      // Stage 4 — Library write-through: upsert the summary to PostgreSQL.
      // Fire-and-forget per the Data Boundary Rule; silent degradation on failure.
      // stravaGps() is forwarded so the backend can geocode Strava waypoints when
      // GoPro GPS is absent (smartphone-only pipeline).
      this.clipApi.upsert(buildClipRequest(file, result, this.stravaGps())).subscribe({
        next: saved => {
          this.streetTimeline.set(saved.streetTimeline ?? []);
          this.library.update(existing => {
            const idx = existing.findIndex(c => c.id === saved.id);
            return idx >= 0
              ? [...existing.slice(0, idx), saved, ...existing.slice(idx + 1)]
              : [saved, ...existing];
          });
        },
        error: err => console.warn('[API] POST /api/clips failed (silent degradation):', err),
      });

    } catch (err) {
      this.pipelineError = String(err);
      console.error('[PIPELINE] Failure:', err);
    } finally {
      this.isProcessing.set(false);
    }
  }

  // Driven by the video's (timeupdate) event (~4 Hz during playback).
  // Mirrors the overlay's speed/G-force computation but without the visual
  // decay state — the feed shows instantaneous readings.
  onTimeUpdate(videoEl: HTMLVideoElement): void {
    const telemetry = this.telemetry();
    if (!telemetry) return;

    const relTimeMs = videoEl.currentTime * 1000;
    const gps = telemetry.gps;
    let speedMs = 0;
    const lockedGPS = gps.filter(g => g.fix >= 2);
    if (lockedGPS.length > 0) {
      speedMs = this.math.interpolateSpeed(lockedGPS, relTimeMs);
    } else if (gps.length > 0 && isFinite(videoEl.duration) && videoEl.duration > 0) {
      const fIdx  = Math.max(0, Math.min(1, videoEl.currentTime / videoEl.duration)) * (gps.length - 1);
      const lo    = Math.floor(fIdx);
      const hi    = Math.min(lo + 1, gps.length - 1);
      const alpha = fIdx - lo;
      speedMs = gps[lo].speed2d + (gps[hi].speed2d - gps[lo].speed2d) * alpha;
    }

    const acclAtom = this.math.findClosestAtom(telemetry.accl, relTimeMs);
    const gForce   = acclAtom ? this.math.calculateGForceMagnitude(acclAtom) : 0;

    this.feedEntries.update(prev => [{
      t:        relTimeMs,
      speedKmh: Math.round(speedMs * 3.6),
      gForce:   +gForce.toFixed(2),
    }, ...prev].slice(0, 10));
  }

  setTelemetrySource(source: 'GoPro' | 'Strava'): void {
    this.telemetrySource.set(source);
  }

  setMapMode(mode: 'segment' | 'full'): void {
    this.mapMode.set(mode);
    if (mode === 'segment' && this.mapZoom() < 1) {
      this.mapZoom.set(1);
    }
  }

  onSyncOffsetChange(offsetMs: number): void {
    this.syncOffsetMs.set(offsetMs);
  }

  onSyncNudge(deltaMs: number): void {
    this.syncOffsetMs.update(v => v + deltaMs);
  }

  async onGpxSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await this.processGpxFile(file);
  }

  private async processGpxFile(file: File): Promise<void> {
    this.syncOffsetMs.set(0);
    const videoStartSec = this.telemetry()?.videoStartEpoch ?? 0;
    const data = await this.stravaService.parseGpx(file, videoStartSec);
    this.stravaGps.set(data);
  }

  formatTime(ms: number): string {
    const s   = ms / 1000;
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  formatSpeedKmh(ms: number | null): string {
    return ms !== null ? `${(ms * 3.6).toFixed(0)} KM/H` : '—';
  }

  formatDistanceKm(m: number | null): string {
    return m !== null ? `${(m / 1000).toFixed(1)} KM` : '—';
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  ngOnDestroy(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
