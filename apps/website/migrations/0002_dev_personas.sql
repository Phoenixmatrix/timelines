-- Formerly seeded the development personas. Migrations also run against the
-- deployed database, which must start empty, so the personas are now seeded
-- by the dev server only (worker/dev-seed.ts). Kept so migration numbering
-- and already-applied local databases stay consistent.
SELECT 1;
