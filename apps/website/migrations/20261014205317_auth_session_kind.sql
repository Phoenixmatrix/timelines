-- Which flow created a Better Auth session: 'device' for the one gm's device
-- login gets (POST /api/identity/device/token), NULL for a browser's. Only a
-- device session may be traded for a personal access token
-- (POST /api/tokens/device); a browser's session token never can.
ALTER TABLE auth_sessions ADD COLUMN kind TEXT;
