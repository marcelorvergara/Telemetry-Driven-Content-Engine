package main

import (
	"encoding/binary"
	"math"
)

// GPMF FourCC codes packed as uint32 for allocation-free inner-loop comparison.
// BigEndian byte order matches how binary.BigEndian.Uint32 reads the wire bytes.
var (
	fccDEVC = pack('D', 'E', 'V', 'C')
	fccSTRM = pack('S', 'T', 'R', 'M')
	fccGPS9 = pack('G', 'P', 'S', '9')
	fccGPS5 = pack('G', 'P', 'S', '5')
	fccACCL = pack('A', 'C', 'C', 'L')
	fccGRAV = pack('G', 'R', 'A', 'V')
	fccSCAL = pack('S', 'C', 'A', 'L')
)

func pack(a, b, c, d byte) uint32 {
	return uint32(a)<<24 | uint32(b)<<16 | uint32(c)<<8 | uint32(d)
}

// klv is the 8-byte GPMF Key-Length-Value header that precedes every element.
type klv struct {
	key    uint32 // FourCC big-endian
	typ    byte   // data type: 'l'=int32, 's'=int16, 'f'=float32, 0=container
	size   uint8  // bytes per repeat
	repeat uint16 // number of repeats (big-endian on wire)
}

func (k klv) dataLen() int { return int(k.size) * int(k.repeat) }

func readKLV(buf []byte, pos int) (klv, int, bool) {
	if pos+8 > len(buf) {
		return klv{}, pos, false
	}
	return klv{
		key:    binary.BigEndian.Uint32(buf[pos:]),
		typ:    buf[pos+4],
		size:   buf[pos+5],
		repeat: binary.BigEndian.Uint16(buf[pos+6:]),
	}, pos + 8, true
}

// align4 rounds n up to the next 4-byte boundary (GPMF pads data blocks).
func align4(n int) int { return (n + 3) &^ 3 }

// readSCAL decodes a SCAL data block.
// SCAL can be a single value (repeat=1) applied to all fields, or one value
// per data field (repeat=N) as used by GPS9 (9 independent scale factors).
func readSCAL(data []byte, k klv) []int32 {
	out := make([]int32, int(k.repeat))
	switch k.typ {
	case 's': // int16
		for i := range out {
			out[i] = int32(int16(binary.BigEndian.Uint16(data[i*2:])))
		}
	case 'l': // int32
		for i := range out {
			out[i] = int32(binary.BigEndian.Uint32(data[i*4:]))
		}
	default:
		for i := range out {
			out[i] = 1
		}
	}
	return out
}

// applyScal divides raw by the scale factor for fieldIdx.
// Falls back to scal[0] when SCAL is a scalar (len==1).
func applyScal(raw int32, scal []int32, fieldIdx int) float64 {
	if len(scal) == 0 {
		return float64(raw)
	}
	idx := fieldIdx
	if idx >= len(scal) {
		idx = 0
	}
	if scal[idx] == 0 {
		return float64(raw)
	}
	return float64(raw) / float64(scal[idx])
}

// parseState carries cross-DEVC cumulative sample counts used for IMU timestamp
// synthesis. These counters must survive across parseDEVC calls so that ACCL/GRAV
// timestamps continue from where the previous DEVC block left off.
type parseState struct {
	videoStartSec  int64
	acclCumulative uint32
	gravCumulative uint32
}

// parse is the top-level entry point.
// buf is the pre-concatenated flat MET track binary provided by Angular.
// videoStartSec is the Unix timestamp (seconds) from the MP4 mvhd creation-time box.
func parse(buf []byte, videoStartSec int64) (*TelemetryResult, int) {
	result := &TelemetryResult{
		Status:          ErrSuccess,
		VideoStartEpoch: videoStartSec,
	}
	state := &parseState{videoStartSec: videoStartSec}

	pos := 0
	for pos < len(buf) {
		k, next, ok := readKLV(buf, pos)
		if !ok {
			break
		}
		dl := k.dataLen()
		if next+dl > len(buf) {
			return nil, ErrMalformedGPMF
		}
		if k.key == fccDEVC {
			if code := parseDEVC(buf[next:next+dl], result, state); code != ErrSuccess {
				return nil, code
			}
		}
		pos = next + align4(dl)
	}

	if len(result.GPS) == 0 && len(result.ACCL) == 0 {
		return nil, ErrNoSupportedStream
	}
	return result, ErrSuccess
}

