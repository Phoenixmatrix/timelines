// A CI job's credential (gmj_…, worker/ci/registry.ts) on the JSON API. The
// API otherwise takes only personal and agent tokens; a job may record and
// update its own repository's deployments (`gm deploy record` in CI), as the
// run: its commit and branch, and the person and agent who started it. It also
// uploads the step artifacts (screenshots, diagrams) its run produced (CORE-383).

import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { hashToken } from "../auth.ts";
import { db, nowIso } from "../schema.ts";
import { resolveJobAuthority, type WorkAuthority } from "../ci/admission.ts";

export const JOB_TOKEN_PREFIX = "gmj_";

/**
 * API paths a job's credential may call: its repository's deployments and
 * environments, and its step artifact uploads (no other steps route).
 * (A landing's merge job also uses it for git: git/http.ts.)
 */
const JOB_PATHS =
  /^\/api\/repos\/[^/]+\/[^/]+\/(?:(?:deployments|environments)(?:\/|$)|steps\/artifacts\/)/;

export interface JobCaller {
  authority: WorkAuthority;
  jobId: string;
  jobName: string;
  runId: string;
  runNumber: number;
  repoId: string;
  sourceId: string;
  commit: string;
  /** The run's branch, without refs/heads/. */
  ref: string;
  defaultBranch: string;
  /** Who pushed or started the run, and the agent that did it for them. */
  actorId: string | null;
  agentId: string | null;
  /** A preview run's timeline (slug) and checkpoint (CORE-79). */
  timelineSlug: string | null;
  checkpointId: string | null;
  /** A preview revival: what it records is rebuilt (1), standing in for that record. */
  revived: number;
  rebuiltFrom: number | null;
}

/** The bearer secret, when it is a CI job's credential. */
export function jobSecret(header: string | undefined): string | null {
  const [scheme, value] = (header ?? "").split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !value?.startsWith(JOB_TOKEN_PREFIX)) return null;
  return value;
}

/** Whether the API should let this request's job credential through to the route. */
export function jobRoute(c: Context<AppEnv>): boolean {
  return jobSecret(c.req.header("authorization")) !== null && JOB_PATHS.test(c.req.path);
}

/** The job behind a credential, while the job runs; null for anything else. */
export async function jobCaller(env: Env, secret: string): Promise<JobCaller | null> {
  const row = await db(env.DB)
    .selectFrom("ci_job_tokens as t")
    .innerJoin("ci_jobs as j", "j.id", "t.job_id")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .select([
      "j.id as jobId",
      "j.name as jobName",
      "r.id as runId",
      "r.number as runNumber",
      "r.commit_oid as commit",
      "r.source_id as sourceId",
      "r.ref",
      "r.actor_id as actorId",
      "r.agent_id as agentId",
      "r.timeline_slug as timelineSlug",
      "r.checkpoint_id as checkpointId",
      "r.preview_revived as revived",
      "r.preview_rebuilt_from as rebuiltFrom",
      "p.id as repoId",
      "p.default_branch as defaultBranch",
    ])
    .where("t.token_hash", "=", await hashToken(secret))
    .where("t.expires_at", ">", nowIso())
    .where("j.status", "in", ["queued", "running"])
    .where("r.status", "in", ["queued", "running"])
    .whereRef("j.source_id", "=", "r.source_id")
    .executeTakeFirst();
  if (!row) return null;
  try {
    const { authority } = await resolveJobAuthority(env, row.jobId);
    return { ...row, authority };
  } catch {
    return null;
  }
}
