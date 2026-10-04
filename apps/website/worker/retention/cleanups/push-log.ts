// The push log (category "push-log", CORE-202): ref_updates and change_refs
// past the policy, in an account's repositories. Git history itself is never
// touched; these are Gitmatrix's records of pushes (worker/ref-log).
//
// Selects, older than `days` before the run's moment:
//
// - stale change refs: a change's record on a ref that no longer exists (a
//   deleted branch, a landed or abandoned timeline's bookmark), last seen
//   before the cutoff;
// - push log entries made before the cutoff, except the latest entry of each
//   branch or tag that still exists (it explains the ref's current commit) and
//   any entry a kept change ref points to (first_update_id: deleting the entry
//   would cascade to it).
//
// Stale change refs come first, then entries. An entry's predicate counts the
// change refs it would cascade to as kept unless they are stale by the same
// predicate, so a dry run selects exactly what a run removes. One predicate
// per kind serves select and remove. Cursor: `c:<change_refs rowid>`, then
// `u:<ref_updates id>`.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  /** c: a change_refs row (by rowid), u: a ref_updates row. */
  kind: "c" | "u";
  id: number;
  bytes: number;
}

/** Parameters: ?1 account id, ?2 cutoff. A change ref on a ref that's gone, last seen before the cutoff. */
const stale = (m: string) => `${m}.last_seen_at < ?2
  AND NOT EXISTS (SELECT 1 FROM repo_refs r WHERE r.repo_id = ${m}.repo_id AND r.ref = ${m}.ref)`;

const STALE_CHANGE_REF = `m.repo_id IN (SELECT id FROM repos WHERE owner_id = ?1) AND ${stale("m")}`;

const OLD_UPDATE = `u.repo_id IN (SELECT id FROM repos WHERE owner_id = ?1)
  AND u.created_at < ?2
  AND NOT EXISTS (SELECT 1 FROM change_refs k WHERE k.first_update_id = u.id AND NOT (${stale("k")}))
  AND NOT (EXISTS (SELECT 1 FROM repo_refs r WHERE r.repo_id = u.repo_id AND r.ref = u.ref)
           AND u.id = (SELECT max(x.id) FROM ref_updates x WHERE x.repo_id = u.repo_id AND x.ref = u.ref))`;

/** Estimated row sizes: their text, plus a fixed allowance for the row and its indexes. */
const changeRefBytes = (m: string) => `(120 + length(${m}repo_id) + length(${m}change_id)
  + length(${m}ref) + length(${m}first_commit_oid) + length(${m}last_commit_oid)
  + length(${m}first_seen_at) + length(${m}last_seen_at))`;
const updateBytes = (u: string) => `(100 + length(${u}repo_id) + length(${u}ref)
  + coalesce(length(${u}old_oid), 0) + coalesce(length(${u}new_oid), 0)
  + coalesce(length(${u}actor_id), 0) + coalesce(length(${u}agent_id), 0) + length(${u}created_at))`;

function scope(ctx: CleanupContext): [string, string] {
  if (ctx.target.scope !== "account") throw new Error("push-log is an account category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("push-log needs its days threshold.");
  return [ctx.target.accountId, daysBefore(ctx.now, days)];
}

async function selectChangeRefs(ctx: CleanupContext, after: number, limit: number) {
  const [account, cutoff] = scope(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT m.rowid AS id, ${changeRefBytes("m.")} AS bytes FROM change_refs m
     WHERE ${STALE_CHANGE_REF} AND m.rowid > ?3 ORDER BY m.rowid LIMIT ?4`,
  )
    .bind(account, cutoff, after, limit)
    .all<{ id: number; bytes: number }>();
  return results.map((r): Item => ({ kind: "c", id: r.id, bytes: r.bytes }));
}

async function selectUpdates(ctx: CleanupContext, after: number, limit: number) {
  const [account, cutoff] = scope(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT u.id, ${updateBytes("u.")} AS bytes FROM ref_updates u
     WHERE ${OLD_UPDATE} AND u.id > ?3 ORDER BY u.id LIMIT ?4`,
  )
    .bind(account, cutoff, after, limit)
    .all<{ id: number; bytes: number }>();
  return results.map((r): Item => ({ kind: "u", id: r.id, bytes: r.bytes }));
}

export const pushLog: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const kind = cursor?.[0] ?? "c";
    const after = cursor ? Number(cursor.slice(2)) : 0;
    const items =
      kind === "c"
        ? await selectChangeRefs(ctx, after, ctx.limit)
        : await selectUpdates(ctx, after, ctx.limit);
    const last = items.at(-1);
    // After the last page of change refs, the entries start.
    const next = items.length === ctx.limit ? `${kind}:${last!.id}` : kind === "c" ? "u:0" : null;
    return { items, next, bytes: items.reduce((sum, i) => sum + i.bytes, 0) };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx);
    const ids = (kind: Item["kind"]) =>
      JSON.stringify(items.filter((i) => i.kind === kind).map((i) => i.id));
    const [changeRefs, updates] = await ctx.env.DB.batch<{ bytes: number }>([
      ctx.env.DB.prepare(
        `DELETE FROM change_refs AS m
         WHERE m.rowid IN (SELECT value FROM json_each(?3)) AND ${STALE_CHANGE_REF}
         RETURNING ${changeRefBytes("")} AS bytes`,
      ).bind(account, cutoff, ids("c")),
      ctx.env.DB.prepare(
        `DELETE FROM ref_updates AS u
         WHERE u.id IN (SELECT value FROM json_each(?3)) AND ${OLD_UPDATE}
         RETURNING ${updateBytes("")} AS bytes`,
      ).bind(account, cutoff, ids("u")),
    ]);
    const removed = [...(changeRefs?.results ?? []), ...(updates?.results ?? [])];
    return { count: removed.length, bytes: removed.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
