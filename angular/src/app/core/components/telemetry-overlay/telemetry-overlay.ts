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
import { TelemetryResult, StravaGpsPoint } from '../../models/telemetry.model';
import { StreetTimelineEntry } from '../../models/clip.model';
import { TelemetryMathService } from '../../services/telemetry-math';
import { ThemeService } from '../../services/theme.service';
import { ThemeConfig } from '../../models/theme.model';

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

// GPS multipath noise floor — same value as TelemetryMathService.SPEED_FLOOR_MS.
// Applied to Strava-derived speed so the display behaviour is consistent across sources.
const SPEED_FLOOR_MS = 8.0 / 3.6;

interface LayoutAnchors {
  speedX: number;
  gfBarX: number;
  gfBarY: number;
}

@Component({
  selector: 'app-telemetry-overlay',
  imports: [],
  templateUrl: './telemetry-overlay.html',
  styleUrl: './telemetry-overlay.scss',
})
export class TelemetryOverlay implements OnDestroy {
  readonly videoEl        = input.required<HTMLVideoElement>();
  readonly telemetry      = input<TelemetryResult | null>(null);
  readonly showMap        = input<boolean>(false);
  readonly stravaGps       = input<StravaGpsPoint[]>([]);
  readonly syncOffsetMs    = input<number>(0);
  readonly telemetrySource = input<'GoPro' | 'Strava'>('GoPro');
  readonly mapZoom         = input<number>(1);
  readonly mapMode         = input<'segment' | 'full'>('segment');
  readonly streetTimeline   = input<StreetTimelineEntry[]>([]);
  readonly showStreetName   = input<boolean>(true);

  private readonly canvasRef    = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly ngZone       = inject(NgZone);
  private readonly math         = inject(TelemetryMathService);
  private readonly themeService = inject(ThemeService);

  readonly isExporting = signal<boolean>(false);

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  private canvasWidth  = 0;
  private canvasHeight = 0;


  private _streetDiagDone = false;

  private _path2DCache: {
    path2D: Path2D;
    fullPath2D: Path2D | null;
    clippedPoints: Array<{ t: number; lat: number; lon: number; fix?: number }>;
    bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
    cacheKey: { width: number; srcLen: number; srcT0: number; durationMs: number; mode: 'segment' | 'full'; zoom: number };
  } | null = null;

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

      const theme          = this.themeService.currentTheme();
      const anchors        = this.resolveLayout(theme.layout, EXPORT_W, EXPORT_H);
      const exportStrava   = this.stravaGps();
      const exportUseStrava = this.telemetrySource() === 'Strava' && exportStrava.length > 0;
      const exportRenderMs  = videoEl.currentTime * 1000 + this.syncOffsetMs();

      // Recompute speed per export frame — video time advances frame-by-frame.
      let exportSpeed = this.lastSpeed;
      let exportBio: { hr: number; cad: number; ele: number; speed: number } | null = null;
      if (exportUseStrava) {
        exportBio   = this.interpolateBiometrics(exportStrava, exportRenderMs);
        exportSpeed = exportBio ? (exportBio.speed >= SPEED_FLOOR_MS ? exportBio.speed : 0) : 0;
      }

      // Black background so the gauges are visible on Screen blend mode.
      ghostCtx.fillStyle = '#000000';
      ghostCtx.fillRect(0, 0, EXPORT_W, EXPORT_H);
      this.drawSpeedReadout(ghostCtx, EXPORT_W, EXPORT_H, exportSpeed, theme, anchors);
      this.drawGForceBar(ghostCtx, EXPORT_W, EXPORT_H, this.currentDisplayedGForce, this.peakGForce, theme, anchors);
      if (this.showStreetName()) {
        this.drawStreetName(ghostCtx, EXPORT_W, EXPORT_H, videoEl.currentTime * 1000, theme, anchors);
      }

      if (this.showMap()) {
        if (this.telemetrySource() === 'Strava') {
          if (exportStrava.length > 0) {
            this.drawVectorMap(ghostCtx, EXPORT_W, exportStrava, exportRenderMs, theme, true, this.mapMode());
          }
        } else {
          const exportTelemetry = this.telemetry();
          if (exportTelemetry && exportTelemetry.gps.length > 0) {
            this.drawVectorMap(ghostCtx, EXPORT_W, exportTelemetry.gps, videoEl.currentTime * 1000, theme, false, this.mapMode());
          }
        }
      }

      if (exportStrava.length > 0) {
        if (!exportBio) exportBio = this.interpolateBiometrics(exportStrava, exportRenderMs);
        if (exportBio) {
          this.drawBiometrics(ghostCtx, EXPORT_W, EXPORT_H, exportBio.hr, exportBio.cad, exportBio.ele, theme);
        }
      }

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

