-- The preview contract (CORE-79; TIMELINES-RESEARCH.md, "Previews: primitives,
-- not hosting"): a project opts in with `on: preview` in ci.yml, and Gitmatrix
-- starts preview runs whose jobs pick `create` or `teardown` with `if:`.
--
-- A preview run is stored with trigger 'manual' and its action here: widening
-- ci_runs.trigger's CHECK would mean rebuilding ci_runs, and dropping it
-- cascades to every job, step and log. Readers report such a run's trigger as
-- 'preview' (worker/ci/api.ts, worker/ci/jobs.ts).
ALTER TABLE ci_runs ADD COLUMN preview_action TEXT CHECK (preview_action IN ('create', 'teardown'));
-- The timeline (slug) and checkpoint the preview run is for.
ALTER TABLE ci_runs ADD COLUMN timeline_slug TEXT;
ALTER TABLE ci_runs ADD COLUMN checkpoint_id TEXT;
-- A `create` run started by reviving a checkpoint's preview: it rebuilds, so
-- what it records is marked rebuilt, pointing at the record it stands in for.
ALTER TABLE ci_runs ADD COLUMN preview_revived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ci_runs ADD COLUMN preview_rebuilt_from INTEGER REFERENCES deployments (id) ON DELETE SET NULL;

-- A revived preview: rebuilt from its checkpoint's commit later, so it can
-- differ from the original (toolchain, seed). rebuilt_from is the earlier
-- record of the same checkpoint, when there was one.
ALTER TABLE deployments ADD COLUMN revived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN rebuilt_from INTEGER REFERENCES deployments (id) ON DELETE SET NULL;
-- Set when the recorder gave expires_at itself; otherwise a timeline
-- preview's expiry follows the account's retention and the sweep moves it.
ALTER TABLE deployments ADD COLUMN expiry_pinned INTEGER NOT NULL DEFAULT 0;
-- When the sweep expired it, and the teardown run it started (none when the
-- project's ci.yml at that commit doesn't opt in).
ALTER TABLE deployments ADD COLUMN torn_down_at TEXT;
ALTER TABLE deployments ADD COLUMN teardown_run_id TEXT REFERENCES ci_runs (id) ON DELETE SET NULL;

-- The sweep reads the live timeline previews.
CREATE INDEX deployments_live_previews ON deployments (repo_id, timeline_slug)
  WHERE status IN ('active', 'sleeping') AND timeline_slug IS NOT NULL;
