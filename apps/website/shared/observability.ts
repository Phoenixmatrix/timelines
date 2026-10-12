// Runtime observability read contracts (CORE-349; decisions on CORE-348).
//
// Gitmatrix reads a hosted repository's runtime evidence live from the
// provider it runs on and shows it next to commits, deployments, packages,
// releases and issues. These are the provider-neutral shapes the Cloudflare
// reader (CORE-352) returns and the History and entity views (CORE-353..356)
// consume. No Cloudflare SQL or payload type crosses this boundary.
//
// What this is not: a telemetry store or a query language. Gitmatrix persists
// no provider data: no aggregates, caches or evidence snapshots, no raw logs or
// bodies. Retention is the provider's live history; past it, evidence is
// `expired_at_provider`, never zero. The only stored shapes are connection
// metadata, service bindings (CORE-350) and explicit issue links
// ({@link ObservationRef}, CORE-353), which carry no payload.
//
// Times are UTC ISO instants (`2026-10-12T20:00:00.000Z`) in storage and on the
// wire, canonical with milliseconds so they sort as text; showing them in the
// viewer's local zone, with the zone named, is the UI's job. Intervals are
// half-open: [start, end). Buckets align to the UTC epoch, so a brush snaps to
// UTC-aligned ranges (a "day" bucket is a UTC day) while its labels are local.
//
// Nothing here proves causation. A matching provider version establishes which
// code ran, not that it caused or fixed anything; a time overlap is a candidate.
//
// OpenTelemetry portability (README, "Observability"): a future named backend
// implements {@link ObservabilityReader} through its own query API, mapping
// OTel `service.name`, `service.version`, `deployment.environment.name`,
// `trace_id` and `span_id`. OTLP is export-only, so there is no "otel" provider.

// ── Providers and connections ───────────────────────────────────────────────

/**
 * Providers with a reader. Only Cloudflare: each connection is a
 * customer-supplied, restricted, read-only credential. There is no
 * instance-operated or same-account mode; Gitmatrix observes its own
 * deployment as an ordinary hosted repository.
 */
export const OBSERVABILITY_PROVIDERS = ["cloudflare"] as const;
export type ObservabilityProvider = (typeof OBSERVABILITY_PROVIDERS)[number];

/** Whether the provider calls a dataset generally available or beta; beta is labelled in the UI. */
export const STABILITIES = ["ga", "beta"] as const;
export type Stability = (typeof STABILITIES)[number];

/**
 * A provider connection. It never carries the credential, which is sealed
 * server-side and never shown back. Only Space admins with an explicit Space
 * grant create, change or revoke one; anyone who can read a bound repository
 * reads its service's evidence.
 */
export interface ObservabilityConnection {
  id: string;
  /**
   * The immutable content scope (Space) that owns the connection, as an opaque
   * id; afterwards the Organization/Space cutover (CORE-361/362) makes it
   * `spaces.id`. Until then the server derives it from `repos.owner_id`, on the
   * CORE-360 mapping manifest's proposal that a legacy owner's id is reused as
   * its default Space id. That proposal awaits operator approval and is not
   * settled; if the approved mapping differs, stored values are remapped with
   * it. Clients never treat it as an account.
   */
  spaceId: string;
  provider: ObservabilityProvider;
  /**
   * Only bindings whose repository the caller can read; the full list is the
   * Space admins' view.
   */
  bindings: ServiceBinding[];
  capabilities: DatasetCapability[];
  /**
   * Full https URL prefixes the provider's own links may start with, declared
   * by the reader for this connection and including its account path; checked
   * with {@link validateLinkPrefixes} where they are declared and on every
   * {@link safeProviderLink}.
   */
  linkPrefixes: string[];
  /** The last successful bounded health read; null before the first. */
  checkedAt: string | null;
}

/**
 * One explicit repository → provider service/environment mapping. Identity is
 * never inferred from URLs. A service several repositories are bound to is
 * composed: evidence for it is at best ambiguous unless a version identifies
 * the repository. Other repositories bound to it are disclosed only to callers
 * who can read them: ambiguity may be reported, never how many hidden
 * repositories cause it.
 */
export interface ServiceBinding {
  id: string;
  connectionId: string;
  repoId: string;
  /** The provider's service name (a Worker script; OTel `service.name`). */
  service: string;
  /** A Gitmatrix environment name (`production`, `timeline/<slug>`…; see deployments.ts). */
  environment: string;
}