    const theme  = this.themeService.currentTheme();
    const nowMs  = performance.now();
    const ctx    = this.ctx;
    const videoEl = this.videoEl();
    const duration       = videoEl.duration;
    const currentTime    = videoEl.currentTime;
    const relativeTimeMs = currentTime * 1000;

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    const stravaPoints  = this.stravaGps();
    const useStrava     = this.telemetrySource() === 'Strava' && stravaPoints.length > 0;
    const renderTimeMs  = relativeTimeMs + this.syncOffsetMs();

    // ── Speed ──────────────────────────────────────────────────────────────
    // Strava mode: Haversine-derived 1 Hz speed, linearly interpolated.
    // GoPro mode: 18 Hz GPS9 measured speed via TelemetryMathService.
    let speed = 0;
    let bio: { hr: number; cad: number; ele: number; speed: number } | null = null;

    if (useStrava) {
      bio   = this.interpolateBiometrics(stravaPoints, renderTimeMs);
      speed = bio ? (bio.speed >= SPEED_FLOOR_MS ? bio.speed : 0) : 0;
    } else {
      const gps       = telemetry.gps;
      const lockedGPS = gps.filter(g => g.fix >= 2);
      if (lockedGPS.length > 0) {
        speed = this.math.getDisplaySpeed(lockedGPS, relativeTimeMs, nowMs);
      } else if (gps.length > 0 && isFinite(duration) && duration > 0) {
        const fIdx  = Math.max(0, Math.min(1, currentTime / duration)) * (gps.length - 1);
        const lo    = Math.floor(fIdx);
        const hi    = Math.min(lo + 1, gps.length - 1);
        const alpha = fIdx - lo;
        speed = gps[lo].speed2d + (gps[hi].speed2d - gps[lo].speed2d) * alpha;
      }
    }
    this.lastSpeed = speed;

    // ── G-force ────────────────────────────────────────────────────────────
    const rawG = this.math.getDisplayGForce(this.math.findClosestAtom(telemetry.accl, relativeTimeMs), nowMs);

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

    // ── Draw ───────────────────────────────────────────────────────────────
    const anchors = this.resolveLayout(theme.layout, this.canvasWidth, this.canvasHeight);
    this.drawSpeedReadout(ctx, this.canvasWidth, this.canvasHeight, speed, theme, anchors);
    this.drawGForceBar(ctx, this.canvasWidth, this.canvasHeight, this.currentDisplayedGForce, this.peakGForce, theme, anchors);
    if (!this._streetDiagDone && this.streetTimeline().length > 0) {
      this._streetDiagDone = true;
      console.log('[STREET DIAG] showStreetName:', this.showStreetName(), '| timeline:', JSON.stringify(this.streetTimeline()));
    }
    if (this.showStreetName()) {
      this.drawStreetName(ctx, this.canvasWidth, this.canvasHeight, relativeTimeMs, theme, anchors);
    }

    if (this.showMap()) {
      if (this.telemetrySource() === 'Strava') {
        if (stravaPoints.length > 0) {
          this.drawVectorMap(ctx, this.canvasWidth, stravaPoints, renderTimeMs, theme, true, this.mapMode());
        }
      } else if (telemetry.gps.length > 0) {
        this.drawVectorMap(ctx, this.canvasWidth, telemetry.gps, relativeTimeMs, theme, false, this.mapMode());
      }
    }

    if (stravaPoints.length > 0) {
      if (!bio) bio = this.interpolateBiometrics(stravaPoints, renderTimeMs);
      if (bio) {
        this.drawBiometrics(ctx, this.canvasWidth, this.canvasHeight, bio.hr, bio.cad, bio.ele, theme);
      }
    }
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  // Returns pixel anchors for the two HUD elements. All three cases share the
  // same draw methods — only the origin coordinates differ per layout.

  private resolveLayout(
    layout: 'spread' | 'stacked' | 'dashboard' | 'tiktok-cover',
    width: number,
    height: number,
  ): LayoutAnchors {
    const barW = Math.round(width * 0.22);
    const barH = 10;
    switch (layout) {
      case 'stacked':
        // Both elements left-aligned; G-bar sits above the speed digits.
        return {
          speedX: 24,
          gfBarX: 24,
          gfBarY: Math.round(height * 0.75),
        };
      case 'dashboard':
        // Speed left-of-centre, G-bar right-of-centre — paired mid-bottom.
        return {
          speedX: Math.round(width / 2) - 40,
          gfBarX: Math.round(width / 2) + 10,
          gfBarY: height - barH - 4,
        };
      case 'tiktok-cover': {
        // Solid-block layout: speed box stacked above G-force box, bottom-left.
        // gfBarY marks the top of the G-force box; speed box sits immediately above.
        const stripeW = 8;
        const margin  = 16;
        const gap     = 4;
        return {
          speedX: margin + stripeW + gap,
          gfBarX: margin + stripeW + gap,
          gfBarY: Math.round(height * 0.80),
        };
      }
      case 'spread':
      default:
        // Current behaviour: speed bottom-left, G-bar bottom-right.
        return {
          speedX: 24,
          gfBarX: width - barW - 24,
          gfBarY: height - barH - 4,
        };
    }
  }

