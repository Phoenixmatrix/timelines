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
  CiStep,
} from "../../shared/api.ts";
import { fail, readJson, requireActor } from "../api/http.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import { findRepo, roleFor } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { claim, jobPayload, loadJob, report, type StoredJob } from "./jobs.ts";
import { startRun } from "./trigger.ts";

interface RunRow {
  id: string;
  number: number;
  commit_oid: string;
  ref: string;
  trigger: "push" | "manual";
  title: string;
  status: CiRunSummary["status"];
  actor: string | null;
  config_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const RUN_SELECT = `SELECT r.*, a.slug AS actor FROM ci_runs r LEFT JOIN accounts a ON a.id = r.actor_id`;
const PAGE = 30;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

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
  const { results } = await c.env.DB.prepare(
    `${RUN_SELECT} WHERE r.repo_id = ? AND r.number < ? ORDER BY r.number DESC LIMIT ${PAGE}`,
  )
    .bind(repo.row.id, before)
    .all<RunRow>();
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
  db: D1Database,
  repoId: string,
  number: number,
): Promise<CiRunDetail | null> {
  const row = await db
    .prepare(`${RUN_SELECT} WHERE r.repo_id = ? AND r.number = ?`)
    .bind(repoId, number)
    .first<RunRow>();
  if (!row) return null;
  const [jobs, steps] = await db.batch([
    db.prepare("SELECT * FROM ci_jobs WHERE run_id = ? ORDER BY rowid").bind(row.id),
    db
      .prepare(
        "SELECT s.* FROM ci_steps s JOIN ci_jobs j ON j.id = s.job_id WHERE j.run_id = ? ORDER BY s.position",
      )
      .bind(row.id),
  ]);
  type JobRow = {
    id: string;
    name: string;
    spec: string;
    status: CiJob["status"];
    runner: CiJob["runner"];
    claimed_by: string | null;
    exit_code: number | null;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
  type StepRow = {
    job_id: string;
    position: number;
    name: string;
    status: CiStep["status"];
    exit_code: number | null;
    started_at: string | null;
    finished_at: string | null;
  };
  const stepRows = steps!.results as StepRow[];
  return {
    ...toRun(row),
    configError: row.config_error,
    jobs: (jobs!.results as JobRow[]).map((job) => ({
      id: job.id,
      name: job.name,
      needs: (JSON.parse(job.spec) as StoredJob).needs,
      status: job.status,
      runner: job.runner,
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
  const db = c.env.DB;
  const run = await db
    .prepare("SELECT id, status FROM ci_runs WHERE repo_id = ? AND number = ?")
    .bind(repo.row.id, Number(c.req.param("number")))
    .first<{ id: string; status: string }>();
  if (!run) return fail(c, 404, "No such run.");
  if (run.status !== "queued" && run.status !== "running") {
    return fail(c, 409, `The run already ${run.status}.`);
  }
  // Runners notice on their next report and stop; the Workflow stops now.
  await db.batch([
    db
      .prepare(`UPDATE ci_runs SET status = 'cancelled', finished_at = ${now} WHERE id = ?`)
      .bind(run.id),
    db
      .prepare(
        `UPDATE ci_jobs SET status = 'cancelled', finished_at = ${now}
         WHERE run_id = ? AND status IN ('pending', 'queued', 'running')`,
      )
      .bind(run.id),
    db
      .prepare(
        `UPDATE ci_steps SET status = 'cancelled', finished_at = ${now}
         WHERE job_id IN (SELECT id FROM ci_jobs WHERE run_id = ?) AND status IN ('pending', 'running')`,
      )
      .bind(run.id),
  ]);
  const instance = await c.env.CI_RUN.get(run.id).catch(() => null);
  await instance?.terminate().catch(() => {});
  return c.json({ ok: true });
});

ci.post("/runs/:number{[0-9]+}/rerun", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const run = await c.env.DB.prepare(
    "SELECT commit_oid, ref FROM ci_runs WHERE repo_id = ? AND number = ?",
  )
    .bind(repo.row.id, Number(c.req.param("number")))
    .first<{ commit_oid: string; ref: string }>();
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
  const db = c.env.DB;
  const [chunks, job] = await db.batch([
    db
      .prepare(
        `SELECT l.seq, l.step, l.text FROM ci_logs l JOIN ci_jobs j ON j.id = l.job_id
         WHERE l.job_id = ? AND j.repo_id = ? AND l.seq > ? ORDER BY l.seq LIMIT 500`,
      )
      .bind(c.req.param("job"), repo.row.id, after),
    db
      .prepare("SELECT status FROM ci_jobs WHERE id = ? AND repo_id = ?")
      .bind(c.req.param("job"), repo.row.id),
  ]);
  const status = (job!.results[0] as { status: string } | undefined)?.status;
  if (!status) return fail(c, 404, "No such job.");
  const rows = chunks!.results as CiLogs["chunks"];
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
  const { results } = await c.env.DB.prepare(
    `SELECT commit_oid, status, number FROM ci_runs WHERE repo_id = ?
       AND commit_oid IN (${commits.map(() => "?").join(",")}) ORDER BY number`,
  )
    .bind(repo.row.id, ...commits)
    .all<{ commit_oid: string; status: CiRunSummary["status"]; number: number }>();
  const out: CiCommitStatuses = {};
  // Ordered by number, so the latest run per commit wins.
  for (const row of results) out[row.commit_oid] = { status: row.status, number: row.number };
  return c.json(out);
});

ci.get("/secrets", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  const { results } = await c.env.DB.prepare(
    "SELECT name, updated_at FROM ci_secrets WHERE repo_id = ? ORDER BY name",
  )
    .bind(repo.row.id)
    .all<{ name: string; updated_at: string }>();
  return c.json<CiSecretSummary[]>(results.map((r) => ({ name: r.name, updatedAt: r.updated_at })));
});

ci.put("/secrets/:secret", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  const name = c.req.param("secret");
  if (!SECRET_NAME.test(name)) return fail(c, 400, "Secret names use letters, digits and _.");
  const { value } = await readJson<{ value: string }>(c);
  if (typeof value !== "string" || !value) return fail(c, 400, "A secret needs a value.");
  await c.env.DB.prepare(
    `INSERT INTO ci_secrets (repo_id, name, value) VALUES (?, ?, ?)
     ON CONFLICT (repo_id, name) DO UPDATE SET value = excluded.value, updated_at = ${now}`,
  )
    .bind(repo.row.id, name, value)
    .run();
  return c.json({ ok: true });
});

ci.delete("/secrets/:secret", async (c) => {
  const repo = await loadRepo(c, "admin");
  if (repo instanceof Response) return repo;
  await c.env.DB.prepare("DELETE FROM ci_secrets WHERE repo_id = ? AND name = ?")
    .bind(repo.row.id, c.req.param("secret"))
    .run();
  return c.json({ ok: true });
});

// ---- runners ----------------------------------------------------------------

export const runner = new Hono<AppEnv>();

/** Whether the actor may run (and see the secrets of) jobs for a repo. */
async function mayRun(
  db: D1Database,
  actor: NonNullable<AppEnv["Variables"]["actor"]>,
  repo: string,
) {
  const [owner, name] = repo.split("/");
  const row = await findRepo(db, actor, owner ?? "", name ?? "");
  return row !== null && atLeast(roleFor(row, actor), "write");
}

runner.post("/claim", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ name: string; repo: string }>(c);
  const runnerName = `${actor.slug}/${(body.name ?? "runner").slice(0, 60)}`;
  const { results } = await c.env.DB.prepare(
    `SELECT j.id, o.slug || '/' || p.name AS repo FROM ci_jobs j
       JOIN repos p ON p.id = j.repo_id JOIN accounts o ON o.id = p.owner_id
     WHERE j.runner = 'local' AND j.status = 'queued'
     ORDER BY j.rowid LIMIT 50`,
  ).all<{ id: string; repo: string }>();
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
    await c.env.DB.prepare(
      `UPDATE ci_runs SET status = 'running', started_at = COALESCE(started_at, ${now})
       WHERE id = ? AND status = 'queued'`,
    )
      .bind(job.run_id)
      .run();
    return c.json<CiClaimedJob>(await jobPayload(c.env.DB, job));
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
