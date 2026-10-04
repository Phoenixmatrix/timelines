// Usage and costs (CORE-195 PRD): the Cloudflare price catalog (CORE-208).
//
// Every price is Cloudflare's published Workers Paid list price for one metric,
// per `unitQuantity` units of `unit`. Included allowances are account-wide (the
// whole Cloudflare account Gitmatrix runs on), so per-Gitmatrix-account costs are
// gross list-price figures. A GB is 10^9 bytes.

export type PriceProduct =
  | "d1"
  | "durable_objects"
  | "r2"
  | "artifacts"
  | "vectorize"
  | "ai_search"
  | "workflows"
  | "queues"
  | "workers_ai"
  | "containers";

export const PRICE_PRODUCTS: Readonly<Record<PriceProduct, string>> = {
  d1: "D1",
  durable_objects: "Durable Objects",
  r2: "R2",
  artifacts: "Artifacts",
  vectorize: "Vectorize",
  ai_search: "AI Search",
  workflows: "Workflows",
  queues: "Queues",
  workers_ai: "Workers AI",
  containers: "Containers",
};

export type PriceUnit =
  | "row"
  | "GB-month"
  | "request"
  | "GB-second"
  | "GiB-second"
  | "vCPU-second"
  | "operation"
  | "vector dimension"
  | "token"
  | "query"
  | "CPU millisecond"
  | "step"
  | "neuron"
  | "GB"
  | "tile";

/** One metric's price as a pricing page publishes it. */
export interface PublishedPrice {
  product: PriceProduct;
  /** e.g. `rows_read`, `sqlite_storage`, `@cf/qwen/qwen3.8-27b:output`. */
  metric: string;
  unit: PriceUnit;
  /** The price is for this many units (1,000,000 for "per million rows"). */
  unitQuantity: number;
  unitPriceUsd: number;
  /** The account-wide allowance before billing, in units; null when the metric has none of its own. */
  includedQuantity: number | null;
  includedPeriod: "month" | "day" | null;
  /** YYYY-MM-DD the price applies from (a later billing start when the page names one). */
  effectiveFrom: string;
  /** The page it was read from. */
  sourceUrl: string;
  /** When that page says it was last changed, YYYY-MM-DD. */
  sourceUpdated: string | null;
}

export type PriceProvenance = "seed" | "refresh" | "manual";

/** A version in the catalog. */
export interface CatalogPrice extends PublishedPrice {
  id: number;
  label: string;
  provenance: PriceProvenance;
  /** The catalog change that recorded it. */
  changeId: number;
  recordedAt: string;
  /** Who applied or edited it (an account slug); null for the seed. */
  recordedBy: string | null;
  /** When the page was fetched; null for manual edits. */
  fetchedAt: string | null;
  note: string | null;
  /** Set when a later version for the same date replaced it. */
  supersededAt: string | null;
}

export interface PriceCatalog {
  /** The catalog's version: the last applied change. */
  version: number;
  /** For each metric, the version in effect `asOf`, then any scheduled later one. */
  prices: CatalogPrice[];
  asOf: string;
  /** A refresh waiting for a site administrator, if there is one. */
  pending: PriceChangeSummary | null;
}

/** One metric's proposed change in a refresh. */
export interface PriceDiffEntry {
  product: PriceProduct;
  metric: string;
  label: string;
  kind: "added" | "changed";
  before: PublishedPrice | null;
  after: PublishedPrice;
  /** What differs: `price`, `unit`, `included`, `effectiveFrom`. */
  fields: string[];
}

export interface PricePageResult {
  product: PriceProduct;
  url: string;
  fetchedAt: string;
  sourceUpdated: string | null;
  /** Why the page's prices were rejected; null when they were read and validated. */
  error: string | null;
}

export type PriceChangeKind = "seed" | "refresh" | "check" | "manual";
export type PriceChangeStatus =
  | "pending"
  | "applied"
  | "discarded"
  | "rejected"
  | "unchanged"
  | "superseded";

