// CI retention (CORE-200) over D1: "ci-logs" and "ci-runs" select exactly
// what their policies say, never the "never" list, remove exactly what a dry
// run at the same moment listed, and remove nothing the second time.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../../testing/d1.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const oid = (n: number) => n.toString(16).padStart(40, "0");
const ORBIT = { scope: "account", accountId: "acc_orbit" } as const;

function migratedRegistry(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../../registry/migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(dir, file), "utf8"));
  return db;
}

function seeded() {
  const sqlite = migratedDatabase();
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  sqlite.exec(`
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_app', 'acc_orbit', 'app', 'private', 'a', 'https://a'),
      ('r_lib', 'acc_orbit', 'lib', 'private', 'b', 'https://b'),
      ('r_sam', 'acc_sam', 'mine', 'private', 'c', 'https://c');
  `);
  const registry = migratedRegistry();
  const runs = sqlite.prepare(`
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, title,
                         created_at, finished_at, landing_id)
    VALUES (?, ?, ?, ?, ?, 'push', ?, 'Run', ?, ?, ?)`);
  const jobs = sqlite.prepare(`
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, finished_at)
    VALUES (?, ?, ?, ?, '{"needs":[]}', ?, 'sandbox', ?)`);
  const steps = sqlite.prepare(`
    INSERT INTO ci_steps (job_id, position, name, status) VALUES (?, 0, 'test', 'succeeded')`);
  const logs = sqlite.prepare(`INSERT INTO ci_logs (job_id, seq, step, text) VALUES (?, ?, 0, ?)`);
  const repoOf = (run: string) =>
    sqlite.prepare("SELECT repo_id FROM ci_runs WHERE id = ?").get(run) as { repo_id: string };
  const addRun = (
    id: string,
    repo: string,
    number: number,
    ref: string,
    days: number | null,
    extra: { status?: string; landing?: string; created?: number } = {},
  ) =>
    runs.run(
      id,
      repo,
      number,
      oid(number),
      ref,
      extra.status ?? "succeeded",
      ago(extra.created ?? days ?? 0),
      days === null ? null : ago(days),
      extra.landing ?? null,
    );
  const addJob = (
    id: string,
    run: string,
    days: number | null,
    text: string[],
    status = "succeeded",
  ) => {
    jobs.run(id, run, repoOf(run).repo_id, id, status, days === null ? null : ago(days));
    steps.run(id);
    text.forEach((t, seq) => logs.run(id, seq + 1, t));
  };
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as unknown as Env;
  return { sqlite, registry, env, addRun, addJob };
}

async function run(
  env: Env,
  category: "ci-logs" | "ci-runs",
  thresholds: Record<string, number>,
  dryRun: boolean,
  limit = 2,
) {
  const id = await createRun(env.DB, {
    target: ORBIT,
    trigger: "manual",
    actorId: "acc_marco",
    dryRun,
    categories: [{ id: category, thresholds }],
    now: NOW,
  });
  const seen: string[] = [];
  let state;
  do {
    state = await advanceRun(env, id, {
      now: NOW,
      limit,
      afterBatch: (_c, items) => void seen.push(...(items as { id: string }[]).map((i) => i.id)),
    });
  } while (state === "more");
  const result = (await getRun(env.DB, ORBIT, id))!;
  expect(result.status).toBe("succeeded");
  return { seen, items: result.items, bytes: result.bytes };
}

