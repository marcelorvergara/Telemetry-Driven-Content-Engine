package com.vergaraverse.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.util.List;

/**
 * Write-through payload Angular POSTs after WASM parsing completes.
 * filename + fileSize form the composite unique key (see uq_clip_filename_filesize).
 * All telemetry fields are nullable — a partial parse is still worth persisting.
 * sessionId is nullable — a new RideSession is auto-created when absent.
 * gpsSnapshots is nullable — absent for showcase/legacy clips with no GPS.
 */
public record CreateClipRequest(
        @NotBlank String filename,
        @NotNull  Long fileSize,
        Double maxSpeed,
        Double totalDistanceM,
        Double videoDurationSec,
        Double startLat,
        Double startLon,
        Double endLat,
        Double endLon,
        String gpsSource,
        Long[] highlights,
        Long sessionId,
        List<GpsSnapshotPoint> gpsSnapshots
) {}
