// Cross-repository composition (CORE-167): capabilities that span the
// repositories of a workspace scope, and dependencies between them backed by
// concrete resolution evidence.
//
// Inputs are only the selected, readable repositories' published snapshots
// (worker/atlas/workspace.ts authorizes and pins them): their capabilities
// (CORE-163) with the canonical concepts each shares, their files' static
// package imports (`pkg:<ecosystem>:<name>` edges), and what each snapshot
// recorded the repository publishes (worker/atlas/publishers.ts, from the
// registry's CI publish provenance), limited to feeds the caller can read.
// Nothing is re-extracted, and no model runs: the same deterministic,
// evidence-only discipline as grouping.
//
// Resolution. An import of package P by repository A resolves to repository
// B when B is the only selected repository (other than A) the registry names
// a source of a package matching P by its format's rule (AtlasResolutionRule).
// Several publishers is `ambiguous`, none is `no-publisher`: both unresolved.
// A's imports of its own packages are intra-repository and not composed.
//
// Composite capabilities. A capability X in A that resolves a dependency on B
// is linked to the capability Y of B sharing the most canonical concepts with
// it (then the larger summed concept weight, then id); with no shared concept
// there is no link, only the dependency. Linked capabilities form composites
// (connected components, which always span at least two repositories). A
// composite's name comes from the concepts its members share; prose stays with
// each member, so nothing written from one repository describes another.
// Capabilities that share concepts but no resolved dependency are only
// `related`, never merged and never shown as a dependency.
//
// Materialized or computed? Computed at read, cached per isolate, keyed by the
// authorized input set: the workspace scope id (which hashes the readable
// repository ids), the composite snapshot id (each repository's pinned seq)
// and the readable feeds. Against the PRD's bounds:
// - The inputs are already materialized and bounded per repository: at most
//   COMPOSE_CAPABILITIES_PER_REPO capabilities and COMPOSE_DEPENDENCIES_PER_REPO
//   (capability, package) rows each, read with indexed queries, so a 50
//   repository scope reads a bounded few thousand rows (coverage reports any
//   truncation). Pages of the result stay within 100 records.
// - A materialized account snapshot would be one per authorized selection and
//   principal policy, all drawing on the account's single 2 GiB composition
//   pool (retention.ts), and every visibility change would have to invalidate
//   it. Computing from per-repository snapshots needs no invalidation: a denied
//   repository is simply never read, so it can't change content, counts or
//   cache identity, and pinning is exactly the per-repository pins.
// - So nothing here is stored and the composition pool stays unused; no
//   inference means no account grouping budget is drawn either.

import type {
  AtlasCompositeCapability,
  AtlasCompositionCoverage,
  AtlasPackageRef,
  AtlasResolutionRule,
} from "../../shared/atlas.ts";
import { sha256 } from "../knowledge/util.ts";
import { parseRecorded, type RecordedPackage, type RecordedPackages } from "./publishers.ts";
import type { AtlasEntity } from "./projection.ts";

/** Bump when the composition rules change. */
export const COMPOSITION_VERSION = 1;
/** Capabilities per repository a composition reads (largest first). */
export const COMPOSE_CAPABILITIES_PER_REPO = 200;
/** (capability, package) import rows per repository a composition reads. */
export const COMPOSE_DEPENDENCIES_PER_REPO = 5000;
/** Related capabilities kept per capability. */
export const MAX_RELATED = 8;
/** A concept more than this many composed capabilities share relates nothing (too common). */
export const COMMON_CONCEPT = 24;
const MAX_RATIONALE = 24;
const MAX_COMPOSITE_CONCEPTS = 8;

const SEP = "/";
export const qualify = (repoId: string, id: string) => `${repoId}${SEP}${id}`;
const UNCLASSIFIED = "group:unclassified";

// ---- resolution ----------------------------------------------------------------

export interface Publisher {
  repoId: string;
  pkg: RecordedPackage;
  rule: AtlasResolutionRule;
}

export type Resolution =
  | { state: "resolved"; publisher: Publisher }
  | { state: "self" }
  | { state: "ambiguous"; candidates: string[] }
  | { state: "none" };

/** `pkg:<ecosystem>:<name>` split, or null. */
export function packageOf(id: string): AtlasPackageRef | null {
  if (!id.startsWith("pkg:")) return null;
  const at = id.indexOf(":", 4);
  if (at < 0) return null;
  return { ecosystem: id.slice(4, at), name: id.slice(at + 1) };
}

