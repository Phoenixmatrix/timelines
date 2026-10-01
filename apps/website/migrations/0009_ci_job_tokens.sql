-- CI jobs act as their repository: each job gets a credential when it starts,
-- valid until it ends (or expires). Package registries accept it (gmj_…), so
-- npm publish, docker push and friends work in CI with no token to manage.
CREATE TABLE ci_job_tokens (
  token_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ci_jobs (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX ci_job_tokens_job ON ci_job_tokens (job_id);
