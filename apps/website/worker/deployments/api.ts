// Deployment records, per repository under /api/repos/:owner/:name:
//   GET    /deployments           newest first; filters: environment, timeline,
//                                 commit (one or a comma list), run (number),
//                                 status; pages with before= and limit=
//   POST   /deployments           record one (write access, or the repository's
//                                 CI job credential)
//   GET    /deployments/:id       one record
//   PATCH  /deployments/:id       {status?, url?, expiresAt?} (same access)
//   GET    /environments          `production` and every environment recorded,
//                                 each with its newest deployment
//
// Environments: `production` (the default branch), `timeline/<slug>` (a
// timeline's previews), `branch/<name>` (any other branch a CI job deploys
// from) or a name of the recorder's own.
//
// Gitmatrix deploys nothing (TIMELINES-RESEARCH.md, "Previews: primitives, not
// hosting"); jobs and outside systems record what they deployed. Records stay
// when a preview expires: only the status changes.

import { Hono, type Context } from "hono";
import { sql, type InferResult } from "kysely";
import {
  branchEnvironment,
  DEPLOYMENT_STATUSES,
  MAX_BRANCH_ENVIRONMENT,
  PRODUCTION,
  timelineEnvironment,
  timelineOfEnvironment,
  type Deployment,
  type DeploymentList,
  type DeploymentStatus,
  type Environment,
  type EnvironmentList,
  previewExpiry,
} from "../../shared/deployments.ts";
import { timelineSlugOf, type Timeline } from "../../shared/timelines.ts";
import { fail } from "../api/http.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import { findRepo, type RepoRow } from "../db.ts";
import { db, nowIso, type DB } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { jobCaller, jobSecret, type JobCaller } from "./job.ts";
import { previewSettings } from "./settings.ts";
import { resolveSource } from "../timelines/sources.ts";

const PAGE = 50;
const MAX_PAGE = 100;
/** Commit ids per list, under D1's 100 bound parameters. */
const MAX_COMMITS = 80;
const MAX_ENVIRONMENTS = 200;
const OID = /^[0-9a-f]{40}$/;
const SEGMENT = "[a-z0-9](?:[a-z0-9._-]{0,62})";
const ENVIRONMENT = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);
const BRANCH = "branch/";
const TIMELINE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECKPOINT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_URL = 2048;

class Invalid extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const selectDeployments = (kdb: DB) =>
  kdb
    .selectFrom("deployments as d")
    .leftJoin("ci_runs as r", "r.id", "d.run_id")
    .leftJoin("ci_jobs as j", "j.id", "d.job_id")
    .leftJoin("ci_runs as t", "t.id", "d.teardown_run_id")
    .leftJoin("accounts as a", "a.id", "d.actor_id")
    .leftJoin("agents as g", "g.id", "d.agent_id")
    .selectAll("d")
    .select([
      "r.number as run_number",
      "j.name as job_name",
      "t.number as teardown_run_number",
      "a.slug as actor",
      "g.name as agent",
    ]);

type DeploymentRow = InferResult<ReturnType<typeof selectDeployments>>[number];

