package com.vergaraverse.api.domain.model;

/**
 * One resolved reverse-geocoding result tied to a video timestamp.
 * Stored as JSONB inside clip_metadata.street_timeline.
 * Deserialized by Jackson during Hibernate load — no JPA annotations needed here.
 */
public record StreetTimelineEntry(long t, String streetName) {}
