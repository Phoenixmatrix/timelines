// Usage history, AI usage records and purged registry rows (CORE-225) over
// D1 with seeded history: dry run = run, a second run finds nothing, the
// usage report and every total over whole months are the same before and
// after the roll-ups, and the latest figures and live registry rows stay.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, onTestFinished, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment } from "../../testing/spaces.ts";
import { aiUsageTotals, usageTotals } from "../../usage/history.ts";
import { spaceUsageReport, instanceUsageReport } from "../../usage/report.ts";
import { CATEGORIES } from "../categories.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";

const SITE = { kind: "instance", id: "" } as const;
const DAY = 86_400_000;
const NOW = new Date("2026-10-04T12:00:00Z");
const day = (ago: number) => new Date(NOW.getTime() - ago * DAY).toISOString().slice(0, 10);
const iso = (ago: number) => new Date(NOW.getTime() - ago * DAY).toISOString();

let sqlite: DatabaseSync;
let env: Env;
beforeEach(async () => {
  const fixture = await createFreshSpaceTestEnvironment();
  onTestFinished(fixture.close);
  sqlite = fixture.sqlite;
  env = fixture.env;
  sqlite.exec("BEGIN");
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  sqlite.exec("COMMIT");
  const snapshot = sqlite.prepare(
    `INSERT INTO usage_snapshots (day, scope_kind, scope_id, construct, item, metric, kind, quantity, estimated, method, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seeded', ?)`,
  );
  const ai = sqlite.prepare(
    `INSERT INTO ai_usage (day, scope_kind, scope_id, feature, model, calls, input_tokens, output_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 120 days of an account's and the site's figures, up to yesterday.
  for (let ago = 120; ago >= 1; ago--) {
    for (const target of [
      { kind: "space", id: "acc_orbit" },
      { kind: "instance", id: "" },
    ] as const) {
      snapshot.run(
        day(ago),
        target.kind,
        target.id,
        "d1",
        "repositories",
        "rows",
        "storage",
        1000 + ago,
        0,
        iso(ago - 1),
      );
      snapshot.run(
        day(ago),
        target.kind,
        target.id,
        "d1",
        "repositories",
        "bytes",
        "storage",
        4096 * ago,
        1,
        iso(ago - 1),
      );
      snapshot.run(
        day(ago),
        target.kind,
        target.id,
        "workers_ai",
        "@cf/model",
        "calls",
        "activity",
        (ago % 7) + 1,
        0,
        iso(ago - 1),
      );
    }
    ai.run(
      day(ago),
      "person",
      "acc_marco",
      "assistant",
      "@cf/model",
      ago % 5,
      ago * 10,
      ago * 3,
      ago * 13,
    );
    ai.run(day(ago), "instance", "", "unattributed", "@cf/other", 1, 0, 0, 0);
  }
  // An account whose collection stopped 150 days ago: its latest day stays.
  for (let ago = 200; ago >= 150; ago -= 10)
    snapshot.run(
      day(ago),
      "person",
      "acc_jun",
      "r2",
      "avatars",
      "bytes",
      "storage",
      ago,
      0,
      iso(ago),
    );
  // Monthly figures from earlier roll-ups: one past 24 months, one within.
  sqlite.exec(`INSERT INTO usage_monthly (month, scope_kind, scope_id, construct, item, metric, kind, quantity, days, last_day, last_quantity, method)
    VALUES ('2024-03', 'space', 'acc_orbit', 'd1', 'repositories', 'rows', 'storage', 31000, 31, '2024-03-31', 1000, 'seeded'),
           ('2025-11', 'space', 'acc_orbit', 'd1', 'repositories', 'rows', 'storage', 30000, 30, '2025-11-30', 1000, 'seeded')`);
  // Registry rows: purged long ago, purged recently, live, and purged then used again.
  sqlite.exec(`INSERT INTO do_instances (class, name, created_at, last_active_at, purged_at, purge_reason) VALUES
    ('Assistant', 'acc_marco:old', '${iso(100)}', '${iso(60)}', '${iso(40)}', 'chat deleted'),
    ('Assistant', 'acc_marco:recent', '${iso(100)}', '${iso(20)}', '${iso(10)}', 'chat deleted'),
    ('Tracker', 'acc_orbit', '${iso(100)}', '${iso(1)}', NULL, NULL),
    ('KnowledgeCoordinator', 'repo_back', '${iso(100)}', '${iso(2)}', NULL, NULL)`);
});

async function run(category: string, dryRun: boolean, thresholds: Record<string, number>) {
  const id = await createRun(env.DB, {
    target: SITE,
    trigger: "schedule",
    actorId: null,
    dryRun,
    categories: [{ id: category, thresholds }],
    now: NOW,
  });
  const seen: string[] = [];
  let state;
  do
    state = await advanceRun(env, id, {
      now: NOW,
      limit: 50,
      afterBatch: async (_category, items) => void seen.push(...(items as string[])),
    });
  while (state === "more");
  return { seen, run: (await getRun(env.DB, SITE, id))! };
}

async function dryThenRun(category: string, thresholds: Record<string, number>) {
  const dry = await run(category, true, thresholds);
  const real = await run(category, false, thresholds);
  expect(real.seen).toEqual(dry.seen);
  expect(real.run).toMatchObject({
    status: "succeeded",
    items: dry.run.items,
    bytes: dry.run.bytes,
  });
  expect((await run(category, false, thresholds)).run).toMatchObject({ items: 0, bytes: 0 });
  return real;
}

const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
const orbit = { id: "acc_orbit", slug: "orbit", displayName: "Orbit" };

describe("usage history", () => {
  test("rollups never merge a person and Space with the same preserved identifier", async () => {
    for (const ago of [100, 1])
      for (const kind of ["person", "space"])
        sqlite
          .prepare(`INSERT INTO usage_snapshots
          (day,scope_kind,scope_id,construct,item,metric,kind,quantity,estimated,method,collected_at)
          VALUES (?,?,'acc_marco','d1','repositories','rows','storage',?,0,'seeded',?)`)
          .run(day(ago), kind, kind === "person" ? 7 : 11, iso(ago));
    const targets = [
      { kind: "space", id: "acc_marco" },
      { kind: "person", id: "acc_marco" },
    ] as const;
    const before = await Promise.all(
      targets.map((target) => usageTotals(env.DB, target, "2024-10", "2026-10")),
    );
    await dryThenRun("usage-history", { days: 90, months: 24 });
    expect(
      await Promise.all(targets.map((target) => usageTotals(env.DB, target, "2024-10", "2026-10"))),
    ).toEqual(before);
    expect(
      sqlite
        .prepare(`SELECT scope_kind,quantity FROM usage_monthly
      WHERE month=? AND scope_id='acc_marco' AND metric='rows' ORDER BY scope_kind`)
        .all(day(100).slice(0, 7)),
    ).toEqual([
      { scope_kind: "person", quantity: 7 },
      { scope_kind: "space", quantity: 11 },
    ]);
  });
  test("the report keeps its window: the shortest policy is longer than it", () => {
    const history = CATEGORIES.find((c) => c.id === "usage-history")!;
    expect(history.thresholds.find((t) => t.key === "days")!.min).toBeGreaterThan(30);
  });

  test("rolls old days into months; reports and totals are unchanged", async () => {
    const totals = () =>
      Promise.all(
        (
          [
            { kind: "space", id: "acc_orbit" },
            { kind: "instance", id: "" },
            { kind: "person", id: "acc_jun" },
          ] as const
        ).map((target) => usageTotals(env.DB, target, "2024-10", "2026-10")),
      );
    const before = {
      totals: await totals(),
      space: await spaceUsageReport(env.DB, orbit),
      instance: await instanceUsageReport(env.DB),
    };
    const real = await dryThenRun("usage-history", { days: 90, months: 24 });
    // 30 old days of 3 figures for 2 accounts, 5 of acc_jun's 6, and the 2024-03 month.
    expect(real.run.items).toBe(30 * 3 * 2 + 5 + 1);
    expect({
      totals: await totals(),
      space: await spaceUsageReport(env.DB, orbit),
      instance: await instanceUsageReport(env.DB),
    }).toEqual(before);

    expect(count(`SELECT count(*) AS n FROM usage_snapshots WHERE day < '${day(90)}'`)).toBe(1);
    expect(
      sqlite
        .prepare(
          "SELECT day FROM usage_snapshots WHERE scope_kind = 'person' AND scope_id = 'acc_jun'",
        )
        .all(),
    ).toEqual([{ day: day(150) }]);
    expect(count("SELECT count(*) AS n FROM usage_monthly WHERE month < '2024-10'")).toBe(0);
    // A month's row: the sum of its days, how many, and its last day's figure.
    const july = sqlite
      .prepare(
        `SELECT quantity, days, last_day, last_quantity FROM usage_monthly
         WHERE month = ? AND scope_kind = 'space' AND scope_id = 'acc_orbit' AND metric = 'rows'`,
      )
      .get(day(100).slice(0, 7)) as { days: number; last_day: string };
    expect(july.days).toBeGreaterThan(0);
    expect(july.last_day.slice(0, 7)).toBe(day(100).slice(0, 7));
  });
});

describe("AI usage records", () => {
  test("AI rollups preserve explicit personal and Space attribution independently", async () => {
    sqlite
      .prepare(`INSERT INTO ai_usage
      (day,scope_kind,scope_id,feature,model,calls,input_tokens,output_tokens,total_tokens)
      VALUES (?,'space','acc_marco','assistant','@cf/model',9,90,9,99)`)
      .run(day(100));
    const targets = [
      { kind: "space", id: "acc_marco" },
      { kind: "person", id: "acc_marco" },
    ] as const;
    const before = await Promise.all(
      targets.map((target) => aiUsageTotals(env.DB, target, "2026-01", "2026-12")),
    );
    await dryThenRun("ai-usage", { days: 90 });
    expect(
      await Promise.all(
        targets.map((target) => aiUsageTotals(env.DB, target, "2026-01", "2026-12")),
      ),
    ).toEqual(before);
    expect(
      sqlite
        .prepare(`SELECT calls FROM ai_usage_monthly WHERE scope_kind='space'
      AND scope_id='acc_marco' AND month=?`)
        .get(day(100).slice(0, 7)),
    ).toEqual({ calls: 9 });
  });
  test("rolls old days into monthly totals per account, feature and model", async () => {
    const totals = () =>
      Promise.all(
        (
          [
            { kind: "person", id: "acc_marco" },
            { kind: "instance", id: "" },
          ] as const
        ).map((target) => aiUsageTotals(env.DB, target, "2026-01", "2026-12")),
      );
    const before = await totals();
    const real = await dryThenRun("ai-usage", { days: 90 });
    expect(real.run.items).toBe(30 * 2);
    expect(await totals()).toEqual(before);
    expect(count(`SELECT count(*) AS n FROM ai_usage WHERE day < '${day(90)}'`)).toBe(0);
    expect(count("SELECT count(*) AS n FROM ai_usage")).toBe(90 * 2);
    expect(
      count(
        "SELECT sum(days) AS n FROM ai_usage_monthly WHERE scope_kind = 'person' AND scope_id = 'acc_marco'",
      ),
    ).toBe(30);
  });
});

describe("Durable Object registry rows", () => {
  test("removes rows of instances purged long ago, never live ones", async () => {
    const real = await dryThenRun("durable-registry", { days: 30 });
    expect(real.run.items).toBe(1);
    expect(
      sqlite
        .prepare("SELECT name FROM do_instances ORDER BY name")
        .all()
        .map((r) => r.name),
    ).toEqual(["acc_marco:recent", "acc_orbit", "repo_back"]);
  });
});
