-- Push log retention (CORE-202): deleting a ref_updates row cascades to the
-- change_refs rows naming it as their first update, and the cleanup checks
-- for kept ones; both look change_refs up by first_update_id.
CREATE INDEX IF NOT EXISTS change_refs_first_update ON change_refs (first_update_id);
