-- Git byte retention is independent of Tracker detail retention. Unknown
-- historical dispositions remain retained until the authoritative Tracker
-- archive evidence has been reconciled; never infer abandonment from absence.
ALTER TABLE timeline_work_sources ADD COLUMN archive_disposition TEXT
  CHECK (archive_disposition IN ('landed', 'abandoned'));
CREATE INDEX timeline_work_sources_retention
  ON timeline_work_sources(owner_id, state, archive_disposition, archived_at, timeline_id);
