import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { TelemetryResult } from './core/models/telemetry.model';
import { ClipMetadataDto } from './core/models/clip.model';
import { Mp4DemuxerService } from './core/services/mp4-demuxer';
import { GpmfParserService } from './core/services/gpmf-parser.service';
import { TelemetryMathService } from './core/services/telemetry-math';
import { ClipApiService, buildClipRequest } from './core/services/clip-api.service';
import { TelemetryVaultService } from './core/services/telemetry-vault.service';
import { TelemetryOverlay } from './core/components/telemetry-overlay/telemetry-overlay';
import { ThemeService } from './core/services/theme.service';
import { ALL_THEMES } from './core/models/theme.model';

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
  readonly videoSrc     = signal<string>('/assets/sample.mp4');
  readonly isProcessing = signal<boolean>(false);
  readonly feedEntries  = signal<FeedEntry[]>([]);
  readonly library      = signal<ClipMetadataDto[]>([]);
  pipelineError: string | null = null;

  readonly allThemes    = ALL_THEMES;
  readonly showMapPath  = signal<boolean>(false);

  private objectUrl: string | null = null;

  constructor(
    private readonly demuxer:      Mp4DemuxerService,
    private readonly parser:       GpmfParserService,
    private readonly math:         TelemetryMathService,
    private readonly clipApi:      ClipApiService,
    private readonly vault:        TelemetryVaultService,
    readonly         themeService: ThemeService,
  ) {}

  // Load the Library from PostgreSQL on app start. Failure is non-fatal —
  // the user can still parse new clips; the Library just starts empty.
  ngOnInit(): void {
    this.clipApi.getAll().subscribe({
      next:  clips => this.library.set(
        [...clips].sort((a, b) => new Date(b.parsedAt).getTime() - new Date(a.parsedAt).getTime()),
      ),
      error: err => console.warn('[API] GET /api/clips failed:', err),
    });
  }

  async onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.telemetry.set(null);
    this.feedEntries.set([]);
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
      console.log(
        `[DEMUXER] GPMD track extracted: ${metBytes.byteLength} bytes,` +
        ` videoStartSec=${videoStartSec}`,
      );

      // Stage 2 — Ephemeral Worker: send the flat Uint8Array to Go-WASM.
      // The worker instantiates a clean gpmf.wasm, runs manual BigEndian
      // decoding + Option B SCAL application, then self-terminates (Nuke Option).
      const result = await this.parser.parse(metBytes, videoStartSec);
      this.telemetry.set(result);
      console.log(
        `[PARSER] TelemetryResult: ${result.gps.length} GPS atoms,` +
        ` ${result.accl.length} ACCL atoms,` +
        ` ${result.grav.length} GRAV atoms`,
      );

      // Stage 3 — Vault write: persist heavy arrays to IndexedDB.
      // Must complete before the Library POST — if the POST succeeds but the
      // Vault write fails, a future lookup would find the summary in Postgres
      // but no arrays for playback. See Write-Through Cache Flow in skill.md.
      await this.vault.save(file.name, file.size, result);

      // Stage 4 — Library write-through: upsert the summary to PostgreSQL.
      // Fire-and-forget per the Data Boundary Rule; silent degradation on failure.
      this.clipApi.upsert(buildClipRequest(file, result)).subscribe({
        next: saved => this.library.update(existing => {
          const idx = existing.findIndex(c => c.id === saved.id);
          return idx >= 0
            ? [...existing.slice(0, idx), saved, ...existing.slice(idx + 1)]
            : [saved, ...existing];
        }),
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
