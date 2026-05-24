package com.vergaraverse.api.web.controller;

import com.vergaraverse.api.domain.model.StreetTimelineEntry;
import com.vergaraverse.api.service.ClipMetadataService;
import com.vergaraverse.api.service.GeocodingService;
import com.vergaraverse.api.web.dto.ClipMetadataDto;
import com.vergaraverse.api.web.dto.CreateClipRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/clips")
public class ClipMetadataController {

    private final ClipMetadataService service;
    private final GeocodingService    geocodingService;

    public ClipMetadataController(ClipMetadataService service, GeocodingService geocodingService) {
        this.service          = service;
        this.geocodingService = geocodingService;
    }

    // Angular calls this on app load to populate the dashboard clip library.
    @GetMapping
    public List<ClipMetadataDto> getAll() {
        return service.findAll();
    }

    // Angular calls this before running WASM. 200 = skip parsing; 404 = run WASM.
    @GetMapping("/lookup")
    public ResponseEntity<ClipMetadataDto> lookup(
            @RequestParam String filename,
            @RequestParam Long fileSize) {
        return service.lookup(filename, fileSize)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // Angular write-through: called after WASM parsing completes successfully.
    // Upserts so re-parsing the same file refreshes data without a duplicate row.
    // Geocoding runs outside the transaction — no DB connection is held during
    // the Google Maps network calls (see GeocodingService for the 3 s cap).
    @PostMapping
    public ResponseEntity<ClipMetadataDto> create(
            @Valid @RequestBody CreateClipRequest req) {
        List<StreetTimelineEntry> streetTimeline = geocodingService.resolveTimeline(req.gpsSnapshots());
        return ResponseEntity
                .status(HttpStatus.CREATED)
                .body(service.upsert(req, streetTimeline));
    }
}
