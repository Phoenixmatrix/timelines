// Commit mentions resolve only in the repository's immutable Space. Organization
// membership and subscription discovery never authorize another Space's tracker.
// Every production lookup revalidates the initiating WorkAuthority and obtains
// current Tracker Access; source provenance remains where the commit was first seen.
//
// A mention belongs to the code source whose push recorded it (CORE-296): a
// timeline's work source until its compact commit lands, and it goes with the
// source when retention purges it. The compact commit names the source's keys
// (worker/timelines/landing.ts), so main's own mention outlives the work.

import { sql } from "kysely";
import type { ShippedIssue } from "../../shared/release-notes.ts";
import { issueKeys } from "../release-notes/keys.ts";
import { batch, db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";
import { findSpaceById, resolveSpaceAccess } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";

/** Issues by key in one tracker; unknown keys are left out. */
export type IssueLookup = (spaceId: string, keys: string[]) => Promise<ShippedIssue[]>;

/** A commit as the index reads it. */
export interface MentionCommit {
  oid: string;
  changeId: string | null;
  message: string;
  /** Committer time, Unix seconds. */
  committedAt: number | null;
  /** The ref whose update made it reachable; null for a backfill. */
  ref: string | null;
}

/** Keys taken from one commit message, at most. */
const KEYS_PER_COMMIT = 20;
/** Keys per tracker lookup (the tracker's own bound). */
const KEYS_PER_LOOKUP = 500;
/** Twelve columns per mention, under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 8;

/** Look keys up in the trackers' Durable Objects. */
export function trackerLookup(env: Env, repoId: string, authority: WorkAuthority): IssueLookup {
  return async (spaceId, keys) => {
    if (spaceId !== authority.spaceId) return [];
    const { actor, repo } = await resolveWorkAuthority(env, authority, repoId);
    if (repo.deleted_at || !(await resolveSpaceAccess(env.DB, actor, spaceId)))
      throw new Error("mention_space_access_required");
    const space = await findSpaceById(env.DB, spaceId);
    if (!space) return [];
    const access = await accessFor(
      env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    const result = await trackerObject(env, spaceId).issuesByKey(access, keys);
    if (!result.ok) throw new Error(`Tracker lookup failed: ${result.error}`);
    return result.value;
  };
}

/** Resolve keys only in the repository's immutable Space. */
export async function resolveRepoKeys(
  d1: D1Database,
  repo: { id: string; space_id: string },
  keys: string[],
  lookup: IssueLookup,
): Promise<Map<string, ShippedIssue>> {
  const resolved = new Map<string, ShippedIssue>();
  if (!keys.length) return resolved;
  const current = await db(d1)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", repo.id)
    .where("space_id", "=", repo.space_id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!current) return resolved;
  const wanted = new Set(keys);
  for (let start = 0; start < keys.length; start += KEYS_PER_LOOKUP)
    for (const issue of await lookup(repo.space_id, keys.slice(start, start + KEYS_PER_LOOKUP)))
      if (wanted.has(issue.key)) resolved.set(issue.key, issue);
  return resolved;
}

function title(message: string): string {
  const line = message.trim().split("\n", 1)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Record the mentions in `commits` (newest first; a commit listed twice keeps
 * its first ref). Idempotent: a row already recorded keeps when and where it
 * was first seen; only an ambiguous one may become linked, and a missing
 * change id is filled in.
 */
export async function indexMentions(
  d1: D1Database,
  repoId: string,
  commits: MentionCommit[],
  lookup: IssueLookup,
  sourceId = "canonical",
): Promise<{ linked: number; ambiguous: number }> {
  const byOid = new Map<string, MentionCommit & { keys: string[] }>();
  for (const commit of commits) {
    if (byOid.has(commit.oid)) continue;
    const keys = issueKeys(commit.message).slice(0, KEYS_PER_COMMIT);
    if (keys.length) byOid.set(commit.oid, { ...commit, keys });
  }
  if (!byOid.size) return { linked: 0, ambiguous: 0 };
  const repo = await db(d1)
    .selectFrom("repos")
    .select(["id", "space_id"])
    .where("id", "=", repoId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) return { linked: 0, ambiguous: 0 };
  const keys = [...new Set([...byOid.values()].flatMap((c) => c.keys))];
  const resolved = await resolveRepoKeys(d1, repo, keys, lookup);

  const rows = [...byOid.values()].flatMap((commit) =>
    commit.keys.flatMap((key) => {
      const found = resolved.get(key);
      if (!found) return [];
      return [
        {
          repo_id: repoId,
          commit_oid: commit.oid,
          issue_key: key,
          change_id: commit.changeId,
          resolution: "linked" as const,
          tracker_space_id: repo.space_id,
          issue_id: found.id,
          title: title(commit.message),
          committed_at:
            commit.committedAt === null ? null : new Date(commit.committedAt * 1000).toISOString(),
          first_ref: commit.ref,
          pushed_at: new Date().toISOString(),
          source_id: sourceId,
        },
      ];
    }),
  );
  const k = db(d1);
  const linkedStays = sql<boolean>`commit_issue_mentions.resolution = 'linked'`;
  const statements = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT)
    statements.push(
      k
        .insertInto("commit_issue_mentions")
        .values(rows.slice(start, start + ROWS_PER_INSERT))
        .onConflict((oc) =>
          oc.columns(["repo_id", "commit_oid", "issue_key"]).doUpdateSet({
            change_id: sql`coalesce(commit_issue_mentions.change_id, excluded.change_id)`,
            resolution: sql`CASE WHEN ${linkedStays} THEN commit_issue_mentions.resolution ELSE excluded.resolution END`,
            tracker_space_id: sql`CASE WHEN ${linkedStays} THEN commit_issue_mentions.tracker_space_id ELSE excluded.tracker_space_id END`,
            issue_id: sql`CASE WHEN ${linkedStays} THEN commit_issue_mentions.issue_id ELSE excluded.issue_id END`,
          }),
        ),
    );
  await batch(d1, statements);
  return {
    linked: rows.length,
    ambiguous: 0,
  };
}

/** After a push to `sourceId`: index the commits each logged update read. Never throws. */
export async function indexPushedMentions(
  env: Env,
  repoId: string,
  authority: WorkAuthority,
  updates: {
    ref: string;
    commits?: {
      oid: string;
      changeId: string | null;
      message?: string;
      committedAt?: number | null;
    }[];
  }[],
  {
    sourceId = "canonical",
    lookup = trackerLookup(env, repoId, authority),
  }: { sourceId?: string; lookup?: IssueLookup } = {},
): Promise<void> {
  const commits: MentionCommit[] = updates.flatMap((update) =>
    (update.commits ?? []).map((commit) => ({
      oid: commit.oid,
      changeId: commit.changeId,
      message: commit.message ?? "",
      committedAt: commit.committedAt ?? null,
      ref: update.ref,
    })),
  );
  if (!commits.some((c) => c.message)) return;
  try {
    await indexMentions(env.DB, repoId, commits, lookup, sourceId);
  } catch (error) {
    console.error("Mentions: indexing a push failed", { repo: repoId, error });
  }
}
