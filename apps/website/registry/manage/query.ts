// The console: a package's publish history, filtered by the query language
// in shared/packages.ts, with facet counts and a publish-rate histogram.
// Built for packages that publish on every commit: tens of thousands of rows,
// read a window at a time.

import { sql, type ExpressionBuilder, type Expression, type SqlBool } from "kysely";

import {
  parseQuery,
  parseWhen,
  type Facet,
  type Histogram,
  type ParsedQuery,
  type PublishPage,
  type PublishRow,
  type PublishStatus,
  type QueryFilter,
  type QueryKey,
} from "../../shared/packages.ts";
import type { Database, DB } from "../core/db.ts";
import { RegistryError } from "../core/errors.ts";

type EB = ExpressionBuilder<Database, "publishes">;

const STATUSES: PublishStatus[] = ["active", "yanked", "deprecated", "deleted"];
export const MAX_WINDOW = 500;

/** Looks up gitmatrix repositories and accounts the query names. */
export interface Directory {
  /** Repository ids for `web` (in the package owner's namespace) or `owner/web`. */
  repoIds(value: string): Promise<string[]>;
  /** `owner/name` for repository ids. */
  repoNames(ids: string[]): Promise<Map<string, string>>;
}

export interface Scope {
  packageId: string;
  /** OCI: versions are tags, so `tag:` matches them directly. */
  tagsAreVersions: boolean;
}

function like(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%");
}

/** A compiled filter: a predicate builder, resolved ahead of time where it needs lookups. */
type Predicate = (eb: EB) => Expression<SqlBool>;

