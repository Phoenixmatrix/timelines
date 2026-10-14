// Deployment records, per repository under /api/repos/:space/:name:
//   GET    /deployments           newest first; filters: environment, timeline,
//                                 commit (one or a comma list), run (number),
//                                 status, version (provider version id);
//                                 pages with before= and limit=
//   POST   /deployments           record one (write access, or the repository's
//                                 CI job credential); a retry of a provider
//                                 deployment answers its first record
//   GET    /deployments/live-timelines
//                                 {timelines}: slugs with a live (active or
//                                 sleeping) record in ANY source at once
//                                 (CORE-372, below)
//   GET    /deployments/:id       one record
//   PATCH  /deployments/:id       {status?, url?, expiresAt?, exposedFrom?,
//                                 exposedUntil?, percentage?} (same access);
//                                 provider and artifact identity never
//                                 change (409)
//   GET    /environments          `production` and every environment recorded,
//                                 each with its newest deployment and, for a
//                                 canary, every live member of its split
//
// Environments: `production` (the default branch), `timeline/<slug>` (a
// timeline's previews), `branch/<name>` (any other branch a CI job deploys
// from) or a name of the recorder's own.
//
// Gitmatrix deploys nothing; jobs and outside systems record what they deployed. Records stay
// when a preview expires: only the status changes.
//
// Provenance (CORE-351): a record may name the provider version that ran and
// the registry publication it shipped. Both are checked, never inferred: a
// job attaching either records only its own commit, and a publication must be
// this repository's CI publish from the record's own source and commit (a
// sibling built from the same commit is not the deployed one). Exposure,
// share and replacement are the recorder's claims at deploy time; the
// provider's live history (CORE-352) is authoritative while it has them.

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
  type LiveTimelineList,
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
import { noteAgentPresence, readAgentPresence } from "../agent-presence.ts";
import {
  captureWorkAuthority,
  parseWorkAuthority,
  resolveWorkAuthority,
  WorkAuthorizationError,
  type WorkAuthority,
} from "../ci/admission.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import {
  normalizeDigest,
  OBSERVABILITY_PROVIDERS,
  ObservabilityError,
  providerId,
  validateExposure,
  validateReplaces,
  type ObservabilityProvider,
} from "../../shared/observability.ts";

/** Ids per `in` list, well under D1's 100 bound parameters. */
const IN_CHUNK = 50;

function chunks<T>(values: T[]): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) parts.push(values.slice(i, i + IN_CHUNK));
  return parts;
}

/** Fields a record's provenance is made of: given once, at record time. */
const IMMUTABLE = ["provider", "artifact", "commit", "deployedAt", "replaces"];
/** How far past now a recorded exposure may start (clock skew). */
const MAX_FUTURE_MS = 60 * 60 * 1000;
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
  repoId: row.repo_id,
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
  provider:
    row.provider && row.provider_service && row.provider_version_id && row.provider_deployment_id
      ? {
          name: row.provider,
          service: row.provider_service,
          versionId: row.provider_version_id,
          deploymentId: row.provider_deployment_id,
        }
      : null,
  artifact:
    row.artifact_publish_id &&
    row.artifact_package_id &&
    row.artifact_format &&
    row.artifact_name &&
    row.artifact_version
      ? {
          publishId: row.artifact_publish_id,
          packageId: row.artifact_package_id,
          format: row.artifact_format,
          name: row.artifact_name,
          version: row.artifact_version,
          digest: row.artifact_digest,
        }
      : null,
  deployedAt: row.deployed_at,
  exposedFrom: row.exposed_from,
  exposedUntil: row.exposed_until,
  percentage: row.percentage,
  replaces: row.replaces_version_id
    ? { versionId: row.replaces_version_id, deploymentId: row.replaces_deployment_id }
    : null,
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
  | {
      kind: "person";
      repo: RepoRow;
      actorId: string;
      agentId: string | null;
      authority: WorkAuthority;
    };

/**
 * Who may write this repository's deployments: a CI job of the repository
 * (its credential), or anyone with write access. Answers a Response otherwise.
 */
