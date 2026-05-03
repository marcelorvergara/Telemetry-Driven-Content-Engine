package main

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"testing"
)

// sampleHex is the first 256 bytes of a real GoPro Hero 13 Black MET track
// (10-second clip, accelerometer stream). Used to pin readKLV against wire bytes.
const sampleHex = "4445564300015D14445649444C0400010000000144564E4D630C00014845524F313320426C61636B5354524D0001051853544D504A0800010000000000005DC454534D504C040001000000C753544E4D630D0001416363656C65726F6D657465720000004F52494E630300015A5859005349554E630400016D2F73B25343414C7302000101A10000544D504366040001425FD6004143434C730600C7EEAC01AA06D9EE790189075BEE65016507CCEE680145081EEE7F012E086CEEB0012308CDEEFF01140909EF5E011E091BEFBA013608BCEFF701330825F036012D077DF071010D06E4F09200D8067DF07A00B10612F06200840579F053004D04EAF04B0012"

func decodeSample(t *testing.T) []byte {
	t.Helper()
	b, err := hex.DecodeString(sampleHex)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestReadKLV_Headers pins readKLV against known wire bytes in the Hero 13 sample.
//
// Verified offsets (relative to start of MET track slice):
//   0   DEVC  type=0x00(container)  size=1  repeat=23828  → 23828 bytes nested
//  40   STRM  type=0x00(container)  size=1  repeat=1304   → 1304 bytes nested
//  48   STMP  type='J'(uint64)      size=8  repeat=1
//  64   TSMP  type='L'(uint32)      size=4  repeat=1      → value=199 total samples
// 124   SCAL  type='s'(int16)       size=2  repeat=1
// 148   ACCL  type='s'(int16)       size=6  repeat=199
func TestReadKLV_Headers(t *testing.T) {
	buf := decodeSample(t)
	tests := []struct {
		name    string
		offset  int
		wantKey uint32
		wantTyp byte
		wantSz  uint8
		wantRep uint16
	}{
		{"DEVC", 0, fccDEVC, 0x00, 1, 23828},
		{"STRM", 40, fccSTRM, 0x00, 1, 1304},
		{"SCAL", 124, fccSCAL, 's', 2, 1},
		{"ACCL", 148, fccACCL, 's', 6, 199},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			k, next, ok := readKLV(buf, tt.offset)
			if !ok {
				t.Fatal("readKLV returned false")
			}
			if k.key != tt.wantKey {
				t.Errorf("key: want %08X got %08X", tt.wantKey, k.key)
			}
			if k.typ != tt.wantTyp {
				t.Errorf("typ: want 0x%02X got 0x%02X", tt.wantTyp, k.typ)
			}
			if k.size != tt.wantSz {
				t.Errorf("size: want %d got %d", tt.wantSz, k.size)
			}
			if k.repeat != tt.wantRep {
				t.Errorf("repeat: want %d got %d", tt.wantRep, k.repeat)
			}
			if next != tt.offset+8 {
				t.Errorf("next: want %d got %d", tt.offset+8, next)
			}
		})
	}
}

// TestReadKLV_ContainerDataLen verifies that container KLVs (type=0) report
// dataLen in bytes, not element count.  This is the mechanism that lets
// parseDEVC and parseSTRM receive a correctly sized sub-slice.
func TestReadKLV_ContainerDataLen(t *testing.T) {
	buf := decodeSample(t)
	k, _, _ := readKLV(buf, 0)
	if k.dataLen() != 23828 {
		t.Fatalf("DEVC dataLen: want 23828 got %d", k.dataLen())
	}
	k, _, _ = readKLV(buf, 40)
	if k.dataLen() != 1304 {
		t.Fatalf("STRM dataLen: want 1304 got %d", k.dataLen())
	}
}

// TestReadKLV_Truncated verifies the bounds check — 7 bytes is not enough for a header.
func TestReadKLV_Truncated(t *testing.T) {
	_, _, ok := readKLV([]byte{0x44, 0x45, 0x56, 0x43, 0x00, 0x01, 0x5D}, 0)
	if ok {
		t.Fatal("expected false for 7-byte buffer, got true")
	}
}

// TestReadKLV_ExactBoundary verifies 8 bytes is accepted and 0 bytes is not.
func TestReadKLV_ExactBoundary(t *testing.T) {
	buf := decodeSample(t)
	_, _, ok := readKLV(buf[:8], 0)
	if !ok {
		t.Fatal("8-byte buffer should succeed")
	}
	_, _, ok = readKLV(buf[:8], 1) // pos+8 = 9 > 8
	if ok {
		t.Fatal("pos=1 in 8-byte buffer should fail")
	}
}

// TestAlign4 pins the 4-byte alignment helper.
func TestAlign4(t *testing.T) {
	cases := [][2]int{{0, 0}, {1, 4}, {2, 4}, {3, 4}, {4, 4}, {5, 8}, {12, 12}, {13, 16}}
	for _, c := range cases {
		if got := align4(c[0]); got != c[1] {
			t.Errorf("align4(%d): want %d got %d", c[0], c[1], got)
		}
	}
}

