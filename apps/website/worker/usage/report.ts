// Usage and cost reports: live Space administrators, personal self-service,
// or Instance operators. Attribution always includes kind and immutable ID.
//
// - Storage is as of the latest day whose collection finished for the scope
//   (or the Instance aggregate), priced as if it stayed that size for a month (GB-month).
// - Activity (Workers AI tokens) is summed over the 30 days up to then; with
//   fewer days measured it is extrapolated to 30 and labelled estimated.
// - Every cost is the figure × the catalog's list price in effect that day, in
//   the price's own units (a GB is 10^9 bytes). Allowances are account-wide
//   on the Cloudflare account, so nothing is subtracted: gross list price.
//   A price whose billing hasn't started yet (Artifacts until 2026-10-14, AI
//   Search until 2026-11-01) is shown with its start and kept out of totals.
// - Bounded: one scope's window is ≤ 30 days of its rows; Instance reports
//   read SQL aggregates and return at most MAX_SUBJECTS distinct subjects.

import {
  GB,
  metricLabel,
  PRICE_PRODUCTS,
  priceCost,
  USAGE_CONSTRUCTS,
  type CatalogPrice,
  type KnowledgeUpdateSpend,
  type PriceProduct,
  type UsageCategoryLink,
  type UsageConstruct,
  type UsageConstructReport,
  type UsageCost,
  type UsageFigure,
  type UsageLine,
  type UsageAttribution,
  type UsageReport,
  type UsageScope,
  type UsageSubject,
  type UsageTrendDay,
} from "../../shared/usage.ts";
import { category } from "../retention/categories.ts";
import { attributionReport } from "./attribution.ts";
import { db } from "../schema.ts";
import { PRICING_PAGES } from "./pages.ts";
import { catalogVersion, priceOn, priceTimeline } from "./prices.ts";
import { TABLE_GROUPS } from "./tables.ts";

export const WINDOW_DAYS = 30;
export const MAX_SUBJECTS = 200;

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
  organization_avatars: "Organization pictures",
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
  "durable_objects/StepFeed": ["step-feed"],
  "d1/step-context": ["step-steering", "step-artifacts"],
  "r2/registry_blobs": ["registry-proxy-cache"],
  "r2/registry_derived": ["registry-proxy-cache"],
  "r2/registry_blobs_all": ["registry-proxy-cache"],
  "artifacts/repositories": ["unreachable-git"],
};

