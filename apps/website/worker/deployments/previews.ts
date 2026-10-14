// The preview contract's runs (CORE-79). Gitmatrix deploys nothing: it starts CI runs with
// trigger "preview" in repositories whose ci.yml opts in with `on: preview`,
// and their jobs pick an action with `if: trigger == "preview" && action ==
// "create"` (or "teardown"):
//
// - `create` for each new checkpoint, per repository, at its commit;
// - `teardown` when a timeline's previews expire (sweep.ts);
// - `create` again when someone revives a checkpoint's preview: what that run
//   records is marked rebuilt, not the original.
//
// Jobs get GITMATRIX_TIMELINE, GITMATRIX_CHECKPOINT, GITMATRIX_COMMIT and
// GITMATRIX_PREVIEW_ACTION (worker/ci/jobs.ts), and report what they deployed
// with `gm deploy record`, which fills in the checkpoint from the run.
//
// A checkpoint's run names the branch it was measured from: its source's ref
// (`work` in the timeline's own repository since CORE-255, which outlives
// landing and abandonment) or, for a canonical repository, the timeline's
// bookmark. Revivals and teardowns look the branch up (previewBranch): `work`
// for a timeline source; for a canonical repository the bookmark while it
// exists, otherwise the default branch, and the runners fetch the commit by id.

