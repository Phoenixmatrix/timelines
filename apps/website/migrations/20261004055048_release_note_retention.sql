-- Release-note retention (CORE-206, category "release-notes";
-- worker/retention/cleanups/release-notes.ts): releases before this moment
-- were removed by retention, so the generator never writes notes for a
-- release older than it again (it would pay to rebuild what the policy
-- removed). Null: nothing was removed.
ALTER TABLE release_note_state ADD COLUMN retained_from TEXT;
