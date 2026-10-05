// The mention index's backfill (CORE-22): pushes index what they make
// reachable, so only history pushed before the index existed is missing.
// The hourly sweep reads, for a few repositories at a time, the most recent
// commits on the default branch's first-parent line and indexes them, then
// marks the repository done (commit_mention_backfills). Bounded per run and
// per repository; a repository is read once, whether or not it had anything.

import { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import { Timing } from "../timing.ts";
import { indexMentions, trackerLookup, type IssueLookup, type MentionCommit } from "./index.ts";

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

/** Index recent history for repositories not yet backfilled, most recently pushed first. */
export async function backfillMentions(
  env: Env,
  read: HistoryReader,
  lookup: IssueLookup = trackerLookup(env),
  limits = BACKFILL_LIMITS,
): Promise<BackfillResult> {
  const k = db(env.DB);
  const repos = await k
    .selectFrom("repos as r")
    .select(["r.id", "r.artifacts_name", "r.artifacts_remote"])
    .where("r.deleted_at", "is", null)
    .where("r.pushed_at", "is not", null)
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
      const history = await read(repo, limits.commits);
      commits = history.length;
      const indexed = await indexMentions(env.DB, repo.id, history, lookup);
      result.linked += indexed.linked;
      result.ambiguous += indexed.ambiguous;
    } catch (error) {
      // Marked done anyway: one broken repository mustn't hold up the rest.
      result.failed++;
      note = error instanceof Error ? error.message.slice(0, 500) : "read failed";
      console.error("Mentions: backfilling a repository failed", { repo: repo.id, error });
    }
    await k
      .insertInto("commit_mention_backfills")
      .values({ repo_id: repo.id, commits, note })
      .onConflict((oc) => oc.doNothing())
      .execute();
    result.repos++;
  }
  return result;
}
