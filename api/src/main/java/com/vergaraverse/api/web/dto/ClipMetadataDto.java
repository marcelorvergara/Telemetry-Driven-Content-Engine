package com.vergaraverse.api.web.dto;

import java.time.Instant;

/**
 * Read-only projection sent to Angular. Never exposes the JPA entity directly.
 * maxSpeed is always m/s — the frontend converts to km/h or mph for display.
 */
public record ClipMetadataDto(
        Long id,
        String filename,
        Long fileSize,
        Double maxSpeed,
        Double totalDistanceM,
        Double videoDurationSec,
        Double startLat,
        Double startLon,
        Double endLat,
        Double endLon,
        String gpsSource,
        Long[] highlights,
        Instant parsedAt,
        Long sessionId
) {}
