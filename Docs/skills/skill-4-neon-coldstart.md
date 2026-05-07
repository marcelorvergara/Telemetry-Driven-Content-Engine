# Skill 4 — Neon Cold-Start Trap

**When to use**: Before any change to `spring.jpa.hibernate.ddl-auto` or `spring.flyway.enabled` in `application.yml`.

---

## The Trap

`ddl-auto: update` asks Hibernate to diff the schema on every application startup. On a serverless Neon database, the first connection after a cold-start takes 1–3 seconds. If Hibernate opens multiple connections during the `update` diff (to inspect existing columns, read constraints, lock tables) it races against Neon's connection pool warming and can fail with `PSQLException: connection refused` or produce a half-applied schema diff with no clear error.

**Current state**: `ddl-auto: update` with `flyway.enabled: false` is intentional for early prototyping while the schema is still changing sprint-to-sprint. It is **not safe for production** and must be replaced before any non-local environment is used.

---

## Migration Path (when schema stabilises)

1. Set `ddl-auto: validate` — Hibernate verifies schema only, never modifies it.
2. Set `flyway.enabled: true`.
3. Author `V1__create_schema.sql` matching the entity definitions exactly.
4. Verify `mvn flyway:migrate` succeeds against Neon before deploying.

---

## Danger Signal

If a startup log shows `HHH90000031: DDL via Hibernate SchemaManagementTool` on a Neon URL, the trap is active. Investigate before the next deploy.
