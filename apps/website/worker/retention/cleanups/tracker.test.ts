// The tracker categories through the engine (CORE-203): runs reach the
// account's Tracker Durable Object over RPC (the real class, its SQL storage
// over node:sqlite), a dry run lists what the run then removes, the run is
// audited, and running again finds nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { Mutation } from "../../../shared/tracker.ts";
import { fakeDurableObjectId, fakeDurableState } from "../../testing/durable-state.ts";
import { createFreshSpaceTestEnvironment } from "../../testing/spaces.ts";
import { Tracker } from "../../tracker/object.ts";
import { accessFor } from "../../tracker/access.ts";
import { findSpaceById } from "../../spaces/access.ts";
import { issueToken } from "../../api/tokens.ts";
import { advanceRun, createRun, getRun, type RetentionAuthority } from "../runs.ts";
import { closedIssues, trackerActivity } from "./tracker.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const ORBIT = { kind: "space", id: "acc_orbit" } as const;

async function setup(seedTracker = true, name = "acc_orbit") {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  onTestFinished(close);
  sqlite.exec("BEGIN");
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  sqlite.exec("COMMIT");
  const space = await findSpaceById(env.DB, "acc_orbit");
  if (!space) throw new Error("Missing fixture Space");
  const token = await issueToken(env.DB, "acc_marco", "retention-fixture", "write");
  const access = await accessFor(env, space, "acc_marco", null, true, {
    kind: "token",
    id: token.id,
  });
  const { ctx, db } = fakeDurableState({ name });
  onTestFinished(() => db.close());
  const tracker = new Tracker(ctx, env);
  Object.assign(env, {
    TRACKER: {
      idFromName: fakeDurableObjectId,
      getByName: () => tracker,
    },
  });
  let operation = 0;
  const mutate = async (mutations: Mutation[]) => {
    const reply = await tracker.mutate(access, {
      contractVersion: 4,
      spaceId: access.spaceId,
      migrationEpoch: access.migrationEpoch,
      operationId: `op-${++operation}`,
      mutations,
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  if (seedTracker) {
    await mutate([{ kind: "team.create", id: "team", data: { key: "ORB", name: "Orbit" } }]);
    for (const id of ["done-1", "done-2", "open"])
      await mutate([{ kind: "issue.create", id, data: { teamId: "team", title: id } }]);
    for (const id of ["done-1", "done-2"])
      await mutate([{ kind: "issue.update", id, expectedVersion: 1, data: { status: "done" } }]);
  }
  const authority: RetentionAuthority = {
    id: "acc_marco",
    slug: "marco",
    displayName: "Marco",
    isSiteAdmin: false,
    migrationEpoch: access.migrationEpoch,
    credential: { kind: "token", id: token.id },
  };
  return { env, tracker, mutate, access, ctx, authority };
}

async function run(
  env: Env,
  dryRun: boolean,
  category: string,
  now: Date,
  authority?: RetentionAuthority,
) {
  const thresholds: Record<string, number> =
    category === "closed-issues" ? { days: 365 } : { eventDays: 365, endedTimelineDays: 180 };
  const id = await createRun(env.DB, {
    target: ORBIT,
    trigger: authority ? "manual" : "schedule",
    actorId: authority?.id ?? null,
    authority,
    dryRun,
    categories: [{ id: category, thresholds }],
    now,
  });
  const seen: string[] = [];
  let state;
  do
    state = await advanceRun(env, id, {
      now,
      limit: 1,
      afterBatch: async (_category, items) => void seen.push(...(items as string[])),
    });
  while (state === "more");
  return { seen, run: (await getRun(env.DB, ORBIT, id))! };
}

describe("tracker retention through the engine", () => {
  for (const [category, cleanup] of [
    ["closed-issues", closedIssues],
    ["tracker-activity", trackerActivity],
  ] as const) {
    test(`${category}: manual dry run opens a never-used epoch-zero Space`, async () => {
      const t = await setup(false);
      expect(t.access.migrationEpoch).toBe(0);
      expect(
        t.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray(),
      ).toEqual([]);
      const result = await run(t.env, true, category, new Date(), t.authority);
      expect(result.seen).toEqual([]);
      expect(result.run).toMatchObject({
        status: "succeeded",
        dryRun: true,
        items: 0,
        bytes: 0,
        categories: [{ category, status: "succeeded" }],
      });
      expect(t.ctx.storage.sql.exec("SELECT * FROM space_migration_scope").one()).toMatchObject({
        contract_version: 4,
        space_id: ORBIT.id,
        migration_epoch: 0,
      });
    });

    test(`${category}: removal opens a never-used epoch-zero Space`, async () => {
      const t = await setup(false);
      expect(
        await cleanup.remove(
          {
            env: t.env,
            target: ORBIT,
            now: new Date(),
            limit: 10,
            thresholds: { days: 365, eventDays: 365, endedTimelineDays: 180 },
          },
          [],
        ),
      ).toEqual({ count: 0, bytes: 0 });
      expect(t.ctx.storage.sql.exec("SELECT * FROM space_migration_scope").one()).toMatchObject({
        space_id: ORBIT.id,
        migration_epoch: 0,
      });
    });

    for (const refusal of ["wrong-object", "wrong-scope", "legacy"] as const) {
      test(`${category}: select and remove refuse ${refusal}`, async () => {
        const t = await setup(
          refusal === "wrong-scope",
          refusal === "wrong-object" ? "other" : ORBIT.id,
        );
        if (refusal === "wrong-scope")
          t.ctx.storage.sql.exec("UPDATE space_migration_scope SET space_id='other'");
        if (refusal === "legacy")
          t.ctx.storage.sql.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY)");
        const context = {
          env: t.env,
          target: ORBIT,
          now: new Date(),
          limit: 10,
          thresholds: { days: 365, eventDays: 365, endedTimelineDays: 180 },
        };
        await expect(cleanup.select(context, null)).rejects.toThrow(/space_migration_fenced/);
        await expect(cleanup.remove(context, [])).rejects.toThrow(/space_migration_fenced/);
      });
    }
  }

  test("closed issues: dry run, run, again; the tracker answers for removed keys", async () => {
    const t = await setup();
    const later = new Date(Date.now() + 400 * 86_400_000);
    const dry = await run(t.env, true, "closed-issues", later);
    expect(dry.seen).toEqual(["done-1", "done-2"]);
    expect(dry.run).toMatchObject({ status: "succeeded", dryRun: true });
    expect(dry.run.items).toBeGreaterThan(2);
    const real = await run(t.env, false, "closed-issues", later);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({
      status: "succeeded",
      dryRun: false,
      items: dry.run.items,
      bytes: dry.run.bytes,
      categories: [{ category: "closed-issues", batches: 2, status: "succeeded" }],
    });
    const snapshot = await t.tracker.snapshot(t.access);
    expect(snapshot.ok && snapshot.value.issues.map((issue) => issue.id)).toEqual(["open"]);
    expect(await t.tracker.history(t.access, "ORB-1", null, 10)).toMatchObject({
      ok: false,
      status: 404,
      code: "removed_by_retention",
    });
    expect((await run(t.env, false, "closed-issues", later)).run).toMatchObject({
      items: 0,
      bytes: 0,
    });
    // Not yet a year: nothing.
    expect((await run(t.env, true, "closed-issues", new Date())).seen).toEqual([]);
  });

  test("activity: a dry run equals the run, and a stale replica must start over", async () => {
    const t = await setup();
    const before = await t.tracker.changes(t.access, 0, 500);
    const later = new Date(Date.now() + 400 * 86_400_000);
    const dry = await run(t.env, true, "tracker-activity", later);
    const real = await run(t.env, false, "tracker-activity", later);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ items: dry.run.items, bytes: dry.run.bytes });
    // The closed issues' creations went; each thing's newest event stayed.
    expect(dry.seen.filter((item) => item.startsWith("e:"))).toHaveLength(2);
    expect(before.ok).toBe(true);
    expect(await t.tracker.changes(t.access, 0, 500)).toMatchObject({
      ok: false,
      status: 410,
      code: "cursor_expired",
    });
    const latest = before.ok ? before.value.cursor : 0;
    expect(await t.tracker.changes(t.access, latest, 500)).toMatchObject({ ok: true });
  });
});
