// The CI API.
//
// Per repository, under /api/repos/:space/:name/ci:
//   GET    /                       recent runs (?before=<number> pages back, ?ref=<branch>
//                                   only that branch's: a timeline's bookmark, say;
//                                   ?commit=<oid> only that commit's)
//   POST   /runs                   start a run for {ref} (write)
//   GET    /runs/:number           one run with jobs and steps
//   POST   /runs/:number/cancel    cancel it (write)
//   POST   /runs/:number/rerun     run the same commit again (write)
//   GET    /jobs/:job/logs?after=  output, from a sequence number on
//   GET    /status?commits=a,b     latest run per commit
//   GET    /secrets                secret names (admin)
//   PUT    /secrets/:name          set {value} (admin)
//   DELETE /secrets/:name          (admin)
//
// For `gm runner`, under /api/ci/runner (token auth, write access per repo):
//   POST   /claim                  {name, repo?} → a queued local job, or 204
//   POST   /jobs/:job              a CiJobReport → {cancelled}

import { Hono, type ErrorHandler } from "hono";
import { sql, type InferResult } from "kysely";
import type {
  CiClaimedJob,
  CiCommitStatuses,
  CiJob,
  CiJobReport,
  CiLogs,
  CiRunDetail,
  CiRunList,
  CiRunSummary,
  CiSecretSummary,
} from "../../shared/api.ts";
import { fail, readJson, requireActor } from "../api/http.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import { findRepo, roleFor } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { batch, db, nowIso, type DB } from "../schema.ts";
import { cancelRun } from "./cancel.ts";
import { claim, jobPayload, loadJob, report, settleStoppedJob, type StoredJob } from "./jobs.ts";
import { mintJobToken } from "./registry.ts";
import { startRun } from "./trigger.ts";
import { landingSlugOf } from "../../shared/timelines.ts";
import { resolveSource } from "../timelines/sources.ts";
import { ciSource } from "./source.ts";
import { noteAgentPresence, readAgentPresence } from "../agent-presence.ts";
import { WorkAuthorizationError } from "./admission.ts";

const PAGE = 30;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

const selectRuns = (kdb: DB) =>
  kdb
    .selectFrom("ci_runs as r")
    .leftJoin("accounts as a", "a.id", "r.actor_id")
    .leftJoin("agents as g", "g.id", "r.agent_id")
    .selectAll("r")
    .select(["a.slug as actor", "g.name as agent"]);

type RunRow = InferResult<ReturnType<typeof selectRuns>>[number];

const toRun = (row: RunRow): CiRunSummary => ({
  id: row.id,
  sourceId: row.source_id,
  number: row.number,
  commit: row.commit_oid,
  ref: row.ref,
  trigger: row.preview_action
    ? "preview"
    : row.landing_id || row.queue_id
      ? "landing"
      : row.trigger,
  landing: row.landing_id ? { id: row.landing_id, timeline: landingSlugOf(row.ref) } : null,
  queueId: row.queue_id,
  preview: row.preview_action
    ? {
        action: row.preview_action,
        timeline: row.timeline_slug,
        checkpoint: row.checkpoint_id,
        revived: row.preview_revived === 1,
      }
    : null,
  title: row.title,
  status: row.status,
  actor: row.actor,
  agent: row.agent,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  heldAt: row.held_at,
  coveredBy: row.covered_by,
});

const workErrorHandler: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof WorkAuthorizationError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error.message === "migration_epoch_mismatch")
    return c.json({ error: error.message, code: "migration_epoch_mismatch" }, 409);
  if (error.message === "space_cutover_fenced")
    return c.json({ error: error.message, code: "space_cutover_fenced" }, 503);
  throw error;
};

export const ci = new Hono<AppEnv>();
ci.onError(workErrorHandler);

