-- CORE-368: which machine reserved a slot, so its owner can reconcile rows whose
-- local journals were deleted. Nullable: legacy rows and hosted children have none.
ALTER TABLE environment_reservations ADD COLUMN host TEXT;
