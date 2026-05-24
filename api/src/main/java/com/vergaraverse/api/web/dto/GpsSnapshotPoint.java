package com.vergaraverse.api.web.dto;

/**
 * One sparse GPS coordinate sampled by Angular before the POST /api/clips call.
 * Sent in CreateClipRequest.gpsSnapshots; never persisted directly.
 */
public record GpsSnapshotPoint(long t, double lat, double lon) {}
