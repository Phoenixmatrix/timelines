// Atlas retention (CORE-159): what Atlas projections keep, and for how long.
//
// The rule (ATLAS_RETENTION; documented in apps/website/README.md):
// - Per scope, the current snapshot plus at most 20 prior published ones.
// - A prior expires 7 days after it was superseded (`expires_at`, stamped by
//   the first retention pass after the next publication), or earlier when it
//   falls outside the 20 or under storage pressure.
// - Storage: 2 GiB per repository scope, measured as the sum of its snapshots'
//   `bytes` (the estimated size of the rows each opened that still exist; see
//   `ENTITY_BYTES_SQL` in projection.ts). Composition scopes (selected Space repositories,
//   not materialized) share ONE 2 GiB pool per Space, lineage and
//   provenance included, so changing scope cannot multiply the allowance: pass
//   all of a Space's composition scopes to `enforceRetention` together with
//   SPACE_COMPOSITION_RETENTION. The pool is the hook; nothing calls it yet:
//   cross-repository composition (CORE-167, compose.ts) is computed at read
//   from repository snapshots and stores nothing.
// - Under pressure the oldest prior (by publication) is evicted first, one at a
//   time, and its rows reclaimed before the pool is measured again. Current is
//   never evicted: a snapshot that doesn't fit even with every prior gone fails
//   with `failure = 'capacity'` (`admitProjection`) and the previous snapshot
//   stays current, stale; `capacityFailure` reports it for the UI.
// - A Space may tighten these for its repositories, never loosen them
//   (retention category "atlas-snapshots", CORE-201: fewer priors, fewer
//   days, a smaller cap, within ATLAS_RETENTION_BOUNDS). Every pass reads the
//   Space's choice (`scopePolicy`); a shorter period also brings forward the
//   expiry of priors stamped before it changed.
// - Reclaiming: a row is kept while any retained snapshot (published or
//   building) sees it (from_seq <= seq < to_seq, or open). Expiry is always
//   oldest-first, so retained published snapshots are a suffix of the scope's
//   sequence and a row is reclaimable exactly when to_seq <= the oldest
//   retained seq; the delete re-checks the general predicate anyway. Each call
//   does bounded work and is idempotent: `more` says to call again.
// - An expired snapshot's record is kept (for an explicit expiry answer) while
//   rows it opened survive, and for 30 days after; failed ones older than
//   current for 30 days.
//
// For the Atlas read API (CORE-160):
// - `pinnedSnapshot(d1, scope, id)` resolves every snapshot-pinned request
//   before reading rows: {state: "ok", snapshot} | {state: "expired",
//   snapshotId, seq, expiredAt, reason, current} | {state: "unknown"}. An
//   expired snapshot's rows may be partly gone, so never read them, and never
//   fall back to current silently: answer expiry and offer `current`.
// - Cursors expire at `cursorExpiresAt(issuedAt, snapshot.expiresAt)`: 30
//   minutes after issue (CURSOR_TTL_MS) or at snapshot expiry, whichever is
//   first. Cursors never hold off eviction (a current snapshot can become a
//   prior and be evicted under pressure within those 30 minutes), so resolve
//   the cursor's snapshot with `pinnedSnapshot` on every page too.
//
// It runs in the KnowledgeBuild Workflow around each publication (until
// `more` is false, then `admitProjection`, publish, and again after), and
// hourly from the scheduled handler (`sweepAtlasRetention`).

import { batch, db } from "../schema.ts";
import {
  EDGE_BYTES_SQL,
  ENTITY_BYTES_SQL,
  failProjection,
  toSnapshot,
  type AtlasSnapshot,
} from "./projection.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GIB = 1024 ** 3;

export const ATLAS_RETENTION = {
  /** Prior published snapshots kept per scope, besides current. */
  maxPrior: 20,
  /** A prior expires this long after it was superseded. */
  priorTtlMs: 7 * DAY,
  /** Projection storage per repository scope. */
  repoCapBytes: 2 * GIB,
  /** Projection storage for all of one Space's composition scopes together. */
  spaceCompositionCapBytes: 2 * GIB,
  /** How long an expired or failed snapshot's record outlives its rows. */
  recordTtlMs: 30 * DAY,
} as const;

