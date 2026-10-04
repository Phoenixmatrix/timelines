-- The Chronicle's linked work (CORE-250): an issue's agent work contexts and
-- release-note entries, found by its key.
CREATE INDEX step_contexts_issue ON step_contexts (issue_key, committed_at);
CREATE INDEX release_note_entries_issue ON release_note_entries (tracker_owner_id, issue_key);