/** What a reader can read. */
export const READ_KINDS = ["series", "error-groups", "occurrences", "traces", "versions"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** Bounds the provider declares for one dataset; nothing here hardcodes a provider's numbers. */
export interface IntervalLimits {
  /** Longest interval one read may cover. */
  maxIntervalMs: number;
  /** Smallest bucket; every bucket width is a multiple of it. */
  minBucketMs: number;
  /** Most buckets one series may have (also capped by {@link OBSERVABILITY_MAX_BUCKETS}). */
  maxBuckets: number;
}

/** One provider dataset as discovered at runtime, not assumed. */
export interface DatasetCapability {
  /** The provider's dataset name; opaque to consumers. */
  dataset: string;
  stability: Stability;
  reads: ReadKind[];
  /**
   * Series this dataset can produce (with `series` in `reads`). A metric
   * missing here is `unsupported`, never zero.
   */
  metrics: MetricId[];
  /** The provider's live history; null when the provider doesn't say. */
  retentionMs: number | null;
  limits: IntervalLimits;
}

// ── Metrics ────────────────────────────────────────────────────────────────

/**
 * Semantic metrics. Each signal is its own series, never merged into an index:
 * Worker exceptions over invocations, 5xx responses at the edge and at the
 * origin over request counts, latency of a named kind, and tracker bug events
 * (read from Gitmatrix, not the provider).
 */
export const METRIC_IDS = [
  "worker.invocations",
  "worker.exceptions",
  "worker.exception_rate",
  "http.requests",
  "http.edge_5xx",
  "http.edge_5xx_rate",
  "http.origin_5xx",
  "http.origin_5xx_rate",
  "latency.wall",
  "latency.cpu",
  "latency.request",
  "tracker.bug_events",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricKind = "count" | "rate" | "distribution";

export interface MetricDefinition {
  id: MetricId;
  label: string;
  kind: MetricKind;
  unit: "count" | "ratio" | "ms";
  /** For a rate: the count it divides and the count it divides by. */
  numerator: MetricId | null;
  denominator: MetricId | null;
  /** Who answers it: a provider reader, or Gitmatrix's own tracker. */
  source: "provider" | "gitmatrix";
}

function countMetric(id: MetricId, label: string, source: "provider" | "gitmatrix" = "provider") {
  return {
    id,
    label,
    kind: "count",
    unit: "count",
    numerator: null,
    denominator: null,
    source,
  } as const;
}
function rateMetric(id: MetricId, label: string, numerator: MetricId, denominator: MetricId) {
  return {
    id,
    label,
    kind: "rate",
    unit: "ratio",
    numerator,
    denominator,
    source: "provider",
  } as const;
}
function latencyMetric(id: MetricId, label: string) {
  return {
    id,
    label,
    kind: "distribution",
    unit: "ms",
    numerator: null,
    denominator: null,
    source: "provider",
  } as const;
}

export const METRICS: Record<MetricId, MetricDefinition> = {
  "worker.invocations": countMetric("worker.invocations", "Worker invocations"),
  "worker.exceptions": countMetric("worker.exceptions", "Worker exceptions"),
  "worker.exception_rate": rateMetric(
    "worker.exception_rate",
    "Worker exception rate",
    "worker.exceptions",
    "worker.invocations",
  ),
  "http.requests": countMetric("http.requests", "Requests"),
  // Edge 5xx are the provider's own failures; origin 5xx are the service's.
  "http.edge_5xx": countMetric("http.edge_5xx", "Edge 5xx responses"),
  "http.edge_5xx_rate": rateMetric(
    "http.edge_5xx_rate",
    "Edge 5xx rate",
    "http.edge_5xx",
    "http.requests",
  ),
  "http.origin_5xx": countMetric("http.origin_5xx", "Origin 5xx responses"),
  "http.origin_5xx_rate": rateMetric(
    "http.origin_5xx_rate",
    "Origin 5xx rate",
    "http.origin_5xx",
    "http.requests",
  ),
  // Kept apart: wall time, CPU time and request latency measure different things.
  "latency.wall": latencyMetric("latency.wall", "Wall time"),
  "latency.cpu": latencyMetric("latency.cpu", "CPU time"),
  "latency.request": latencyMetric("latency.request", "Request latency"),
  "tracker.bug_events": countMetric("tracker.bug_events", "Bug issue events", "gitmatrix"),
};

// ── Time ───────────────────────────────────────────────────────────────────

/** A half-open UTC interval [start, end) of ISO instants. */
export interface UtcInterval {
  start: string;
  end: string;
}

/**
 * Equal-width buckets from `start`: bucket i is [start + i·bucketMs,
 * start + (i+1)·bucketMs). `start` is a multiple of `bucketMs` from the UTC
 * epoch.
 */
export interface Buckets {
  start: string;
  bucketMs: number;
  count: number;
}

/** Buckets in any one series, whatever the provider allows. */
export const OBSERVABILITY_MAX_BUCKETS = 1440;
/** How far past now an interval may end (a window that includes "now"). */
export const OBSERVABILITY_MAX_FUTURE_MS = 60 * 60 * 1000;
/** Items per page, at most, and when the request doesn't say. */
export const OBSERVABILITY_PAGE_MAX = 100;
export const OBSERVABILITY_PAGE_DEFAULT = 50;

/**
 * What a timestamp means. Kept distinct: a commit's time is not when it was
 * pushed, published or deployed, and a deployment is not when traffic reached it.
 * - `commit`: the Git committer time.
 * - `receipt`: when Gitmatrix received it (a push, a record).
 * - `publication`: a tag, release or package publish.
 * - `deployment`: when the provider says the version was deployed.
 * - `exposure`: when it served traffic (a share of it, for a canary).
 * - `observation`: when the provider recorded the event.
 */
export const TIMESTAMP_KINDS = [
  "commit",
  "receipt",
  "publication",
  "deployment",
  "exposure",
  "observation",
] as const;
export type TimestampKind = (typeof TIMESTAMP_KINDS)[number];

export interface TimedRef {
  kind: TimestampKind;
  at: string;
}

// ── Identity ───────────────────────────────────────────────────────────────

/** A commit is its repository, its source and its full object id; never a bare SHA. */
export interface CommitRef {
  repoId: string;
  sourceId: string;
  commit: string;
}

/** A registry publication: built from a commit is not proof it was deployed. */
export interface ArtifactRef {
  packageId: string;
  version: string;
  /** `<algorithm>:<hex>` (`sha256:…`) of the primary file or manifest, when there is one. */
  digest: string | null;
}

/** An immutable version or deployment id the provider assigned. */
export interface ProviderVersionRef {
  connectionId: string;
  bindingId: string;
  versionId: string;
  deploymentId: string | null;
}

/** A provider deployment as the provider reports it. */
export interface ProviderDeployment {
  version: ProviderVersionRef;
  /** `deployment`: when the provider deployed it. */
  deployedAt: string;
  /**
   * `exposure`: when it started and stopped serving; null end while it still
   * does. It starts no earlier than `deployedAt`.
   */
  exposedFrom: string | null;
  exposedUntil: string | null;
  /** A canary's traffic share, 0–100; null when it took all traffic or the provider doesn't say. */
  percentage: number | null;
  /** The version id it replaced; a rollback replaces a newer version with an older one. */
  replaces?: string | null;
  link: ProviderLink | null;
}

/** W3C trace context ids (OTel `trace_id`, `span_id`) and Cloudflare's Ray id. */
export interface TraceRef {
  traceId: string;
  spanId: string | null;
  rayId: string | null;
  link: ProviderLink | null;
}

export interface TraceSummary {
  trace: TraceRef;
  at: string;
  rootName: string;
  durationMs: number | null;
  status: "ok" | "error" | "unset";
  versionId: string | null;
}

export interface SpanSummary {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  start: string;
  durationMs: number | null;
  status: "ok" | "error" | "unset";
}

/** One trace on demand, with a bounded list of its spans. */
export interface TraceDetail extends TraceSummary {
  spans: SpanSummary[];
  /** More spans exist than were returned; the provider link has them all. */
  truncated: boolean;
}

/**
 * The provider's grouping of similar exceptions. A fingerprint is not a
 * tracker issue: linking one to an issue is an explicit person's action
 * ({@link ObservationRef}).
 */
export interface ErrorGroup {
  fingerprint: string;
  bindingId: string;
  /** The provider's summary (exception type and message). */
  title: string;
  /** The group's whole known history, which may reach outside the requested window. */
  firstSeen: string | null;
  lastSeen: string;
  /** Occurrences in the requested window only. */
  count: number;
  sampling: Sampling;
  versionIds: string[];
  link: ProviderLink | null;
}

export interface OccurrenceRef {
  id: string;
  fingerprint: string;
  at: string;
  versionId: string | null;
  trace: TraceRef | null;
  link: ProviderLink | null;
}

/**
 * A link into the provider's own UI. Only a URL the provider documents (a
 * detail page when there is a durable one, else a landing page with the ids to
 * copy); never a constructed guess. See {@link safeProviderLink}.
 */
export interface ProviderLink {
  url: string;
  kind: "detail" | "landing";
}

// ── Series ─────────────────────────────────────────────────────────────────

/** How a provider count relates to the truth: counted, weighted from a sample, or unknown. */
export const SAMPLINGS = ["exact", "estimated", "unknown"] as const;
export type Sampling = (typeof SAMPLINGS)[number];

/**
 * One metric over buckets. A null point has no value (uncovered, expired,
 * or a rate without its denominator) and is never drawn as zero; a zero is a
 * real zero only in a bucket the coverage fully covers.
 */
export interface Series {
  metric: MetricId;
  bindingId: string;
  dataset: string;
  stability: Stability;
  buckets: Buckets;
  points: (number | null)[];
  /** A rate's denominator counts, one per bucket; null when the denominator is unavailable. */
  denominator: (number | null)[] | null;
  /** A distribution's quantile (0.5, 0.95…); null otherwise. */
  quantile: number | null;
  sampling: Sampling;
  /** Sorted, disjoint parts of the buckets the provider actually covers. */
  coverage: UtcInterval[];
  /** The start of the buckets that fell past the provider's retention; null when none did. */
  expired: UtcInterval | null;
  /** Data up to here is settled; later buckets may still fill in. */
  freshThrough: string | null;
}

// ── Evidence ───────────────────────────────────────────────────────────────

/**
 * How an observation was attributed to code (CORE-348), counted after
 * candidates the caller can't read are omitted:
 * - `explicit`: exactly one candidate whose recorded provider version or
 *   artifact digest matches what ran.
 * - `temporal`: exactly one candidate, matched by its deployment or exposure time.
 * - `ambiguous`: one or more visible candidates where attribution isn't unique
 *   (canaries, rollbacks, composed or uninstrumented services); never shown as
 *   definite. One visible candidate can be ambiguous because of others the
 *   caller can't see; how many hidden candidates there were is never said.
 */
export const ATTRIBUTIONS = ["explicit", "temporal", "ambiguous"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/**
 * How that code reaches Gitmatrix work: `direct` through a deployment record's
 * own identity (so every candidate names its record), `derived` through
 * existing provenance (linked work, registry publishes, release notes).
 * Commit-message mentions are neither; they stay separate (`WorkMention`,
 * chronicle.ts).
 */
export const JOINS = ["direct", "derived"] as const;
export type Join = (typeof JOINS)[number];

/** One piece of code an observation may have run on. */
export interface EvidenceCandidate {
  commit: CommitRef;
  version: ProviderVersionRef | null;
  artifact: ArtifactRef | null;
  /** Gitmatrix's deployment record id, when one matched. */
  deploymentId: string | null;
  times: TimedRef[];
  /** A canary's traffic share, 0–1, when known. */
  weight?: number;
}

/**
 * Why runtime evidence is associated with work. Neither axis proves causation.
 * Candidates in repositories the caller can't read are omitted before the
 * attribution is chosen; if no visible candidate remains, the evidence is
 * omitted entirely, never returned with no candidates.
 */
export interface RuntimeEvidence {
  attribution: Attribution;
  join: Join;
  candidates: EvidenceCandidate[];
}

/**
 * A person's explicit link from an issue to an observation (CORE-353): a
 * reference, never a snapshot. It is re-read live under current
 * authorization, against its stored `dataset`:
 * - its binding must still name the same repository, service and environment,
 *   else `binding_changed` ({@link observationBindingCheck});
 * - once `retentionSplit(ref.interval, …)` says the interval has expired, the
 *   server answers `expired_at_provider` itself, before any read, even for
 *   targets whose by-id read would answer `not_found`;
 * - an error group is re-read with `errorGroup` over `interval`, an occurrence
 *   or trace by id, a series with `series`.
 */
export interface ObservationRef {
  id: string;
  /** The content scope it belongs to; see {@link ObservabilityConnection.spaceId}. */
  spaceId: string;
  issueId: string;
  connectionId: string;
  bindingId: string;
  repoId: string;
  service: string;
  environment: string;
  dataset: string;
  target:
    | { kind: "series"; metric: MetricId }
    | { kind: "error-group"; fingerprint: string }
    | { kind: "occurrence"; fingerprint: string; occurrenceId: string }
    | { kind: "trace"; traceId: string };
  interval: UtcInterval;
  /** The bounded filter the person saw (environment, version…), not a query. */
  filter: Record<string, string>;
  /** When the person looked. */
  observedAt: string;
  evidence: Pick<RuntimeEvidence, "attribution" | "join">;
  actor: string;
  agent: string | null;
  createdAt: string;
}

// ── Results ────────────────────────────────────────────────────────────────

/**
 * Why a read has no answer. Distinct from a successful empty answer and from
 * not found: a repository, binding or connection the caller can't read looks
 * exactly like a missing one and never reaches the reader.
 * - `unsupported`: the dataset or capability isn't there.
 * - `not_configured`: no binding for this repository and environment.
 * - `denied`: the provider refused the credential for a binding the caller can read.
 * - `expired_at_provider`: past the provider's retention.
 * - `not_found`: the provider no longer has the item read by id.
 * - `binding_changed`: a stored reference's binding now names a different
 *   repository, service or environment.
 * - `rate_limited`: retry after `retryAfter`.
 * - `provider_error`: the provider failed.
 * - `cursor_invalid`: a cursor bound to another principal, authorization
 *   version, scope or request ({@link checkCursorBinding}).
 * - `cursor_expired`: a cursor older than {@link OBSERVABILITY_CURSOR_MAX_AGE_MS}.
 */
export const UNAVAILABLE_REASONS = [
  "unsupported",
  "not_configured",
  "denied",
  "expired_at_provider",
  "not_found",
  "binding_changed",
  "rate_limited",
  "provider_error",
  "cursor_invalid",
  "cursor_expired",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** An answer with gaps: `partial` (some of it failed), `truncated` (a bound cut it), `delayed` (ingestion lag). */
export type Incomplete = "partial" | "truncated" | "delayed";

export type ReadResult<T> =
  | { status: "ok"; data: T; incomplete: Incomplete[] }
  | {
      status: "unavailable";
      reason: UnavailableReason;
      /** Safe for the viewer: no credential, raw query or provider body. */
      message: string;
      retryAfter: string | null;
    };

/**
 * A page of a list read. `expired` and `freshThrough` say how much of the
 * window the items speak for: an empty page over a partly expired or
 * unsettled window is not "none". A page (or {@link Detail}) whose `dataset`
 * differs from the request's is a reader bug, and the server refuses it.
 *
 * `cursor` is the reader's own, provider-scoped and opaque. The server API
 * never hands it out bare: it wraps it in an envelope it signs, bound to a
 * {@link CursorBinding}, and refuses a continuation whose binding doesn't
 * match as `cursor_invalid`, or that is too old as `cursor_expired`
 * ({@link checkCursorBinding}).
 */
export interface Page<T> {
  dataset: string;
  stability: Stability;
  items: T[];
  cursor: string | null;
  truncated: boolean;
  /** The start of the window past the provider's retention; null when none is. */
  expired: UtcInterval | null;
  freshThrough: string | null;
}

/** One item read by id, with the dataset it came from. */
export interface Detail<T> {
  dataset: string;
  stability: Stability;
  item: T;
}

/** How long a server cursor envelope stays usable. */
export const OBSERVABILITY_CURSOR_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * What a server-issued cursor envelope is bound to. The server signs the
 * envelope (an HMAC with a server secret; not part of this contract) and
 * checks the binding on every continuation ({@link checkCursorBinding}), after
 * re-checking that the caller can still read `repoId`.
 */
export interface CursorBinding {
  /** The person (or agent) the first page was read for. */
  principalId: string;
  /**
   * Required: the Space's `authorization_version` when the first page was
   * read, so a grant change ends the cursor. That column is CORE-360's
   * `spaces.authorization_version`, introduced by CORE-361. Until it exists
   * the server binds a constant here, and the repository read check it repeats
   * on every continuation is what ends cursors after a grant change.
   */
  authorizationVersion: string;
  repoId: string;
  connectionId: string;
  bindingId: string;
  /** {@link cursorRequestDigest} of the request. */
  request: string;
  /** When the first page was read; older than {@link OBSERVABILITY_CURSOR_MAX_AGE_MS} is expired. */
  issuedAt: string;
}

// ── The read port ──────────────────────────────────────────────────────────

/**
 * Which binding a read is for. The caller has already authorized reading
 * `repoId` in this request; the reader checks the binding belongs to both.
 */
export interface ReadScope {
  repoId: string;
  connectionId: string;
  bindingId: string;
}

export interface ReadContext {
  /** The request's clock, for retention and bounds. */
  now: string;
  signal?: AbortSignal;
}

/** A read of one dataset: the answer names the same dataset, or the server refuses it. */
export interface DatasetRequest extends ReadScope {
  dataset: string;
}

export interface SeriesRequest extends DatasetRequest {
  metric: MetricId;
  interval: UtcInterval;
  bucketMs: number;
  /** For a distribution. */
  quantile?: number;
  /** Only what ran on this provider version. */
  versionId?: string;
}

export interface ListRequest extends DatasetRequest {
  interval: UtcInterval;
  versionId?: string;
  cursor?: string | null;
  /** Up to {@link OBSERVABILITY_PAGE_MAX} ({@link pageLimit}). */
  limit?: number;
}

/**
 * What a provider adapter implements: read-only, bounded, no raw queries from
 * callers, no configuration writes. Optional capabilities answer
 * `unsupported`, never an empty success or a made-up link. Gitmatrix-sourced
 * metrics (`tracker.bug_events`) are not a provider's to answer.
 *
 * Page order is stable within a cursor's life:
 * - `errorGroups`: most occurrences in the window first, then fingerprint.
 * - `occurrences`, `traces`: newest first, then id.
 * - `versions`: newest `deployedAt` first, then version id.
 */
export interface ObservabilityReader {
  readonly provider: ObservabilityProvider;
  capabilities(scope: ReadScope, context: ReadContext): Promise<ReadResult<DatasetCapability[]>>;
  series(request: SeriesRequest, context: ReadContext): Promise<ReadResult<Series>>;
  errorGroups(request: ListRequest, context: ReadContext): Promise<ReadResult<Page<ErrorGroup>>>;
  /** One error group over a window (`count` covers it); `not_found` when the provider has none. */
  errorGroup(
    request: DatasetRequest & { fingerprint: string; interval: UtcInterval },
    context: ReadContext,
  ): Promise<ReadResult<Detail<ErrorGroup>>>;
  occurrences(
    request: ListRequest & { fingerprint?: string },
    context: ReadContext,
  ): Promise<ReadResult<Page<OccurrenceRef>>>;
  traces(
    request: ListRequest & { fingerprint?: string },
    context: ReadContext,
  ): Promise<ReadResult<Page<TraceSummary>>>;
  versions(
    request: ListRequest,
    context: ReadContext,
  ): Promise<ReadResult<Page<ProviderDeployment>>>;
  /** One occurrence by id; `not_found` once the provider no longer has it. */
  occurrence(
    request: DatasetRequest & { occurrenceId: string },
    context: ReadContext,
  ): Promise<ReadResult<Detail<OccurrenceRef>>>;
  /** One trace with its spans; `not_found` once the provider no longer has it. */
  trace(
    request: DatasetRequest & { traceId: string },
    context: ReadContext,
  ): Promise<ReadResult<Detail<TraceDetail>>>;
}

// ── Validation ─────────────────────────────────────────────────────────────

export class ObservabilityError extends Error {}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-f]{32,}$/;

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (!values.includes(value as T))
    throw new ObservabilityError(`Invalid ${field} "${String(value)}": use ${values.join(", ")}.`);
  return value as T;
}

/**
 * Milliseconds for a strict UTC ISO instant: `Z` only, no offsets or local
 * times, a real calendar date, and not before the epoch buckets align to.
 */
export function parseUtcInstant(value: unknown, field = "time"): number {
  if (typeof value !== "string")
    throw new ObservabilityError(`Invalid ${field}: expected a UTC ISO time.`);
  const match = INSTANT.exec(value);
  const ms = match ? Date.parse(value) : Number.NaN;
  const fraction = (match?.[7] ?? "").padEnd(3, "0");
  // Date.parse rolls 2026-02-30 over to March: compare the round trip.
  if (
    Number.isNaN(ms) ||
    ms < 0 ||
    new Date(ms).toISOString() !== `${value.slice(0, 19)}.${fraction}Z`
  )
    throw new ObservabilityError(
      `Invalid ${field} "${value}": use a UTC ISO time like 2026-10-12T20:00:00Z.`,
    );
  return ms;
}

/** The canonical instant for milliseconds. */
export function utcInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/** A strict UTC instant in canonical form (`.000Z`). */
function canonical(value: unknown, field: string): string {
  return utcInstant(parseUtcInstant(value, field));
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new ObservabilityError(`Invalid ${field}: expected a positive whole number.`);
  return value as number;
}

function checkLimits(limits: IntervalLimits): void {
  positiveInteger(limits.maxIntervalMs, "maxIntervalMs");
  positiveInteger(limits.minBucketMs, "minBucketMs");
  positiveInteger(limits.maxBuckets, "maxBuckets");
}

/** Strict start < end; the canonical interval and its milliseconds. */
function interval(
  value: unknown,
  field = "interval",
): { from: number; to: number; interval: UtcInterval } {
  if (!value || typeof value !== "object")
    throw new ObservabilityError(`Invalid ${field}: expected {start, end}.`);
  const { start, end } = value as Record<string, unknown>;
  const from = parseUtcInstant(start, `${field} start`);
  const to = parseUtcInstant(end, `${field} end`);
  if (from >= to) throw new ObservabilityError(`Invalid ${field}: start must be before end.`);
  return { from, to, interval: { start: utcInstant(from), end: utcInstant(to) } };
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\s\p{Cc}]/u.test(value))
    throw new ObservabilityError(`Invalid ${field}: expected an id.`);
  return value;
}

