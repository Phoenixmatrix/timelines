// The Cloudflare price catalog (CORE-208): what each metric costs, versioned,
// with its source page and the date it applies from.
//
//   refresh   fetch every product's pricing page (`<page>/index.md`), parse it
//             deterministically (pages.ts), validate it against the catalog
//             (units unchanged, no price or allowance moving more than tenfold,
//             no tracked metric missing) and record the diff as a pending
//             change. A page that fails any check contributes nothing and
//             says why. Nothing changes until a site administrator applies it.
//   apply     a pending change, against the catalog version it was computed
//             from (a newer catalog means refresh again), adds one version per
//             entry in one D1 batch.
//   edit      a site administrator's manual price, recorded the same way, with
//             a required note.
//   check     the hourly cron runs a refresh once per UTC day (kind `check`),
//             so a page that stops parsing, or a price that changes, shows up
//             for review without anyone asking.
//
// Every refresh, check, edit and decision is a row in cloudflare_price_changes;
// versions are never edited, only superseded (same metric and effective date)
// or followed by a later effective date, so old prices stay with their dates.

import type { Selectable } from "kysely";
import {
  metricLabel,
  type CatalogPrice,
  type PriceCatalog,
  type PriceChangeKind,
  type PriceChangeSummary,
  type PriceDiffEntry,
  type PriceEdit,
  type PricePageResult,
  type PriceProduct,
  type PublishedPrice,
} from "../../shared/usage.ts";
import { batch, db, type Database } from "../schema.ts";
import { parsePricingPage, PRICING_PAGES, PriceParseError, type PricingPage } from "./pages.ts";

/** Prices may not move more than this factor in one refresh. */
export const PLAUSIBLE_FACTOR = 10;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 2_000_000;

type PriceRow = Selectable<Database["cloudflare_prices"]>;
type ChangeRow = Selectable<Database["cloudflare_price_changes"]>;

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);
const key = (p: { product: string; metric: string }) => `${p.product}\u0000${p.metric}`;
/** USD per single unit: what a price change is compared by. */
const perUnit = (p: { unitPriceUsd: number; unitQuantity: number }) =>
  p.unitPriceUsd / p.unitQuantity;
const same = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));

/** Only a price's published fields. */
export function publishedOf(p: PublishedPrice): PublishedPrice {
  return {
    product: p.product,
    metric: p.metric,
    unit: p.unit,
    unitQuantity: p.unitQuantity,
    unitPriceUsd: p.unitPriceUsd,
    includedQuantity: p.includedQuantity,
    includedPeriod: p.includedPeriod,
    effectiveFrom: p.effectiveFrom,
    sourceUrl: p.sourceUrl,
    sourceUpdated: p.sourceUpdated,
  };
}

function published(row: PriceRow): PublishedPrice {
  return {
    product: row.product as PriceProduct,
    metric: row.metric,
    unit: row.unit as PublishedPrice["unit"],
    unitQuantity: row.unit_quantity,
    unitPriceUsd: row.unit_price_usd,
    includedQuantity: row.included_quantity,
    includedPeriod: row.included_period,
    effectiveFrom: row.effective_from,
    sourceUrl: row.source_url,
    sourceUpdated: row.source_updated,
  };
}

function catalogPrice(row: PriceRow & { recorded_by_slug: string | null }): CatalogPrice {
  return {
    ...published(row),
    id: row.id,
    label: metricLabel(row.product as PriceProduct, row.metric),
    provenance: row.provenance,
    changeId: row.change_id,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by_slug,
    fetchedAt: row.fetched_at,
    note: row.note,
    supersededAt: row.superseded_at,
  };
}

/** The catalog's version: the last applied change. */
export async function catalogVersion(d1: D1Database): Promise<number> {
  const row = await db(d1)
    .selectFrom("cloudflare_price_changes")
    .select((eb) => eb.fn.max("id").as("version"))
    .where("status", "=", "applied")
    .executeTakeFirst();
  return Number(row?.version ?? 0);
}

