// The price catalog (CORE-208): the parsers against saved copies of
// Cloudflare's pricing pages (fixtures/, fetched 2026-10-04), the seed, the
// refresh's validation and diff, applying, editing and the audit trail.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { priceCost, type PriceProduct } from "../../shared/usage.ts";
import { AI_MODEL_CATALOG } from "../../shared/ai.ts";
import { ATLAS_PRICES } from "../knowledge/budget.ts";
import { MODELS } from "../knowledge/models.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  modelMetric,
  parsePricingPage,
  PRICING_PAGES,
  pricingPage,
  WORKERS_AI_MODELS,
} from "./pages.ts";
import {
  applyChange,
  checkCatalogDaily,
  discardChange,
  editPrice,
  listChanges,
  loadCatalog,
  priceHistory,
  priceOn,
  priceTimeline,
  publishedOf,
  refreshCatalog,
  type Fetcher,
} from "./prices.ts";
import { SEED_DATE, SEED_PRICES } from "./seed.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url).href);
const fixture = (product: PriceProduct) => readFileSync(join(FIXTURES, `${product}.txt`), "utf8");

/** Serves the saved pages, with any page's text replaced or an HTTP status instead. */
function pages(overrides: Partial<Record<PriceProduct, string | number>> = {}): Fetcher {
  return async (url) => {
    const page = PRICING_PAGES.find((p) => `${p.url}index.md` === url);
    if (!page) return new Response("not found", { status: 404 });
    const override = overrides[page.product];
    if (typeof override === "number") return new Response("error", { status: override });
    return new Response(override ?? fixture(page.product), {
      headers: { "content-type": "text/markdown" },
    });
  };
}

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin) VALUES
      ('acc_root', 'user', 'root', 'Root', 1);
  `);
  return { sqlite, DB: d1(sqlite) };
}

const rows = (sqlite: DatabaseSync, sql: string) => sqlite.prepare(sql).all();

describe("parsing the saved pricing pages", () => {
  test("yields exactly the seeded prices", () => {
    const parsed = PRICING_PAGES.flatMap((page) =>
      parsePricingPage(page, fixture(page.product), SEED_DATE),
    );
    expect(parsed).toEqual(SEED_PRICES);
  });

  test("reads the prices as published", () => {
    const seeded = (product: PriceProduct, metric: string) =>
      SEED_PRICES.find((p) => p.product === product && p.metric === metric);
    // A few by hand, against the pages' own words.
    expect(seeded("d1", "rows_written")).toMatchObject({
      unit: "row",
      unitQuantity: 1e6,
      unitPriceUsd: 1,
      includedQuantity: 50e6,
      includedPeriod: "month",
    });
    expect(seeded("durable_objects", "sqlite_storage")).toMatchObject({
      unit: "GB-month",
      unitPriceUsd: 0.2,
      includedQuantity: 5,
    });
    expect(seeded("vectorize", "stored_dimensions")).toMatchObject({
      unitQuantity: 100e6,
      unitPriceUsd: 0.05,
      includedQuantity: 10e6,
    });
    expect(seeded("r2", "ia_storage")).toMatchObject({ unitPriceUsd: 0.01, includedQuantity: 0 });
    expect(seeded("workers_ai", "neurons")).toMatchObject({
      unitQuantity: 1000,
      unitPriceUsd: 0.011,
      includedQuantity: 10_000,
      includedPeriod: "day",
    });
    expect(seeded("workers_ai", modelMetric(MODELS.reason, "output"))).toMatchObject({
      unit: "token",
      unitQuantity: 1e6,
      unitPriceUsd: 3.2,
      includedQuantity: null,
    });
    expect(seeded("workers_ai", "@cf/black-forest-labs/flux-1-schnell:tile")).toMatchObject({
      unit: "tile",
      unitQuantity: 1,
      unitPriceUsd: 0.0000528,
    });
  });

  test("prices whose billing starts later take effect then", () => {
    for (const p of SEED_PRICES) {
      const expected =
        p.product === "artifacts"
          ? "2026-10-14"
          : p.product === "ai_search"
            ? "2026-11-01"
            : SEED_DATE;
      expect(`${p.product} ${p.metric} ${p.effectiveFrom}`).toBe(
        `${p.product} ${p.metric} ${expected}`,
      );
    }
    // After the start, the page's date is in the past: the refresh's own day applies.
    const later = parsePricingPage(pricingPage("artifacts"), fixture("artifacts"), "2026-12-01");
    expect(later.map((p) => p.effectiveFrom)).toEqual(["2026-12-01", "2026-12-01"]);
  });

  test("each price records its page and that page's date", () => {
    for (const p of SEED_PRICES) {
      expect(p.sourceUrl).toBe(pricingPage(p.product).url);
      expect(p.sourceUpdated).toMatch(/^2026-\d\d-\d\d$/);
    }
  });

  test("malformed pages are rejected with a clear reason", () => {
    const d1Page = pricingPage("d1");
    const parse = (text: string) => () => parsePricingPage(d1Page, text, SEED_DATE);
    expect(parse("")).toThrow("D1: not a pricing page");
    expect(parse("<html><body>Service unavailable</body></html>")).toThrow("not a pricing page");
    // A row gone.
    expect(parse(fixture("d1").replace(/^\| Rows written .*$/m, ""))).toThrow(
      "D1 rows_written: no row or column for it",
    );
    // A unit changed.
    expect(parse(fixture("d1").replace("$0.75 / GB-mo", "$0.75 / TB-mo"))).toThrow(
      'D1 storage: the price is per "TB-mo", expected',
    );
    // The price gone from its cell.
    expect(parse(fixture("d1").replace("+ $0.001 / million rows", "+ contact sales"))).toThrow(
      "D1 rows_read: no price",
    );
    // A table renamed away.
    expect(parse(fixture("d1").replace("## Billing metrics", "## Billing"))).toThrow(
      "D1: no billing table",
    );
    // A tracked model no longer listed.
    expect(() =>
      parsePricingPage(
        pricingPage("workers_ai"),
        fixture("workers_ai").replace(/^\| @cf\/cloudflare\/clef-flash .*$/m, ""),
        SEED_DATE,
      ),
    ).toThrow("Workers AI: no price for @cf/cloudflare/clef-flash");
  });
});

describe("the seed", () => {
  test("the migration inserts exactly the seeded prices, as one applied change", () => {
    const { sqlite } = setup();
    expect(
      rows(sqlite, "SELECT id, kind, status, created_by FROM cloudflare_price_changes"),
    ).toEqual([{ id: 1, kind: "seed", status: "applied", created_by: null }]);
    const stored = rows(
      sqlite,
      `SELECT product, metric, unit, unit_quantity, unit_price_usd, included_quantity,
              included_period, effective_from, source_url, source_updated, provenance
         FROM cloudflare_prices ORDER BY id`,
    );
    expect(stored).toEqual(
      SEED_PRICES.map((p) => ({
        product: p.product,
        metric: p.metric,
        unit: p.unit,
        unit_quantity: p.unitQuantity,
        unit_price_usd: p.unitPriceUsd,
        included_quantity: p.includedQuantity,
        included_period: p.includedPeriod,
        effective_from: p.effectiveFrom,
        source_url: p.sourceUrl,
        source_updated: p.sourceUpdated,
        provenance: "seed",
      })),
    );
  });

  test("Atlas budgets spend at the catalog's prices, exactly as before", () => {
    expect(ATLAS_PRICES).toEqual({
      [MODELS.fast]: { input: 0.15, output: 0.5 },
      "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
      [MODELS.reason]: { input: 0.45, output: 3.2 },
    });
  });

  test("the AI settings' model prices agree with the catalog", () => {
    const perMillion = (model: string, metric: "input" | "output") => {
      const price = SEED_PRICES.find(
        (p) => p.product === "workers_ai" && p.metric === modelMetric(model, metric),
      );
      return price ? (price.unitPriceUsd * 1e6) / price.unitQuantity : 0;
    };
    for (const option of Object.values(AI_MODEL_CATALOG).flat()) {
      expect([option.model, perMillion(option.model, "input")]).toEqual([
        option.model,
        option.inputUsdPerMillion,
      ]);
      expect([option.model, perMillion(option.model, "output")]).toEqual([
        option.model,
        option.outputUsdPerMillion,
      ]);
    }
  });

  test("every Workers AI model the code calls has its prices in the catalog", () => {
    const worker = fileURLToPath(new URL("../", import.meta.url).href);
    const shared = fileURLToPath(new URL("../../shared/", import.meta.url).href);
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === "fixtures"
            ? []
            : files(join(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const used = new Set(
      [...files(worker), ...files(shared)].flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/"(@cf\/[\w.-]+\/[\w.-]+)"/g)].map((m) => m[1]!),
      ),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const model of used) {
      expect(Object.keys(WORKERS_AI_MODELS), `${model} is called but not priced`).toContain(model);
      for (const metric of WORKERS_AI_MODELS[model]!)
        expect(
          SEED_PRICES.some(
            (p) => p.product === "workers_ai" && p.metric === modelMetric(model, metric),
          ),
        ).toBe(true);
    }
  });

  test("costs are quantity × price per unit quantity", () => {
    const storage = SEED_PRICES.find((p) => p.product === "d1" && p.metric === "storage")!;
    expect(priceCost(storage, 10)).toBeCloseTo(7.5, 12);
    const written = SEED_PRICES.find((p) => p.product === "d1" && p.metric === "rows_written")!;
    expect(priceCost(written, 3_000_000)).toBeCloseTo(3, 12);
    const stored = SEED_PRICES.find(
      (p) => p.product === "vectorize" && p.metric === "stored_dimensions",
    )!;
    expect(priceCost(stored, 200_000_000)).toBeCloseTo(0.1, 12);
  });
});

describe("refreshing the catalog", () => {
  test("unchanged pages propose nothing, and the check is recorded", async () => {
    const { DB } = setup();
    const change = await refreshCatalog(DB, {
      fetcher: pages(),
      now: new Date("2026-10-05T12:00:00Z"),
      actorId: "acc_root",
    });
    expect(change).toMatchObject({
      kind: "refresh",
      status: "unchanged",
      createdBy: "root",
      baseVersion: 1,
      diff: [],
    });
    expect(change.pages.map((p) => [p.product, p.error])).toEqual(
      PRICING_PAGES.map((p) => [p.product, null]),
    );
    expect(change.pages.find((p) => p.product === "r2")?.sourceUpdated).toBe("2026-10-01");
  });

  test("a changed price yields its diff; applying keeps the old version with its date", async () => {
    const { DB, sqlite } = setup();
    const now = new Date("2026-10-20T09:00:00Z");
    const change = await refreshCatalog(DB, {
      fetcher: pages({ d1: fixture("d1").replace("$0.75 / GB-mo", "$0.80 / GB-mo") }),
      now,
      actorId: "acc_root",
    });
    expect(change.status).toBe("pending");
    expect(change.diff).toEqual([
      {
        product: "d1",
        metric: "storage",
        label: "Storage",
        kind: "changed",
        fields: ["price"],
        before: SEED_PRICES.find((p) => p.product === "d1" && p.metric === "storage"),
        after: {
          ...SEED_PRICES.find((p) => p.product === "d1" && p.metric === "storage"),
          unitPriceUsd: 0.8,
          effectiveFrom: "2026-10-20",
        },
      },
    ]);
    // Nothing changes until it's applied.
    expect((await loadCatalog(DB, now)).pending?.id).toBe(change.id);
    expect(priceOn(await priceTimeline(DB), "d1", "storage", "2026-10-25")?.unitPriceUsd).toBe(
      0.75,
    );

    const applied = await applyChange(DB, change.id, "acc_root", now);
    expect(applied.status).toBe("applied");
    const timeline = await priceTimeline(DB);
    expect(priceOn(timeline, "d1", "storage", "2026-10-10")?.unitPriceUsd).toBe(0.75);
    expect(priceOn(timeline, "d1", "storage", "2026-10-25")).toMatchObject({
      unitPriceUsd: 0.8,
      provenance: "refresh",
      recordedBy: "root",
      changeId: change.id,
    });
    expect(priceOn(timeline, "d1", "storage", "2026-10-25")?.fetchedAt).toBeTruthy();
    const catalog = await loadCatalog(DB, now);
    expect(catalog.version).toBe(change.id);
    expect(catalog.pending).toBeNull();
    expect(catalog.prices.filter((p) => p.product === "d1" && p.metric === "storage")).toHaveLength(
      1,
    );
    // Both versions are kept; neither is superseded (different dates).
    const history = await priceHistory(DB, "d1", "storage");
    expect(history.map((p) => [p.effectiveFrom, p.unitPriceUsd, p.supersededAt])).toEqual([
      ["2026-10-20", 0.8, null],
      ["2026-10-04", 0.75, null],
    ]);
    // Applying again does nothing.
    expect((await applyChange(DB, change.id, "acc_root", now)).status).toBe("not_pending");
    expect(rows(sqlite, "SELECT COUNT(*) AS n FROM cloudflare_prices")).toEqual([
      { n: SEED_PRICES.length + 1 },
    ]);
  });

  test("a change on the seed's own day supersedes that version, which is kept", async () => {
    const { DB } = setup();
    const now = new Date(`${SEED_DATE}T20:00:00Z`);
    const change = await refreshCatalog(DB, {
      fetcher: pages({ queues: fixture("queues").replace("$0.40/million", "$0.45/million") }),
      now,
      actorId: "acc_root",
    });
    expect(change.diff.map((e) => [e.metric, e.fields])).toEqual([["operations", ["price"]]]);
    await applyChange(DB, change.id, "acc_root", now);
    const history = await priceHistory(DB, "queues", "operations");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ unitPriceUsd: 0.45, supersededAt: null });
    expect(history[1]).toMatchObject({ unitPriceUsd: 0.4, supersededAt: now.toISOString() });
    expect(priceOn(await priceTimeline(DB), "queues", "operations", SEED_DATE)?.unitPriceUsd).toBe(
      0.45,
    );
  });

  test("implausible changes, unit changes and failed fetches reject only their page", async () => {
    const { DB } = setup();
    const change = await refreshCatalog(DB, {
      fetcher: pages({
        d1: fixture("d1").replace("$0.75 / GB-mo", "$8.00 / GB-mo"),
        r2: fixture("r2").replace("| Storage | $0.015 / GB-month", "| Storage | $0.015 / GB"),
        vectorize: 503,
        queues: fixture("queues").replace("$0.40/million", "$0.45/million"),
      }),
      now: new Date("2026-10-20T09:00:00Z"),
    });
    const errors = Object.fromEntries(change.pages.map((p) => [p.product, p.error]));
    expect(errors.d1).toBe(
      "D1: Storage: the price moved from $0.75 per 1 GB-month to $8 per 1 GB-month, more than 10x",
    );
    expect(errors.r2).toContain('R2 standard_storage: the price is per "GB"');
    expect(errors.vectorize).toBe("Vectorize: the page answered HTTP 503");
    expect(errors.workers_ai).toBeNull();
    // Only the valid page's change is proposed.
    expect(change.status).toBe("pending");
    expect(change.diff.map((e) => `${e.product}/${e.metric}`)).toEqual(["queues/operations"]);
    expect(change.note).toBe("3 of 9 pages rejected");
  });

  test("a stored unit that no longer matches the page rejects the page", async () => {
    const { DB, sqlite } = setup();
    sqlite.exec(
      `UPDATE cloudflare_prices SET unit = 'GB' WHERE product = 'd1' AND metric = 'storage'`,
    );
    const change = await refreshCatalog(DB, {
      fetcher: pages(),
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(change.pages.find((p) => p.product === "d1")?.error).toBe(
      "D1: Storage: the unit changed from GB to GB-month",
    );
  });

  test("when no page can be read, the refresh is rejected", async () => {
    const { DB } = setup();
    const all = Object.fromEntries(PRICING_PAGES.map((p) => [p.product, 500]));
    const change = await refreshCatalog(DB, {
      fetcher: pages(all),
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(change.status).toBe("rejected");
    expect(change.diff).toEqual([]);
  });

  test("a moved billing start reschedules the price", async () => {
    const { DB } = setup();
    const now = new Date("2026-10-20T00:00:00Z");
    const change = await refreshCatalog(DB, {
      fetcher: pages({
        ai_search: fixture("ai_search").replace(
          "AI Search billing begins on November 1, 2026",
          "AI Search billing begins on December 1, 2026",
        ),
      }),
      now,
    });
    expect(change.diff.map((e) => [e.metric, e.fields, e.after.effectiveFrom])).toEqual([
      ["fulltext_queries", ["effectiveFrom"], "2026-12-01"],
      ["ingestion_tokens", ["effectiveFrom"], "2026-12-01"],
      ["semantic_queries", ["effectiveFrom"], "2026-12-01"],
      ["storage", ["effectiveFrom"], "2026-12-01"],
    ]);
    await applyChange(DB, change.id, "acc_root", now);
    const timeline = await priceTimeline(DB);
    expect(priceOn(timeline, "ai_search", "storage", "2026-11-15")).toBeNull();
    expect(priceOn(timeline, "ai_search", "storage", "2026-12-02")?.unitPriceUsd).toBe(2);
    // The catalog shows the scheduled price before it starts.
    const catalog = await loadCatalog(DB, now);
    expect(
      catalog.prices.filter((p) => p.product === "ai_search").map((p) => p.effectiveFrom),
    ).toEqual(["2026-12-01", "2026-12-01", "2026-12-01", "2026-12-01"]);
  });

  test("a newer refresh supersedes a pending one; a stale diff can't be applied", async () => {
    const { DB } = setup();
    const now = new Date("2026-10-20T00:00:00Z");
    const changed = pages({ queues: fixture("queues").replace("$0.40/million", "$0.45/million") });
    const first = await refreshCatalog(DB, { fetcher: changed, now });
    const second = await refreshCatalog(DB, { fetcher: changed, now });
    expect((await listChanges(DB)).map((c) => [c.id, c.status])).toEqual([
      [second.id, "pending"],
      [first.id, "superseded"],
      [1, "applied"],
    ]);
    expect((await applyChange(DB, first.id, "acc_root", now)).status).toBe("not_pending");
    // An edit lands first: the pending diff was computed against an older catalog.
    await editPrice(
      DB,
      { product: "d1", metric: "storage", unitPriceUsd: 0.7, note: "test" },
      "acc_root",
      now,
    );
    expect(await applyChange(DB, second.id, "acc_root", now)).toMatchObject({ status: "stale" });
    expect((await discardChange(DB, second.id, "acc_root", now)).status).toBe("applied");
    expect((await listChanges(DB))[1]).toMatchObject({
      id: second.id,
      status: "discarded",
      decidedBy: "root",
    });
  });

  test("the daily check runs once per UTC day", async () => {
    const { DB } = setup();
    let fetched = 0;
    const counting: Fetcher = (url, init) => {
      fetched++;
      return pages()(url, init);
    };
    const morning = await checkCatalogDaily(DB, {
      fetcher: counting,
      now: new Date("2026-10-20T01:00:00Z"),
    });
    expect(morning).toMatchObject({ kind: "check", status: "unchanged", createdBy: null });
    expect(
      await checkCatalogDaily(DB, { fetcher: counting, now: new Date("2026-10-20T23:00:00Z") }),
    ).toBeNull();
    expect(fetched).toBe(PRICING_PAGES.length);
    expect(
      await checkCatalogDaily(DB, { fetcher: counting, now: new Date("2026-10-21T00:30:00Z") }),
    ).not.toBeNull();
  });
});

describe("editing a price by hand", () => {
  test("is audited and versioned", async () => {
    const { DB } = setup();
    const now = new Date("2026-10-20T00:00:00Z");
    const result = await editPrice(
      DB,
      { product: "r2", metric: "standard_storage", unitPriceUsd: 0.02, note: "Negotiated rate" },
      "acc_root",
      now,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.change).toMatchObject({
      kind: "manual",
      status: "applied",
      createdBy: "root",
      note: "Negotiated rate",
    });
    expect(result.change.diff[0]).toMatchObject({
      fields: ["price"],
      after: { unitPriceUsd: 0.02, effectiveFrom: "2026-10-20" },
    });
    const history = await priceHistory(DB, "r2", "standard_storage");
    expect(history[0]).toMatchObject({
      unitPriceUsd: 0.02,
      provenance: "manual",
      recordedBy: "root",
      note: "Negotiated rate",
      fetchedAt: null,
      effectiveFrom: "2026-10-20",
    });
    expect(history[1]).toMatchObject({ unitPriceUsd: 0.015, supersededAt: null });
    // A later refresh sees the edited price as the catalog's.
    const refresh = await refreshCatalog(DB, { fetcher: pages(), now });
    expect(refresh.diff.map((e) => [e.metric, publishedOf(e.after).unitPriceUsd])).toEqual([
      ["standard_storage", 0.015],
    ]);
  });

  test("rejects what it can't record", async () => {
    const { DB } = setup();
    const edit = (e: object) =>
      editPrice(
        DB,
        { product: "d1", metric: "storage", note: "x", unitPriceUsd: 1, ...e },
        "acc_root",
      );
    expect(await edit({ metric: "nope" })).toEqual({
      status: "invalid",
      message: "No such price in the catalog.",
    });
    expect(await edit({ unitPriceUsd: -1 })).toMatchObject({ status: "invalid" });
    expect(await edit({ unitPriceUsd: "1" })).toMatchObject({ status: "invalid" });
    expect(await edit({ unitQuantity: 0 })).toMatchObject({ status: "invalid" });
    expect(await edit({ effectiveFrom: "next week" })).toMatchObject({ status: "invalid" });
    expect(await edit({ note: " " })).toEqual({
      status: "invalid",
      message: "Say why the price is being changed.",
    });
    expect(await edit({ unitPriceUsd: 0.75, effectiveFrom: SEED_DATE })).toEqual({
      status: "invalid",
      message: "That is already the price.",
    });
  });
});