/**
 * A canonical interval within the provider's bounds: strict UTC instants,
 * start before end, no longer than `maxIntervalMs`, ending no later than
 * {@link OBSERVABILITY_MAX_FUTURE_MS} past now. Retention is not checked here:
 * an interval past it is valid and reads as `expired_at_provider`
 * ({@link retentionSplit}).
 */
export function validateInterval(value: unknown, limits: IntervalLimits, now: string): UtcInterval {
  checkLimits(limits);
  const { from, to, interval: canonicalInterval } = interval(value);
  if (to - from > limits.maxIntervalMs)
    throw new ObservabilityError(`Invalid interval: longer than ${limits.maxIntervalMs} ms.`);
  if (to > parseUtcInstant(now, "now") + OBSERVABILITY_MAX_FUTURE_MS)
    throw new ObservabilityError("Invalid interval: ends too far in the future.");
  return canonicalInterval;
}

/**
 * The buckets covering exactly `interval`: no longer than `maxIntervalMs`,
 * the width a multiple of the provider's minimum, both ends aligned to it from
 * the UTC epoch, and no more buckets than the provider and
 * {@link OBSERVABILITY_MAX_BUCKETS} allow.
 */
export function bucketsFor(value: UtcInterval, bucketMs: number, limits: IntervalLimits): Buckets {
  checkLimits(limits);
  positiveInteger(bucketMs, "bucketMs");
  if (bucketMs % limits.minBucketMs)
    throw new ObservabilityError(`Invalid bucketMs: must be a multiple of ${limits.minBucketMs}.`);
  const { from, to } = interval(value);
  if (to - from > limits.maxIntervalMs)
    throw new ObservabilityError(`Invalid interval: longer than ${limits.maxIntervalMs} ms.`);
  if (from % bucketMs || to % bucketMs)
    throw new ObservabilityError(
      "Invalid interval: start and end must align to the bucket width (from the UTC epoch).",
    );
  const count = (to - from) / bucketMs;
  const max = Math.min(limits.maxBuckets, OBSERVABILITY_MAX_BUCKETS);
  if (count > max)
    throw new ObservabilityError(`Invalid bucketMs: ${count} buckets is more than ${max}.`);
  return { start: utcInstant(from), bucketMs, count };
}

