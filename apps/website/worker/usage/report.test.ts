// The usage and cost report (CORE-209): costs are usage × the catalog's prices
// in the right units, estimates are labelled, the report reads only complete
// collection days, the site counts shared blobs once, and only administrators
// see it.

import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { UsageLine, UsageReport } from "../../shared/usage.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { priceTimeline } from "./prices.ts";
import {
  accountUsageReport,
  addDays,
  buildReport,
  collected,
  reportCsv,
  siteUsageReport,
  type SnapshotRow,
} from "./report.ts";
import { accountUsageApi, siteUsageApi } from "./report-api.ts";

const FLASH = "@cf/zai-org/glm-5.3-flash";
const EMBED = "@cf/qwen/qwen3-embedding-0.6b";

/** A typed fixture in CORE-207's snapshot shape. */
const storage = (
  day: string,
  construct: SnapshotRow["construct"],
  item: string,
  metric: string,
  quantity: number,
  estimated = false,
): SnapshotRow => ({
  day,
  construct,
  item,
  metric,
  kind: "storage",
  quantity,
  estimated,
  method: `${metric} of ${item}`,
  collected_at: `${day}T05:00:00.000Z`,
});
const activity = (
  day: string,
  construct: SnapshotRow["construct"],
  item: string,
  metric: string,
  quantity: number,
): SnapshotRow => ({ ...storage(day, construct, item, metric, quantity), kind: "activity" });

/** `days` daily collections ending on `asOf`: the same storage each day, activity the day before. */
function collections(asOf: string, days: number, perDay: (day: string) => SnapshotRow[]) {
  const rows: SnapshotRow[] = [];
  for (let i = days - 1; i >= 0; i--) rows.push(...perDay(addDays(asOf, -i)));
  return rows;
}

const STORAGE = (day: string) => [
  storage(day, "d1", "ci-logs", "rows", 1000),
  storage(day, "d1", "ci-logs", "bytes", 2.5e9),
  storage(day, "d1", "push-log", "bytes", 1e9, true),
  storage(day, "durable_objects", "Tracker", "instances", 1),
  storage(day, "durable_objects", "Tracker", "bytes", 1e9),
  storage(day, "r2", "registry_blobs", "bytes", 20e9),
  storage(day, "vectorize", "knowledge", "dimensions", 200e6, true),
  storage(day, "artifacts", "repositories", "bytes", 4e9, true),
  storage(day, "ai_search", "knowledge", "bytes", 3e9),
];
const ACTIVITY = (day: string) => [
  activity(addDays(day, -1), "workers_ai", FLASH, "calls", 10),
  activity(addDays(day, -1), "workers_ai", FLASH, "input_tokens", 2e6 / 30),
  activity(addDays(day, -1), "workers_ai", FLASH, "output_tokens", 1e6 / 30),
  activity(addDays(day, -1), "workers_ai", EMBED, "total_tokens", 10e6 / 30),
  activity(addDays(day, -1), "ci", "sandbox", "minutes", 12),
];

async function timeline() {
  return priceTimeline(d1(migratedDatabase()));
}

function lineOf(report: UsageReport, construct: string, item: string): UsageLine {
  const found = report.constructs
    .flatMap((c) => c.lines)
    .find((l) => l.construct === construct && l.item === item);
  if (!found) throw new Error(`no line ${construct}/${item}`);
  return found;
}

