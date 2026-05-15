import { Injectable } from '@angular/core';
import { StravaGpsPoint } from '../models/telemetry.model';

@Injectable({ providedIn: 'root' })
export class StravaTelemetryService {

  // Parse a .gpx file and return an array of StravaGpsPoints whose .t is
  // milliseconds from the video start epoch.  All timestamps are derived from
  // the ISO 8601 <time> element inside each <trkpt>; videoStartSec is the Unix
  // epoch of frame 0 (from the MP4 mvhd box, or 0 when no GoPro clip is loaded).
  async parseGpx(file: File, videoStartSec: number): Promise<StravaGpsPoint[]> {
    const text = await file.text();
    const doc  = new DOMParser().parseFromString(text, 'application/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error(`GPX parse failed: ${parseError.textContent}`);

    const NS_TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
    const trkpts = Array.from(doc.querySelectorAll('trkpt'));
    const data: StravaGpsPoint[] = trkpts.map(pt => {
      const lat     = parseFloat(pt.getAttribute('lat') ?? '0');
      const lon     = parseFloat(pt.getAttribute('lon') ?? '0');
      const ele     = parseFloat(pt.querySelector('ele')?.textContent  ?? '0');
      const timeStr = pt.querySelector('time')?.textContent ?? '';

      const hr  = parseInt(pt.getElementsByTagNameNS(NS_TPX, 'hr')[0]?.textContent  ?? '0', 10) || 0;
      const cad = parseInt(pt.getElementsByTagNameNS(NS_TPX, 'cad')[0]?.textContent ?? '0', 10) || 0;

      // ISO 8601 → Unix milliseconds
      const absoluteUnixMs  = new Date(timeStr).getTime();
      const relativeTimeSec = absoluteUnixMs / 1000 - videoStartSec;

      // speed placeholder — filled in the second pass below
      return { t: relativeTimeSec * 1000, lat, lon, ele, hr, cad, speed: 0, relativeTimeSec, absoluteUnixMs };
    });

    // Second pass: Haversine speed between adjacent points.
    // Point 0 inherits point 1's speed so the display starts non-zero.
    for (let i = 1; i < data.length; i++) {
      const dt = (data[i].absoluteUnixMs - data[i - 1].absoluteUnixMs) / 1000;
      data[i].speed = dt > 0 ? this.haversineMetres(data[i - 1].lat, data[i - 1].lon, data[i].lat, data[i].lon) / dt : 0;
    }
    if (data.length > 1) data[0].speed = data[1].speed;

    return data;
  }

  private haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
