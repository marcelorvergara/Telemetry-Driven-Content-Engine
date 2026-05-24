package com.vergaraverse.api.service;

import com.vergaraverse.api.domain.model.StreetTimelineEntry;
import com.vergaraverse.api.web.dto.GpsSnapshotPoint;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Resolves a sparse list of GPS coordinates to street names via the Google Maps
 * Geocoding API. Fires all requests concurrently on Java 21 virtual threads
 * and collects whatever resolves within a hard 3-second cap.
 *
 * Must NOT be called inside a @Transactional method — the caller (controller)
 * is responsible for keeping DB connections closed during network I/O.
 */
@Service
public class GeocodingService {

    private static final Logger log = LoggerFactory.getLogger(GeocodingService.class);
    private static final String GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

    private final String apiKey;
    private final RestClient http;

    public GeocodingService(@Value("${geocoding.google-maps.api-key}") String apiKey) {
        this.apiKey = apiKey;
        this.http   = RestClient.create();
    }

    /**
     * Resolves all snapshots concurrently. Partial results are returned when the
     * 3 s deadline expires — missing entries simply leave a gap in the timeline.
     */
    public List<StreetTimelineEntry> resolveTimeline(List<GpsSnapshotPoint> snapshots) {
        if (snapshots == null || snapshots.isEmpty()) return List.of();

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<StreetTimelineEntry>> futures = snapshots.stream()
                    .map(snap -> CompletableFuture.supplyAsync(() -> resolveOne(snap), executor))
                    .toList();

            try {
                CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                        .get(3, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                log.warn("[GEOCODING] 3 s deadline exceeded — collecting partial results");
            } catch (Exception e) {
                log.warn("[GEOCODING] allOf interrupted: {}", e.getMessage());
            }

            return futures.stream()
                    .filter(f -> f.isDone() && !f.isCompletedExceptionally())
                    .map(CompletableFuture::join)
                    .filter(entry -> entry != null)
                    .sorted(Comparator.comparingLong(StreetTimelineEntry::t))
                    .toList();
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private StreetTimelineEntry resolveOne(GpsSnapshotPoint snap) {
        try {
            String url = GEOCODE_URL + "?latlng=" + snap.lat() + "," + snap.lon() + "&key=" + apiKey;

            @SuppressWarnings("unchecked")
            Map<String, Object> body = http.get()
                    .uri(url)
                    .retrieve()
                    .body(Map.class);

            if (body == null) return null;

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> results = (List<Map<String, Object>>) body.get("results");
            if (results == null || results.isEmpty()) return null;

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> components =
                    (List<Map<String, Object>>) results.get(0).get("address_components");
            if (components == null) return null;

            return components.stream()
                    .filter(c -> {
                        @SuppressWarnings("unchecked")
                        List<String> types = (List<String>) c.get("types");
                        return types != null && types.contains("route");
                    })
                    .findFirst()
                    .map(c -> new StreetTimelineEntry(snap.t(), (String) c.get("long_name")))
                    .orElse(null);

        } catch (Exception e) {
            log.warn("[GEOCODING] Failed for ({}, {}): {}", snap.lat(), snap.lon(), e.getMessage());
            return null;
        }
    }
}
