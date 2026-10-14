-- A person's own default Organization and Space (CORE-413), chosen in
-- Preferences. Null means unset: the personal Organization's default Space
-- applies, as before. A null Space with an Organization means "that
-- Organization's default Space". No foreign keys: access can lapse (a removed
-- membership or grant, an archived Space) without anything being deleted, so
-- every read re-checks access and falls back instead of trusting the row.
ALTER TABLE accounts ADD COLUMN preferred_organization_id TEXT;
ALTER TABLE accounts ADD COLUMN preferred_space_id TEXT;