const priceRows = (d1: D1Database) =>
  db(d1)
    .selectFrom("cloudflare_prices as p")
    .leftJoin("accounts as a", "a.id", "p.recorded_by")
    .selectAll("p")
    .select("a.slug as recorded_by_slug");

/** Every unsuperseded version, ordered by metric then effective date: the price timeline. */
export async function priceTimeline(d1: D1Database): Promise<CatalogPrice[]> {
  const rows = await priceRows(d1)
    .where("p.superseded_at", "is", null)
    .orderBy("p.product")
    .orderBy("p.metric")
    .orderBy("p.effective_from")
    .execute();
  return rows.map(catalogPrice);
}

/** The version in effect on `day` (YYYY-MM-DD) for a metric, from a timeline; null before billing starts. */
export function priceOn<T extends PublishedPrice>(
  timeline: readonly T[],
  product: PriceProduct,
  metric: string,
  day: string,
): T | null {
  let found: T | null = null;
  for (const price of timeline)
    if (price.product === product && price.metric === metric && price.effectiveFrom <= day)
      if (!found || price.effectiveFrom > found.effectiveFrom) found = price;
  return found;
}

/**
 * For each metric, the version in effect on `asOf` and any later scheduled one
 * (or, before billing starts, only the scheduled one).
 */
function current(timeline: readonly CatalogPrice[], asOf: string): CatalogPrice[] {
  return timeline.filter((price) => {
    const inEffect = priceOn(timeline, price.product, price.metric, asOf);
    return price.effectiveFrom > asOf || inEffect?.id === price.id;
  });
}

export async function loadCatalog(d1: D1Database, now = new Date()): Promise<PriceCatalog> {
  const asOf = utcDay(now);
  const [timeline, version, pending] = await Promise.all([
    priceTimeline(d1),
    catalogVersion(d1),
    changes(d1)
      .where("c.status", "=", "pending")
      .where("c.kind", "in", ["refresh", "check"])
      .orderBy("c.id", "desc")
      .limit(1)
      .executeTakeFirst(),
  ]);
  return {
    version,
    asOf,
    prices: current(timeline, asOf),
    pending: pending ? summary(pending) : null,
  };
}

/** Every version of one metric, newest first, superseded ones included. */
export async function priceHistory(
  d1: D1Database,
  product: string,
  metric: string,
): Promise<CatalogPrice[]> {
  const rows = await priceRows(d1)
    .where("p.product", "=", product)
    .where("p.metric", "=", metric)
    .orderBy("p.id", "desc")
    .limit(100)
    .execute();
  return rows.map(catalogPrice);
}

// ---- changes ------------------------------------------------------------------

const changes = (d1: D1Database) =>
  db(d1)
    .selectFrom("cloudflare_price_changes as c")
    .leftJoin("accounts as by", "by.id", "c.created_by")
    .leftJoin("accounts as decider", "decider.id", "c.decided_by")
    .selectAll("c")
    .select(["by.slug as created_by_slug", "decider.slug as decided_by_slug"]);

function summary(
  row: ChangeRow & { created_by_slug: string | null; decided_by_slug: string | null },
): PriceChangeSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by_slug,
    baseVersion: row.base_version,
    pages: JSON.parse(row.pages) as PricePageResult[],
    diff: JSON.parse(row.diff) as PriceDiffEntry[],
    note: row.note,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by_slug,
  };
}

export async function listChanges(d1: D1Database, limit = 50): Promise<PriceChangeSummary[]> {
  const rows = await changes(d1)
    .orderBy("c.id", "desc")
    .limit(Math.min(Math.max(limit, 1), 100))
    .execute();
  return rows.map(summary);
}

export async function getChange(d1: D1Database, id: number): Promise<PriceChangeSummary | null> {
  const row = await changes(d1).where("c.id", "=", id).executeTakeFirst();
  return row ? summary(row) : null;
}

