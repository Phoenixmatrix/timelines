// The preview sweep (CORE-79), hourly from the Worker's cron: timeline
// previews expire by the Space's retention: endedDays after the timeline
// lands or is abandoned, or idleDays after its last push. Space admins
// configure both rules.
//
// Each live timeline preview's expiry is kept to those rules, unless its
// recorder pinned one. A timeline's previews in one repository are torn down
// together once every one of them is due: they're marked expired (the records
// stay), and a `teardown` run starts at the newest one's commit, with its
// checkpoint, when the repository's ci.yml there opts in to previews.
//
// Applying a Space's retention rules is the Instance's scheduled service
// policy: it may move an expiry by those rules and mark a due preview expired
// without a person's authority, and it never creates or extends anything for
// one. Starting a teardown run acts as a person, so it needs every record's
// own live initiating authority. A record from before Spaces has none: it is
// marked expired and left out of later sweeps, and its resources go when an
// authorized teardown in its repository reconciles previews no live record
// explains (CORE-372, CORE-388), or when a person takes the record over.

import { previewExpiry, type PreviewSettings } from "../../shared/deployments.ts";
import type { Timeline } from "../../shared/timelines.ts";
import { batch, db, nowIso, type DB } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { startPreviewRuns, type PreviewRunResult } from "./previews.ts";
import { previewSettings } from "./settings.ts";
import { parseWorkAuthority, resolveWorkAuthority } from "../ci/admission.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";

/** Live previews looked at per sweep; the rest wait for the next hour. */
const MAX_PREVIEWS = 1000;
const MOVES_PER_BATCH = 100;

const livePreviews = (kdb: DB) =>
  kdb
    .selectFrom("deployments as d")
    .innerJoin("repos as p", "p.id", "d.repo_id")
    .select([
      "d.id",
      "d.repo_id",
      "d.source_id",
      "d.authority",
      "d.timeline_slug",
      "d.timeline_id",
      "d.checkpoint_id",
      "d.commit_oid",
      "d.expires_at",
      "d.expiry_pinned",
      "d.revived",
      "d.created_at",
      "d.status",
      "d.teardown_run_id",
      "p.space_id",
      "p.artifacts_name",
      "p.artifacts_remote",
      "p.default_branch",
    ])
    .where((eb) =>
      eb.or([
        eb("d.status", "in", ["active", "sleeping"]),
        eb.and([
          eb("d.status", "=", "expired"),
          eb("d.teardown_completed_at", "is", null),
          eb("d.teardown_unmanaged_at", "is", null),
          eb("d.teardown_run_id", "is", null),
          // Expired without an initiating authority: no run can start for it.
          eb("d.authority", "is not", null),
        ]),
      ]),
    )
    .where("d.timeline_slug", "is not", null)
    // A repository's deletion tears down its own previews (CORE-199).
    .where("p.deleted_at", "is", null)
    .orderBy("d.id")
    .limit(MAX_PREVIEWS);

type Row = Awaited<ReturnType<ReturnType<typeof livePreviews>["execute"]>>[number];

export interface SweepResult {
  /** Records whose rule-based expiry moved. */
  moved: number;
  /** Records marked expired. */
  expired: number[];
  /** Teardown runs, one per repository and timeline torn down. */
  teardowns: PreviewRunResult[];
}