describe("ci-logs", () => {
  function logsSeed() {
    const t = seeded();
    t.addRun("run_a", "r_app", 1, "main", 200);
    t.addRun("run_b", "r_app", 2, "main", 1, { status: "running", created: 100 });
    t.addRun("run_l", "r_lib", 1, "main", 60);
    t.addRun("run_s", "r_sam", 1, "main", 200);
    // Selected: finished over 30 days ago, with log text, in Orbit's repositories.
    t.addJob("j_old", "run_a", 31, ["hello ", "wörld\n"]);
    t.addJob("j_failed", "run_a", 100, ["boom\n"], "failed");
    t.addJob("j_cancelled", "run_a", 40, ["stop\n"], "cancelled");
    t.addJob("j_lib", "run_l", 60, ["lib\n"]);
    // Kept: recent, still running or queued (an old start), nothing to remove,
    // another account's.
    t.addJob("j_recent", "run_a", 29.5, ["recent\n"]);
    t.addJob("j_running", "run_b", null, ["live\n"], "running");
    t.addJob("j_queued", "run_b", null, [], "queued");
    t.addJob("j_empty", "run_a", 100, []);
    t.addJob("j_sam", "run_s", 200, ["sam\n"]);
    const chunks = () =>
      (
        t.sqlite.prepare("SELECT job_id FROM ci_logs ORDER BY job_id, seq").all() as {
          job_id: string;
        }[]
      ).map((r) => r.job_id);
    const marked = () =>
      t.sqlite
        .prepare(
          "SELECT id, logs_removed_at FROM ci_jobs WHERE logs_removed_at IS NOT NULL ORDER BY id",
        )
        .all();
    return { ...t, chunks, marked };
  }
  const SELECTED = ["j_cancelled", "j_failed", "j_lib", "j_old"];
  const TEXT = Buffer.byteLength("hello wörld\nboom\nstop\nlib\n");

  test("removes exactly the dry run's logs, marks their jobs, and is idempotent", async () => {
    const t = logsSeed();
    const before = t.chunks();
    const dry = await run(t.env, "ci-logs", { days: 30 }, true);
    expect(dry.seen).toEqual(SELECTED);
    // Five chunks; their text, in bytes.
    expect(dry).toMatchObject({ items: 5, bytes: TEXT });
    expect(t.chunks()).toEqual(before);
    expect(t.marked()).toEqual([]);

    const real = await run(t.env, "ci-logs", { days: 30 }, false);
    expect(real).toEqual(dry);
    expect(t.chunks()).toEqual(before.filter((job) => !SELECTED.includes(job)));
    expect(t.marked()).toEqual(SELECTED.map((id) => ({ id, logs_removed_at: NOW.toISOString() })));
    // Runs, jobs and steps stay.
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_jobs").get()).toEqual({ n: 9 });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_steps").get()).toEqual({ n: 9 });

    const again = await run(t.env, "ci-logs", { days: 30 }, false);
    expect(again).toEqual({ seen: [], items: 0, bytes: 0 });
    expect(t.marked()).toHaveLength(4);
  });

  test("the days threshold decides the cutoff", async () => {
    const t = logsSeed();
    expect((await run(t.env, "ci-logs", { days: 50 }, true)).seen).toEqual(["j_failed", "j_lib"]);
    expect((await run(t.env, "ci-logs", { days: 1 }, true)).seen).toEqual([
      ...SELECTED.slice(0, 3),
      "j_old",
      "j_recent",
    ]);
  });

  test("a job that started running again since select keeps its log", async () => {
    const t = logsSeed();
    const { ciLogs } = await import("./ci-logs.ts");
    const ctx = { env: t.env, target: ORBIT, thresholds: { days: 30 }, now: NOW, limit: 10 };
    const selection = await ciLogs.select(ctx, null);
    t.sqlite.exec("UPDATE ci_jobs SET status = 'running', finished_at = NULL WHERE id = 'j_old'");
    const removed = await ciLogs.remove(ctx, selection.items);
    expect(removed.count).toBe(3);
    expect(t.chunks()).toContain("j_old");
    expect(t.marked().map((r) => (r as { id: string }).id)).toEqual([
      "j_cancelled",
      "j_failed",
      "j_lib",
    ]);
  });
});