export function lineCategories(
  construct: UsageConstruct,
  item: string,
  scope: UsageScope["kind"],
): UsageCategoryLink[] {
  const ids = CATEGORY_IDS[`${construct}/${item}`] ?? (construct === "d1" ? [item] : []);
  return ids.flatMap((id) => {
    const found = category(id);
    // Scoped pages must not link to another scope's policy.
    if (!found || (scope !== "instance" && found.scope !== scope)) return [];
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

/**
 * The figure as priced. A model's total_tokens counts every token, including
 * the input and output tokens priced on their own; only the rest (calls that
 * reported nothing but a total) is priced as total.
 */
function pricedFigure(
  construct: UsageConstruct,
  figure: UsageFigure,
  figures: readonly UsageFigure[],
): UsageFigure {
  if (construct !== "workers_ai" || figure.metric !== "total_tokens") return figure;
  const split = figures
    .filter((f) => f.metric === "input_tokens" || f.metric === "output_tokens")
    .reduce((sum, f) => sum + f.quantity, 0);
  return split > 0 ? { ...figure, quantity: Math.max(0, figure.quantity - split) } : figure;
}

function line(
  pricing: Pricing,
  scope: UsageScope["kind"],
  construct: UsageConstruct,
  item: string,
  kind: "storage" | "activity",
  figures: UsageFigure[],
): UsageLine {
  const priced = figures.map((f) => pricedFigure(construct, f, figures));
  // A figure adjusted down to nothing (tokens all already split) costs nothing.
  const costs = priced.flatMap((f, i) =>
    f !== figures[i] && f.quantity === 0 ? [] : (cost(pricing, construct, item, kind, f) ?? []),
  );
  const notes: string[] = [];
  for (const f of priced) {
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
  scope: UsageScope;
  done: boolean;
}

/** Null requests the complete Instance aggregate, not a single attribution. */
export function collected(cursor: CollectionCursor | null, day: string, scope: UsageScope | null) {
  if (!cursor || cursor.day > day) return true;
  if (cursor.day < day) return false;
  if (cursor.done) return true;
  // Collection order is Instance, people by ID, then Spaces by ID.
  return (
    scope !== null &&
    (scope.kind < cursor.scope.kind ||
      (scope.kind === cursor.scope.kind && scope.id < cursor.scope.id))
  );
}

// ---- the report -------------------------------------------------------------------

export interface ReportInput {
  scope: UsageScope["kind"];
  subject: UsageSubject | null;
  /** Every snapshot row in the window; Instance reports aggregate all scopes. */
  rows: readonly SnapshotRow[];
  /** The day storage figures describe. */
  asOf: string | null;
  timeline: readonly CatalogPrice[];
  version: number;
  subjects?: UsageReport["subjects"];
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
  scope: UsageScope["kind"],
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
    "Figures are attributed estimates from Timelines' own records, not Cloudflare's bill.",
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
      subject: input.subject,
      asOf: null,
      window: { ...windowOf(today), daysMeasured: 0 },
      collectedAt: null,
      monthlyUsd: 0,
      constructs: [],
      trend: [],
      catalog,
      subjects: input.subjects ?? null,
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
    const today = input.rows.filter((row) => row.day === day);
    const asFigure = (row: SnapshotRow): UsageFigure => ({
      metric: row.metric,
      quantity: row.quantity,
      estimated: row.estimated,
      method: row.method,
    });
    for (const row of today) {
      // Priced as the lines are: a model's total less what input and output priced.
      const siblings = today
        .filter((r) => r.construct === row.construct && r.item === row.item && r.kind === row.kind)
        .map(asFigure);
      const figure = pricedFigure(row.construct, asFigure(row), siblings);
      if (figure.quantity === 0 && row.quantity > 0) continue;
      const c = cost(dayPricing, row.construct, row.item, row.kind, figure);
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
    subject: input.subject,
    asOf: input.asOf,
    window: { from, to, daysMeasured: measured.size },
    collectedAt,
    monthlyUsd: constructs.reduce((sum, c) => sum + c.monthlyUsd, 0),
    constructs,
    trend,
    catalog,
    subjects: input.subjects ?? null,
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
    .where("name", "=", "usage:collect:v4")
    .executeTakeFirst();
  if (!row) return null;
  try {
    return JSON.parse(row.cursor) as CollectionCursor;
  } catch {
    return null;
  }
}

/** Latest storage day whose collection finished for this scope, else the latest. */
async function reportDay(
  d1: D1Database,
  scope: UsageScope | null,
): Promise<{ asOf: string | null; partial: boolean }> {
  let query = db(d1)
    .selectFrom("usage_snapshots")
    .select("day")
    .distinct()
    .where("kind", "=", "storage")
    .orderBy("day", "desc")
    .limit(2);
  if (scope !== null)
    query = query.where("scope_kind", "=", scope.kind).where("scope_id", "=", scope.id);
  const [days, cursor] = await Promise.all([query.execute(), loadCursor(d1)]);
  const complete = days.find((d) => collected(cursor, d.day, scope));
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

/**
 * Knowledge build costs over the last 30 days, for one Space or the
 * operator-only Instance aggregate (`null`). Never called for person usage.
 */
export async function knowledgeUpdateSpend(
  d1: D1Database,
  spaceId: string | null,
  now = new Date(),
): Promise<KnowledgeUpdateSpend> {
  const from = addDays(now.toISOString().slice(0, 10), -WINDOW_DAYS);
  const { results } = await d1
    .prepare(
      `SELECT o.slug || '/' || r.name AS name,
              coalesce(json_extract(b.stats, '$.mode'), '') AS mode,
              count(*) AS builds,
              count(json_extract(b.stats, '$.aiUsage.costUsd')) AS metered,
              coalesce(sum(json_extract(b.stats, '$.aiUsage.calls')), 0) AS calls,
              coalesce(sum(json_extract(b.stats, '$.aiUsage.costUsd')), 0) AS cost
         FROM kg_builds b
         JOIN repos r ON r.id = b.repo_id
         JOIN spaces o ON o.id = r.space_id
        WHERE b.started_at >= ?1 AND b.status <> 'running' AND (?2 IS NULL OR r.space_id = ?2)
        GROUP BY r.id, mode`,
    )
    .bind(from, spaceId)
    .all<{
      name: string;
      mode: string;
      builds: number;
      metered: number;
      calls: number;
      cost: number;
    }>();
  const spend = () => ({
    count: 0,
    calls: 0,
    costUsd: 0,
    eachUsd: null as number | null,
    metered: 0,
  });
  const updates = spend();
  const full = spend();
  let unmetered = 0;
  const repos = new Map<
    string,
    { name: string; updates: number; fullRebuilds: number; costUsd: number }
  >();
  for (const row of results) {
    const target = row.mode === "full" ? full : row.mode === "update" ? updates : null;
    unmetered += row.builds - row.metered;
    const repo = repos.get(row.name) ?? { name: row.name, updates: 0, fullRebuilds: 0, costUsd: 0 };
    repo.costUsd += row.cost;
    if (row.mode === "full") repo.fullRebuilds += row.builds;
    else repo.updates += row.builds;
    repos.set(row.name, repo);
    if (!target) continue;
    target.count += row.builds;
    target.metered += row.metered;
    target.calls += row.calls;
    target.costUsd += row.cost;
  }
  const done = ({ metered, ...s }: ReturnType<typeof spend>) => ({
    ...s,
    costUsd: Math.round(s.costUsd * 1e4) / 1e4,
    eachUsd: metered ? Math.round((s.costUsd / metered) * 1e4) / 1e4 : null,
  });
  return {
    from,
    updates: done(updates),
    fullRebuilds: done(full),
    unmetered,
    repos: [...repos.values()]
      .map((r) => ({ ...r, costUsd: Math.round(r.costUsd * 1e4) / 1e4 }))
      .toSorted((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name))
      .slice(0, 10),
  };
}

export function spaceUsageReport(d1: D1Database, space: UsageSubject): Promise<UsageReport> {
  return scopedUsageReport(d1, "space", space);
}

export function personUsageReport(d1: D1Database, person: UsageSubject): Promise<UsageReport> {
  return scopedUsageReport(d1, "person", person);
}

async function scopedUsageReport(
  d1: D1Database,
  kind: "space" | "person",
  subject: UsageSubject,
): Promise<UsageReport> {
  const [{ asOf, partial }, timeline, version] = await Promise.all([
    reportDay(d1, { kind, id: subject.id }),
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
          .where("scope_kind", "=", kind)
          .where("scope_id", "=", subject.id)
          .where("day", ">=", windowOf(asOf).from)
          .where("day", "<=", asOf)
          .limit(20_000)
          .execute()
      ).map(asRow)
    : [];
  const report = buildReport({
    scope: kind,
    subject: { id: subject.id, slug: subject.slug, displayName: subject.displayName },
    rows,
    asOf,
    timeline,
    version,
    partial,
  });
  return {
    ...report,
    knowledgeUpdates: kind === "space" ? await knowledgeUpdateSpend(d1, subject.id) : null,
    attribution: await attributionFor(d1, { kind, id: subject.id }, report, timeline),
  };
}

/** The report's window costs by person, agent and timeline (CORE-222), priced like it. */
async function attributionFor(
  d1: D1Database,
  scope: UsageScope | null,
  report: UsageReport,
  timeline: readonly CatalogPrice[],
): Promise<UsageAttribution | null> {
  if (!report.asOf) return null;
  // Attribution reads every job and call in the window: nothing to extrapolate.
  const p = pricing(timeline, report.asOf, WINDOW_DAYS);
  return attributionReport(d1, {
    // Null: the whole Instance.
    scope,
    from: report.window.from,
    to: report.window.to,
    asOf: report.asOf,
    storageUsd: report.constructs
      .flatMap((c) => c.lines)
      .filter((l) => l.kind === "storage")
      .reduce((sum, l) => sum + l.monthlyUsd, 0),
    price: (rows) => priceLines(rows, scope?.kind ?? "instance", p, report.window.from),
  });
}

/**
 * Instance aggregate: all attributed figures, shared registry blobs counted
 * once, and separate Space/person totals.
 */
export async function instanceUsageReport(d1: D1Database): Promise<UsageReport> {
  const [{ asOf, partial }, timeline, version] = await Promise.all([
    reportDay(d1, null),
    priceTimeline(d1),
    catalogVersion(d1),
  ]);
  if (!asOf)
    return buildReport({
      scope: "instance",
      subject: null,
      rows: [],
      asOf,
      timeline,
      version,
      subjects: [],
    });
  const { from } = windowOf(asOf);
  const summed = await d1
    .prepare(
      `SELECT day, construct, item, metric, kind, SUM(quantity) AS quantity, MAX(estimated) AS estimated,
              MIN(method) AS method, MAX(collected_at) AS collected_at
         FROM usage_snapshots
        WHERE day >= ?1 AND day <= ?2
          AND NOT (scope_kind <> 'instance' AND construct = 'r2' AND item = 'registry_blobs')
        GROUP BY day, construct, item, metric, kind
        LIMIT 20000`,
    )
    .bind(from, asOf)
    .all<Parameters<typeof asRow>[0]>();
  const rows = summed.results.map(asRow);
  const p = pricing(timeline, asOf, activityDays(rows, from, asOf).size);

  // Both identity columns participate in grouping, including legacy equal IDs.
  const metrics = PRICED_METRICS.map((_, i) => `?${i + 4}`).join(", ");
  const perSubject = await d1
    .prepare(
      `SELECT s.scope_kind, s.scope_id, n.slug, n.display_name,
              CASE s.kind WHEN 'storage' THEN ?2 ELSE ?3 END AS day,
              s.construct, s.item, s.metric, s.kind, SUM(s.quantity) AS quantity,
              MAX(s.estimated) AS estimated, '' AS method, MAX(s.collected_at) AS collected_at
         FROM usage_snapshots s
         JOIN (SELECT scope_kind, scope_id, MAX(day) AS latest FROM usage_snapshots
                WHERE kind = 'storage' AND day >= ?1 AND day <= ?2 AND scope_kind <> 'instance'
                GROUP BY scope_kind, scope_id) l
           ON l.scope_kind = s.scope_kind AND l.scope_id = s.scope_id
         JOIN (SELECT 'space' AS scope_kind, id, slug, display_name FROM spaces
               UNION ALL SELECT 'person', id, slug, display_name FROM accounts) n
           ON n.scope_kind = s.scope_kind AND n.id = s.scope_id
        WHERE ((s.kind = 'storage' AND s.day = l.latest) OR (s.kind = 'activity' AND s.day >= ?1 AND s.day <= ?2))
          AND s.metric IN (${metrics})
        GROUP BY s.scope_kind, s.scope_id, s.construct, s.item, s.metric, s.kind
        LIMIT 20000`,
    )
    .bind(from, asOf, windowOf(asOf).to, ...PRICED_METRICS)
    .all<
      Parameters<typeof asRow>[0] & {
        scope_kind: "space" | "person";
        scope_id: string;
        slug: string;
        display_name: string;
      }
    >();
  const groups = new Map<
    string,
    {
      subject: UsageSubject & { scope: "space" | "person" };
      rows: SnapshotRow[];
    }
  >();
  for (const r of perSubject.results) {
    const key = `${r.scope_kind}:${r.scope_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        subject: { scope: r.scope_kind, id: r.scope_id, slug: r.slug, displayName: r.display_name },
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(asRow(r));
  }
  const subjects = [...groups.values()]
    .map(({ subject, rows }) => ({
      ...subject,
      monthlyUsd: priceLines(rows, subject.scope, p, from).reduce(
        (sum, line) => sum + line.monthlyUsd,
        0,
      ),
    }))
    .toSorted(
      (a, b) =>
        b.monthlyUsd - a.monthlyUsd ||
        a.scope.localeCompare(b.scope) ||
        a.slug.localeCompare(b.slug),
    )
    .slice(0, MAX_SUBJECTS);
  const report = buildReport({
    scope: "instance",
    subject: null,
    rows,
    asOf,
    timeline,
    version,
    subjects,
    partial,
  });
  return {
    ...report,
    knowledgeUpdates: await knowledgeUpdateSpend(d1, null),
    attribution: await attributionFor(d1, null, report, timeline),
  };
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