/** Whether a record's own initiating authority is still live. */
async function authorized(env: Env, row: Row): Promise<boolean> {
  try {
    await resolveWorkAuthority(env, parseWorkAuthority(row.authority), row.repo_id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Space's rules and timelines, read with the first record whose current
 * initiating credential independently authorizes Tracker reads. One revoked
 * or pre-Spaces record never hides the Space's other previews.
 */
async function spaceState(
  env: Env,
  previews: Row[],
  live: Set<number>,
): Promise<{ settings: PreviewSettings; timelines: Timeline[] } | null> {
  for (const row of previews) {
    if (!live.has(row.id)) continue;
    const state = await stateFor(env, row);
    if (state) return state;
  }
  console.warn("Previews: no live authority reads this Space's timelines", {
    spaceId: previews[0]?.space_id,
  });
  return null;
}

async function stateFor(
  env: Env,
  row: Row,
): Promise<{ settings: PreviewSettings; timelines: Timeline[] } | null> {
  try {
    const authority = parseWorkAuthority(row.authority);
    await resolveWorkAuthority(env, authority, row.repo_id);
    const space = await findSpaceById(env.DB, authority.spaceId);
    if (!space) throw new Error("Preview Space is unavailable.");
    const access = await accessFor(
      env,
      space,
      authority.personId,
      authority.agentId,
      false,
      authority.credential,
    );
    const [settings, reply] = await Promise.all([
      previewSettings(env.DB, space.id),
      trackerObject(env, space.id).listTimelines(access),
    ]);
    if (!reply.ok) throw new Error(reply.error);
    return { settings, timelines: reply.value };
  } catch (error) {
    console.warn("Previews: a record couldn't read its Space's timelines", {
      spaceId: row.space_id,
      deployment: row.id,
      error,
    });
    return null;
  }
}

export async function sweepPreviews(
  env: Env,
  options: { now?: number; waitUntil: (work: Promise<unknown>) => void },
): Promise<SweepResult> {
  const now = options.now ?? Date.now();
  const kdb = db(env.DB);
  // Retry only acknowledged failed/cancelled teardown attempts, never leases.
  await env.DB.prepare(`UPDATE deployments SET teardown_run_id=NULL
    WHERE status='expired' AND teardown_completed_at IS NULL AND teardown_unmanaged_at IS NULL
      AND EXISTS (SELECT 1 FROM ci_runs c WHERE c.id=deployments.teardown_run_id
        AND c.status IN ('failed','cancelled')
        AND NOT EXISTS (SELECT 1 FROM ci_jobs j WHERE j.run_id=c.id
          AND (j.status IN ('pending','queued','running') OR j.source_completion_pending=1)))`).run();
  const rows = await livePreviews(kdb).execute();
  const result: SweepResult = { moved: 0, expired: [], teardowns: [] };

  const spaces = new Map<string, Row[]>();
  for (const row of rows) spaces.set(row.space_id, [...(spaces.get(row.space_id) ?? []), row]);
  for (const previews of spaces.values()) {
    const live = new Set<number>();
    for (const row of previews) if (await authorized(env, row)) live.add(row.id);
    const state = await spaceState(env, previews, live);
    const byId = new Map(state?.timelines.map((t) => [t.id, t]));
    const bySlug = new Map(state?.timelines.map((t) => [t.slug, t]));

    // Each preview's expiry: the recorder's, or the Space's rules. Without the
    // Space's timelines nothing new is known, so each recorded expiry stands.
    const expiry = new Map<number, string | null>();
    const moves = [];
    for (const row of previews) {
      if (row.expiry_pinned || !state) {
        expiry.set(row.id, row.expires_at);
        continue;
      }
      const timeline =
        (row.timeline_id ? byId.get(row.timeline_id) : undefined) ??
        bySlug.get(row.timeline_slug!) ??
        null;
      const due = previewExpiry(
        { timeline, createdAt: row.created_at, revived: row.revived === 1 },
        state.settings,
      );
      expiry.set(row.id, due);
      if (due !== row.expires_at)
        moves.push(
          kdb.updateTable("deployments").set({ expires_at: due }).where("id", "=", row.id),
        );
    }
    for (let i = 0; i < moves.length; i += MOVES_PER_BATCH)
      await batch(env.DB, moves.slice(i, i + MOVES_PER_BATCH));
    result.moved += moves.length;

    // A timeline's previews in a repository go together, once all are due.
    const groups = new Map<string, Row[]>();
    for (const row of previews) {
      const key = `${row.repo_id}\0${row.source_id}\0${row.timeline_slug}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      // A run would act on recorded expiries alone: wait for the timelines.
      if (!state && group.some((row) => live.has(row.id))) continue;
      const due = group.every((row) => {
        if (row.status === "expired") return true;
        const at = expiry.get(row.id);
        return at != null && Date.parse(at) <= now;
      });
      if (!due) continue;
      try {
        result.teardowns.push(...(await tearDown(env, group, live, options.waitUntil, result)));
      } catch (error) {
        console.error("Previews: tearing down failed", { repo: group[0]!.repo_id, error });
      }
    }
  }
  return result;
}

/** Mark a group expired, then ask the repository's CI to tear it down. */
async function tearDown(
  env: Env,
  group: Row[],
  live: Set<number>,
  waitUntil: (work: Promise<unknown>) => void,
  result: SweepResult,
): Promise<PreviewRunResult[]> {
  const kdb = db(env.DB);
  const at = nowIso();
  // Every exact source claim retains its own initiating credential; a newer
  // record must never lend rights to an older revoked or pre-Spaces one. The
  // service policy still marks the due group expired, but no run starts.
  if (!group.every((row) => live.has(row.id))) {
    const marked = await kdb
      .updateTable("deployments")
      .set({ status: "expired", torn_down_at: at, updated_at: at })
      .where(
        "id",
        "in",
        group.map((row) => row.id),
      )
      .where("status", "in", ["active", "sleeping"])
      .returning("id")
      .execute();
    result.expired.push(...marked.map((row) => row.id));
    if (marked.length)
      console.warn("Previews: expired without a teardown run; a record lacks live authority", {
        repo: group[0]!.repo_id,
        deployments: marked.map((row) => row.id),
      });
    return [];
  }
  // Claimed by the update, so overlapping sweeps start one teardown.
  const claimed = await kdb
    .updateTable("deployments")
    .set({ status: "expired", torn_down_at: at, updated_at: at })
    .where(
      "id",
      "in",
      group.map((row) => row.id),
    )
    .where("status", "in", ["active", "sleeping", "expired"])
    .where("teardown_run_id", "is", null)
    .where("teardown_completed_at", "is", null)
    .where("teardown_unmanaged_at", "is", null)
    .returning("id")
    .execute();
  if (!claimed.length) return [];
  const ids = claimed.map((row) => row.id);
  result.expired.push(...ids);
  const newest = group.filter((row) => ids.includes(row.id)).at(-1)!;
  const runs = await startPreviewRuns(
    env,
    [
      {
        authority: parseWorkAuthority(newest.authority),
        repo: {
          id: newest.repo_id,
          source_id: newest.source_id,
          artifacts_name: newest.artifacts_name,
          artifacts_remote: newest.artifacts_remote,
          default_branch: newest.default_branch,
        },
        commit: newest.commit_oid,
        preview: {
          action: "teardown",
          timeline: newest.timeline_slug!,
          checkpoint: newest.checkpoint_id,
          teardownOf: newest.id,
        },
      },
    ],
    null,
    waitUntil,
  );
  const started = runs[0];
  if (started && "number" in started) {
    await kdb
      .updateTable("deployments")
      .set({ teardown_run_id: started.runId })
      .where("id", "in", ids)
      .execute();
  }
  if (started && "skipped" in started && started.teardownUnmanaged) {
    await kdb
      .updateTable("deployments")
      .set({ teardown_unmanaged_at: at })
      .where("id", "in", ids)
      .where("teardown_run_id", "is", null)
      .execute();
  }
  return runs;
}
