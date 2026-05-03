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
const SPIKE_THRESHOLD  = 1.5;
const SEVERE_THRESHOLD = 3.0;
const MAX_G_SCALE      = 4.0;

// Rates are per animation frame (~60 Hz).
const EASE_FACTOR          = 0.10;
const PEAK_DECAY_PER_FRAME = 0.003;

// Ghost canvas export resolution — gauges are vector text/lines so 1080p is
// sufficient quality and avoids the CPU/memory choke of a 4K canvas buffer.
const EXPORT_W = 1920;
const EXPORT_H = 1080;

@Component({
  selector: 'app-telemetry-overlay',
  imports: [],
  templateUrl: './telemetry-overlay.html',
  styleUrl: './telemetry-overlay.scss',
})
export class TelemetryOverlay implements OnDestroy {
  readonly videoEl   = input.required<HTMLVideoElement>();
  readonly telemetry = input<TelemetryResult | null>(null);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly ngZone    = inject(NgZone);
  private readonly math      = inject(TelemetryMathService);

  readonly isExporting = signal<boolean>(false);

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  private canvasWidth  = 0;
  private canvasHeight = 0;

  // ── Visual decay state ───────────────────────────────────────────────────
  private currentDisplayedGForce = 0;
  private peakGForce              = 0;
  private activeTelemetry: TelemetryResult | null = null;
  // Last speed computed by drawFrame — read by the export ghost canvas so
  // it does not need to re-run GPS interpolation per video frame.
  private lastSpeed = 0;

  // ── Ghost canvas export state ────────────────────────────────────────────
  private mediaRecorder:    MediaRecorder | null = null;
  private recordedChunks:   Blob[] = [];
  // Stored so stopExport() can removeEventListener if the user cancels before
  // the video reaches its natural end (prevents a stale listener memory leak).
  private exportVideoEl:     HTMLVideoElement | null = null;
  private videoEndedHandler: (() => void) | null = null;

  constructor() {
    afterNextRender(() => {
      this.canvas = this.canvasRef().nativeElement;
      this.ctx    = this.canvas.getContext('2d')!;
      this.startLoop();
    });
  }

  // ── Export ──────────────────────────────────────────────────────────────

  async startExport(): Promise<void> {
    if (typeof MediaRecorder === 'undefined') {
      console.error('[EXPORT] MediaRecorder not available');
      return;
    }
    const videoEl = this.videoEl();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (videoEl as any).requestVideoFrameCallback !== 'function') {
      console.error('[EXPORT] requestVideoFrameCallback not supported in this browser');
      return;
    }

    // Ghost canvas: exists only in JS heap, never appended to the DOM.
    // MediaRecorder captures this canvas; the display canvas is untouched
    // so the user can watch the video and see the live overlay throughout.
    const ghost    = document.createElement('canvas');
    ghost.width    = EXPORT_W;
    ghost.height   = EXPORT_H;
    const ghostCtx = ghost.getContext('2d')!;
    this.recordedChunks = [];

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';

