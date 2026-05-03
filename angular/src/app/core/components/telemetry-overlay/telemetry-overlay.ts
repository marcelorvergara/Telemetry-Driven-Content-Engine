import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { TelemetryResult } from '../../models/telemetry.model';
import { TelemetryMathService } from '../../services/telemetry-math';

// G-force thresholds for visual state transitions.
const SPIKE_THRESHOLD = 1.5;   // instant-snap on impact (no easing up)
const SEVERE_THRESHOLD = 3.0;  // RGB chromatic-aberration split on speed text
const MAX_G_SCALE = 4.0;       // bar and bloom full-scale reference

// Rates are per animation frame (~60 Hz).
const EASE_FACTOR = 0.10;           // drain: closes 10% of gap per frame
const PEAK_DECAY_PER_FRAME = 0.003; // ghost drifts ~0.18 G/s at 60 Hz

@Component({
  selector: 'app-telemetry-overlay',
  imports: [],
  templateUrl: './telemetry-overlay.html',
  styleUrl: './telemetry-overlay.scss',
})
export class TelemetryOverlay implements OnDestroy {
  // The video element whose currentTime drives the master clock.
  readonly videoEl = input.required<HTMLVideoElement>();
  // Null until the WASM parser completes; drawFrame bails early until then.
  readonly telemetry = input<TelemetryResult | null>(null);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly ngZone = inject(NgZone);
  private readonly math = inject(TelemetryMathService);

  readonly isExporting = signal<boolean>(false);

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  // Set during export; the rAF tick calls it after every drawFrame to capture the frame.
  private frameCapture: (() => void) | null = null;
  // CSS pixel dimensions of the canvas — drawing code uses these so the context
  // scale transform (DPR or export scale) maps them to the correct buffer pixels.
  private canvasWidth = 0;
  private canvasHeight = 0;
  private exportBlackBg = false;

  // ── Visual decay state ───────────────────────────────────────────────────────
  // All display state is strictly local to this component.
  private currentDisplayedGForce = 0;
  private peakGForce = 0;
  // Tracks the active TelemetryResult reference so decay state resets on new load.
  private activeTelemetry: TelemetryResult | null = null;

