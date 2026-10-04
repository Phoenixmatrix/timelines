// The package registry's site categories (CORE-205), over REGISTRY_DB and
// the REGISTRY_BLOBS bucket.
//
// "registry-proxy-cache" (`days`), in two phases:
// - "d": derived objects (R2 `d/<repo>/<sha256>`) no `derived_files` row
//   refers to: replaced generations, removed files, deleted feeds and the
//   bodies of cache entries an earlier run removed. Only objects older than
//   garbage collection's grace period (GC_GRACE_MS), re-checked right before
//   each delete, so a derived file being written keeps its object. First, so
//   what the next phase orphans waits for the next run and a dry run lists
//   exactly what the run removes.
// - "e": proxy cache entries (`remote_entries`) nobody was served for `days`
//   (`used_at`, touched at most daily by registry/core/remote.ts), with an
//   upstream metadata entry's cached body (its `derived_files` row). The next
//   request fetches from upstream again. An artifact entry's blob then has
//   no reference left, so garbage collection (registry/jobs/gc.ts) reclaims it
//   after its usual grace period; blobs any version, tag or kept entry refers
//   to stay.
//
// "registry-audit" (`days`), in two phases:
// - "a": audit log entries older than `days` (nothing reads them back).
// - "p": publish records older than `days` that history alone needs: those
//   of deleted versions, and those a newer record of the same version
//   supersedes. Never the newest record of a version still published, and
//   never one from a non-default branch (it keeps that version from becoming
//   `latest`).
//
// Items are short strings, `<phase>:<rowid>` (or `d:<key>`); the cursor is
// the last item of a phase, or `<next phase>:` when one starts.

import type { CategoryCleanup, CleanupContext, Selection } from "../engine.ts";
import { daysBefore } from "../engine.ts";
import { GC_GRACE_MS } from "../../../registry/jobs/gc.ts";

type Item = string;

/** Phases in order; each select works through one, then hands over to the next. */
function phase(cursor: string | null, phases: string[]): [string, string] {
  if (cursor === null) return [phases[0]!, ""];
  const [name, ...rest] = cursor.split(":");
  if (!name || !phases.includes(name) || !rest.length) throw new Error(`Bad cursor: ${cursor}`);
  return [name, rest.join(":")];
}

function following(name: string, phases: string[]): string | null {
  const next = phases[phases.indexOf(name) + 1];
  return next ? `${next}:` : null;
}

function cutoff(ctx: CleanupContext, id: string): string {
  if (ctx.target.scope !== "site") throw new Error(`${id} is a site category.`);
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error(`${id} needs its days threshold.`);
  return daysBefore(ctx.now, days);
}

/** One page of a D1 phase: rows matching `where` (binding ?1) after the cursor's rowid. */
async function rowsAfter(
  ctx: CleanupContext,
  sql: string,
  binding: string,
  name: string,
  position: string,
  phases: string[],
): Promise<Selection<Item>> {
  const { results } = await ctx.env.REGISTRY_DB.prepare(
    `${sql} AND t.rowid > ?2 ORDER BY t.rowid LIMIT ?3`,
  )
    .bind(binding, Number(position || 0), ctx.limit)
    .all<{ id: number; bytes: number }>();
  return {
    items: results.map((row) => `${name}:${row.id}`),
    next: results.length < ctx.limit ? following(name, phases) : `${name}:${results.at(-1)!.id}`,
    bytes: results.reduce((sum, row) => sum + row.bytes, 0),
  };
}

function rowids(items: Item[], name: string): string {
  return JSON.stringify(
    items.filter((item) => item.startsWith(`${name}:`)).map((item) => Number(item.slice(2))),
  );
}

// ---- registry-proxy-cache --------------------------------------------------------

/** Entries unused since ?1, as `t`. */
const UNUSED = `(t.used_at < ?1 OR (t.used_at IS NULL AND t.fetched_at < ?1))`;
/** The entry row, and an artifact's blob (its bytes once garbage collection runs). */
const ENTRY_BYTES = (t: string) => `(120 + length(${t}path)
  + coalesce((SELECT b.size FROM blobs b WHERE b.digest = ${t}digest), 0))`;
const CACHE_PHASES = ["d", "e"];

/** Of these derived object keys, those no derived file refers to. */
async function unreferenced(d1: D1Database, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { results } = await d1
    .prepare(
      `SELECT k.value AS key FROM json_each(?1) k
       WHERE NOT EXISTS (SELECT 1 FROM derived_files f WHERE f.r2_key = k.value)`,
    )
    .bind(JSON.stringify(keys))
    .all<{ key: string }>();
  return new Set(results.map((row) => row.key));
}

