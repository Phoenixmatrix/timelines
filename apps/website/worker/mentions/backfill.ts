// Durable, scoped mention backfill. Authenticated producers persist their real
// WorkAuthority; the hourly sweep revalidates it before reading any history.
// Unattributed legacy work and failed/revoked jobs remain explicitly blocked.

import { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import { Timing } from "../timing.ts";
import { indexMentions, trackerLookup, type IssueLookup, type MentionCommit } from "./index.ts";
import { captureWorkAuthority, parseWorkAuthority, resolveWorkAuthority } from "../ci/admission.ts";
import type { Actor } from "../db.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";

/** Resume incomplete history without requiring another push. */
export async function resumeMentionBackfill(
  env: Env,
  repoId: string,
  actor: Pick<Actor, "id" | "agent" | "credential">,
): Promise<void> {
  const authority = await captureWorkAuthority(env, repoId, actor);
  const current = await resolveWorkAuthority(env, authority, repoId);
  if (
    current.repo.deleted_at ||
    !(await resolveSpaceAccess(env.DB, current.actor, authority.spaceId))
  )
    throw new Error("mention_space_access_required");
  const k = db(env.DB);
  const completed = await k
    .selectFrom("commit_mention_backfills")
    .select("repo_id")
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  if (completed) return;
  await k
    .insertInto("mention_backfill_jobs")
    .values({
      repo_id: repoId,
      authority: JSON.stringify(authority),
      state: "pending",
      error: null,
    })
    .onConflict((oc) =>
      oc.column("repo_id").doUpdateSet({
        authority: JSON.stringify(authority),
        state: "pending",
        error: null,
      }),
    )
    .execute();
}

export const BACKFILL_LIMITS = {
  /** Repositories read per run. */
  repos: 20,
  /** Recent commits read per repository. */
  commits: 200,
};

export interface BackfillRepo {
  id: string;
  artifacts_name: string;
  artifacts_remote: string;
}

/** A repository's most recent commits, newest first; [] when it has none. */
export type HistoryReader = (repo: BackfillRepo, limit: number) => Promise<MentionCommit[]>;

/** The default branch's first-parent history, through the Artifacts binding. */
export function artifactsHistory(
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
): HistoryReader {
  return async (repo, limit) => {
    const reader = new RepoReader(
      env,
      repo.artifacts_name,
      repo.artifacts_remote,
      new Timing(),
      waitUntil,
    );
    try {
      const head = (await reader.refs()).head;
      if (!head) return [];
      const commits = await reader.log(head, limit, 0);
      return commits.map((commit) => ({
        oid: commit.hash,
        changeId: null,
        message: commit.message,
        committedAt: commit.committedAt,
        ref: null,
      }));
    } finally {
      await reader.close();
    }
  };
}

export interface BackfillResult {
  repos: number;
  linked: number;
  ambiguous: number;
  failed: number;
}

/** Consume bounded pending work; failures remain blocked until explicitly resumed. */
export async function backfillMentions(
  env: Env,
  read: HistoryReader,
  lookup?: IssueLookup,
  limits = BACKFILL_LIMITS,
): Promise<BackfillResult> {
  const k = db(env.DB);
  const repos = await k
    .selectFrom("mention_backfill_jobs as j")
    .innerJoin("repos as r", "r.id", "j.repo_id")
    .select(["r.id", "r.artifacts_name", "r.artifacts_remote", "j.authority"])
    .where("j.state", "=", "pending")
    .where("j.authority", "is not", null)
    .where("r.deleted_at", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("commit_mention_backfills as b")
            .select("b.repo_id")
            .whereRef("b.repo_id", "=", "r.id"),
        ),
      ),
    )
    .orderBy("r.pushed_at", "desc")
    .limit(limits.repos)
    .execute();
  const result: BackfillResult = { repos: 0, linked: 0, ambiguous: 0, failed: 0 };
  for (const repo of repos) {
    let commits = 0;
    let note: string | null = null;
    try {
      const authority = parseWorkAuthority(repo.authority);
      const current = await resolveWorkAuthority(env, authority, repo.id);
      if (!(await resolveSpaceAccess(env.DB, current.actor, authority.spaceId)))
        throw new Error("mention_space_access_required");
      const history = await read(repo, limits.commits);
      commits = history.length;
      const refreshed = await resolveWorkAuthority(env, authority, repo.id);
      if (!(await resolveSpaceAccess(env.DB, refreshed.actor, authority.spaceId)))
        throw new Error("mention_space_access_required");
      const indexed = await indexMentions(
        env.DB,
        repo.id,
        history,
        lookup ?? trackerLookup(env, repo.id, authority),
      );
      result.linked += indexed.linked;
      result.ambiguous += indexed.ambiguous;
    } catch (error) {
      // Do not mark failed or revoked work completed; preserve its explicit state.
      result.failed++;
      note = error instanceof Error ? error.message.slice(0, 500) : "read failed";
      console.error("Mentions: backfilling a repository failed", { repo: repo.id, error });
    }
    if (note === null) {
      await k
        .insertInto("commit_mention_backfills")
        .values({ repo_id: repo.id, commits, note: null })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await k
        .deleteFrom("mention_backfill_jobs")
        .where("repo_id", "=", repo.id)
        .where("authority", "=", repo.authority)
        .execute();
    } else {
      await k
        .updateTable("mention_backfill_jobs")
        .set({ state: "blocked", error: note })
        .where("repo_id", "=", repo.id)
        .where("authority", "=", repo.authority)
        .execute();
    }
    result.repos++;
  }
  return result;
}
