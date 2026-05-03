package main

import (
	"strconv"
	"unsafe"
)

// inputBuf holds the pre-allocated GPMF binary written by JS before parseGPMF.
// outputBuf holds the JSON result written by parseGPMF and read by JS after.
// Both are package-level to survive across exported function calls without GC pressure.
var (
	inputBuf  []byte
	outputBuf []byte
)

// main is required by TinyGo's wasm target; the browser never calls it.
func main() {}

// allocBuffer allocates the WASM-side input buffer and returns its linear-memory pointer.
//
// JS usage:
//
//	const ptr = exports.allocBuffer(gpmfBytes.byteLength);
//	new Uint8Array(exports.memory.buffer, ptr, gpmfBytes.byteLength).set(gpmfBytes);
//
//export allocBuffer
func allocBuffer(size uint32) uint32 {
	inputBuf = make([]byte, int(size))
	if len(inputBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&inputBuf[0])))
}

// parseGPMF parses the first `length` bytes of the allocated input buffer.
// videoStartSec is the Unix timestamp in seconds extracted from the MP4 mvhd box
// by the Angular service. Passed as uint32 (sufficient until year 2106).
//
// Returns an ErrXxx constant. On ErrSuccess call getResultPtr/getResultLen to read JSON.
//
// JS usage:
//
//	const code = exports.parseGPMF(gpmfBytes.byteLength, videoStartSec);
//	if (code === 0) {
//	  const len = exports.getResultLen();
//	  const json = new TextDecoder().decode(
//	    new Uint8Array(exports.memory.buffer, exports.getResultPtr(), len));
//	}
//
//export parseGPMF
func parseGPMF(length, videoStartSec uint32) uint32 {
	if int(length) > len(inputBuf) {
		return ErrMalformedGPMF
	}
	result, code := parse(inputBuf[:length], int64(videoStartSec))
	if code != ErrSuccess {
		outputBuf = outputBuf[:0]
		return uint32(code)
	}
	outputBuf = marshalResult(result)
	return ErrSuccess
}

// getResultPtr returns the pointer to the JSON output buffer.
// Only valid immediately after a successful parseGPMF call; reallocating inputBuf
// or calling parseGPMF again invalidates the previous pointer.
//
//export getResultPtr
func getResultPtr() uint32 {
	if len(outputBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&outputBuf[0])))
}

// getResultLen returns the byte length of the JSON output buffer.
//
//export getResultLen
func getResultLen() uint32 {
	return uint32(len(outputBuf))
}

// ---------------------------------------------------------------------------
// Manual JSON marshaler — no encoding/json, no reflection, TinyGo-safe.
// Produces: {"status":N,"videoStartEpoch":N,"gps":[...],"accl":[...],"grav":[...]}
// ---------------------------------------------------------------------------

func marshalResult(r *TelemetryResult) []byte {
	b := make([]byte, 0, 512)
	b = append(b, `{"status":`...)
	b = strconv.AppendInt(b, int64(r.Status), 10)
	b = append(b, `,"videoStartEpoch":`...)
	b = strconv.AppendInt(b, r.VideoStartEpoch, 10)
	b = append(b, `,"gps":`...)
	b = marshalGPSArray(b, r.GPS)
	b = append(b, `,"accl":`...)
	b = marshalACCLArray(b, r.ACCL)
	b = append(b, `,"grav":`...)
	b = marshalGRAVArray(b, r.GRAV)
	b = append(b, '}')
	return b
}

// appendF appends a float64 in shortest decimal notation — no scientific notation,
// no reflection, round-trips exactly through JSON.parse on the JS side.
func appendF(b []byte, f float64) []byte {
	return strconv.AppendFloat(b, f, 'f', -1, 64)
}

func marshalGPSArray(b []byte, ss []GPS9Sample) []byte {
	b = append(b, '[')
	for i, s := range ss {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"t":`...)
		b = appendF(b, s.T)
		b = append(b, `,"lat":`...)
		b = appendF(b, s.Lat)
		b = append(b, `,"lon":`...)
		b = appendF(b, s.Lon)
		b = append(b, `,"alt":`...)
		b = appendF(b, s.Alt)
		b = append(b, `,"speed2d":`...)
		b = appendF(b, s.Speed2D)
		b = append(b, `,"speed3d":`...)
		b = appendF(b, s.Speed3D)
		b = append(b, `,"fix":`...)
		b = strconv.AppendInt(b, int64(s.Fix), 10)
		b = append(b, `,"dop":`...)
		b = appendF(b, s.DOP)
		b = append(b, '}')
	}
	b = append(b, ']')
	return b
}

func marshalACCLArray(b []byte, ss []ACCLSample) []byte {
	b = append(b, '[')
	for i, s := range ss {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"t":`...)
		b = appendF(b, s.T)
		b = append(b, `,"x":`...)
		b = appendF(b, s.X)
		b = append(b, `,"y":`...)
		b = appendF(b, s.Y)
		b = append(b, `,"z":`...)
		b = appendF(b, s.Z)
		b = append(b, '}')
	}
	b = append(b, ']')
	return b
}

func marshalGRAVArray(b []byte, ss []GRAVSample) []byte {
	b = append(b, '[')
	for i, s := range ss {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"t":`...)
		b = appendF(b, s.T)
		b = append(b, `,"x":`...)
		b = appendF(b, s.X)
		b = append(b, `,"y":`...)
		b = appendF(b, s.Y)
		b = append(b, `,"z":`...)
		b = appendF(b, s.Z)
		b = append(b, '}')
	}
	b = append(b, ']')
	return b
}
