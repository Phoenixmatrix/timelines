-- CORE-300: one installation-wide admission boundary, shared by all machines.
CREATE TABLE environment_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  maximum INTEGER NOT NULL DEFAULT 4 CHECK (maximum >= 0 AND maximum <= 2147483647),
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO environment_limits (id) VALUES (1);
CREATE TABLE environment_reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  cloud_account TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('local', 'remote')),
  expires INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Expiry means cleanup is due, NOT that provisioned resources have disappeared.
CREATE INDEX environment_reservations_owner ON environment_reservations(owner_id);
