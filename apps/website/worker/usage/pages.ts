// Where each price lives on Cloudflare's published pricing pages (CORE-208).
// Each page's parser reads the tables it knows by heading, column and row
// label, checks that every price is written in the unit it expects, and
// returns every metric Gitmatrix tracks for that product, or throws a
// PriceParseError saying what it couldn't find. Never AI: if Cloudflare
// rewrites a page so it no longer reads, the refresh rejects it and says why.
//
// Workers Paid prices: Gitmatrix runs on a paid account. Included allowances
// are account-wide, per month unless the page says per day.

import {
  amount,
  DATE_IN_PROSE,
  isoDate,
  lastUpdated,
  markdownTables,
  prose,
  writtenPrice,
  type MarkdownTable,
} from "./markdown.ts";
import type { PriceProduct, PriceUnit, PublishedPrice } from "../../shared/usage.ts";

export class PriceParseError extends Error {
  override name = "PriceParseError";
}

/** Every Workers AI model the code calls, and the prices it is billed on (catalog.test.ts checks the code). */
export const WORKERS_AI_MODELS: Readonly<Record<string, readonly ModelMetric[]>> = {
  "@cf/zai-org/glm-5.3-flash": ["input", "cached_input", "output"],
  "@cf/zai-org/glm-5.3": ["input", "cached_input", "output"],
  "@cf/qwen/qwen3.8-27b": ["input", "output"],
  "@cf/google/gemma-4-26b-a4b-it": ["input", "output"],
  "@cf/cloudflare/clef": ["input"],
  "@cf/cloudflare/clef-flash": ["input"],
  "@cf/qwen/qwen3-embedding-0.6b": ["input"],
  "@cf/ibm-granite/granite-4.0-h-micro": ["input", "output"],
  "@cf/black-forest-labs/flux-1-schnell": ["tile", "step"],
};

export type ModelMetric = "input" | "cached_input" | "output" | "tile" | "step";

const MODEL_UNITS: Record<string, { metric: ModelMetric; unit: PriceUnit }> = {
  "input tokens": { metric: "input", unit: "token" },
  "cached input tokens": { metric: "cached_input", unit: "token" },
  "output tokens": { metric: "output", unit: "token" },
  "512x512 tile": { metric: "tile", unit: "tile" },
  step: { metric: "step", unit: "step" },
};

/** A Workers AI model's metric id: `@cf/qwen/qwen3.8-27b:input`. */
export const modelMetric = (model: string, metric: ModelMetric) => `${model}:${metric}`;

// ---- reading cells ------------------------------------------------------------

interface Context {
  page: PricingPage;
  markdown: string;
  tables: MarkdownTable[];
  text: string;
  asOf: string;
}

function findTable(
  ctx: Context,
  where: { heading?: RegExp; header: RegExp },
  what: string,
): MarkdownTable {
  const table = ctx.tables.find(
    (t) =>
      (!where.heading || where.heading.test(t.heading)) &&
      t.headers.some((h) => where.header.test(h)),
  );
  if (!table) throw new PriceParseError(`${ctx.page.label}: no ${what} table`);
  return table;
}

function cell(table: MarkdownTable, row: RegExp, column: RegExp, what: string): string {
  const col = table.headers.findIndex((h) => column.test(h));
  const found = table.rows.find((r) => row.test(r[0] ?? ""));
  if (col < 0 || !found || found[col] === undefined || found[col] === "")
    throw new PriceParseError(`${what}: no row or column for it`);
  return found[col]!;
}

function price(text: string, unit: RegExp, what: string) {
  const written = writtenPrice(text);
  if (!written) throw new PriceParseError(`${what}: no price in "${oneLine(text)}"`);
  if (!unit.test(written.unit))
    throw new PriceParseError(
      `${what}: the price is per "${written.unit || "(nothing)"}", expected ${unit.source}`,
    );
  if (!(written.usd > 0) || !(written.quantity > 0))
    throw new PriceParseError(`${what}: implausible price "${oneLine(text)}"`);
  return written;
}

/** The allowance before the `+ $…` (or the whole cell), and whether it is per day or per month. */
function included(text: string, what: string) {
  const before = text.split("+")[0]!;
  const quantity = amount(before);
  if (quantity === null)
    throw new PriceParseError(`${what}: no included amount in "${oneLine(text)}"`);
  return { quantity, period: /\bday\b/i.test(before) ? ("day" as const) : ("month" as const) };
}

const SECONDS: Record<string, number> = { hour: 3600, minute: 60, second: 1 };

