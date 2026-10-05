// Commit-message mentions of tracker issues (CORE-22). When a push makes
// commits newly reachable (worker/ref-log/record.ts reads them), the issue
// keys their messages name are resolved to issues in Gitmatrix trackers and
// recorded in commit_issue_mentions; an issue's linked work lists them as
// "Mentioned in" (worker/tracker/work.ts). Release notes resolve the keys a
// workspace subscription doesn't through the same rules.
//
// A key is looked up tier by tier, and the first tier where it resolves
// decides:
//
// 1. trackers whose workspaces subscribe to the repository,
// 2. the repository owner's tracker,
// 3. the trackers of the organizations the owner belongs to (an owner that
//    is a person).
//
// Within a tier, a key found in one tracker links to its issue. Found in
// several, the repository owner's tracker wins if it is one of them;
// otherwise the key is ambiguous and recorded unresolved. A key no tracker
// knows (an external tracker's, `UTF-8`) isn't recorded. Only Gitmatrix
// trackers are ever consulted.

import { sql } from "kysely";
import type { ShippedIssue } from "../../shared/release-notes.ts";
import { issueKeys } from "../release-notes/keys.ts";
import { batch, db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";

export interface TrackerOwnerRef {
  id: string;
  slug: string;
}

export type KeyResolution =
  | { kind: "linked"; owner: TrackerOwnerRef; issue: ShippedIssue }
  | { kind: "ambiguous"; owners: TrackerOwnerRef[] };

/** Issues by key in one tracker; unknown keys are left out. */
export type IssueLookup = (ownerId: string, keys: string[]) => Promise<ShippedIssue[]>;

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
/** Organizations consulted in the third tier, at most. */
const ORG_TIER_LIMIT = 20;
/** Mention rows per insert: 11 columns, under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 9;

/** Look keys up in the trackers' Durable Objects. */
export function trackerLookup(env: Env): IssueLookup {
  return async (ownerId, keys) => {
    const result = await trackerObject(env, ownerId).issuesByKey(keys);
    if (!result.ok) throw new Error(`Tracker lookup failed: ${result.error}`);
    return result.value;
  };
}

/**
 * The trackers related to a repository: those whose workspaces subscribe to
 * it (the tracker_repo_subscriptions mirror), its owner's, and, for a
 * person's repository, the organizations they belong to (unless `orgs` is
 * false). Shared with the viewer-side reference resolver (worker/refs).
 */
export async function repoTrackers(
  d1: D1Database,
  repoId: string,
  options: { orgs?: boolean } = {},
): Promise<{
  subscribed: TrackerOwnerRef[];
  owner: TrackerOwnerRef;
  orgs: TrackerOwnerRef[];
} | null> {
  const k = db(d1);
  const repo = await k
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .select(["r.owner_id", "o.slug", "o.kind"])
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  if (!repo) return null;
  const subscribed = await k
    .selectFrom("tracker_repo_subscriptions as s")
    .innerJoin("accounts as a", "a.id", "s.tracker_owner_id")
    .select(["a.id", "a.slug"])
    .where("s.repo_id", "=", repoId)
    .orderBy("a.slug")
    .execute();
  const orgs =
    options.orgs !== false && repo.kind === "user"
      ? await k
          .selectFrom("org_members as m")
          .innerJoin("accounts as a", "a.id", "m.org_id")
          .select(["a.id", "a.slug"])
          .where("m.user_id", "=", repo.owner_id)
          .orderBy("a.slug")
          .limit(ORG_TIER_LIMIT)
          .execute()
      : [];
  return { subscribed, owner: { id: repo.owner_id, slug: repo.slug }, orgs };
}

/** The trackers that may resolve a repository's keys, in preference order. */
export async function trackerTiers(d1: D1Database, repoId: string): Promise<TrackerOwnerRef[][]> {
  const related = await repoTrackers(d1, repoId);
  if (!related) return [];
  const seen = new Set<string>();
  const tier = (owners: TrackerOwnerRef[]) => {
    const fresh = owners.filter((owner) => !seen.has(owner.id));
    for (const owner of fresh) seen.add(owner.id);
    return fresh;
  };
  return [tier(related.subscribed), tier([related.owner]), tier(related.orgs)].filter(
    (t) => t.length,
  );
}

/**
 * Resolve `keys` through `tiers` (trackerTiers). `preferred` is the repository
 * owner's account, which breaks a tie within a tier.
 */
export async function resolveKeys(
  tiers: TrackerOwnerRef[][],
  keys: string[],
  lookup: IssueLookup,
  preferred?: string,
): Promise<Map<string, KeyResolution>> {
  const resolved = new Map<string, KeyResolution>();
  const remaining = new Set(keys);
  for (const tier of tiers) {
    if (!remaining.size) break;
    const wanted = [...remaining];
    const hits = new Map<string, { owner: TrackerOwnerRef; issue: ShippedIssue }[]>();
    for (const owner of tier)
      for (let start = 0; start < wanted.length; start += KEYS_PER_LOOKUP)
        for (const issue of await lookup(owner.id, wanted.slice(start, start + KEYS_PER_LOOKUP)))
          if (remaining.has(issue.key))
            hits.set(issue.key, [...(hits.get(issue.key) ?? []), { owner, issue }]);
    for (const [key, found] of hits) {
      remaining.delete(key);
      const chosen =
        found.length === 1 ? found[0] : found.find((hit) => hit.owner.id === preferred);
      resolved.set(
        key,
        chosen
          ? { kind: "linked", owner: chosen.owner, issue: chosen.issue }
          : { kind: "ambiguous", owners: found.map((hit) => hit.owner) },
      );
    }
  }
  return resolved;
}

/** Resolve keys for a repository: its tiers, its owner preferred. */
export async function resolveRepoKeys(
  d1: D1Database,
  repo: { id: string; owner_id: string },
  keys: string[],
  lookup: IssueLookup,
): Promise<Map<string, KeyResolution>> {
  if (!keys.length) return new Map();
  return resolveKeys(await trackerTiers(d1, repo.id), keys, lookup, repo.owner_id);
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
    .select(["id", "owner_id"])
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
          resolution: found.kind,
          tracker_owner_id: found.kind === "linked" ? found.owner.id : null,
          issue_id: found.kind === "linked" ? found.issue.id : null,
          title: title(commit.message),
          committed_at:
            commit.committedAt === null ? null : new Date(commit.committedAt * 1000).toISOString(),
          first_ref: commit.ref,
          pushed_at: new Date().toISOString(),
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
            tracker_owner_id: sql`CASE WHEN ${linkedStays} THEN commit_issue_mentions.tracker_owner_id ELSE excluded.tracker_owner_id END`,
            issue_id: sql`CASE WHEN ${linkedStays} THEN commit_issue_mentions.issue_id ELSE excluded.issue_id END`,
          }),
        ),
    );
  await batch(d1, statements);
  return {
    linked: rows.filter((r) => r.resolution === "linked").length,
    ambiguous: rows.filter((r) => r.resolution === "ambiguous").length,
  };
}

/** After a push: index the commits each logged update read. Never throws. */
export async function indexPushedMentions(
  env: Env,
  repoId: string,
  updates: {
    ref: string;
    commits?: {
      oid: string;
      changeId: string | null;
      message?: string;
      committedAt?: number | null;
    }[];
  }[],
  lookup: IssueLookup = trackerLookup(env),
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
    await indexMentions(env.DB, repoId, commits, lookup);
  } catch (error) {
    console.error("Mentions: indexing a push failed", { repo: repoId, error });
  }
}
