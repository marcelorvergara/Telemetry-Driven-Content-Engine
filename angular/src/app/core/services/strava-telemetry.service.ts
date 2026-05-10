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

    const trkpts = Array.from(doc.querySelectorAll('trkpt'));
    const data: StravaGpsPoint[] = trkpts.map(pt => {
      const lat     = parseFloat(pt.getAttribute('lat') ?? '0');
      const lon     = parseFloat(pt.getAttribute('lon') ?? '0');
      const ele     = parseFloat(pt.querySelector('ele')?.textContent  ?? '0');
      const timeStr = pt.querySelector('time')?.textContent ?? '';

      // ISO 8601 → Unix milliseconds
      const absoluteUnixMs  = new Date(timeStr).getTime();
      const relativeTimeSec = absoluteUnixMs / 1000 - videoStartSec;

      return { t: relativeTimeSec * 1000, lat, lon, ele, relativeTimeSec, absoluteUnixMs };
    });

    console.log(
      '[Task 2 Complete] GPX Parser: Extracted', data.length,
      'points. First point relative time:', data[0]?.relativeTimeSec,
    );
    return data;
  }
}