const pypiModule = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "_");
const crateModule = (name: string) => name.toLowerCase().replace(/-/g, "_");

/** Lookup keys an import of `ref` matches, most specific first. */
function importKeys(ref: AtlasPackageRef): string[] {
  switch (ref.ecosystem) {
    case "npm":
      return [`npm:${ref.name.toLowerCase()}`];
    case "crates":
      return [`cargo:${crateModule(ref.name)}`];
    case "pypi":
      return [`pypi:${pypiModule(ref.name)}`];
    case "go": {
      const parts = ref.name.split("/");
      const keys: string[] = [];
      for (let n = parts.length; n >= 1; n--) keys.push(`go:${parts.slice(0, n).join("/")}`);
      return keys;
    }
    default:
      return [];
  }
}

/** The key a published package is found under, and its rule. */
function publishedKey(pkg: RecordedPackage): { key: string; rule: AtlasResolutionRule } {
  switch (pkg.format) {
    case "npm":
      return { key: `npm:${pkg.normalized.toLowerCase()}`, rule: "npm-name" };
    case "cargo":
      return { key: `cargo:${crateModule(pkg.normalized)}`, rule: "cargo-crate" };
    case "pypi":
      return { key: `pypi:${pypiModule(pkg.normalized)}`, rule: "pypi-module" };
    case "go":
      return { key: `go:${pkg.name}`, rule: "go-module" };
  }
}

/** Every selected repository's readable published packages, by lookup key. */
export class PublisherIndex {
  private readonly byKey = new Map<string, Publisher[]>();
  /** Exact `pkg:` ids an import of a published package can have. */
  readonly exactIds: string[];
  /** Go module paths (imports inside them match too). */
  readonly goModules: string[];

  constructor(repos: { repoId: string; packages: RecordedPackage[] }[]) {
    const exact = new Set<string>();
    const go = new Set<string>();
    for (const { repoId, packages } of [...repos].sort((a, b) => cmp(a.repoId, b.repoId)))
      for (const pkg of packages) {
        const { key, rule } = publishedKey(pkg);
        const list = this.byKey.get(key) ?? [];
        // One entry per repository: its first package under the key (sorted input).
        if (!list.some((p) => p.repoId === repoId)) list.push({ repoId, pkg, rule });
        this.byKey.set(key, list);
        if (pkg.format === "npm") {
          exact.add(`pkg:npm:${pkg.name}`).add(`pkg:npm:${pkg.normalized}`);
        } else if (pkg.format === "cargo") {
          exact.add(`pkg:crates:${crateModule(pkg.name)}`).add(`pkg:crates:${pkg.name}`);
        } else if (pkg.format === "pypi") {
          exact.add(`pkg:pypi:${pypiModule(pkg.name)}`).add(`pkg:pypi:${pkg.name}`);
        } else {
          exact.add(`pkg:go:${pkg.name}`);
          go.add(pkg.name);
        }
      }
    this.exactIds = [...exact].sort(cmp);
    this.goModules = [...go].sort(cmp);
  }

  get empty(): boolean {
    return this.byKey.size === 0;
  }

  /** Where an import of package entity `pkgId` by repository `from` resolves. */
  resolve(pkgId: string, from: string): Resolution {
    const ref = packageOf(pkgId);
    if (!ref) return { state: "none" };
    for (const key of importKeys(ref)) {
      const publishers = this.byKey.get(key);
      if (!publishers?.length) continue;
      if (publishers.some((p) => p.repoId === from)) return { state: "self" };
      if (publishers.length > 1)
        return { state: "ambiguous", candidates: publishers.map((p) => p.repoId) };
      return { state: "resolved", publisher: publishers[0]! };
    }
    return { state: "none" };
  }
}

// ---- composition ---------------------------------------------------------------

export interface ComposeCapability {
  entity: AtlasEntity;
  files: number;
  concepts: { id: string; name: string; weight: number }[];
}

export interface ComposeRepo {
  repoId: string;
  capabilities: ComposeCapability[];
}

/** Files of a capability (null: unclassified files) importing a package. */
export interface ImportRow {
  repoId: string;
  capability: string | null;
  pkg: string;
  files: number;
}