    const stream   = ghost.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 5_000_000,
    });
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    recorder.onstop = () => {
      // Normal completion: ended listener already fired and was auto-removed
      // by { once: true }, but we still null the references for symmetry.
      this.exportVideoEl     = null;
      this.videoEndedHandler = null;
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'telemetry-overlay.webm';
      a.click();
      URL.revokeObjectURL(url);
      this.recordedChunks = [];
      this.mediaRecorder  = null;
      this.isExporting.set(false);
    };

    recorder.start();
    this.isExporting.set(true);
    videoEl.currentTime = 0;

    // requestVideoFrameCallback fires exactly once per decoded video frame.
    // Re-arming from inside the callback means we only wake up when a real
    // frame arrives — no CPU churn between frames, no duplicate captures.
    const onFrame = (_now: DOMHighResTimeStamp, _meta: unknown): void => {
      if (!this.isExporting()) return;

      // Black background so the gauges are visible on Screen blend mode.
      ghostCtx.fillStyle = '#000000';
      ghostCtx.fillRect(0, 0, EXPORT_W, EXPORT_H);
      this.drawSpeedReadout(ghostCtx, EXPORT_W, EXPORT_H, this.lastSpeed);
      this.drawGForceBar(ghostCtx, EXPORT_W, EXPORT_H, this.currentDisplayedGForce, this.peakGForce);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (videoEl as any).requestVideoFrameCallback(onFrame);
    };

    // 'ended' is handled by a dedicated one-time listener rather than a
    // check inside onFrame. requestVideoFrameCallback can stop firing a few
    // frames before videoEl.ended becomes true, so relying on it for the
    // stop trigger causes the recorder to hang at the end of the video.
    this.exportVideoEl     = videoEl;
    this.videoEndedHandler = () => recorder.stop();
    videoEl.addEventListener('ended', this.videoEndedHandler, { once: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (videoEl as any).requestVideoFrameCallback(onFrame);
    videoEl.play();
  }

  private stopExport(): void {
    // Remove the ended listener before stopping so it cannot fire after
    // cleanup and call stop() on an already-stopped recorder.
    if (this.exportVideoEl && this.videoEndedHandler) {
      this.exportVideoEl.removeEventListener('ended', this.videoEndedHandler);
      this.exportVideoEl     = null;
      this.videoEndedHandler = null;
    }
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    this.stopExport();
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  private startLoop(): void {
    // Runs entirely outside Angular's change-detection zone.
    this.ngZone.runOutsideAngular(() => {
      const tick = () => {
        this.syncCanvasSize();
        this.drawFrame();
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    });
  }

  private syncCanvasSize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w   = this.canvas.clientWidth;
    const h   = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (this.canvasWidth !== w || this.canvasHeight !== h)) {
      this.canvasWidth   = w;
      this.canvasHeight  = h;
      this.canvas.width  = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.scale(dpr, dpr);
    }
  }

  // ── Render pipeline ─────────────────────────────────────────────────────

  private drawFrame(): void {
    const telemetry = this.telemetry();
    if (this.canvasWidth === 0 || this.canvasHeight === 0 || !telemetry) return;

    if (telemetry !== this.activeTelemetry) {
      this.currentDisplayedGForce = 0;
      this.peakGForce              = 0;
      this.activeTelemetry         = telemetry;
    }

    const ctx      = this.ctx;
    const videoEl  = this.videoEl();
    const duration    = videoEl.duration;
    const currentTime = videoEl.currentTime;
    const relativeTimeMs = currentTime * 1000;

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // GPS speed: prefer locked samples (fix >= 2) with timestamp interpolation.
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
    this.lastSpeed = speed; // cached for ghost canvas export frames

    const acclAtom = this.math.findClosestAtom(telemetry.accl, relativeTimeMs);
    const rawG     = acclAtom ? this.math.calculateGForceMagnitude(acclAtom) : 0;

    // Spike instantly on impact above the threshold; ease smoothly otherwise.
    if (rawG > SPIKE_THRESHOLD && rawG > this.currentDisplayedGForce) {
      this.currentDisplayedGForce = rawG;
    } else {
      this.currentDisplayedGForce += (rawG - this.currentDisplayedGForce) * EASE_FACTOR;
    }

    if (rawG >= this.peakGForce) {
      this.peakGForce = rawG;
    } else {
      this.peakGForce = Math.max(this.peakGForce - PEAK_DECAY_PER_FRAME, 0);
    }

    this.drawSpeedReadout(ctx, this.canvasWidth, this.canvasHeight, speed);
    this.drawGForceBar(ctx, this.canvasWidth, this.canvasHeight, this.currentDisplayedGForce, this.peakGForce);
  }

  // ── Bloom helper ─────────────────────────────────────────────────────────

  private bloomParams(): { blur: number; color: string } {
    const t = Math.min(this.currentDisplayedGForce / MAX_G_SCALE, 1);
    return {
      blur:  6 + t * 42,
      color: t > 0.5 ? '#FF00FF' : '#00FFFF',
    };
  }

  // ── Drawing primitives ───────────────────────────────────────────────────
  // Both methods accept explicit width/height so they can be called against
  // either the display canvas (canvasWidth/Height) or the ghost export canvas
  // (EXPORT_W/EXPORT_H) without touching global state.

  private drawSpeedReadout(
    ctx: CanvasRenderingContext2D,
    _width: number,
    height: number,
    speedMs: number,
  ): void {
    const kmh     = Math.round(speedMs * 3.6);
    const bigPx   = Math.max(16, Math.round(height * 0.095));
    const smallPx = Math.max(10, Math.round(height * 0.042));
    const font    = '"Consolas", "Courier New", monospace';
    const x       = 24;
    const yBig    = height - smallPx - 12;
    const ySmall  = height - 10;

    const { blur, color } = this.bloomParams();

    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${bigPx}px ${font}`;

    if (this.currentDisplayedGForce >= SEVERE_THRESHOLD) {
      const offset = Math.max(1, Math.round((this.currentDisplayedGForce - SEVERE_THRESHOLD) * 3));
      ctx.shadowBlur = blur;

      ctx.shadowColor = '#00FFFF';
      ctx.fillStyle   = 'rgba(0, 255, 255, 0.75)';
      ctx.fillText(String(kmh), x - offset, yBig);

      ctx.shadowColor = '#FF00FF';
      ctx.fillStyle   = 'rgba(255, 0, 255, 0.75)';
      ctx.fillText(String(kmh), x + offset, yBig);

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
    width: number,
    height: number,
    gForce: number,
    peak: number,
  ): void {
    const fill     = Math.min(gForce / MAX_G_SCALE, 1);
    const peakFill = Math.min(peak  / MAX_G_SCALE, 1);
    const barW    = Math.round(width * 0.22);
    const barH    = 10;
    const x       = width - barW - 24;
    const barY    = height - barH - 4;
    const labelPx = Math.max(10, Math.round(height * 0.038));
    const font    = '"Consolas", "Courier New", monospace';

    const { blur, color } = this.bloomParams();

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = color;
    ctx.shadowColor  = color;
    ctx.shadowBlur   = blur;
    ctx.font = `${labelPx}px ${font}`;
    ctx.fillText(`${gForce.toFixed(2)} G`, x, barY - 8);

    ctx.shadowBlur  = 0;
    ctx.strokeStyle = '#FF00FF';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x, barY, barW, barH);

    if (fill > 0) {
      ctx.fillStyle   = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = blur * 0.4;
      ctx.fillRect(x, barY, Math.round(barW * fill), barH);
    }

    if (peakFill > fill && peak > 0.05) {
      const markerX   = x + Math.round(barW * peakFill);
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