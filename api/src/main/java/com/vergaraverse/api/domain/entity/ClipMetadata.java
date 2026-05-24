package com.vergaraverse.api.domain.entity;

import com.vergaraverse.api.domain.model.StreetTimelineEntry;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(
    name = "clip_metadata",
    uniqueConstraints = @UniqueConstraint(
        name = "uq_clip_filename_filesize",
        columnNames = {"filename", "file_size"}
    )
)
public class ClipMetadata {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String filename;

    @Column(name = "file_size", nullable = false)
    private Long fileSize;

    private Double maxSpeed;        // m/s — frontend converts to display units
    private Double totalDistanceM;  // metres
    private Double videoDurationSec;

    private Double startLat;
    private Double startLon;
    private Double endLat;
    private Double endLon;

    @Column(length = 10)
    private String gpsSource;       // "GPS9" or "GPS5"

    // Top-5 G-force peak timestamps in ms from video start.
    // Stored as a native PostgreSQL bigint[] — no join table needed.
    @Column(columnDefinition = "bigint[]")
    private Long[] highlights;

    // Sparse reverse-geocoding timeline: one street name per ~60 s of video.
    // Stored as native PostgreSQL jsonb — ddl-auto:update adds the column on boot.
    @JdbcTypeCode(SqlTypes.JSON)
    private List<StreetTimelineEntry> streetTimeline;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private Instant parsedAt;

    // Read-only FK mirror: lets the service read sessionId in toDto()
    // without triggering a lazy load of the RideSession proxy.
    @Column(name = "session_id", insertable = false, updatable = false)
    private Long sessionId;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id")
    private RideSession session;
}
