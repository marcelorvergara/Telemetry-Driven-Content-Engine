import { Injectable, OnDestroy } from '@angular/core';
import type { TelemetryResult, WorkerResponse } from '../models/telemetry.model';

// Provide at component level (not root) if the component's ngOnDestroy must
// trigger nuke() on navigation away. Root-level provision keeps the worker alive
// until the user selects a new file (nuke() is called at the start of parse()).
@Injectable({ providedIn: 'root' })
export class GpmfParserService implements OnDestroy {
  private activeWorker: Worker | null = null;

  // Spins up a fresh WASM worker, transfers the MET byte buffer to it (zero-copy),
  // and resolves with TelemetryResult. Calling parse() while a previous parse is
  // in flight terminates the old worker first (new-file selection case).
  parse(metBytes: Uint8Array, videoStartSec: number): Promise<TelemetryResult> {
    this.nuke();

    return new Promise<TelemetryResult>((resolve, reject) => {
      const worker = new Worker(
        new URL('../workers/gpmf-parser.worker', import.meta.url),
        { type: 'module' },
      );
      this.activeWorker = worker;

      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        this.nuke();
        if (data.ok) {
          resolve(data.result);
        } else {
          reject(new Error(data.message ?? `GPMF error code ${data.code}`));
        }
      };

      worker.onerror = (event) => {
        this.nuke();
        reject(new Error(event.message));
      };

      // Transfer the ArrayBuffer — the parent's metBytes becomes detached (zero-length)
      // and the worker takes full ownership, avoiding a memory copy.
      worker.postMessage({ metBytes, videoStartSec }, [metBytes.buffer]);
    });
  }

  // Terminates the worker immediately, releasing its WebAssembly.Memory.
  // Safe to call even when no worker is active.
  nuke(): void {
    this.activeWorker?.terminate();
    this.activeWorker = null;
  }

  ngOnDestroy(): void {
    this.nuke();
  }
}
