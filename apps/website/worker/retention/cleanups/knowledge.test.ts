// Knowledge retention (CORE-201) over D1: "knowledge-builds",
// "ended-timeline-data", "analysis-caches" and "ai-spend" select exactly what
// their policies say, never the "never" list, remove exactly what a dry run
// at the same moment listed, and remove nothing the second time. Budget checks
// answer the same after the AI spend roll-up, and a rebuild after the cache
// cleanup reuses what is left and re-analyzes only what went.

import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import {
  atlasDailySpend,
  reserveAtlasCall,
  type BudgetOptions,
  type PriceTable,
} from "../../knowledge/budget.ts";
import { ANALYZER, loadAnalyses } from "../../knowledge/analyze.ts";
import { reopenOverlay } from "../../knowledge/overlay.ts";
import { cached } from "../../knowledge/synthesize.ts";
import { d1, migratedDatabase } from "../../testing/d1.ts";
import type { CategoryId } from "../categories.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";
import type { RetentionTarget } from "../policies.ts";

const NOW = new Date("2026-12-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ORBIT: RetentionTarget = { scope: "account", accountId: "acc_orbit" };
const SITE: RetentionTarget = { scope: "site" };

function seeded() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_orbit', 'org', 'orbit', 'Orbit'), ('acc_sam', 'user', 'sam', 'Sam'),
      ('acc_marco', 'user', 'marco', 'Marco');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_app', 'acc_orbit', 'app', 'private', 'a', 'https://a'),
      ('r_lib', 'acc_orbit', 'lib', 'private', 'b', 'https://b'),
      ('r_sam', 'acc_sam', 'mine', 'private', 'c', 'https://c');
  `);
  return { sqlite, env: { DB: d1(sqlite) } as unknown as Env };
}

/** A manual run of one category to the end, in batches of `limit`. */
async function run(
  env: Env,
  target: RetentionTarget,
  category: CategoryId,
  thresholds: Record<string, number>,
  dryRun: boolean,
  limit = 2,
) {
  const id = await createRun(env.DB, {
    target,
    trigger: "manual",
    actorId: "acc_marco",
    dryRun,
    categories: [{ id: category, thresholds }],
    now: NOW,
  });
  const seen: unknown[] = [];
  let state;
  do {
    state = await advanceRun(env, id, {
      now: NOW,
      limit,
      afterBatch: (_c, items) => void seen.push(...items),
    });
  } while (state === "more");
  const result = (await getRun(env.DB, target, id))!;
  expect(result.status).toBe("succeeded");
  return { seen, items: result.items, bytes: result.bytes };
}

const all = (sqlite: DatabaseSync, sql: string, ...params: string[]) =>
  sqlite.prepare(sql).all(...params);
const count = (sqlite: DatabaseSync, table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("knowledge-builds", () => {
  function buildsSeed() {
    const t = seeded();
    const build = t.sqlite.prepare(`
      INSERT INTO kg_builds (id, repo_id, to_commit, status, stats, started_at, finished_at)
      VALUES (?, ?, 'c', ?, '{"files":1}', ?, ?)`);
    const change = t.sqlite.prepare(`
      INSERT INTO kg_changes (repo_id, build_id, node_id, kind, change)
      VALUES (?, ?, ?, 'file', 'changed')`);
    const add = (id: string, repo: string, days: number, status = "succeeded") => {
      build.run(id, repo, status, ago(days), status === "running" ? null : ago(days - 0.01));
      for (const node of ["file:a.ts", "file:b.ts"]) change.run(repo, id, node);
    };
    // r_app: 25 builds, 199 to 175 days old; the latest 20 (b06..b25) stay.
    for (let i = 1; i <= 25; i++) add(`b${String(i).padStart(2, "0")}`, "r_app", 200 - i);
    // b04 still runs (a stuck build), b01 is behind the current graph and
    // wiki, b02 behind a kept Atlas snapshot; b03 only behind an expired one.
    t.sqlite.exec(`
      UPDATE kg_builds SET status = 'running', finished_at = NULL WHERE id = 'b04';
      INSERT INTO kg_state (repo_id, indexed_commit, last_build_id) VALUES ('r_app', 'c', 'b01');
      INSERT INTO kg_nodes (repo_id, id, kind, name, summary, data, content_hash, changed_in)
        VALUES ('r_app', 'file:a.ts', 'file', 'a.ts', 'A', '{}', 'h', 'b01');
      INSERT INTO atlas_scopes (scope, kind, repo_id) VALUES ('repo:r_app', 'repo', 'r_app');
      INSERT INTO atlas_snapshots (id, scope, seq, status, projection_version, vector)
        VALUES ('s1', 'repo:r_app', 1, 'expired', 1,
                '[{"repoId":"r_app","commit":"c","buildId":"b03"}]'),
               ('s2', 'repo:r_app', 2, 'published', 1,
                '[{"repoId":"r_app","commit":"c","buildId":"b02"}]');
    `);
    // r_lib: three old builds, fewer than the latest 20. Sam's: another account.
    for (const [id, days] of [
      ["l1", 300],
      ["l2", 299],
      ["l3", 298],
    ] as const)
      add(id, "r_lib", days);
    add("s1", "r_sam", 400);
    add("s2", "r_sam", 399);
    const builds = () =>
      (all(t.sqlite, "SELECT id FROM kg_builds ORDER BY id") as { id: string }[]).map((r) => r.id);
    return { ...t, builds };
  }

  test("removes exactly the dry run's builds with their changes, once", async () => {
    const t = buildsSeed();
    const before = t.builds();
    const thresholds = { days: 90, keepLatest: 20 };
    const dry = await run(t.env, ORBIT, "knowledge-builds", thresholds, true);
    expect((dry.seen as { id: string }[]).map((i) => i.id)).toEqual(["b03", "b05"]);
    // Two builds, each with two changes.
    expect(dry.items).toBe(6);
    expect(dry.bytes).toBeGreaterThan(0);
    expect(t.builds()).toEqual(before);

    const real = await run(t.env, ORBIT, "knowledge-builds", thresholds, false);
    expect(real).toEqual(dry);
    expect(t.builds()).toEqual(before.filter((id) => id !== "b03" && id !== "b05"));
    expect(
      all(t.sqlite, "SELECT DISTINCT build_id FROM kg_changes WHERE build_id IN ('b03', 'b05')"),
    ).toEqual([]);
    // The graph and Atlas are untouched.
    expect(count(t.sqlite, "kg_nodes")).toBe(1);
    expect(count(t.sqlite, "atlas_snapshots")).toBe(2);

    expect(await run(t.env, ORBIT, "knowledge-builds", thresholds, false)).toEqual({
      seen: [],
      items: 0,
      bytes: 0,
    });
  });

  test("keep-latest per repository and the days threshold decide", async () => {
    const t = buildsSeed();
    const ids = async (thresholds: Record<string, number>) =>
      ((await run(t.env, ORBIT, "knowledge-builds", thresholds, true)).seen as { id: string }[])
        .map((i) => i.id)
        .sort();
    expect(await ids({ days: 196, keepLatest: 20 })).toEqual(["b03"]);
    expect(await ids({ days: 90, keepLatest: 1 })).toEqual(
      [
        "b03",
        ...Array.from({ length: 21 }, (_, i) => `b${String(i + 5).padStart(2, "0")}`).filter(
          (id) => id !== "b25",
        ),
        "l1",
        "l2",
      ].sort(),
    );
  });
});

describe("ended-timeline-data", () => {
  test("page-only archived sources release their consumer root without removing canonical pages", async () => {
    const t = seeded();
    t.sqlite.exec(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,state,allocation_operation_id,
       fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES ('work_pages','r_app','page-timeline','pages','acc_orbit','owned-pages','ready','page-allocation',
        'canonical','base','tree','refs/heads/main','canonical','head','head-tree','refs/heads/main','${ago(200)}','${ago(200)}');
      INSERT INTO kg_page_sets(repo_id,source_id,ref,set_key,commit_oid,status,stats)
        VALUES ('r_app','work_pages','refs/heads/timeline/pages','key','head','succeeded','{}'),
               ('r_app','canonical','refs/heads/timeline/pages','key','canonical-head','succeeded','{}');
      INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
        VALUES ('r_app','work_pages','knowledge-pages','r_app:work_pages:refs/heads/timeline/pages:key','head','${ago(200)}');
      UPDATE timeline_work_sources SET state='archived',archived_at='${ago(200)}' WHERE source_id='work_pages';`);
    const dry = await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, true);
    expect(dry.items).toBe(1);
    const removed = await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, false);
    expect(removed.items).toBe(1);
    expect(t.sqlite.prepare("SELECT source_id,commit_oid FROM kg_page_sets").all()).toEqual([
      { source_id: "canonical", commit_oid: "canonical-head" },
    ]);
    expect(t.sqlite.prepare("SELECT source_id FROM timeline_source_roots").all()).toEqual([]);
    expect((await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, false)).items).toBe(0);
    t.sqlite.close();
  });

  function overlaysSeed() {
    const t = seeded();
    const overlay = t.sqlite.prepare(`
      INSERT INTO kg_overlays (repo_id, ref, overlay_id, head_commit, base_commit, stats,
                               updated_at, status, attempted_commit, ended_at, ended_reason)
      VALUES (?, ?, ?, 'tip', 'base', '{"counts":{"file":{"added":1}},"stored":2}', ?,
              'succeeded', 'tip', ?, ?)`);
    const changes = t.sqlite.prepare(`
      INSERT INTO kg_overlay_changes (repo_id, overlay_id, node_id, kind, change, name, path, summary)
      VALUES (?, ?, ?, 'file', 'added', ?, ?, 'new')`);
    const regrouping = t.sqlite.prepare(`
      INSERT INTO atlas_timeline_regroupings (repo_id, overlay_id, version, grouping_version, state,
                                              data, created_at)
      VALUES (?, ?, 1, 1, 'ready', '{"groups":[]}', ?)`);
    const set = t.sqlite.prepare(`
      INSERT INTO kg_page_sets (repo_id, ref, set_key, commit_oid, status, stats)
      VALUES (?, ?, 'k1', 'tip', 'writing', '{}')`);
    const page = t.sqlite.prepare(`
      INSERT INTO kg_page_set_pages (repo_id, ref, set_key, slug, title, section, position, kind,
                                     change, outcome, body, inputs_hash)
      VALUES (?, ?, 'k1', ?, 'Page', 'Components', 0, 'component', 'added', 'written', 'Body', 'h')`);
    const add = (repo: string, slug: string, ended: number | null) => {
      const ref = `refs/heads/timeline/${slug}`;
      const id = `ov-${repo}-${slug}`;
      overlay.run(
        repo,
        ref,
        id,
        ago(200),
        ended === null ? null : ago(ended),
        ended === null ? null : "landed",
      );
      for (const n of ["a", "b"]) changes.run(repo, id, `file:${n}.ts`, `${n}.ts`, `${n}.ts`);
      regrouping.run(repo, id, ago(200));
      set.run(repo, ref);
      for (const s of ["one", "two"]) page.run(repo, ref, s);
      t.sqlite
        .prepare("UPDATE kg_page_sets SET status='succeeded' WHERE repo_id=? AND ref=?")
        .run(repo, ref);
    };
    add("r_app", "old", 100);
    add("r_lib", "older", 300);
    add("r_app", "recent", 30);
    add("r_app", "live", null);
    add("r_sam", "theirs", 300);
    // Main's wiki: never touched.
    t.sqlite.exec(`
      INSERT INTO wiki_pages (repo_id, slug, title, section, position, body, sources, inputs_hash,
                              generated_in)
        VALUES ('r_app', 'overview', 'Overview', 'Overview', 0, 'Main', '[]', 'h', 'b1');
    `);
    const left = () =>
      all(
        t.sqlite,
        `SELECT o.repo_id || ' ' || o.ref AS overlay, o.removed_at,
           (SELECT count(*) FROM kg_overlay_changes c WHERE c.overlay_id = o.overlay_id) AS changes,
           (SELECT count(*) FROM atlas_timeline_regroupings g WHERE g.overlay_id = o.overlay_id) AS regroupings,
           (SELECT count(*) FROM kg_page_sets p WHERE p.repo_id = o.repo_id AND p.ref = o.ref) AS sets,
           (SELECT count(*) FROM kg_page_set_pages p WHERE p.repo_id = o.repo_id AND p.ref = o.ref) AS pages
         FROM kg_overlays o ORDER BY o.repo_id, o.ref`,
      );
    return { ...t, left };
  }
  const kept = { removed_at: null, changes: 2, regroupings: 1, sets: 1, pages: 2 };
  const emptied = {
    removed_at: NOW.toISOString(),
    changes: 0,
    regroupings: 0,
    sets: 0,
    pages: 0,
  };

  test("removes the ended overlays' data exactly as the dry run listed, once", async () => {
    const t = overlaysSeed();
    const dry = await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, true, 1);
    expect((dry.seen as { repo: string; ref: string }[]).map((i) => [i.repo, i.ref])).toEqual([
      ["r_app", "refs/heads/timeline/old"],
      ["r_lib", "refs/heads/timeline/older"],
    ]);
    // Per timeline: two changes, a regrouping, a page set and two pages.
    expect(dry.items).toBe(12);
    expect(dry.bytes).toBeGreaterThan(0);
    expect(t.left().every((r) => (r as { changes: number }).changes === 2)).toBe(true);

    const real = await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, false, 1);
    expect(real).toEqual(dry);
    expect(t.left()).toEqual([
      { overlay: "r_app refs/heads/timeline/live", ...kept },
      { overlay: "r_app refs/heads/timeline/old", ...emptied },
      { overlay: "r_app refs/heads/timeline/recent", ...kept },
      { overlay: "r_lib refs/heads/timeline/older", ...emptied },
      { overlay: "r_sam refs/heads/timeline/theirs", ...kept },
    ]);
    // The row stays, emptied, so the timeline view can say what happened.
    expect(
      all(t.sqlite, "SELECT stats, ended_reason FROM kg_overlays WHERE ref LIKE '%/old'"),
    ).toEqual([{ stats: "{}", ended_reason: "landed" }]);
    expect(count(t.sqlite, "wiki_pages")).toBe(1);

    expect(await run(t.env, ORBIT, "ended-timeline-data", { days: 90 }, false)).toEqual({
      seen: [],
      items: 0,
      bytes: 0,
    });
  });

  test("a timeline that came back since select keeps its data; reopening forgets the removal", async () => {
    const t = overlaysSeed();
    const { endedTimelineData } = await import("./ended-timeline-data.ts");
    const ctx = { env: t.env, target: ORBIT, thresholds: { days: 90 }, now: NOW, limit: 10 };
    const selection = await endedTimelineData.select(ctx, null);
    expect(selection.items).toHaveLength(2);
    t.sqlite.exec(
      "UPDATE kg_overlays SET ended_at = NULL, ended_reason = NULL WHERE ref LIKE '%/older'",
    );
    expect((await endedTimelineData.remove(ctx, selection.items)).count).toBe(6);
    expect(t.left()[3]).toEqual({ overlay: "r_lib refs/heads/timeline/older", ...kept });

    // The removed one's bookmark returns: live again, and computed afresh.
    t.sqlite.exec("UPDATE kg_overlays SET ended_reason = 'ended' WHERE ref LIKE '%/old'");
    await reopenOverlay(t.env.DB, "r_app", "refs/heads/timeline/old");
    expect(
      all(
        t.sqlite,
        "SELECT ended_at, removed_at, head_commit FROM kg_overlays WHERE ref LIKE '%/old'",
      ),
    ).toEqual([{ ended_at: null, removed_at: null, head_commit: null }]);
  });
});

