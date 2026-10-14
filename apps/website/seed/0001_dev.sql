-- DEVELOPMENT ONLY: applied atomically after native v4 initialization by local
-- development and test harnesses. Deploys apply migrations/ alone; the deployed
-- database starts empty. Idempotent; never use as legacy migration input.
--
-- The personas each exercise a different path through the permission rules.
-- Francois is an email sign-in (fward@example.com, development's OWNER_EMAIL)
-- as well as a persona: his Better Auth user shares his account id, so an
-- emailed code signs into the same superuser account the persona picker does.
INSERT OR IGNORE INTO accounts (id, kind, slug, display_name, bio, is_site_admin, email) VALUES
  ('acc_priya', 'user', 'priya', 'Priya Raman', 'Site admin. Can read, push to and manage every repository.', 1, NULL),
  ('acc_marco', 'user', 'marco', 'Marco Bellini', 'Orbit Labs owner with an explicit admin grant in its General Space, not its private Research Space.', 0, NULL),
  ('acc_jun', 'user', 'jun', 'Jun Tanaka', 'Orbit General member. Reads its repositories and can push to orbit/engine as a collaborator.', 0, NULL),
  ('acc_sam', 'user', 'sam', 'Sam Rivera', 'Outside contributor. Has read access to orbit/engine and owns a private repository.', 0, NULL),
  ('acc_fward', 'user', 'fward', 'Francois Ward', 'The instance owner. Superuser; signs in with an emailed code or as a persona.', 1, 'fward@example.com');

-- Apply this seed atomically: Organization/default-Space foreign keys are deferred.
-- This is fixture data, not migration authority; it never activates the runtime.
-- Five people, seven Organizations, nine Spaces. Historical acc_* Space IDs
-- remain immutable, but are not Account ownership or implicit content grants.
-- Marco cannot read Orbit Research; Sam's Nova Research grant is package-only.
-- /api/dev/seed adds public/private repositories and Sam's repo-only Orbit grant.
INSERT OR IGNORE INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id) VALUES
  ('org_orbit', 'orbit-labs', 'Orbit Labs', 'company', NULL, 'acc_orbit'),
  ('org_nova', 'nova-labs', 'Nova Labs', 'company', NULL, 'space_nova'),
  ('org_priya', 'priya-personal', 'Priya Raman', 'personal', 'acc_priya', 'acc_priya'),
  ('org_marco', 'marco-personal', 'Marco Bellini', 'personal', 'acc_marco', 'acc_marco'),
  ('org_jun', 'jun-personal', 'Jun Tanaka', 'personal', 'acc_jun', 'acc_jun'),
  ('org_sam', 'sam-personal', 'Sam Rivera', 'personal', 'acc_sam', 'acc_sam'),
  ('org_fward', 'fward-personal', 'Francois Ward', 'personal', 'acc_fward', 'acc_fward');

INSERT OR IGNORE INTO spaces (id, organization_id, slug, display_name) VALUES
  ('acc_orbit', 'org_orbit', 'orbit', 'General'),
  ('space_orbit_research', 'org_orbit', 'orbit-research', 'Research'),
  ('space_nova', 'org_nova', 'nova', 'General'),
  ('space_nova_research', 'org_nova', 'nova-research', 'Research'),
  ('acc_priya', 'org_priya', 'priya', 'Personal'),
  ('acc_marco', 'org_marco', 'marco', 'Personal'),
  ('acc_jun', 'org_jun', 'jun', 'Personal'),
  ('acc_sam', 'org_sam', 'sam', 'Personal'),
  ('acc_fward', 'org_fward', 'fward', 'Personal');

INSERT OR IGNORE INTO organization_members (organization_id, account_id, role, origin, granted_by) VALUES
  ('org_orbit', 'acc_marco', 'owner', 'development-fixture', 'acc_marco'),
  ('org_orbit', 'acc_jun', 'member', 'development-fixture', 'acc_marco'),
  ('org_nova', 'acc_sam', 'owner', 'development-fixture', 'acc_sam'),
  ('org_priya', 'acc_priya', 'owner', 'development-fixture', 'acc_priya'),
  ('org_marco', 'acc_marco', 'owner', 'development-fixture', 'acc_marco'),
  ('org_jun', 'acc_jun', 'owner', 'development-fixture', 'acc_jun'),
  ('org_sam', 'acc_sam', 'owner', 'development-fixture', 'acc_sam'),
  ('org_fward', 'acc_fward', 'owner', 'development-fixture', 'acc_fward');

INSERT OR IGNORE INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by) VALUES
  ('acc_orbit', 'org_orbit', 'acc_marco', 'admin', 'write', 'write', 'development-fixture', 'acc_marco'),
  ('acc_orbit', 'org_orbit', 'acc_jun', 'member', 'read', 'read', 'development-fixture', 'acc_marco'),
  ('space_orbit_research', 'org_orbit', 'acc_jun', 'admin', 'write', 'write', 'development-fixture', 'acc_marco'),
  ('space_nova', 'org_nova', 'acc_sam', 'admin', 'write', 'write', 'development-fixture', 'acc_sam'),
  ('space_nova_research', 'org_nova', 'acc_sam', 'member', 'none', 'read', 'development-fixture', 'acc_sam'),
  ('acc_priya', 'org_priya', 'acc_priya', 'admin', 'write', 'write', 'development-fixture', 'acc_priya'),
  ('acc_marco', 'org_marco', 'acc_marco', 'admin', 'write', 'write', 'development-fixture', 'acc_marco'),
  ('acc_jun', 'org_jun', 'acc_jun', 'admin', 'write', 'write', 'development-fixture', 'acc_jun'),
  ('acc_sam', 'org_sam', 'acc_sam', 'admin', 'write', 'write', 'development-fixture', 'acc_sam'),
  ('acc_fward', 'org_fward', 'acc_fward', 'admin', 'write', 'write', 'development-fixture', 'acc_fward');

INSERT OR IGNORE INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail)
SELECT 'fixture-grant:' || space_id || ':' || account_id, organization_id, space_id,
       granted_by, 'space.grant', account_id,
       json_object('origin', origin, 'role', role, 'repositoryRole', repository_role, 'packageRole', package_role)
FROM space_grants WHERE origin = 'development-fixture';

INSERT OR IGNORE INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt) VALUES
  ('acc_fward', 'Francois Ward', 'fward@example.com', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
