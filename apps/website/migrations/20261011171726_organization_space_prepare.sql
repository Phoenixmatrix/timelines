-- CORE-361 preparation only: no legacy data mapping, rename, drop or activation.
-- Independent control adjunct: never include in business checkpoints/restores.
-- The coordinator installs DML fences and permits bypass only inside its own
-- atomic migration batch; ordinary preparation leaves business admission open.
CREATE TABLE _space_cutover_fence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT,
  migration_epoch INTEGER,
  manifest_digest TEXT,
  fenced INTEGER NOT NULL DEFAULT 0 CHECK (fenced IN (0, 1)),
  authority_token TEXT NOT NULL DEFAULT '',
  bypass INTEGER NOT NULL DEFAULT 0 CHECK (bypass IN (0, 1))
);
INSERT INTO _space_cutover_fence (id, fenced, bypass) VALUES (1, 0, 0);

-- The deferred composite FK makes an Organization and its real default Space
-- one transaction, including fresh bootstrap. A default cannot be archived.
CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (slug = lower(slug)),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'personal')),
  personal_account_id TEXT UNIQUE REFERENCES accounts(id),
  default_space_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'personal' AND personal_account_id IS NOT NULL) OR
         (kind = 'company' AND personal_account_id IS NULL)),
  FOREIGN KEY (default_space_id, id) REFERENCES spaces(id, organization_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE spaces (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (slug = lower(slug)),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  archived_at TEXT,
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, organization_id)
);
CREATE INDEX spaces_organization ON spaces(organization_id);
CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  origin TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  granted_by TEXT NOT NULL,
  granted_by_agent_id TEXT,
  PRIMARY KEY (organization_id, account_id)
);
CREATE TABLE space_grants (
  space_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  repository_role TEXT NOT NULL CHECK (repository_role IN ('none', 'read', 'write')),
  package_role TEXT NOT NULL CHECK (package_role IN ('none', 'read', 'write')),
  origin TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  granted_by TEXT NOT NULL,
  granted_by_agent_id TEXT,
  PRIMARY KEY (space_id, account_id),
  FOREIGN KEY (space_id, organization_id) REFERENCES spaces(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, account_id)
    REFERENCES organization_members(organization_id, account_id) ON DELETE CASCADE
);
CREATE INDEX space_grants_account ON space_grants(account_id, space_id);
-- Audit survives membership/grant deletion and stores accountable person and agent
-- separately. Imported origin is evidence, not a fabricated historical timestamp.
CREATE TABLE space_audit (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  space_id TEXT,
  actor_id TEXT NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  subject_id TEXT,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  migration_run_id TEXT,
  manifest_digest TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((migration_run_id IS NULL) = (manifest_digest IS NULL))
);
CREATE INDEX space_audit_organization ON space_audit(organization_id, created_at, id);
CREATE TRIGGER organizations_identity_immutable BEFORE UPDATE OF id, slug, kind, personal_account_id ON organizations
WHEN NEW.id IS NOT OLD.id OR NEW.slug IS NOT OLD.slug OR NEW.kind IS NOT OLD.kind OR NEW.personal_account_id IS NOT OLD.personal_account_id
BEGIN SELECT RAISE(ABORT, 'organization_identity_immutable'); END;
CREATE TRIGGER spaces_identity_immutable BEFORE UPDATE OF id, slug, organization_id ON spaces
WHEN NEW.id IS NOT OLD.id OR NEW.slug IS NOT OLD.slug OR NEW.organization_id IS NOT OLD.organization_id
BEGIN SELECT RAISE(ABORT, 'space_identity_immutable'); END;
CREATE TRIGGER organizations_default_active_insert BEFORE INSERT ON organizations
WHEN EXISTS (SELECT 1 FROM spaces WHERE id = NEW.default_space_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'default_space_archived'); END;
CREATE TRIGGER organizations_default_active_update BEFORE UPDATE OF default_space_id ON organizations
WHEN NOT EXISTS (SELECT 1 FROM spaces WHERE id = NEW.default_space_id AND organization_id = NEW.id AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_default_space'); END;
CREATE TRIGGER spaces_default_active_insert BEFORE INSERT ON spaces
WHEN NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM organizations WHERE default_space_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'default_space_archived'); END;
CREATE TRIGGER spaces_default_active_update BEFORE UPDATE OF archived_at ON spaces
WHEN NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM organizations WHERE default_space_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'default_space_archived'); END;
CREATE TRIGGER organizations_person_insert BEFORE INSERT ON organizations
WHEN NEW.personal_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.personal_account_id AND kind = 'user')
BEGIN SELECT RAISE(ABORT, 'personal_account_must_be_person'); END;
CREATE TRIGGER organization_members_person_insert BEFORE INSERT ON organization_members
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND kind = 'user')
BEGIN SELECT RAISE(ABORT, 'member_must_be_person'); END;
CREATE TRIGGER organization_members_identity_immutable BEFORE UPDATE OF organization_id, account_id ON organization_members
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.account_id IS NOT OLD.account_id
BEGIN SELECT RAISE(ABORT, 'membership_identity_immutable'); END;
CREATE TRIGGER space_grants_identity_immutable BEFORE UPDATE OF space_id, organization_id, account_id ON space_grants
WHEN NEW.space_id IS NOT OLD.space_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.account_id IS NOT OLD.account_id
BEGIN SELECT RAISE(ABORT, 'grant_identity_immutable'); END;
CREATE TRIGGER space_grants_insert_version AFTER INSERT ON space_grants
BEGIN UPDATE spaces SET authorization_version = authorization_version + 1 WHERE id = NEW.space_id; END;
CREATE TRIGGER space_grants_update_version AFTER UPDATE ON space_grants
BEGIN UPDATE spaces SET authorization_version = authorization_version + 1 WHERE id = NEW.space_id; END;
CREATE TRIGGER space_grants_delete_version AFTER DELETE ON space_grants
BEGIN UPDATE spaces SET authorization_version = authorization_version + 1 WHERE id = OLD.space_id; END;
CREATE TRIGGER spaces_archive_version AFTER UPDATE OF archived_at ON spaces
WHEN NEW.archived_at IS NOT OLD.archived_at
BEGIN UPDATE spaces SET authorization_version = authorization_version + 1 WHERE id = NEW.id; END;

-- Nullable preparation targets: legacy consumers continue to use their existing
-- columns until the independent fence and approved coordinator import run.
-- Mixed person/Instance/content rows MUST be classified before backfill.
ALTER TABLE repos ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE timeline_work_sources ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE source_operations ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE tracker_preferences ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE repo_deletions ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE account_settings ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE ai_providers ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE account_ai_log_bodies ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE atlas_spend ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE atlas_spend_daily ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE do_instances ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE usage_snapshots ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE usage_monthly ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE ai_usage ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE ai_usage_monthly ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE retention_policies ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE retention_policy_changes ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE cleanup_runs ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE timeline_source_migrations ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE tracker_repo_subscriptions ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE release_highlights ADD COLUMN space_id TEXT REFERENCES spaces(id);
ALTER TABLE atlas_budget_exhaustions ADD COLUMN space_id TEXT REFERENCES spaces(id);