/** A page size: {@link OBSERVABILITY_PAGE_DEFAULT} when unset, else 1 to {@link OBSERVABILITY_PAGE_MAX}. */
export function pageLimit(value: unknown): number {
  if (value === undefined || value === null) return OBSERVABILITY_PAGE_DEFAULT;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > OBSERVABILITY_PAGE_MAX
  )
    throw new ObservabilityError(`Invalid limit: use 1 to ${OBSERVABILITY_PAGE_MAX}.`);
  return value as number;
}

/**
 * The part of an interval past the provider's retention (expired, never zero)
 * and the part still live, canonical. Unknown retention claims no expiry.
 */
export function retentionSplit(
  value: UtcInterval,
  retentionMs: number | null,
  now: string,
): { expired: UtcInterval | null; live: UtcInterval | null } {
  const { from, to, interval: whole } = interval(value);
  if (retentionMs !== null) positiveInteger(retentionMs, "retentionMs");
  const nowMs = parseUtcInstant(now, "now");
  if (retentionMs === null) return { expired: null, live: whole };
  const horizon = nowMs - retentionMs;
  if (horizon <= from) return { expired: null, live: whole };
  if (horizon >= to) return { expired: whole, live: null };
  return {
    expired: { start: whole.start, end: utcInstant(horizon) },
    live: { start: utcInstant(horizon), end: whole.end },
  };
}

