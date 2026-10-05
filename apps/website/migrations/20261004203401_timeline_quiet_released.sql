-- A checkpoint may arrive before its push's run exists (runs start after the
-- push answers): the commit it released from the quiet period (CORE-238) is
-- kept on the branch's row, and a run of that commit then starts at once.
ALTER TABLE ci_refs ADD COLUMN quiet_released TEXT;
