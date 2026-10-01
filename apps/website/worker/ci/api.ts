// The CI API.
//
// Per repository, under /api/repos/:owner/:name/ci:
//   GET    /                       recent runs (?before=<number> pages back)
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

import { Hono } from "hono";
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
import { claim, jobPayload, loadJob, report, type StoredJob } from "./jobs.ts";
import { mintJobToken } from "./registry.ts";
import { startRun } from "./trigger.ts";

const PAGE = 30;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

const selectRuns = (kdb: DB) =>
  kdb
    .selectFrom("ci_runs as r")
    .leftJoin("accounts as a", "a.id", "r.actor_id")
    .selectAll("r")
    .select("a.slug as actor");

type RunRow = InferResult<ReturnType<typeof selectRuns>>[number];

const toRun = (row: RunRow): CiRunSummary => ({
  id: row.id,
  number: row.number,
  commit: row.commit_oid,
  ref: row.ref,
  trigger: row.trigger,
  title: row.title,
  status: row.status,
  actor: row.actor,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const ci = new Hono<AppEnv>();

ci.get("/", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const results = await selectRuns(db(c.env.DB))
    .where("r.repo_id", "=", repo.row.id)
    .where("r.number", "<", before)
    .orderBy("r.number", "desc")
    .limit(PAGE)
    .execute();
  return c.json<CiRunList>({ runs: results.map(toRun), runner: c.env.CI_RUNNER });
});

ci.post("/runs", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const body = await readJson<{ ref: string }>(c);
  const branch = (body.ref ?? repo.row.default_branch).replace(/^refs\/heads\//, "");
  const reader = new RepoReader(
    c.env,
    repo.row.artifacts_name,
    repo.row.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
  );
  const refs = await reader.refs();
  await reader.close();
  const target = refs.branches.find((b) => b.shortName === branch);
  if (!target) return fail(c, 404, `No branch named ${branch}.`);
  const started = await startRun(c.env, repo.row, {
    branch,
    commit: target.oid,
    trigger: "manual",
    actorId: c.get("actor")?.id ?? null,
    waitUntil: (work) => c.executionCtx.waitUntil(work),
  });
  if ("skipped" in started) return fail(c, 422, started.skipped);
  return c.json({ number: started.number }, 201);
});

async function runDetail(
  d1: D1Database,
  repoId: string,
  number: number,
): Promise<CiRunDetail | null> {
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
  const run = await runDetail(c.env.DB, repo.row.id, Number(c.req.param("number")));
  return run ? c.json<CiRunDetail>(run) : fail(c, 404, "No such run.");
});

ci.post("/runs/:number{[0-9]+}/cancel", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const d1 = c.env.DB;
  const kdb = db(d1);
  const run = await kdb
    .selectFrom("ci_runs")
    .select(["id", "status"])
    .where("repo_id", "=", repo.row.id)
    .where("number", "=", Number(c.req.param("number")))
    .executeTakeFirst();
  if (!run) return fail(c, 404, "No such run.");
  if (run.status !== "queued" && run.status !== "running") {
    return fail(c, 409, `The run already ${run.status}.`);
  }
  // Runners notice on their next report and stop; the Workflow stops now.
  const now = nowIso();
  await batch(d1, [
    kdb
      .updateTable("ci_runs")
      .set({ status: "cancelled", finished_at: now })
      .where("id", "=", run.id),
    kdb
      .updateTable("ci_jobs")
      .set({ status: "cancelled", finished_at: now })
      .where("run_id", "=", run.id)
      .where("status", "in", ["pending", "queued", "running"]),
    kdb
      .updateTable("ci_steps")
      .set({ status: "cancelled", finished_at: now })
      .where("job_id", "in", kdb.selectFrom("ci_jobs").select("id").where("run_id", "=", run.id))
      .where("status", "in", ["pending", "running"]),
  ]);
  const instance = await c.env.CI_RUN.get(run.id).catch(() => null);
  await instance?.terminate().catch(() => {});
  return c.json({ ok: true });
});

ci.post("/runs/:number{[0-9]+}/rerun", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const run = await db(c.env.DB)
    .selectFrom("ci_runs")
    .select(["commit_oid", "ref"])
    .where("repo_id", "=", repo.row.id)
    .where("number", "=", Number(c.req.param("number")))
    .executeTakeFirst();
  if (!run) return fail(c, 404, "No such run.");
  const started = await startRun(c.env, repo.row, {
    branch: run.ref,
    commit: run.commit_oid,
    trigger: "manual",
    actorId: c.get("actor")?.id ?? null,
    waitUntil: (work) => c.executionCtx.waitUntil(work),
  });
  if ("skipped" in started) return fail(c, 422, started.skipped);
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
    .selectFrom("ci_jobs")
    .select("status")
    .where("id", "=", c.req.param("job"))
    .where("repo_id", "=", repo.row.id);
  const [chunks, job] = await batch(d1, [chunksQuery, jobQuery]);
  const status = (job!.results as InferResult<typeof jobQuery>)[0]?.status;
  if (!status) return fail(c, 404, "No such job.");
  const rows: CiLogs["chunks"] = chunks!.results as InferResult<typeof chunksQuery>;
  const done = !["pending", "queued", "running"].includes(status);
  return c.json<CiLogs>({
    chunks: rows,
    next: rows.at(-1)?.seq ?? after,
    // Done only once the job ended and every chunk has been read.
    done: done && rows.length < 500,
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
    .select(["commit_oid", "status", "number"])
    .where("repo_id", "=", repo.row.id)
    .where("commit_oid", "in", commits)
    .orderBy("number")
    .execute();
  const out: CiCommitStatuses = {};
  // Ordered by number, so the latest run per commit wins.
  for (const row of results) out[row.commit_oid] = { status: row.status, number: row.number };
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

/** Whether the actor may run (and see the secrets of) jobs for a repo. */
async function mayRun(
  d1: D1Database,
  actor: NonNullable<AppEnv["Variables"]["actor"]>,
  repo: string,
) {
  const [owner, name] = repo.split("/");
  const row = await findRepo(d1, actor, owner ?? "", name ?? "");
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
    .innerJoin("accounts as o", "o.id", "p.owner_id")
    .select(["j.id", sql<string>`o.slug || '/' || p.name`.as("repo")])
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
    if (!(await claim(c.env.DB, candidate.id, runnerName))) continue;
    const job = await loadJob(c.env.DB, candidate.id);
    if (!job) continue;
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
    const token = await mintJobToken(c.env.DB, job.id, spec.timeoutMinutes);
    return c.json<CiClaimedJob>(
      await jobPayload(c.env.DB, job, { origin: new URL(c.req.url).origin, token }),
    );
  }
  return c.body(null, 204);
});

runner.post("/jobs/:job", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const job = await loadJob(c.env.DB, c.req.param("job"));
  if (!job || job.runner !== "local" || !(await mayRun(c.env.DB, actor, job.full_name))) {
    return fail(c, 404, "No such job.");
  }
  const update = await readJson<CiJobReport>(c);
  return c.json(await report(c.env, job.id, update));
});