export interface PriceChangeSummary {
  id: number;
  kind: PriceChangeKind;
  status: PriceChangeStatus;
  createdAt: string;
  /** Account slug; null for the seed and scheduled checks. */
  createdBy: string | null;
  /** The catalog version the diff was computed against. */
  baseVersion: number | null;
  pages: PricePageResult[];
  diff: PriceDiffEntry[];
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** A site administrator's edit of one metric's price. */
export interface PriceEdit {
  product: PriceProduct;
  metric: string;
  unitPriceUsd: number;
  /** Defaults to the metric's current quantity. */
  unitQuantity?: number;
  includedQuantity?: number | null;
  includedPeriod?: "month" | "day" | null;
  /** YYYY-MM-DD; defaults to today. */
  effectiveFrom?: string;
  /** Why (required): kept with the version. */
  note: string;
}

const METRIC_LABELS: Readonly<Record<string, string>> = {
  "d1/rows_read": "Rows read",
  "d1/rows_written": "Rows written",
  "d1/storage": "Storage",
  "durable_objects/requests": "Requests",
  "durable_objects/duration": "Duration",
  "durable_objects/sqlite_rows_read": "SQLite rows read",
  "durable_objects/sqlite_rows_written": "SQLite rows written",
  "durable_objects/sqlite_storage": "SQLite storage",
  "r2/standard_storage": "Standard storage",
  "r2/standard_class_a": "Standard Class A operations",
  "r2/standard_class_b": "Standard Class B operations",
  "r2/ia_storage": "Infrequent Access storage",
  "r2/ia_class_a": "Infrequent Access Class A operations",
  "r2/ia_class_b": "Infrequent Access Class B operations",
  "r2/ia_retrieval": "Infrequent Access data retrieval",
  "artifacts/operations": "Operations",
  "artifacts/storage": "Storage",
  "vectorize/queried_dimensions": "Queried vector dimensions",
  "vectorize/stored_dimensions": "Stored vector dimensions",
  "ai_search/ingestion_tokens": "Ingestion tokens",
  "ai_search/storage": "Storage",
  "ai_search/semantic_queries": "Semantic, vector and hybrid queries",
  "ai_search/fulltext_queries": "Full-text queries",
  "workflows/requests": "Requests",
  "workflows/cpu_time": "CPU time",
  "workflows/storage": "Storage",
  "workflows/steps": "Steps",
  "queues/operations": "Operations",
  "workers_ai/neurons": "Neurons",
  "containers/vcpu": "vCPU time",
  "containers/memory": "Memory",
  "containers/disk": "Disk",
};

const MODEL_METRIC_LABELS: Readonly<Record<string, string>> = {
  input: "input tokens",
  cached_input: "cached input tokens",
  output: "output tokens",
  tile: "512×512 tiles",
  step: "steps",
};

/** What a metric is called: `Rows read`, `qwen3.8-27b output tokens`. */
export function metricLabel(product: PriceProduct, metric: string): string {
  const known = METRIC_LABELS[`${product}/${metric}`];
  if (known) return known;
  const model = /^@cf\/[^/]+\/([^:]+):(\w+)$/.exec(metric);
  if (product === "workers_ai" && model)
    return `${model[1]} ${MODEL_METRIC_LABELS[model[2]!] ?? model[2]}`;
  return metric;
}

/** USD for `quantity` units at a price. */
export function priceCost(
  price: Pick<PublishedPrice, "unitQuantity" | "unitPriceUsd">,
  quantity: number,
): number {
  return (quantity * price.unitPriceUsd) / price.unitQuantity;
}

/** Bytes in a GB, as Cloudflare bills storage. */
export const GB = 1e9;

// ---- the usage and cost report (CORE-209) ---------------------------------------

export type UsageConstruct =
  | "d1"
  | "durable_objects"
  | "r2"
  | "artifacts"
  | "vectorize"
  | "ai_search"
  | "workers_ai"
  | "ci";

export const USAGE_CONSTRUCTS: Readonly<Record<UsageConstruct, string>> = {
  d1: "D1",
  durable_objects: "Durable Objects",
  r2: "R2",
  artifacts: "Artifacts",
  vectorize: "Vectorize",
  ai_search: "AI Search",
  workers_ai: "Workers AI",
  ci: "CI sandboxes",
};

/** One measured or estimated figure: storage as of the report's day, or activity over its window. */
export interface UsageFigure {
  /** rows, bytes, instances, objects, repositories, vectors, dimensions, items, calls, input_tokens… */
  metric: string;
  quantity: number;
  estimated: boolean;
  /** How it was measured or estimated, in plain words. */
  method: string;
}

/** What one priced figure costs per month at the catalog's list price. */
export interface UsageCost {
  /** The catalog price used. */
  product: PriceProduct;
  metric: string;
  label: string;
  /** The figure it prices. */
  figure: string;
  /** How much of the price's unit: GB-months, tokens over the window, stored dimensions… */
  quantity: number;
  unit: PriceUnit;
  unitPriceUsd: number;
  unitQuantity: number;
  /** The account-wide allowance (not subtracted: these are gross list-price figures). */
  includedQuantity: number | null;
  includedPeriod: "month" | "day" | null;
  effectiveFrom: string;
  sourceUrl: string;
  monthlyUsd: number;
  /** The price isn't billed yet: billing starts this day, and monthlyUsd is what it will be. */
  startsOn: string | null;
  estimated: boolean;
}

export interface UsageCategoryLink {
  id: string;
  label: string;
  /** What the category removes, in plain words. */
  description: string;
  scope: "account" | "site";
}

/** One thing an account keeps or does: a D1 table group, a Durable Object class, a model… */
export interface UsageLine {
  construct: UsageConstruct;
  item: string;
  label: string;
  kind: "storage" | "activity";
  figures: UsageFigure[];
  costs: UsageCost[];
  /** The sum of its costs already billed. */
  monthlyUsd: number;
  estimated: boolean;
  /** The retention categories that clean this up. */
  categories: UsageCategoryLink[];
  /** E.g. why it has no price. */
  note: string | null;
}

export interface UsageConstructReport {
  construct: UsageConstruct;
  label: string;
  monthlyUsd: number;
  estimated: boolean;
  lines: UsageLine[];
}

export interface UsageTrendDay {
  day: string;
  /** That day's storage at a thirtieth of its monthly price, plus that day's activity. */
  costUsd: number;
  byConstruct: Partial<Record<UsageConstruct, number>>;
  /** Whether a snapshot exists for the day. */
  measured: boolean;
}

export interface UsageReport {
  scope: "account" | "site";
  /** The account, for an account's report. */
  account: { slug: string; displayName: string } | null;
  /** The day the storage figures describe; null before the first collection. */
  asOf: string | null;
  /** The activity window: the last 30 days up to asOf. */
  window: { from: string; to: string; daysMeasured: number };
  collectedAt: string | null;
  monthlyUsd: number;
  constructs: UsageConstructReport[];
  trend: UsageTrendDay[];
  /** Where the prices came from. */
  catalog: {
    version: number;
    sources: { product: PriceProduct; label: string; url: string; sourceUpdated: string | null }[];
  };
  /** Site reports: each account's monthly estimate, highest first (at most 200). */
  accounts: { slug: string; displayName: string; monthlyUsd: number }[] | null;
  /** Caveats every reader should see. */
  notes: string[];
}
