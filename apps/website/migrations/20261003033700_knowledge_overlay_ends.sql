-- Ended knowledge overlays (CORE-139): when a timeline's bookmark disappears
-- its last overlay is kept, read-only, and never computed again, so a landed
-- or abandoned timeline's knowledge diff stays reviewable like its events and
-- deployment records. Both columns are null while the bookmark exists.
ALTER TABLE kg_overlays ADD COLUMN ended_at TEXT;
-- From the timeline's record in the tracker when the bookmark went: `landed`
-- or `abandoned`; `ended` when the tracker did not say (yet).
ALTER TABLE kg_overlays ADD COLUMN ended_reason TEXT
  CHECK (ended_reason IN ('landed', 'abandoned', 'ended'));
