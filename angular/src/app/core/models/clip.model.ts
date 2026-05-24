// Mirror of the Java records in com.vergaraverse.api.web.dto.
// Field names and nullability match the Spring Boot API contract exactly.

export interface GpsSnapshotPoint {
  t:   number; // ms from video start
  lat: number;
  lon: number;
}

export interface StreetTimelineEntry {
  t:          number; // ms from video start — binary-search key in the render loop
  streetName: string;
}

export interface ClipMetadataDto {
  id:              number;
  filename:        string;
  fileSize:        number;
  maxSpeed:        number | null;   // m/s
  totalDistanceM:  number | null;
  videoDurationSec: number | null;
  startLat:        number | null;
  startLon:        number | null;
  endLat:          number | null;
  endLon:          number | null;
  gpsSource:       string | null;
  highlights:      number[] | null; // ms from video start, up to 5 peak G-force events
  parsedAt:        string;          // ISO-8601 Instant
  sessionId:       number | null;
  streetTimeline:  StreetTimelineEntry[] | null;
}

export interface CreateClipRequest {
  filename:        string;
  fileSize:        number;
  maxSpeed:        number | null;
  totalDistanceM:  number | null;
  videoDurationSec: number | null;
  startLat:        number | null;
  startLon:        number | null;
  endLat:          number | null;
  endLon:          number | null;
  gpsSource:       string | null;
  highlights:      number[] | null;
  sessionId:       number | null;
  gpsSnapshots:    GpsSnapshotPoint[] | null;
}