// ---- refresh --------------------------------------------------------------------

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchPage(page: PricingPage, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(`${page.url}index.md`, {
    headers: { accept: "text/markdown, text/plain" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new PriceParseError(`${page.label}: the page answered HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_PAGE_BYTES)
    throw new PriceParseError(`${page.label}: the page is too large`);
  return text;
}

/**
 * Compare one page's parsed prices with the catalog. Returns the entries to
 * propose, or throws a PriceParseError naming every problem (the page is then
 * rejected as a whole).
 */
export function diffPage(
  page: Pick<PricingPage, "product" | "label">,
  parsed: readonly PublishedPrice[],
  timeline: readonly PublishedPrice[],
  asOf: string,
): PriceDiffEntry[] {
  const problems: string[] = [];
  const entries: PriceDiffEntry[] = [];
  const seen = new Set(parsed.map(key));
  for (const tracked of new Set(timeline.filter((p) => p.product === page.product).map(key)))
    if (!seen.has(tracked)) problems.push(`${tracked.split("\u0000")[1]} is no longer on the page`);
  for (const after of parsed) {
    const label = metricLabel(after.product, after.metric);
    const versions = timeline.filter((p) => key(p) === key(after));
    // What this price replaces: the version in effect when it would start, or
    // (before billing starts) the scheduled one.
    const before =
      priceOn(versions, after.product, after.metric, after.effectiveFrom) ??
      versions.toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ??
      null;
    if (!before) {
      entries.push({
        product: after.product,
        metric: after.metric,
        label,
        kind: "added",
        before: null,
        after,
        fields: [],
      });
      continue;
    }
    if (before.unit !== after.unit) {
      problems.push(`${label}: the unit changed from ${before.unit} to ${after.unit}`);
      continue;
    }
    const fields: string[] = [];
    const ratio = perUnit(after) / perUnit(before);
    if (!same(perUnit(after), perUnit(before))) {
      if (!(ratio <= PLAUSIBLE_FACTOR && ratio >= 1 / PLAUSIBLE_FACTOR)) {
        problems.push(
          `${label}: the price moved from ${describe(before)} to ${describe(after)}, more than ${PLAUSIBLE_FACTOR}x`,
        );
        continue;
      }
      fields.push("price");
    }
    if (
      before.includedQuantity !== after.includedQuantity ||
      before.includedPeriod !== after.includedPeriod
    ) {
      const a = before.includedQuantity ?? 0;
      const b = after.includedQuantity ?? 0;
      if (a > 0 && b > 0 && (b / a > PLAUSIBLE_FACTOR || a / b > PLAUSIBLE_FACTOR)) {
        problems.push(
          `${label}: the included allowance moved from ${a} to ${b}, more than ${PLAUSIBLE_FACTOR}x`,
        );
        continue;
      }
      fields.push("included");
    }
    // A scheduled price whose billing start moved.
    if (before.effectiveFrom > asOf && after.effectiveFrom !== before.effectiveFrom)
      fields.push("effectiveFrom");
    if (fields.length)
      entries.push({
        product: after.product,
        metric: after.metric,
        label,
        kind: "changed",
        before: publishedOf(before),
        after,
        fields,
      });
  }
  if (problems.length) throw new PriceParseError(`${page.label}: ${problems.join("; ")}`);
  return entries;
}

const describe = (p: PublishedPrice) =>
  `$${p.unitPriceUsd} per ${p.unitQuantity.toLocaleString("en-US")} ${p.unit}`;

export interface RefreshOptions {
  fetcher?: Fetcher;
  now?: Date;
  /** Who asked (an account id); null for the scheduled check. */
  actorId?: string | null;
  kind?: Extract<PriceChangeKind, "refresh" | "check">;
  /** Only these pages (tests); default every page. */
  pages?: readonly PricingPage[];
}

/**
 * Fetch, parse and validate every pricing page and record the result as a
 * change: `pending` when it proposes something (an earlier pending change is
 * then superseded), `unchanged` when the catalog already matches, `rejected`
 * when no page could be read.
 */
export async function refreshCatalog(
  d1: D1Database,
  options: RefreshOptions = {},
): Promise<PriceChangeSummary> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? new Date();
  const asOf = utcDay(now);
  const [timeline, version] = await Promise.all([priceTimeline(d1), catalogVersion(d1)]);
  const pages: PricePageResult[] = [];
  const diff: PriceDiffEntry[] = [];
  await Promise.all(
    (options.pages ?? PRICING_PAGES).map(async (page) => {
      const fetchedAt = new Date().toISOString();
      try {
        const markdown = await fetchPage(page, fetcher);
        const parsed = parsePricingPage(page, markdown, asOf);
        pages.push({
          product: page.product,
          url: page.url,
          fetchedAt,
          sourceUpdated: parsed[0]?.sourceUpdated ?? null,
          error: null,
        });
        diff.push(...diffPage(page, parsed, timeline, asOf));
      } catch (error) {
        const reason =
          error instanceof PriceParseError
            ? error.message
            : `${page.label}: the page couldn't be fetched (${error instanceof Error ? error.message : String(error)})`;
        const result = pages.find((p) => p.product === page.product);
        if (result) result.error = reason;
        else
          pages.push({
            product: page.product,
            url: page.url,
            fetchedAt,
            sourceUpdated: null,
            error: reason,
          });
      }
    }),
  );
  const order = (product: string) => PRICING_PAGES.findIndex((p) => p.product === product);
  pages.sort((a, b) => order(a.product) - order(b.product));
  diff.sort((a, b) => order(a.product) - order(b.product) || a.metric.localeCompare(b.metric));
  const failed = pages.filter((p) => p.error).length;
  const status = diff.length ? "pending" : failed === pages.length ? "rejected" : "unchanged";
  const k = db(d1);
  if (status === "pending")
    await k
      .updateTable("cloudflare_price_changes")
      .set({ status: "superseded", decided_at: now.toISOString() })
      .where("status", "=", "pending")
      .where("kind", "in", ["refresh", "check"])
      .execute();
  const inserted = await k
    .insertInto("cloudflare_price_changes")
    .values({
      kind: options.kind ?? "refresh",
      status,
      created_at: now.toISOString(),
      created_by: options.actorId ?? null,
      base_version: version,
      pages: JSON.stringify(pages),
      diff: JSON.stringify(diff),
      note: failed ? `${failed} of ${pages.length} pages rejected` : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return (await getChange(d1, inserted.id))!;
}

/** Once per UTC day from the hourly cron: a refresh nobody asked for, kept for review. */
export async function checkCatalogDaily(
  d1: D1Database,
  options: Omit<RefreshOptions, "kind" | "actorId"> = {},
): Promise<PriceChangeSummary | null> {
  const now = options.now ?? new Date();
  const today = `${utcDay(now)}T00:00:00.000Z`;
  const recent = await db(d1)
    .selectFrom("cloudflare_price_changes")
    .select("id")
    .where("kind", "in", ["refresh", "check"])
    .where("created_at", ">=", today)
    .executeTakeFirst();
  if (recent) return null;
  return refreshCatalog(d1, { ...options, now, kind: "check", actorId: null });
}

// ---- applying -------------------------------------------------------------------

export type ApplyResult =
  | { status: "applied"; change: PriceChangeSummary }
  | { status: "not_found" | "not_pending" | "stale"; message: string };

/**
 * Apply a pending change: one new version per entry, superseding any
 * unsuperseded version of that metric on or after its effective date, all in
 * one D1 batch. Refused when the catalog changed since the diff was computed.
 */
export async function applyChange(
  d1: D1Database,
  id: number,
  actorId: string,
  now = new Date(),
): Promise<ApplyResult> {
  const change = await getChange(d1, id);
  if (!change) return { status: "not_found", message: "No such change." };
  if (change.status !== "pending")
    return { status: "not_pending", message: `That change is ${change.status}, not pending.` };
  if (change.baseVersion !== (await catalogVersion(d1)))
    return {
      status: "stale",
      message: "The catalog changed since this diff was made. Refresh again.",
    };
  const at = now.toISOString();
  const k = db(d1);
  // Every write below happens only if this batch is the one that applied the change.
  const appliedByThisBatch = () =>
    k
      .selectFrom("cloudflare_price_changes")
      .select("id")
      .where("id", "=", id)
      .where("status", "=", "applied")
      .where("decided_at", "=", at);
  const provenance = change.kind === "manual" ? "manual" : "refresh";
  const fetchedAt = (product: string) =>
    change.pages.find((p) => p.product === product)?.fetchedAt ?? null;
  const queries = [
    k
      .updateTable("cloudflare_price_changes")
      .set({ status: "applied", decided_at: at, decided_by: actorId })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .where(
        (eb) =>
          eb
            .selectFrom("cloudflare_price_changes")
            .select((e) => e.fn.coalesce(e.fn.max("id"), e.lit(0)).as("v"))
            .where("status", "=", "applied"),
        "=",
        change.baseVersion ?? 0,
      ),
  ];
  for (const entry of change.diff) {
    const p = entry.after;
    const guard = appliedByThisBatch();
    // A scheduled price whose start moved: the old schedule goes too.
    const moved = entry.fields.includes("effectiveFrom") ? entry.before?.effectiveFrom : undefined;
    queries.push(
      // Older versions on or after this date step aside (kept, marked superseded)…
      k
        .updateTable("cloudflare_prices")
        .set({ superseded_at: at })
        .where("product", "=", p.product)
        .where("metric", "=", p.metric)
        .where("superseded_at", "is", null)
        .where((eb) =>
          eb.and([
            eb.or([
              eb("effective_from", ">=", p.effectiveFrom),
              ...(moved ? [eb("effective_from", "=", moved)] : []),
            ]),
            eb.exists(guard),
          ]),
        ) as never,
      // …for the new version…
      k
        .insertInto("cloudflare_prices")
        .columns([
          "change_id",
          "product",
          "metric",
          "unit",
          "unit_quantity",
          "unit_price_usd",
          "included_quantity",
          "included_period",
          "effective_from",
          "source_url",
          "source_updated",
          "fetched_at",
          "provenance",
          "recorded_at",
          "recorded_by",
          "note",
        ])
        .expression(
          k
            .selectNoFrom((eb) => [
              eb.val(id).as("change_id"),
              eb.val(p.product).as("product"),
              eb.val(p.metric).as("metric"),
              eb.val(p.unit).as("unit"),
              eb.val(p.unitQuantity).as("unit_quantity"),
              eb.val(p.unitPriceUsd).as("unit_price_usd"),
              eb.val(p.includedQuantity).as("included_quantity"),
              eb.val(p.includedPeriod).as("included_period"),
              eb.val(p.effectiveFrom).as("effective_from"),
              eb.val(p.sourceUrl).as("source_url"),
              eb.val(p.sourceUpdated).as("source_updated"),
              eb.val(provenance === "manual" ? null : fetchedAt(p.product)).as("fetched_at"),
              eb.val(provenance).as("provenance"),
              eb.val(at).as("recorded_at"),
              eb.val(actorId).as("recorded_by"),
              eb.val(change.note).as("note"),
            ])
            .where((w) => w.exists(guard)),
        ) as never,
      // …which they point at.
      k
        .updateTable("cloudflare_prices")
        .set((eb) => ({
          superseded_by: eb
            .selectFrom("cloudflare_prices")
            .select((e) => e.fn.max("id").as("id"))
            .where("change_id", "=", id)
            .where("product", "=", p.product)
            .where("metric", "=", p.metric),
        }))
        .where("product", "=", p.product)
        .where("metric", "=", p.metric)
        .where("superseded_at", "=", at)
        .where("superseded_by", "is", null) as never,
    );
  }
  await batch(d1, queries);
  const after = await getChange(d1, id);
  if (after?.status !== "applied" || after.decidedAt !== at)
    return { status: "stale", message: "Another change was applied first. Refresh again." };
  return { status: "applied", change: after };
}

export async function discardChange(
  d1: D1Database,
  id: number,
  actorId: string,
  now = new Date(),
): Promise<ApplyResult> {
  const result = await db(d1)
    .updateTable("cloudflare_price_changes")
    .set({ status: "discarded", decided_at: now.toISOString(), decided_by: actorId })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) {
    const change = await getChange(d1, id);
    return change
      ? { status: "not_pending", message: `That change is ${change.status}, not pending.` }
      : { status: "not_found", message: "No such change." };
  }
  return { status: "applied", change: (await getChange(d1, id))! };
}

// ---- manual edits ---------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Check an edit; a message for the person when it can't be made. */
function editProblem(edit: Partial<PriceEdit>, before: PublishedPrice | null): string | null {
  if (!before) return "No such price in the catalog.";
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!finite(edit.unitPriceUsd) || edit.unitPriceUsd! < 0)
    return "The price must be a number of dollars, 0 or more.";
  if (edit.unitQuantity !== undefined && (!finite(edit.unitQuantity) || edit.unitQuantity <= 0))
    return "The quantity the price is for must be more than 0.";
  if (
    edit.includedQuantity !== undefined &&
    edit.includedQuantity !== null &&
    (!finite(edit.includedQuantity) || edit.includedQuantity < 0)
  )
    return "The included allowance must be 0 or more.";
  if (
    edit.includedPeriod !== undefined &&
    edit.includedPeriod !== null &&
    edit.includedPeriod !== "month" &&
    edit.includedPeriod !== "day"
  )
    return "The allowance is per month or per day.";
  if (
    edit.effectiveFrom !== undefined &&
    (!DAY.test(edit.effectiveFrom) || Number.isNaN(Date.parse(edit.effectiveFrom)))
  )
    return "The effective date must be YYYY-MM-DD.";
  if (typeof edit.note !== "string" || !edit.note.trim())
    return "Say why the price is being changed.";
  if (edit.note.length > 500) return "Keep the note under 500 characters.";
  return null;
}

