-- Performance indexes for admin queries.
--   sessions.lastSeenAt — admin sessions list orders by MAX(lastSeenAt, updatedAt) DESC.
--   analytics_events(sessionId, createdAt) — paginated events lookup per session.
-- Tables are small at the moment so a plain CREATE INDEX is fine; if these grow
-- large in the future, switch to CREATE INDEX CONCURRENTLY (run via psql,
-- then `prisma migrate resolve --applied`).

CREATE INDEX "sessions_lastSeenAt_idx" ON "sessions"("lastSeenAt");
CREATE INDEX "analytics_events_sessionId_createdAt_idx" ON "analytics_events"("sessionId", "createdAt");
