// A Knowledge build meters its own model calls (CORE-286), and the usage
// report adds them up per update and per full rebuild.

import { describe, expect, test } from "vite-plus/test";
import type { CatalogPrice } from "../../shared/usage.ts";
import { db as databaseQueries } from "../schema.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { knowledgeUpdateSpend } from "../usage/report.ts";
import { buildAiUsage, finalBuildStats, meterBuildCall, priceUsage } from "./meter.ts";

const price = (metric: string, usdPerMillion: number): CatalogPrice =>
  ({
    id: metric.length,
    product: "workers_ai",
    metric,
    unit: "token",
    unitQuantity: 1_000_000,
    unitPriceUsd: usdPerMillion,
    includedQuantity: null,
    includedPeriod: null,
    effectiveFrom: "2026-10-01",
    sourceUrl: "https://example.com",
    sourceUpdated: null,
  }) as CatalogPrice;

function database() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann'), ('bob', 'user', 'bob', 'Bob');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'ledger', 'private', 'a1', ''), ('r2', 'bob', 'other', 'private', 'a2', '');
  `);
  return { sqlite, db: d1(sqlite) };
}

describe("build metering", () => {
  test("finalization preserves an old attempt's late answer rather than a retry snapshot", async () => {
    const { sqlite, db } = database();
    sqlite.exec(`
      INSERT INTO kg_builds (id, repo_id, to_commit, status, stats)
        VALUES ('b1', 'r1', 'c', 'running', '{"conceptReviewsAsked":1,"conceptReviewRoundsAsked":{"0":1}}'),
               ('empty', 'r1', 'c', 'running', '{}');
    `);
    const retry = sqlite
      .prepare(
        "SELECT json_extract(stats, '$.conceptReviewsAsked') asked FROM kg_builds WHERE id = 'b1'",
      )
      .get();
    if (!retry || typeof retry.asked !== "number") throw new Error("Missing retry snapshot");
    // Provider success was already returned; metering held the old callback
    // until after the retry read its round total.
    const metering = Promise.withResolvers<void>();
    const lateAnswer = metering.promise.then(() => {
      sqlite.exec(`
        INSERT INTO kg_concept_reviews (repo_id, a, b, score, inputs_hash)
          VALUES ('r1', 'a', 'b', 1, 'late');
        UPDATE kg_builds SET stats = json_set(stats,
          '$.conceptReviewsAsked', json_extract(stats, '$.conceptReviewsAsked') + 1,
          '$.conceptReviewRoundsAsked."0"', 2) WHERE id = 'b1';
      `);
    });
    metering.resolve();
    await lateAnswer;
    await databaseQueries(db)
      .updateTable("kg_builds")
      .set({
        status: "succeeded",
        stats: finalBuildStats({ conceptReviewsAsked: retry.asked, conceptReviewRounds: 1 }),
      })
      .where("id", "=", "b1")
      .execute();
    expect(
      sqlite
        .prepare(`
      SELECT json_extract(stats, '$.conceptReviewsAsked') total,
             json_extract(stats, '$.conceptReviewRoundsAsked."0"') round_total,
             json_extract(stats, '$.conceptReviewRounds') rounds
      FROM kg_builds WHERE id = 'b1'
    `)
        .get(),
    ).toMatchObject({ total: 2, round_total: 2, rounds: 1 });
    // A zero-review build gets an explicit zero; replay leaves existing totals.
    await databaseQueries(db)
      .updateTable("kg_builds")
      .set({ stats: finalBuildStats({}) })
      .where("id", "in", ["b1", "empty"])
      .execute();
    expect(
      sqlite
        .prepare(
          "SELECT json_extract(stats, '$.conceptReviewsAsked') total FROM kg_builds WHERE id = 'b1'",
        )
        .get(),
    ).toMatchObject({ total: 2 });
    expect(
      sqlite
        .prepare(
          "SELECT json_extract(stats, '$.conceptReviewsAsked') total FROM kg_builds WHERE id = 'empty'",
        )
        .get(),
    ).toMatchObject({ total: 0 });
  });

  test("calls add up by model, concurrently, and are priced at list prices", async () => {
    const { sqlite, db } = database();
    sqlite.exec(
      `INSERT INTO kg_builds (id, repo_id, to_commit, status) VALUES ('b1', 'r1', 'c', 'running')`,
    );
    await Promise.all([
      meterBuildCall(db, "b1", "@cf/cloudflare/clef", {
        calls: 1,
        input: 1000,
        output: 0,
        total: 1000,
      }),
      meterBuildCall(db, "b1", "@cf/cloudflare/clef", {
        calls: 1,
        input: 500,
        output: 0,
        total: 500,
      }),
      meterBuildCall(db, "b1", "@cf/zai-org/glm-5.3-flash", {
        calls: 2,
        input: 2000,
        output: 400,
        total: 2400,
      }),
      meterBuildCall(db, "b1", "@cf/other/unpriced", { calls: 1, input: 10, output: 0, total: 10 }),
      // A timed-out attempt (CORE-285) counts apart from the calls.
      meterBuildCall(db, "b1", "@cf/cloudflare/clef", {
        calls: 0,
        failed: 1,
        input: 0,
        output: 0,
        total: 0,
      }),
    ]);
    const { ai_usage } = sqlite.prepare("SELECT ai_usage FROM kg_builds WHERE id = 'b1'").get() as {
      ai_usage: string;
    };
    const usage = priceUsage(
      ai_usage,
      [
        price("@cf/cloudflare/clef:input", 0.24),
        price("@cf/zai-org/glm-5.3-flash:input", 0.1),
        price("@cf/zai-org/glm-5.3-flash:output", 0.4),
      ],
      "2026-10-05",
    );
    expect(usage).toMatchObject({ calls: 5, failedCalls: 1, inputTokens: 3510, outputTokens: 400 });
    expect(usage.byModel["@cf/cloudflare/clef"]).toMatchObject({
      calls: 2,
      failed: 1,
      input: 1500,
    });
    // 1500 × 0.24/M + 2000 × 0.1/M + 400 × 0.4/M
    expect(usage.costUsd).toBeCloseTo(0.00036 + 0.0002 + 0.00016, 8);
    expect(usage.unpriced).toEqual(["@cf/other/unpriced"]);
    // The same, read back with the database's own catalog.
    expect((await buildAiUsage(db, "b1")).calls).toBe(5);
  });

  test("the usage report shows what an update costs beside a full rebuild", async () => {
    const { sqlite, db } = database();
    const now = new Date("2026-10-05T12:00:00Z");
    const build = (id: string, repo: string, stats: unknown, started = "2026-10-04T10:00:00Z") =>
      sqlite
        .prepare(
          `INSERT INTO kg_builds (id, repo_id, to_commit, status, stats, started_at) VALUES (?, ?, 'c', 'succeeded', ?, ?)`,
        )
        .run(id, repo, JSON.stringify(stats), started);
    build("u1", "r1", { mode: "update", aiUsage: { calls: 10, costUsd: 0.002 } });
    build("u2", "r1", { mode: "update", aiUsage: { calls: 30, costUsd: 0.004 } });
    build("f1", "r1", { mode: "full", aiUsage: { calls: 900, costUsd: 0.5 } });
    // Before builds metered themselves; and one too old for the window.
    build("o1", "r1", { conceptReviewsAsked: 600 });
    build(
      "o2",
      "r1",
      { mode: "update", aiUsage: { calls: 1, costUsd: 9 } },
      "2026-08-01T00:00:00Z",
    );
    // Another account's.
    build("x1", "r2", { mode: "update", aiUsage: { calls: 5, costUsd: 1 } });

    const ann = await knowledgeUpdateSpend(db, "ann", now);
    expect(ann).toMatchObject({
      from: "2026-09-05",
      updates: { count: 2, calls: 40, costUsd: 0.006, eachUsd: 0.003 },
      fullRebuilds: { count: 1, calls: 900, costUsd: 0.5, eachUsd: 0.5 },
      unmetered: 1,
      repos: [{ name: "ann/ledger", updates: 3, fullRebuilds: 1, costUsd: 0.506 }],
    });
    const site = await knowledgeUpdateSpend(db, null, now);
    expect(site.updates.count).toBe(3);
    expect(site.repos.map((r) => r.name)).toEqual(["bob/other", "ann/ledger"]);
  });
});
