// The cleanup engine end to end (CORE-198) over D1, with the reference
// category "preview-records": dry run = run, bounded batches, idempotence,
// resuming after a crash, the audit record, and gate 1 (nothing enabled, so
// a cron cycle leaves the database unchanged).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { accountPolicies } from "./policies.ts";
import {
  advanceRun,
  continueRun,
  createRun,
  getRun,
  retentionCron,
  SimulatedCrash,
  type RetentionJob,
} from "./runs.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const oid = (n: number) => n.toString(16).padStart(40, "0");

/**
 * Orbit (org) and Sam (user) with deployments of every kind; ids 1..12 are
 * Orbit's expired records past 30 days, which the policy at its default
 * selects; the rest must survive.
 */
function seeded() {
  const sqlite = migratedDatabase();
  sqlite.exec(
    readFileSync(fileURLToPath(new URL("../../seed/0001_dev.sql", import.meta.url).href), "utf8"),
  );
  sqlite.exec(`
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_app', 'acc_orbit', 'app', 'private', 'a', 'https://a'),
      ('r_lib', 'acc_orbit', 'lib', 'private', 'b', 'https://b'),
      ('r_sam', 'acc_sam', 'mine', 'private', 'c', 'https://c');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, status, preview_action)
      VALUES ('run_live', 'r_app', 1, '${oid(1)}', 'timeline/x', 'manual', 'acc_marco', 'running', 'create');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, finished_at)
      VALUES ('job_old', 'run_live', 'r_app', 'build', '{}', 'succeeded', 'sandbox', '${ago(400)}');
    INSERT INTO ci_logs (job_id, seq, step, text) VALUES ('job_old', 0, 0, 'hello');
    INSERT INTO account_settings (account_id, preview_ended_days, preview_idle_days)
      VALUES ('acc_orbit', 3, 9);
  `);
  const insert = sqlite.prepare(`
    INSERT INTO deployments (id, repo_id, environment, timeline_slug, commit_oid, url, status,
                             expires_at, torn_down_at, updated_at, rebuilt_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (
    id: number,
    repo: string,
    status: string,
    expired: string | null,
    extra: { tornDown?: string | null; rebuiltFrom?: number; environment?: string } = {},
  ) =>
    insert.run(
      id,
      repo,
      extra.environment ?? "timeline/t" + id,
      extra.environment ? null : "t" + id,
      oid(id),
      `https://p${id}.example.com`,
      status,
      expired,
      extra.tornDown === undefined ? expired : extra.tornDown,
      expired ?? ago(1),
      extra.rebuiltFrom ?? null,
    );
  // Selected: expired over 30 days ago, in both of Orbit's repositories.
  for (let id = 1; id <= 12; id++) add(id, id % 2 ? "r_app" : "r_lib", "expired", ago(31 + id));
  // Kept: expired recently, live, sleeping, failed, production, another account's.
  add(20, "r_app", "expired", ago(29.5));
  add(21, "r_app", "active", ago(90), { tornDown: null });
  add(22, "r_app", "sleeping", ago(90), { tornDown: null });
  add(23, "r_app", "failed", ago(90), { tornDown: null });
  add(24, "r_app", "active", null, { tornDown: null, environment: "production" });
  add(25, "r_sam", "expired", ago(90));
  // Kept: an old expired record a live revived preview was rebuilt from, and
  // one a running preview run rebuilds from.
  add(26, "r_app", "expired", ago(90));
  add(27, "r_app", "active", ago(-5), { tornDown: null, rebuiltFrom: 26 });
  add(28, "r_app", "expired", ago(90));
  sqlite.exec(`UPDATE ci_runs SET preview_rebuilt_from = 28 WHERE id = 'run_live'`);
  const sent: RetentionJob[] = [];
  const env = {
    DB: d1(sqlite),
    JOBS: { send: async (body: RetentionJob) => void sent.push(body) },
  } as unknown as Env;
  const deployments = () =>
    (sqlite.prepare("SELECT id FROM deployments ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
  return { sqlite, env, sent, deployments };
}

const SELECTED = Array.from({ length: 12 }, (_, i) => i + 1);
const ORBIT = { scope: "account", accountId: "acc_orbit" } as const;

/** Every table's rows, for byte-for-byte comparison. */
function dump(sqlite: ReturnType<typeof migratedDatabase>): Record<string, unknown[]> {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

async function run(
  env: Env,
  dryRun: boolean,
  options: Parameters<typeof advanceRun>[2] = {},
  thresholds = { days: 30 },
) {
  const id = await createRun(env.DB, {
    target: ORBIT,
    trigger: "manual",
    actorId: "acc_marco",
    dryRun,
    categories: [{ id: "preview-records", thresholds }],
    now: NOW,
  });
  const seen: number[] = [];
  let state;
  let calls = 0;
  do {
    state = await advanceRun(env, id, {
      now: NOW,
      limit: 5,
      ...options,
      afterBatch: async (category, items) => {
        seen.push(...(items as { id: number }[]).map((i) => i.id));
        await options.afterBatch?.(category, items);
      },
    });
    calls++;
  } while (state === "more");
  return { id, state, seen, calls, run: (await getRun(env.DB, ORBIT, id))! };
}

describe("the cleanup engine with expired preview records", () => {
  test("a dry run and the run after it select the same items; a second run removes nothing", async () => {
    const t = seeded();
    const before = t.deployments();
    const dry = await run(t.env, true);
    expect(dry.seen).toEqual(SELECTED);
    expect(t.deployments()).toEqual(before);
    expect(dry.run).toMatchObject({
      level: "account",
      account: "orbit",
      trigger: "manual",
      actor: "marco",
      dryRun: true,
      status: "succeeded",
      asOf: NOW.toISOString(),
      items: 12,
      categories: [
        {
          category: "preview-records",
          status: "succeeded",
          thresholds: { days: 30 },
          items: 12,
          // Batches of 5: 5, 5, 2.
          batches: 3,
          error: null,
        },
      ],
    });
    expect(dry.run.bytes).toBeGreaterThan(12 * 160);

    const real = await run(t.env, false);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ dryRun: false, status: "succeeded", items: 12 });
    expect(real.run.bytes).toBe(dry.run.bytes);
    expect(t.deployments()).toEqual(before.filter((id) => !SELECTED.includes(id)));

    const again = await run(t.env, false);
    expect(again.seen).toEqual([]);
    expect(again.run).toMatchObject({ status: "succeeded", items: 0, bytes: 0 });
    expect(t.deployments()).toEqual(before.filter((id) => !SELECTED.includes(id)));
  });

  test("thresholds decide the cutoff", async () => {
    const t = seeded();
    expect((await run(t.env, true, {}, { days: 40 })).seen).toEqual([10, 11, 12]);
    expect((await run(t.env, true, {}, { days: 1 })).seen).toEqual([...SELECTED, 20]);
  });

  test("bounded calls: a budget stops between batches and the queue carries on", async () => {
    const t = seeded();
    const limited = await run(t.env, false, { maxBatches: 1 });
    // Three batches, then one call that finds nothing left to do.
    expect(limited.calls).toBe(3);
    expect(limited.seen).toEqual(SELECTED);
    expect(limited.run.categories[0]).toMatchObject({ batches: 3, items: 12 });

    const fresh = seeded();
    const id = await createRun(fresh.env.DB, {
      target: ORBIT,
      trigger: "manual",
      actorId: null,
      dryRun: true,
      categories: [{ id: "preview-records", thresholds: { days: 30 } }],
      now: NOW,
    });
    expect(await continueRun(fresh.env, id, { now: NOW, limit: 5, maxBatches: 1 })).toBe("more");
    expect(fresh.sent).toEqual([{ type: "retention", runId: id }]);
    expect(await continueRun(fresh.env, id, { now: NOW, limit: 5 })).toBe("done");
    expect(fresh.sent).toHaveLength(1);
    expect(await continueRun(fresh.env, id, { now: NOW })).toBe("done");
    expect(await advanceRun(fresh.env, 999)).toBe("missing");
  });

  test("a run interrupted mid-way resumes without duplicates or misses", async () => {
    const t = seeded();
    const dry = await run(t.env, true);
    const id = await createRun(t.env.DB, {
      target: ORBIT,
      trigger: "manual",
      actorId: null,
      dryRun: false,
      categories: [{ id: "preview-records", thresholds: { days: 30 } }],
      now: NOW,
    });
    const removed: number[] = [];
    let batch = 0;
    // The worker dies after its second batch's delete, before saving progress.
    await expect(
      advanceRun(t.env, id, {
        now: NOW,
        limit: 5,
        afterBatch: (_c, items) => {
          batch++;
          removed.push(...(items as { id: number }[]).map((i) => i.id));
          if (batch === 2) throw new SimulatedCrash("killed");
        },
      }),
    ).rejects.toThrow("killed");
    expect(removed).toEqual(SELECTED.slice(0, 10));
    expect((await getRun(t.env.DB, ORBIT, id))!.status).toBe("running");
    // Still leased: nobody else may advance it.
    expect(await advanceRun(t.env, id, { now: NOW })).toBe("busy");
    // After the lease lapses, the cron restarts it.
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const { restarted } = await retentionCron(t.env, {
      now: later,
      advance: { now: later, limit: 5 },
    });
    expect(restarted).toEqual([id]);
    const done = (await getRun(t.env.DB, ORBIT, id))!;
    expect(done.status).toBe("succeeded");
    // The batch the crash lost is selected again: what's left of it is gone.
    expect(t.deployments().filter((d) => dry.seen.includes(d))).toEqual([]);
    expect(t.deployments()).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
    // Batch one was counted, batch two's count was lost with the crash, the rest counted.
    expect(done.categories[0]).toMatchObject({ status: "succeeded", items: 7 });
  });

  test("a failing category fails the run with its error, and other categories still run", async () => {
    const t = seeded();
    const id = await createRun(t.env.DB, {
      target: ORBIT,
      trigger: "manual",
      actorId: null,
      dryRun: true,
      categories: [
        { id: "preview-records", thresholds: {} },
        // Atlas snapshots expire in their own sweep: no cleanup here.
        { id: "atlas-snapshots", thresholds: {} },
        { id: "preview-records-copy", thresholds: {} },
      ],
      now: NOW,
    });
    expect(await advanceRun(t.env, id, { now: NOW })).toBe("done");
    const result = (await getRun(t.env.DB, ORBIT, id))!;
    expect(result.status).toBe("failed");
    expect(result.categories.map((c) => [c.category, c.status, c.error])).toEqual([
      ["preview-records", "failed", "preview-records needs its days threshold."],
      ["atlas-snapshots", "failed", "No cleanup for this category."],
      ["preview-records-copy", "failed", "No cleanup for this category."],
    ]);
    expect(result.error).toContain("preview-records: preview-records needs its days threshold.");
  });
});

describe("scheduled runs", () => {
  test("gate 1: with nothing enabled, a cron cycle changes nothing at all", async () => {
    const t = seeded();
    // Policies stored, none enabled: thresholds changed, a category turned
    // off explicitly, and site-wide defaults without enabling anything.
    t.sqlite.exec(`
      INSERT INTO retention_policies (account_id, category, enabled, thresholds) VALUES
        ('acc_orbit', 'preview-records', 0, '{"days": 1}'),
        ('acc_orbit', 'ci-logs', NULL, '{"days": 1}');
      INSERT INTO retention_site_policies (category, enabled, thresholds) VALUES
        ('preview-records', 0, '{"days": 1}'),
        ('auth-hygiene', NULL, '{"days": 1}');
    `);
    const before = dump(t.sqlite);
    for (const hour of [0, 1, 2, 24, 48]) {
      const at = new Date(NOW.getTime() + hour * 3_600_000);
      expect(await retentionCron(t.env, { now: at, advance: { now: at } })).toEqual({
        scheduled: [],
        restarted: [],
      });
    }
    expect(dump(t.sqlite)).toEqual(before);
    expect(t.sent).toEqual([]);
  });

  test("an enabled category runs once a day, deleting what its dry run listed", async () => {
    const t = seeded();
    t.sqlite.exec(`
      INSERT INTO retention_policies (account_id, category, enabled, thresholds)
        VALUES ('acc_orbit', 'preview-records', 1, '{}');
      -- Stored as enabled, but not a policy category with a cleanup: skipped.
      INSERT INTO retention_policies (account_id, category, enabled) VALUES ('acc_sam', 'atlas-snapshots', 1);
    `);
    const dry = await run(t.env, true);
    const first = await retentionCron(t.env, { now: NOW, advance: { now: NOW } });
    expect(first.scheduled).toHaveLength(1);
    const scheduled = (await getRun(t.env.DB, ORBIT, first.scheduled[0]!))!;
    expect(scheduled).toMatchObject({
      trigger: "schedule",
      actor: null,
      dryRun: false,
      status: "succeeded",
      items: dry.run.items,
      bytes: dry.run.bytes,
      categories: [{ category: "preview-records", thresholds: { days: 30 } }],
    });
    expect(t.deployments()).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
    // The policy shows the last run.
    const policies = await accountPolicies(t.env.DB, "acc_orbit");
    expect(policies.find((p) => p.id === "preview-records")).toMatchObject({
      runnable: true,
      lastRun: { runId: scheduled.id, dryRun: false, trigger: "schedule", items: 12 },
    });
    expect(policies.find((p) => p.id === "atlas-snapshots")).toMatchObject({
      runnable: false,
      lastRun: null,
    });

    const hourLater = new Date(NOW.getTime() + 3_600_000);
    expect((await retentionCron(t.env, { now: hourLater })).scheduled).toEqual([]);
    const nextDay = new Date(NOW.getTime() + DAY);
    const second = await retentionCron(t.env, { now: nextDay, advance: { now: nextDay } });
    expect(second.scheduled).toHaveLength(1);
    // A day later, record 20 is past 30 days too.
    expect((await getRun(t.env.DB, ORBIT, second.scheduled[0]!))!.items).toBe(1);
    expect(t.deployments()).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
  });
});