export interface ResolvedDependency {
  /** The importing capability (or unclassified group), namespaced. */
  src: string;
  repoId: string;
  /** Repository-local capability id; null for unclassified files. */
  capability: string | null;
  pkg: string;
  files: number;
  publisher: Publisher;
}

export interface Composed {
  composites: (AtlasCompositeCapability & { memberIds: string[] })[];
  /** Composite id of a namespaced capability. */
  compositeOf: Map<string, string>;
  /** Every resolved dependency, by src then package. */
  resolved: ResolvedDependency[];
  /** Package ids a repository's imports resolve to itself or to another one: never "unresolved". */
  settled: Map<string, Set<string>>;
  /** Related capabilities of each namespaced capability, strongest first. */
  related: Map<string, { id: string; concepts: { id: string; name: string }[] }[]>;
  /** Composed capabilities, namespaced. */
  capabilities: Map<string, { repoId: string; cap: ComposeCapability }>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    let at = x;
    while (at !== root) {
      const next = this.parent.get(at) ?? root;
      this.parent.set(at, root);
      at = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // The smaller id is the root, so the result is independent of order.
    if (cmp(ra, rb) < 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

/**
 * Compose a scope. Deterministic: identical inputs give identical output,
 * whatever order repositories and rows arrive in.
 */
export async function compose(
  repos: ComposeRepo[],
  imports: ImportRow[],
  index: PublisherIndex,
): Promise<Composed> {
  const capabilities = new Map<string, { repoId: string; cap: ComposeCapability }>();
  const byRepoConcept = new Map<string, Map<string, string[]>>();
  for (const repo of [...repos].sort((a, b) => cmp(a.repoId, b.repoId))) {
    const postings = new Map<string, string[]>();
    for (const cap of repo.capabilities) {
      const ns = qualify(repo.repoId, cap.entity.id);
      capabilities.set(ns, { repoId: repo.repoId, cap });
      for (const c of cap.concepts) postings.set(c.id, [...(postings.get(c.id) ?? []), ns]);
    }
    byRepoConcept.set(repo.repoId, postings);
  }
  const conceptsOf = (ns: string) =>
    new Map((capabilities.get(ns)?.cap.concepts ?? []).map((c) => [c.id, c]));

  // Resolve every import row.
  const resolved: ResolvedDependency[] = [];
  const settled = new Map<string, Set<string>>();
  for (const row of [...imports].sort(
    (a, b) =>
      cmp(a.repoId, b.repoId) || cmp(a.capability ?? "", b.capability ?? "") || cmp(a.pkg, b.pkg),
  )) {
    const resolution = index.resolve(row.pkg, row.repoId);
    if (resolution.state === "resolved" || resolution.state === "self") {
      const set = settled.get(row.repoId) ?? new Set<string>();
      set.add(row.pkg);
      settled.set(row.repoId, set);
    }
    if (resolution.state !== "resolved") continue;
    resolved.push({
      src: qualify(row.repoId, row.capability ?? UNCLASSIFIED),
      repoId: row.repoId,
      capability: row.capability,
      pkg: row.pkg,
      files: row.files,
      publisher: resolution.publisher,
    });
  }
  resolved.sort((a, b) => cmp(a.src, b.src) || cmp(a.pkg, b.pkg));

  // Link each depending capability to its closest capability in the publisher.
  const links = new UnionFind();
  const rationale = new Map<
    string,
    { from: string; to: string; publisher: string; packages: AtlasPackageRef[]; concepts: string[] }
  >();
  for (const dep of resolved) {
    if (!capabilities.has(dep.src)) continue;
    const mine = conceptsOf(dep.src);
    const postings = byRepoConcept.get(dep.publisher.repoId);
    if (!postings) continue;
    const scores = new Map<string, { shared: string[]; weight: number }>();
    for (const [conceptId, c] of mine)
      for (const other of postings.get(conceptId) ?? []) {
        const theirs = conceptsOf(other).get(conceptId);
        const score = scores.get(other) ?? { shared: [], weight: 0 };
        score.shared.push(conceptId);
        score.weight += c.weight + (theirs?.weight ?? 0);
        scores.set(other, score);
      }
    const best = [...scores].sort(
      (a, b) =>
        b[1].shared.length - a[1].shared.length || b[1].weight - a[1].weight || cmp(a[0], b[0]),
    )[0];
    if (!best) continue;
    links.union(dep.src, best[0]);
    const key = `${dep.src}\u0000${best[0]}`;
    const entry = rationale.get(key) ?? {
      from: dep.src,
      to: best[0],
      publisher: dep.publisher.repoId,
      packages: [],
      concepts: [...best[1].shared].sort(cmp),
    };
    const ref = packageOf(dep.pkg)!;
    if (entry.packages.length < 5) entry.packages.push(ref);
    rationale.set(key, entry);
  }

  // Composites: connected components of linked capabilities.
  const components = new Map<string, string[]>();
  for (const { from, to } of rationale.values())
    for (const ns of [from, to]) {
      const root = links.find(ns);
      const list = components.get(root) ?? [];
      if (!list.includes(ns)) list.push(ns);
      components.set(root, list);
    }
  const composites: Composed["composites"] = [];
  const compositeOf = new Map<string, string>();
  for (const members of components.values()) {
    const ordered = members
      .map((ns) => ({ ns, ...capabilities.get(ns)! }))
      .sort((a, b) => b.cap.files - a.cap.files || cmp(a.ns, b.ns));
    const anchor = ordered[0]!;
    const id = `xcap:${(await sha256(`composite\u0000${anchor.ns}`)).slice(0, 16)}`;
    const shared = new Map<string, { name: string; members: number; weight: number }>();
    for (const m of ordered)
      for (const c of m.cap.concepts) {
        const s = shared.get(c.id) ?? { name: c.name, members: 0, weight: 0 };
        s.members++;
        s.weight += c.weight;
        shared.set(c.id, s);
      }
    const concepts = [...shared]
      .filter(([, s]) => s.members >= 2)
      .sort((a, b) => b[1].members - a[1].members || b[1].weight - a[1].weight || cmp(a[0], b[0]))
      .slice(0, MAX_COMPOSITE_CONCEPTS)
      .map(([cid, s]) => ({ id: cid, name: s.name, members: s.members }));
    const conceptName = new Map(concepts.map((c) => [c.id, c.name]));
    const memberSet = new Set(members);
    const why = [...rationale.values()]
      .filter((r) => memberSet.has(r.from))
      .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))
      .slice(0, MAX_RATIONALE)
      .map((r) => ({
        from: r.from,
        to: r.to,
        publisher: r.publisher,
        packages: r.packages,
        concepts: r.concepts.map((cid) => ({
          id: cid,
          name: conceptName.get(cid) ?? conceptsOf(r.from).get(cid)?.name ?? cid,
        })),
      }));
    const repoIds = [...new Set(ordered.map((m) => m.repoId))].sort(cmp);
    const named = concepts.slice(0, 2).map((c) => c.name);
    composites.push({
      id,
      kind: "composite-capability",
      name: named.length ? named.join(" & ") : anchor.cap.entity.name,
      nameSource: named.length ? "concepts" : "anchor",
      anchor: anchor.ns,
      repos: repoIds,
      members: [],
      memberIds: ordered.map((m) => m.ns),
      counts: {
        files: ordered.reduce((n, m) => n + m.cap.files, 0),
        capabilities: ordered.length,
        repos: repoIds.length,
      },
      concepts,
      rationale: why,
      composition: {
        producer: "atlas/compose",
        version: COMPOSITION_VERSION,
        evidence: ["resolved-dependencies", "concepts"],
      },
    });
    for (const ns of ordered) compositeOf.set(ns.ns, id);
  }
  composites.sort((a, b) => b.counts.files - a.counts.files || cmp(a.id, b.id));

  // Related: shared concepts across repositories, outside a common composite.
  const postings = new Map<string, string[]>();
  for (const [ns, { cap }] of [...capabilities].sort((a, b) => cmp(a[0], b[0])))
    for (const c of cap.concepts) postings.set(c.id, [...(postings.get(c.id) ?? []), ns]);
  const pairs = new Map<string, Map<string, string[]>>();
  for (const [conceptId, list] of [...postings].sort((a, b) => cmp(a[0], b[0]))) {
    if (list.length < 2 || list.length > COMMON_CONCEPT) continue;
    for (const a of list)
      for (const b of list) {
        if (a === b) continue;
        if (capabilities.get(a)!.repoId === capabilities.get(b)!.repoId) continue;
        const ca = compositeOf.get(a);
        if (ca && ca === compositeOf.get(b)) continue;
        const mine = pairs.get(a) ?? new Map<string, string[]>();
        mine.set(b, [...(mine.get(b) ?? []), conceptId]);
        pairs.set(a, mine);
      }
  }
  const related: Composed["related"] = new Map();
  for (const [ns, others] of pairs) {
    const mine = conceptsOf(ns);
    related.set(
      ns,
      [...others]
        .sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]))
        .slice(0, MAX_RELATED)
        .map(([id, shared]) => ({
          id,
          concepts: shared.map((cid) => ({ id: cid, name: mine.get(cid)?.name ?? cid })),
        })),
    );
  }

  return { composites, compositeOf, resolved, settled, related, capabilities };
}