async function writer(c: Context<AppEnv>): Promise<Writer | Response> {
  const secret = jobSecret(c.req.header("authorization"));
  if (secret) {
    const job = await jobCaller(c.env, secret);
    if (!job) return fail(c, 401, "The CI job's credential is invalid, or the job has ended.");
    // A deletion's preview teardown job still reports (CORE-199).
    const repo = await findRepo(
      c.env.DB,
      null,
      c.req.param("space") ?? "",
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
  return {
    kind: "person",
    repo: repo.row,
    actorId: actor.id,
    agentId: actor.agent?.id ?? null,
    authority: await captureWorkAuthority(c.env, repo.row.id, actor),
  };
}

/**
 * The repository to read: a job reads its own, anyone else needs read access.
 * A job reads only its exact source: `sourceId` for a list, or null where the
 * caller checks each record (recordSource) or answers repository-wide slugs
 * only (live-timelines). Every caller says which.
 */
async function reader(c: Context<AppEnv>, sourceId: string | null): Promise<RepoRow | Response> {
  if (jobSecret(c.req.header("authorization"))) {
    const found = await writer(c);
    if (found instanceof Response) return found;
    if (found.kind === "job" && sourceId !== null && found.job.sourceId !== sourceId)
      return fail(c, 403, "A job must name its exact source when reading deployments.");
    return found.repo;
  }
  const repo = await loadRepo(c);
  return repo instanceof Response ? repo : repo.row;
}

/** A source query narrows a stable record id; job credentials never cross sources. */
async function recordSource(c: Context<AppEnv>, row: DeploymentRow): Promise<Response | null> {
  if (c.req.query("source") !== undefined && c.req.query("source") !== row.source_id)
    return fail(c, 404, "No such deployment.");
  const secret = jobSecret(c.req.header("authorization"));
  if (secret) {
    const job = await jobCaller(c.env, secret);
    if (!job || job.repoId !== row.repo_id || job.sourceId !== row.source_id)
      return fail(c, 403, "A job may read only its own source's deployments.");
  }
  return null;
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

/** Shared contract validation, answered as a 400. */
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ObservabilityError) throw new Invalid(error.message);
    throw error;
  }
}