ci.get("/", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const ref = c.req.query("ref")?.replace(/^refs\/heads\//, "");
  let query = selectRuns(db(c.env.DB))
    .where("r.repo_id", "=", repo.row.id)
    .where("r.source_id", "=", c.req.query("source") ?? "canonical")
    .where("r.number", "<", before);
  if (ref) query = query.where("r.ref", "=", ref);
  // A commit's runs, for the commit panel (CORE-22).
  const commit = c.req.query("commit")?.toLowerCase();
  if (commit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(commit)) return fail(c, 400, "commit is a full commit hash.");
    query = query.where("r.commit_oid", "=", commit);
  }
  const results = await query.orderBy("r.number", "desc").limit(PAGE).execute();
  return c.json<CiRunList>({ runs: results.map(toRun), runner: c.env.CI_RUNNER });
});

ci.post("/runs", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const body = await readJson<{ ref: string; source?: string }>(c);
  const source = await resolveSource(c.env, repo.row, body.source ?? c.req.query("source"));
  const branch = (body.ref ?? source.repo.default_branch).replace(/^refs\/heads\//, "");
  const reader = new RepoReader(
    c.env,
    source.repo.artifacts_name,
    source.repo.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
    source.source.kind === "timeline-work" ? source.source.ref : undefined,
  );
  const refs = await reader.refs();
  await reader.close();
  const target = refs.branches.find((b) => b.shortName === branch);
  if (!target) return fail(c, 404, `No branch named ${branch}.`);
  const started = await startRun(c.env, source.repo, {
    branch,
    commit: target.oid,
    trigger: "manual",
    actor: c.get("actor") ?? null,
    waitUntil: (work) => c.executionCtx.waitUntil(work),
  });
  if ("skipped" in started) return fail(c, 422, started.skipped);
  noteAgentPresence(c, {
    kind: "ci-run",
    scopeId: repo.row.id,
    resourceId: started.runId,
    sourceId: source.repo.source_id,
  });
  return c.json({ number: started.number }, 201);
});

async function runDetail(
  d1: D1Database,
  repoId: string,
  number: number,
): Promise<(CiRunDetail & { sourceId: string }) | null> {
  const kdb = db(d1);
  const row = await selectRuns(kdb)
    .where("r.repo_id", "=", repoId)
    .where("r.number", "=", number)
    .executeTakeFirst();
  if (!row) return null;
  const jobsQuery = kdb
    .selectFrom("ci_jobs")
    .selectAll()
    .where("run_id", "=", row.id)
    .orderBy(sql`rowid`);
  const stepsQuery = kdb
    .selectFrom("ci_steps as s")
    .innerJoin("ci_jobs as j", "j.id", "s.job_id")
    .selectAll("s")
    .where("j.run_id", "=", row.id)
    .orderBy("s.position");
  const [jobs, steps] = await batch(d1, [jobsQuery, stepsQuery]);
  const stepRows = steps!.results as InferResult<typeof stepsQuery>;
  return {
    ...toRun(row),
    sourceId: row.source_id,
    configError: row.config_error,
    jobs: (jobs!.results as InferResult<typeof jobsQuery>).map((job) => ({
      id: job.id,
      name: job.name,
      needs: (JSON.parse(job.spec) as StoredJob).needs,
      status: job.status,
      runner: job.runner as CiJob["runner"],
      claimedBy: job.claimed_by,
      exitCode: job.exit_code,
      error: job.error,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      logsRemovedAt: job.logs_removed_at,
      verifiedBy:
        job.status === "skipped" && job.verified_by
          ? (JSON.parse(job.verified_by) as NonNullable<CiJob["verifiedBy"]>)
          : null,
      steps: stepRows
        .filter((s) => s.job_id === job.id)
        .map((s) => ({
          position: s.position,
          name: s.name,
          status: s.status,
          exitCode: s.exit_code,
          startedAt: s.started_at,
          finishedAt: s.finished_at,
        })),
    })),
  };
}

