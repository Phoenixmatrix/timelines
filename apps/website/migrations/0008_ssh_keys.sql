-- SSH keys over HTTPS (worker/ssh.ts, worker/api/ssh.ts). A client proves it
-- holds a registered key by signing a one-time challenge (SSHSIG, as
-- `ssh-keygen -Y sign` makes) and gets a short-lived session token.

CREATE TABLE ssh_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  key_type TEXT NOT NULL,
  -- "<type> <base64>", without the comment.
  public_key TEXT NOT NULL,
  -- OpenSSH style: SHA256:<base64, unpadded>. A key belongs to one account.
  fingerprint TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX ssh_keys_user ON ssh_keys (user_id);

-- One-time nonces handed out for a key; consumed by the signed reply.
CREATE TABLE ssh_challenges (
  nonce TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES ssh_keys (id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Session tokens minted from a key expire, and go when the key goes.
ALTER TABLE access_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE access_tokens ADD COLUMN ssh_key_id TEXT REFERENCES ssh_keys (id) ON DELETE CASCADE;
CREATE INDEX access_tokens_ssh_key ON access_tokens (ssh_key_id);
