-- Real sign-in: Better Auth with email one-time codes, and device login for gm.
-- Better Auth owns the auth_* tables (its column names, camelCase). A Better
-- Auth user's id is the Gitmatrix account id ("acc_…"), so sessions resolve
-- straight to the accounts row that permissions already use.

ALTER TABLE accounts ADD COLUMN email TEXT;
CREATE UNIQUE INDEX accounts_email ON accounts (email COLLATE NOCASE) WHERE email IS NOT NULL;

CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user ON auth_sessions (userId);

CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX auth_accounts_user ON auth_accounts (userId);

-- One-time codes and other short-lived values.
CREATE TABLE auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX auth_verifications_identifier ON auth_verifications (identifier);

-- RFC 8628 device authorization, for `gm auth login`.
CREATE TABLE auth_device_codes (
  id TEXT PRIMARY KEY,
  deviceCode TEXT NOT NULL UNIQUE,
  userCode TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES auth_users (id) ON DELETE CASCADE,
  expiresAt TEXT NOT NULL,
  status TEXT NOT NULL,
  lastPolledAt TEXT,
  pollingInterval INTEGER,
  clientId TEXT,
  scope TEXT
);

-- Sign-up is by invitation: a code is only sent to an existing user, the
-- instance owner (OWNER_EMAIL) or an address an admin invited.
CREATE TABLE auth_invites (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  invited_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Keys (an email or an IP) that failed too often, per the AUTH_FAILURES rate
-- limiter, and are refused until `until`.
CREATE TABLE auth_lockouts (
  key TEXT PRIMARY KEY,
  until TEXT NOT NULL
);
