import { sql, type Selectable } from "kysely";
import type { AiSnapshot } from "../../shared/ai.ts";
import type { QueueEntry, QueueResolution } from "../../shared/merge-queue.ts";
import type { Actor } from "../db.ts";
import { batch, db, type Database } from "../schema.ts";
import type { WorkAuthority } from "../../shared/ci.ts";

export interface QueueState {
  entry: QueueEntry;
  authority: WorkAuthority;
  actor: Pick<Actor, "id" | "agent">;
  snapshot: AiSnapshot;
  mergeSource: string;
  combinedIds: string[];
  rebaseAttempts: number;
  mergeRunId: string | null;
  gateRunId: string | null;
  deployRunId: string | null;
  resolution: QueueResolution | null;
  resolutionInput: string | null;
  resolutionClaimed: boolean;
  classificationClaimed: boolean;
  effectsPending: boolean;
  remediationPending: boolean;
  history: QueueEntry[];
}
export interface StoredQueue extends QueueState {
  version: number;
}
type Row = Selectable<Database["merge_queue"]>;
export function decode(row: Row): StoredQueue {
  return { ...(JSON.parse(row.data) as QueueState), version: row.version };
}
export async function getQueue(
  d1: D1Database,
  repoId: string,
  id: string,
): Promise<StoredQueue | null> {
  const row = await db(d1)
    .selectFrom("merge_queue")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? decode(row) : null;
}
export async function listQueue(d1: D1Database, repoId: string): Promise<StoredQueue[]> {
  const k = db(d1);
  // Separate budgets keep a failed Tracker/effect outbox from starving work.
  const active = await k
    .selectFrom("merge_queue")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("status", "in", ["queued", "merging", "testing", "advancing"])
    .orderBy(sql`CASE WHEN status = 'queued' THEN 1 ELSE 0 END`)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(64)
    .execute();
  const effects = await k
    .selectFrom("merge_queue")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("status", "in", ["landed", "failed", "cancelled"])
    .where(
      sql<boolean>`(json_extract(data, '$.effectsPending') = 1 OR json_extract(data, '$.remediationPending') = 1 OR (status = 'landed' AND json_extract(data, '$.entry.deployStatus') NOT IN ('succeeded','failed','cancelled')))`,
    )
    .orderBy("recovered_at", "asc")
    .orderBy("created_at", "asc")
    .limit(32)
    .execute();
  const cancelled = await k
    .selectFrom("merge_queue")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("status", "=", "cancelled")
    .orderBy("created_at", "desc")
    .limit(101)
    .execute();
  const unique = new Map([...active, ...effects, ...cancelled].map((row) => [row.id, row]));
  return [...unique.values()].map(decode);
}
function columns(state: QueueState) {
  const e = state.entry;
  return {
    status: e.status,
    attempts: e.attempts,
    merge_run_id: state.mergeRunId,
    gate_run_id: state.gateRunId,
    base: e.base,
    candidate: e.candidate,
    covered_by: e.coveredBy,
    data: JSON.stringify(state),
    updated_at: e.updatedAt,
  };
}
export async function admitQueue(d1: D1Database, state: QueueState): Promise<boolean> {
  const e = state.entry;
  const result = await db(d1)
    .insertInto("merge_queue")
    .columns([
      "repo_id",
      "id",
      "created_at",
      "status",
      "attempts",
      "merge_run_id",
      "gate_run_id",
      "base",
      "candidate",
      "covered_by",
      "data",
      "updated_at",
    ])
    .expression((eb) =>
      eb
        .selectFrom("repos")
        .select([
          "id as repo_id",
          eb.val(e.id).as("id"),
          eb.val(e.createdAt).as("created_at"),
          eb.val(e.status).as("status"),
          eb.val(e.attempts).as("attempts"),
          eb.val(state.mergeRunId).as("merge_run_id"),
          eb.val(state.gateRunId).as("gate_run_id"),
          eb.val(e.base).as("base"),
          eb.val(e.candidate).as("candidate"),
          eb.val(e.coveredBy).as("covered_by"),
          eb.val(JSON.stringify(state)).as("data"),
          eb.val(e.updatedAt).as("updated_at"),
        ])
        .where("id", "=", e.repo.id)
        .where("deleted_at", "is", null),
    )
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows) === 1;
}
/**
 * A partial unique index arbitrates queued -> active across isolates.
 * Coverage mutations also fence the observed leader in this same statement:
 * a null version requires its absence, otherwise the exact version must match.
 */
export async function saveQueue(
  d1: D1Database,
  before: StoredQueue,
  state: QueueState,
  leader?: { id: string; version: number | null },
): Promise<StoredQueue | null> {
  const { version: _version, ...plain } = state as StoredQueue;
  plain.entry = { ...plain.entry, updatedAt: new Date().toISOString() };
  try {
    const row = await db(d1)
      .updateTable("merge_queue")
      .set({ ...columns(plain), version: before.version + 1 })
      .where("repo_id", "=", before.entry.repo.id)
      .where("id", "=", before.entry.id)
      .where("version", "=", before.version)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("repos")
            .select("id")
            .where("id", "=", before.entry.repo.id)
            .where("deleted_at", "is", null),
        ),
      )
      .$if(!!leader, (query) =>
        query.where((eb) => {
          const owner = eb
            .selectFrom("merge_queue as leader")
            .select("leader.id")
            .where("leader.repo_id", "=", before.entry.repo.id)
            .where("leader.id", "=", leader!.id);
          return leader!.version === null
            ? eb.not(eb.exists(owner))
            : eb.exists(owner.where("leader.version", "=", leader!.version));
        }),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? decode(row) : null;
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: merge_queue.repo_id")) return null;
    throw error;
  }
}

/** Cancel one member and fence its combined attempt in the same D1 transaction. */
export async function cancelCombined(
  d1: D1Database,
  member: StoredQueue,
  leader: StoredQueue,
): Promise<boolean> {
  const k = db(d1),
    now = new Date().toISOString(),
    repo = member.entry.repo.id;
  const cancelled: QueueState = {
    ...member,
    entry: { ...member.entry, status: "cancelled", updatedAt: now },
  };
  const requeued: QueueState = {
    ...leader,
    history: [...leader.history, leader.entry],
    entry: { ...leader.entry, status: "queued", base: null, candidate: null, updatedAt: now },
  };
  const results = await batch(d1, [
    k
      .updateTable("merge_queue")
      .set({ ...columns(cancelled), version: member.version + 1 })
      .where("repo_id", "=", repo)
      .where("id", "=", member.entry.id)
      .where("version", "=", member.version)
      .where("status", "=", "queued")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("repos")
            .select("id")
            .where("id", "=", repo)
            .where("deleted_at", "is", null),
        ),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("merge_queue as leader")
            .select("leader.id")
            .where("leader.repo_id", "=", repo)
            .where("leader.id", "=", leader.entry.id)
            .where("leader.version", "=", leader.version)
            .where("leader.status", "in", ["merging", "testing"]),
        ),
      ),
    k
      .updateTable("merge_queue")
      .set({ ...columns(requeued), version: leader.version + 1 })
      .where("repo_id", "=", repo)
      .where("id", "=", leader.entry.id)
      .where("version", "=", leader.version)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("merge_queue as member")
            .select("member.id")
            .where("member.repo_id", "=", repo)
            .where("member.id", "=", member.entry.id)
            .where("member.version", "=", member.version + 1)
            .where("member.status", "=", "cancelled"),
        ),
      ),
  ]);
  return results.every((result) => result.meta.changes === 1);
}
