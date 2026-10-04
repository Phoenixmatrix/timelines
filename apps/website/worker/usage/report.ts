// The usage and cost report (CORE-209): CORE-207's daily usage snapshots priced
// with CORE-208's catalog, for one account (its administrators) or the whole
// site (site administrators).
//
// - Storage is as of the latest day whose collection finished for the account
//   (or the site), priced as if it stayed that size for a month (GB-month).
// - Activity (Workers AI tokens) is summed over the 30 days up to then; with
//   fewer days measured it is extrapolated to 30 and labelled estimated.
// - Every cost is the figure × the catalog's list price in effect that day, in
//   the price's own units (a GB is 10^9 bytes). Allowances are account-wide
//   on the Cloudflare account, so nothing is subtracted: gross list price.
//   A price whose billing hasn't started yet (Artifacts until 2026-10-14, AI
//   Search until 2026-11-01) is shown with its start and kept out of totals.
// - Bounded: one account's window is ≤ 30 days of its rows; the site report
//   reads SQL aggregates, and at most MAX_ACCOUNTS accounts' totals.

import {
  GB,
  metricLabel,
  PRICE_PRODUCTS,
  priceCost,
  USAGE_CONSTRUCTS,
  type CatalogPrice,
  type PriceProduct,
  type UsageCategoryLink,
  type UsageConstruct,
  type UsageConstructReport,
  type UsageCost,
  type UsageFigure,
  type UsageLine,
  type UsageReport,
  type UsageTrendDay,
} from "../../shared/usage.ts";
import { category } from "../retention/categories.ts";
import { db } from "../schema.ts";
import { PRICING_PAGES } from "./pages.ts";
import { catalogVersion, priceOn, priceTimeline } from "./prices.ts";
import { TABLE_GROUPS } from "./tables.ts";

export const WINDOW_DAYS = 30;
export const MAX_ACCOUNTS = 200;
/** Where the site's own figures (data no account owns) are filed. */
const SITE = "";

export interface SnapshotRow {
  day: string;
  construct: UsageConstruct;
  item: string;
  metric: string;
  kind: "storage" | "activity";
  quantity: number;
  estimated: boolean;
  method: string;
  collected_at?: string;
}

// ---- pricing rules ----------------------------------------------------------------

interface Rule {
  product: PriceProduct;
  /** The catalog metric; for Workers AI, built from the model. */
  metric: (item: string) => string;
  /** Figure quantity → the price's unit. */
  convert: (quantity: number) => number;
  /** Why this pricing is itself an approximation, if it is. */
  approximation?: string;
}

const bytesToGb = (bytes: number) => bytes / GB;
const same = (quantity: number) => quantity;
const fixed = (metric: string) => () => metric;

/** construct → figure metric → how it's priced. Figures without a rule are shown unpriced. */
const RULES: Partial<Record<UsageConstruct, Record<string, Rule>>> = {
  d1: { bytes: { product: "d1", metric: fixed("storage"), convert: bytesToGb } },
  durable_objects: {
    bytes: { product: "durable_objects", metric: fixed("sqlite_storage"), convert: bytesToGb },
  },
  r2: { bytes: { product: "r2", metric: fixed("standard_storage"), convert: bytesToGb } },
  artifacts: { bytes: { product: "artifacts", metric: fixed("storage"), convert: bytesToGb } },
  vectorize: {
    dimensions: { product: "vectorize", metric: fixed("stored_dimensions"), convert: same },
  },
  ai_search: { bytes: { product: "ai_search", metric: fixed("storage"), convert: bytesToGb } },
  workers_ai: {
    input_tokens: { product: "workers_ai", metric: (model) => `${model}:input`, convert: same },
    output_tokens: { product: "workers_ai", metric: (model) => `${model}:output`, convert: same },
    total_tokens: {
      product: "workers_ai",
      metric: (model) => `${model}:input`,
      convert: same,
      approximation: "only a total was reported; priced as input tokens",
    },
  },
  // CI sandboxes: each job's wall time × its instance type's size (collect.ts).
  ci: {
    vcpu_seconds: {
      product: "containers",
      metric: fixed("vcpu"),
      convert: same,
      approximation:
        "the instance's vCPUs for the job's whole run; Cloudflare bills only active CPU, so this is an upper bound",
    },
    memory_gib_seconds: { product: "containers", metric: fixed("memory"), convert: same },
    disk_gb_seconds: { product: "containers", metric: fixed("disk"), convert: same },
  },
};

