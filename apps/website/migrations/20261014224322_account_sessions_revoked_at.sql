-- When any of a person's sign-in sessions last ended other than by expiry, or
-- their password changed (Unix milliseconds; NULL if never). A browser's read
-- may trust Better Auth's signed session cache for SESSION_CACHE_SECONDS
-- (worker/better-auth.ts) instead of reading auth_sessions; within that long of
-- this time, sessionActor (worker/auth.ts) reads the session from D1 instead,
-- so a revoked session or a reset password ends at once. It rides on the
-- accounts read every signed-in request already makes.
ALTER TABLE accounts ADD COLUMN sessions_revoked_at INTEGER;