func parseDEVC(buf []byte, result *TelemetryResult, state *parseState) int {
	pos := 0
	for pos < len(buf) {
		k, next, ok := readKLV(buf, pos)
		if !ok {
			break
		}
		dl := k.dataLen()
		if next+dl > len(buf) {
			return ErrMalformedGPMF
		}
		if k.key == fccSTRM {
			parseSTRM(buf[next:next+dl], result, state)
		}
		pos = next + align4(dl)
	}
	return ErrSuccess
}

func parseSTRM(buf []byte, result *TelemetryResult, state *parseState) {
	var scal []int32
	pos := 0
	for pos < len(buf) {
		k, next, ok := readKLV(buf, pos)
		if !ok {
			break
		}
		dl := k.dataLen()
		if next+dl > len(buf) {
			return
		}
		data := buf[next : next+dl]

		switch k.key {
		case fccSCAL:
			scal = readSCAL(data, k)

		case fccGPS9:
			result.GPS = append(result.GPS,
				decodeGPS9(data, int(k.repeat), int(k.size), scal, state.videoStartSec)...)

		case fccGPS5:
			// Only fall back to GPS5 if no GPS9 data has been seen yet.
			if len(result.GPS) == 0 {
				result.GPS = append(result.GPS,
					decodeGPS5(data, int(k.repeat), int(k.size), scal)...)
			}

		case fccACCL:
			result.ACCL = append(result.ACCL,
				decodeACCL(data, int(k.repeat), scal, state.acclCumulative)...)
			state.acclCumulative += uint32(k.repeat)

		case fccGRAV:
			result.GRAV = append(result.GRAV,
				decodeGRAV(data, int(k.repeat), k.typ, scal, state.gravCumulative)...)
			state.gravCumulative += uint32(k.repeat)
		}

		pos = next + align4(dl)
	}
}

// decodeGPS9 decodes GPS9 samples. GoPro firmware variants emit either 8 or 9
// int32 fields per sample (stride = k.size: 32 or 36 bytes). Newer firmware
// may append extra fields making stride ≥ 40; sampleSize is taken directly from
// k.size so the loop always advances by the correct number of bytes.
//
// Standard 9-field layout (stride=36), per-field SCAL from GPS9's SCAL array:
//
//	[0] lat      degrees  [1] lon      degrees  [2] alt     metres
//	[3] speed2d  m/s      [4] speed3d  m/s      [5] days    since Jan 1 2000
//	[6] secs     of day   [7] DOP      precision [8] fix     0/2/3
//
// 8-field variant (stride=32): fields 0-6 are identical; bytes 28-29 hold DOP
// as a big-endian int16 (divide by 100) and byte 30 holds fix as uint8.
//
// Timestamps use GPS UTC (fields 5+6) anchored to videoStartSec from mvhd.
func decodeGPS9(data []byte, repeat, sampleSize int, scal []int32, videoStartSec int64) []GPS9Sample {
	const coreBytes = 28 // fields 0-6 (7 × 4 bytes) — minimum for speed + time
	if sampleSize < coreBytes {
		return nil
	}
	numFields := sampleSize / 4
	if numFields > 9 {
		numFields = 9
	}
	out := make([]GPS9Sample, 0, repeat)
	for i := 0; i < repeat; i++ {
		base := i * sampleSize
		if base+sampleSize > len(data) {
			break
		}
		var f [9]int32
		for j := 0; j < numFields; j++ {
			f[j] = int32(binary.BigEndian.Uint32(data[base+j*4:]))
		}
		days := f[5]
		// Keep secsOfDay as float64 so the fractional-second part survives into ms.
		secsOfDay := applyScal(f[6], scal, 6)
		unixFrac := float64(GPS2000Epoch+int64(days)*86400) + secsOfDay
		tMs := (unixFrac - float64(videoStartSec)) * 1000

		var fix int
		var dop float64
		if numFields >= 9 {
			fix = int(f[8])
			dop = applyScal(f[7], scal, 7)
		} else {
			// 8-field packed: DOP as int16 big-endian at bytes 28-29, fix as uint8 at byte 30.
			dop = float64(int16(binary.BigEndian.Uint16(data[base+28:]))) / 100.0
			fix = int(data[base+30])
		}

		out = append(out, GPS9Sample{
			T:       tMs,
			Lat:     applyScal(f[0], scal, 0),
			Lon:     applyScal(f[1], scal, 1),
			Alt:     applyScal(f[2], scal, 2),
			Speed2D: applyScal(f[3], scal, 3),
			Speed3D: applyScal(f[4], scal, 4),
			Fix:     fix,
			DOP:     dop,
		})
	}
	return out
}