describe("analysis-caches", () => {
  const USED = { old: 100, recent: 10 };
  function cachesSeed(currentBuildDays = 5) {
    const t = seeded();
    const analysis = t.sqlite.prepare(`
      INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data, used_at)
      VALUES (?, ?, 'ts', '{"summary":"s"}', ?)`);
    const synthesis = t.sqlite.prepare(
      `INSERT INTO kg_synthesis (key, data, used_at) VALUES (?, '"x"', ?)`,
    );
    // In the current build's files (old use, but the next build reads it).
    analysis.run("current", ANALYZER, ago(USED.old));
    // In a running build's files.
    analysis.run("building", ANALYZER, ago(USED.old));
    // Unused for 100 days, in no build: goes.
    analysis.run("stale", ANALYZER, ago(USED.old));
    // A current file's analysis under an older analyzer: no build reads it.
    analysis.run("current", "v0", ago(USED.old));
    // Used 10 days ago: stays.
    analysis.run("fresh", ANALYZER, ago(USED.recent));
    // Never stamped since the column came (2026-10-04, 58 days before NOW).
    analysis.run("unstamped", ANALYZER, null);
    synthesis.run("s-stale", ago(40));
    synthesis.run("s-fresh", ago(USED.recent));
    synthesis.run("s-unstamped", null);
    t.sqlite.exec(`
      INSERT INTO kg_builds (id, repo_id, to_commit, status, started_at, finished_at)
        VALUES ('b_cur', 'r_app', 'c', 'succeeded', '${ago(currentBuildDays)}', '${ago(currentBuildDays)}'),
               ('b_run', 'r_lib', 'c', 'running', '${ago(1)}', NULL);
      INSERT INTO kg_state (repo_id, indexed_commit, last_build_id) VALUES ('r_app', 'c', 'b_cur');
      INSERT INTO kg_files (repo_id, snapshot, path, blob_oid, mode) VALUES
        ('r_app', 'current', 'a.ts', 'current', '100644'),
        ('r_lib', 'b_run', 'b.ts', 'building', '100644');
    `);
    const left = () =>
      [
        ...(
          all(t.sqlite, "SELECT blob_oid, analyzer FROM kg_blob_analysis") as {
            blob_oid: string;
            analyzer: string;
          }[]
        ).map((r) => `a ${r.blob_oid} ${r.analyzer}`),
        ...(all(t.sqlite, "SELECT key FROM kg_synthesis") as { key: string }[]).map(
          (r) => `s ${r.key}`,
        ),
      ].sort();
    return { ...t, left };
  }

  test("removes unused entries no current build references, exactly as the dry run listed, once", async () => {
    const t = cachesSeed();
    const before = t.left();
    const dry = await run(t.env, SITE, "analysis-caches", { days: 30 }, true);
    const gone = ["a current v0", "a stale v1", "a unstamped v1", "s s-stale", "s s-unstamped"].map(
      (k) => k.replace(" v1", ` ${ANALYZER}`),
    );
    const key = (i: { table: string; blob?: string; analyzer?: string; key?: string }) =>
      i.table === "analysis" ? `a ${i.blob} ${i.analyzer}` : `s ${i.key}`;
    expect((dry.seen as Parameters<typeof key>[0][]).map(key).sort()).toEqual(gone);
    expect(dry.items).toBe(5);
    expect(t.left()).toEqual(before);

    const real = await run(t.env, SITE, "analysis-caches", { days: 30 }, false);
    expect(real).toEqual(dry);
    expect(t.left()).toEqual(before.filter((k) => !gone.includes(k)));
    expect(await run(t.env, SITE, "analysis-caches", { days: 30 }, false)).toEqual({
      seen: [],
      items: 0,
      bytes: 0,
    });

    // A rebuild of the same files reuses what's left and analyzes only what went.
    const blobs = ["current", "building", "stale", "fresh", "unstamped"];
    const known = await loadAnalyses(t.env.DB, blobs);
    expect(blobs.filter((b) => !known.has(b))).toEqual(["stale", "unstamped"]);
    expect(await cached(t.env.DB, "s-fresh")).toBe("x");
    expect(await cached(t.env.DB, "s-stale")).toBeNull();
  });

  test("a synthesis an old current build may still use stays; an unknown build protects all", async () => {
    // The current build started 50 days ago: syntheses it used were stamped
    // since (less a day), so only those older than that can go.
    const t = cachesSeed(50);
    const syntheses = async () =>
      ((await run(t.env, SITE, "analysis-caches", { days: 30 }, true)).seen as { key?: string }[])
        .flatMap((i) => (i.key ? [i.key] : []))
        .sort();
    expect(await syntheses()).toEqual(["s-unstamped"]);
    // A repository with a graph whose build record is gone: keep every synthesis.
    t.sqlite.exec("UPDATE kg_state SET last_build_id = 'b_gone'");
    expect(await syntheses()).toEqual([]);
  });

  test("using a cached entry records it at most daily", async () => {
    const t = cachesSeed();
    const hour = new Date(Date.now() - 3_600_000).toISOString();
    t.sqlite.exec(`
      UPDATE kg_blob_analysis SET used_at = '${hour}' WHERE blob_oid = 'fresh';
      UPDATE kg_synthesis SET used_at = '${hour}' WHERE key = 's-fresh';
    `);
    await loadAnalyses(t.env.DB, ["stale", "fresh"]);
    await cached(t.env.DB, "s-stale");
    await cached(t.env.DB, "s-fresh");
    const used = Object.fromEntries(
      (
        all(
          t.sqlite,
          `SELECT blob_oid AS k, used_at FROM kg_blob_analysis WHERE analyzer = ?
           UNION ALL SELECT key, used_at FROM kg_synthesis`,
          ANALYZER,
        ) as { k: string; used_at: string | null }[]
      ).map((r) => [r.k, r.used_at]),
    );
    const today = Date.now() - 60_000;
    for (const k of ["stale", "s-stale"]) expect(Date.parse(used[k]!)).toBeGreaterThan(today);
    expect([used.fresh, used["s-fresh"]]).toEqual([hour, hour]);
  });
});