ci.get("/runs/:number{[0-9]+}", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const number = Number(c.req.param("number"));
  const run = await runDetail(c.env.DB, repo.row.id, number);
  if (run) {
    if (c.req.query("source") !== undefined && c.req.query("source") !== run.sourceId)
      return fail(c, 404, "No such run.");
    noteAgentPresence(c, {
      kind: "ci-run",
      scopeId: repo.row.id,
      resourceId: run.id,
      sourceId: run.sourceId,
    });
    return c.json<CiRunDetail>(run);
  }
  return fail(c, 404, await missingRun(c.env.DB, repo.row.id, number));
});

ci.get("/runs/:number{[0-9]+}/presence", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const run = await db(c.env.DB)
    .selectFrom("ci_runs")
    .select(["id", "source_id"])
    .where("repo_id", "=", repo.row.id)
    .where("number", "=", Number(c.req.param("number")))
    .executeTakeFirst();
  if (!run || (c.req.query("source") !== undefined && c.req.query("source") !== run.source_id))
    return fail(c, 404, "No such run.");
  c.header("cache-control", "private, no-store");
  return c.json(
    await readAgentPresence(c.env.DB, {
      kind: "ci-run",
      scopeId: repo.row.id,
      resourceId: run.id,
      sourceId: run.source_id,
    }),
  );
});

/**
 * Why a run number has no run. Numbers are handed out in sequence and only
 * retention deletes runs ("ci-runs", CORE-200), so a number below a run that
 * exists was removed by retention.
 */
async function missingRun(d1: D1Database, repoId: string, number: number): Promise<string> {
  const later = await db(d1)
    .selectFrom("ci_runs")
    .select("number")
    .where("repo_id", "=", repoId)
    .where("number", ">", number)
    .limit(1)
    .executeTakeFirst();
  return later ? `Run #${number} was removed by retention.` : "No such run.";
}

ci.post("/runs/:number{[0-9]+}/cancel", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const run = await db(c.env.DB)
    .selectFrom("ci_runs")
    .select(["id", "status", "source_id"])
    .where("repo_id", "=", repo.row.id)
    .where("number", "=", Number(c.req.param("number")))
    .executeTakeFirst();
  if (!run) return fail(c, 404, "No such run.");
  if (c.req.query("source") !== undefined && c.req.query("source") !== run.source_id)
    return fail(c, 404, "No such run.");
  if (run.status !== "queued" && run.status !== "running") {
    return fail(c, 409, `The run already ${run.status}.`);
  }
  await cancelRun(c.env, run.id);
  noteAgentPresence(c, {
    kind: "ci-run",
    scopeId: repo.row.id,
    resourceId: run.id,
    sourceId: run.source_id,
  });
  return c.json({ ok: true });
});

ci.post("/runs/:number{[0-9]+}/rerun", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const run = await db(c.env.DB)
    .selectFrom("ci_runs")
    .select([
      "id",
      "source_id",
      "commit_oid",
      "ref",
      "preview_action",
      "timeline_slug",
      "checkpoint_id",
      "preview_revived",
      "preview_rebuilt_from",
      "queue_id",
    ])
    .where("repo_id", "=", repo.row.id)
    .where("number", "=", Number(c.req.param("number")))
    .executeTakeFirst();
  if (!run) return fail(c, 404, "No such run.");
  if (c.req.query("source") !== undefined && c.req.query("source") !== run.source_id)
    return fail(c, 404, "No such run.");
  if (run.queue_id)
    return fail(
      c,
      409,
      "Retry this entry through the merge queue so its attempt and credentials stay fenced.",
    );
  // Re-running a preview run repeats its action for the same checkpoint.
  const preview =
    run.preview_action && run.timeline_slug
      ? {
          action: run.preview_action,
          timeline: run.timeline_slug,
          checkpoint: run.checkpoint_id,
          revived: run.preview_revived === 1,
          rebuiltFrom: run.preview_rebuilt_from,
        }
      : undefined;
  const source = await resolveSource(c.env, repo.row, run.source_id);
  const started = await startRun(c.env, source.repo, {
    branch: run.ref,
    commit: run.commit_oid,
    trigger: preview ? "preview" : "manual",
    ...(preview ? { preview } : {}),
    actor: c.get("actor") ?? null,
    waitUntil: (work) => c.executionCtx.waitUntil(work),
  });
  if ("skipped" in started) return fail(c, 422, started.skipped);
  noteAgentPresence(c, {
    kind: "ci-run",
    scopeId: repo.row.id,
    resourceId: run.id,
    sourceId: run.source_id,
  });
  if (started.runId !== run.id)
    noteAgentPresence(c, {
      kind: "ci-run",
      scopeId: repo.row.id,
      resourceId: started.runId,
      sourceId: run.source_id,
    });
  return c.json({ number: started.number }, 201);
});

