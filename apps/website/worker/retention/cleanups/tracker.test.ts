// The tracker categories through the engine (CORE-203): runs reach the
// account's Tracker Durable Object over RPC (the real class, its SQL storage
// over node:sqlite), a dry run lists what the run then removes, the run is
// audited, and running again finds nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../../testing/d1.ts";
import { fakeDurableState } from "../../testing/durable-state.ts";
import { Tracker } from "../../tracker/object.ts";
import type { Access } from "../../tracker/store.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";

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

const ORBIT = { scope: "account", accountId: "acc_orbit" } as const;
const access: Access = {
  actorId: "acc_marco",
  principalId: "acc_marco",
  agents: [],
  owner: { id: "acc_orbit", slug: "orbit", displayName: "Orbit" },
  canAdmin: true,
  members: [{ id: "acc_marco", slug: "marco", displayName: "Marco" }],
  repos: [],
};

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  const env = { DB: d1(sqlite) } as unknown as Env;
  const { ctx } = fakeDurableState();
  const tracker = new Tracker(ctx, env);
  const names: string[] = [];
  Object.assign(env, {
    TRACKER: {
      getByName: (name: string) => {
        names.push(name);
        return tracker;
      },
    },
  });
  let operation = 0;
  const mutate = (mutations: object[]) => {
    const reply = tracker.mutate(access, {
      operationId: `op-${++operation}`,
      mutations: mutations as never,
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  mutate([{ kind: "team.create", id: "team", data: { key: "ORB", name: "Orbit" } }]);
  for (const id of ["done-1", "done-2", "open"])
    mutate([{ kind: "issue.create", id, data: { teamId: "team", title: id } }]);
  for (const id of ["done-1", "done-2"])
    mutate([{ kind: "issue.update", id, expectedVersion: 1, data: { status: "done" } }]);
  return { env, tracker, names, mutate };
}

async function run(env: Env, dryRun: boolean, category: string, now: Date) {
  const thresholds: Record<string, number> =
    category === "closed-issues" ? { days: 365 } : { eventDays: 365, endedTimelineDays: 180 };
  const id = await createRun(env.DB, {
    target: ORBIT,
    trigger: "manual",
    actorId: "acc_marco",
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
  test("closed issues: dry run, run, again; the tracker answers for removed keys", async () => {
    const t = setup();
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
    expect(t.names.every((name) => name === "acc_orbit")).toBe(true);
    const snapshot = t.tracker.snapshot(access);
    expect(snapshot.ok && snapshot.value.issues.map((issue) => issue.id)).toEqual(["open"]);
    expect(t.tracker.history(access, "ORB-1", null, 10)).toMatchObject({
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
    const t = setup();
    const before = t.tracker.changes(0, 500);
    const later = new Date(Date.now() + 400 * 86_400_000);
    const dry = await run(t.env, true, "tracker-activity", later);
    const real = await run(t.env, false, "tracker-activity", later);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ items: dry.run.items, bytes: dry.run.bytes });
    // The closed issues' creations went; each thing's newest event stayed.
    expect(dry.seen.filter((item) => item.startsWith("e:"))).toHaveLength(2);
    expect(before.ok).toBe(true);
    expect(t.tracker.changes(0, 500)).toMatchObject({
      ok: false,
      status: 410,
      code: "cursor_expired",
    });
    const latest = before.ok ? before.value.cursor : 0;
    expect(t.tracker.changes(latest, 500)).toMatchObject({ ok: true });
  });
});