describe("ai-spend", () => {
  const MODEL = "test/model";
  // $1 per 1,000 output tokens: easy dollar arithmetic.
  const PRICES: PriceTable = { [MODEL]: { input: 0, output: 1000 } };
  const OLD = ago(100).slice(0, 10);
  const OLDER = ago(120).slice(0, 10);

  function spendSeed() {
    const t = seeded();
    const spend = t.sqlite.prepare(`
      INSERT INTO atlas_spend (id, account_id, day, scope, run_id, repo_id, purpose, model, status,
                               input_tokens, output_tokens, cost_micro_usd, reserved_input_tokens,
                               reserved_output_tokens, reserved_micro_usd, created_at)
      VALUES (?, ?, ?, 'build', ?, ?, 'capability_summary', '${MODEL}', ?, 10, ?, ?, 10, 1000, 1000000, ?)`);
    const add = (id: string, account: string, day: string, status: string, out: number) =>
      spend.run(
        id,
        account,
        day,
        `run-${day}`,
        account === "acc_orbit" ? "r_app" : "r_sam",
        status,
        out,
        out * 1000,
        `${day}T12:00:00.000Z`,
      );
    // Orbit spent $8.5 on OLD: settled, failed (kept at its maximum) and a
    // released call (charged nothing, no call).
    add("o1", "acc_orbit", OLD, "settled", 4000);
    add("o2", "acc_orbit", OLD, "failed", 1000);
    add("o3", "acc_orbit", OLD, "settled", 3500);
    add("o4", "acc_orbit", OLD, "released", 0);
    add("o5", "acc_orbit", OLDER, "settled", 1000);
    // A reservation still in flight, and a recent day: both stay.
    add("o6", "acc_orbit", OLDER, "reserved", 1000);
    add("o7", "acc_orbit", ago(10).slice(0, 10), "settled", 1000);
    add("s1", "acc_sam", OLD, "settled", 2000);
    return t;
  }

  /** What budget checks answer on OLD's afternoon. */
  async function answers(env: Env) {
    const at = new Date(`${OLD}T18:00:00.000Z`);
    const options: BudgetOptions = { prices: PRICES, now: at };
    const call = (out: number) =>
      reserveAtlasCall(
        env.DB,
        {
          scope: { kind: "build", repoId: "r_app", buildId: `new-${out}` },
          purpose: "capability_summary",
          model: MODEL,
          maxInputTokens: 1,
          maxOutputTokens: out,
        },
        options,
      );
    return {
      orbit: await atlasDailySpend(env.DB, "acc_orbit", { now: at }),
      sam: await atlasDailySpend(env.DB, "acc_sam", { now: at }),
      // $1 fits under $10 after $8.5; $1 more doesn't.
      fits: (await call(1000)).status,
      over: await call(1000).then((r) => (r.status === "exhausted" ? r.cap : r.status)),
    };
  }

  test("rolls up exactly the dry run's days into daily totals, once", async () => {
    const t = spendSeed();
    const dry = await run(t.env, SITE, "ai-spend", { days: 90 }, true, 1);
    expect((dry.seen as { account: string; day: string }[]).map((i) => [i.account, i.day])).toEqual(
      [
        ["acc_orbit", OLDER],
        ["acc_orbit", OLD],
        ["acc_sam", OLD],
      ],
    );
    expect(dry.items).toBe(6);
    expect(count(t.sqlite, "atlas_spend")).toBe(8);

    const real = await run(t.env, SITE, "ai-spend", { days: 90 }, false, 1);
    expect(real).toEqual(dry);
    expect(
      all(t.sqlite, "SELECT id FROM atlas_spend ORDER BY id").map((r) => (r as { id: string }).id),
    ).toEqual(["o6", "o7"]);
    expect(
      all(
        t.sqlite,
        `SELECT account_id, day, calls, input_tokens, output_tokens, cost_micro_usd
         FROM atlas_spend_daily ORDER BY account_id, day`,
      ),
    ).toEqual([
      {
        account_id: "acc_orbit",
        day: OLDER,
        calls: 1,
        input_tokens: 10,
        output_tokens: 1000,
        cost_micro_usd: 1_000_000,
      },
      {
        account_id: "acc_orbit",
        day: OLD,
        calls: 3,
        input_tokens: 40,
        output_tokens: 8500,
        cost_micro_usd: 8_500_000,
      },
      {
        account_id: "acc_sam",
        day: OLD,
        calls: 1,
        input_tokens: 10,
        output_tokens: 2000,
        cost_micro_usd: 2_000_000,
      },
    ]);
    expect(await run(t.env, SITE, "ai-spend", { days: 90 }, false)).toEqual({
      seen: [],
      items: 0,
      bytes: 0,
    });

    // The in-flight reservation, settled later, rolls up into the same day.
    t.sqlite.exec("UPDATE atlas_spend SET status = 'settled' WHERE id = 'o6'");
    await run(t.env, SITE, "ai-spend", { days: 90 }, false);
    expect(
      all(t.sqlite, "SELECT calls, cost_micro_usd FROM atlas_spend_daily WHERE day = ?", OLDER),
    ).toEqual([{ calls: 2, cost_micro_usd: 2_000_000 }]);
  });

  test("budget checks answer the same before and after the roll-up", async () => {
    const before = spendSeed();
    const after = spendSeed();
    await run(after.env, SITE, "ai-spend", { days: 90 }, false);
    expect(count(after.sqlite, "atlas_spend")).toBe(2);
    const expected = await answers(before.env);
    expect(expected).toMatchObject({
      orbit: { day: OLD, usd: 8.5 },
      sam: { usd: 2 },
      fits: "reserved",
      over: "daily_usd",
    });
    expect(await answers(after.env)).toEqual(expected);
  });
});