ci.get("/jobs/:job/logs", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const after = Number(c.req.query("after")) || 0;
  const d1 = c.env.DB;
  const kdb = db(d1);
  const chunksQuery = kdb
    .selectFrom("ci_logs as l")
    .innerJoin("ci_jobs as j", "j.id", "l.job_id")
    .select(["l.seq", "l.step", "l.text"])
    .where("l.job_id", "=", c.req.param("job"))
    .where("j.repo_id", "=", repo.row.id)
    .where("l.seq", ">", after)
    .orderBy("l.seq")
    .limit(500);
  const jobQuery = kdb
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select(["j.status", "j.logs_removed_at", "r.id as run_id", "r.source_id"])
    .where("j.id", "=", c.req.param("job"))
    .where("j.repo_id", "=", repo.row.id)
    .where("r.repo_id", "=", repo.row.id);
  const [chunks, job] = await batch(d1, [chunksQuery, jobQuery]);
  const found = (job!.results as InferResult<typeof jobQuery>)[0];
  if (!found) return fail(c, 404, "No such job.");
  if (c.req.query("source") !== undefined && c.req.query("source") !== found.source_id)
    return fail(c, 404, "No such job.");
  const status = found.status;
  const rows: CiLogs["chunks"] = chunks!.results as InferResult<typeof chunksQuery>;
  const done = !["pending", "queued", "running"].includes(status);
  noteAgentPresence(c, {
    kind: "ci-run",
    scopeId: repo.row.id,
    resourceId: found.run_id,
    sourceId: found.source_id,
  });
  return c.json<CiLogs>({
    chunks: rows,
    next: rows.at(-1)?.seq ?? after,
    // Done only once the job ended and every chunk has been read.
    done: done && rows.length < 500,
    removedAt: found.logs_removed_at,
  });
});

ci.get("/status", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const commits = (c.req.query("commits") ?? "")
    .split(",")
    .filter((s) => /^[0-9a-f]{40}$/.test(s))
    .slice(0, 100);
  if (commits.length === 0) return c.json<CiCommitStatuses>({});
  const results = await db(c.env.DB)
    .selectFrom("ci_runs")
    .select(["commit_oid", "status", "number", "covered_by"])
    .where("repo_id", "=", repo.row.id)
    .where("commit_oid", "in", commits)
    .orderBy("number")
    .execute();
  const out: CiCommitStatuses = {};
  // Ordered by number, so the latest run per commit wins.
  for (const row of results)
    out[row.commit_oid] = { status: row.status, number: row.number, coveredBy: row.covered_by };
  return c.json(out);
});

ci.get("/secrets", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  const results = await db(c.env.DB)
    .selectFrom("ci_secrets")
    .select(["name", "updated_at"])
    .where("repo_id", "=", repo.row.id)
    .orderBy("name")
    .execute();
  return c.json<CiSecretSummary[]>(results.map((r) => ({ name: r.name, updatedAt: r.updated_at })));
});