/**
 * A dataset capability that says what it means: a known stability, known and
 * unrepeated reads and metrics, only provider metrics, metrics only with
 * `series`, positive retention and limits.
 */
export function validateCapability(capability: DatasetCapability): DatasetCapability {
  id(capability.dataset, "dataset");
  oneOf(STABILITIES, capability.stability, "stability");
  for (const read of capability.reads) oneOf(READ_KINDS, read, "read");
  if (new Set(capability.reads).size !== capability.reads.length)
    throw new ObservabilityError("Invalid capability: a read is listed twice.");
  for (const metric of capability.metrics) {
    oneOf(METRIC_IDS, metric, "metric");
    if (METRICS[metric].source !== "provider")
      throw new ObservabilityError(`Invalid capability: ${metric} isn't a provider's to answer.`);
  }
  if (new Set(capability.metrics).size !== capability.metrics.length)
    throw new ObservabilityError("Invalid capability: a metric is listed twice.");
  if (capability.metrics.length > 0 !== capability.reads.includes("series"))
    throw new ObservabilityError(
      "Invalid capability: metrics come with the series read, and only with it.",
    );
  if (capability.retentionMs !== null) positiveInteger(capability.retentionMs, "retentionMs");
  checkLimits(capability.limits);
  return capability;
}

/**
 * A commit with its repository and source. A bare SHA, an abbreviation or an
 * environment label is not an identity.
 */
export function normalizeCommitRef(value: unknown): CommitRef {
  if (typeof value === "string")
    throw new ObservabilityError("Invalid commit: a bare SHA needs its repoId and sourceId.");
  if (!value || typeof value !== "object")
    throw new ObservabilityError("Invalid commit: expected {repoId, sourceId, commit}.");
  const ref = value as Record<string, unknown>;
  const repoId = id(ref.repoId, "commit repoId");
  const sourceId = id(ref.sourceId, "commit sourceId");
  if (typeof ref.commit !== "string" || !COMMIT.test(ref.commit))
    throw new ObservabilityError("Invalid commit: use the full 40-character lowercase object id.");
  return { repoId, sourceId, commit: ref.commit };
}

