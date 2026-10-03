// Resolving the snapshot an Atlas read is pinned to (CORE-160).
//
// A pinned read names its snapshot; it either gets exactly that snapshot or an
// explicit unknown/expired answer, never the current one in its place. Only
// published snapshots are readable: building and failed ones don't exist as
// far as readers are concerned. A snapshot is expired once retention marks it
// so or its expires_at has passed.

import type { AtlasSnapshotRef, AtlasVectorEntry } from "../../shared/atlas.ts";
import { db } from "../schema.ts";

export type Pinned =
  | { state: "ok"; snapshot: AtlasSnapshotRef }
  | { state: "unknown" }
  | { state: "expired"; snapshot: AtlasSnapshotRef };

type SnapshotRow = {
  id: string;
  seq: number;
  status: string;
  partial: number;
  projection_version: number;
  vector: string;
  published_at: string | null;
  expires_at: string | null;
};

const toRef = (row: SnapshotRow): AtlasSnapshotRef => ({
  id: row.id,
  seq: Number(row.seq),
  vector: JSON.parse(row.vector) as AtlasVectorEntry[],
  publishedAt: row.published_at,
  partial: Boolean(row.partial),
  projectionVersion: Number(row.projection_version),
  expiresAt: row.expires_at,
});

const COLUMNS = [
  "s.id",
  "s.seq",
  "s.status",
  "s.partial",
  "s.projection_version",
  "s.vector",
  "s.published_at",
  "s.expires_at",
] as const;

/** Whether a snapshot is past retention at `now`. */
export function snapshotExpired(
  snapshot: { status?: string; expiresAt: string | null },
  now: number,
): boolean {
  if (snapshot.status === "expired") return true;
  if (!snapshot.expiresAt) return false;
  const at = Date.parse(snapshot.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** The snapshot `id` of `scope`, if it was published and hasn't expired. */
export async function pinnedSnapshot(
  d1: D1Database,
  scope: string,
  id: string,
  now = Date.now(),
): Promise<Pinned> {
  const row = await db(d1)
    .selectFrom("atlas_snapshots as s")
    .select(COLUMNS)
    .where("s.scope", "=", scope)
    .where("s.id", "=", id)
    .executeTakeFirst();
  if (!row || (row.status !== "published" && row.status !== "expired")) return { state: "unknown" };
  const snapshot = toRef(row);
  if (snapshotExpired({ status: row.status, expiresAt: row.expires_at }, now))
    return { state: "expired", snapshot };
  return { state: "ok", snapshot };
}

/** The scope's current snapshot, or null before its first publication. */
export async function currentPinned(
  d1: D1Database,
  scope: string,
): Promise<AtlasSnapshotRef | null> {
  const row = await db(d1)
    .selectFrom("atlas_current as c")
    .innerJoin("atlas_snapshots as s", "s.id", "c.snapshot_id")
    .select(COLUMNS)
    .where("c.scope", "=", scope)
    .executeTakeFirst();
  return row ? toRef(row) : null;
}
