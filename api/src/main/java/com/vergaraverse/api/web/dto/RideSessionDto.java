package com.vergaraverse.api.web.dto;

import java.time.Instant;

public record RideSessionDto(
        Long id,
        String name,
        Instant createdAt
) {}
