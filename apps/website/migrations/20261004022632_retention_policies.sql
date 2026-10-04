-- Retention policies (CORE-196; PRD CORE-195). Categories are defined in code
-- (worker/retention/categories.ts); these tables store only what an
-- administrator changed. A missing row, a missing `enabled` (NULL) or a missing
-- threshold inherits: account, then site-wide default, then the category's
-- default. Every "policy" category is disabled unless enabled here.

-- Per account, for account-scope categories.
CREATE TABLE retention_policies (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  enabled INTEGER CHECK (enabled IN (0, 1)),
  -- JSON object of threshold overrides, {key: whole number}.
  thresholds TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, category)
);
-- The scheduler looks up the accounts that enabled a category.
CREATE INDEX retention_policies_enabled ON retention_policies (category, account_id)
  WHERE enabled = 1;

-- Site level: site-scope categories, and site-wide defaults for account ones.
CREATE TABLE retention_site_policies (
  category TEXT PRIMARY KEY,
  enabled INTEGER CHECK (enabled IN (0, 1)),
  thresholds TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Who changed what: one row per category changed, for both levels (account_id
-- NULL at site level). `before`/`after` are the stored policy, as JSON
-- {enabled?, thresholds?}.
CREATE TABLE retention_policy_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  actor_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX retention_policy_changes_account ON retention_policy_changes (account_id, id);
