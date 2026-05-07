import { Component, Input, AfterViewInit, OnChanges, OnDestroy, NgZone, SimpleChanges, ViewChild, ElementRef } from '@angular/core';
import * as L from 'leaflet';
import { GPS9Sample } from '../../models/telemetry.model';
import { TelemetryMathService } from '../../services/telemetry-math';

const RDP_TOLERANCE  = 0.0001; // ~11 m at mid-latitudes
const PATH_COLOR     = '#0066cc';
const PATH_WEIGHT    = 2;
const PATH_OPACITY   = 0.85;
const MARKER_COLOR   = '#ff00ff';
const MARKER_RADIUS  = 6;
const BOUNDS_PADDING = [8, 8] as [number, number];

@Component({
  selector: 'app-map-overlay',
  standalone: true,
  templateUrl: './map-overlay.html',
  styleUrl: './map-overlay.scss',
})
export class MapOverlay implements OnChanges, AfterViewInit, OnDestroy {
  @Input() gps:      GPS9Sample[]      = [];
  @Input() videoEl!: HTMLVideoElement;

  @ViewChild('mapContainer') private containerRef!: ElementRef<HTMLDivElement>;

  private map:       L.Map | null          = null;
  private marker:    L.CircleMarker | null = null;
  private rafId      = 0;
  private baseOffset = 0;
  private lockedGps: GPS9Sample[]          = [];

  constructor(
    private readonly ngZone: NgZone,
    private readonly math:   TelemetryMathService,
  ) {}

  // Re-initialize when GPS data is replaced (e.g. user loads a new video while map is visible).
  // Skip firstChange — ngAfterViewInit owns the first setup. Skip empty arrays — they signal
  // a new video is still loading (telemetry.set(null) briefly sets gps to []).
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['gps'] && !changes['gps'].firstChange && this.gps.length > 0 && this.map) {
      this.ngZone.runOutsideAngular(() => {
        this.teardown();
        this.setup();
      });
    }
  }

  ngAfterViewInit(): void {
    this.ngZone.runOutsideAngular(() => {
      this.setup();
      setTimeout(() => this.map?.invalidateSize(), 0);
    });
  }

  // Compute the working GPS set: prefer fix >= 2 samples; fall back to all samples when
  // the parser found no locked fixes (common with early-boot GPS or indoor starts).
  private setup(): void {
    const locked = this.gps.filter(s => s.fix >= 2);
    this.lockedGps  = locked.length > 0 ? locked : this.gps;
    this.baseOffset = this.lockedGps.length > 0 ? this.lockedGps[0].t : 0;
    this.initMap();
    if (this.lockedGps.length > 0) {
      this.startMarkerLoop();
    }
  }

  private teardown(): void {
    cancelAnimationFrame(this.rafId);
    this.map?.remove();
    this.map    = null;
    this.marker = null;
    this.rafId  = 0;
  }

  private initMap(): void {
    this.map = L.map(this.containerRef.nativeElement, {
      zoomControl:        false,
      attributionControl: false,
      dragging:           false,
      scrollWheelZoom:    false,
      doubleClickZoom:    false,
      boxZoom:            false,
      keyboard:           false,
      touchZoom:          false,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 },
    ).addTo(this.map);

    if (this.lockedGps.length === 0) {
      this.map.setView([0, 0], 2);
      return;
    }

    // Extract path directly from lockedGps — it is already filtered (or the fallback set),
    // so we do not re-filter by fix here; that would drop everything in the fallback case.
    const rawPath: [number, number][] = this.lockedGps.map(s => [s.lat, s.lon]);
    L.polyline(
      this.math.simplifyPath(rawPath, RDP_TOLERANCE),
      { color: PATH_COLOR, weight: PATH_WEIGHT, opacity: PATH_OPACITY },
    ).addTo(this.map);

    let minLat = this.lockedGps[0].lat, maxLat = this.lockedGps[0].lat;
    let minLon = this.lockedGps[0].lon, maxLon = this.lockedGps[0].lon;
    for (const { lat, lon } of this.lockedGps) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    this.map.fitBounds(
      [[minLat, minLon], [maxLat, maxLon]],
      { padding: BOUNDS_PADDING },
    );

    this.marker = L.circleMarker(
      [this.lockedGps[0].lat, this.lockedGps[0].lon],
      {
        radius:      MARKER_RADIUS,
        color:       MARKER_COLOR,
        fillColor:   MARKER_COLOR,
        fillOpacity: 0.9,
        weight:      2,
      },
    ).addTo(this.map);
  }

  private startMarkerLoop(): void {
    const tick = () => {
      this.updateMarker();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private updateMarker(): void {
    if (!this.marker) return;
    const targetTimeMs = this.baseOffset + (this.videoEl.currentTime * 1000);
    const atom = this.math.findClosestAtom(this.lockedGps, targetTimeMs);
    if (atom) {
      this.marker.setLatLng([atom.lat, atom.lon]);
    }
  }

  ngOnDestroy(): void {
    this.teardown();
  }
}