/**
 * What a Space may choose for its repositories (retention category
 * "atlas-snapshots", CORE-201): anything up to ATLAS_RETENTION, never more.
 * Stored in retention_policies; `scopePolicy` reads it for every pass.
 */
export const ATLAS_RETENTION_BOUNDS = {
  maxPrior: { min: 0, max: ATLAS_RETENTION.maxPrior },
  priorDays: { min: 1, max: ATLAS_RETENTION.priorTtlMs / DAY },
  capGib: { min: 1, max: ATLAS_RETENTION.repoCapBytes / GIB },
} as const;

/** The retention category whose stored thresholds tighten a repository's policy. */
export const ATLAS_CATEGORY = "atlas-snapshots";

/**
 * A repository scope's policy as its owning Space chose it (category
 * "atlas-snapshots"), over REPO_RETENTION; nothing for other pools or when
 * the Space chose nothing. A stored value outside ATLAS_RETENTION_BOUNDS is
 * ignored, like any retention threshold.
 */
export async function scopePolicy(
  d1: D1Database,
  scopes: string[],
): Promise<Partial<RetentionPolicy>> {
  const [scope] = scopes;
  if (scopes.length !== 1 || !scope?.startsWith("repo:")) return {};
  const row = await d1
    .prepare(
      `SELECT p.thresholds FROM retention_policies p JOIN repos r ON r.space_id = p.scope_id AND p.scope_kind = 'space'
       WHERE r.id = ? AND p.category = ?`,
    )
    .bind(scope.slice("repo:".length), ATLAS_CATEGORY)
    .first<{ thresholds: string }>();
  if (!row) return {};
  let stored: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.thresholds) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      stored = value as Record<string, unknown>;
  } catch {
    return {};
  }
  const valid = (key: keyof typeof ATLAS_RETENTION_BOUNDS): number | undefined => {
    const value = stored[key];
    const { min, max } = ATLAS_RETENTION_BOUNDS[key];
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? value
      : undefined;
  };
  const policy: Partial<RetentionPolicy> = {};
  const maxPrior = valid("maxPrior");
  const priorDays = valid("priorDays");
  const capGib = valid("capGib");
  if (maxPrior !== undefined) policy.maxPrior = maxPrior;
  if (priorDays !== undefined) policy.priorTtlMs = priorDays * DAY;
  if (capGib !== undefined) policy.capBytes = capGib * GIB;
  return policy;
}

/** Cursors expire 30 minutes after issue, or at their snapshot's expiry if sooner. */
export const CURSOR_TTL_MS = 30 * MINUTE;

export interface RetentionPolicy {
  maxPrior: number;
  priorTtlMs: number;
  capBytes: number;
  recordTtlMs: number;
  /** Rows deleted per table per round. */
  reclaimBatch: number;
  /** Reclaim rounds per call, which bounds one call's work. */
  maxRounds: number;
}

export const REPO_RETENTION: RetentionPolicy = {
  maxPrior: ATLAS_RETENTION.maxPrior,
  priorTtlMs: ATLAS_RETENTION.priorTtlMs,
  capBytes: ATLAS_RETENTION.repoCapBytes,
  recordTtlMs: ATLAS_RETENTION.recordTtlMs,
  reclaimBatch: 5_000,
  maxRounds: 10,
};

/** For a Space's composition scopes, enforced as one pool (see the header). */
export const SPACE_COMPOSITION_RETENTION: RetentionPolicy = {
  ...REPO_RETENTION,
  capBytes: ATLAS_RETENTION.spaceCompositionCapBytes,
};

export type ExpiredReason = "age" | "count" | "storage";

export interface RetentionResult {
  expired: { id: string; scope: string; seq: number; reason: ExpiredReason }[];
  reclaimed: { entities: number; edges: number };
  /** The pool's storage after this call. */
  storedBytes: number;
  capBytes: number;
  /** Work is left (rows to reclaim, or over the cap with priors left): call again. */
  more: boolean;
}

type Statement = { compile(): { sql: string; parameters: readonly unknown[] } };
const raw = (sql: string, ...parameters: unknown[]): Statement => ({
  compile: () => ({ sql, parameters }),
});
const inList = "(SELECT value FROM json_each(?))";

interface PoolRow {
  id: string;
  scope: string;
  seq: number;
  status: "published" | "building";
  published_at: string | null;
  expires_at: string | null;
  current: number;
}