ci.put("/secrets/:secret", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  const name = c.req.param("secret");
  if (!SECRET_NAME.test(name)) return fail(c, 400, "Secret names use letters, digits and _.");
  const { value } = await readJson<{ value: string }>(c);
  if (typeof value !== "string" || !value) return fail(c, 400, "A secret needs a value.");
  await db(c.env.DB)
    .insertInto("ci_secrets")
    .values({ repo_id: repo.row.id, name, value })
    .onConflict((oc) =>
      oc.columns(["repo_id", "name"]).doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        updated_at: nowIso(),
      })),
    )
    .execute();
  return c.json({ ok: true });
});

ci.delete("/secrets/:secret", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  await db(c.env.DB)
    .deleteFrom("ci_secrets")
    .where("repo_id", "=", repo.row.id)
    .where("name", "=", c.req.param("secret"))
    .execute();
  return c.json({ ok: true });
});

// ---- runners ----------------------------------------------------------------

export const runner = new Hono<AppEnv>();

runner.onError(workErrorHandler);

/**
 * Whether the actor may run (and see the secrets of) jobs for a repo. A
 * repository being deleted still runs its previews' teardown (CORE-199); its
 * other runs were cancelled when the deletion started.
 */
async function mayRun(
  d1: D1Database,
  actor: NonNullable<AppEnv["Variables"]["actor"]>,
  repo: string,
) {
  const [space, name] = repo.split("/");
  const row = await findRepo(d1, actor, space ?? "", name ?? "", { deleting: true });
  return row !== null && atLeast(roleFor(row, actor), "write");
}

runner.post("/claim", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ name: string; repo: string }>(c);
  const runnerName = `${actor.slug}/${(body.name ?? "runner").slice(0, 60)}`;
  const kdb = db(c.env.DB);
  const results = await kdb
    .selectFrom("ci_jobs as j")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("spaces as s", "s.id", "p.space_id")
    .select(["j.id", sql<string>`s.slug || '/' || p.name`.as("repo")])
    .where("j.runner", "=", "local")
    .where("j.status", "=", "queued")
    .orderBy(sql`j.rowid`)
    .limit(50)
    .execute();
  const allowed = new Map<string, boolean>();
  for (const candidate of results) {
    if (body.repo && candidate.repo !== body.repo) continue;
    if (!allowed.has(candidate.repo)) {
      allowed.set(candidate.repo, await mayRun(c.env.DB, actor, candidate.repo));
    }
    if (!allowed.get(candidate.repo)) continue;
    if (!(await claim(c.env, candidate.id, runnerName))) continue;
    const job = await loadJob(c.env.DB, candidate.id);
    if (!job) continue;
    try {
      await ciSource(c.env, job.repo_id, job.source_id, { runId: job.run_id });
    } catch (error) {
      await report(c.env, job.id, { done: { status: "failed", error: String(error) } });
      continue;
    }
    await kdb
      .updateTable("ci_runs")
      .set((eb) => ({
        status: "running",
        started_at: eb.fn.coalesce("started_at", eb.val(nowIso())),
      }))
      .where("id", "=", job.run_id)
      .where("status", "=", "queued")
      .execute();
    const spec = JSON.parse(job.spec) as StoredJob;
    const token = await mintJobToken(c.env, job.id, spec.timeoutMinutes);
    return c.json<CiClaimedJob>(
      await jobPayload(c.env, job, { origin: new URL(c.req.url).origin, token }),
    );
  }
  return c.body(null, 204);
});

runner.post("/jobs/:job", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const job = await loadJob(c.env.DB, c.req.param("job"));
  if (!job || job.runner !== "local") return fail(c, 404, "No such job.");
  const update = await readJson<CiJobReport>(c);
  if (!(await mayRun(c.env.DB, actor, job.full_name))) {
    // A runner that lost repository access may acknowledge its own process
    // stopping, but may no longer publish logs, step results or success.
    if (update.done && job.claimed_by?.startsWith(`${actor.slug}/`)) {
      await settleStoppedJob(c.env, job.id, "Runner repository authority was revoked.");
      return c.json({ cancelled: true });
    }
    return fail(c, 404, "No such job.");
  }
  return c.json(await report(c.env, job.id, update));
});
