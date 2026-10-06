// What a push did to timelines, from the push log (ref-log/record.ts): which
// timeline bookmarks it moved, and the merges it brought between timelines and
// main. A merge is a commit on the pushed line's own first-parent chain whose
// other parent was, at some point, the tip of another line: main (the default
// branch) or a timeline bookmark. Runs after the push answered (waitUntil).

import type { Actor, RepoRow } from "../db.ts";
import type { PackCommit } from "../git/pack.ts";
import { recordPush, type LoggedUpdate } from "../ref-log/record.ts";
import { db } from "../schema.ts";
import { timelineSlugOf } from "../../shared/timelines.ts";
import type { PushActivity } from "../tracker/timelines.ts";
import { trackerObject } from "../tracker/stub.ts";

/** Commit ids per lookup, under D1's 100 bound parameters. */
const OIDS_PER_QUERY = 80;

type PushedRepo = Pick<
  RepoRow,
  | "id"
  | "owner_id"
  | "owner_slug"
  | "name"
  | "default_branch"
  | "artifacts_name"
  | "artifacts_remote"
> & { source_id?: string };

/** A ref's line: null for main, a slug for a timeline bookmark, undefined for anything else. */
function lineOf(ref: string, mainRef: string): string | null | undefined {
  if (ref === mainRef) return null;
  return timelineSlugOf(ref) ?? undefined;
}

/** The commits an update put on its ref's own line: its first-parent chain down to the old tip. */
function ownLine(update: LoggedUpdate): PackCommit[] {
  const byOid = new Map((update.commits ?? []).map((c) => [c.oid, c]));
  const chain: PackCommit[] = [];
  for (let oid = update.new; oid && oid !== update.old;) {
    const commit = byOid.get(oid);
    if (!commit) break;
    chain.push(commit);
    byOid.delete(oid);
    oid = commit.parents[0] ?? null;
  }
  return chain;
}

export async function timelineActivity(
  d1: D1Database,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
  logged: LoggedUpdate[],
): Promise<PushActivity | null> {
  // Owned source pushes are admitted and recorded synchronously by Tracker.
  // Their work ref must never be interpreted as canonical main or guessed
  // into another timeline by an equal commit/change id.
  if (repo.source_id && repo.source_id !== "canonical") return null;
  const mainRef = `refs/heads/${repo.default_branch}`;
  const pushed = new Set<string>();
  const heads: NonNullable<PushActivity["heads"]> = [];
  const pending: { update: LoggedUpdate; into: string | null; commit: string; parent: string }[] =
    [];
  for (const update of logged) {
    const into = lineOf(update.ref, mainRef);
    // Where each bookmark points now: a move past a checkpoint ends its approval.
    if (into) heads.push({ slug: into, commit: update.new });
    if (into === undefined || !update.new) continue;
    const line = ownLine(update);
    // A bookmark made where commits already were (a fork) isn't work in the timeline.
    if (into !== null && (update.old || line.length)) pushed.add(into);
    for (const commit of line)
      for (const parent of commit.parents.slice(1))
        pending.push({ update, into, commit: commit.oid, parent });
  }
  // Which lines' tips each merged parent has been: now (repo_refs) or ever (the push log).
  const tips = new Map<string, { ref: string; at: number }[]>();
  const parents = [...new Set(pending.map((p) => p.parent))];
  const kdb = db(d1);
  for (let start = 0; start < parents.length; start += OIDS_PER_QUERY) {
    const oids = parents.slice(start, start + OIDS_PER_QUERY);
    const [current, history] = await Promise.all([
      kdb
        .selectFrom("repo_refs")
        .select(["ref", "oid"])
        .where("repo_id", "=", repo.id)
        .where("source_id", "=", "canonical")
        .where("oid", "in", oids)
        .where((eb) => eb.or([eb("ref", "=", mainRef), eb("ref", "like", "refs/heads/timeline/%")]))
        .execute(),
      kdb
        .selectFrom("ref_updates")
        .select(["ref", "new_oid as oid", "id"])
        .where("repo_id", "=", repo.id)
        .where("source_id", "=", "canonical")
        .where("new_oid", "in", oids)
        .where((eb) => eb.or([eb("ref", "=", mainRef), eb("ref", "like", "refs/heads/timeline/%")]))
        .execute(),
    ]);
    for (const row of [...current.map((r) => ({ ...r, id: Infinity })), ...history]) {
      if (!row.oid) continue;
      tips.set(row.oid, [...(tips.get(row.oid) ?? []), { ref: row.ref, at: row.id }]);
    }
  }
  const merges: PushActivity["merges"] = [];
  for (const { update, into, commit, parent } of pending) {
    const candidates = (tips.get(parent) ?? [])
      .filter((tip) => tip.ref !== update.ref)
      .map((tip) => ({ line: lineOf(tip.ref, mainRef)!, at: tip.at }))
      .filter((tip) => tip.line !== into);
    if (!candidates.length) continue;
    // Main when it's one of them (a fresh fork shares main's tip), else the latest tip.
    const from = candidates.some((c) => c.line === null)
      ? null
      : candidates.sort((a, b) => b.at - a.at)[0]!.line;
    merges.push({ into, from, commit, parent, refUpdateId: update.id });
  }
  if (!pushed.size && !merges.length && !heads.length) return null;
  return {
    repo: { id: repo.id, owner: repo.owner_slug, name: repo.name },
    actorId: actor ? (actor.agent?.id ?? actor.id) : null,
    accountableId: actor?.id ?? null,
    pushed: [...pushed],
    heads,
    merges,
  };
}

/**
 * Log a push (or a ref the server wrote itself) and note what it did to the
 * repository owner's timelines. Never throws: it runs after the response.
 */
export async function logPush(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
): Promise<void> {
  let logged: LoggedUpdate[];
  try {
    logged = await recordPush(env, repo, actor);
  } catch (error) {
    console.error("Push log: recording failed", error);
    return;
  }
  try {
    const activity = await timelineActivity(env.DB, repo, actor, logged);
    if (!activity) return;
    const result = await trackerObject(env, repo.owner_id).recordTimelinePush(activity);
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    console.error("Timelines: recording a push failed", { repo: repo.id, error });
  }
}