describe("costs", () => {
  test("equal usage × catalog prices, in the prices' units", async () => {
    const asOf = "2026-10-20";
    const report = buildReport({
      scope: "account",
      account: { slug: "orbit", displayName: "Orbit" },
      rows: collections(asOf, 30, (day) => [...STORAGE(day), ...ACTIVITY(day)]),
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    // Activity: the 30 days before asOf (a day's activity is collected the day after).
    expect(report.window).toEqual({ from: "2026-09-20", to: "2026-10-19", daysMeasured: 30 });
    const monthly = (construct: string, item: string) => lineOf(report, construct, item).monthlyUsd;
    // D1: 2.5 GB × $0.75 per GB-month.
    expect(monthly("d1", "ci-logs")).toBeCloseTo(1.875, 10);
    expect(lineOf(report, "d1", "ci-logs").costs[0]).toMatchObject({
      product: "d1",
      metric: "storage",
      unit: "GB-month",
      quantity: 2.5,
      unitPriceUsd: 0.75,
      includedQuantity: 5,
      startsOn: null,
      estimated: false,
    });
    // Durable Objects SQLite: 1 GB × $0.20. R2 Standard: 20 GB × $0.015.
    expect(monthly("durable_objects", "Tracker")).toBeCloseTo(0.2, 10);
    expect(monthly("r2", "registry_blobs")).toBeCloseTo(0.3, 10);
    // Vectorize: 200M stored dimensions × $0.05 per 100M.
    expect(monthly("vectorize", "knowledge")).toBeCloseTo(0.1, 10);
    // Artifacts ($0.50/GB-month) is billed from 2026-10-14: in effect on the 20th.
    expect(monthly("artifacts", "repositories")).toBeCloseTo(2, 10);
    // AI Search isn't billed until 2026-11-01: shown, kept out of the total.
    const search = lineOf(report, "ai_search", "knowledge");
    expect(search.monthlyUsd).toBe(0);
    expect(search.costs[0]).toMatchObject({ startsOn: "2026-11-01", unitPriceUsd: 2 });
    expect(search.costs[0]!.monthlyUsd).toBeCloseTo(6, 10);
    expect(search.note).toContain("Billed from 2026-11-01");
    // Workers AI over 30 days: 2M input × $0.15/M + 1M output × $0.50/M.
    expect(monthly("workers_ai", FLASH)).toBeCloseTo(0.8, 10);
    // An embedding model reports only totals: priced as input ($0.012/M), labelled.
    const embed = lineOf(report, "workers_ai", EMBED);
    expect(embed.monthlyUsd).toBeCloseTo(0.12, 10);
    expect(embed.estimated).toBe(true);
    expect(embed.note).toContain("priced as input tokens");
    // CI minutes have no price: shown, with why.
    const ci = lineOf(report, "ci", "sandbox");
    expect(ci.costs).toEqual([]);
    expect(ci.figures[0]).toMatchObject({ metric: "minutes", quantity: 360 });
    expect(ci.note).toContain("isn't in the price catalog");
    expect(report.monthlyUsd).toBeCloseTo(1.875 + 0.75 + 0.2 + 0.3 + 0.1 + 2 + 0.8 + 0.12, 10);
  });

  test("estimated figures are labelled; measured ones aren't", async () => {
    const asOf = "2026-10-20";
    const report = buildReport({
      scope: "account",
      account: null,
      rows: collections(asOf, 30, STORAGE),
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    expect(lineOf(report, "d1", "ci-logs").estimated).toBe(false);
    expect(lineOf(report, "d1", "push-log").estimated).toBe(true);
    expect(lineOf(report, "d1", "push-log").costs[0]!.estimated).toBe(true);
    expect(report.constructs.find((c) => c.construct === "d1")?.estimated).toBe(true);
    expect(report.notes.join(" ")).toContain("gross list prices");
  });

  test("before billing starts, a price is shown with its start and kept out of totals", async () => {
    const asOf = "2026-10-10";
    const report = buildReport({
      scope: "account",
      account: null,
      rows: STORAGE(asOf),
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    const artifacts = lineOf(report, "artifacts", "repositories");
    expect(artifacts.monthlyUsd).toBe(0);
    expect(artifacts.costs[0]).toMatchObject({ startsOn: "2026-10-14" });
    expect(artifacts.costs[0]!.monthlyUsd).toBeCloseTo(2, 10);
  });

  test("activity measured on fewer days is extrapolated to 30 and labelled", async () => {
    const asOf = "2026-10-20";
    const report = buildReport({
      scope: "account",
      account: null,
      rows: collections(asOf, 10, (day) => [...STORAGE(day), ...ACTIVITY(day)]),
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    expect(report.window.daysMeasured).toBe(10);
    const flash = lineOf(report, "workers_ai", FLASH);
    // 10 days of a 30-day volume, × 3.
    expect(flash.monthlyUsd).toBeCloseTo(0.8, 10);
    expect(flash.estimated).toBe(true);
    expect(flash.note).toContain("extrapolated to 30 days from 10 measured");
    // The figures themselves are what was measured.
    expect(flash.figures.find((f) => f.metric === "input_tokens")?.quantity).toBeCloseTo(
      2e6 / 3,
      4,
    );
  });

  test("the trend is each day's storage at a thirtieth of a month, plus its activity", async () => {
    const asOf = "2026-10-20";
    const rows = [
      storage("2026-10-19", "d1", "ci-logs", "bytes", 3e9),
      storage(asOf, "d1", "ci-logs", "bytes", 6e9),
      activity("2026-10-19", "workers_ai", FLASH, "output_tokens", 1e6),
    ];
    const report = buildReport({
      scope: "account",
      account: null,
      rows,
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    expect(report.trend).toHaveLength(30);
    const day = (d: string) => report.trend.find((t) => t.day === d)!;
    expect(day("2026-10-19").costUsd).toBeCloseTo((3 * 0.75) / 30 + 0.5, 10);
    expect(day("2026-10-19").byConstruct).toEqual({ d1: (3 * 0.75) / 30, workers_ai: 0.5 });
    expect(day(asOf).costUsd).toBeCloseTo((6 * 0.75) / 30, 10);
    expect(day(asOf).measured).toBe(true);
    expect(day("2026-10-01")).toMatchObject({ costUsd: 0, measured: false });
  });

  test("lines link to the retention categories that clean them up, within the page's scope", async () => {
    const asOf = "2026-10-20";
    const rows = [
      ...STORAGE(asOf),
      storage(asOf, "d1", "atlas", "bytes", 1e6),
      storage(asOf, "d1", "repositories", "bytes", 1e6),
      storage(asOf, "durable_objects", "Assistant", "bytes", 1e6),
    ];
    const account = buildReport({
      scope: "account",
      account: null,
      rows,
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    const ids = (r: UsageReport, construct: string, item: string) =>
      lineOf(r, construct, item).categories.map((c) => c.id);
    expect(ids(account, "d1", "ci-logs")).toEqual(["ci-logs"]);
    expect(ids(account, "d1", "push-log")).toEqual(["push-log"]);
    expect(ids(account, "d1", "atlas")).toEqual(["atlas-snapshots"]);
    expect(ids(account, "d1", "repositories")).toEqual([]);
    expect(ids(account, "durable_objects", "Tracker")).toEqual([
      "closed-issues",
      "tracker-activity",
    ]);
    expect(ids(account, "durable_objects", "Assistant")).toEqual(["assistant-chats"]);
    // The registry proxy cache is site data: only the site page links it.
    expect(ids(account, "r2", "registry_blobs")).toEqual([]);
    const site = buildReport({
      scope: "site",
      account: null,
      rows,
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    expect(ids(site, "r2", "registry_blobs")).toEqual(["registry-proxy-cache"]);
  });

  test("CSV has one row per figure with its price and monthly cost", async () => {
    const asOf = "2026-10-20";
    const report = buildReport({
      scope: "account",
      account: null,
      rows: [
        storage(asOf, "d1", "ci-logs", "rows", 5),
        storage(asOf, "d1", "ci-logs", "bytes", 2e9),
      ],
      asOf,
      timeline: await timeline(),
      version: 1,
    });
    const lines = reportCsv(report).trim().split("\n");
    expect(lines[0]).toBe(
      "construct,item,label,kind,metric,quantity,estimated,method,price,billable_quantity,unit,unit_price_usd,per_units,monthly_usd,billed_from,price_source,retention_categories",
    );
    expect(lines).toContain(
      "d1,ci-logs,CI logs,storage,bytes,2000000000,no,bytes of ci-logs,d1/storage,2,GB-month,0.75,1,1.500000,2026-10-04,https://developers.cloudflare.com/d1/platform/pricing/,ci-logs",
    );
    expect(lines).toContain("d1,ci-logs,CI logs,storage,rows,5,no,rows of ci-logs,,,,,,,,,ci-logs");
  });

  test("no collection yet says so", async () => {
    const report = buildReport({
      scope: "account",
      account: null,
      rows: [],
      asOf: null,
      timeline: await timeline(),
      version: 1,
    });
    expect(report).toMatchObject({ asOf: null, monthlyUsd: 0, constructs: [] });
    expect(report.notes.join(" ")).toContain("hasn't been collected yet");
  });
});

describe("which day a report describes", () => {
  test("a day counts once its collection finished for the account", () => {
    expect(collected(null, "2026-10-20", "acc_b")).toBe(true);
    expect(collected({ day: "2026-10-21", account: "", done: false }, "2026-10-20", "acc_b")).toBe(
      true,
    );
    expect(
      collected({ day: "2026-10-20", account: "acc_c", done: false }, "2026-10-20", "acc_b"),
    ).toBe(true);
    expect(
      collected({ day: "2026-10-20", account: "acc_b", done: false }, "2026-10-20", "acc_b"),
    ).toBe(false);
    expect(
      collected({ day: "2026-10-20", account: "acc_a", done: false }, "2026-10-20", "acc_b"),
    ).toBe(false);
    expect(
      collected({ day: "2026-10-20", account: "acc_z", done: false }, "2026-10-20", null),
    ).toBe(false);
    expect(collected({ day: "2026-10-20", account: "acc_z", done: true }, "2026-10-20", null)).toBe(
      true,
    );
  });
});

// ---- against the database and through the API -------------------------------------

function insert(sqlite: DatabaseSync, account: string, rows: SnapshotRow[]) {
  const statement = sqlite.prepare(
    `INSERT INTO usage_snapshots (day, account_id, construct, item, metric, kind, quantity, estimated, method, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows)
    statement.run(
      r.day,
      account,
      r.construct,
      r.item,
      r.metric,
      r.kind,
      r.quantity,
      r.estimated ? 1 : 0,
      r.method,
      r.collected_at ?? "",
    );
}

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin) VALUES
      ('acc_ann', 'user', 'ann', 'Ann', 0), ('acc_bob', 'user', 'bob', 'Bob', 0),
      ('acc_cat', 'user', 'cat', 'Cat', 0), ('acc_root', 'user', 'root', 'Root', 1);
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role)
      VALUES ('acc_org', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('acc_org', 'acc_ann', 'owner'), ('acc_org', 'acc_cat', 'member');
  `);
  const day = "2026-10-20";
  const yesterday = "2026-10-19";
  // Orbit: yesterday complete; today's collection is still on Orbit.
  insert(sqlite, "acc_org", [
    ...STORAGE(yesterday),
    ...ACTIVITY(yesterday),
    storage(day, "d1", "ci-logs", "bytes", 1e9),
  ]);
  insert(sqlite, "acc_bob", [
    storage(yesterday, "r2", "registry_blobs", "bytes", 20e9),
    storage(day, "r2", "registry_blobs", "bytes", 20e9),
  ]);
  // The site's own: every registry blob once (Orbit's and Bob's overlap).
  insert(sqlite, "", [
    storage(yesterday, "r2", "registry_blobs_all", "bytes", 30e9),
    storage(day, "r2", "registry_blobs_all", "bytes", 30e9),
    storage(day, "d1", "analysis-caches", "bytes", 2e9),
  ]);
  sqlite.exec(
    `INSERT INTO job_cursors (name, cursor, updated_at) VALUES ('usage:collect', '{"day":"${day}","account":"acc_org","step":3,"page":null,"done":false}', '${day}T03:00:00Z')`,
  );
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/usage", accountUsageApi);
  app.route("/api/admin/usage", siteUsageApi);
  const token = async (user: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, "read")).secret;
  const tokens = {
    ann: await token("acc_ann"),
    bob: await token("acc_bob"),
    cat: await token("acc_cat"),
    root: await token("acc_root"),
  };
  const call = async (token: string | null, path: string) => {
    const response = await app.request(
      path,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      env,
    );
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      text,
      json: (response.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : null) as never,
    };
  };
  return { sqlite, env, call, tokens };
}

describe("reports from the database", () => {
  test("an account's report uses its latest complete day", async () => {
    const t = await setup();
    const orbit = await accountUsageReport(t.env.DB, {
      id: "acc_org",
      slug: "orbit",
      display_name: "Orbit",
    });
    // Today's collection is still on Orbit: yesterday is its latest complete day.
    expect(orbit.asOf).toBe("2026-10-19");
    expect(orbit.notes.join(" ")).toContain("still running");
    expect(lineOf(orbit, "d1", "ci-logs").monthlyUsd).toBeCloseTo(1.875, 10);
    // Bob comes before Orbit's id: his today is complete.
    const bob = await accountUsageReport(t.env.DB, {
      id: "acc_bob",
      slug: "bob",
      display_name: "Bob",
    });
    expect(bob.asOf).toBe("2026-10-20");
    expect(bob.monthlyUsd).toBeCloseTo(0.3, 10);
  });

  test("the site sums accounts, counts shared blobs once and totals each account", async () => {
    const t = await setup();
    const site = await siteUsageReport(t.env.DB);
    // The site's collection hasn't finished today.
    expect(site.asOf).toBe("2026-10-19");
    const r2 = site.constructs.find((c) => c.construct === "r2")!;
    expect(r2.lines.map((l) => l.item)).toEqual(["registry_blobs_all"]);
    expect(r2.monthlyUsd).toBeCloseTo(30 * 0.015, 10);
    expect(site.accounts).toEqual([
      // One day of activity measured, extrapolated to 30.
      {
        slug: "orbit",
        displayName: "Orbit",
        monthlyUsd: expect.closeTo(1.875 + 0.75 + 0.2 + 0.3 + 0.1 + 2 + 0.8 + 0.12, 8),
      },
      { slug: "bob", displayName: "Bob", monthlyUsd: expect.closeTo(0.3, 10) },
    ]);
  });
});

describe("the API", () => {
  test("an account's administrators see its report; members are refused; others get 404", async () => {
    const t = await setup();
    const ok = await t.call(t.tokens.ann, "/api/accounts/orbit/usage");
    expect(ok.status).toBe(200);
    expect((ok.json as UsageReport).account).toEqual({ slug: "orbit", displayName: "Orbit" });
    expect((await t.call(t.tokens.root, "/api/accounts/orbit/usage")).status).toBe(200);
    expect((await t.call(t.tokens.bob, "/api/accounts/bob/usage")).status).toBe(200);
    expect((await t.call(t.tokens.cat, "/api/accounts/orbit/usage")).status).toBe(403);
    expect((await t.call(t.tokens.bob, "/api/accounts/orbit/usage")).status).toBe(404);
    expect((await t.call(t.tokens.ann, "/api/accounts/bob/usage")).status).toBe(404);
    expect((await t.call(t.tokens.ann, "/api/accounts/nobody/usage")).status).toBe(404);
    expect((await t.call(null, "/api/accounts/orbit/usage")).status).toBe(401);
  });

  test("only site administrators see the site's report", async () => {
    const t = await setup();
    const site = await t.call(t.tokens.root, "/api/admin/usage");
    expect(site.status).toBe(200);
    expect((site.json as UsageReport).scope).toBe("site");
    expect((await t.call(t.tokens.ann, "/api/admin/usage")).status).toBe(403);
    expect((await t.call(null, "/api/admin/usage")).status).toBe(401);
  });

  test("CSV export", async () => {
    const t = await setup();
    const csv = await t.call(t.tokens.ann, "/api/accounts/orbit/usage?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.type).toBe("text/csv; charset=utf-8");
    expect(csv.disposition).toBe('attachment; filename="orbit-usage-2026-10-19.csv"');
    expect(csv.text.split("\n")[0]).toMatch(/^construct,item,label,/);
    expect(csv.text).toContain("d1,ci-logs,CI logs,storage,bytes,2500000000,no,");
    expect((await t.call(t.tokens.cat, "/api/accounts/orbit/usage?format=csv")).status).toBe(403);
    const site = await t.call(t.tokens.root, "/api/admin/usage?format=csv");
    expect(site.text).toContain("r2,registry_blobs_all,");
  });
});