async function compileFilter(
  filter: QueryFilter,
  scope: Scope,
  directory: Directory,
  now: number,
): Promise<Predicate> {
  const v = filter.value;
  switch (filter.key) {
    case "source": {
      if (v === "none") return (eb) => eb("git_repo_id", "is", null);
      const ids = await directory.repoIds(v);
      return (eb) => (ids.length ? eb("git_repo_id", "in", ids) : eb.val(false));
    }
    case "branch":
      if (v === "none") return (eb) => eb("ref", "is", null);
      return v.includes("*")
        ? (eb) => sql<SqlBool>`${eb.ref("ref")} like ${like(v)} escape '\\'`
        : (eb) => eb("ref", "=", v);
    case "status": {
      const status = v.toLowerCase() as PublishStatus;
      if (!STATUSES.includes(status)) {
        throw RegistryError.badRequest(`status: is one of ${STATUSES.join(", ")}.`);
      }
      return (eb) => eb("status", "=", status);
    }
    case "since":
    case "until": {
      const when = parseWhen(v, now);
      if (!when) throw RegistryError.badRequest(`${filter.key}: takes 30m, 12h, 7d, 2w or a date.`);
      const iso = when.toISOString();
      return (eb) => eb("at", filter.key === "since" ? ">=" : "<", iso);
    }
    case "commit":
      if (!/^[0-9a-f]{4,64}$/i.test(v))
        throw RegistryError.badRequest("commit: takes a hash prefix.");
      return (eb) => sql<SqlBool>`${eb.ref("commit_oid")} like ${`${v.toLowerCase()}%`}`;
    case "run": {
      const n = Number(v.replace(/^#/, ""));
      if (!Number.isInteger(n)) throw RegistryError.badRequest("run: takes a run number.");
      return (eb) => eb("run_number", "=", n);
    }
    case "by":
      return (eb) =>
        eb.or([eb("actor_label", "=", v), eb("actor_label", "like", `${like(v)} · %`)]);
    case "tag":
      return (eb) => {
        const tagged = eb.exists(
          eb
            .selectFrom("dist_tags as t")
            .select("t.tag")
            .whereRef("t.package_id", "=", "publishes.package_id")
            .whereRef("t.version", "=", "publishes.version")
            .where("t.tag", "=", v),
        );
        return scope.tagsAreVersions ? eb.or([tagged, eb("version", "=", v)]) : tagged;
      };
  }
}

interface Compiled {
  /** Per key, the predicates (ORed within a key, negations ANDed). */
  byKey: Map<QueryKey, { positive: Predicate[]; negative: Predicate[] }>;
  text: string[];
  excluded: string[];
  raw: QueryFilter[];
}

async function compile(
  parsed: ParsedQuery,
  scope: Scope,
  directory: Directory,
  now: number,
): Promise<Compiled> {
  const byKey: Compiled["byKey"] = new Map();
  for (const filter of parsed.filters) {
    const predicate = await compileFilter(filter, scope, directory, now);
    const entry = byKey.get(filter.key) ?? { positive: [], negative: [] };
    (filter.negated ? entry.negative : entry.positive).push(predicate);
    byKey.set(filter.key, entry);
  }
  if (parsed.unknown.length) {
    throw RegistryError.badRequest(
      `Unknown filter ${parsed.unknown[0]}. Filters: source, branch, status, since, until, commit, run, by, tag.`,
    );
  }
  return { byKey, text: parsed.text, excluded: parsed.excluded, raw: parsed.filters };
}

/** Everything the query says, optionally leaving one key out (for its facet). */
function whereOf(scope: Scope, compiled: Compiled, except?: QueryKey) {
  return (eb: EB): Expression<SqlBool> => {
    const all: Expression<SqlBool>[] = [eb("package_id", "=", scope.packageId)];
    for (const [key, { positive, negative }] of compiled.byKey) {
      if (key === except) continue;
      if (positive.length) all.push(eb.or(positive.map((p) => p(eb))));
      for (const p of negative) all.push(eb.not(p(eb)));
    }
    for (const word of compiled.text) {
      all.push(sql<SqlBool>`${eb.ref("version")} like ${`%${like(word)}%`} escape '\\'`);
    }
    for (const word of compiled.excluded) {
      all.push(sql<SqlBool>`${eb.ref("version")} not like ${`%${like(word)}%`} escape '\\'`);
    }
    return eb.and(all);
  };
}

/** Bucket widths the histogram picks from: at most ~120 bars. */
const BUCKETS = [
  5 * 60_000,
  15 * 60_000,
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  7 * 86_400_000,
  30 * 86_400_000,
];

export interface QueryOptions {
  query: string;
  offset: number;
  limit: number;
  now?: number;
}

export async function queryPublishes(
  db: DB,
  scope: Scope,
  directory: Directory,
  options: QueryOptions,
): Promise<PublishPage> {
  const now = options.now ?? Date.now();
  const compiled = await compile(parseQuery(options.query), scope, directory, now);
  const where = whereOf(scope, compiled);
  const limit = Math.min(Math.max(options.limit, 1), MAX_WINDOW);
  const offset = Math.max(options.offset, 0);

  const [count, rows] = await Promise.all([
    db
      .selectFrom("publishes")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where(where)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("publishes")
      .selectAll()
      .where(where)
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset)
      .execute(),
  ]);

  const tags = await tagsByVersion(db, scope.packageId);
  const names = await directory.repoNames([
    ...new Set(rows.map((r) => r.git_repo_id).filter((id): id is string => !!id)),
  ]);
  const page: PublishPage = {
    query: options.query,
    total: Number(count.n),
    offset,
    rows: rows.map((row): PublishRow => ({
      id: row.id,
      version: row.version,
      status: row.status as PublishStatus,
      digest: row.digest,
      size: row.size,
      at: row.at,
      repo: row.git_repo_id ? (names.get(row.git_repo_id) ?? null) : null,
      ref: row.ref,
      commit: row.commit_oid,
      runNumber: row.run_number,
      actor: row.actor_label,
      via: row.via,
      tags: tags.get(row.version) ?? [],
    })),
  };
  if (offset === 0) {
    const [facets, histogram] = await Promise.all([
      facetsOf(db, scope, compiled, directory),
      histogramOf(db, scope, compiled, now),
    ]);
    page.facets = facets;
    page.histogram = histogram;
  }
  return page;
}

/** Versions a query matches (newest first), for bulk actions. */
export async function matchingVersions(
  db: DB,
  scope: Scope,
  directory: Directory,
  query: string,
  limit: number,
): Promise<{ versions: string[]; total: number }> {
  const compiled = await compile(parseQuery(query), scope, directory, Date.now());
  const where = whereOf(scope, compiled);
  const live = (eb: EB) => eb.and([where(eb), eb("status", "!=", "deleted")]);
  const [rows, total] = await Promise.all([
    db
      .selectFrom("publishes")
      .select("version")
      .select((eb) => eb.fn.max("at").as("last"))
      .where(live)
      .groupBy("version")
      .orderBy("last", "desc")
      .limit(limit)
      .execute(),
    db
      .selectFrom("publishes")
      .select((eb) => eb.fn.count<number>("version").distinct().as("n"))
      .where(live)
      .executeTakeFirstOrThrow(),
  ]);
  return { versions: rows.map((r) => r.version), total: Number(total.n) };
}

async function tagsByVersion(db: DB, packageId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom("dist_tags")
    .select(["tag", "version"])
    .where("package_id", "=", packageId)
    .execute();
  const map = new Map<string, string[]>();
  for (const row of rows) map.set(row.version, [...(map.get(row.version) ?? []), row.tag]);
  return map;
}

const FACET_LIMIT = 24;

async function facetsOf(
  db: DB,
  scope: Scope,
  compiled: Compiled,
  directory: Directory,
): Promise<NonNullable<PublishPage["facets"]>> {
  const facet = async (key: QueryKey, column: "git_repo_id" | "ref" | "status") => {
    const rows = await db
      .selectFrom("publishes")
      .select([column, (eb) => eb.fn.countAll<number>().as("n")])
      .where(whereOf(scope, compiled, key))
      .groupBy(column)
      .orderBy("n", "desc")
      .limit(FACET_LIMIT)
      .execute();
    return rows.map((row) => ({
      value: (row as Record<string, unknown>)[column] as string | null,
      count: Number(row.n),
    }));
  };
  const [sources, branch, status] = await Promise.all([
    facet("source", "git_repo_id"),
    facet("branch", "ref"),
    facet("status", "status"),
  ]);
  const names = await directory.repoNames(
    sources.map((s) => s.value).filter((v): v is string => !!v),
  );
  const source: Facet[] = sources.map((s) => ({
    value: s.value ? (names.get(s.value) ?? s.value) : null,
    count: s.count,
  }));
  return { source, branch, status };
}

async function histogramOf(
  db: DB,
  scope: Scope,
  compiled: Compiled,
  now: number,
): Promise<Histogram> {
  const where = whereOf(scope, compiled);
  const span = await db
    .selectFrom("publishes")
    .select((eb) => [eb.fn.min("at").as("first"), eb.fn.max("at").as("last")])
    .where(where)
    .executeTakeFirst();
  const since = sinceOf(compiled, now);
  const until = untilOf(compiled, now) ?? now;
  const first = since ?? (span?.first ? Date.parse(span.first) : until - 86_400_000);
  const range = Math.max(until - first, 3_600_000);
  const bucketMs = BUCKETS.find((b) => range / b <= 120) ?? BUCKETS[BUCKETS.length - 1]!;
  const start = Math.floor(first / bucketMs) * bucketMs;
  const buckets = Math.max(1, Math.ceil((until - start) / bucketMs));
  const startIso = new Date(start).toISOString();
  const rows = await db
    .selectFrom("publishes")
    .select([
      sql<number>`cast((julianday(at) - julianday(${startIso})) * 86400000 / ${bucketMs} as integer)`.as(
        "b",
      ),
      sql<number>`status = 'active'`.as("live"),
      (eb) => eb.fn.countAll<number>().as("n"),
    ])
    .where(where)
    .where("at", ">=", startIso)
    .groupBy(["b", "live"])
    .execute();
  const active = Array.from({ length: buckets }, () => 0);
  const removed = Array.from({ length: buckets }, () => 0);
  for (const row of rows) {
    const index = Number(row.b);
    if (index < 0 || index >= buckets) continue;
    const series = Number(row.live) ? active : removed;
    series[index] = (series[index] ?? 0) + Number(row.n);
  }
  return { start: startIso, bucketMs, active, removed };
}

/** The latest `since:` (when it's the only kind of time filter that narrows). */
function sinceOf(compiled: Compiled, now: number): number | null {
  return timeBound(compiled, "since", now, Math.max);
}

function untilOf(compiled: Compiled, now: number): number | null {
  return timeBound(compiled, "until", now, Math.min);
}

function timeBound(
  compiled: Compiled,
  key: "since" | "until",
  now: number,
  pick: (...values: number[]) => number,
): number | null {
  const values = compiled.raw
    .filter((f) => f.key === key && !f.negated)
    .map((f) => parseWhen(f.value, now)?.getTime())
    .filter((t): t is number => t !== undefined);
  return values.length ? pick(...values) : null;
}
