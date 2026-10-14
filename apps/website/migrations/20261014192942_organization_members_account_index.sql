-- A person's Organization memberships (CORE-439): every Space access check
-- joins organization_members by account, and its primary key leads with the
-- Organization, so looking a person up scanned the table.
CREATE INDEX IF NOT EXISTS organization_members_account ON organization_members (account_id);
