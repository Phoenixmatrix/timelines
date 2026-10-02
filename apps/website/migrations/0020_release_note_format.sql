-- Existing materializations remain private until the daily-history rebuild converges.
ALTER TABLE release_note_state ADD COLUMN format_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE release_notes ADD COLUMN format_version INTEGER NOT NULL DEFAULT 0;