const toDeployment = (row: DeploymentRow): Deployment => ({
  id: row.id,
  sourceId: row.source_id,
  environment: row.environment,
  timeline: row.timeline_slug,
  timelineId: row.timeline_id,
  checkpoint: row.checkpoint_id,
  commit: row.commit_oid,
  url: row.url,
  status: row.status,
  run: row.run_number,
  job: row.job_name,
  actor: row.actor,
  agent: row.agent,
  expiresAt: row.expires_at,
  expiryPinned: row.expiry_pinned === 1,
  revived: row.revived === 1,
  rebuiltFrom: row.rebuilt_from,
  tornDownAt: row.torn_down_at,
  teardownRun: row.teardown_run_number,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function findDeployment(kdb: DB, repoId: string, id: number) {
  return selectDeployments(kdb)
    .where("d.repo_id", "=", repoId)
    .where("d.id", "=", id)
    .executeTakeFirst();
}

type Writer =
  | { kind: "job"; repo: RepoRow; job: JobCaller }
  | { kind: "person"; repo: RepoRow; actorId: string; agentId: string | null };

/**
 * Who may write this repository's deployments: a CI job of the repository
 * (its credential), or anyone with write access. Answers a Response otherwise.
 */
async function writer(c: Context<AppEnv>): Promise<Writer | Response> {
  const secret = jobSecret(c.req.header("authorization"));
  if (secret) {
    const job = await jobCaller(c.env.DB, secret);
    if (!job) return fail(c, 401, "The CI job's credential is invalid, or the job has ended.");
    // A deletion's preview teardown job still reports (CORE-199).
    const repo = await findRepo(
      c.env.DB,
      null,
      c.req.param("owner") ?? "",
      c.req.param("name") ?? "",
      { deleting: true },
    );
    if (!repo || repo.id !== job.repoId)
      return fail(c, 403, "A CI job records deployments for its own repository only.");
    if (job.sourceId !== "canonical" || !repo.deleted_at)
      await resolveSource(c.env, repo, job.sourceId);
    return { kind: "job", repo, job };
  }
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const actor = c.get("actor")!;
  return { kind: "person", repo: repo.row, actorId: actor.id, agentId: actor.agent?.id ?? null };
}

/** The repository to read: a job reads its own, anyone else needs read access. */
async function reader(c: Context<AppEnv>): Promise<RepoRow | Response> {
  if (jobSecret(c.req.header("authorization"))) {
    const found = await writer(c);
    return found instanceof Response ? found : found.repo;
  }
  const repo = await loadRepo(c);
  return repo instanceof Response ? repo : repo.row;
}

async function body(c: Context<AppEnv>, allowed: string[]): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new Invalid("Body must be JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Invalid("Expected an object.");
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Invalid(`Unknown field: ${key}.`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Invalid(`${name} must be a string.`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function url(value: unknown): string | null | undefined {
  const text = optionalString(value, "url");
  if (!text) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Invalid("url must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Invalid("url must be an absolute http(s) URL.");
  if (text.length > MAX_URL) throw new Invalid(`url is longer than ${MAX_URL} characters.`);
  return text;
}

function status(value: unknown): DeploymentStatus | undefined {
  if (value === undefined) return undefined;
  if (!DEPLOYMENT_STATUSES.includes(value as DeploymentStatus))
    throw new Invalid(`status must be one of: ${DEPLOYMENT_STATUSES.join(", ")}.`);
  return value as DeploymentStatus;
}

function expiry(value: unknown): string | null | undefined {
  const text = optionalString(value, "expiresAt");
  if (!text) return text;
  const time = Date.parse(text);
  if (Number.isNaN(time)) throw new Invalid("expiresAt must be an ISO 8601 time.");
  return new Date(time).toISOString();
}

function environmentName(value: string): string {
  if (value.startsWith(BRANCH)) {
    if (branchEnvironment(value.slice(BRANCH.length)) !== value)
      throw new Invalid(
        `A branch's environment is branch/<name>: lowercase letters, digits, '.', '_' and '-' in '/'-separated parts that start and end with a letter or digit, ${MAX_BRANCH_ENVIRONMENT} characters at most.`,
      );
    return value;
  }
  if (!ENVIRONMENT.test(value))
    throw new Invalid(
      "An environment is a lowercase name such as production, timeline/<slug> or branch/<name>: letters, digits, '.', '_' and '-', with at most one '/' outside branch/<name>.",
    );
  if (value.startsWith("timeline/") && !timelineOfEnvironment(value))
    throw new Invalid("A timeline's environment is timeline/<slug>.");
  return value;
}

function timelineName(value: unknown): string | null | undefined {
  const text = optionalString(value, "timeline");
  // main is no timeline.
  if (!text || text === "main") return text && null;
  if (!TIMELINE_SLUG.test(text))
    throw new Invalid("A timeline slug is lowercase letters and digits joined by hyphens.");
  return text;
}

/** Where a new record goes: its environment and timeline, from what was given and the job. */
export function placement(
  given: { environment?: string | null; timeline?: string | null },
  job: Pick<JobCaller, "ref" | "defaultBranch"> | null,
): { environment: string; timeline: string | null } {
  const environment = given.environment ? environmentName(given.environment) : null;
  const fromEnvironment = environment ? timelineOfEnvironment(environment) : null;
  if (given.timeline) {
    if (environment && fromEnvironment !== given.timeline)
      throw new Invalid(
        `Timeline ${given.timeline} deploys to ${timelineEnvironment(given.timeline)}, not ${environment}.`,
      );
    return { environment: timelineEnvironment(given.timeline), timeline: given.timeline };
  }
  if (environment) return { environment, timeline: fromEnvironment };
  if (!job) return { environment: PRODUCTION, timeline: null };
  const fromBranch = timelineSlugOf(`refs/heads/${job.ref}`);
  if (fromBranch) return { environment: timelineEnvironment(fromBranch), timeline: fromBranch };
  if (job.ref === job.defaultBranch) return { environment: PRODUCTION, timeline: null };
  // Any other branch gets its own environment (CORE-138).
  const fromOther = branchEnvironment(job.ref);
  if (fromOther) return { environment: fromOther, timeline: null };
  throw new Invalid(
    `Branch ${job.ref} has no usable environment name (branch/<name>, ${MAX_BRANCH_ENVIRONMENT} characters at most); name the environment.`,
  );
}

/** The timeline in its account's tracker, when it exists there. */
async function timelineRecord(env: Env, ownerId: string, slug: string): Promise<Timeline | null> {
  try {
    const reply = await trackerObject(env, ownerId).timeline(slug, 0, 1);
    return reply.ok ? reply.value.timeline : null;
  } catch (error) {
    console.warn("Deployments: looking up a timeline failed", { slug, error });
    return null;
  }
}

export const deployments = new Hono<AppEnv>();

deployments.onError((error, c) => {
  if (error instanceof Invalid) return fail(c, error.status, error.message);
  throw error;
});

deployments.get("/deployments", async (c) => {
  const repo = await reader(c);
  if (repo instanceof Response) return repo;
  const q = (name: string) => c.req.query(name)?.trim() || undefined;
  const before = Number(q("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q("limit")) || PAGE));
  const kdb = db(c.env.DB);
  let query = selectDeployments(kdb).where("d.repo_id", "=", repo.id).where("d.id", "<", before);
  query = query.where("d.source_id", "=", c.req.query("source") ?? "canonical");
  const environment = q("environment");
  if (environment) query = query.where("d.environment", "=", environment);
  const timeline = q("timeline");
  if (timeline) query = query.where("d.timeline_slug", "=", timeline);
  const commits = q("commit")
    ?.split(",")
    .map((oid) => oid.trim().toLowerCase())
    .filter(Boolean);
  if (commits?.length) {
    if (commits.length > MAX_COMMITS || commits.some((oid) => !OID.test(oid)))
      return fail(c, 400, `commit takes up to ${MAX_COMMITS} full commit ids, comma-separated.`);
    query = query.where("d.commit_oid", "in", commits);
  }
  const run = q("run");
  if (run) {
    if (!/^\d+$/.test(run)) return fail(c, 400, "run is a run number.");
    query = query.where("r.number", "=", Number(run)).where("r.repo_id", "=", repo.id);
  }
  const wanted = q("status");
  if (wanted) query = query.where("d.status", "=", status(wanted)!);
  const rows = await query
    .orderBy("d.id", "desc")
    .limit(limit + 1)
    .execute();
  const list = rows.slice(0, limit).map(toDeployment);
  return c.json<DeploymentList>({
    deployments: list,
    next: rows.length > limit ? (list.at(-1)?.id ?? null) : null,
  });
});

deployments.post("/deployments", async (c) => {
  const who = await writer(c);
  if (who instanceof Response) return who;
  const data = await body(c, [
    "commit",
    "source",
    "url",
    "environment",
    "timeline",
    "checkpoint",
    "status",
    "expiresAt",
  ]);
  const job = who.kind === "job" ? who.job : null;
  const sourceId = job?.sourceId ?? optionalString(data.source, "source") ?? "canonical";
  if (job && data.source !== undefined && data.source !== job.sourceId)
    throw new Invalid("A job records only its exact source.");
  if (sourceId !== "canonical" || !who.repo.deleted_at)
    await resolveSource(c.env, who.repo, sourceId);
  const commit = optionalString(data.commit, "commit")?.toLowerCase() ?? job?.commit;
  if (!commit) throw new Invalid("Name the commit that was deployed (commit: a full commit id).");
  if (!OID.test(commit)) throw new Invalid("commit must be a full 40-character commit id.");
  const environment = optionalString(data.environment, "environment");
  const givenTimeline = timelineName(data.timeline);
  const where = placement(
    {
      environment,
      // A preview run names its timeline (CORE-79); otherwise the branch does.
      timeline: givenTimeline !== undefined || environment ? givenTimeline : job?.timelineSlug,
    },
    job,
  );
  const state = status(data.status) ?? "active";
  const address = url(data.url) ?? null;
  if (!address && state !== "failed")
    throw new Invalid("Give the deployment's url (only a failed deployment may have none).");
  const checkpoint = optionalString(data.checkpoint, "checkpoint") ?? job?.checkpointId ?? null;
  if (checkpoint && !CHECKPOINT.test(checkpoint))
    throw new Invalid("checkpoint is an id of up to 128 letters, digits and . _ : / -.");
  // A revival's run records a rebuilt preview of the same checkpoint.
  const revived = Boolean(job?.revived) && checkpoint === job?.checkpointId;
  const now = nowIso();
  const timeline = where.timeline
    ? await timelineRecord(c.env, who.repo.owner_id, where.timeline)
    : null;
  let expiresAt = expiry(data.expiresAt);
  const pinned = expiresAt !== undefined;
  // A timeline's preview follows the account's retention unless told
  // otherwise; the preview sweep (sweep.ts) moves it as work goes on.
  if (expiresAt === undefined && where.timeline && state !== "failed") {
    const settings = await previewSettings(c.env.DB, who.repo.owner_id);
    expiresAt = previewExpiry({ timeline, createdAt: now, revived }, settings);
  }
  const kdb = db(c.env.DB);
  const inserted = await kdb
    .insertInto("deployments")
    .values({
      repo_id: who.repo.id,
      source_id: sourceId,
      environment: where.environment,
      timeline_slug: where.timeline,
      timeline_id: timeline?.id ?? null,
      checkpoint_id: checkpoint,
      commit_oid: commit,
      url: address,
      status: state,
      run_id: job?.runId ?? null,
      job_id: job?.jobId ?? null,
      actor_id: job ? job.actorId : who.kind === "person" ? who.actorId : null,
      agent_id: job ? job.agentId : who.kind === "person" ? who.agentId : null,
      expires_at: expiresAt ?? null,
      expiry_pinned: pinned ? 1 : 0,
      revived: revived ? 1 : 0,
      rebuilt_from: revived ? (job?.rebuiltFrom ?? null) : null,
      created_at: now,
      updated_at: now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await findDeployment(kdb, who.repo.id, inserted.id);
  return c.json<Deployment>(toDeployment(row!), 201);
});

deployments.get("/deployments/:id{[0-9]+}", async (c) => {
  const repo = await reader(c);
  if (repo instanceof Response) return repo;
  const row = await findDeployment(db(c.env.DB), repo.id, Number(c.req.param("id")));
  return row ? c.json<Deployment>(toDeployment(row)) : fail(c, 404, "No such deployment.");
});

deployments.patch("/deployments/:id{[0-9]+}", async (c) => {
  const who = await writer(c);
  if (who instanceof Response) return who;
  const data = await body(c, ["status", "url", "expiresAt"]);
  const kdb = db(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await findDeployment(kdb, who.repo.id, id);
  if (!existing) return fail(c, 404, "No such deployment.");
  if (who.kind === "job" && existing.source_id !== who.job.sourceId)
    return fail(c, 403, "A job may update only its own source's deployments.");
  const changes: {
    status?: DeploymentStatus;
    url?: string | null;
    expires_at?: string | null;
    expiry_pinned?: number;
  } = {};
  const state = status(data.status);
  if (state) changes.status = state;
  const address = url(data.url);
  if (address !== undefined) changes.url = address;
  const expiresAt = expiry(data.expiresAt);
  // An expiry given by hand stays: retention no longer moves it.
  if (expiresAt !== undefined) Object.assign(changes, { expires_at: expiresAt, expiry_pinned: 1 });
  if (!Object.keys(changes).length) throw new Invalid("Change status, url or expiresAt.");
  const nextUrl = "url" in changes ? changes.url : existing.url;
  if (!nextUrl && (changes.status ?? existing.status) !== "failed")
    throw new Invalid("Only a failed deployment may have no url.");
  await kdb
    .updateTable("deployments")
    .set({ ...changes, updated_at: nowIso() })
    .where("id", "=", id)
    .where("repo_id", "=", who.repo.id)
    .execute();
  const row = await findDeployment(kdb, who.repo.id, id);
  return c.json<Deployment>(toDeployment(row!));
});

deployments.get("/environments", async (c) => {
  const repo = await reader(c);
  if (repo instanceof Response) return repo;
  const kdb = db(c.env.DB);
  const groups = await kdb
    .selectFrom("deployments")
    .select([
      "environment",
      (eb) => eb.fn.max("id").as("latest"),
      (eb) => eb.fn.countAll<number>().as("total"),
      sql<number>`sum(status IN ('active', 'sleeping'))`.as("live"),
    ])
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", c.req.query("source") ?? "canonical")
    .groupBy("environment")
    .orderBy("latest", "desc")
    .limit(MAX_ENVIRONMENTS)
    .execute();
  const latest = groups.length
    ? await selectDeployments(kdb)
        .where("d.repo_id", "=", repo.id)
        .where(
          "d.id",
          "in",
          groups.map((g) => g.latest),
        )
        .execute()
    : [];
  const byId = new Map(latest.map((row) => [row.id, toDeployment(row)]));
  const environments: Environment[] = groups.map((group) => ({
    name: group.environment,
    timeline: timelineOfEnvironment(group.environment),
    latest: byId.get(group.latest) ?? null,
    live: Number(group.live),
    total: Number(group.total),
  }));
  if (!environments.some((e) => e.name === PRODUCTION))
    environments.unshift({ name: PRODUCTION, timeline: null, latest: null, live: 0, total: 0 });
  return c.json<EnvironmentList>({ environments });
});