  constructor() {
    // afterNextRender fires once after the first DOM render — safe to read
    // nativeElement and begin the rAF loop.
    afterNextRender(() => {
      this.canvas = this.canvasRef().nativeElement;
      this.ctx = this.canvas.getContext('2d')!;
      this.startLoop();
    });
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  // Uses WebCodecs VideoEncoder (not MediaRecorder) so the VP9 alpha plane is
  // preserved — MediaRecorder silently discards alpha even with the VP9 codec.
  async startExport(): Promise<void> {
    if (typeof VideoEncoder === 'undefined') {
      console.error('[EXPORT] WebCodecs VideoEncoder not available in this browser');
      return;
    }

    const videoEl = this.videoEl();

    // Scale canvas buffer to the video's native resolution for a crisp export.
    const cssW   = this.canvasWidth  || this.canvas.clientWidth;
    const cssH   = this.canvasHeight || this.canvas.clientHeight;
    const exportW = videoEl.videoWidth  || Math.round(cssW * (window.devicePixelRatio || 1));
    const exportH = videoEl.videoHeight || Math.round(cssH * (window.devicePixelRatio || 1));
    this.canvas.width  = exportW;
    this.canvas.height = exportH;
    this.ctx.scale(exportW / cssW, exportH / cssH);

    // VP9 alpha encoding is not yet supported in Chrome WebCodecs (as of 2025).
    // isConfigSupported() detects this before we commit, avoiding a closed-encoder crash loop.
    const alphaConfig = {
      codec: 'vp09.00.10.08', width: exportW, height: exportH,
      bitrate: 8_000_000, framerate: 60, alpha: 'keep',
    } as unknown as VideoEncoderConfig;
    const { supported: alphaOk } = await VideoEncoder.isConfigSupported(alphaConfig);
    const useAlpha = alphaOk === true;
    if (!useAlpha) {
      console.warn('[EXPORT] VP9 alpha not supported — black background used. Apply Screen blend mode in CapCut.');
      this.exportBlackBg = true;
    }

    const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
    const target = new ArrayBufferTarget();
    const muxer  = new Muxer({
      target,
      video: { codec: 'V_VP9', width: exportW, height: exportH, alpha: useAlpha },
      firstTimestampBehavior: 'offset',
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error:  e => console.error('[EXPORT] Encoder:', e),
    });
    encoder.configure(useAlpha ? alphaConfig : {
      codec: 'vp09.00.10.08', width: exportW, height: exportH,
      bitrate: 8_000_000, framerate: 60,
    });

    let frameCount   = 0;
    let lastTsUs     = -1;
    let finalizing   = false;

    const finalize = async () => {
      this.frameCapture = null;
      await encoder.flush();
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'telemetry-overlay.webm';
      a.click();
      URL.revokeObjectURL(url);
      this.canvasWidth = 0; // let syncCanvasSize restore DPR display resolution
      this.exportBlackBg = false;
      this.isExporting.set(false);
    };

    this.frameCapture = () => {
      if (videoEl.ended) {
        if (!finalizing) { finalizing = true; finalize(); }
        return;
      }
      if (encoder.state === 'closed') return;
      const tsUs = Math.round(videoEl.currentTime * 1_000_000);
      if (tsUs <= lastTsUs) return; // skip duplicate timestamps between rAF ticks
      lastTsUs = tsUs;
      const frame = new VideoFrame(this.canvas, { timestamp: tsUs });
      encoder.encode(frame, { keyFrame: frameCount % 150 === 0 });
      frame.close();
      frameCount++;
    };

    videoEl.currentTime = 0;
    this.isExporting.set(true);
    videoEl.play();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.frameCapture = null;
  }

  // ── Loop ────────────────────────────────────────────────────────────────────

  private startLoop(): void {
    // Runs entirely outside Angular's change-detection zone.
    // Never call NgZone.run() from inside tick() — the loop is fire-and-forget.
    this.ngZone.runOutsideAngular(() => {
      const tick = () => {
        this.syncCanvasSize();
        this.drawFrame();
        this.frameCapture?.();
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    });
  }

  // Keep the canvas buffer resolution in sync with its CSS-rendered size,
  // scaled by devicePixelRatio so text is crisp on HiDPI displays.
  // Skipped during export — startExport() owns the buffer dimensions then.
  // Resizing the buffer resets all context state, so ctx.scale() is re-applied here.
  private syncCanvasSize(): void {
    if (this.isExporting()) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (this.canvasWidth !== w || this.canvasHeight !== h)) {
      this.canvasWidth  = w;
      this.canvasHeight = h;
      this.canvas.width  = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.scale(dpr, dpr);
    }
  }

  // ── Render pipeline ─────────────────────────────────────────────────────────

  private drawFrame(): void {
    const telemetry = this.telemetry();
    if (this.canvasWidth === 0 || this.canvasHeight === 0 || !telemetry) return;

    // Reset decay state whenever a new file is loaded.
    if (telemetry !== this.activeTelemetry) {
      this.currentDisplayedGForce = 0;
      this.peakGForce = 0;
      this.activeTelemetry = telemetry;
    }

    const ctx     = this.ctx;
    const videoEl = this.videoEl();
    const duration    = videoEl.duration;
    const currentTime = videoEl.currentTime;
    // ACCL timestamps are synthesised via a global cumulative counter (correct
    // across STRM blocks) → use raw video-relative ms directly.
    const relativeTimeMs = currentTime * 1000;

    if (this.exportBlackBg) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
    } else {
      ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    }

    // GPS speed: prefer locked samples (fix >= 2) with timestamp-based interpolation.
    // GPS9 locked samples carry valid UTC-anchored .t values (video-relative ms).
    // Fall back to progress-based indexing when no locked samples exist (GPS5 or
    // no-fix GPS9 — both lack reliable timestamps).
    const gps = telemetry.gps;
    let speed = 0;
    const lockedGPS = gps.filter(g => g.fix >= 2);
    if (lockedGPS.length > 0) {
      speed = this.math.interpolateSpeed(lockedGPS, relativeTimeMs);
    } else if (gps.length > 0 && isFinite(duration) && duration > 0) {
      const fIdx  = Math.max(0, Math.min(1, currentTime / duration)) * (gps.length - 1);
      const lo    = Math.floor(fIdx);
      const hi    = Math.min(lo + 1, gps.length - 1);
      const alpha = fIdx - lo;
      speed = gps[lo].speed2d + (gps[hi].speed2d - gps[lo].speed2d) * alpha;
    }

    const acclAtom = this.math.findClosestAtom(telemetry.accl, relativeTimeMs);
    const rawG     = acclAtom ? this.math.calculateGForceMagnitude(acclAtom) : 0;

    // ── Decay / ghost update ─────────────────────────────────────────────────
    // Spike instantly on any impact above the threshold (rawG > current).
    // For all other directions (drain, recovery below threshold), ease smoothly.
    if (rawG > SPIKE_THRESHOLD && rawG > this.currentDisplayedGForce) {
      this.currentDisplayedGForce = rawG;
    } else {
      this.currentDisplayedGForce += (rawG - this.currentDisplayedGForce) * EASE_FACTOR;
    }

    // Peak rises instantly to match any new maximum; then drifts down at a fixed
    // slow rate so the ghost marker persists well after the impact.
    if (rawG >= this.peakGForce) {
      this.peakGForce = rawG;
    } else {
      this.peakGForce = Math.max(this.peakGForce - PEAK_DECAY_PER_FRAME, 0);
    }

    this.drawSpeedReadout(ctx, speed);
    this.drawGForceBar(ctx, this.currentDisplayedGForce, this.peakGForce);
  }