function fields(value: unknown, name: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Invalid(`${name} must be an object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Invalid(`Unknown field: ${name}.${key}.`);
  return value as Record<string, unknown>;
}

interface ProviderIdentity {
  name: ObservabilityProvider;
  service: string;
  versionId: string;
  deploymentId: string;
}

/**
 * `provider`: what the provider deployed, by the immutable ids it assigned:
 * the version that ran and the deployment that put it out, both required, so
 * a canary's members and a rollback to an earlier version are records of
 * their own.
 */
function providerIdentity(value: unknown): ProviderIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  const given = fields(value, "provider", ["name", "service", "versionId", "deploymentId"]);
  if (!OBSERVABILITY_PROVIDERS.includes(given.name as ObservabilityProvider))
    throw new Invalid(`provider.name must be one of: ${OBSERVABILITY_PROVIDERS.join(", ")}.`);
  return checked(() => ({
    name: given.name as ObservabilityProvider,
    service: providerId(given.service, "provider.service"),
    versionId: providerId(given.versionId, "provider.versionId"),
    deploymentId: providerId(given.deploymentId, "provider.deploymentId"),
  }));
}

type ArtifactQuery =
  | { publishId: string; digest: string | null }
  | { packageId: string; version: string; digest: string | null };

/** `artifact`: a registry publication, by id or by package and version. */
function artifactQuery(value: unknown): ArtifactQuery | undefined {
  if (value === undefined || value === null) return undefined;
  const given = fields(value, "artifact", ["publishId", "packageId", "version", "digest"]);
  return checked(() => {
    const digest =
      given.digest === undefined || given.digest === null
        ? null
        : normalizeDigest(given.digest, "artifact.digest");
    if (given.publishId !== undefined) {
      if (given.packageId !== undefined || given.version !== undefined)
        throw new Invalid("Name the artifact by publishId, or by packageId and version, not both.");
      return { publishId: providerId(given.publishId, "artifact.publishId"), digest };
    }
    if (given.packageId === undefined || given.version === undefined)
      throw new Invalid("Name the artifact by publishId, or by packageId and version.");
    return {
      packageId: providerId(given.packageId, "artifact.packageId"),
      version: providerId(given.version, "artifact.version"),
      digest,
    };
  });
}

interface Publication {
  id: string;
  package_id: string;
  format: string;
  name: string;
  version: string;
  digest: string | null;
}

/**
 * The one registry publication an artifact names that this repository's CI
 * published from exactly this source and commit and that isn't deleted. A
 * publication from another repository, source or commit, a person's, one from
 * before publishes recorded their source, a deleted one or a digest that
 * differs all answer as no publication at all, the same as an unknown one.
 */
async function publication(
  env: Env,
  query: ArtifactQuery,
  at: { repoId: string; sourceId: string; commit: string },
): Promise<Publication> {
  const select = `SELECT u.id, u.package_id, u.format, p.name, u.version, u.digest
    FROM publishes u JOIN packages p ON p.id = u.package_id
    WHERE u.git_repo_id = ? AND u.source_id = ? AND u.commit_oid = ? AND u.status != 'deleted'`;
  const { results } =
    "publishId" in query
      ? await env.REGISTRY_DB.prepare(`${select} AND u.id = ?`)
          .bind(at.repoId, at.sourceId, at.commit, query.publishId)
          .all<Publication>()
      : await env.REGISTRY_DB.prepare(
          `${select} AND u.package_id = ? AND u.version = ? ORDER BY u.at DESC LIMIT 10`,
        )
          .bind(at.repoId, at.sourceId, at.commit, query.packageId, query.version)
          .all<Publication>();
  // A catalog format (npm and the like) records no digest for a publication:
  // a digest can't be checked against it, so it isn't accepted as one.
  if (query.digest !== null && results.length && results.every((row) => row.digest === null))
    throw new Invalid("This publication records no digest; omit the artifact's digest.");
  const matches = results.filter((row) => query.digest === null || row.digest === query.digest);
  if (!matches.length)
    throw new Invalid(
      "No publication from this repository's CI, at this source and commit, matches artifact.",
    );
  if (new Set(matches.map((row) => row.id)).size > 1)
    throw new Invalid(
      "Several publications from this commit match artifact; name it by publishId or digest.",
      409,
    );
  return matches[0]!;
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

/**
 * The timeline in its Space's tracker, when it exists there; a record for an
 * unknown slug stays unlinked. Timeline association never supplies Tracker
 * rights: anything but "not found" still refuses the record.
 */
async function timelineRecord(
  env: Env,
  authority: WorkAuthority,
  repoId: string,
  slug: string,
): Promise<Timeline | null> {
  await resolveWorkAuthority(env, authority, repoId);
  const space = await findSpaceById(env.DB, authority.spaceId);
  if (!space) throw new Invalid("Timeline Space is unavailable.", 403);
  const access = await accessFor(
    env,
    space,
    authority.personId,
    authority.agentId,
    false,
    authority.credential,
  );
  const reply = await trackerObject(env, space.id).timeline(access, slug, 0, 1);
  if (!reply.ok && reply.status === 404 && reply.code === "not_found") return null;
  if (!reply.ok) throw new Invalid(reply.error, reply.status === 404 ? 404 : 403);
  return reply.value.timeline;
}

export const deployments = new Hono<AppEnv>();

deployments.onError((error, c) => {
  if (error instanceof Invalid) return fail(c, error.status, error.message);
  if (error instanceof WorkAuthorizationError) return fail(c, 403, error.message);
  if (error.message === "migration_epoch_mismatch" || error.message === "space_cutover_fenced")
    return fail(c, 409, error.message);
  throw error;
});

deployments.get("/deployments", async (c) => {
  const sourceId = c.req.query("source") ?? "canonical";
  const repo = await reader(c, sourceId);
  if (repo instanceof Response) return repo;
  const q = (name: string) => c.req.query(name)?.trim() || undefined;
  const before = Number(q("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q("limit")) || PAGE));
  const kdb = db(c.env.DB);
  let query = selectDeployments(kdb).where("d.repo_id", "=", repo.id).where("d.id", "<", before);
  query = query.where("d.source_id", "=", sourceId);
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
  const version = q("version");
  // Provider versions are Cloudflare's for now; naming it uses the version index.
  if (version)
    query = query
      .where("d.provider", "=", "cloudflare")
      .where("d.provider_version_id", "=", version);
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

/**
 * Which timelines still have a live preview, in ANY source of the repository,
 * in one answer. Since CORE-255 a timeline's preview runs, and the records
 * they make, live in that timeline's own work source. GET /deployments reads
 * one source per request (`?source=`; a job's credential only its own), and
 * nothing here lists the sources, so a preview
 * janitor (tools/preview/preview.ts reconcile, CORE-372) couldn't otherwise
 * know every live timeline before it deletes what no live preview owns. This
 * answers slugs only, never URLs, commits, sources or any other field, to the
 * repository's own CI jobs and to its readers. Any environment counts: a
 * protective list errs towards live. It is also reconcile's kill switch:
 * anything but a 200 here, and reconcile deletes nothing.
 */
deployments.get("/deployments/live-timelines", async (c) => {
  // The one deliberate cross-source read: slugs only, for a preview teardown's
  // reconcile, which runs in the torn-down timeline's own work source.
  const repo = await reader(c, null);
  if (repo instanceof Response) return repo;
  const rows = await db(c.env.DB)
    .selectFrom("deployments")
    .select("timeline_slug")
    .distinct()
    .where("repo_id", "=", repo.id)
    .where("status", "in", ["active", "sleeping"])
    .where("timeline_slug", "is not", null)
    .orderBy("timeline_slug")
    .execute();
  return c.json<LiveTimelineList>({
    timelines: rows.flatMap((row) => (row.timeline_slug ? [row.timeline_slug] : [])),
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
    "provider",
    "artifact",
    "deployedAt",
    "exposedFrom",
    "exposedUntil",
    "percentage",
    "replaces",
  ]);
  const job = who.kind === "job" ? who.job : null;
  const authority = who.kind === "job" ? who.job.authority : who.authority;
  const sourceId = job?.sourceId ?? optionalString(data.source, "source") ?? "canonical";
  if (job && data.source !== undefined && data.source !== job.sourceId)
    throw new Invalid("A job records only its exact source.");
  if (sourceId !== "canonical" || !who.repo.deleted_at)
    await resolveSource(c.env, who.repo, sourceId);
  const commit = optionalString(data.commit, "commit")?.toLowerCase() ?? job?.commit;
  if (!commit) throw new Invalid("Name the commit that was deployed (commit: a full commit id).");
  if (!OID.test(commit)) throw new Invalid("commit must be a full 40-character commit id.");
  const provider = providerIdentity(data.provider);
  const artifact = artifactQuery(data.artifact);
  const exposure = checked(() => validateExposure(data));
  if (exposure.percentage !== null && !provider)
    throw new Invalid("percentage is a share of a provider deployment: give provider too.");
  if (data.replaces !== undefined && data.replaces !== null && !provider)
    throw new Invalid("replaces names a provider version: give provider too.");
  const replaces = provider
    ? checked(() => validateReplaces(data.replaces, provider.versionId))
    : null;
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
  const kdb = db(c.env.DB);
  // A job's identity claims stay with what it built: its own commit. It may
  // re-assert a version → commit mapping already recorded in this source and
  // environment (a canary's older member, a rollback to a known version),
  // never make a new one; an artifact is always its own commit's.
  if (job && artifact && commit !== job.commit)
    throw new Invalid("A job records an artifact only for its own commit.", 403);
  if (job && provider && commit !== job.commit) {
    const known = await kdb
      .selectFrom("deployments")
      .select("id")
      .where("repo_id", "=", who.repo.id)
      .where("source_id", "=", sourceId)
      .where("environment", "=", where.environment)
      .where("provider", "=", provider.name)
      .where("provider_service", "=", provider.service)
      .where("provider_version_id", "=", provider.versionId)
      .where("commit_oid", "=", commit)
      .limit(1)
      .executeTakeFirst();
    if (!known)
      throw new Invalid(
        "A job records a provider version for another commit only when that version is already recorded for it in this environment.",
        403,
      );
  }
  const state = status(data.status) ?? "active";
  const address = url(data.url) ?? null;
  if (!address && state !== "failed")
    throw new Invalid("Give the deployment's url (only a failed deployment may have none).");
  const checkpoint = optionalString(data.checkpoint, "checkpoint") ?? job?.checkpointId ?? null;
  if (checkpoint && !CHECKPOINT.test(checkpoint))
    throw new Invalid("checkpoint is an id of up to 128 letters, digits and . _ : / -.");
  const published = artifact
    ? await publication(c.env, artifact, { repoId: who.repo.id, sourceId, commit })
    : null;
  const givenExpiry = expiry(data.expiresAt);
  // A retried record of the same provider deployment answers the first one.
  const same = async () => {
    if (!provider) return null;
    const row = await selectDeployments(kdb)
      .where("d.repo_id", "=", who.repo.id)
      .where("d.source_id", "=", sourceId)
      .where("d.provider", "=", provider.name)
      .where("d.provider_service", "=", provider.service)
      .where("d.provider_version_id", "=", provider.versionId)
      .where("d.provider_deployment_id", "=", provider.deploymentId)
      .executeTakeFirst();
    if (!row) return null;
    // The record's identity, not the times a producer recomputes on each run
    // (deployedAt, exposure, expiresAt: `now`, `--expires 2d`) nor its
    // address or status, which PATCH owns: the first record stands unchanged.
    const differs =
      row.commit_oid !== commit ||
      row.environment !== where.environment ||
      row.artifact_publish_id !== (published?.id ?? null) ||
      row.percentage !== exposure.percentage ||
      row.replaces_version_id !== replaces;
    if (differs)
      throw new Invalid(
        `Provider deployment ${provider.deploymentId} of version ${provider.versionId} is already recorded as #${row.id}, differently.`,
        409,
      );
    return row;
  };
  const existing = await same();
  if (existing) return c.json<Deployment>(toDeployment(existing), 200);
  // A revival's run records a rebuilt preview of the same checkpoint.
  const revived = Boolean(job?.revived) && checkpoint === job?.checkpointId;
  const now = nowIso();
  const timeline = where.timeline
    ? await timelineRecord(c.env, authority, who.repo.id, where.timeline)
    : null;
  let expiresAt = givenExpiry;
  const pinned = expiresAt !== undefined;
  // A timeline's preview follows the account's retention unless told
  // otherwise; the preview sweep (sweep.ts) moves it as work goes on.
  if (expiresAt === undefined && where.timeline && state !== "failed") {
    const settings = await previewSettings(c.env.DB, who.repo.space_id);
    expiresAt = previewExpiry({ timeline, createdAt: now, revived }, settings);
  }
  // The replaced version's record, only in this source and environment.
  const replaced =
    provider && replaces
      ? await kdb
          .selectFrom("deployments")
          .select("id")
          .where("repo_id", "=", who.repo.id)
          .where("source_id", "=", sourceId)
          .where("environment", "=", where.environment)
          .where("provider", "=", provider.name)
          .where("provider_service", "=", provider.service)
          .where("provider_version_id", "=", replaces)
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst()
      : undefined;
  await resolveWorkAuthority(c.env, authority, who.repo.id);
  let inserted: { id: number };
  try {
    inserted = await kdb
      .insertInto("deployments")
      .values({
        repo_id: who.repo.id,
        authority: JSON.stringify(authority),
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
        provider: provider?.name ?? null,
        provider_service: provider?.service ?? null,
        provider_version_id: provider?.versionId ?? null,
        provider_deployment_id: provider?.deploymentId ?? null,
        deployed_at: exposure.deployedAt,
        exposed_from: exposure.exposedFrom,
        exposed_until: exposure.exposedUntil,
        percentage: exposure.percentage,
        replaces_version_id: replaces,
        replaces_deployment_id: replaced?.id ?? null,
        artifact_publish_id: published?.id ?? null,
        artifact_package_id: published?.package_id ?? null,
        artifact_format: published?.format ?? null,
        artifact_name: published?.name ?? null,
        artifact_version: published?.version ?? null,
        artifact_digest: published?.digest ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  } catch (error) {
    // A concurrent retry stored it first.
    if (!provider || !/UNIQUE constraint failed/.test(String(error))) throw error;
    const raced = await same();
    if (!raced) throw error;
    return c.json<Deployment>(toDeployment(raced), 200);
  }
  const row = await findDeployment(kdb, who.repo.id, inserted.id);
  noteAgentPresence(c, {
    kind: "deployment",
    scopeId: who.repo.id,
    resourceId: String(inserted.id),
    sourceId,
  });
  return c.json<Deployment>(toDeployment(row!), 201);
});

