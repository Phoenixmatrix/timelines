-- Advisory, self-reported profiles on existing identities. Legacy agents stay unset.
ALTER TABLE agents ADD COLUMN capabilities TEXT;
ALTER TABLE agents ADD COLUMN capabilities_updated_at TEXT;