// TestReadSCAL_FromSample decodes the SCAL KLV at offset 124 and expects 417.
// Wire bytes at 132-133: 0x01 0xA1 = int16 big-endian = 417.
func TestReadSCAL_FromSample(t *testing.T) {
	buf := decodeSample(t)
	k, next, ok := readKLV(buf, 124)
	if !ok {
		t.Fatal("readKLV returned false")
	}
	if k.key != fccSCAL {
		t.Fatalf("want SCAL got %08X", k.key)
	}
	scal := readSCAL(buf[next:next+k.dataLen()], k)
	if len(scal) != 1 || scal[0] != 417 {
		t.Fatalf("want [417] got %v", scal)
	}
}

// TestDecodeACCL_FirstSample applies SCAL=417 to sample[0] from the real binary.
// Raw wire bytes at 156-161: EE AC 01 AA 06 D9
//   X = int16(0xEEAC) = -4436    -4436/417 ≈ -10.6379
//   Y = int16(0x01AA) =   426      426/417 ≈  1.0216
//   Z = int16(0x06D9) =  1753     1753/417 ≈  4.2038
func TestDecodeACCL_FirstSample(t *testing.T) {
	buf := decodeSample(t)
	samples := decodeACCL(buf[156:162], 1, []int32{417}, 0)
	if len(samples) != 1 {
		t.Fatalf("want 1 sample, got %d", len(samples))
	}
	s := samples[0]
	check := func(field string, got, rawInt float64) {
		t.Helper()
		want := rawInt / 417.0
		if math.Abs(got-want) > 1e-9 {
			t.Errorf("%s: want %v got %v", field, want, got)
		}
	}
	check("X", s.X, -4436)
	check("Y", s.Y, 426)
	check("Z", s.Z, 1753)
	if s.T != 0 {
		t.Errorf("T: want 0 (first sample, cumOffset=0) got %v", s.T)
	}
}

// TestDecodeACCL_TimestampProgression verifies cumulative timestamp synthesis.
// At 200 Hz, sample i has T = i * (1000/200) = i * 5 ms.
func TestDecodeACCL_TimestampProgression(t *testing.T) {
	buf := decodeSample(t)
	// Use 3 samples starting at cumOffset=10 (simulating a second DEVC block).
	samples := decodeACCL(buf[156:174], 3, []int32{417}, 10)
	if len(samples) != 3 {
		t.Fatalf("want 3 samples, got %d", len(samples))
	}
	for i, s := range samples {
		wantT := float64(10+i) * 1000.0 / acclRateHz
		if math.Abs(s.T-wantT) > 1e-9 {
			t.Errorf("sample[%d].T: want %v got %v", i, wantT, s.T)
		}
	}
}

// TestDecodeGPS9_SubSecondPrecision proves the secsOfDay fractional part is
// preserved.  One synthetic GPS9 sample:
//   days=9600, secs_raw=43200500 with SCAL[6]=1000 → secsOfDay=43200.500
//   videoStartSec = GPS2000Epoch + 9600×86400 + 43200 = 1776168000
//   expected tMs = 0.500 × 1000 = 500.0 ms
// With the old int64(secsOfDay) truncation the result would be 0 ms.
func TestDecodeGPS9_SubSecondPrecision(t *testing.T) {
	// 9 × int32 big-endian: lat=0 lon=0 alt=0 speed2d=0 speed3d=0
	//   days=9600(0x2580)  secs_raw=43200500(0x02932FF4)  dop=0  fix=3
	data := []byte{
		0x00, 0x00, 0x00, 0x00, // lat
		0x00, 0x00, 0x00, 0x00, // lon
		0x00, 0x00, 0x00, 0x00, // alt
		0x00, 0x00, 0x00, 0x00, // speed2d
		0x00, 0x00, 0x00, 0x00, // speed3d
		0x00, 0x00, 0x25, 0x80, // days = 9600
		0x02, 0x93, 0x2F, 0xF4, // secs_raw = 43200500
		0x00, 0x00, 0x00, 0x00, // dop
		0x00, 0x00, 0x00, 0x03, // fix = 3
	}
	// SCAL: all fields = 1 except field[6] (secs) = 1000
	scal := []int32{1, 1, 1, 1, 1, 1, 1000, 1, 1}

	// videoStartSec aligns to exactly 43200 whole seconds into that day
	videoStartSec := GPS2000Epoch + int64(9600)*86400 + 43200

	samples := decodeGPS9(data, 1, 36, scal, videoStartSec)
	if len(samples) != 1 {
		t.Fatalf("want 1 sample, got %d", len(samples))
	}
	if math.Abs(samples[0].T-500.0) > 1e-9 {
		t.Errorf("T: want 500.0 ms got %v (fractional seconds lost?)", samples[0].T)
	}
	if samples[0].Fix != 3 {
		t.Errorf("Fix: want 3 got %d", samples[0].Fix)
	}
}