export const registryProxyCache: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const before = cutoff(ctx, "registry-proxy-cache");
    const [name, position] = phase(cursor, CACHE_PHASES);
    if (name === "e")
      return rowsAfter(
        ctx,
        `SELECT t.rowid AS id, ${ENTRY_BYTES("t.")} AS bytes FROM remote_entries t WHERE ${UNUSED}`,
        before,
        name,
        position,
        CACHE_PHASES,
      );
    const grace = ctx.now.getTime() - GC_GRACE_MS;
    const page = await ctx.env.REGISTRY_BLOBS.list({
      prefix: "d/",
      limit: Math.min(ctx.limit, 1000),
      ...(position ? { startAfter: position } : {}),
    });
    const old = page.objects.filter((object) => object.uploaded.getTime() < grace);
    const orphans = await unreferenced(
      ctx.env.REGISTRY_DB,
      old.map((object) => object.key),
    );
    const found = old.filter((object) => orphans.has(object.key));
    return {
      items: found.map((object) => `d:${object.key}`),
      next: page.truncated ? `d:${page.objects.at(-1)!.key}` : following("d", CACHE_PHASES),
      bytes: found.reduce((sum, object) => sum + object.size, 0),
    };
  },
  async remove(ctx, items) {
    const before = cutoff(ctx, "registry-proxy-cache");
    const d1 = ctx.env.REGISTRY_DB;
    let count = 0;
    let bytes = 0;
    const entries = rowids(items, "e");
    if (entries !== "[]") {
      // The cached body first, in the same transaction, so no entry is left
      // pointing at a body that's gone.
      const [, removed] = await d1.batch<{ bytes: number }>([
        d1
          .prepare(
            `DELETE FROM derived_files WHERE EXISTS (
               SELECT 1 FROM remote_entries t
               WHERE t.rowid IN (SELECT value FROM json_each(?2)) AND ${UNUSED}
                 AND t.repo_id = derived_files.repo_id AND t.path = derived_files.path)`,
          )
          .bind(before, entries),
        d1
          .prepare(
            // No alias: RETURNING's blob lookup names the deleted row by its table.
            `DELETE FROM remote_entries
             WHERE rowid IN (SELECT value FROM json_each(?2))
               AND ${UNUSED.replaceAll("t.", "remote_entries.")}
             RETURNING ${ENTRY_BYTES("remote_entries.")} AS bytes`,
          )
          .bind(before, entries),
      ]);
      count += removed!.results.length;
      bytes += removed!.results.reduce((sum, row) => sum + row.bytes, 0);
    }
    const keys = items.filter((item) => item.startsWith("d:")).map((item) => item.slice(2));
    if (keys.length) {
      const grace = ctx.now.getTime() - GC_GRACE_MS;
      const orphans = await unreferenced(d1, keys);
      for (const key of orphans) {
        const object = await ctx.env.REGISTRY_BLOBS.head(key);
        if (!object || object.uploaded.getTime() >= grace) continue;
        // Checked again right before the delete: a derived file written meanwhile keeps it.
        if (!(await unreferenced(d1, [key])).has(key)) continue;
        await ctx.env.REGISTRY_BLOBS.delete(key);
        count++;
        bytes += object.size;
      }
    }
    return { count, bytes };
  },
};

// ---- registry-audit -----------------------------------------------------------------

const AUDIT_PHASES = ["a", "p"];
const AUDIT_BYTES = (t: string) =>
  `(96 + length(${t}id) + length(${t}action) + coalesce(length(${t}target), 0) + length(${t}detail))`;
const PUBLISH_BYTES = (t: string) =>
  `(200 + length(${t}id) + length(${t}version) + coalesce(length(${t}commit_oid), 0) + length(${t}actor_label))`;
/** Publish records older than ?1 that only history needs, as `t`. */
const SUPERSEDED = `t.at < ?1 AND (t.status = 'deleted' OR (t.off_default_branch = 0 AND EXISTS (
  SELECT 1 FROM publishes n WHERE n.package_id = t.package_id AND n.version = t.version
    AND (n.at > t.at OR (n.at = t.at AND n.id > t.id)))))`;

export const registryAudit: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const before = cutoff(ctx, "registry-audit");
    const [name, position] = phase(cursor, AUDIT_PHASES);
    const query =
      name === "a"
        ? `SELECT t.rowid AS id, ${AUDIT_BYTES("t.")} AS bytes FROM audit_log t WHERE t.at < ?1`
        : `SELECT t.rowid AS id, ${PUBLISH_BYTES("t.")} AS bytes FROM publishes t WHERE ${SUPERSEDED}`;
    return rowsAfter(ctx, query, before, name, position, AUDIT_PHASES);
  },
  async remove(ctx, items) {
    const before = cutoff(ctx, "registry-audit");
    const d1 = ctx.env.REGISTRY_DB;
    let count = 0;
    let bytes = 0;
    for (const [name, statement] of [
      [
        "a",
        `DELETE FROM audit_log AS t WHERE t.rowid IN (SELECT value FROM json_each(?2)) AND t.at < ?1
         RETURNING ${AUDIT_BYTES("")} AS bytes`,
      ],
      [
        "p",
        // Superseded is re-checked row by row: removing an older record never
        // makes a newer one removable, so batches agree with the dry run.
        `DELETE FROM publishes AS t WHERE t.rowid IN (SELECT value FROM json_each(?2)) AND ${SUPERSEDED}
         RETURNING ${PUBLISH_BYTES("")} AS bytes`,
      ],
    ] as const) {
      const ids = rowids(items, name);
      if (ids === "[]") continue;
      const { results } = await d1.prepare(statement).bind(before, ids).all<{ bytes: number }>();
      count += results.length;
      bytes += results.reduce((sum, row) => sum + row.bytes, 0);
    }
    return { count, bytes };
  },
};