/** Retained (published or building) snapshots of a pool. */
async function retainedSnapshots(d1: D1Database, scopes: string[]): Promise<PoolRow[]> {
  const rows = await d1
    .prepare(
      `SELECT s.id, s.scope, s.seq, s.status, s.published_at, s.expires_at,
              (c.snapshot_id IS NOT NULL) AS current
       FROM atlas_snapshots s LEFT JOIN atlas_current c ON c.snapshot_id = s.id
       WHERE s.scope IN ${inList} AND s.status IN ('published', 'building')
       ORDER BY s.scope, s.seq`,
    )
    .bind(JSON.stringify(scopes))
    .all<PoolRow>();
  return rows.results.map((r) => ({ ...r, seq: Number(r.seq), current: Number(r.current) }));
}

/** A pool's projection storage: every snapshot's surviving rows. */
export async function storedBytes(d1: D1Database, scopes: string[]): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT coalesce(sum(bytes), 0) AS bytes FROM atlas_snapshots WHERE scope IN ${inList}`,
    )
    .bind(JSON.stringify(scopes))
    .first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

async function expire(
  d1: D1Database,
  victims: PoolRow[],
  reason: ExpiredReason,
  now: string,
): Promise<void> {
  if (victims.length === 0) return;
  const ids = JSON.stringify(victims.map((v) => v.id));
  await batch(d1, [
    // Age expiry keeps its due time; early expiry happens now.
    raw(
      `UPDATE atlas_snapshots SET status = 'expired', expired_reason = ?,
         expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN expires_at ELSE ? END
       WHERE id IN ${inList} AND status = 'published'
         AND id NOT IN (SELECT snapshot_id FROM atlas_current)`,
      reason,
      now,
      now,
      ids,
    ),
    raw(
      `UPDATE atlas_scopes SET retention_pending = 1
       WHERE scope IN (SELECT scope FROM atlas_snapshots WHERE id IN ${inList})`,
      ids,
    ),
  ]);
}

/**
 * Delete up to `limit` rows per table that no retained snapshot of `scope`
 * sees, subtracting their size from the snapshots that opened them. Each
 * table's subtraction and delete are one transaction over the rows still
 * there, so concurrent passes never subtract a row twice. Returns how many
 * were chosen and whether a batch was full.
 */
async function reclaim(
  d1: D1Database,
  scope: string,
  oldestRetained: number,
  limit: number,
): Promise<{ entities: number; edges: number; full: boolean }> {
  const counts = { entities: 0, edges: 0 };
  let full = false;
  for (const [table, size, key] of [
    ["atlas_entities", ENTITY_BYTES_SQL, "entities"],
    ["atlas_edges", EDGE_BYTES_SQL, "edges"],
  ] as const) {
    const unseen = `${table}.scope = ? AND ${table}.to_seq <= ? AND NOT EXISTS (
        SELECT 1 FROM atlas_snapshots s WHERE s.scope = ${table}.scope
        AND s.status IN ('published', 'building')
        AND s.seq >= ${table}.from_seq AND s.seq < ${table}.to_seq)`;
    const rows = await d1
      .prepare(`SELECT rowid AS rid FROM ${table} WHERE ${unseen} ORDER BY to_seq LIMIT ?`)
      .bind(scope, oldestRetained, limit)
      .all<{ rid: number }>();
    if (rows.results.length === 0) continue;
    const ids = JSON.stringify(rows.results.map((r) => r.rid));
    const chosen = `rowid IN ${inList} AND ${unseen}`;
    await batch(d1, [
      raw(
        `UPDATE atlas_snapshots SET bytes = max(0, bytes - coalesce((
           SELECT sum(${size}) FROM ${table}
           WHERE ${chosen} AND ${table}.from_seq = atlas_snapshots.seq), 0))
         WHERE scope = ? AND seq IN (SELECT from_seq FROM ${table} WHERE ${chosen})`,
        ids,
        scope,
        oldestRetained,
        scope,
        ids,
        scope,
        oldestRetained,
      ),
      raw(`DELETE FROM ${table} WHERE ${chosen}`, ids, scope, oldestRetained),
    ]);
    counts[key] = rows.results.length;
    if (rows.results.length >= limit) full = true;
  }
  return { ...counts, full };
}

/**
 * One bounded, idempotent retention pass over a pool of scopes sharing one
 * storage cap (a repository scope alone, with REPO_RETENTION by default):
 * stamp priors' expiry, expire by count and age, reclaim rows nothing
 * retained sees, then evict the oldest priors while the pool is over its cap.
 */
export async function enforceRetention(
  d1: D1Database,
  scopes: string[],
  options: { now?: Date; policy?: Partial<RetentionPolicy> } = {},
): Promise<RetentionResult> {
  const policy = { ...REPO_RETENTION, ...(await scopePolicy(d1, scopes)), ...options.policy };
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const expired: RetentionResult["expired"] = [];
  let rows = await retainedSnapshots(d1, scopes);

  // A prior's 7 days start when the next snapshot was published. A Space
  // that shortened the period since a prior was stamped brings it forward.
  const stamps: Statement[] = [];
  for (const row of rows) {
    if (row.status !== "published" || row.current) continue;
    const next = rows.find(
      (r) => r.scope === row.scope && r.status === "published" && r.seq > row.seq,
    );
    if (row.expires_at && !next?.published_at) continue;
    const from = Date.parse(next?.published_at ?? nowIso);
    const due = new Date(from + policy.priorTtlMs).toISOString();
    if (row.expires_at && row.expires_at <= due) continue;
    row.expires_at = due;
    stamps.push(
      raw(
        `UPDATE atlas_snapshots SET expires_at = ?1
         WHERE id = ?2 AND (expires_at IS NULL OR expires_at > ?1)`,
        row.expires_at,
        row.id,
      ),
    );
  }
  for (let i = 0; i < stamps.length; i += 50) await batch(d1, stamps.slice(i, i + 50));

  // Count, then age.
  const priors = (scope: string) =>
    rows.filter((r) => r.scope === scope && r.status === "published" && !r.current);
  const byCount: PoolRow[] = [];
  const byAge: PoolRow[] = [];
  for (const scope of scopes) {
    const newestFirst = priors(scope).sort((a, b) => b.seq - a.seq);
    byCount.push(...newestFirst.slice(policy.maxPrior));
    byAge.push(
      ...newestFirst
        .slice(0, policy.maxPrior)
        .filter((r) => r.expires_at !== null && r.expires_at <= nowIso),
    );
  }
  for (const [victims, reason] of [
    [byCount, "count"],
    [byAge, "age"],
  ] as const) {
    await expire(d1, victims, reason, nowIso);
    for (const v of victims) expired.push({ id: v.id, scope: v.scope, seq: v.seq, reason });
  }
  const gone = new Set(expired.map((e) => e.id));
  rows = rows.filter((r) => !gone.has(r.id));

  // Reclaim, and evict oldest-first while over the cap.
  const reclaimed = { entities: 0, edges: 0 };
  let rounds = 0;
  let more = false;
  let stored = 0;
  for (;;) {
    let pending = false;
    for (const scope of scopes) {
      const retained = rows.filter((r) => r.scope === scope).map((r) => r.seq);
      const oldest = retained.length ? Math.min(...retained) : Number.MAX_SAFE_INTEGER;
      for (;;) {
        if (rounds >= policy.maxRounds) {
          pending = true;
          break;
        }
        rounds++;
        const r = await reclaim(d1, scope, oldest, policy.reclaimBatch);
        reclaimed.entities += r.entities;
        reclaimed.edges += r.edges;
        if (!r.full) break;
      }
    }
    stored = await storedBytes(d1, scopes);
    if (pending) {
      more = true;
      break;
    }
    if (stored <= policy.capBytes) break;
    const victim = rows
      .filter((r) => r.status === "published" && !r.current)
      .sort(
        (a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.seq - b.seq,
      )[0];
    if (!victim) break; // Only current (and a building snapshot) left: admission decides.
    await expire(d1, [victim], "storage", nowIso);
    expired.push({ id: victim.id, scope: victim.scope, seq: victim.seq, reason: "storage" });
    rows = rows.filter((r) => r.id !== victim.id);
  }

  const cutoff = new Date(now.getTime() - policy.recordTtlMs).toISOString();
  await batch(d1, [
    raw(
      `UPDATE atlas_scopes SET retention_pending = ? WHERE scope IN ${inList}`,
      more ? 1 : 0,
      JSON.stringify(scopes),
    ),
    ...purgeRecords(cutoff, scopes),
  ]);
  return { expired, reclaimed, storedBytes: stored, capBytes: policy.capBytes, more };
}

/**
 * Forget expired snapshots whose rows are all gone and failed ones older than
 * current, once older than `cutoff`. Bounded; `scopes` null means every scope.
 */
function purgeRecords(cutoff: string, scopes: string[] | null): Statement[] {
  const inScope = scopes ? `AND scope IN ${inList}` : "";
  const params = scopes ? [JSON.stringify(scopes)] : [];
  return [
    raw(
      `DELETE FROM atlas_snapshots WHERE rowid IN (
         SELECT rowid FROM atlas_snapshots
         WHERE ((status = 'expired' AND bytes <= 0 AND expires_at < ?)
             OR (status = 'failed' AND created_at < ?
                 AND seq < coalesce((SELECT seq FROM atlas_current c WHERE c.scope = atlas_snapshots.scope), 0)))
           ${inScope}
         LIMIT 1000)`,
      cutoff,
      cutoff,
      ...params,
    ),
  ];
}

export type Admission =
  | { admitted: true; storedBytes: number; capBytes: number }
  | { admitted: false; storedBytes: number; capBytes: number; error: string };

const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

/**
 * Decide whether a built (not yet published) snapshot fits its pool's cap.
 * Run after `enforceRetention` has nothing left to do, so every prior that
 * could make room is gone. If it still doesn't fit, it fails with
 * `failure = 'capacity'` and is rolled back; the previous snapshot stays
 * current (stale). Safe to repeat: a snapshot no longer building isn't admitted.
 */
export async function admitProjection(
  d1: D1Database,
  scope: string,
  snapshotId: string,
  options: { scopes?: string[]; policy?: Partial<RetentionPolicy> } = {},
): Promise<Admission> {
  const policy = {
    ...REPO_RETENTION,
    ...(await scopePolicy(d1, options.scopes ?? [scope])),
    ...options.policy,
  };
  const capBytes = policy.capBytes;
  const snapshot = await db(d1)
    .selectFrom("atlas_snapshots")
    .select(["status", "error"])
    .where("id", "=", snapshotId)
    .where("scope", "=", scope)
    .executeTakeFirst();
  const stored = await storedBytes(d1, options.scopes ?? [scope]);
  if (snapshot?.status !== "building")
    return {
      admitted: false,
      storedBytes: stored,
      capBytes,
      error: snapshot?.error ?? "The snapshot is no longer being built.",
    };
  if (stored <= capBytes) return { admitted: true, storedBytes: stored, capBytes };
  const error =
    `Capacity: this snapshot needs ${gib(stored)} of projection storage with every prior ` +
    `snapshot evicted, over the ${gib(capBytes)} cap. The previous snapshot stays current (stale).`;
  await db(d1)
    .updateTable("atlas_snapshots")
    .set({ status: "failed", failure: "capacity", error })
    .where("id", "=", snapshotId)
    .where("status", "=", "building")
    .execute();
  await failProjection(d1, scope, snapshotId, error);
  return { admitted: false, storedBytes: stored, capBytes, error };
}

export interface CapacityFailure {
  snapshotId: string;
  seq: number;
  error: string;
  failedAt: string;
}

/**
 * The capacity failure that left a scope's current snapshot stale, if any: the
 * newest snapshot after current that failed for capacity.
 */
export async function capacityFailure(
  d1: D1Database,
  scope: string,
): Promise<CapacityFailure | null> {
  const row = await d1
    .prepare(
      `SELECT id, seq, error, created_at FROM atlas_snapshots
       WHERE scope = ?1 AND status = 'failed' AND failure = 'capacity'
         AND seq > coalesce((SELECT seq FROM atlas_current WHERE scope = ?1), 0)
       ORDER BY seq DESC LIMIT 1`,
    )
    .bind(scope)
    .first<{ id: string; seq: number; error: string | null; created_at: string }>();
  return row
    ? { snapshotId: row.id, seq: Number(row.seq), error: row.error ?? "", failedAt: row.created_at }
    : null;
}

export type PinnedSnapshot =
  | { state: "ok"; snapshot: AtlasSnapshot }
  | {
      state: "expired";
      snapshotId: string;
      seq: number;
      expiredAt: string;
      reason: ExpiredReason;
      /** What to offer instead, explicitly: the scope's current snapshot. */
      current: AtlasSnapshot | null;
    }
  | { state: "unknown" };

/**
 * Resolve a snapshot a request is pinned to. Unknown covers never-existed,
 * other-scope, unpublished and failed snapshots; a prior past its expiry
 * answers expired even before the sweep has marked it.
 */
export async function pinnedSnapshot(
  d1: D1Database,
  scope: string,
  id: string,
  now: Date = new Date(),
): Promise<PinnedSnapshot> {
  const row = await db(d1)
    .selectFrom("atlas_snapshots as s")
    // By scope, atlas_current's key: joining on the snapshot id alone scanned
    // every repository's pointer on each pinned page (CORE-177).
    .leftJoin("atlas_current as c", (join) =>
      join.onRef("c.scope", "=", "s.scope").onRef("c.snapshot_id", "=", "s.id"),
    )
    .selectAll("s")
    .select("c.snapshot_id as current_id")
    .where("s.scope", "=", scope)
    .where("s.id", "=", id)
    .executeTakeFirst();
  if (!row || (row.status !== "published" && row.status !== "expired")) return { state: "unknown" };
  const due =
    row.status === "published" &&
    !row.current_id &&
    row.expires_at !== null &&
    row.expires_at <= now.toISOString();
  if (row.status === "published" && !due) return { state: "ok", snapshot: toSnapshot(row) };
  const current = await db(d1)
    .selectFrom("atlas_current as c")
    .innerJoin("atlas_snapshots as s", "s.id", "c.snapshot_id")
    .selectAll("s")
    .where("c.scope", "=", scope)
    .executeTakeFirst();
  return {
    state: "expired",
    snapshotId: row.id,
    seq: row.seq,
    expiredAt: row.expires_at ?? now.toISOString(),
    reason: row.expired_reason ?? "age",
    current: current ? toSnapshot(current) : null,
  };
}

/**
 * When a cursor issued at `issuedAt` for a snapshot expiring at
 * `snapshotExpiresAt` (AtlasSnapshot.expiresAt; null while current) expires:
 * CURSOR_TTL_MS after issue or at snapshot expiry, whichever is first. Epoch ms.
 */
export function cursorExpiresAt(issuedAt: Date | number, snapshotExpiresAt: string | null): number {
  const ttl = new Date(issuedAt).getTime() + CURSOR_TTL_MS;
  return snapshotExpiresAt === null ? ttl : Math.min(ttl, Date.parse(snapshotExpiresAt));
}

/**
 * Hourly: resume retention for repository scopes with work left or priors due,
 * and forget old expired/failed records. Bounded to `limit` scopes per run.
 */
export async function sweepAtlasRetention(
  d1: D1Database,
  options: { now?: Date; limit?: number; policy?: Partial<RetentionPolicy> } = {},
): Promise<{ scopes: number; expired: number; more: boolean }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const policy = { ...REPO_RETENTION, ...options.policy };
  const due = await d1
    .prepare(
      `SELECT a.scope FROM atlas_scopes a
       WHERE a.kind = 'repo' AND (a.retention_pending = 1 OR EXISTS (
         SELECT 1 FROM atlas_snapshots s
         WHERE s.scope = a.scope AND s.status = 'published'
           AND s.id NOT IN (SELECT snapshot_id FROM atlas_current WHERE scope = a.scope)
           AND (s.expires_at IS NULL OR s.expires_at <= ?))
         OR (SELECT count(*) FROM atlas_snapshots s
             WHERE s.scope = a.scope AND s.status = 'published') > ?)
       ORDER BY a.retention_pending DESC, a.scope LIMIT ?`,
    )
    .bind(now.toISOString(), policy.maxPrior + 1, limit + 1)
    .all<{ scope: string }>();
  let expired = 0;
  let more = due.results.length > limit;
  for (const { scope } of due.results.slice(0, limit)) {
    try {
      const result = await enforceRetention(d1, [scope], { now, policy: options.policy });
      expired += result.expired.length;
      more ||= result.more;
    } catch (error) {
      console.error("Atlas retention failed", scope, error);
    }
  }
  await batch(d1, purgeRecords(new Date(now.getTime() - policy.recordTtlMs).toISOString(), null));
  return { scopes: Math.min(due.results.length, limit), expired, more };
}