  // ── Bloom helper ─────────────────────────────────────────────────────────────

  // Maps currentDisplayedGForce onto a { blur, color } pair consumed by all
  // three drawing primitives. At 0 G: subtle cyan pulse. At MAX_G_SCALE: magenta
  // explosion. All Canvas shadowBlur values flow through here.
  private bloomParams(): { blur: number; color: string } {
    const t = Math.min(this.currentDisplayedGForce / MAX_G_SCALE, 1);
    return {
      blur:  6 + t * 42,           // 6 at rest → 48 at peak
      color: t > 0.5 ? '#FF00FF' : '#00FFFF',
    };
  }

  // ── Drawing primitives ───────────────────────────────────────────────────────

  private drawSpeedReadout(ctx: CanvasRenderingContext2D, speedMs: number): void {
    const height = this.canvasHeight;
    // Round to nearest integer — eliminates sub-millisecond GPS interpolation jitter.
    const kmh = Math.round(speedMs * 3.6);
    const bigPx   = Math.max(16, Math.round(height * 0.095));
    const smallPx = Math.max(10, Math.round(height * 0.042));
    const font  = '"Consolas", "Courier New", monospace';
    const x     = 24;
    const yBig   = height - smallPx - 12;
    const ySmall = height - 10;

    const { blur, color } = this.bloomParams();

    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${bigPx}px ${font}`;

    if (this.currentDisplayedGForce >= SEVERE_THRESHOLD) {
      // Chromatic-aberration split: two offset copies (cyan left, magenta right)
      // simulate camera shake on hard impact. Offset scales with excess G-force.
      const offset = Math.max(1, Math.round((this.currentDisplayedGForce - SEVERE_THRESHOLD) * 3));
      ctx.shadowBlur = blur;

      ctx.shadowColor = '#00FFFF';
      ctx.fillStyle   = 'rgba(0, 255, 255, 0.75)';
      ctx.fillText(String(kmh), x - offset, yBig);

      ctx.shadowColor = '#FF00FF';
      ctx.fillStyle   = 'rgba(255, 0, 255, 0.75)';
      ctx.fillText(String(kmh), x + offset, yBig);

      // White composite on top binds the two channels.
      ctx.shadowColor = '#FFFFFF';
      ctx.fillStyle   = '#FFFFFF';
      ctx.fillText(String(kmh), x, yBig);
    } else {
      ctx.shadowColor = color;
      ctx.shadowBlur  = blur;
      ctx.fillStyle   = '#00FFFF';
      ctx.fillText(String(kmh), x, yBig);
    }

    ctx.font        = `${smallPx}px ${font}`;
    ctx.shadowColor = '#00FFFF';
    ctx.shadowBlur  = Math.min(blur * 0.4, 10);
    ctx.fillStyle   = '#00FFFF';
    ctx.fillText('KM/H', x, ySmall);

    ctx.shadowBlur = 0;
  }

  private drawGForceBar(
    ctx: CanvasRenderingContext2D,
    gForce: number,
    peak: number,
  ): void {
    const width  = this.canvasWidth;
    const height = this.canvasHeight;
    const fill     = Math.min(gForce / MAX_G_SCALE, 1);
    const peakFill = Math.min(peak / MAX_G_SCALE, 1);
    const barW    = Math.round(width * 0.22);
    const barH    = 10;
    const x       = width - barW - 24;
    const barY    = height - barH - 4;
    const labelPx = Math.max(10, Math.round(height * 0.038));
    const font    = '"Consolas", "Courier New", monospace';

    const { blur, color } = this.bloomParams();

    // Label — bloom intensity drives glow color and blur.
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = color;
    ctx.shadowColor  = color;
    ctx.shadowBlur   = blur;
    ctx.font = `${labelPx}px ${font}`;
    ctx.fillText(`${gForce.toFixed(2)} G`, x, barY - 8);

    // Track outline
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = '#FF00FF';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x, barY, barW, barH);

    // Fill — glow scales with bloom.
    if (fill > 0) {
      ctx.fillStyle   = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = blur * 0.4;
      ctx.fillRect(x, barY, Math.round(barW * fill), barH);
    }

    // Ghost peak marker: thin vertical line that lingers above the current fill,
    // marking the maximum impact point while it slowly drifts toward zero.
    if (peakFill > fill && peak > 0.05) {
      const markerX = x + Math.round(barW * peakFill);
      ctx.strokeStyle = '#FF00FF';
      ctx.shadowColor = '#FF00FF';
      ctx.shadowBlur  = blur * 0.6;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(markerX, barY - 2);
      ctx.lineTo(markerX, barY + barH + 2);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
  }

}
