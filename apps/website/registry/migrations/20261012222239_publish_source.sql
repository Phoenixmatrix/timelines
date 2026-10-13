-- The gitmatrix work source (CORE-255) a CI publish was built in, beside its
-- repository and commit, so a deployment can name the exact publication it
-- shipped (CORE-351). Null for people's publishes and for those recorded
-- before this column: those are never linked to a deployment, since the
-- source they came from can't be told.
ALTER TABLE publishes ADD COLUMN source_id TEXT;
CREATE INDEX publishes_source_commit ON publishes (git_repo_id, source_id, commit_oid);
