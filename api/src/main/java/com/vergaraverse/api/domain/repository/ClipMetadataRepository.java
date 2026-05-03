package com.vergaraverse.api.domain.repository;

import com.vergaraverse.api.domain.entity.ClipMetadata;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface ClipMetadataRepository extends JpaRepository<ClipMetadata, Long> {

    // Drives the Angular pre-check: GET /api/clips/lookup?filename=…&fileSize=…
    // Uses the uq_clip_filename_filesize index — O(log n) even at thousands of clips.
    Optional<ClipMetadata> findByFilenameAndFileSize(String filename, Long fileSize);
}
