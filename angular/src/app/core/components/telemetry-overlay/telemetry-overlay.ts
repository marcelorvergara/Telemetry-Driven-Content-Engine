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
import { TelemetryResult, GPS9Sample } from '../../models/telemetry.model';
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
  readonly videoEl   = input.required<HTMLVideoElement>();
  readonly telemetry = input<TelemetryResult | null>(null);
  readonly showMap   = input<boolean>(false);

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

      const theme   = this.themeService.currentTheme();
      const anchors = this.resolveLayout(theme.layout, EXPORT_W, EXPORT_H);

      // Black background so the gauges are visible on Screen blend mode.
      ghostCtx.fillStyle = '#000000';
      ghostCtx.fillRect(0, 0, EXPORT_W, EXPORT_H);
      this.drawSpeedReadout(ghostCtx, EXPORT_W, EXPORT_H, this.lastSpeed, theme, anchors);
      this.drawGForceBar(ghostCtx, EXPORT_W, EXPORT_H, this.currentDisplayedGForce, this.peakGForce, theme, anchors);

      const exportTelemetry = this.telemetry();
      if (this.showMap() && exportTelemetry && exportTelemetry.gps.length > 0) {
        this.drawVectorMap(ghostCtx, EXPORT_W, exportTelemetry.gps, videoEl.currentTime * 1000, theme);
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
    const ctx     = this.ctx;
    const videoEl = this.videoEl();
    const duration       = videoEl.duration;
    const currentTime    = videoEl.currentTime;
    const relativeTimeMs = currentTime * 1000;

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // GPS speed: prefer locked samples (fix >= 2) with timestamp interpolation.
    const gps = telemetry.gps;
    let speed = 0;
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
    this.lastSpeed = speed; // cached for ghost canvas export frames

    const acclAtom = this.math.findClosestAtom(telemetry.accl, relativeTimeMs);
    const rawG     = this.math.getDisplayGForce(acclAtom, nowMs);

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

    const anchors = this.resolveLayout(theme.layout, this.canvasWidth, this.canvasHeight);
    this.drawSpeedReadout(ctx, this.canvasWidth, this.canvasHeight, speed, theme, anchors);
    this.drawGForceBar(ctx, this.canvasWidth, this.canvasHeight, this.currentDisplayedGForce, this.peakGForce, theme, anchors);

    if (this.showMap() && gps.length > 0) {
      this.drawVectorMap(ctx, this.canvasWidth, gps, relativeTimeMs, theme);
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

  // ── Hex → rgba helper ────────────────────────────────────────────────────
  // Used for the translucent chromatic-aberration ghost copies in the severe
  // G-force glitch effect. Assumes 6-digit hex with leading '#'.

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
      const gfBoxH    = Math.round(height * 0.055);
      const boxW      = Math.round(width * 0.18);
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
      const gfBoxH  = Math.round(height * 0.055);
      const boxW    = Math.round(width * 0.18);
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
  private drawVectorMap(
    ctx: CanvasRenderingContext2D,
    width: number,
    gps: GPS9Sample[],
    relativeTimeMs: number,
    theme: ThemeConfig,
  ): void {
    const locked = gps.filter(s => s.fix >= 2);
    const path   = locked.length > 0 ? locked : gps;
    if (path.length < 2) return;

    // Map box: top-right corner, 18 % of canvas width, 2:3 aspect ratio.
    const mapW    = Math.round(width * 0.18);
    const mapH    = Math.round(mapW * 0.667);
    const padding = Math.round(mapW * 0.05);
    const bx      = width - mapW - 16 + padding;
    const by      = 16 + padding;
    const bw      = mapW - 2 * padding;
    const bh      = mapH - 2 * padding;

    // Theme-driven background — drawn before the path so it sits behind the vector.
    // save/restore isolates globalAlpha; leak would taint the entire 60 Hz HUD.
    ctx.save();
    ctx.globalAlpha = theme.map.backgroundAlpha;
    ctx.fillStyle   = theme.colors.secondary;
    ctx.fillRect(
      Math.round(width - mapW - 16),
      Math.round(16),
      Math.round(mapW),
      Math.round(mapH),
    );
    ctx.restore();

    // Geographic bounds of the ride.
    let minLat = path[0].lat, maxLat = path[0].lat;
    let minLon = path[0].lon, maxLon = path[0].lon;
    for (const { lat, lon } of path) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    // Full ride path — cyan, no shadow (keeps canvas untainted).
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = '#00FFFF';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    const [sx, sy] = this.projectLatLon(path[0].lat, path[0].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < path.length; i++) {
      const [px, py] = this.projectLatLon(path[i].lat, path[i].lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
      ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current-position dot — magenta.
    const atom = this.math.findClosestAtom(path, relativeTimeMs);
    if (atom) {
      const [mx, my] = this.projectLatLon(atom.lat, atom.lon, minLat, maxLat, minLon, maxLon, bx, by, bw, bh);
      ctx.beginPath();
      ctx.fillStyle = '#FF00FF';
      ctx.arc(mx, my, Math.max(3, Math.round(mapW * 0.025)), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
  }
}