/** Figures whose quantities feed a cost (the site's per-account totals read only these). */
export const PRICED_METRICS = [
  ...new Set(Object.values(RULES).flatMap((rules) => Object.keys(rules ?? {}))),
];

// ---- labels and retention categories ------------------------------------------------

const R2_ITEMS: Record<string, string> = {
  registry_blobs: "Registry blobs",
  registry_derived: "Registry index files",
  registry_blobs_all: "Registry blobs (every blob once)",
  avatars: "Profile pictures",
};
const OTHER_ITEMS: Record<string, string> = {
  "artifacts/repositories": "Git repositories",
  "vectorize/knowledge": "Knowledge graph vectors",
  "ai_search/knowledge": "Knowledge search index",
  "ci/sandbox": "Sandbox jobs",
};

export function itemLabel(construct: UsageConstruct, item: string): string {
  if (construct === "d1") return TABLE_GROUPS.find((g) => g.id === item)?.label ?? item;
  if (construct === "r2") return R2_ITEMS[item] ?? item;
  if (construct === "workers_ai") return item.replace(/^@cf\/[^/]+\//, "");
  return OTHER_ITEMS[`${construct}/${item}`] ?? item;
}

/** Retention categories that clean up what a line counts. */
const CATEGORY_IDS: Record<string, string[]> = {
  "d1/atlas": ["atlas-snapshots"],
  "durable_objects/Tracker": ["closed-issues", "tracker-activity"],
  "durable_objects/Assistant": ["assistant-chats"],
  "r2/registry_blobs": ["registry-proxy-cache"],
  "r2/registry_derived": ["registry-proxy-cache"],
  "r2/registry_blobs_all": ["registry-proxy-cache"],
  "artifacts/repositories": ["unreachable-git"],
};

export function lineCategories(
  construct: UsageConstruct,
  item: string,
  scope: "account" | "site",
): UsageCategoryLink[] {
  const ids = CATEGORY_IDS[`${construct}/${item}`] ?? (construct === "d1" ? [item] : []);
  return ids.flatMap((id) => {
    const found = category(id);
    // An account's administrators manage only account categories.
    if (!found || (scope === "account" && found.scope !== "account")) return [];
    return [
      { id: found.id, label: found.label, description: found.description, scope: found.scope },
    ];
  });
}

// ---- costs --------------------------------------------------------------------------

interface Pricing {
  timeline: readonly CatalogPrice[];
  asOf: string;
  /** Activity over the window × this = a month's activity. */
  activityScale: number;
  activityEstimated: string | null;
}

function cost(
  pricing: Pricing,
  construct: UsageConstruct,
  item: string,
  kind: "storage" | "activity",
  figure: UsageFigure,
): UsageCost | null {
  const rule = RULES[construct]?.[figure.metric];
  if (!rule) return null;
  const metric = rule.metric(item);
  const versions = pricing.timeline.filter(
    (p) => p.product === rule.product && p.metric === metric,
  );
  const inEffect = priceOn(versions, rule.product, metric, pricing.asOf);
  const upcoming = inEffect
    ? null
    : (versions
        .filter((p) => p.effectiveFrom > pricing.asOf)
        .toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ?? null);
  const price = inEffect ?? upcoming;
  if (!price) return null;
  const quantity =
    rule.convert(figure.quantity) * (kind === "activity" ? pricing.activityScale : 1);
  return {
    product: rule.product,
    metric,
    label: `${PRICE_PRODUCTS[rule.product]} ${metricLabel(rule.product, metric).toLowerCase()}`,
    figure: figure.metric,
    quantity,
    unit: price.unit,
    unitPriceUsd: price.unitPriceUsd,
    unitQuantity: price.unitQuantity,
    includedQuantity: price.includedQuantity,
    includedPeriod: price.includedPeriod,
    effectiveFrom: price.effectiveFrom,
    sourceUrl: price.sourceUrl,
    monthlyUsd: priceCost(price, quantity),
    startsOn: inEffect ? null : price.effectiveFrom,
    estimated:
      figure.estimated ||
      Boolean(rule.approximation) ||
      (kind === "activity" && pricing.activityEstimated !== null),
  };
}

function line(
  pricing: Pricing,
  scope: "account" | "site",
  construct: UsageConstruct,
  item: string,
  kind: "storage" | "activity",
  figures: UsageFigure[],
): UsageLine {
  const costs = figures.flatMap((f) => cost(pricing, construct, item, kind, f) ?? []);
  const notes: string[] = [];
  for (const f of figures) {
    const rule = RULES[construct]?.[f.metric];
    if (rule?.approximation && costs.some((c) => c.figure === f.metric))
      notes.push(`${f.metric.replace(/_/g, " ")}: ${rule.approximation}.`);
    if (rule && !costs.some((c) => c.figure === f.metric) && f.quantity > 0)
      notes.push(`No catalog price for ${rule.metric(item)}.`);
  }
  if (kind === "activity" && pricing.activityEstimated) notes.push(pricing.activityEstimated);
  for (const c of costs)
    if (c.startsOn) notes.push(`Billed from ${c.startsOn}; not in the total until then.`);
  return {
    construct,
    item,
    label: itemLabel(construct, item),
    kind,
    figures,
    costs,
    monthlyUsd: costs.reduce((sum, c) => sum + (c.startsOn ? 0 : c.monthlyUsd), 0),
    estimated: figures.some((f) => f.estimated) || costs.some((c) => c.estimated),
    categories: lineCategories(construct, item, scope),
    note: notes.length ? [...new Set(notes)].join(" ") : null,
  };
}

// ---- days -------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The collection's progress (CORE-207's cursor): which days are complete for whom. */
export interface CollectionCursor {
  day: string;
  account: string;
  done: boolean;
}

/** Whether `day`'s collection has finished for an account (or, with null, the whole site). */
export function collected(cursor: CollectionCursor | null, day: string, account: string | null) {
  if (!cursor || cursor.day > day) return true;
  if (cursor.day < day) return false;
  if (cursor.done) return true;
  // Accounts are collected in id order after the site ('').
  return account !== null && account !== cursor.account && account < cursor.account;
}

// ---- the report -------------------------------------------------------------------

export interface ReportInput {
  scope: "account" | "site";
  account: { slug: string; displayName: string } | null;
  /** Every snapshot row in the window (for the site, summed over accounts). */
  rows: readonly SnapshotRow[];
  /** The day storage figures describe. */
  asOf: string | null;
  timeline: readonly CatalogPrice[];
  version: number;
  accounts?: UsageReport["accounts"];
  partial?: boolean;
}

const ORDER = Object.keys(USAGE_CONSTRUCTS) as UsageConstruct[];

/**
 * The activity window: the 30 days before `asOf` (a day's activity is
 * collected the day after, so `asOf` itself has none yet).
 */
export function windowOf(asOf: string) {
  return { from: addDays(asOf, -WINDOW_DAYS), to: addDays(asOf, -1) };
}

/** Days whose activity was collected: each collection day's activity describes the day before. */
function activityDays(rows: readonly SnapshotRow[], from: string, to: string): Set<string> {
  const days = new Set<string>();
  for (const row of rows)
    if (row.kind === "storage") {
      const day = addDays(row.day, -1);
      if (day >= from && day <= to) days.add(day);
    }
  return days;
}

export function pricing(
  timeline: readonly CatalogPrice[],
  asOf: string,
  daysMeasured: number,
): Pricing {
  const scale = daysMeasured > 0 ? WINDOW_DAYS / daysMeasured : 0;
  return {
    timeline,
    asOf,
    activityScale: scale,
    activityEstimated:
      daysMeasured > 0 && daysMeasured < WINDOW_DAYS
        ? `Activity extrapolated to ${WINDOW_DAYS} days from ${daysMeasured} measured.`
        : null,
  };
}

/** Group a window's rows into priced lines: storage as of `asOf`, activity summed. */
export function priceLines(
  rows: readonly SnapshotRow[],
  scope: "account" | "site",
  p: Pricing,
  from: string,
): UsageLine[] {
  const groups = new Map<
    string,
    {
      construct: UsageConstruct;
      item: string;
      kind: "storage" | "activity";
      figures: Map<string, UsageFigure>;
    }
  >();
  for (const row of rows) {
    if (row.kind === "storage" ? row.day !== p.asOf : row.day < from || row.day >= p.asOf) continue;
    const key = `${row.construct}\u0000${row.item}\u0000${row.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { construct: row.construct, item: row.item, kind: row.kind, figures: new Map() };
      groups.set(key, group);
    }
    const figure = group.figures.get(row.metric);
    if (figure) {
      figure.quantity += row.quantity;
      figure.estimated ||= row.estimated;
    } else
      group.figures.set(row.metric, {
        metric: row.metric,
        quantity: row.quantity,
        estimated: row.estimated,
        method: row.method,
      });
  }
  return [...groups.values()].map((g) =>
    line(p, scope, g.construct, g.item, g.kind, [...g.figures.values()]),
  );
}

export function buildReport(input: ReportInput): UsageReport {
  const notes = [
    "Figures are attributed estimates from Gitmatrix's own records, not Cloudflare's bill.",
    "Costs are gross list prices: included allowances apply once to the whole Cloudflare account, so they aren't subtracted here.",
  ];
  const sources = PRICING_PAGES.map((page) => {
    const version = input.timeline.find((p) => p.product === page.product);
    return {
      product: page.product,
      label: page.label,
      url: page.url,
      sourceUpdated: version?.sourceUpdated ?? null,
    };
  });
  const catalog = { version: input.version, sources };
  if (!input.asOf) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      scope: input.scope,
      account: input.account,
      asOf: null,
      window: { ...windowOf(today), daysMeasured: 0 },
      collectedAt: null,
      monthlyUsd: 0,
      constructs: [],
      trend: [],
      catalog,
      accounts: input.accounts ?? null,
      notes: [...notes, "Usage hasn't been collected yet; the hourly collection fills this in."],
    };
  }
  const { from, to } = windowOf(input.asOf);
  const measured = activityDays(input.rows, from, to);
  const p = pricing(input.timeline, input.asOf, measured.size);
  const lines = priceLines(input.rows, input.scope, p, from);
  const constructs: UsageConstructReport[] = ORDER.flatMap((construct) => {
    const own = lines
      .filter((l) => l.construct === construct)
      .toSorted((a, b) => b.monthlyUsd - a.monthlyUsd || a.label.localeCompare(b.label));
    if (!own.length) return [];
    return [
      {
        construct,
        label: USAGE_CONSTRUCTS[construct],
        monthlyUsd: own.reduce((sum, l) => sum + l.monthlyUsd, 0),
        estimated: own.some((l) => l.estimated),
        lines: own,
      },
    ];
  });

  // The trend: each day's storage at a thirtieth of its monthly price, plus its activity.
  const storageDays = new Set(input.rows.filter((r) => r.kind === "storage").map((r) => r.day));
  const trend: UsageTrendDay[] = [];
  for (let day = addDays(input.asOf, 1 - WINDOW_DAYS); day <= input.asOf; day = addDays(day, 1)) {
    const dayPricing: Pricing = { ...p, asOf: day, activityScale: 1, activityEstimated: null };
    const byConstruct: Partial<Record<UsageConstruct, number>> = {};
    for (const row of input.rows) {
      if (row.day !== day) continue;
      const c = cost(dayPricing, row.construct, row.item, row.kind, {
        metric: row.metric,
        quantity: row.quantity,
        estimated: row.estimated,
        method: row.method,
      });
      if (!c || c.startsOn) continue;
      const usd = row.kind === "storage" ? c.monthlyUsd / WINDOW_DAYS : c.monthlyUsd;
      byConstruct[row.construct] = (byConstruct[row.construct] ?? 0) + usd;
    }
    trend.push({
      day,
      costUsd: Object.values(byConstruct).reduce((sum, usd) => sum + usd, 0),
      byConstruct,
      measured: storageDays.has(day),
    });
  }

  const collectedAt = input.rows.reduce<string | null>(
    (latest, r) =>
      r.collected_at && (!latest || r.collected_at > latest) ? r.collected_at : latest,
    null,
  );
  return {
    scope: input.scope,
    account: input.account,
    asOf: input.asOf,
    window: { from, to, daysMeasured: measured.size },
    collectedAt,
    monthlyUsd: constructs.reduce((sum, c) => sum + c.monthlyUsd, 0),
    constructs,
    trend,
    catalog,
    accounts: input.accounts ?? null,
    notes: input.partial
      ? [...notes, "Today's collection is still running; these are the latest complete figures."]
      : notes,
  };
}

// ---- loading --------------------------------------------------------------------

async function loadCursor(d1: D1Database): Promise<CollectionCursor | null> {
  const row = await db(d1)
    .selectFrom("job_cursors")
    .select("cursor")
    .where("name", "=", "usage:collect")
    .executeTakeFirst();
  if (!row) return null;
  try {
    return JSON.parse(row.cursor) as CollectionCursor;
  } catch {
    return null;
  }
}

/** The latest storage day whose collection finished for the account (or site), else the latest. */
async function reportDay(
  d1: D1Database,
  accountId: string | null,
): Promise<{ asOf: string | null; partial: boolean }> {
  let query = db(d1)
    .selectFrom("usage_snapshots")
    .select("day")
    .distinct()
    .where("kind", "=", "storage")
    .orderBy("day", "desc")
    .limit(2);
  if (accountId !== null) query = query.where("account_id", "=", accountId);
  const [days, cursor] = await Promise.all([query.execute(), loadCursor(d1)]);
  const complete = days.find((d) => collected(cursor, d.day, accountId));
  return {
    asOf: complete?.day ?? days[0]?.day ?? null,
    partial: Boolean(days[0] && complete?.day !== days[0].day),
  };
}

function asRow(r: {
  day: string;
  construct: string;
  item: string;
  metric: string;
  kind: string;
  quantity: number;
  estimated: number;
  method: string;
  collected_at: string;
}): SnapshotRow {
  return {
    day: r.day,
    construct: r.construct as UsageConstruct,
    item: r.item,
    metric: r.metric,
    kind: r.kind as "storage" | "activity",
    quantity: Number(r.quantity),
    estimated: Number(r.estimated) === 1,
    method: r.method,
    collected_at: r.collected_at,
  };
}

/** One account's report. */
export async function accountUsageReport(
  d1: D1Database,
  account: { id: string; slug: string; display_name: string },
): Promise<UsageReport> {
  const [{ asOf, partial }, timeline, version] = await Promise.all([
    reportDay(d1, account.id),
    priceTimeline(d1),
    catalogVersion(d1),
  ]);
  const rows = asOf
    ? (
        await db(d1)
          .selectFrom("usage_snapshots")
          .select([
            "day",
            "construct",
            "item",
            "metric",
            "kind",
            "quantity",
            "estimated",
            "method",
            "collected_at",
          ])
          .where("account_id", "=", account.id)
          .where("day", ">=", windowOf(asOf).from)
          .where("day", "<=", asOf)
          .limit(20_000)
          .execute()
      ).map(asRow)
    : [];
  return buildReport({
    scope: "account",
    account: { slug: account.slug, displayName: account.display_name },
    rows,
    asOf,
    timeline,
    version,
    partial,
  });
}

/**
 * The site's report: every account's figures summed (an account's registry
 * blobs overlap with other accounts', so the site counts the registry's own
 * once-per-blob figure instead), the site's own data, and each account's total.
 */
export async function siteUsageReport(d1: D1Database): Promise<UsageReport> {
  const [{ asOf, partial }, timeline, version] = await Promise.all([
    reportDay(d1, null),
    priceTimeline(d1),
    catalogVersion(d1),
  ]);
  if (!asOf)
    return buildReport({
      scope: "site",
      account: null,
      rows: [],
      asOf,
      timeline,
      version,
      accounts: [],
    });
  const { from } = windowOf(asOf);
  const summed = await d1
    .prepare(
      `SELECT day, construct, item, metric, kind, SUM(quantity) AS quantity, MAX(estimated) AS estimated,
              MIN(method) AS method, MAX(collected_at) AS collected_at
         FROM usage_snapshots
        WHERE day >= ?1 AND day <= ?2
          AND NOT (account_id <> ?3 AND construct = 'r2' AND item = 'registry_blobs')
        GROUP BY day, construct, item, metric, kind
        LIMIT 20000`,
    )
    .bind(from, asOf, SITE)
    .all<Parameters<typeof asRow>[0]>();
  const rows = summed.results.map(asRow);
  const p = pricing(timeline, asOf, activityDays(rows, from, asOf).size);

  // Each account's total: its latest storage and the window's activity, priced figures only.
  const metrics = PRICED_METRICS.map((_, i) => `?${i + 5}`).join(", ");
  const perAccount = await d1
    .prepare(
      `SELECT s.account_id AS account_id,
              CASE s.kind WHEN 'storage' THEN ?2 ELSE ?4 END AS day,
              s.construct AS construct, s.item AS item,
              s.metric AS metric, s.kind AS kind, SUM(s.quantity) AS quantity,
              MAX(s.estimated) AS estimated, '' AS method, MAX(s.collected_at) AS collected_at
         FROM usage_snapshots s
         JOIN (SELECT account_id, MAX(day) AS latest FROM usage_snapshots
                WHERE kind = 'storage' AND day >= ?1 AND day <= ?2 AND account_id <> ?3
                GROUP BY account_id) l ON l.account_id = s.account_id
        WHERE ((s.kind = 'storage' AND s.day = l.latest) OR (s.kind = 'activity' AND s.day >= ?1 AND s.day <= ?2))
          AND s.metric IN (${metrics})
        GROUP BY s.account_id, s.construct, s.item, s.metric, s.kind
        LIMIT 20000`,
    )
    .bind(from, asOf, SITE, windowOf(asOf).to, ...PRICED_METRICS)
    .all<Parameters<typeof asRow>[0] & { account_id: string }>();
  const totals = new Map<string, number>();
  const byAccount = new Map<string, SnapshotRow[]>();
  for (const r of perAccount.results) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(asRow(r));
    byAccount.set(r.account_id, list);
  }
  for (const [id, list] of byAccount) {
    const lines = priceLines(list, "site", p, from);
    totals.set(
      id,
      lines.reduce((sum, l) => sum + l.monthlyUsd, 0),
    );
  }
  const ids = [...totals.keys()];
  const names = ids.length
    ? await db(d1)
        .selectFrom("accounts")
        .select(["id", "slug", "display_name"])
        .where("id", "in", ids.slice(0, 1000))
        .execute()
    : [];
  const accounts = names
    .map((a) => ({ slug: a.slug, displayName: a.display_name, monthlyUsd: totals.get(a.id) ?? 0 }))
    .toSorted((a, b) => b.monthlyUsd - a.monthlyUsd || a.slug.localeCompare(b.slug))
    .slice(0, MAX_ACCOUNTS);
  return buildReport({
    scope: "site",
    account: null,
    rows,
    asOf,
    timeline,
    version,
    accounts,
    partial,
  });
}

// ---- CSV ----------------------------------------------------------------------------

const csvCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The report's lines, one row per figure, with its price and monthly cost. */
export function reportCsv(report: UsageReport): string {
  const header = [
    "construct",
    "item",
    "label",
    "kind",
    "metric",
    "quantity",
    "estimated",
    "method",
    "price",
    "billable_quantity",
    "unit",
    "unit_price_usd",
    "per_units",
    "monthly_usd",
    "billed_from",
    "price_source",
    "retention_categories",
  ];
  const rows = [header.join(",")];
  for (const construct of report.constructs)
    for (const l of construct.lines)
      for (const f of l.figures) {
        const c = l.costs.find((x) => x.figure === f.metric);
        rows.push(
          [
            l.construct,
            l.item,
            l.label,
            l.kind,
            f.metric,
            f.quantity,
            f.estimated || c?.estimated ? "yes" : "no",
            f.method,
            c ? `${c.product}/${c.metric}` : "",
            c?.quantity ?? "",
            c?.unit ?? "",
            c?.unitPriceUsd ?? "",
            c?.unitQuantity ?? "",
            c ? c.monthlyUsd.toFixed(6) : "",
            c?.effectiveFrom ?? "",
            c?.sourceUrl ?? "",
            l.categories.map((x) => x.id).join(" "),
          ]
            .map(csvCell)
            .join(","),
        );
      }
  return `${rows.join("\n")}\n`;
}
