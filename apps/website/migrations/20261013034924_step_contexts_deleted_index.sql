-- Deleted steps by repository and timeline (CORE-399): each live feed
-- connection asks which of its timeline's steps were deleted in the last week,
-- so the feed forgets them even if telling it at deletion failed. Partial, so
-- the question reads only deleted rows.
CREATE INDEX step_contexts_deleted ON step_contexts (repo_id, timeline, deleted_at)
  WHERE deleted_at IS NOT NULL;
