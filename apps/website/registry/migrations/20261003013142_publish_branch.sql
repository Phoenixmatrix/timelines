-- 1 for a CI publish from a branch other than its repository's default: it
-- keeps its version and provenance but never becomes `latest`. People's
-- publishes, and those recorded before this column, stay 0.
ALTER TABLE publishes ADD COLUMN off_default_branch INTEGER NOT NULL DEFAULT 0;