// TestParseGPMF_WASMEntryPoint exercises the complete Deep Module boundary:
// allocBuffer → JS writes data → parseGPMF → getResultPtr/Len → JSON.
//
// Minimal binary (42 bytes): DEVC(repeat=34) → STRM(repeat=26) → SCAL(417) + ACCL(1 sample).
// ACCL sample is the real Hero 13 wire bytes verified earlier in this suite.
func TestParseGPMF_WASMEntryPoint(t *testing.T) {
	const minimalHex = "44455643000100225354524D0001001A5343414C7302000101A100004143434C73060001EEAC01AA06D9"
	raw, err := hex.DecodeString(minimalHex)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate JS: allocate buffer then write the GPMF bytes into it.
	allocBuffer(uint32(len(raw)))
	copy(inputBuf, raw)

	const videoStartSec = uint32(1_000_000)
	if code := parseGPMF(uint32(len(raw)), videoStartSec); code != ErrSuccess {
		t.Fatalf("parseGPMF returned code %d (want %d ErrSuccess)", code, ErrSuccess)
	}

	rlen := getResultLen()
	if rlen == 0 {
		t.Fatal("getResultLen returned 0 after successful parse")
	}

	// Round-trip through encoding/json (test-only; production uses manual marshaler).
	var result TelemetryResult
	if err := json.Unmarshal(outputBuf[:rlen], &result); err != nil {
		t.Fatalf("json.Unmarshal failed: %v\nraw JSON: %s", err, outputBuf[:rlen])
	}

	if result.Status != ErrSuccess {
		t.Errorf("Status: want %d got %d", ErrSuccess, result.Status)
	}
	if result.VideoStartEpoch != int64(videoStartSec) {
		t.Errorf("VideoStartEpoch: want %d got %d", videoStartSec, result.VideoStartEpoch)
	}
	if len(result.GPS) != 0 {
		t.Errorf("GPS: want [] got %d samples", len(result.GPS))
	}
	if len(result.GRAV) != 0 {
		t.Errorf("GRAV: want [] got %d samples", len(result.GRAV))
	}
	if len(result.ACCL) != 1 {
		t.Fatalf("ACCL: want 1 sample, got %d", len(result.ACCL))
	}

	s := result.ACCL[0]
	check := func(field string, got, rawInt float64) {
		t.Helper()
		want := rawInt / 417.0
		if math.Abs(got-want) > 1e-9 {
			t.Errorf("ACCL[0].%s: want %v got %v", field, want, got)
		}
	}
	check("X", s.X, -4436) // int16(0xEEAC) = -4436
	check("Y", s.Y, 426)   // int16(0x01AA) =  426
	check("Z", s.Z, 1753)  // int16(0x06D9) = 1753
	if s.T != 0 {
		t.Errorf("ACCL[0].T: want 0 (cumOffset=0, sample 0) got %v", s.T)
	}
}

// TestParseSTRM_Integration builds a self-contained STRM body and verifies
// parseSTRM emits correctly scaled ACCL samples end-to-end.
func TestParseSTRM_Integration(t *testing.T) {
	// SCAL: type='s', size=2, repeat=1, value=100; dataLen=2 → padded to 4
	scalKLV := []byte{'S', 'C', 'A', 'L', 's', 2, 0, 1, 0x00, 0x64, 0x00, 0x00}

	// ACCL: type='s', size=6, repeat=2
	// sample 0: X=1000 Y=0    Z=9810  → /100 → 10.0  0.0  98.1
	// sample 1: X=-500 Y=200  Z=9700  → /100 → -5.0  2.0  97.0
	acclKLV := []byte{
		'A', 'C', 'C', 'L', 's', 6, 0, 2,
		0x03, 0xE8, 0x00, 0x00, 0x26, 0x52, // sample 0
		0xFE, 0x0C, 0x00, 0xC8, 0x25, 0xE4, // sample 1
	}

	var buf []byte
	buf = append(buf, scalKLV...)
	buf = append(buf, acclKLV...)

	result := &TelemetryResult{}
	state := &parseState{}
	parseSTRM(buf, result, state)

	if len(result.ACCL) != 2 {
		t.Fatalf("want 2 ACCL samples, got %d", len(result.ACCL))
	}
	check := func(i int, field string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("ACCL[%d].%s: want %v got %v", i, field, want, got)
		}
	}
	check(0, "X", result.ACCL[0].X, 10.0)
	check(0, "Y", result.ACCL[0].Y, 0.0)
	check(0, "Z", result.ACCL[0].Z, 98.1)
	check(1, "X", result.ACCL[1].X, -5.0)
	check(1, "Y", result.ACCL[1].Y, 2.0)
	check(1, "Z", result.ACCL[1].Z, 97.0)
}