describe("ci-runs", () => {
  function runsSeed() {
    const t = seeded();
    const add = (
      id: string,
      repo: string,
      number: number,
      ref: string,
      days: number | null,
      extra: Parameters<typeof t.addRun>[5] = {},
    ) => {
      t.addRun(id, repo, number, ref, days, extra);
      t.addJob(`${id}_j`, id, days, ["out\n"], extra.status === "queued" ? "queued" : "succeeded");
    };
    // r_app main: latest two (#9 recent, #10 old) kept; of the older ones,
    // #1 and #7 are selected and the rest are kept for a reason each.
    add("app_01", "r_app", 1, "main", 200);
    add("app_02", "r_app", 2, "main", 200); // a deployment names it
    add("app_03", "r_app", 3, "main", 200, { landing: "ld_1" });
    add("app_04", "r_app", 4, "main", 200, { status: "failed" }); // a job still running
    t.sqlite.exec("UPDATE ci_jobs SET status = 'running' WHERE id = 'app_04_j'");
    add("app_05", "r_app", 5, "main", 200); // a deployment's teardown run
    add("app_06", "r_app", 6, "main", 200); // a registry publish names it
    add("app_07", "r_app", 7, "main", 200);
    add("app_08", "r_app", 8, "main", null, { status: "queued", created: 200 });
    add("app_09", "r_app", 9, "main", 10);
    add("app_10", "r_app", 10, "main", 200);
    // Another ref: its own latest two kept.
    add("app_11", "r_app", 11, "topic", 181);
    add("app_12", "r_app", 12, "topic", 300);
    add("app_13", "r_app", 13, "topic", 300);
    // Another repository's only run, and another account's runs.
    add("lib_01", "r_lib", 1, "main", 400);
    for (let n = 1; n <= 4; n++) add(`sam_0${n}`, "r_sam", n, "main", 400);
    t.sqlite.exec(`
      INSERT INTO deployments (repo_id, environment, commit_oid, url, status, run_id, job_id)
        VALUES ('r_app', 'staging', '${oid(2)}', 'https://s.example.com', 'active', 'app_02', 'app_02_j');
      INSERT INTO deployments (repo_id, environment, commit_oid, url, status, teardown_run_id)
        VALUES ('r_app', 'timeline/x', '${oid(5)}', 'https://x.example.com', 'expired', 'app_05');
    `);
    t.registry.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO publishes (id, feed_id, format, package_id, version, action, git_repo_id,
                             ci_run_id, run_number, actor, actor_label, via, at)
        VALUES ('p1', 'f1', 'generic', 'pk1', '1.0.0', 'publish', 'r_app', 'app_06', 6,
                'job:app_06_j', 'CI', 'job', '${ago(200)}');
    `);
    const remaining = () =>
      (t.sqlite.prepare("SELECT id FROM ci_runs ORDER BY id").all() as { id: string }[]).map(
        (r) => r.id,
      );
    const count = (table: string) =>
      (t.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { ...t, remaining, count };
  }
  const SELECTED = ["app_01", "app_07", "app_11"];
  const POLICY = { days: 180, keepLatest: 2 };

  test("removes exactly the dry run's runs with their jobs, steps and logs, once", async () => {
    const t = runsSeed();
    const before = t.remaining();
    const dry = await run(t.env, "ci-runs", POLICY, true);
    expect(dry.seen).toEqual(SELECTED);
    // Each run stands for itself, one job, one step and one log chunk.
    expect(dry.items).toBe(12);
    expect(dry.bytes).toBeGreaterThan(3 * (200 + 200 + 80 + 4));
    expect(t.remaining()).toEqual(before);

    const real = await run(t.env, "ci-runs", POLICY, false);
    expect(real).toEqual(dry);
    expect(t.remaining()).toEqual(before.filter((id) => !SELECTED.includes(id)));
    const left = before.length - SELECTED.length;
    expect([t.count("ci_jobs"), t.count("ci_steps"), t.count("ci_logs")]).toEqual([
      left,
      left,
      left,
    ]);
    // References survive with what they refer to.
    expect(
      t.sqlite.prepare("SELECT run_id, teardown_run_id FROM deployments ORDER BY id").all(),
    ).toEqual([
      { run_id: "app_02", teardown_run_id: null },
      { run_id: null, teardown_run_id: "app_05" },
    ]);

    const again = await run(t.env, "ci-runs", POLICY, false);
    expect(again).toEqual({ seen: [], items: 0, bytes: 0 });
  });

  test("keeps the latest runs per ref at the default count, and follows the days threshold", async () => {
    const t = runsSeed();
    expect((await run(t.env, "ci-runs", { days: 180, keepLatest: 20 }, true)).seen).toEqual([]);
    expect((await run(t.env, "ci-runs", { days: 190, keepLatest: 2 }, true)).seen).toEqual([
      "app_01",
      "app_07",
    ]);
    expect((await run(t.env, "ci-runs", { days: 1, keepLatest: 1 }, true)).seen).toEqual([
      "app_01",
      "app_07",
      "app_09",
      "app_11",
      "app_12",
    ]);
  });

  test("a run something started referring to since select stays", async () => {
    const t = runsSeed();
    const { ciRuns } = await import("./ci-runs.ts");
    const ctx = { env: t.env, target: ORBIT, thresholds: POLICY, now: NOW, limit: 10 };
    const selection = await ciRuns.select(ctx, null);
    expect(selection.items.map((i) => i.id)).toEqual(SELECTED);
    t.sqlite.exec(`
      INSERT INTO deployments (repo_id, environment, commit_oid, url, status, run_id)
        VALUES ('r_app', 'prod', '${oid(1)}', 'https://p.example.com', 'active', 'app_01');
    `);
    t.registry.exec(`
      INSERT INTO publishes (id, feed_id, format, package_id, version, action, ci_run_id,
                             actor, actor_label, via, at)
        VALUES ('p2', 'f1', 'generic', 'pk1', '1.0.1', 'publish', 'app_07', 'x', 'x', 'job', 'now');
    `);
    const removed = await ciRuns.remove(ctx, selection.items);
    expect(removed.count).toBe(4);
    expect(t.remaining()).toContain("app_01");
    expect(t.remaining()).toContain("app_07");
    expect(t.remaining()).not.toContain("app_11");
  });
});