/** W3C trace context ids: 32 and 16 lowercase hex digits, not all zero. */
export function normalizeTraceRef(value: TraceRef): TraceRef {
  if (!TRACE_ID.test(value.traceId) || /^0+$/.test(value.traceId))
    throw new ObservabilityError(
      "Invalid trace id: expected 32 lowercase hex digits, not all zero.",
    );
  if (value.spanId !== null && (!SPAN_ID.test(value.spanId) || /^0+$/.test(value.spanId)))
    throw new ObservabilityError(
      "Invalid span id: expected 16 lowercase hex digits, not all zero.",
    );
  if (value.rayId !== null) id(value.rayId, "Ray id");
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ObservabilityError(`Invalid ${field}: expected an object.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ObservabilityError(`Invalid ${field}: expected a list.`);
  return value;
}

/** A finite number within [min, max]; strings, null and NaN are refused. */
function within(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new ObservabilityError(`Invalid ${field}: a number from ${min} to ${max}.`);
  return value;
}

function versionRef(value: unknown): ProviderVersionRef {
  const version = object(value, "version");
  const deploymentId = version.deploymentId ?? null;
  return {
    connectionId: id(version.connectionId, "version connectionId"),
    bindingId: id(version.bindingId, "version bindingId"),
    versionId: id(version.versionId, "versionId"),
    deploymentId: deploymentId === null ? null : id(deploymentId, "provider deploymentId"),
  };
}

function artifactRef(value: unknown): ArtifactRef {
  const artifact = object(value, "artifact");
  const digest = artifact.digest ?? null;
  if (digest !== null && (typeof digest !== "string" || !DIGEST.test(digest)))
    throw new ObservabilityError(
      `Invalid artifact digest ${JSON.stringify(digest)}: use <algorithm>:<hex>.`,
    );
  return {
    packageId: id(artifact.packageId, "artifact packageId"),
    version: id(artifact.version, "artifact version"),
    digest,
  };
}

/**
 * Evidence backed by what it claims, never more definite than it is, with
 * canonical times. Counted after candidates the caller can't read are omitted:
 * - `explicit`: exactly one candidate, with a provider version or an artifact digest;
 * - `temporal`: exactly one candidate, with a deployment or exposure time;
 * - `ambiguous`: one or more candidates;
 * - none: an error; the server omits such evidence entirely;
 * - a `direct` join names every candidate's deployment record;
 * - no candidate is listed twice (the same commit as two artifacts or versions
 *   is two candidates); weights are finite shares from 0 to 1;
 * - a missing `version`, `artifact` or `deploymentId` reads as null.
 */
export function validateEvidence(evidence: RuntimeEvidence): RuntimeEvidence {
  object(evidence, "evidence");
  const attribution = oneOf(ATTRIBUTIONS, evidence.attribution, "attribution");
  const join = oneOf(JOINS, evidence.join, "join");
  const candidates = list(evidence.candidates, "evidence candidates").map(
    (value): EvidenceCandidate => {
      const candidate = object(value, "evidence candidate");
      const times = list(candidate.times, "candidate times").map((entry) => {
        const time = object(entry, "candidate time");
        const kind = oneOf(TIMESTAMP_KINDS, time.kind, "timestamp kind");
        return { kind, at: canonical(time.at, `${kind} time`) };
      });
      const version = candidate.version ?? null;
      const artifact = candidate.artifact ?? null;
      const deploymentId = candidate.deploymentId ?? null;
      return {
        commit: normalizeCommitRef(candidate.commit),
        version: version === null ? null : versionRef(version),
        artifact: artifact === null ? null : artifactRef(artifact),
        deploymentId: deploymentId === null ? null : id(deploymentId, "deploymentId"),
        times,
        ...(candidate.weight === undefined
          ? {}
          : { weight: within(candidate.weight, 0, 1, "evidence weight") }),
      };
    },
  );
  if (!candidates.length)
    throw new ObservabilityError("Invalid evidence: no candidates; omit the evidence instead.");
  const keys = new Set(
    candidates.map((c) => JSON.stringify([c.commit, c.version, c.artifact, c.deploymentId])),
  );
  if (keys.size !== candidates.length)
    throw new ObservabilityError("Invalid evidence: a candidate is listed twice.");
  if (attribution !== "ambiguous" && candidates.length !== 1)
    throw new ObservabilityError(
      `Invalid evidence: ${attribution} attribution has exactly one candidate.`,
    );
  if (attribution === "explicit" && !candidates[0]!.version && !candidates[0]!.artifact?.digest)
    throw new ObservabilityError(
      "Invalid evidence: explicit attribution needs a provider version or an artifact digest.",
    );
  if (
    attribution === "temporal" &&
    !candidates[0]!.times.some((t) => t.kind === "deployment" || t.kind === "exposure")
  )
    throw new ObservabilityError(
      "Invalid evidence: a temporal candidate needs a deployment or exposure time.",
    );
  if (join === "direct" && candidates.some((c) => c.deploymentId === null))
    throw new ObservabilityError("Invalid evidence: a direct join needs each deployment record.");
  return { attribution, join, candidates };
}

/**
 * A provider deployment in canonical form: exposure starts no earlier than
 * the deployment and ends no earlier than it starts, an end needs a start, a
 * canary's share is a finite 0–100, and it doesn't replace itself. Missing
 * optional fields read as null. Readers pass the connection's link prefixes so
 * the link is checked with {@link safeProviderLink}; without them only its
 * shape is checked.
 */
export function validateProviderDeployment(
  deployment: ProviderDeployment,
  prefixes?: readonly string[],
): ProviderDeployment {
  object(deployment, "deployment");
  const version = versionRef(deployment.version);
  const deployed = parseUtcInstant(deployment.deployedAt, "deployedAt");
  const exposedFrom = deployment.exposedFrom ?? null;
  const exposedUntil = deployment.exposedUntil ?? null;
  const from = exposedFrom === null ? null : parseUtcInstant(exposedFrom, "exposedFrom");
  const until = exposedUntil === null ? null : parseUtcInstant(exposedUntil, "exposedUntil");
  if (from !== null && from < deployed)
    throw new ObservabilityError("Invalid deployment: exposure can't start before the deployment.");
  if (until !== null && (from === null || until < from))
    throw new ObservabilityError("Invalid deployment: exposure must start before it ends.");
  const percentage = deployment.percentage ?? null;
  if (percentage !== null) within(percentage, 0, 100, "deployment percentage");
  const replaces = deployment.replaces;
  if (replaces !== undefined && replaces !== null) {
    id(replaces, "replaces");
    if (replaces === version.versionId)
      throw new ObservabilityError("Invalid deployment: a version can't replace itself.");
  }
  const rawLink = deployment.link ?? null;
  let link: ProviderLink | null = null;
  if (rawLink !== null) {
    const value = object(rawLink, "deployment link");
    const kind = oneOf(["detail", "landing"] as const, value.kind, "link kind");
    if (typeof value.url !== "string")
      throw new ObservabilityError("Invalid link: expected a URL.");
    link = { url: prefixes ? safeProviderLink(value.url, prefixes) : value.url, kind };
  }
  return {
    ...deployment,
    version,
    deployedAt: utcInstant(deployed),
    exposedFrom: from === null ? null : utcInstant(from),
    exposedUntil: until === null ? null : utcInstant(until),
    percentage,
    link,
    ...(replaces === undefined ? {} : { replaces }),
  };
}

function denseNumbers(
  values: unknown,
  count: number,
  field: string,
  whole: boolean,
): (number | null)[] {
  const numbers = list(values, `series ${field}`) as (number | null)[];
  if (numbers.length !== count)
    throw new ObservabilityError(
      `Invalid series: ${numbers.length} ${field} for ${count} buckets.`,
    );
  for (let i = 0; i < count; i++) {
    if (!(i in numbers))
      throw new ObservabilityError(`Invalid series: ${field} has a hole at ${i}.`);
    const value = numbers[i];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ObservabilityError(
        `Invalid series: ${field} ${i} must be a finite, non-negative number.`,
      );
    if (value !== null && whole && !Number.isInteger(value))
      throw new ObservabilityError(`Invalid series: exact ${field} ${i} must be a whole number.`);
  }
  return numbers;
}

/**
 * Checks a series against its own claims and returns it canonical:
 * - a known metric, sampling and stability; one dense point per bucket, aligned buckets;
 * - coverage and expiry are sorted, disjoint and inside the buckets; touching
 *   coverage parts are merged;
 * - a bucket nothing covers (or expired) has no value; a zero needs full coverage;
 * - `exact` counts and denominators are whole numbers; values are finite and not negative;
 * - a rate is 0–1 and has a value only where its denominator is positive, none
 *   at all without one; denominators are dense, finite and not negative;
 * - a distribution names its quantile, and only a distribution does;
 * - `freshThrough` is no later than {@link OBSERVABILITY_MAX_FUTURE_MS} past now.
 */
export function validateSeries(series: Series, now: string): Series {
  object(series, "series");
  const definition = METRICS[series.metric];
  if (!definition)
    throw new ObservabilityError(`Invalid series: unknown metric "${series.metric}".`);
  id(series.bindingId, "bindingId");
  id(series.dataset, "dataset");
  oneOf(STABILITIES, series.stability, "stability");
  oneOf(SAMPLINGS, series.sampling, "sampling");
  const exact = series.sampling === "exact";
  const buckets = object(series.buckets, "buckets");
  const bucketMs = positiveInteger(buckets.bucketMs, "bucketMs");
  const count = positiveInteger(buckets.count, "bucket count");
  if (count > OBSERVABILITY_MAX_BUCKETS)
    throw new ObservabilityError(`Invalid series: more than ${OBSERVABILITY_MAX_BUCKETS} buckets.`);
  const start = parseUtcInstant(buckets.start, "bucket start");
  if (start % bucketMs)
    throw new ObservabilityError("Invalid series: buckets must align to their width.");
  const end = start + count * bucketMs;
  const points = denseNumbers(series.points, count, "points", exact && definition.kind === "count");
  let freshThrough: string | null = null;
  if (series.freshThrough !== null) {
    const fresh = parseUtcInstant(series.freshThrough, "freshThrough");
    if (fresh > parseUtcInstant(now, "now") + OBSERVABILITY_MAX_FUTURE_MS)
      throw new ObservabilityError("Invalid series: freshThrough is in the future.");
    freshThrough = utcInstant(fresh);
  }

  const covered: [number, number][] = [];
  let last = start;
  for (const part of list(series.coverage, "coverage")) {
    const { from, to } = interval(part, "coverage");
    if (from < last || to > end)
      throw new ObservabilityError(
        "Invalid series: coverage must be sorted, disjoint and inside the buckets.",
      );
    const previous = covered[covered.length - 1];
    if (previous && previous[1] === from) previous[1] = to;
    else covered.push([from, to]);
    last = to;
  }
  let expired: UtcInterval | null = null;
  let expiredUntil = start;
  if (series.expired !== null) {
    const { from, to } = interval(series.expired, "expiry");
    if (from !== start || to > end)
      throw new ObservabilityError("Invalid series: expiry must start with the buckets.");
    if (covered.length && covered[0]![0] < to)
      throw new ObservabilityError("Invalid series: expired time can't be covered.");
    expired = { start: utcInstant(from), end: utcInstant(to) };
    expiredUntil = to;
  }

  if (definition.kind === "distribution") {
    if (series.quantile === null || !(series.quantile > 0 && series.quantile <= 1))
      throw new ObservabilityError("Invalid series: a distribution needs a quantile in (0, 1].");
  } else if (series.quantile !== null) {
    throw new ObservabilityError("Invalid series: only a distribution has a quantile.");
  }
  let denominators: (number | null)[] | null = null;
  if (definition.kind === "rate") {
    if (series.denominator !== null)
      denominators = denseNumbers(series.denominator, count, "denominators", exact);
  } else if (series.denominator !== null) {
    throw new ObservabilityError("Invalid series: only a rate has a denominator.");
  }

  points.forEach((point, i) => {
    if (point === null) return;
    const from = start + i * bucketMs;
    const to = from + bucketMs;
    if (from < expiredUntil)
      throw new ObservabilityError(
        `Invalid series: point ${i} is past retention; it has no value.`,
      );
    const overlap = covered.some(([a, b]) => a < to && b > from);
    if (!overlap)
      throw new ObservabilityError(
        `Invalid series: point ${i} is outside coverage; it has no value.`,
      );
    if (point === 0 && !covered.some(([a, b]) => a <= from && b >= to))
      throw new ObservabilityError(`Invalid series: point ${i} is zero without full coverage.`);
    if (definition.kind === "rate") {
      const denominator = denominators?.[i] ?? null;
      if (denominator === null || !(denominator > 0))
        throw new ObservabilityError(
          `Invalid series: rate ${i} has no denominator; it has no value.`,
        );
      if (point > 1) throw new ObservabilityError(`Invalid series: rate ${i} is more than 1.`);
    }
  });
  return {
    ...series,
    buckets: { start: utcInstant(start), bucketMs, count },
    coverage: covered.map(([from, to]) => ({ start: utcInstant(from), end: utcInstant(to) })),
    expired,
    freshThrough,
  };
}

/**
 * Rate points from counts: a value only where both counts are known and the
 * denominator is positive. A missing denominator series gives no rate at all,
 * never a zero rate.
 */
export function ratePoints(
  numerator: readonly (number | null)[],
  denominator: readonly (number | null)[] | null,
): (number | null)[] {
  if (!denominator) return numerator.map(() => null);
  if (denominator.length !== numerator.length)
    throw new ObservabilityError("Invalid rate: numerator and denominator differ in length.");
  return numerator.map((value, i) => {
    const by = denominator[i] ?? null;
    return value === null || by === null || !(by > 0) ? null : value / by;
  });
}

const SCOPE_KEYS = new Set(["repoId", "connectionId", "bindingId", "cursor"]);

/**
 * The canonical text of a paged read's request, for {@link CursorBinding.request}:
 * the read kind and, in sorted key order, the dataset, the interval as
 * canonical instants, every filter (`metric`, `bucketMs`, `quantile`,
 * `versionId`, `fingerprint`) and, for lists, the page limit with its default
 * applied. Scope and cursor are bound separately and left out; an unknown key
 * is refused rather than silently ignored. Two requests get the same text
 * exactly when they ask for the same thing.
 */
export function cursorRequestDigest(kind: ReadKind, request: Record<string, unknown>): string {
  oneOf(READ_KINDS, kind, "read kind");
  object(request, "request");
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (SCOPE_KEYS.has(key) || value === undefined) continue;
    switch (key) {
      case "dataset":
      case "versionId":
      case "fingerprint":
        fields[key] = id(value, key);
        break;
      case "interval":
        fields[key] = interval(value).interval;
        break;
      case "metric":
        fields[key] = oneOf(METRIC_IDS, value, "metric");
        break;
      case "bucketMs":
        fields[key] = positiveInteger(value, "bucketMs");
        break;
      case "quantile":
        fields[key] = within(value, 0, 1, "quantile");
        break;
      case "limit":
        if (kind === "series")
          throw new ObservabilityError("Invalid request: a series has no limit.");
        fields[key] = pageLimit(value);
        break;
      default:
        throw new ObservabilityError(`Invalid request: unknown field "${key}".`);
    }
  }
  if (!("dataset" in fields) || !("interval" in fields))
    throw new ObservabilityError("Invalid request: a dataset and an interval are required.");
  if (kind !== "series") fields.limit = pageLimit(request.limit);
  const sorted = Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
  return JSON.stringify([kind, sorted]);
}

const CURSOR_FIELDS = [
  "principalId",
  "authorizationVersion",
  "repoId",
  "connectionId",
  "bindingId",
  "request",
] as const;
/** Clock skew tolerated between the server that issued a cursor and the one checking it. */
const CURSOR_SKEW_MS = 60 * 1000;

/**
 * Whether a server cursor envelope's binding matches the continuing request:
 * null when it does; `cursor_invalid` when any bound field differs, the
 * binding has other or inherited fields, or `issuedAt` is malformed or in the
 * future; `cursor_expired` when it is older than
 * {@link OBSERVABILITY_CURSOR_MAX_AGE_MS}. Signature checks are the server's,
 * before this.
 */
export function checkCursorBinding(
  expected: Omit<CursorBinding, "issuedAt">,
  actual: unknown,
  now: string,
): "cursor_invalid" | "cursor_expired" | null {
  for (const field of CURSOR_FIELDS)
    if (field === "request") {
      if (
        typeof expected.request !== "string" ||
        !expected.request ||
        expected.request.length > 4096
      )
        throw new ObservabilityError("Invalid expected cursor request.");
    } else id(expected[field], `expected cursor ${field}`);
  const nowMs = parseUtcInstant(now, "now");
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return "cursor_invalid";
  const keys = Object.keys(actual).sort();
  const wanted = [...CURSOR_FIELDS, "issuedAt"].sort();
  if (keys.length !== wanted.length || keys.some((key, i) => key !== wanted[i]))
    return "cursor_invalid";
  const binding = actual as Record<string, unknown>;
  if (!CURSOR_FIELDS.every((field) => binding[field] === expected[field])) return "cursor_invalid";
  let issued: number;
  try {
    issued = parseUtcInstant(binding.issuedAt, "issuedAt");
  } catch {
    return "cursor_invalid";
  }
  if (issued > nowMs + CURSOR_SKEW_MS) return "cursor_invalid";
  return nowMs - issued > OBSERVABILITY_CURSOR_MAX_AGE_MS ? "cursor_expired" : null;
}

/**
 * Whether a stored observation still means what the person linked: null when
 * its binding still names the same connection, repository, service and
 * environment; `not_configured` when the binding is gone; else `binding_changed`.
 */
export function observationBindingCheck(
  ref: Pick<ObservationRef, "bindingId" | "connectionId" | "repoId" | "service" | "environment">,
  binding: ServiceBinding | null,
): "binding_changed" | "not_configured" | null {
  if (!binding) return "not_configured";
  if (binding.id !== ref.bindingId)
    throw new ObservabilityError("Invalid check: compare an observation with its own binding.");
  return binding.connectionId === ref.connectionId &&
    binding.repoId === ref.repoId &&
    binding.service === ref.service &&
    binding.environment === ref.environment
    ? null
    : "binding_changed";
}

const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * A connection's declared link prefixes, each an https URL to an account path
 * in normalized form: a host, a path below the root, no userinfo, query or
 * fragment, no encoded `/` or `\`, and equal to its own normalized URL
 * (lowercase punycode host, no default port, no dot segments). A bare origin is
 * refused: links are tied to the connection's account.
 */
export function validateLinkPrefixes(prefixes: readonly string[]): string[] {
  return list(prefixes, "link prefixes").map((prefix) => {
    let parsed: URL | null = null;
    try {
      parsed = typeof prefix === "string" ? new URL(prefix) : null;
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      parsed.protocol !== "https:" ||
      // Userinfo (even empty), a query or a fragment; whitespace or control characters.
      /[@?#\s\p{Cc}]/u.test(prefix as string) ||
      ENCODED_SEPARATOR.test(prefix as string) ||
      parsed.pathname === "/" ||
      parsed.href !== prefix
    )
      throw new ObservabilityError(
        `Invalid link prefix ${JSON.stringify(prefix)}: use a normalized https URL to an account path.`,
      );
    return prefix as string;
  });
}

/**
 * A provider link, only if safe: an https URL with no userinfo (not even an
 * empty `@`), no whitespace or control characters and no encoded `/` or `\`
 * in its path (`%2F`, `%5C`: the prefix check compares text and doesn't decode
 * them), that starts with one of the connection's declared prefixes
 * ({@link validateLinkPrefixes}) on a path-segment boundary. Returns the
 * normalized URL. Keeping credentials out of query strings is the reader's
 * responsibility.
 */
export function safeProviderLink(url: string, prefixes: readonly string[]): string {
  const declared = validateLinkPrefixes(prefixes);
  if (typeof url !== "string" || /[\s\p{Cc}]/u.test(url))
    throw new ObservabilityError("Invalid provider link: whitespace or control characters.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ObservabilityError("Invalid provider link: not an absolute URL.");
  }
  if (parsed.protocol !== "https:")
    throw new ObservabilityError("Invalid provider link: https only.");
  const authority = /^[a-z][a-z0-9+.-]*:[/\\]*([^/\\?#]*)/i.exec(url)?.[1] ?? "";
  if (authority.includes("@") || parsed.username || parsed.password)
    throw new ObservabilityError("Invalid provider link: credentials in a URL are refused.");
  if (ENCODED_SEPARATOR.test(parsed.pathname))
    throw new ObservabilityError("Invalid provider link: an encoded / or \\ in its path.");
  const href = parsed.href;
  const allowed = declared.some((prefix) => {
    if (!href.startsWith(prefix)) return false;
    const next = href.charAt(prefix.length);
    return prefix.endsWith("/") || next === "" || next === "/" || next === "?" || next === "#";
  });
  if (!allowed)
    throw new ObservabilityError(
      `Invalid provider link: ${parsed.origin} isn't under a declared prefix.`,
    );
  return href;
}
