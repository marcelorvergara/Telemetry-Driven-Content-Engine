/// <reference lib="webworker" />

// Ephemeral WASM worker — receives exactly one ParseRequest, posts one ParseResponse, exits.
// The parent GpmfParserService calls worker.terminate() after the response, releasing the
// entire WebAssembly.Memory in one atomic operation (the Nuke Option).

import type { TelemetryResult, WorkerRequest, WorkerResponse } from '../models/telemetry.model';

// ---------- Types for TinyGo's wasm_exec.js runtime ----------

interface GoInstance {
  importObject: WebAssembly.Imports;
  // Resolves when the Go program exits; for goroutine-free programs (ours) this
  // resolves as soon as main() returns. Do NOT await in the caller — see runParse.
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface GpmfExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  allocBuffer(size: number): number;
  parseGPMF(length: number, videoStartSec: number): number;
  getResultPtr(): number;
  getResultLen(): number;
}

// ---------- Error code table (mirrors types.go) ----------

const ERR_SUCCESS = 0;
const ERR_NAMES: Readonly<Record<number, string>> = {
  1: 'ErrMalformedGPMF',
  2: 'ErrMemLimit',
  3: 'ErrNoSupportedStream',
};

// ---------- Entry point ----------

addEventListener('message', async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const result = await runParse(data.metBytes, data.videoStartSec);
    postMessage({ ok: true, result } satisfies WorkerResponse);
  } catch (err) {
    postMessage({ ok: false, code: -1, message: String(err) } satisfies WorkerResponse);
  }
});

// ---------- WASM bridge ----------

async function runParse(metBytes: Uint8Array, videoStartSec: number): Promise<TelemetryResult> {
  // wasm_exec.js is TinyGo's runtime bootstrap. It is a classic (non-module) script,
  // so importScripts() is unavailable in a module worker. We fetch the text and
  // evaluate it via Function constructor to install the `Go` global in this scope.
  const goExecText = await fetch('/assets/wasm_exec.js').then(r => r.text());
  // eslint-disable-next-line no-new-func
  new Function(goExecText)();
  const GoRuntime = (globalThis as Record<string, unknown>)['Go'] as new () => GoInstance;

  const go = new GoRuntime();
  const { instance } = await WebAssembly.instantiateStreaming(
    fetch('/assets/gpmf.wasm'),
    go.importObject,
  );

  // Kick off the TinyGo runtime. We intentionally do NOT await: go.run() only
  // resolves when the program exits, which hangs for programs with live goroutines.
  // TinyGo calls _start() (and thus our empty main()) synchronously in the first
  // microtask of go.run(), so the memory allocator is fully initialized by the
  // time our next line executes.
  void go.run(instance);

  const exp = instance.exports as unknown as GpmfExports;

  const ptr = exp.allocBuffer(metBytes.byteLength);
  if (ptr === 0) {
    throw new Error('allocBuffer returned null — WASM out of memory');
  }
  new Uint8Array(exp.memory.buffer, ptr, metBytes.byteLength).set(metBytes);

  const code = exp.parseGPMF(metBytes.byteLength, videoStartSec);
  if (code !== ERR_SUCCESS) {
    throw new Error(ERR_NAMES[code] ?? `GPMF error code ${code}`);
  }

  const resultPtr = exp.getResultPtr();
  const resultLen = exp.getResultLen();
  const json = new TextDecoder().decode(
    new Uint8Array(exp.memory.buffer, resultPtr, resultLen),
  );

  return JSON.parse(json) as TelemetryResult;
}
