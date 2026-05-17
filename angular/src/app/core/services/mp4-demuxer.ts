import { Injectable } from '@angular/core';
import { ISOFile, MP4BoxBuffer, Movie, Sample, Track, createFile } from 'mp4box';

export interface DemuxResult {
  readonly metBytes: Uint8Array;
  readonly videoStartSec: number;
}

// GoPro telemetry track identifier.
// Primary: codec FourCC == 'gpmd' (Hero 6 and later).
// Fallback: handler name contains 'GoPro MET' (older firmware variants).
const GPMD_CODEC = 'gpmd';
const GPMD_NAME_FRAGMENT = 'gopro met';

// 1 MB per slice — keeps the main-thread heap flat even for 4+ GB GoPro originals.
// mp4box processes each slice and can GC video/audio mdat bytes that we never
// configure for extraction.
const CHUNK_SIZE = 1 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class Mp4DemuxerService {

  // Extracts the raw GPMF binary payload from a GoPro MP4 file.
  // Returns a lean Uint8Array (typically 1–5 MB) ready for the Go-WASM bridge.
  // Short-circuits as soon as all expected telemetry samples are received —
  // the gigabyte-sized mdat video payload is never read past that point.
  extract(file: File): Promise<DemuxResult> {
    const mp4File: ISOFile = createFile();
    // Shared abort flag: set by settle() so feedChunks stops between chunks.
    let aborted = false;

    return new Promise<DemuxResult>((resolve, reject) => {
      const sampleChunks: Uint8Array[] = [];
      let expectedSamples = 0;
      let receivedSamples = 0;
      let videoStartSec = 0;
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          aborted = true; // Signal feedChunks to stop between chunk boundaries.
          mp4File.stop();
          fn();
        }
      };

      // Resolve as soon as all expected samples have arrived — no need to wait
      // for the file to be fully fed. settle() sets aborted=true, which stops
      // feedChunks on the next iteration check.
      const tryResolve = () => {
        if (!settled && expectedSamples > 0 && receivedSamples >= expectedSamples) {
          settle(() => resolve({
            metBytes: concatUint8Arrays(sampleChunks),
            videoStartSec,
          }));
        }
      };

      mp4File.onReady = (info: Movie) => {
        // Read creation timestamp first — valid for both GoPro and standard MP4s.
        videoStartSec = Math.max(0, Math.floor(info.created.getTime() / 1000));

        const gpmfTrack: Track | undefined = info.tracks.find(
          (t: Track) =>
            t.codec === GPMD_CODEC ||
            t.name.toLowerCase().includes(GPMD_NAME_FRAGMENT),
        );

        if (!gpmfTrack) {
          // Standard Android/smartphone MP4 — no telemetry track is not an error.
          // Resolve with empty bytes so the pipeline can surface the no-telemetry UI
          // and accept a Strava GPX for biometrics, anchored to this videoStartSec.
          settle(() => resolve({ metBytes: new Uint8Array(0), videoStartSec }));
          return;
        }

        expectedSamples = gpmfTrack.nb_samples;

        mp4File.setExtractionOptions(gpmfTrack.id, null, { nbSamples: Infinity });
        mp4File.start();
      };

      mp4File.onSamples = (_id: number, _user: unknown, samples: Sample[]) => {
        for (const s of samples) {
          if (s.data) {
            // Defensive copy: mp4box may reuse the underlying buffer across callbacks.
            sampleChunks.push(s.data.slice());
            receivedSamples++;
          }
        }
        tryResolve();
      };

      // v2 onError signature: (module: string, message: string)
      mp4File.onError = (_module: string, message: string) => {
        settle(() => reject(new Error(`MP4 parse error: ${message}`)));
      };

      this.feedChunks(file, mp4File, () => aborted)
        .then(() => {
          // feedChunks completed without early abort — file fully fed.
          // Guard: if settle() already fired (all samples arrived mid-stream),
          // skip flush to avoid calling mp4File methods after mp4File.stop().
          if (settled) return;
          // flush() processes any data mp4box buffered waiting for a complete box.
          mp4File.flush();
          tryResolve();
        })
        .catch(err => settle(() => reject(err)));
    });
  }

  private async feedChunks(
    file: File,
    mp4File: ISOFile,
    isAborted: () => boolean,
  ): Promise<void> {
    let offset = 0;
    while (offset < file.size) {
      // Check before the async slice/read so we bail immediately after settle().
      if (isAborted()) return;

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const arrayBuffer = await file.slice(offset, end).arrayBuffer();

      // Check again after the await — settle() may have fired while we were
      // waiting for the disk read to complete.
      if (isAborted()) return;

      // Universal mp4box convention: stamp the buffer with its global file
      // position before appending. appendBuffer() returns the next expected
      // offset; use it directly so mp4box controls sequencing.
      (arrayBuffer as MP4BoxBuffer).fileStart = offset;
      const nextOffset = mp4File.appendBuffer(arrayBuffer as MP4BoxBuffer);
      offset = typeof nextOffset === 'number' ? nextOffset : end;
    }
  }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const arr of arrays) {
    out.set(arr, pos);
    pos += arr.byteLength;
  }
  return out;
}
