package com.vergaraverse.api.domain.repository;

import com.vergaraverse.api.domain.entity.RideSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface RideSessionRepository extends JpaRepository<RideSession, Long> {
}