import type { Checkpoint, Timeline } from "../../shared/timelines.ts";
import { timelineBookmark } from "../../shared/timelines.ts";
import { listRefs } from "../artifacts.ts";
import type { Actor } from "../db.ts";
import { db } from "../schema.ts";
import { startRun, type CiRepo, type PreviewRun } from "../ci/trigger.ts";
import { captureWorkAuthority, resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";

type Waiter = (work: Promise<unknown>) => void;

/** One repository's preview run: started (its number), or why not. */
export type PreviewRunResult =
  | { repoId: string; number: number; runId: string }
  | { repoId: string; skipped: string; teardownUnmanaged?: boolean };

/** A repository to start a preview run in, with its default branch. */
export type PreviewRepo = CiRepo & { default_branch: string };

export interface PreviewTarget {
  repo: PreviewRepo;
  commit: string;
  preview: PreviewRun;
  authority?: WorkAuthority;
  /** The branch to run on, when known; otherwise looked up (previewBranch). */
  branch?: string;
}

/**
 * The branch a preview run checks out from: the timeline's bookmark while it
 * exists, else the default branch (the commit is then fetched by id).
 */
export async function previewBranch(env: Env, repo: PreviewRepo, slug: string): Promise<string> {
  if (repo.source_id && repo.source_id !== "canonical") return "work";
  const bookmark = timelineBookmark(slug);
  try {
    const refs = await listRefs(env, repo.artifacts_name, repo.artifacts_remote);
    if (refs.branches.some((branch) => branch.shortName === bookmark)) return bookmark;
    return refs.headBranch ?? repo.default_branch;
  } catch (error) {
    console.warn("Previews: listing branches failed", { repo: repo.id, error });
    return bookmark;
  }
}

/** Start each repository's preview run; a failure comes back as a reason, not an error. */
export async function startPreviewRuns(
  env: Env,
  targets: PreviewTarget[],
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
  waitUntil: Waiter,
): Promise<PreviewRunResult[]> {
  return Promise.all(
    targets.map(
      async ({ repo, commit, preview, branch, authority: saved }): Promise<PreviewRunResult> => {
        try {
          const authority = saved ?? (await captureWorkAuthority(env, repo.id, actor));
          const current = await resolveWorkAuthority(env, authority, repo.id);
          const started = await startRun(env, repo, {
            branch: branch ?? (await previewBranch(env, repo, preview.timeline)),
            commit,
            trigger: "preview",
            preview,
            actor: current.actor,
            authority,
            waitUntil,
          });
          return "skipped" in started
            ? {
                repoId: repo.id,
                skipped: started.skipped,
                teardownUnmanaged: started.teardownUnmanaged,
              }
            : { repoId: repo.id, number: started.number, runId: started.runId };
        } catch (error) {
          console.error("Previews: could not start a run", { repo: repo.id, preview, error });
          return {
            repoId: repo.id,
            skipped: `The run could not be started: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    ),
  );
}

async function ciRepos(d1: D1Database, ids: string[]): Promise<Map<string, PreviewRepo>> {
  if (!ids.length) return new Map();
  const rows = await db(d1)
    .selectFrom("repos")
    .select(["id", "artifacts_name", "artifacts_remote", "default_branch"])
    .where("id", "in", ids)
    // A repository being deleted tears its previews down instead (CORE-199).
    .where("deleted_at", "is", null)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

/** A new checkpoint: a `create` run in each of its repositories that opts in. */
export async function previewCheckpoint(
  env: Env,
  checkpoint: Checkpoint,
  timeline: Pick<Timeline, "slug">,
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
  waitUntil: Waiter,
  authority: WorkAuthority,
): Promise<PreviewRunResult[]> {
  const repos = await ciRepos(
    env.DB,
    checkpoint.repos.map((repo) => repo.id),
  );
  return startPreviewRuns(
    env,
    checkpoint.repos.flatMap((repo): PreviewTarget[] => {
      const row = repos.get(repo.id);
      return row
        ? [
            {
              repo: { ...row, source_id: repo.source?.sourceId ?? "canonical" },
              authority,
              commit: repo.commit,
              // Just measured from it.
              branch:
                repo.source?.ref.replace(/^refs\/heads\//, "") ?? timelineBookmark(timeline.slug),
              preview: { action: "create", timeline: timeline.slug, checkpoint: checkpoint.id },
            },
          ]
        : [];
    }),
    actor,
    waitUntil,
  );
}

/**
 * The newest record of a checkpoint's preview in each repository: by its id,
 * or (recorded before checkpoints were named) by its commit in the timeline.
 */
export async function checkpointRecords(
  d1: D1Database,
  checkpoint: Checkpoint,
): Promise<Map<string, number>> {
  const ids = checkpoint.repos.map((repo) => repo.id);
  if (!ids.length) return new Map();
  const rows = await db(d1)
    .selectFrom("deployments")
    .select(["id", "repo_id", "source_id", "commit_oid", "checkpoint_id"])
    .where("repo_id", "in", ids)
    .where((eb) =>
      eb.or([
        eb("checkpoint_id", "=", checkpoint.id),
        eb.and([
          eb("timeline_id", "=", checkpoint.timelineId),
          eb("checkpoint_id", "is", null),
          eb(
            "commit_oid",
            "in",
            checkpoint.repos.map((repo) => repo.commit),
          ),
        ]),
      ]),
    )
    .orderBy("id", "desc")
    .execute();
  const newest = new Map<string, number>();
  for (const row of rows) {
    const repo = checkpoint.repos.find((r) => r.id === row.repo_id);
    if (
      !repo ||
      row.source_id !== (repo.source?.sourceId ?? "canonical") ||
      (row.checkpoint_id === null && row.commit_oid !== repo.commit)
    )
      continue;
    if (!newest.has(row.repo_id)) newest.set(row.repo_id, row.id);
  }
  return newest;
}

/**
 * Revive a checkpoint's preview, for example to look into last week's work:
 * a `create` run per repository at the checkpoint's commit, whatever became
 * of the timeline since. What it records is marked rebuilt from the earlier
 * record. The caller checks the actor may write to every repository.
 */
export async function reviveCheckpoint(
  env: Env,
  checkpoint: Checkpoint,
  timeline: Pick<Timeline, "slug">,
  actor: Pick<Actor, "id" | "agent" | "credential">,
  waitUntil: Waiter,
  authority: WorkAuthority,
): Promise<PreviewRunResult[]> {
  const [repos, records] = await Promise.all([
    ciRepos(
      env.DB,
      checkpoint.repos.map((repo) => repo.id),
    ),
    checkpointRecords(env.DB, checkpoint),
  ]);
  return startPreviewRuns(
    env,
    checkpoint.repos.flatMap((repo): PreviewTarget[] => {
      const row = repos.get(repo.id);
      return row
        ? [
            {
              repo: { ...row, source_id: repo.source?.sourceId ?? "canonical" },
              authority,
              commit: repo.commit,
              preview: {
                action: "create",
                timeline: timeline.slug,
                checkpoint: checkpoint.id,
                revived: true,
                rebuiltFrom: records.get(repo.id) ?? null,
              },
            },
          ]
        : [];
    }),
    actor,
    waitUntil,
  );
}