deployments.get("/deployments/:id{[0-9]+}", async (c) => {
  const repo = await reader(c, null);
  if (repo instanceof Response) return repo;
  const row = await findDeployment(db(c.env.DB), repo.id, Number(c.req.param("id")));
  if (!row) return fail(c, 404, "No such deployment.");
  const denied = await recordSource(c, row);
  if (denied) return denied;
  noteAgentPresence(c, {
    kind: "deployment",
    scopeId: repo.id,
    resourceId: String(row.id),
    sourceId: row.source_id,
  });
  return c.json<Deployment>(toDeployment(row));
});

deployments.get("/deployments/:id{[0-9]+}/presence", async (c) => {
  const repo = await reader(c, null);
  if (repo instanceof Response) return repo;
  const row = await findDeployment(db(c.env.DB), repo.id, Number(c.req.param("id")));
  if (!row) return fail(c, 404, "No such deployment.");
  const denied = await recordSource(c, row);
  if (denied) return denied;
  c.header("cache-control", "private, no-store");
  return c.json(
    await readAgentPresence(c.env.DB, {
      kind: "deployment",
      scopeId: repo.id,
      resourceId: String(row.id),
      sourceId: row.source_id,
    }),
  );
});

deployments.patch("/deployments/:id{[0-9]+}", async (c) => {
  const who = await writer(c);
  if (who instanceof Response) return who;
  const data = await body(c, [
    "status",
    "url",
    "expiresAt",
    "exposedFrom",
    "exposedUntil",
    "percentage",
    ...IMMUTABLE,
  ]);
  const kdb = db(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await findDeployment(kdb, who.repo.id, id);
  if (!existing) return fail(c, 404, "No such deployment.");
  if (c.req.query("source") !== undefined && c.req.query("source") !== existing.source_id)
    return fail(c, 404, "No such deployment.");
  if (who.kind === "job" && existing.source_id !== who.job.sourceId)
    return fail(c, 403, "A job may update only its own source's deployments.");
  for (const key of IMMUTABLE)
    if (key in data)
      throw new Invalid(
        `${key} never changes once recorded; record the new deployment instead.`,
        409,
      );
  const changes: {
    status?: DeploymentStatus;
    url?: string | null;
    expires_at?: string | null;
    expiry_pinned?: number;
    exposed_from?: string;
    exposed_until?: string;
    percentage?: number;
  } = {};
  const state = status(data.status);
  if (state) changes.status = state;
  const address = url(data.url);
  if (address !== undefined) changes.url = address;
  const expiresAt = expiry(data.expiresAt);
  // An expiry given by hand stays: retention no longer moves it.
  if (expiresAt !== undefined) Object.assign(changes, { expires_at: expiresAt, expiry_pinned: 1 });
  // When it started serving: set once while unknown, no earlier than the
  // deployment and not in the future. It may precede the record itself, which
  // a producer makes after deploying.
  let exposedFrom = existing.exposed_from;
  if (data.exposedFrom !== undefined) {
    const claim = checked(() =>
      validateExposure({
        deployedAt: existing.deployed_at,
        exposedFrom: data.exposedFrom ?? undefined,
      }),
    );
    if (claim.exposedFrom === null) throw new Invalid("exposedFrom is a UTC ISO time.");
    if (Date.parse(claim.exposedFrom) > Date.now() + MAX_FUTURE_MS)
      throw new Invalid("exposedFrom can't be in the future.");
    if (existing.exposed_from !== null && existing.exposed_from !== claim.exposedFrom)
      throw new Invalid(`Its exposure already started at ${existing.exposed_from}.`, 409);
    exposedFrom = changes.exposed_from = claim.exposedFrom;
  }
  // When it stopped serving: set once, after it started.
  if (data.exposedUntil !== undefined) {
    const { exposedUntil } = checked(() =>
      validateExposure({
        deployedAt: existing.deployed_at,
        exposedFrom,
        exposedUntil: data.exposedUntil ?? undefined,
      }),
    );
    if (exposedUntil === null) throw new Invalid("exposedUntil is a UTC ISO time.");
    if (existing.exposed_until !== null && existing.exposed_until !== exposedUntil)
      throw new Invalid(`Its exposure already ended at ${existing.exposed_until}.`, 409);
    changes.exposed_until = exposedUntil;
  }
  // A canary's share, only while none is recorded.
  if (data.percentage !== undefined) {
    if (!existing.provider_version_id)
      throw new Invalid("percentage is a share of a provider deployment, and none is recorded.");
    const { percentage } = checked(() => validateExposure({ percentage: data.percentage }));
    if (percentage === null) throw new Invalid("percentage is a number from 0 to 100.");
    if (existing.percentage !== null && existing.percentage !== percentage)
      throw new Invalid(`Its share is already recorded as ${existing.percentage}%.`, 409);
    changes.percentage = percentage;
  }
  if (!Object.keys(changes).length)
    throw new Invalid("Change status, url, expiresAt, exposedFrom, exposedUntil or percentage.");
  const nextUrl = "url" in changes ? changes.url : existing.url;
  if (!nextUrl && (changes.status ?? existing.status) !== "failed")
    throw new Invalid("Only a failed deployment may have no url.");
  await resolveWorkAuthority(
    c.env,
    who.kind === "job" ? who.job.authority : who.authority,
    who.repo.id,
  );
  // A record from before Spaces has no initiating authority, and none is
  // inferred from its history. A person with write access may take it over
  // with their own live authority, which the record keeps from then on.
  const adopted = existing.authority === null;
  if (adopted && (who.kind === "job" || who.agentId !== null))
    return fail(c, 403, "A deployment from before Spaces can be changed only by a person.");
  if (!adopted)
    await resolveWorkAuthority(c.env, parseWorkAuthority(existing.authority), who.repo.id);
  const [updated] = await kdb
    .updateTable("deployments")
    .set({
      ...changes,
      ...(adopted && who.kind === "person" ? { authority: JSON.stringify(who.authority) } : {}),
      updated_at: nowIso(),
    })
    .where("id", "=", id)
    .where("repo_id", "=", who.repo.id)
    .where((eb) =>
      adopted ? eb("authority", "is", null) : eb("authority", "=", existing.authority),
    )
    .execute();
  if (!updated?.numUpdatedRows) return fail(c, 409, "The deployment changed; try again.");
  const row = await findDeployment(kdb, who.repo.id, id);
  noteAgentPresence(c, {
    kind: "deployment",
    scopeId: who.repo.id,
    resourceId: String(id),
    sourceId: existing.source_id,
  });
  return c.json<Deployment>(toDeployment(row!));
});

deployments.get("/environments", async (c) => {
  const sourceId = c.req.query("source") ?? "canonical";
  const repo = await reader(c, sourceId);
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
    .where("source_id", "=", sourceId)
    .groupBy("environment")
    .orderBy("latest", "desc")
    .limit(MAX_ENVIRONMENTS)
    .execute();
  const latest: DeploymentRow[] = [];
  for (const part of chunks(groups.map((g) => g.latest)))
    latest.push(
      ...(await selectDeployments(kdb)
        .where("d.repo_id", "=", repo.id)
        .where("d.id", "in", part)
        .execute()),
    );
  const byId = new Map(latest.map((row) => [row.id, toDeployment(row)]));
  // A canary: the newest record's provider deployment split traffic between
  // versions, each recorded on its own; list every live member, not just one.
  const splitKey = (d: { environment: string; provider: unknown; service: unknown; id: unknown }) =>
    JSON.stringify([d.environment, d.provider, d.service, d.id]);
  const providerDeployments = [
    ...new Set(
      latest.flatMap((row) => (row.provider_deployment_id ? [row.provider_deployment_id] : [])),
    ),
  ];
  const members = new Map<string, Deployment[]>();
  for (const part of chunks(providerDeployments))
    for (const row of await selectDeployments(kdb)
      .where("d.repo_id", "=", repo.id)
      .where("d.source_id", "=", sourceId)
      .where("d.provider_deployment_id", "in", part)
      .where("d.status", "in", ["active", "sleeping"])
      .orderBy("d.id", "desc")
      .limit(MAX_ENVIRONMENTS)
      .execute()) {
      const key = splitKey({
        environment: row.environment,
        provider: row.provider,
        service: row.provider_service,
        id: row.provider_deployment_id,
      });
      members.set(key, [...(members.get(key) ?? []), toDeployment(row)]);
    }
  const environments: Environment[] = groups.map((group) => {
    const newest = byId.get(group.latest) ?? null;
    const split = newest?.provider?.deploymentId
      ? (members.get(
          splitKey({
            environment: newest.environment,
            provider: newest.provider.name,
            service: newest.provider.service,
            id: newest.provider.deploymentId,
          }),
        ) ?? [])
      : [];
    return {
      name: group.environment,
      timeline: timelineOfEnvironment(group.environment),
      latest: newest,
      split: split.length > 1 ? split : [],
      live: Number(group.live),
      total: Number(group.total),
    };
  });
  if (!environments.some((e) => e.name === PRODUCTION))
    environments.unshift({
      name: PRODUCTION,
      timeline: null,
      latest: null,
      split: [],
      live: 0,
      total: 0,
    });
  return c.json<EnvironmentList>({ environments });
});