/**
 * A site administrator sets one metric's price: recorded as a `manual` change
 * and applied at once (its unit stays the metric's unit).
 */
export async function editPrice(
  d1: D1Database,
  edit: Partial<PriceEdit>,
  actorId: string,
  now = new Date(),
): Promise<ApplyResult | { status: "invalid"; message: string }> {
  const timeline = await priceTimeline(d1);
  const effectiveFrom = edit.effectiveFrom ?? utcDay(now);
  const versions = timeline.filter((p) => p.product === edit.product && p.metric === edit.metric);
  const before =
    priceOn(versions, edit.product as PriceProduct, edit.metric ?? "", effectiveFrom) ??
    versions[0] ??
    null;
  const problem = editProblem(edit, before);
  if (problem || !before) return { status: "invalid", message: problem ?? "No such price." };
  const was = publishedOf(before);
  const label = before.label;
  const includedQuantity =
    edit.includedQuantity === undefined ? was.includedQuantity : edit.includedQuantity;
  const after: PublishedPrice = {
    ...was,
    unitQuantity: edit.unitQuantity ?? was.unitQuantity,
    unitPriceUsd: edit.unitPriceUsd!,
    includedQuantity,
    includedPeriod:
      includedQuantity === null ? null : (edit.includedPeriod ?? was.includedPeriod ?? "month"),
    effectiveFrom,
  };
  const fields = [
    ...(same(perUnit(after), perUnit(was)) ? [] : ["price"]),
    ...(after.includedQuantity !== was.includedQuantity ||
    after.includedPeriod !== was.includedPeriod
      ? ["included"]
      : []),
    // Moving a scheduled price's start; otherwise the old version stays with its date.
    ...(was.effectiveFrom > utcDay(now) && after.effectiveFrom !== was.effectiveFrom
      ? ["effectiveFrom"]
      : []),
  ];
  if (!fields.length && after.effectiveFrom === was.effectiveFrom)
    return { status: "invalid", message: "That is already the price." };
  const entry: PriceDiffEntry = {
    product: was.product,
    metric: was.metric,
    label,
    kind: "changed",
    before: was,
    after,
    fields,
  };
  const inserted = await db(d1)
    .insertInto("cloudflare_price_changes")
    .values({
      kind: "manual",
      status: "pending",
      created_at: now.toISOString(),
      created_by: actorId,
      base_version: await catalogVersion(d1),
      diff: JSON.stringify([entry]),
      note: edit.note!.trim(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return applyChange(d1, inserted.id, actorId, now);
}
