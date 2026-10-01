-- Development personas: the sign-in screen lists these until real auth exists.
-- Each one exercises a different path through the permission rules.
INSERT INTO accounts (id, kind, slug, display_name, bio, is_site_admin, member_repo_role) VALUES
  ('acc_priya', 'user', 'priya', 'Priya Raman', 'Site admin. Can read, push to and manage every repository.', 1, NULL),
  ('acc_marco', 'user', 'marco', 'Marco Bellini', 'Owns the Orbit Labs organization, so is an admin on all of its repositories.', 0, NULL),
  ('acc_jun', 'user', 'jun', 'Jun Tanaka', 'Orbit Labs member. Reads every Orbit repository and can push to orbit/engine as a collaborator.', 0, NULL),
  ('acc_sam', 'user', 'sam', 'Sam Rivera', 'Outside contributor. Has read access to orbit/engine and owns a private repository.', 0, NULL),
  ('acc_orbit', 'org', 'orbit', 'Orbit Labs', 'A sample organization. Members get read access to its repositories.', 0, 'read');

INSERT INTO org_members (org_id, user_id, role) VALUES
  ('acc_orbit', 'acc_marco', 'owner'),
  ('acc_orbit', 'acc_jun', 'member');
