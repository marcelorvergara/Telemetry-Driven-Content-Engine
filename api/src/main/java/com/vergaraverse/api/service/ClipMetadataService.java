package com.vergaraverse.api.service;

import com.vergaraverse.api.domain.entity.ClipMetadata;
import com.vergaraverse.api.domain.entity.RideSession;
import com.vergaraverse.api.domain.model.StreetTimelineEntry;
import com.vergaraverse.api.domain.repository.ClipMetadataRepository;
import com.vergaraverse.api.domain.repository.RideSessionRepository;
import com.vergaraverse.api.web.dto.ClipMetadataDto;
import com.vergaraverse.api.web.dto.CreateClipRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Service
@Transactional
public class ClipMetadataService {

    private final ClipMetadataRepository clipRepo;
    private final RideSessionRepository  sessionRepo;

    public ClipMetadataService(ClipMetadataRepository clipRepo,
                               RideSessionRepository sessionRepo) {
        this.clipRepo    = clipRepo;
        this.sessionRepo = sessionRepo;
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public List<ClipMetadataDto> findAll() {
        return clipRepo.findAll().stream()
                .map(this::toDto)
                .toList();
    }

    @Transactional(readOnly = true)
    public Optional<ClipMetadataDto> lookup(String filename, Long fileSize) {
        return clipRepo.findByFilenameAndFileSize(filename, fileSize)
                .map(this::toDto);
    }

    // ── Write-through upsert ─────────────────────────────────────────────────
    // Finds the existing clip by (filename, fileSize) and updates its fields,
    // or inserts a new row. This means re-parsing a file always refreshes the
    // stored summary without creating duplicates.

    public ClipMetadataDto upsert(CreateClipRequest req, List<StreetTimelineEntry> streetTimeline) {
        ClipMetadata clip = clipRepo
                .findByFilenameAndFileSize(req.filename(), req.fileSize())
                .orElseGet(ClipMetadata::new);

        clip.setFilename(req.filename());
        clip.setFileSize(req.fileSize());
        clip.setMaxSpeed(req.maxSpeed());
        clip.setTotalDistanceM(req.totalDistanceM());
        clip.setVideoDurationSec(req.videoDurationSec());
        clip.setStartLat(req.startLat());
        clip.setStartLon(req.startLon());
        clip.setEndLat(req.endLat());
        clip.setEndLon(req.endLon());
        clip.setGpsSource(req.gpsSource());
        clip.setHighlights(req.highlights());
        clip.setStreetTimeline(streetTimeline.isEmpty() ? null : streetTimeline);

        // Session resolution: use the provided ID, or auto-create for new clips.
        // Existing clips keep their original session on re-parse (sessionId == null
        // in the request does not detach a clip that already belongs to a session).
        if (req.sessionId() != null) {
            sessionRepo.findById(req.sessionId()).ifPresent(clip::setSession);
        } else if (clip.getId() == null) {
            RideSession session = new RideSession();
            session.setName("Ride " + LocalDate.now());
            clip.setSession(sessionRepo.save(session));
        }

        return toDto(clipRepo.save(clip));
    }

    // ── Mapper ───────────────────────────────────────────────────────────────
    // Reads sessionId from the FK mirror column to avoid triggering a lazy load
    // of the RideSession proxy (open-in-view is disabled in application.yml).

    private ClipMetadataDto toDto(ClipMetadata c) {
        return new ClipMetadataDto(
                c.getId(),
                c.getFilename(),
                c.getFileSize(),
                c.getMaxSpeed(),
                c.getTotalDistanceM(),
                c.getVideoDurationSec(),
                c.getStartLat(),
                c.getStartLon(),
                c.getEndLat(),
                c.getEndLon(),
                c.getGpsSource(),
                c.getHighlights(),
                c.getParsedAt(),
                c.getSessionId(),   // FK mirror — no SELECT on ride_session
                c.getStreetTimeline()
        );
    }
}
