import type { WorkAuthority } from "../../shared/ci.ts";
import { isActorCredentialLive } from "../auth.ts";
import { findUserById, roleFor, selectRepos, type Actor } from "../db.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";

export type { WorkAuthority } from "../../shared/ci.ts";

export class WorkAuthorizationError extends Error {
  override name = "WorkAuthorizationError";
  readonly status = 403;
  readonly code = "work_authorization_revoked";
}

function assertWorkAuthority(binding: unknown): asserts binding is WorkAuthority {
  if (!binding || typeof binding !== "object")
    throw new WorkAuthorizationError("Work authority requires reconciliation.");
  const b = binding as Partial<WorkAuthority>;
  if (
    typeof b.spaceId !== "string" ||
    !b.spaceId ||
    !Number.isSafeInteger(b.migrationEpoch) ||
    b.migrationEpoch! < 0 ||
    typeof b.personId !== "string" ||
    !b.personId ||
    !(b.agentId === null || typeof b.agentId === "string") ||
    !b.credential ||
    !["token", "session"].includes(b.credential.kind) ||
    typeof b.credential.id !== "string" ||
    !b.credential.id
  )
    throw new WorkAuthorizationError("Work authority requires reconciliation.");
}

export function parseWorkAuthority(value: string | null): WorkAuthority {
  let binding: unknown;
  try {
    binding = value === null ? null : JSON.parse(value);
  } catch {
    throw new WorkAuthorizationError("Work authority requires reconciliation.");
  }
  assertWorkAuthority(binding);
  return binding;
}

/** Re-resolve identity and resource rights; a saved binding grants nothing. */
export async function resolveWorkAuthority(env: Env, authority: WorkAuthority, repoId: string) {
  assertWorkAuthority(authority);
  const admission = await cutoverControl(env).admission(4);
  if (!admission.allowed) throw new Error("space_cutover_fenced");
  if (admission.epoch !== authority.migrationEpoch) throw new Error("migration_epoch_mismatch");
  const person = await findUserById(env.DB, authority.personId);
  if (!person) throw new WorkAuthorizationError("Work initiator is unavailable.");
  const actor: Actor = { ...person, credential: authority.credential };
  if (authority.agentId !== null) {
    const agent = await db(env.DB)
      .selectFrom("agents")
      .select(["id", "name"])
      .where("id", "=", authority.agentId)
      .where("accountable_id", "=", person.id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!agent) throw new WorkAuthorizationError("Work initiator is revoked.");
    actor.agent = agent;
  }
  if (!(await isActorCredentialLive(env.DB, actor, "write")))
    throw new WorkAuthorizationError("Work initiating credential is revoked or expired.");
  const repo = await selectRepos(env.DB, actor.id, { deleting: true })
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  if (!repo || repo.space_id !== authority.spaceId || !atLeast(roleFor(repo, actor), "write"))
    throw new WorkAuthorizationError("Work source authorization is unavailable.");
  return { actor, repo };
}

export async function captureWorkAuthority(
  env: Env,
  repoId: string,
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
): Promise<WorkAuthority> {
  if (!actor?.credential)
    throw new WorkAuthorizationError("An initiating credential is required for content work.");
  const admission = await cutoverControl(env).admission(4);
  if (!admission.allowed) throw new Error("space_cutover_fenced");
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("space_id")
    .where("id", "=", repoId)
    .executeTakeFirst();
  if (!repo?.space_id) throw new WorkAuthorizationError("Work Space requires reconciliation.");
  const authority: WorkAuthority = {
    spaceId: repo.space_id,
    migrationEpoch: admission.epoch,
    personId: actor.id,
    agentId: actor.agent?.id ?? null,
    credential: actor.credential,
  };
  await resolveWorkAuthority(env, authority, repoId);
  return authority;
}

export async function resolveRunAuthority(env: Env, runId: string) {
  const run = await db(env.DB)
    .selectFrom("ci_runs")
    .select([
      "repo_id",
      "source_id",
      "space_id",
      "migration_epoch",
      "authority",
      "actor_id",
      "agent_id",
    ])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) throw new WorkAuthorizationError("Run is unavailable.");
  const authority = parseWorkAuthority(run.authority);
  if (
    run.space_id !== authority.spaceId ||
    run.migration_epoch !== authority.migrationEpoch ||
    run.actor_id !== authority.personId ||
    run.agent_id !== authority.agentId
  )
    throw new WorkAuthorizationError("Run authority does not match its immutable binding.");
  const current = await resolveWorkAuthority(env, authority, run.repo_id);
  const teardowns = await db(env.DB)
    .selectFrom("deployments")
    .select(["repo_id", "source_id", "authority"])
    .where("teardown_run_id", "=", runId)
    .where("teardown_completed_at", "is", null)
    .execute();
  for (const deployment of teardowns) {
    if (deployment.repo_id !== run.repo_id || deployment.source_id !== run.source_id)
      throw new WorkAuthorizationError("Teardown source binding does not match its run.");
    await resolveWorkAuthority(env, parseWorkAuthority(deployment.authority), deployment.repo_id);
  }
  return { authority, ...current };
}

export async function resolveJobAuthority(env: Env, jobId: string) {
  const job = await db(env.DB)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select([
      "j.run_id",
      "j.repo_id",
      "j.source_id",
      "r.repo_id as run_repo_id",
      "r.source_id as run_source_id",
    ])
    .where("j.id", "=", jobId)
    .executeTakeFirst();
  if (!job || job.repo_id !== job.run_repo_id || job.source_id !== job.run_source_id)
    throw new WorkAuthorizationError("Job source binding is unavailable.");
  return resolveRunAuthority(env, job.run_id);
}
