-- DEVELOPMENT ONLY: applied by `vp run db:seed` (and the agent harness) as a
-- migration of local databases only (`--dir seed`); deploys apply migrations/
-- alone, so the deployed database starts empty. Idempotent.
--
-- The personas each exercise a different path through the permission rules.
-- Francois is a real sign-in (hello@fward.me) as well as a persona: his
-- Better Auth user shares his account id, so an emailed code signs into the
-- same superuser account the persona picker does.
INSERT OR IGNORE INTO accounts (id, kind, slug, display_name, bio, is_site_admin, member_repo_role, email) VALUES
  ('acc_priya', 'user', 'priya', 'Priya Raman', 'Site admin. Can read, push to and manage every repository.', 1, NULL, NULL),
  ('acc_marco', 'user', 'marco', 'Marco Bellini', 'Owns the Orbit Labs organization, so is an admin on all of its repositories.', 0, NULL, NULL),
  ('acc_jun', 'user', 'jun', 'Jun Tanaka', 'Orbit Labs member. Reads every Orbit repository and can push to orbit/engine as a collaborator.', 0, NULL, NULL),
  ('acc_sam', 'user', 'sam', 'Sam Rivera', 'Outside contributor. Has read access to orbit/engine and owns a private repository.', 0, NULL, NULL),
  ('acc_orbit', 'org', 'orbit', 'Orbit Labs', 'A sample organization. Members get read access to its repositories.', 0, 'read', NULL),
  ('acc_fward', 'user', 'fward', 'Francois Ward', 'The instance owner. Superuser; signs in with an emailed code or as a persona.', 1, NULL, 'hello@fward.me');

INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES
  ('acc_orbit', 'acc_marco', 'owner'),
  ('acc_orbit', 'acc_jun', 'member');

INSERT OR IGNORE INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt) VALUES
  ('acc_fward', 'Francois Ward', 'hello@fward.me', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
