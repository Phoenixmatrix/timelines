import { selectRepos } from "../db.ts";
import { db } from "../schema.ts";
import { getWorkSource, resolveSource } from "../timelines/sources.ts";
import { parseWorkAuthority, resolveWorkAuthority } from "./admission.ts";

type TeardownClaim = { runId: string } | { deploymentId: number; commit: string };

/** A tombstone permits only the exact admitted deployment's cleanup reader. */
export async function ciSource(
  env: Env,
  repoId: string,
  sourceId = "canonical",
  claim?: TeardownClaim,
) {
  const repo = await selectRepos(env.DB, "", { deleting: Boolean(claim) })
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  if (!repo) throw new Error("Repository is unavailable.");
  if (!repo.deleted_at) return (await resolveSource(env, repo, sourceId)).repo;
  if (!claim) throw new Error("Repository is unavailable.");
  let parent = db(env.DB)
    .selectFrom("deployments as d")
    .select(["d.id", "d.authority"])
    .where("d.repo_id", "=", repoId)
    .where("d.source_id", "=", sourceId)
    .where("d.status", "=", "expired")
    .where("d.teardown_completed_at", "is", null)
    .where("d.teardown_unmanaged_at", "is", null);
  if ("runId" in claim) {
    parent = parent.where("d.teardown_run_id", "=", claim.runId).where((eb) =>
      eb.exists(
        eb
          .selectFrom("ci_runs as c")
          .select("c.id")
          .where("c.id", "=", claim.runId)
          .where("c.preview_action", "=", "teardown")
          .where("c.status", "in", ["queued", "running"])
          .whereRef("c.repo_id", "=", "d.repo_id")
          .whereRef("c.source_id", "=", "d.source_id")
          .whereRef("c.commit_oid", "=", "d.commit_oid")
          .where((eb) =>
            eb.or([
              eb("c.preview_teardown_of", "is", null),
              eb("c.preview_teardown_of", "=", eb.ref("d.id")),
            ]),
          ),
      ),
    );
  } else {
    parent = parent
      .where("d.id", "=", claim.deploymentId)
      .where("d.commit_oid", "=", claim.commit)
      .where("d.teardown_run_id", "is", null);
  }
  const admitted = await parent.execute();
  if (admitted.length === 0) throw new Error("No exact admitted teardown source claim.");
  for (const deployment of admitted)
    await resolveWorkAuthority(env, parseWorkAuthority(deployment.authority), repoId);
  if (sourceId === "canonical") return { ...repo, source_id: sourceId };
  const source = await getWorkSource(env, repoId, sourceId);
  const root = await db(env.DB)
    .selectFrom("timeline_source_roots")
    .select("source_id")
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("consumer_kind", "=", "deployment")
    .where(
      "consumer_id",
      "in",
      admitted.map((deployment) => String(deployment.id)),
    )
    .execute();
  if (
    root.length !== admitted.length ||
    !source?.artifacts_remote ||
    !source.initial_token_revoked ||
    !["ready", "archived"].includes(source.state)
  )
    throw new Error("Teardown source is unavailable.");
  return {
    ...repo,
    source_id: sourceId,
    artifacts_name: source.artifacts_name,
    artifacts_remote: source.artifacts_remote,
    default_branch: source.work_ref.replace(/^refs\/heads\//, ""),
  };
}