/** A per-month allowance written as `25 GiB-hours/month`, in the price's seconds. */
function includedSeconds(text: string, resource: RegExp, what: string) {
  const before = text.split("+")[0]!;
  const match = /(\d[\d,.]*)\s*([A-Za-z]+)-(hour|minute|second)s?\b/.exec(before);
  if (!match || !resource.test(match[2]!))
    throw new PriceParseError(`${what}: no included amount in "${oneLine(text)}"`);
  if (!/\bmonth\b/i.test(before))
    throw new PriceParseError(`${what}: the allowance isn't per month in "${oneLine(text)}"`);
  const quantity = amount(match[1]!);
  if (quantity === null) throw new PriceParseError(`${what}: no included amount`);
  return { quantity: quantity * SECONDS[match[3]!]!, period: "month" as const };
}

const oneLine = (text: string) => text.replace(/\n/g, " ").slice(0, 120);

/** The date a sentence on the page says billing starts, if it says so. */
function billingStart(ctx: Context, sentence: string): string | null {
  const match = new RegExp(sentence.replace("DATE", DATE_IN_PROSE), "i").exec(ctx.text);
  return match ? isoDate(match[1]!) : null;
}

interface Row {
  metric: string;
  unit: PriceUnit;
  written: { usd: number; quantity: number };
  included: { quantity: number; period: "month" | "day" } | null;
  /** A date later than the refresh the page says this starts being billed. */
  starts?: string | null;
}

/** A paid-plan cell `[First] N … included + $X / unit`. */
function paidCell(
  ctx: Context,
  table: MarkdownTable,
  metric: string,
  row: RegExp,
  unit: PriceUnit,
  priceUnit: RegExp,
  column = /paid/i,
): Row {
  const what = `${ctx.page.label} ${metric}`;
  const text = cell(table, row, column, what);
  return { metric, unit, written: price(text, priceUnit, what), included: included(text, what) };
}

// ---- the pages ------------------------------------------------------------------

export interface PricingPage {
  product: PriceProduct;
  label: string;
  /** The page people read; its markdown is `${url}index.md`. */
  url: string;
  read(ctx: Context): Row[];
}

const ROWS = /^rows?$/i;
const GB_MONTH = /^GB-mo(nth)?$/i;
const NOTHING = /^$/;