// ---- reading a scope -------------------------------------------------------------

/** A pinned, readable repository snapshot to compose. */
export interface ComposeSource {
  repoId: string;
  scope: string;
  seq: number;
  snapshotId: string;
}

const VISIBLE = (alias: string) =>
  `${alias}.from_seq <= ?2 AND (${alias}.to_seq IS NULL OR ${alias}.to_seq > ?2)`;

/** Each snapshot's recorded packages (null: not recorded). */
export async function recordedPackages(
  d1: D1Database,
  snapshotIds: string[],
): Promise<Map<string, RecordedPackages | null>> {
  if (!snapshotIds.length) return new Map();
  const rows = await d1
    .prepare(
      `SELECT id, packages FROM atlas_snapshots WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(snapshotIds))
    .all<{ id: string; packages: string | null }>();
  return new Map(rows.results.map((r) => [r.id, parseRecorded(r.packages)]));
}

/** A snapshot's largest capabilities (at most COMPOSE_CAPABILITIES_PER_REPO) and how many it has. */
async function capabilitiesOf(
  d1: D1Database,
  source: ComposeSource,
): Promise<{ capabilities: ComposeCapability[]; total: number }> {
  const [rows, total] = await Promise.all([
    d1
      .prepare(
        `SELECT entity_id, kind, parent_id, name, path, summary, data,
                coalesce(json_extract(data, '$.counts.files'), 0) AS files
         FROM atlas_entities e
         WHERE e.scope = ?1 AND e.parent_id = 'repo' AND e.kind = 'capability' AND ${VISIBLE("e")}
         ORDER BY files DESC, sort_key LIMIT ?3`,
      )
      .bind(source.scope, source.seq, COMPOSE_CAPABILITIES_PER_REPO)
      .all<{
        entity_id: string;
        kind: string;
        parent_id: string | null;
        name: string;
        path: string | null;
        summary: string;
        data: string;
        files: number;
      }>(),
    d1
      .prepare(
        `SELECT count(*) AS n FROM atlas_entities e
         WHERE e.scope = ?1 AND e.parent_id = 'repo' AND e.kind = 'capability' AND ${VISIBLE("e")}`,
      )
      .bind(source.scope, source.seq)
      .first<{ n: number }>(),
  ]);
  return {
    total: Number(total?.n ?? 0),
    capabilities: rows.results.map((r) => {
      const data = JSON.parse(r.data) as Record<string, unknown>;
      const concepts = Array.isArray(data.concepts)
        ? (data.concepts as { id: string; name: string; weight: number }[]).filter(
            (c) => typeof c?.id === "string",
          )
        : [];
      return {
        entity: {
          id: r.entity_id,
          kind: r.kind,
          parentId: r.parent_id,
          name: r.name,
          path: r.path,
          summary: r.summary,
          data,
        },
        files: Number(r.files),
        concepts,
      };
    }),
  };
}

/** Successor of a prefix for a half-open range: "a/" -> "a0". */
const after = (prefix: string) =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/** Import rows of packages the index can resolve, by capability (at most COMPOSE_DEPENDENCIES_PER_REPO). */
async function importsOf(
  d1: D1Database,
  source: ComposeSource,
  index: PublisherIndex,
): Promise<{ rows: ImportRow[]; truncated: boolean }> {
  const ranges = index.goModules.map((m) => [`pkg:go:${m}/`, after(`pkg:go:${m}/`)] as const);
  const rows = await d1
    .prepare(
      `WITH hits (src, dst) AS (
         SELECT e.src, e.dst FROM atlas_edges e
          WHERE e.scope = ?1 AND e.dst IN (SELECT value FROM json_each(?3)) AND e.kind = 'imports'
            AND ${VISIBLE("e")}
         UNION ALL
         SELECT e.src, e.dst FROM json_each(?4) g
           JOIN atlas_edges e ON e.scope = ?1 AND e.dst >= json_extract(g.value, '$[0]')
            AND e.dst < json_extract(g.value, '$[1]') AND e.kind = 'imports' AND ${VISIBLE("e")}
       )
       SELECT json_extract(f.data, '$.membership.capability') AS cap, h.dst AS pkg, count(*) AS n
       FROM hits h
       JOIN atlas_entities f ON f.scope = ?1 AND f.entity_id = h.src AND f.kind = 'file' AND ${VISIBLE("f")}
       GROUP BY cap, pkg ORDER BY cap, pkg LIMIT ?5`,
    )
    .bind(
      source.scope,
      source.seq,
      JSON.stringify(index.exactIds),
      JSON.stringify(ranges),
      COMPOSE_DEPENDENCIES_PER_REPO + 1,
    )
    .all<{ cap: string | null; pkg: string; n: number }>();
  return {
    truncated: rows.results.length > COMPOSE_DEPENDENCIES_PER_REPO,
    rows: rows.results.slice(0, COMPOSE_DEPENDENCIES_PER_REPO).map((r) => ({
      repoId: source.repoId,
      capability: r.cap,
      pkg: r.pkg,
      files: Number(r.n),
    })),
  };
}

export interface ScopeComposition extends Composed {
  index: PublisherIndex;
  coverage: AtlasCompositionCoverage[];
}

/**
 * Read and compose these sources. `packages` is each snapshot's recorded
 * packages already limited to readable feeds (see `limitToFeeds`).
 */
export async function composeScope(
  d1: D1Database,
  sources: ComposeSource[],
  packages: Map<
    string,
    { state: AtlasCompositionCoverage["packages"]; packages: RecordedPackage[] }
  >,
): Promise<ScopeComposition> {
  const index = new PublisherIndex(
    sources.map((s) => ({
      repoId: s.repoId,
      packages: packages.get(s.snapshotId)?.packages ?? [],
    })),
  );
  const read = await Promise.all(
    sources.map(async (source) => {
      const [caps, imports] = await Promise.all([
        capabilitiesOf(d1, source),
        index.empty
          ? Promise.resolve({ rows: [] as ImportRow[], truncated: false })
          : importsOf(d1, source, index),
      ]);
      return { source, caps, imports };
    }),
  );
  const composed = await compose(
    read.map((r) => ({ repoId: r.source.repoId, capabilities: r.caps.capabilities })),
    read.flatMap((r) => r.imports.rows),
    index,
  );
  const coverage: AtlasCompositionCoverage[] = read.map((r) => ({
    repoId: r.source.repoId,
    capabilities: { composed: r.caps.capabilities.length, total: r.caps.total },
    packages: packages.get(r.source.snapshotId)?.state ?? "unrecorded",
    imports: { considered: r.imports.rows.length, truncated: r.imports.truncated },
  }));
  return { ...composed, index, coverage };
}

/** Recorded packages per snapshot, keeping only those in `readable` feeds. */
export function limitToFeeds(
  recorded: Map<string, RecordedPackages | null>,
  readable: Set<string>,
): Map<string, { state: AtlasCompositionCoverage["packages"]; packages: RecordedPackage[] }> {
  const out = new Map<
    string,
    { state: AtlasCompositionCoverage["packages"]; packages: RecordedPackage[] }
  >();
  for (const [id, value] of recorded) {
    if (!value) out.set(id, { state: "unrecorded", packages: [] });
    else if (value.status === "error") out.set(id, { state: "error", packages: [] });
    else
      out.set(id, {
        state: "recorded",
        packages: value.packages.filter((p) => readable.has(p.feedId)),
      });
  }
  return out;
}

// ---- a small cache, keyed by the authorized input set -----------------------------

const CACHE_ENTRIES = 16;
const cache = new Map<string, Promise<ScopeComposition>>();

/**
 * The composition for a key naming exactly its authorized inputs (scope id,
 * composite snapshot id, readable feeds), computed once per isolate.
 */
export function cachedComposition(
  key: string,
  compute: () => Promise<ScopeComposition>,
): Promise<ScopeComposition> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = compute();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return pending;
}

/** For tests: forget every cached composition. */
export function clearCompositionCache() {
  cache.clear();
}

// ---- evidence ------------------------------------------------------------------------

/** Manifest file names for an ecosystem, most authoritative first. */
const MANIFESTS: Record<string, string[]> = {
  npm: ["package.json"],
  crates: ["Cargo.toml"],
  pypi: ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt"],
  go: ["go.mod"],
};

/** Candidate manifest paths above `path`, nearest first. */
export function manifestCandidates(path: string, ecosystem: string): string[] {
  const names = MANIFESTS[ecosystem] ?? [];
  const dirs = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let n = dirs.length; n >= 0; n--) {
    const dir = dirs.slice(0, n).join("/");
    for (const name of names) out.push(dir ? `${dir}/${name}` : name);
  }
  return out;
}

/**
 * Files of a capability (null: unclassified files) importing each of these
 * packages: the first `per` by path, with their blobs.
 */
export async function importerSamples(
  d1: D1Database,
  source: { scope: string; seq: number },
  capability: string | null,
  pkgs: string[],
  per = 5,
): Promise<Map<string, { path: string; blob: string | null }[]>> {
  if (!pkgs.length) return new Map();
  const rows = await d1
    .prepare(
      `SELECT pkg, path, blob FROM (
         SELECT e.dst AS pkg, f.path AS path, json_extract(f.data, '$.blob') AS blob,
                row_number() OVER (PARTITION BY e.dst ORDER BY f.path) AS rn
         FROM atlas_edges e
         JOIN atlas_entities f ON f.scope = e.scope AND f.entity_id = e.src AND f.kind = 'file' AND ${VISIBLE("f")}
         WHERE e.scope = ?1 AND e.kind = 'imports' AND ${VISIBLE("e")}
           AND e.dst IN (SELECT value FROM json_each(?3))
           AND ${capability === null ? "json_extract(f.data, '$.membership.capability') IS NULL" : "json_extract(f.data, '$.membership.capability') = ?5"}
       ) WHERE rn <= ?4 ORDER BY pkg, path`,
    )
    .bind(
      source.scope,
      source.seq,
      JSON.stringify(pkgs),
      per,
      ...(capability === null ? [] : [capability]),
    )
    .all<{ pkg: string; path: string; blob: string | null }>();
  const out = new Map<string, { path: string; blob: string | null }[]>();
  for (const r of rows.results)
    out.set(r.pkg, [...(out.get(r.pkg) ?? []), { path: r.path, blob: r.blob }]);
  return out;
}

/** The nearest manifest present in the snapshot for each (path, ecosystem). */
export async function nearestManifests(
  d1: D1Database,
  source: { scope: string; seq: number },
  wanted: { path: string; ecosystem: string }[],
): Promise<Map<string, { path: string; blob: string | null } | null>> {
  const candidates = new Map(
    wanted.map((w) => [`${w.ecosystem}\u0000${w.path}`, manifestCandidates(w.path, w.ecosystem)]),
  );
  const all = [...new Set([...candidates.values()].flat())].map((p) => `file:${p}`);
  const present = new Map<string, string | null>();
  if (all.length) {
    const rows = await d1
      .prepare(
        `SELECT path, json_extract(data, '$.blob') AS blob FROM atlas_entities e
         WHERE e.scope = ?1 AND e.entity_id IN (SELECT value FROM json_each(?3)) AND ${VISIBLE("e")}`,
      )
      .bind(source.scope, source.seq, JSON.stringify(all))
      .all<{ path: string; blob: string | null }>();
    for (const r of rows.results) present.set(r.path, r.blob);
  }
  const out = new Map<string, { path: string; blob: string | null } | null>();
  for (const [key, paths] of candidates) {
    const found = paths.find((p) => present.has(p));
    out.set(key, found ? { path: found, blob: present.get(found) ?? null } : null);
  }
  return out;
}

/** Some entities of one snapshot, by id. */
export async function entitiesAt(
  d1: D1Database,
  source: { scope: string; seq: number },
  ids: string[],
): Promise<Map<string, AtlasEntity>> {
  if (!ids.length) return new Map();
  const rows = await d1
    .prepare(
      `SELECT entity_id, kind, parent_id, name, path, summary, data FROM atlas_entities e
       WHERE e.scope = ?1 AND e.entity_id IN (SELECT value FROM json_each(?3)) AND ${VISIBLE("e")}`,
    )
    .bind(source.scope, source.seq, JSON.stringify([...new Set(ids)]))
    .all<{
      entity_id: string;
      kind: string;
      parent_id: string | null;
      name: string;
      path: string | null;
      summary: string;
      data: string;
    }>();
  return new Map(
    rows.results.map((r) => [
      r.entity_id,
      {
        id: r.entity_id,
        kind: r.kind,
        parentId: r.parent_id,
        name: r.name,
        path: r.path,
        summary: r.summary,
        data: JSON.parse(r.data) as Record<string, unknown>,
      },
    ]),
  );
}

/**
 * A page of the packages files under `parentId` (a capability, through its
 * areas, or a group) import, except `exclude`, by package id.
 */
export async function unresolvedImports(
  d1: D1Database,
  source: { scope: string; seq: number },
  parentId: string,
  exclude: string[],
  after: string | null,
  limit: number,
): Promise<{ rows: { pkg: string; files: number }[]; next: string | null }> {
  const rows = await d1
    .prepare(
      `WITH members (id) AS (
         SELECT entity_id FROM atlas_entities e
          WHERE e.scope = ?1 AND e.parent_id = ?3 AND e.kind = 'file' AND ${VISIBLE("e")}
         UNION ALL
         SELECT f.entity_id FROM atlas_entities a
           JOIN atlas_entities f ON f.scope = a.scope AND f.parent_id = a.entity_id AND f.kind = 'file' AND ${VISIBLE("f")}
          WHERE a.scope = ?1 AND a.parent_id = ?3 AND a.kind = 'area' AND ${VISIBLE("a")}
       )
       SELECT e.dst AS pkg, count(*) AS n FROM members m
       JOIN atlas_edges e ON e.scope = ?1 AND e.src = m.id AND e.kind = 'imports'
         AND e.dst >= 'pkg:' AND e.dst < 'pkg;' AND ${VISIBLE("e")}
       WHERE e.dst > ?4 AND e.dst NOT IN (SELECT value FROM json_each(?5))
         AND e.dst NOT LIKE 'pkg:platform:%'
       GROUP BY e.dst ORDER BY e.dst LIMIT ?6`,
    )
    .bind(source.scope, source.seq, parentId, after ?? "", JSON.stringify(exclude), limit + 1)
    .all<{ pkg: string; n: number }>();
  const page = rows.results.slice(0, limit);
  return {
    rows: page.map((r) => ({ pkg: r.pkg, files: Number(r.n) })),
    next: rows.results.length > limit ? (page.at(-1)?.pkg ?? null) : null,
  };
}

/** How many packages unresolvedImports would list in all. */
export async function unresolvedCount(
  d1: D1Database,
  source: { scope: string; seq: number },
  parentId: string,
  exclude: string[],
): Promise<number> {
  const page = await d1
    .prepare(
      `WITH members (id) AS (
         SELECT entity_id FROM atlas_entities e
          WHERE e.scope = ?1 AND e.parent_id = ?3 AND e.kind = 'file' AND ${VISIBLE("e")}
         UNION ALL
         SELECT f.entity_id FROM atlas_entities a
           JOIN atlas_entities f ON f.scope = a.scope AND f.parent_id = a.entity_id AND f.kind = 'file' AND ${VISIBLE("f")}
          WHERE a.scope = ?1 AND a.parent_id = ?3 AND a.kind = 'area' AND ${VISIBLE("a")}
       )
       SELECT count(DISTINCT e.dst) AS n FROM members m
       JOIN atlas_edges e ON e.scope = ?1 AND e.src = m.id AND e.kind = 'imports'
         AND e.dst >= 'pkg:' AND e.dst < 'pkg;' AND ${VISIBLE("e")}
       WHERE e.dst NOT IN (SELECT value FROM json_each(?4)) AND e.dst NOT LIKE 'pkg:platform:%'`,
    )
    .bind(source.scope, source.seq, parentId, JSON.stringify(exclude))
    .first<{ n: number }>();
  return Number(page?.n ?? 0);
}
