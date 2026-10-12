-- Deployment provenance (CORE-351; decisions on CORE-348): which provider
-- version ran and which registry publication was deployed, on the existing
-- deployment record rather than a parallel one. Every column is nullable and
-- nothing is backfilled: a record made before this, or without these fields,
-- is uninstrumented, and its runtime evidence can only ever be temporal or
-- ambiguous (shared/observability.ts).
--
-- The provider identity is what the producer deployed: the provider, its
-- service (a Worker script) and the immutable version and deployment ids it
-- assigned. No connection or binding is stored: CORE-352/353 resolve the
-- binding from (repo, service, environment) at read time, under current
-- authorization, and a version counts as explicit only once the reader finds
-- it under the bound service.
ALTER TABLE deployments ADD COLUMN provider TEXT CHECK (provider IN ('cloudflare'));
ALTER TABLE deployments ADD COLUMN provider_service TEXT;
ALTER TABLE deployments ADD COLUMN provider_version_id TEXT;
ALTER TABLE deployments ADD COLUMN provider_deployment_id TEXT;
-- The producer's own claim at deploy time, never a snapshot of provider
-- telemetry: when the provider deployed it, when it started and stopped
-- serving, and a canary's share (0–100). The provider's live deployment
-- history (CORE-352) is authoritative while it has them. created_at stays
-- when Gitmatrix recorded it.
ALTER TABLE deployments ADD COLUMN deployed_at TEXT;
ALTER TABLE deployments ADD COLUMN exposed_from TEXT;
ALTER TABLE deployments ADD COLUMN exposed_until TEXT;
ALTER TABLE deployments ADD COLUMN percentage REAL CHECK (percentage BETWEEN 0 AND 100);
-- A rollback or replacement: the provider version it replaced, and that
-- version's record when one exists in the same repository, source and
-- environment.
ALTER TABLE deployments ADD COLUMN replaces_version_id TEXT;
ALTER TABLE deployments ADD COLUMN replaces_deployment_id INTEGER REFERENCES deployments (id) ON DELETE SET NULL;
-- The registry publication deployed (registry D1, no foreign key): checked
-- at record time to come from this repository's source and commit, with the
-- name and version as published. A package built from the same commit is not
-- proof it was deployed, so nothing here is inferred.
ALTER TABLE deployments ADD COLUMN artifact_publish_id TEXT;
ALTER TABLE deployments ADD COLUMN artifact_package_id TEXT;
ALTER TABLE deployments ADD COLUMN artifact_format TEXT;
ALTER TABLE deployments ADD COLUMN artifact_name TEXT;
ALTER TABLE deployments ADD COLUMN artifact_version TEXT;
ALTER TABLE deployments ADD COLUMN artifact_digest TEXT;

-- One record per provider deployment of a version in a source (a provider
-- version always comes with the deployment that put it out): a retried
-- record finds the first (worker/deployments/api.ts answers it again).
CREATE UNIQUE INDEX deployments_provider_identity
  ON deployments (repo_id, source_id, provider, provider_service, provider_version_id, provider_deployment_id)
  WHERE provider_version_id IS NOT NULL;
-- Runtime evidence joins a provider version to its records (CORE-353).
CREATE INDEX deployments_provider_version
  ON deployments (provider, provider_service, provider_version_id)
  WHERE provider_version_id IS NOT NULL;
-- A canary's members: the records sharing one provider deployment (/environments).
CREATE INDEX deployments_provider_deployment
  ON deployments (repo_id, source_id, provider_deployment_id)
  WHERE provider_deployment_id IS NOT NULL;