export const PRICING_PAGES: readonly PricingPage[] = [
  {
    product: "d1",
    label: "D1",
    url: "https://developers.cloudflare.com/d1/platform/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^Billing metrics$/i, header: /Workers Paid/ },
        "billing",
      );
      return [
        paidCell(ctx, t, "rows_read", /^Rows read$/i, "row", ROWS),
        paidCell(ctx, t, "rows_written", /^Rows written$/i, "row", ROWS),
        paidCell(ctx, t, "storage", /^Storage\b/i, "GB-month", GB_MONTH),
      ];
    },
  },
  {
    product: "durable_objects",
    label: "Durable Objects",
    url: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    read(ctx) {
      const compute = findTable(
        ctx,
        { heading: /^Compute billing$/i, header: /Paid plan/ },
        "compute",
      );
      const sqlite = findTable(
        ctx,
        { heading: /^SQLite storage backend$/i, header: /Workers Paid/ },
        "SQLite storage",
      );
      const storageStarts = billingStart(
        ctx,
        String.raw`Storage billing for SQLite-backed Durable Objects[^.]*?target date of DATE`,
      );
      return [
        paidCell(ctx, compute, "requests", /^Requests$/i, "request", /^(requests?)?$/i),
        paidCell(ctx, compute, "duration", /^Duration$/i, "GB-second", /^GB-s(econds?)?$/i),
        paidCell(ctx, sqlite, "sqlite_rows_read", /^Rows? reads?$/i, "row", ROWS),
        paidCell(ctx, sqlite, "sqlite_rows_written", /^Rows written$/i, "row", ROWS),
        {
          ...paidCell(ctx, sqlite, "sqlite_storage", /^SQL Stored data$/i, "GB-month", GB_MONTH),
          starts: storageStarts,
        },
      ];
    },
  },
  {
    product: "r2",
    label: "R2",
    url: "https://developers.cloudflare.com/r2/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^R2 pricing$/i, header: /Standard storage/ },
        "R2 pricing",
      );
      const free = findTable(ctx, { heading: /^Free tier$/i, header: /^Free$/ }, "free tier");
      const std = /^Standard storage$/i;
      const ia = /^Infrequent Access storage$/i;
      const rows: [string, RegExp, RegExp, PriceUnit, RegExp, boolean][] = [
        ["standard_storage", /^Storage$/i, std, "GB-month", GB_MONTH, true],
        ["standard_class_a", /^Class A Operations$/i, std, "request", /^requests$/i, true],
        ["standard_class_b", /^Class B Operations$/i, std, "request", /^requests$/i, true],
        ["ia_storage", /^Storage$/i, ia, "GB-month", GB_MONTH, false],
        ["ia_class_a", /^Class A Operations$/i, ia, "request", /^requests$/i, false],
        ["ia_class_b", /^Class B Operations$/i, ia, "request", /^requests$/i, false],
        ["ia_retrieval", /^Data Retrieval\b/i, ia, "GB", /^GB$/, false],
      ];
      return rows.map(([metric, row, column, unit, priceUnit, hasFreeTier]) => {
        const what = `R2 ${metric}`;
        return {
          metric,
          unit,
          written: price(cell(t, row, column, what), priceUnit, what),
          // The free tier only applies to Standard storage.
          included: hasFreeTier
            ? included(cell(free, row, /^Free$/, `${what} free tier`), `${what} free tier`)
            : { quantity: 0, period: "month" },
        };
      });
    },
  },
  {
    product: "artifacts",
    label: "Artifacts",
    url: "https://developers.cloudflare.com/artifacts/platform/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^Artifacts pricing$/i, header: /Workers Paid/ },
        "pricing",
      );
      const starts = billingStart(ctx, String.raw`begin billing for Artifacts[^.]*? on DATE`);
      return [
        paidCell(ctx, t, "operations", /^Operations\b/i, "operation", /^operations$/i),
        paidCell(ctx, t, "storage", /^Storage\b/i, "GB-month", GB_MONTH),
      ].map((row) => ({ ...row, starts }));
    },
  },
  {
    product: "vectorize",
    label: "Vectorize",
    url: "https://developers.cloudflare.com/vectorize/platform/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^Billing metrics$/i, header: /Workers Paid/ },
        "billing",
      );
      const dims = /^((queried |stored )?vector dimensions)?$/i;
      return [
        paidCell(
          ctx,
          t,
          "queried_dimensions",
          /queried vector dimensions/i,
          "vector dimension",
          dims,
        ),
        paidCell(
          ctx,
          t,
          "stored_dimensions",
          /stored vector dimensions/i,
          "vector dimension",
          dims,
        ),
      ];
    },
  },
  {
    product: "ai_search",
    label: "AI Search",
    url: "https://developers.cloudflare.com/ai-search/platform/limits-pricing/",
    read(ctx) {
      const t = findTable(ctx, { heading: /^Pricing$/i, header: /^Price$/ }, "pricing");
      const starts = billingStart(ctx, String.raw`AI Search billing begins on DATE`);
      // The included usage is a bulleted list above the table.
      const section =
        /Every account receives the following included usage each month:([\s\S]*?)Usage beyond/i.exec(
          ctx.text,
        );
      if (!section) throw new PriceParseError("AI Search: no included usage list");
      const allowance = (pattern: RegExp, what: string) => {
        const line = section[1]!.split("\n").find((l) => pattern.test(l));
        const quantity = line ? amount(line) : null;
        if (quantity === null) throw new PriceParseError(`AI Search ${what}: no included amount`);
        return { quantity, period: "month" as const };
      };
      const row = (
        metric: string,
        label: RegExp,
        unit: PriceUnit,
        priceUnit: RegExp,
        inc: RegExp,
      ) => {
        const what = `AI Search ${metric}`;
        return {
          metric,
          unit,
          written: price(cell(t, label, /^Price$/, what), priceUnit, what),
          included: allowance(inc, metric),
          starts,
        };
      };
      return [
        row("ingestion_tokens", /^Base ingestion$/i, "token", /^tokens$/i, /ingestion tokens/i),
        row("storage", /^Storage$/i, "GB-month", GB_MONTH, /of storage/i),
        row("semantic_queries", /^Semantic\b/i, "query", /^queries$/i, /semantic queries/i),
        row(
          "fulltext_queries",
          /^Full-text queries$/i,
          "query",
          /^queries$/i,
          /full-text queries/i,
        ),
      ];
    },
  },
  {
    product: "workflows",
    label: "Workflows",
    url: "https://developers.cloudflare.com/workflows/reference/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^Workflows pricing$/i, header: /Workers Paid/ },
        "pricing",
      );
      const starts = billingStart(
        ctx,
        String.raw`Billing for Workflows steps and storage will apply starting DATE`,
      );
      return [
        paidCell(ctx, t, "requests", /^Requests\b/i, "request", NOTHING),
        paidCell(ctx, t, "cpu_time", /^CPU time\b/i, "CPU millisecond", /^CPU milliseconds$/i),
        { ...paidCell(ctx, t, "storage", /^Storage\b/i, "GB-month", GB_MONTH), starts },
        { ...paidCell(ctx, t, "steps", /^Steps$/i, "step", /^(steps )?per month$/i), starts },
      ];
    },
  },
  {
    product: "queues",
    label: "Queues",
    url: "https://developers.cloudflare.com/queues/platform/pricing/",
    read(ctx) {
      const t = findTable(ctx, { header: /Workers Paid/ }, "pricing");
      return [
        paidCell(ctx, t, "operations", /^Standard operations$/i, "operation", /^operations$/i),
      ];
    },
  },
  {
    product: "workers_ai",
    label: "Workers AI",
    url: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    read(ctx) {
      const plans = findTable(ctx, { header: /^Pricing$/ }, "neurons");
      const neurons = {
        metric: "neurons",
        unit: "neuron" as const,
        written: price(
          cell(plans, /^Workers Paid$/i, /^Pricing$/, "Workers AI neurons"),
          /^Neurons$/i,
          "Workers AI neurons",
        ),
        included: included(
          cell(plans, /^Workers Paid$/i, /^Free\s+allocation$/i, "Workers AI allocation"),
          "Workers AI allocation",
        ),
      };
      const priced = new Map<string, string>();
      for (const table of ctx.tables) {
        const col = table.headers.findIndex((h) => /^Price in Tokens$/i.test(h));
        if (table.headers[0] !== "Model" || col < 0) continue;
        for (const row of table.rows) if (row[0] && row[col]) priced.set(row[0], row[col]);
      }
      const rows: Row[] = [neurons];
      for (const [model, metrics] of Object.entries(WORKERS_AI_MODELS)) {
        const text = priced.get(model);
        if (!text) throw new PriceParseError(`Workers AI: no price for ${model}`);
        const lines = new Map<ModelMetric, { unit: PriceUnit; usd: number; quantity: number }>();
        for (const line of text.split("\n")) {
          const written = writtenPrice(line);
          const kind = written ? MODEL_UNITS[written.unit] : undefined;
          if (!written || !kind)
            throw new PriceParseError(`Workers AI ${model}: unrecognised price "${line}"`);
          lines.set(kind.metric, { unit: kind.unit, usd: written.usd, quantity: written.quantity });
        }
        for (const metric of metrics) {
          const line = lines.get(metric);
          if (!line) throw new PriceParseError(`Workers AI ${model}: no ${metric} price`);
          if (!(line.usd > 0))
            throw new PriceParseError(`Workers AI ${model}: implausible ${metric} price`);
          // Model prices draw on the account's daily neuron allocation, not an allowance of their own.
          rows.push({
            metric: modelMetric(model, metric),
            unit: line.unit,
            written: line,
            included: null,
          });
        }
      }
      return rows;
    },
  },
  {
    product: "containers",
    label: "Containers",
    url: "https://developers.cloudflare.com/containers/platform/pricing/",
    read(ctx) {
      const t = findTable(
        ctx,
        { heading: /^vCPU, Memory and Disk$/i, header: /^CPU$/ },
        "vCPU, memory and disk",
      );
      const row = /^Workers Paid$/i;
      // Billed per second; the allowances are written in hours or minutes.
      const resource = (
        metric: string,
        column: RegExp,
        unit: PriceUnit,
        priceUnit: RegExp,
        allowance: RegExp,
      ): Row => {
        const what = `Containers ${metric}`;
        const text = cell(t, row, column, what);
        return {
          metric,
          unit,
          written: price(text, priceUnit, what),
          included: includedSeconds(text, allowance, what),
        };
      };
      return [
        resource("vcpu", /^CPU$/, "vCPU-second", /^vCPU-seconds?$/, /vCPU/),
        resource("memory", /^Memory$/, "GiB-second", /^GiB-seconds?$/, /GiB/),
        resource("disk", /^Disk$/, "GB-second", /^GB-seconds?$/, /GB/),
      ];
    },
  },
];

export const pricingPage = (product: PriceProduct) =>
  PRICING_PAGES.find((page) => page.product === product)!;

/**
 * Every price Gitmatrix tracks on one page, as of `asOf` (YYYY-MM-DD): a price
 * whose billing starts later takes effect then. Throws PriceParseError when the
 * page doesn't read as expected.
 */
export function parsePricingPage(
  page: PricingPage,
  markdown: string,
  asOf: string,
): PublishedPrice[] {
  if (!/\|/.test(markdown) || !/^# /m.test(markdown))
    throw new PriceParseError(`${page.label}: not a pricing page (no heading or tables)`);
  const ctx: Context = {
    page,
    markdown,
    tables: markdownTables(markdown),
    text: prose(markdown),
    asOf,
  };
  const sourceUpdated = lastUpdated(markdown);
  return page.read(ctx).map((row) => ({
    product: page.product,
    metric: row.metric,
    unit: row.unit,
    unitQuantity: row.written.quantity,
    unitPriceUsd: row.written.usd,
    includedQuantity: row.included?.quantity ?? null,
    includedPeriod: row.included?.period ?? null,
    effectiveFrom: row.starts && row.starts > asOf ? row.starts : asOf,
    sourceUrl: page.url,
    sourceUpdated,
  }));
}