// decodeGPS5 decodes GPS5 samples (Hero 10 and older). Standard layout: 5 × int32 (stride=20).
// sampleSize is taken from k.size so any extra trailing fields are skipped cleanly.
// GPS5 has no UTC fields; timestamps are synthesised from sample index at 18 Hz.
// All samples receive Fix=2 (2-D assumed) since GPS5 carries no fix field.
// TODO: Anchor to chunk timestamps from Angular when available.
func decodeGPS5(data []byte, repeat, sampleSize int, scal []int32) []GPS9Sample {
	const fieldsBytes = 20 // always read 5 × 4 bytes regardless of sampleSize
	const rateHz = 18.0
	if sampleSize < fieldsBytes {
		sampleSize = fieldsBytes
	}
	out := make([]GPS9Sample, 0, repeat)
	for i := 0; i < repeat; i++ {
		base := i * sampleSize
		if base+fieldsBytes > len(data) {
			break
		}
		var f [5]int32
		for j := range f {
			f[j] = int32(binary.BigEndian.Uint32(data[base+j*4:]))
		}
		out = append(out, GPS9Sample{
			T:       float64(i) * 1000 / rateHz,
			Lat:     applyScal(f[0], scal, 0),
			Lon:     applyScal(f[1], scal, 1),
			Alt:     applyScal(f[2], scal, 2),
			Speed2D: applyScal(f[3], scal, 3),
			Speed3D: applyScal(f[4], scal, 4),
			Fix:     2,
			DOP:     0,
		})
	}
	return out
}

// decodeACCL decodes accelerometer samples. Each sample = 3 × int16 big-endian, in m/s².
// Timestamps are synthesised from the cumulative sample offset at the nominal 200 Hz rate.
// This is accurate for continuous recordings but drifts after any pause/resume gap.
// TODO: Anchor to GPS-derived block time once Angular sends per-DEVC chunk timestamps.
func decodeACCL(data []byte, repeat int, scal []int32, cumOffset uint32) []ACCLSample {
	const stride = 6 // 3 × 2 bytes
	out := make([]ACCLSample, 0, repeat)
	for i := 0; i < repeat; i++ {
		base := i * stride
		if base+stride > len(data) {
			break
		}
		x := int32(int16(binary.BigEndian.Uint16(data[base:])))
		y := int32(int16(binary.BigEndian.Uint16(data[base+2:])))
		z := int32(int16(binary.BigEndian.Uint16(data[base+4:])))
		tMs := float64(cumOffset+uint32(i)) * 1000 / acclRateHz
		out = append(out, ACCLSample{
			T: tMs,
			X: applyScal(x, scal, 0),
			Y: applyScal(y, scal, 1),
			Z: applyScal(z, scal, 2),
		})
	}
	return out
}

// decodeGRAV decodes gravity-vector samples.
// Hero 11 firmware emits GRAV as float32 (typ='f'); older firmware uses int16+SCAL (typ='s').
// The klv type byte selects the decode path so both firmware variants are handled.
// Timestamps follow the same cumulative-offset convention as ACCL.
func decodeGRAV(data []byte, repeat int, typ byte, scal []int32, cumOffset uint32) []GRAVSample {
	out := make([]GRAVSample, 0, repeat)
	switch typ {
	case 'f': // float32 — Hero 11 firmware, no SCAL applied
		const stride = 12 // 3 × 4 bytes
		for i := 0; i < repeat; i++ {
			base := i * stride
			if base+stride > len(data) {
				break
			}
			x := math.Float32frombits(binary.BigEndian.Uint32(data[base:]))
			y := math.Float32frombits(binary.BigEndian.Uint32(data[base+4:]))
			z := math.Float32frombits(binary.BigEndian.Uint32(data[base+8:]))
			tMs := float64(cumOffset+uint32(i)) * 1000 / gravRateHz
			out = append(out, GRAVSample{T: tMs, X: float64(x), Y: float64(y), Z: float64(z)})
		}
	case 's': // int16 + SCAL — older firmware
		const stride = 6 // 3 × 2 bytes
		for i := 0; i < repeat; i++ {
			base := i * stride
			if base+stride > len(data) {
				break
			}
			x := int32(int16(binary.BigEndian.Uint16(data[base:])))
			y := int32(int16(binary.BigEndian.Uint16(data[base+2:])))
			z := int32(int16(binary.BigEndian.Uint16(data[base+4:])))
			tMs := float64(cumOffset+uint32(i)) * 1000 / gravRateHz
			out = append(out, GRAVSample{
				T: tMs,
				X: applyScal(x, scal, 0),
				Y: applyScal(y, scal, 1),
				Z: applyScal(z, scal, 2),
			})
		}
	}
	return out
}
