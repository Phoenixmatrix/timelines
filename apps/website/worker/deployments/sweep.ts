// The preview sweep (CORE-79), hourly from the Worker's cron: timeline
// previews expire by the account's retention (TIMELINES-RESEARCH.md,
// Decisions): `endedDays` after the timeline lands or is abandoned and
// `idleDays` after its last push (2 and 7 by default; org owners change them).
//
// Each live timeline preview's expiry is kept to those rules, unless its
// recorder pinned one. A timeline's previews in one repository are torn down
// together once every one of them is due: they're marked expired (the records
// stay), and a `teardown` run starts at the newest one's commit, with its
// checkpoint, when the repository's ci.yml there opts in to previews.

import { previewExpiry, type PreviewSettings } from "../../shared/deployments.ts";
import type { Timeline } from "../../shared/timelines.ts";
import { batch, db, nowIso, type DB } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { startPreviewRuns, type PreviewRunResult } from "./previews.ts";
import { previewSettings } from "./settings.ts";

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
      "d.timeline_slug",
      "d.timeline_id",
      "d.checkpoint_id",
      "d.commit_oid",
      "d.expires_at",
      "d.expiry_pinned",
      "d.revived",
      "d.created_at",
      "p.owner_id",
      "p.artifacts_name",
      "p.artifacts_remote",
      "p.default_branch",
    ])
    .where("d.status", "in", ["active", "sleeping"])
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

/** Each owner's retention and timelines; null when the tracker can't answer now. */
async function ownerState(
  env: Env,
  ownerId: string,
): Promise<{ settings: PreviewSettings; timelines: Timeline[] } | null> {
  try {
    const [settings, reply] = await Promise.all([
      previewSettings(env.DB, ownerId),
      trackerObject(env, ownerId).listTimelines(),
    ]);
    if (!reply.ok) throw new Error(reply.error);
    return { settings, timelines: reply.value };
  } catch (error) {
    // Without the timelines nothing is known to be due: try again next hour.
    console.warn("Previews: the sweep skipped an account", { ownerId, error });
    return null;
  }
}

export async function sweepPreviews(
  env: Env,
  options: { now?: number; waitUntil: (work: Promise<unknown>) => void },
): Promise<SweepResult> {
  const now = options.now ?? Date.now();
  const kdb = db(env.DB);
  const rows = await livePreviews(kdb).execute();
  const result: SweepResult = { moved: 0, expired: [], teardowns: [] };

  const owners = new Map<string, Row[]>();
  for (const row of rows) owners.set(row.owner_id, [...(owners.get(row.owner_id) ?? []), row]);

  for (const [ownerId, previews] of owners) {
    const state = await ownerState(env, ownerId);
    if (!state) continue;
    const byId = new Map(state.timelines.map((t) => [t.id, t]));
    const bySlug = new Map(state.timelines.map((t) => [t.slug, t]));

    // Each preview's expiry: the recorder's, or the account's rules.
    const expiry = new Map<number, string | null>();
    const moves = [];
    for (const row of previews) {
      if (row.expiry_pinned) {
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
      const key = `${row.repo_id}\0${row.timeline_slug}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const due = group.every((row) => {
        const at = expiry.get(row.id);
        return at != null && Date.parse(at) <= now;
      });
      if (!due) continue;
      try {
        result.teardowns.push(...(await tearDown(env, group, options.waitUntil, result)));
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
  waitUntil: (work: Promise<unknown>) => void,
  result: SweepResult,
): Promise<PreviewRunResult[]> {
  const kdb = db(env.DB);
  const at = nowIso();
  // Claimed by the update, so overlapping sweeps start one teardown.
  const claimed = await kdb
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
  if (!claimed.length) return [];
  const ids = claimed.map((row) => row.id);
  result.expired.push(...ids);
  const newest = group.filter((row) => ids.includes(row.id)).at(-1)!;
  const runs = await startPreviewRuns(
    env,
    [
      {
        repo: {
          id: newest.repo_id,
          artifacts_name: newest.artifacts_name,
          artifacts_remote: newest.artifacts_remote,
          default_branch: newest.default_branch,
        },
        commit: newest.commit_oid,
        preview: {
          action: "teardown",
          timeline: newest.timeline_slug!,
          checkpoint: newest.checkpoint_id,
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
  return runs;
}