  // ── Bloom helper ─────────────────────────────────────────────────────────

  private bloomParams(theme: ThemeConfig): { blur: number; color: string } {
    const t = Math.min(this.currentDisplayedGForce / MAX_G_SCALE, 1);
    return {
      blur:  6 + t * 42,
      color: t > 0.5 ? theme.colors.secondary : theme.colors.primary,
    };
  }

  // ── Biometric interpolation ──────────────────────────────────────────────
  // Linear interpolation of hr/cad/ele from the 1 Hz Strava point array.
  // Returns null only when the array is empty.

  private interpolateBiometrics(
    points: StravaGpsPoint[],
    renderTimeMs: number,
  ): { hr: number; cad: number; ele: number; speed: number } | null {
    if (points.length === 0) return null;

    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (points[mid].t <= renderTimeMs) { lo = mid; } else { hi = mid - 1; }
    }
    const hiIdx = Math.min(lo + 1, points.length - 1);
    const loP   = points[lo];
    const hiP   = points[hiIdx];
    const dt    = hiP.t - loP.t;
    const a     = dt > 0 ? Math.max(0, Math.min(1, (renderTimeMs - loP.t) / dt)) : 0;

    return {
      hr:    Math.round(loP.hr    + (hiP.hr    - loP.hr)    * a),
      cad:   Math.round(loP.cad   + (hiP.cad   - loP.cad)   * a),
      ele:   loP.ele   + (hiP.ele   - loP.ele)   * a,
      speed: loP.speed + (hiP.speed - loP.speed) * a,
    };
  }

  // Returns the HUD colour for a heart rate value according to training zones.
  private hrColor(hr: number, theme: ThemeConfig): string {
    if (hr === 0)   return theme.colors.text;
    if (hr < 100)   return theme.colors.success;
    if (hr < 140)   return theme.colors.primary;
    if (hr < 160)   return theme.colors.warning;
    return theme.colors.danger;
  }

  // ── Hex → rgba helper ────────────────────────────────────────────────────
  // Used for the translucent chromatic-aberration ghost copies in the severe
  // G-force glitch effect. Assumes 6-digit hex with leading '#'.

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ── Street name lookup ───────────────────────────────────────────────────
  // O(log N) floor search: returns the streetName of the last entry whose
  // .t <= timeMs, or null when the timeline is empty or timeMs precedes all entries.

  private findStreetAtTime(timeMs: number): string | null {
    const timeline = this.streetTimeline();
    if (timeline.length === 0) return null;
    let lo = 0, hi = timeline.length - 1;
    let result: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].t <= timeMs) { result = timeline[mid].streetName; lo = mid + 1; }
      else hi = mid - 1;
    }
    return result;
  }

  // Renders the current street name as a single line of canvas text.
  // ctx.save/restore isolates font, fillStyle, shadowBlur, and textBaseline —
  // no state leaks into adjacent draw calls.
  private drawStreetName(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    timeMs: number,
    theme: ThemeConfig,
    anchors: LayoutAnchors,
  ): void {
    const raw = this.findStreetAtTime(timeMs);
    if (!raw) return;

    const MAX_CHARS = 20;
    const label = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS - 1) + '…' : raw;

    // Minimum 14 px so the name is legible on small embedded canvases.
    const streetPx = Math.max(14, Math.round(height * 0.032));

    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.font         = `bold ${streetPx}px ${theme.font.primary}`;

    if (theme.layout === 'tiktok-cover') {
      // Positioned just above the G-force box (at 80% height), centered horizontally
      // so it does not overlap the left-side solid blocks.
      const gfBarY = Math.round(height * 0.80);
      const y      = gfBarY - 10;
      const textW  = ctx.measureText(label).width;
      const padX   = 8;
      const padY   = 4;
      const bgX    = width / 2 - textW / 2 - padX;
      const bgY    = y - streetPx - padY;
      ctx.fillStyle   = 'rgba(0,0,0,0.65)';
      ctx.fillRect(bgX, bgY, textW + padX * 2, streetPx + padY * 2);
      ctx.textAlign   = 'center';
      ctx.fillStyle   = '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur  = 6;
      ctx.fillText(label, width / 2, y);
      ctx.textAlign   = 'left';
    } else {
      // spread / stacked / dashboard: above the speed number column.
      // Uses theme primary (same colour as the speed readout) with a matching glow
      // so the label reads as part of the same HUD block.
      const bigPx   = Math.max(16, Math.round(height * 0.095));
      const smallPx = Math.max(10, Math.round(height * 0.042));
      const y       = height - smallPx - bigPx - 16;
      ctx.fillStyle   = theme.colors.primary;
      ctx.shadowColor = theme.colors.primary;
      ctx.shadowBlur  = 10;
      ctx.fillText(label, anchors.speedX, y);
    }

    ctx.restore();
  }

  // ── Drawing primitives ───────────────────────────────────────────────────
  // Both methods accept explicit width/height so they can be called against
  // either the display canvas (canvasWidth/Height) or the ghost export canvas
  // (EXPORT_W/EXPORT_H) without touching global state.

  private drawSpeedReadout(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    speedMs: number,
    theme: ThemeConfig,
    anchors: LayoutAnchors,
  ): void {
    const kmh = Math.round(speedMs * 3.6);

    if (theme.layout === 'tiktok-cover') {
      const stripeW   = 8;
      const margin    = 16;
      const speedBoxH = Math.round(height * 0.09);
      const gfBoxH    = Math.round(height * (width < 360 ? 0.08 : 0.055));
      const boxW      = Math.round(width * (width < 450 ? 0.20 : 0.18));
      const boxLeft   = anchors.speedX;
      const speedBoxY = anchors.gfBarY - speedBoxH;

      // Speed box — solid primary colour fill
      ctx.fillStyle = theme.colors.primary;
      ctx.fillRect(boxLeft, speedBoxY, boxW, speedBoxH);

      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#FFFFFF';

      ctx.font = `bold ${Math.max(14, Math.round(speedBoxH * 0.52))}px ${theme.font.primary}`;
      ctx.fillText(String(kmh), boxLeft + 10, speedBoxY + speedBoxH * 0.42);

      ctx.font = `${Math.max(8, Math.round(speedBoxH * 0.28))}px ${theme.font.primary}`;
      ctx.fillText('KM/H', boxLeft + 10, speedBoxY + speedBoxH * 0.80);

      // Three-colour branding stripe at the left edge of the combined block
      const totalH  = speedBoxH + gfBoxH;
      const stripeH = Math.floor(totalH / 3);
      [theme.colors.secondary, theme.colors.success, theme.colors.warning].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(margin, speedBoxY + i * stripeH, stripeW, stripeH);
      });

      ctx.shadowBlur = 0;
      return;
    }

    const bigPx   = Math.max(16, Math.round(height * 0.095));
    const smallPx = Math.max(10, Math.round(height * 0.042));
    const x       = anchors.speedX;
    const yBig    = height - smallPx - 12;
    const ySmall  = height - 10;

    const { blur, color } = this.bloomParams(theme);

    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${bigPx}px ${theme.font.primary}`;

    if (this.currentDisplayedGForce >= SEVERE_THRESHOLD) {
      const offset = Math.max(1, Math.round((this.currentDisplayedGForce - SEVERE_THRESHOLD) * 3));
      ctx.shadowBlur = blur;

      ctx.shadowColor = theme.colors.primary;
      ctx.fillStyle   = this.hexToRgba(theme.colors.primary, 0.75);
      ctx.fillText(String(kmh), x - offset, yBig);

      ctx.shadowColor = theme.colors.secondary;
      ctx.fillStyle   = this.hexToRgba(theme.colors.secondary, 0.75);
      ctx.fillText(String(kmh), x + offset, yBig);

      ctx.shadowColor = theme.colors.text;
      ctx.fillStyle   = theme.colors.text;
      ctx.fillText(String(kmh), x, yBig);
    } else {
      ctx.shadowColor = color;
      ctx.shadowBlur  = blur;
      ctx.fillStyle   = theme.colors.primary;
      ctx.fillText(String(kmh), x, yBig);
    }

    ctx.font        = `${smallPx}px ${theme.font.primary}`;
    ctx.shadowColor = theme.colors.primary;
    ctx.shadowBlur  = Math.min(blur * 0.4, 10);
    ctx.fillStyle   = theme.colors.primary;
    ctx.fillText('KM/H', x, ySmall);

    ctx.shadowBlur = 0;
  }

  private drawGForceBar(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    gForce: number,
    peak: number,
    theme: ThemeConfig,
    anchors: LayoutAnchors,
  ): void {
    if (theme.layout === 'tiktok-cover') {
      const gfBoxH  = Math.round(height * (width < 360 ? 0.08 : 0.055));
      const boxW    = Math.round(width * (width < 450 ? 0.20 : 0.18));
      const boxLeft = anchors.gfBarX;
      const gfBoxY  = anchors.gfBarY;

      // G-force box — solid black fill
      ctx.fillStyle = '#000000';
      ctx.fillRect(boxLeft, gfBoxY, boxW, gfBoxH);

      const labelPx = Math.max(8, Math.round(gfBoxH * 0.55));
      ctx.font         = `${labelPx}px ${theme.font.primary}`;
      ctx.fillStyle    = '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${gForce.toFixed(2)} G`, boxLeft + 10, gfBoxY + gfBoxH * 0.5);

      ctx.shadowBlur = 0;
      return;
    }

    const fill     = Math.min(gForce / MAX_G_SCALE, 1);
    const peakFill = Math.min(peak  / MAX_G_SCALE, 1);
    const barW    = Math.round(width * 0.22);
    const barH    = 10;
    const x       = anchors.gfBarX;
    const barY    = anchors.gfBarY;
    const labelPx = Math.max(10, Math.round(height * 0.038));

    const { blur, color } = this.bloomParams(theme);

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = color;
    ctx.shadowColor  = color;
    ctx.shadowBlur   = blur;
    ctx.font = `${labelPx}px ${theme.font.primary}`;
    ctx.fillText(`${gForce.toFixed(2)} G`, x, barY - 8);

    ctx.shadowBlur  = 0;
    ctx.strokeStyle = theme.colors.secondary;
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
      ctx.strokeStyle = theme.colors.secondary;
      ctx.shadowColor = theme.colors.secondary;
      ctx.shadowBlur  = blur * 0.6;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(markerX, barY - 2);
      ctx.lineTo(markerX, barY + barH + 2);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
  }

  // ── Biometric HUD panel ──────────────────────────────────────────────────
  // Renders HR / CAD / ELE in a layout-specific style.  All three themes use
  // the same data but differ in position, typography, and decoration.

  private drawBiometrics(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    hr: number,
    cad: number,
    ele: number,
    theme: ThemeConfig,
  ): void {
    const hrCol = this.hrColor(hr, theme);

    // ── tiktok-cover: solid block stack above the speed/G-force column ───
    if (theme.layout === 'tiktok-cover') {
      const margin   = 16;
      const stripeW  = 8;
      const gap      = 4;
      const boxLeft  = margin + stripeW + gap;
      const narrow    = width < 450;
      const compact   = width < 360;
      const boxW      = Math.round(width * (narrow  ? 0.20 : 0.18));
      const gfBarY    = Math.round(height * 0.80);
      const speedBoxH = Math.round(height * 0.09);
      const bioBoxH   = Math.round(height * (compact ? 0.08 : 0.055));
      const labelPx   = Math.max(8, Math.round(bioBoxH * 0.38));
      const valuePx   = Math.max(9, Math.round(bioBoxH * 0.55));
      const speedBoxY = gfBarY - speedBoxH;

      const boxes: Array<{ label: string; value: string; fill: string }> = [
        { label: 'ELE', value: narrow ? `${ele.toFixed(1)}` : `${ele.toFixed(1)} m`,  fill: theme.colors.accent },
        { label: 'CAD', value: narrow ? `${cad}`            : `${cad} RPM`,           fill: theme.colors.primary },
        { label: 'HR',  value: narrow ? `${hr}`             : `${hr} BPM`,            fill: hrCol },
      ];

      // Draw from top down: ELE → CAD → HR (HR is closest to speed box)
      boxes.forEach(({ label, value, fill }, i) => {
        const boxY = speedBoxY - (boxes.length - i) * bioBoxH;
        ctx.fillStyle = fill;
        ctx.fillRect(boxLeft, boxY, boxW, bioBoxH);

        ctx.fillStyle    = '#FFFFFF';
        ctx.textBaseline = 'middle';
        const midY       = boxY + bioBoxH * 0.5;

        ctx.font = `${labelPx}px ${theme.font.primary}`;
        ctx.fillText(label, boxLeft + 8, midY);

        ctx.font = `bold ${valuePx}px ${theme.font.primary}`;
        const labelW = ctx.measureText(label + '  ').width;
        ctx.fillText(value, boxLeft + 8 + labelW, midY);
      });

      // Coloured left-stripe covering all bio boxes
      const bioTotalH = boxes.length * bioBoxH;
      const bioTopY   = speedBoxY - bioTotalH;
      const stripeH   = Math.floor(bioTotalH / 3);
      [theme.colors.secondary, theme.colors.success, theme.colors.warning].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(margin, bioTopY + i * stripeH, stripeW, stripeH);
      });

      ctx.shadowBlur = 0;
      return;
    }

    // ── stacked (CLEAN_SPORT): clean right-side vertical panel ───────────
    if (theme.layout === 'stacked') {
      const narrow  = width < 450;
      const rowH    = Math.max(22, Math.round(height * 0.042));
      const bigPx   = Math.max(13, Math.round(height * 0.032));
      const labPx   = Math.max(8,  Math.round(height * 0.020));
      const panW    = Math.round(width * (narrow ? 0.20 : 0.14));
      const panX    = width - panW - 24;
      const panBotY = height - 16;

      const rows: Array<{ icon: string; value: string; unit: string; color: string }> = [
        { icon: '▲', value: ele.toFixed(1), unit: 'm',   color: theme.colors.accent },
        { icon: '↺', value: String(cad),    unit: 'rpm', color: theme.colors.text },
        { icon: '♥', value: String(hr),     unit: 'bpm', color: hrCol },
      ];

      rows.forEach(({ icon, value, unit, color }, i) => {
        const rowY = panBotY - i * rowH - rowH * 0.35;

        ctx.save();
        ctx.textBaseline = 'middle';

        // Accent icon label
        ctx.font      = `${labPx}px ${theme.font.primary}`;
        ctx.fillStyle = theme.colors.accent;
        ctx.fillText(icon, panX, rowY);

        // Bold value in zone colour
        ctx.font      = `bold ${bigPx}px ${theme.font.primary}`;
        ctx.fillStyle = color;
        ctx.fillText(value, panX + labPx + 6, rowY);

        // Small unit — omitted on narrow screens; icons carry the semantic meaning
        if (!narrow) {
          const valW  = ctx.measureText(value).width;
          ctx.font    = `${labPx}px ${theme.font.primary}`;
          ctx.fillStyle = theme.colors.text;
          ctx.globalAlpha = 0.7;
          ctx.fillText(unit, panX + labPx + 6 + valW + 4, rowY);
          ctx.globalAlpha = 1.0;
        }

        ctx.restore();
      });

      // Thin separator line above the panel
      const sepY = panBotY - rows.length * rowH - 4;
      ctx.save();
      ctx.strokeStyle = theme.colors.accent;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(panX, sepY);
      ctx.lineTo(panX + panW, sepY);
      ctx.stroke();
      ctx.restore();

      return;
    }

    // ── spread (VERGARA_YOUTUBE): cyberpunk glowing top-left panel ────────
    {
      const rowH  = Math.max(28, Math.round(height * 0.048));
      const bigPx = Math.max(14, Math.round(height * 0.036));
      const labPx = Math.max(9,  Math.round(height * 0.022));
      const panX  = 16;
      const panY  = 16;

      const iconColW = Math.round(labPx * 1.4);
      const valColW  = Math.round(bigPx * 3.0);

      const rows: Array<{ icon: string; value: string; unit: string; color: string }> = [
        { icon: '♥', value: String(hr),     unit: 'BPM', color: hrCol },
        { icon: '↺', value: String(cad),    unit: 'RPM', color: theme.colors.primary },
        { icon: '▲', value: ele.toFixed(1), unit: 'M',   color: theme.colors.accent },
      ];

      rows.forEach(({ icon, value, unit, color }, i) => {
        const y = panY + i * rowH + rowH * 0.55;

        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.shadowColor  = color;
        ctx.shadowBlur   = 10;
        ctx.fillStyle    = color;

        // Icon (right-aligned in narrow column)
        ctx.textAlign = 'right';
        ctx.font = `${labPx}px ${theme.font.primary}`;
        ctx.fillText(icon, panX + iconColW, y);

        // Value (right-aligned in value column)
        ctx.textAlign = 'right';
        ctx.font = `bold ${bigPx}px ${theme.font.primary}`;
        ctx.fillText(value, panX + iconColW + valColW, y);

        // Unit (left-aligned, dimmed)
        ctx.textAlign   = 'left';
        ctx.font        = `${labPx}px ${theme.font.primary}`;
        ctx.shadowBlur  = 4;
        ctx.globalAlpha = 0.7;
        ctx.fillText(unit, panX + iconColW + valColW + 5, y);
        ctx.globalAlpha = 1.0;

        ctx.restore();
      });
    }
  }

  // ── Vector map ───────────────────────────────────────────────────────────
  // Projects [lat, lon] into pixel space within a canvas bounding box.
  // Y is inverted: maxLat → top of box, minLat → bottom (canvas grows downward).
  // Returns the centre of the box when the ride is a single point (dLat or dLon = 0).
  private projectLatLon(
    lat: number, lon: number,
    minLat: number, maxLat: number,
    minLon: number, maxLon: number,
    bx: number, by: number, bw: number, bh: number,
  ): [number, number] {
    const dLat = maxLat - minLat;
    const dLon = maxLon - minLon;
    if (dLat === 0 || dLon === 0) return [bx + bw / 2, by + bh / 2];
    return [
      bx + ((lon - minLon) / dLon) * bw,
      by + ((maxLat - lat) / dLat) * bh,
    ];
  }

  // Draws a pure-vector GPS path and current-position dot into any ctx.
  // No tile images are drawn — canvas stays origin-clean for captureStream().
  //
  // points: accepts GPS9Sample[] (GoPro) or StravaGpsPoint[] — both carry {t, lat, lon, fix?}.
  // useLinearInterp: false → snap to nearest atom (GoPro 18 Hz);
  //                  true  → linear interpolation between bracketing points (Strava 1 Hz).
  //
  // Performance contract:
  //   - Path2D is built once on cache miss (O(N) work); ctx.stroke(path2D) in the 60 Hz loop.
  //   - Zoom applied via ctx.translate/scale — no per-frame coordinate iteration.
  private drawVectorMap(
    ctx: CanvasRenderingContext2D,
    width: number,
    points: Array<{ t: number; lat: number; lon: number; fix?: number }>,
    renderTimeMs: number,
    theme: ThemeConfig,
    useLinearInterp: boolean,
    mapMode: 'segment' | 'full',
  ): void {
    // GoPro: keep only fix >= 2 locked samples; fall back to all if none locked.
    // Strava: fix is undefined for all points — passes the filter, uses full array.
    const locked = points.filter(p => p.fix === undefined || p.fix >= 2);
    const base   = locked.length > 0 ? locked : points;
    if (base.length < 2) return;

    // Map box geometry — derived purely from width, stable across frames at fixed size.
    const mapW    = Math.round(width * 0.18);
    const mapH    = Math.round(mapW * 0.667);
    const padding = Math.round(mapW * 0.05);
    const bx      = width - mapW - 16 + padding;
    const by      = 16 + padding;
    const bw      = mapW - 2 * padding;
    const bh      = mapH - 2 * padding;

    // Video duration rounded to ms — used as a stable cache-key component.
    const rawDuration = this.videoEl().duration;
    const durationMs  = isFinite(rawDuration) ? Math.round(rawDuration * 1000) : 0;
    const zoom      = this.mapZoom();
    // Continuous slider: only the bbox preset zone (≤ 0) changes projected coordinates.
    // Matrix zoom (> 0) is applied via ctx.scale — Path2D coordinates are stable.
    const cacheZoom = zoom <= 0 ? Math.round(zoom) : 1;

    // ── Path2D cache ────────────────────────────────────────────────────────
    // Rebuild when source data, canvas width, video duration, map mode, or bbox zoom changes.
    const ck = this._path2DCache?.cacheKey;
    if (!ck || ck.width !== width || ck.srcLen !== base.length || ck.srcT0 !== base[0].t || ck.durationMs !== durationMs || ck.mode !== mapMode || ck.zoom !== cacheZoom) {
      // Temporal clip — only the portion of the route that the video covers.
      const clipped = durationMs > 0
        ? base.filter(p => p.t >= 0 && p.t <= durationMs)
        : base;
      if (clipped.length < 2) return;

      // Segment bounding box — always the starting point.
      let minLat = clipped[0].lat, maxLat = clipped[0].lat;
      let minLon = clipped[0].lon, maxLon = clipped[0].lon;
      for (const { lat, lon } of clipped) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }

      // Named scope presets expand or replace the bounding box.
      // zoom >= 1: keep segment bbox; ctx.scale handles zoom-in.
      // zoom = 0  (LOCAL MAP):  widen segment bbox by 50 % on each side.
      // zoom = -1 (MID MAP):   widen segment bbox ×4 (1.5 each side).
      // zoom = -2 (FULL MAP):  replace with the full ride's bbox.
      if (cacheZoom === -2) {
        for (const { lat, lon } of base) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      } else if (cacheZoom === -1) {
        const latPad = (maxLat - minLat) * 1.5;
        const lonPad = (maxLon - minLon) * 1.5;
        minLat -= latPad; maxLat += latPad;
        minLon -= lonPad; maxLon += lonPad;
      } else if (cacheZoom === 0) {
        const latPad = (maxLat - minLat) * 0.25;
        const lonPad = (maxLon - minLon) * 0.25;
        minLat -= latPad; maxLat += latPad;
        minLon -= lonPad; maxLon += lonPad;
      }

      // O(N) segment path build — once per cache miss.
      const p2d = new Path2D();
      const [sx, sy] = this.projectLatLon(clipped[0].lat, clipped[0].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
      p2d.moveTo(sx, sy);
      for (let i = 1; i < clipped.length; i++) {
        const [px, py] = this.projectLatLon(clipped[i].lat, clipped[i].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
        p2d.lineTo(px, py);
      }

      // Full-ride ghost path projected through the same (possibly expanded) bbox.
      // Points outside the bbox project outside the map box and are clipped naturally.
      let fullPath2D: Path2D | null = null;
      if (mapMode === 'full') {
        const fp2d = new Path2D();
        const [fsx, fsy] = this.projectLatLon(base[0].lat, base[0].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
        fp2d.moveTo(fsx, fsy);
        for (let i = 1; i < base.length; i++) {
          const [fpx, fpy] = this.projectLatLon(base[i].lat, base[i].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
          fp2d.lineTo(fpx, fpy);
        }
        fullPath2D = fp2d;
      }

      this._path2DCache = {
        path2D: p2d,
        fullPath2D,
        clippedPoints: clipped,
        bounds: { minLat, maxLat, minLon, maxLon },
        cacheKey: { width, srcLen: base.length, srcT0: base[0].t, durationMs, mode: mapMode, zoom: cacheZoom },
      };
    }

    const { path2D, fullPath2D, clippedPoints, bounds: { minLat, maxLat, minLon, maxLon } } = this._path2DCache!;

    // ── Background ──────────────────────────────────────────────────────────
    // save/restore isolates globalAlpha — leak would taint the entire 60 Hz HUD.
    ctx.save();
    ctx.globalAlpha = theme.map.backgroundAlpha;
    ctx.fillStyle   = theme.colors.secondary;
    ctx.fillRect(width - mapW - 16, 16, mapW, mapH);
    ctx.restore();

    // ── Current-position dot ────────────────────────────────────────────────
    let dotX = bx + bw / 2;
    let dotY = by + bh / 2;

    if (useLinearInterp) {
      let lo = 0, hi = clippedPoints.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (clippedPoints[mid].t <= renderTimeMs) { lo = mid; } else { hi = mid - 1; }
      }
      const hiIdx = Math.min(lo + 1, clippedPoints.length - 1);
      const loP   = clippedPoints[lo];
      const hiP   = clippedPoints[hiIdx];
      const dt    = hiP.t - loP.t;
      const alpha = dt > 0 ? Math.max(0, Math.min(1, (renderTimeMs - loP.t) / dt)) : 0;
      const lat   = loP.lat + (hiP.lat - loP.lat) * alpha;
      const lon   = loP.lon + (hiP.lon - loP.lon) * alpha;
      [dotX, dotY] = this.projectLatLon(lat, lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);

    } else {
      const atom = this.math.findClosestAtom(clippedPoints, renderTimeMs);
      if (atom) {
        [dotX, dotY] = this.projectLatLon(atom.lat, atom.lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
      }
    }

    // ── Route path via cached Path2D + optional zoom transform ──────────────
    // ctx.clip() confines the zoomed paths to the map box — prevents bleeding
    // into the speed/G-force HUD at high zoom levels.
    ctx.save();
    ctx.beginPath();
    ctx.rect(width - mapW - 16, 16, mapW, mapH);
    ctx.clip();

    if (zoom > 1) {
      // Pin the dot on-screen; segment path zooms in around it.
      ctx.translate(dotX, dotY);
      ctx.scale(zoom, zoom);
      ctx.translate(-dotX, -dotY);
    }

    // Ghost: full-ride path drawn first so the segment path paints over it.
    if (fullPath2D) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth   = theme.map.strokeWidth + 4;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.shadowBlur  = 0;
      ctx.stroke(fullPath2D);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = theme.colors.primary;
      ctx.lineWidth   = theme.map.strokeWidth;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.shadowBlur  = 0;
      ctx.stroke(fullPath2D);
      ctx.restore();
    }

    // Active segment — contrast outline first, theme primary colour on top.
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth   = theme.map.strokeWidth + 4;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.shadowBlur  = 0;
    ctx.stroke(path2D);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = theme.colors.primary;
    ctx.lineWidth   = theme.map.strokeWidth;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.shadowBlur  = 0;
    ctx.stroke(path2D);
    ctx.restore();

    ctx.restore();

    // Dot drawn after restore — always at its projected canvas position,
    // unaffected by the zoom transform.
    ctx.beginPath();
    ctx.fillStyle = '#FF00FF';
    ctx.arc(dotX, dotY, Math.max(3, Math.round(mapW * 0.025)), 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
  }
}
