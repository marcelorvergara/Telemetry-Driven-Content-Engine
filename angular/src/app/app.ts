import { Component, OnDestroy, signal } from '@angular/core';
import { TelemetryResult } from './core/models/telemetry.model';
import { Mp4DemuxerService } from './core/services/mp4-demuxer';
import { GpmfParserService } from './core/services/gpmf-parser.service';
import { TelemetryOverlay } from './core/components/telemetry-overlay/telemetry-overlay';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [TelemetryOverlay],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class AppComponent implements OnDestroy {
  readonly telemetry = signal<TelemetryResult | null>(null);
  readonly videoSrc = signal<string>('/assets/sample.mp4');
  readonly isProcessing = signal<boolean>(false);
  pipelineError: string | null = null;

  private objectUrl: string | null = null;

  constructor(
    private readonly demuxer: Mp4DemuxerService,
    private readonly parser: GpmfParserService,
  ) {}

  async onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    // Teardown previous state
    this.telemetry.set(null);
    this.pipelineError = null;
    this.isProcessing.set(true);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
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
      if (result.gps.length >= 2) {
        const dt = result.gps[1].t - result.gps[0].t;
        const unit = dt >= 10 ? 'ms' : dt >= 0.05 ? 's' : 'unknown';
        console.log(
          `[GPS] t[0]=${result.gps[0].t}  t[last]=${result.gps[result.gps.length - 1].t}` +
          `  dt=${dt}  inferred-unit=${unit}`,
        );
      }
      console.table(result.gps.slice(0, 5).map(g => ({
        t:            g.t.toFixed(1),
        lat:          g.lat.toFixed(6),
        lon:          g.lon.toFixed(6),
        speed2d_raw:  g.speed2d,
        speed2d_kmh:  (g.speed2d * 3.6).toFixed(2),
        speed3d_raw:  g.speed3d,
        fix:          g.fix,
      })));

      if (result.accl.length > 0) {
        const G = 9.81;
        // Sample every 40th atom (~5 samples/sec from 200 Hz) to get a spread across the clip.
        const stride = Math.max(1, Math.floor(result.accl.length / 20));
        console.log(`[ACCL] ${result.accl.length} atoms  dt=${(result.accl[1]?.t - result.accl[0]?.t).toFixed(2)} ms  t[last]=${result.accl[result.accl.length - 1].t.toFixed(0)} ms`);
        console.table(
          Array.from({ length: 20 }, (_, i) => result.accl[Math.min(i * stride, result.accl.length - 1)])
            .map(a => {
              const mag = Math.sqrt(a.x ** 2 + a.y ** 2 + a.z ** 2);
              return {
                t_ms:   a.t.toFixed(0),
                x:      a.x.toFixed(3),
                y:      a.y.toFixed(3),
                z:      a.z.toFixed(3),
                mag_ms2: mag.toFixed(3),
                mag_G:  (mag / G).toFixed(3),
                delta_G: Math.abs(mag - G).toFixed(3),
              };
            })
        );
      }
    } catch (err) {
      this.pipelineError = String(err);
      console.error('[PIPELINE] Failure:', err);
    } finally {
      this.isProcessing.set(false);
    }
  }

  ngOnDestroy(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
