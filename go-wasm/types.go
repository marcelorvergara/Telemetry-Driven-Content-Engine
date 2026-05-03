package main

// Error codes returned to the JS caller via parseGPMF.
const (
	ErrSuccess           = 0
	ErrMalformedGPMF     = 1
	ErrMemLimit          = 2
	ErrNoSupportedStream = 3
)

// GPS2000Epoch is the Unix timestamp (seconds UTC) for Jan 1, 2000 00:00:00.
// GPS9 "days" and "seconds" fields count from this epoch.
const GPS2000Epoch int64 = 946684800

// Nominal GoPro Hero 10/11/12 IMU sample rates used to synthesise ACCL/GRAV
// timestamps when per-DEVC chunk timing is unavailable.
// TODO: Replace synthesised timing with MP4 stts chunk timestamps passed from Angular.
const (
	acclRateHz float64 = 200
	gravRateHz float64 = 200
)

// GPS9Sample is one decoded GPS9 reading.
// T is milliseconds from video start — maps directly to HTML5 video currentTime × 1000.
// Fix: 0 = no lock, 2 = 2-D, 3 = 3-D. Passed through unfiltered; frontend decides.
type GPS9Sample struct {
	T       float64 `json:"t"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Alt     float64 `json:"alt"`     // metres
	Speed2D float64 `json:"speed2d"` // m/s
	Speed3D float64 `json:"speed3d"` // m/s
	Fix     int     `json:"fix"`
	DOP     float64 `json:"dop"`
}

// ACCLSample is one decoded accelerometer reading in m/s².
type ACCLSample struct {
	T float64 `json:"t"`
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// GRAVSample is one decoded gravity-vector reading (unit vector in camera frame).
type GRAVSample struct {
	T float64 `json:"t"`
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// TelemetryResult is the top-level JSON envelope written to the WASM output buffer.
// Streams are grouped by sensor type for efficient binary-search access in the
// Angular requestAnimationFrame loop.
type TelemetryResult struct {
	Status          int          `json:"status"`
	VideoStartEpoch int64        `json:"videoStartEpoch"` // Unix seconds from MP4 mvhd box
	GPS             []GPS9Sample `json:"gps"`
	ACCL            []ACCLSample `json:"accl"`
	GRAV            []GRAVSample `json:"grav"`
}
