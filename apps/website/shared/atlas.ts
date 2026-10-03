// The Atlas read API (CORE-160): bounded, snapshot-pinned pages over a
// repository's published Atlas projection. Served by worker/atlas/api.ts under
// /api/repos/:owner/:name/atlas, read by src/lib/atlas.ts. The same pages over
// an explicit workspace scope (CORE-161) are served by worker/atlas/workspace.ts
// under /api/accounts/:owner/atlas (the Atlas Workspace types below).
//
// Every response names the snapshot it was read from. A request may pin one
// (`?snapshot=<id>`); continuation cursors always do. A pinned snapshot that is
// unknown or expired is an explicit error (AtlasErrorCode), never a silent
// switch to the current one. Browsing never runs a model.

/** Records per page, at most. */
export const ATLAS_PAGE_MAX = 100;
/** Records per page when the request doesn't ask. */
export const ATLAS_PAGE_DEFAULT = 50;
/** Top-level regions an overview shows; the rest are in its catalogue. */
export const ATLAS_OVERVIEW_REGIONS = 12;
/** Bound on the initial overview's compressed JSON (PRD gate 18). */
export const ATLAS_OVERVIEW_MAX_BYTES = 256 * 1024;
/** Summary characters an overview region carries; `detail` has the rest. */
export const ATLAS_OVERVIEW_SUMMARY_CHARS = 2000;
/** Summary characters a region catalogue entry carries. */
export const ATLAS_CATALOGUE_SUMMARY_CHARS = 280;
/** Repositories one workspace scope can select. */
export const ATLAS_WORKSPACE_MAX_REPOS = 50;

/** One repository's place in a snapshot: there is no common HEAD across repositories. */
export interface AtlasVectorEntry {
  repoId: string;
  commit: string;
  buildId: string;
}

/** The immutable snapshot a response was read from. */
export interface AtlasSnapshotRef {
  id: string;
  seq: number;
  vector: AtlasVectorEntry[];
  publishedAt: string | null;
  /** Upstream analysis was incomplete (pending files): totals are floors. */
  partial: boolean;
  projectionVersion: number;
  /** When a retained prior snapshot stops being readable; null while current. */
  expiresAt: string | null;
}

/** What every Atlas response carries. */
export interface AtlasEnvelope {
  /** "repo:<id>" for a repository. */
  scope: string;
  snapshot: AtlasSnapshotRef;
}

/** Deduplicated counts: each source unit counts once, at its primary place. */
export interface AtlasCountsData {
  files?: number;
  symbols?: number;
  [key: string]: number | undefined;
}

/**
 * A region's cell in its parent's fixed-width grid: kept while its id
 * continues, so regions appearing, growing or leaving never move another.
 * `fill` (0..1) is the share of the cell its size covers, from a power-of-two
 * `bucket` of its primary file count.
 */
export interface AtlasLayout {
  slot: number;
  col: number;
  row: number;
  bucket: number;
  fill: number;
}

/** An entity as lists show it. */
export interface AtlasEntitySummary {
  id: string;
  /** repository, component, group, file, symbol, concept, package, directory. */
  kind: string;
  parentId: string | null;
  name: string;
  path: string | null;
  summary: string;
  counts: AtlasCountsData;
  /** A structural group (unclassified, concepts, dependencies, folders), not a capability. */
  structural: boolean;
  /**
   * For described entities (capabilities): whether `summary` is current model
   * prose. "stale" and "unavailable" leave `summary` empty; `detail` carries
   * the stale prose with its original basis in `data.description`.
   */
  summaryState?: { status: AtlasDescriptionStatus; reason?: AtlasUnavailableReason };
  /**
   * The snapshot sequence this entity last changed in: equal to the snapshot
   * being read, it changed in that build (the map's change marker).
   */
  since?: number;
  /** Stable grid placement under its parent (CORE-165); capabilities and areas. */
  layout?: AtlasLayout;
  /**
   * In a workspace scope, the repository it belongs to: ids (and parentId)
   * are then `<repoId>/<repository-local id>`. Ids inside `data` stay
   * repository-local. Absent in a repository scope.
   */
  repoId?: string;
}

/** An entity in full, as `detail` shows it. */
export interface AtlasEntity extends AtlasEntitySummary {
  data: Record<string, unknown>;
}

/** How much of a list the traversal has seen. */
export interface AtlasCounts {
  /** Records returned so far in this traversal, this page included. */
  loaded: number;
  /** Records the snapshot holds for this query, or null when not counted. */
  knownTotal: number | null;
  /**
   * More may exist than the snapshot indexed (a partial snapshot), so
   * knownTotal is a floor and an empty page isn't proof of absence.
   */
  unknownTotal: boolean;
}

/** A bounded page. `next` continues it; null when this is the last page. */
export interface AtlasPage<T> extends AtlasEnvelope {
  items: T[];
  counts: AtlasCounts;
  next: string | null;
}

/**
 * A top-level region: a capability (or, in a projection built before
 * grouping, a component), or a structural group.
 */
export interface AtlasRegion extends AtlasEntitySummary {
  /** Primary files (deduplicated) and direct members, for ranking and area. */
  size: { files: number; members: number };
  /** The summary was cut (ATLAS_OVERVIEW_SUMMARY_CHARS, or ATLAS_CATALOGUE_SUMMARY_CHARS in the catalogue); `detail` has it whole. */
  summaryTruncated: boolean;
}

/** GET /overview */
export interface AtlasOverview extends AtlasEnvelope {
  root: AtlasEntitySummary | null;
  /**
   * The first top-level regions (≤ ATLAS_OVERVIEW_REGIONS): capabilities by
   * primary files, then direct members, then name; structural groups after
   * every capability, ranked the same way.
   */
  regions: AtlasRegion[];
  /** Every top-level region past `regions`, in the same order: first page, continued by GET /regions. */
  catalogue: AtlasPage<AtlasRegion>;
  /** Top-level regions in all. */
  totalRegions: number;
  /**
   * The newest build of this scope didn't fit its storage cap, so the current
   * snapshot is stale (older than the latest build); null when it isn't.
   */
  capacityFailure: AtlasCapacityFailure | null;
}

/** A snapshot that failed to publish for want of projection storage (CORE-159). */
export interface AtlasCapacityFailure {
  snapshotId: string;
  seq: number;
  /** Says how much storage it needed against the cap. */
  error: string;
  failedAt: string;
}

/** GET /detail */
export interface AtlasDetail extends AtlasEnvelope {
  entity: AtlasEntity;
  /** Root first, parent last. */
  ancestors: AtlasEntitySummary[];
  counts: {
    children: number;
    outgoing: Record<string, number>;
    incoming: Record<string, number>;
  };
}

/** GET /ancestors */
export interface AtlasAncestors extends AtlasEnvelope {
  entity: AtlasEntitySummary;
  /** Root first, parent last. */
  ancestors: AtlasEntitySummary[];
}

export type AtlasDirection = "in" | "out";

/** One edge, with the entity at its other end. */
export interface AtlasRelation {
  src: string;
  dst: string;
  kind: string;
  weight: number;
  /** The other end; null when the snapshot holds no entity for it. */
  neighbor: AtlasEntitySummary | null;
}

/** One file import behind a capability-to-capability relation (GET /contributing). */
export interface AtlasContribution {
  src: string;
  dst: string;
  srcPath: string | null;
  dstPath: string | null;
}

/** Where a source line range is known; never invented. */
export interface AtlasRange {
  startLine: number | null;
  endLine: number | null;
  /**
   * "whole-file": the evidence is the file, lines 1..endLine; "start-line":
   * only where it starts is known (endLine null); "unavailable": nothing is.
   */
  status: "whole-file" | "start-line" | "unavailable";
}

/** A source location backing an entity, at the snapshot's commit. */
export interface AtlasEvidence {
  /** The source entity (a file, or the symbol itself). */
  entityId: string;
  kind: string;
  repoId: string;
  commit: string;
  path: string;
  blob: string | null;
  range: AtlasRange;
  /** How it backs the entity: self, defines (a symbol's file), member, contains, mentions, imports. */
  via: string;
  /** analyzed, pending (not analyzed yet) or skipped (generated, binary, oversized…). */
  analysis: "analyzed" | "pending" | "skipped";
}

// ---- names, summaries and provenance (CORE-164) ---------------------------------
//
// A capability's `data` keeps three kinds of statement apart:
//   structural facts  membership and counts from grouping (imports, concepts)
//   model inference   name, summary and rationale (`data.description`), each
//                     traced to the file cards, syntheses and concepts it was
//                     written from, and through them to immutable sources
//   curated           assertions a person made, with author and basis (none yet)
// No numeric confidence is ever given, and prose never cites only other prose.

/** current: written from this snapshot's inputs; stale: an earlier snapshot's prose; unavailable: none. */
export type AtlasDescriptionStatus = "current" | "stale" | "unavailable";

/** Why prose is stale or unavailable. */
export type AtlasUnavailableReason =
  /** A per-build cap or the account's daily Atlas ceiling was reached (see `exhausted`). */
  | "budget_exhausted"
  /** Atlas paid synthesis is off (the model has no configured price). */
  | "disabled"
  /** The model call failed; it is not retried automatically. */
  | "provider_error"
  /** The model replied with nothing usable. */
  | "invalid_reply"
  /** The naming step itself failed; structure was published without it. */
  | "error";

/** An immutable source location: a file at an indexed commit, with what's known of its range. */
export interface AtlasSourceRef {
  repoId: string;
  commit: string;
  path: string;
  blob: string | null;
  range: AtlasRange;
  /** Symbols the file card lists for it, each with what's known of its range. */
  symbols: { name: string; range: AtlasRange }[];
}

/** What a piece of model inference was written from (never another capability's prose). */
export type AtlasDerivation =
  /** A file's analysis card (per blob). */
  | {
      kind: "file-card";
      path: string;
      blob: string;
      producer: "knowledge/analyze";
      analyzer: string;
      /** The model that wrote the card; null for structure-only cards. */
      model: string | null;
    }
  /** A directory component's synthesis, itself written from its files' cards. */
  | {
      kind: "component-synthesis";
      id: string;
      producer: "knowledge/synthesize";
      analyzer: string;
      /** Not recorded for component syntheses. */
      model: "unavailable";
      /** The component's files among this capability's sources. */
      paths: string[];
    }
  /** A canonical concept the members share, with how many members mention it. */
  | { kind: "concept"; id: string; name: string; producer: "knowledge/concepts"; files: number }
  /** The grouping evidence that put the members together. */
  | {
      kind: "membership";
      producer: "atlas/grouping";
      version: number;
      files: number;
      /** Import links between members. */
      importLinks: number;
    };

/** Model-derived statements, traced to their inputs and immutable sources. */
export interface AtlasInference {
  /** Which fields of `description` are model-derived. */
  fields: ("name" | "summary" | "rationale")[];
  producer: "atlas/describe";
  /** The naming algorithm/prompt version. */
  version: number;
  model: string;
  /** Hash of exactly what the model was given; identical inputs are never re-inferred. */
  inputsHash: string;
  /** The source version the prose was written from (the original one, when stale). */
  basis: { repoId: string; commit: string; buildId: string };
  inferredAt: string;
  derivedFrom: AtlasDerivation[];
  /** The member files the prose rests on, at `basis.commit`. */
  sources: AtlasSourceRef[];
}

/** A person's assertion consumed by the Atlas: it keeps its author and source basis. */
export interface AtlasCuratedAssertion {
  field: string;
  value: string;
  author: { id: string; kind: "user" | "agent" };
  at: string;
  basis: AtlasSourceRef[];
}

/** `data.description` of a capability. */
export interface AtlasDescription {
  status: AtlasDescriptionStatus;
  reason?: AtlasUnavailableReason;
  /** The cap that stopped paid work, when `reason` is budget_exhausted. */
  exhausted?: { cap: string; resetsAt: string | null };
  /** The model's name for it (the entity's `name` only while current). */
  name: string | null;
  summary: string | null;
  /** Why the members belong together, in words (the structural evidence is on each file's membership). */
  rationale: string | null;
}

/** `data.provenance` of a capability. */
export interface AtlasProvenance {
  /** Membership and counts: deterministic, from the snapshot's graph. */
  structural: { producer: "atlas/grouping"; version: number; evidence: string[] };
  /** Present when `description` is current or stale. */
  inferred: AtlasInference | null;
  curated: AtlasCuratedAssertion[];
}

/** A recoverable Atlas failure: the client restarts or moves explicitly. */
export type AtlasErrorCode =
  /** The scope has no published snapshot yet. */
  | "atlas_unavailable"
  /** The pinned snapshot doesn't exist in this scope (or never published). */
  | "snapshot_unknown"
  /** The pinned snapshot is past retention. */
  | "snapshot_expired"
  /** The cursor is forged, malformed or belongs to another request, scope, snapshot or user. */
  | "cursor_invalid"
  /** The cursor outlived its 30 minutes (or its snapshot's retention). */
  | "cursor_expired"
  /** The entity isn't in this snapshot. */
  | "entity_unknown"
  /**
   * Workspace scope: no selected repository is one the caller can read (or
   * exists). Unreadable and nonexistent repositories are indistinguishable.
   */
  | "scope_empty"
  | "bad_request";

export interface AtlasError {
  error: string;
  code: AtlasErrorCode;
  /**
   * The scope's current snapshot, for an explicit "go to current" action. In
   * a workspace scope it's the current composite id, and `seq` is null.
   */
  current?: { id: string; seq: number | null } | null;
  /** With snapshot_expired: when and why retention expired it (in a workspace, the first one read). */
  expired?: { at: string; reason: "age" | "count" | "storage" };
  /**
   * With entity_unknown for a capability or area a build retired (CORE-165):
   * what it was and where its members went, so an old link can explain the
   * change rather than resolve to something unrelated.
   */
  lineage?: AtlasLineage;
  /**
   * A comparison (GET /compare): which of its two snapshots the error is
   * about. An expired or unknown one makes the comparison unavailable, which
   * says nothing about whether anything changed.
   */
  side?: "from" | "to";
}

export interface AtlasLineage {
  id: string;
  kind: string;
  name: string;
  /** The snapshot sequence that no longer has it. */
  retiredSeq: number;
  change: "split" | "merged" | "removed";
  successors: { id: string; share: number }[];
}

// ---- workspace scope (CORE-161) ------------------------------------------------
//
// A workspace scope is an explicit selection of one account's repositories
// (`?repos=a,b`), re-authorized on every request: the server keeps only the
// selected repositories the caller can read now, and a response never says
// anything about the rest, not even how many. Composition is virtual: each
// response reads every selected repository's own published projection, so
// each item belongs to exactly one repository (`repoId`) and there is no
// common HEAD, only each repository's own snapshot.

/**
 * A selected repository's Atlas: `ready` (a published snapshot), `building`
 * (none yet, a Knowledge build is running), `unavailable` (Knowledge has run
 * but published no Atlas, e.g. it failed) or `not-enabled` (Knowledge has
 * never built it). Selecting a repository never starts a build.
 */
export type AtlasRepoState = "ready" | "building" | "unavailable" | "not-enabled";

/** One selected, readable repository and its own place in the composite. */
export interface AtlasWorkspaceRepo {
  id: string;
  owner: string;
  name: string;
  visibility: "public" | "private";
  state: AtlasRepoState;
  /** The snapshot this view reads, with its own commit and build; null unless ready. */
  snapshot: AtlasSnapshotRef | null;
  /** A Knowledge build is running, so a ready snapshot may lag the repository. */
  building: boolean;
  /** Overview only: a newer build didn't fit its storage cap (the snapshot is stale). */
  capacityFailure?: AtlasCapacityFailure | null;
}

/** The composite snapshot a workspace response was read from. */
export interface AtlasWorkspaceSnapshot {
  /**
   * Pins every selected repository's snapshot; pass it back as `?snapshot=`.
   * Only meaningful with the same scope: when what the caller can read
   * changes, it's `snapshot_unknown`.
   */
  id: string;
  /**
   * The selected repositories this response read: all of them for overview,
   * regions and catalogue, the entity's own repository otherwise.
   */
  repos: AtlasWorkspaceRepo[];
}

/** What every workspace response carries. */
export interface AtlasWorkspaceEnvelope {
  /** "ws:<ownerId>:<hash>": names exactly the authorized repository set. */
  scope: string;
  owner: { id: string; slug: string };
  snapshot: AtlasWorkspaceSnapshot;
}

type InWorkspace<T> = Omit<T, "scope" | "snapshot"> & AtlasWorkspaceEnvelope;

export type AtlasWorkspacePage<T> = InWorkspace<AtlasPage<T>>;

/** GET /api/accounts/:owner/atlas/overview */
export interface AtlasWorkspaceOverview extends AtlasWorkspaceEnvelope {
  /**
   * The first top-level regions of every ready repository, ranked together:
   * capabilities by primary files, then members, name and repository;
   * structural groups after them.
   */
  regions: AtlasRegion[];
  catalogue: AtlasWorkspacePage<AtlasRegion>;
  totalRegions: number;
}

export type AtlasWorkspaceDetail = InWorkspace<AtlasDetail>;
export type AtlasWorkspaceAncestors = InWorkspace<AtlasAncestors>;

// ---- cross-repository composition (CORE-167) -----------------------------------
//
// Over a workspace scope, capabilities can span repositories, and a capability
// can depend on another selected repository. Both come only from the selected,
// readable repositories' own snapshots (worker/atlas/compose.ts), computed when
// read: nothing is re-extracted and no model runs.
//
// A dependency across repositories is `resolved` only with concrete evidence:
// files of the capability import a package (the knowledge graph's static
// imports, `pkg:<ecosystem>:<name>`) that the registry's CI publish provenance
// says exactly one other selected repository publishes, in a feed the caller
// can read. Anything else is `unresolved` (no selected repository publishes it,
// or several do), and capabilities that only share canonical concepts are
// `related`: similarity, never an import, call or dependency.

/** The knowledge graph's view of an imported package: `pkg:<ecosystem>:<name>`. */
export interface AtlasPackageRef {
  /** npm, crates, pypi or go: the importing language's ecosystem. */
  ecosystem: string;
  name: string;
}

/** How an import was matched to a registry package (each a fixed, documented rule). */
export type AtlasResolutionRule =
  /** npm: the import's package name equals the registry package name. */
  | "npm-name"
  /** Rust: `use foo_bar::…` and the cargo crate `foo-bar`/`foo_bar` (Cargo's lib-name rule). */
  | "cargo-crate"
  /** Python: the top-level module equals the PEP 503 name with `-` as `_`. */
  | "pypi-module"
  /** Go: the import path is the module path or inside it. */
  | "go-module";

/** The repository that publishes a package, from the registry's CI publish provenance. */
export interface AtlasPublisher {
  /** A selected, readable repository: the package names it a source. */
  repoId: string;
  /** The registry package: its format, feed (owner key) and name. */
  registry: { format: string; feed: string; name: string };
  /** Its latest publish from that repository when the snapshot was built, if any. */
  publish: {
    version: string;
    commit: string | null;
    ref: string | null;
    runNumber: number | null;
    at: string;
  } | null;
  rule: AtlasResolutionRule;
}

/** A source file at a snapshot's commit (inspectable, immutable). */
export interface AtlasFileRef {
  repoId: string;
  commit: string;
  path: string;
  blob: string | null;
}

/** Why a resolved dependency is one. */
export interface AtlasDependencyEvidence {
  package: AtlasPackageRef;
  publisher: AtlasPublisher;
  /** Files of the source capability that import the package: how many, and the first few by path. */
  importers: { total: number; files: AtlasFileRef[] };
  /**
   * The manifest governing the first importing file (the nearest package.json,
   * Cargo.toml, pyproject.toml/setup.cfg/setup.py/requirements.txt or go.mod
   * above it in that snapshot); null when there's none. Located by path only:
   * the Atlas doesn't read its contents, so it isn't proof of a declaration.
   */
  manifest: AtlasFileRef | null;
}

/**
 * `resolved`: a dependency with evidence. `unresolved`: an imported package no
 * selected repository publishes (`no-publisher`: maybe external, maybe outside
 * this scope; nothing more is known) or several do (`ambiguous`). `related`:
 * shared canonical concepts only.
 */
export type AtlasLinkState = "resolved" | "unresolved" | "related";

export interface AtlasCrossLink {
  state: AtlasLinkState;
  /** depends_on (resolved), imports (unresolved package import) or related. */
  kind: "depends_on" | "imports" | "related";
  /** A capability (or a repository's unclassified group), namespaced `<repoId>/<id>`. */
  src: string;
  /**
   * resolved: the publishing repository's root (`<repoId>/repo`), since a
   * package is published by a repository, not a capability. unresolved: the
   * package entity in the source's snapshot. related: the other capability.
   */
  dst: string;
  package: AtlasPackageRef | null;
  /** The entity at `dst` (related), or the source (`direction=in`). */
  neighbor: AtlasEntitySummary | null;
  /** resolved only. */
  evidence: AtlasDependencyEvidence | null;
  /** unresolved only. */
  unresolved: { reason: "no-publisher" | "ambiguous"; candidates: string[]; files: number } | null;
  /** related only: the canonical concepts both capabilities share (never a dependency). */
  concepts: { id: string; name: string }[] | null;
}

/** A capability spanning repositories, composed from repository capabilities. */
export interface AtlasCompositeCapability {
  /** `xcap:<hash of its anchor member's id>`: stable while its anchor stays a member. */
  id: string;
  kind: "composite-capability";
  /** From the concepts its members share; never model prose. */
  name: string;
  nameSource: "concepts" | "anchor";
  /** The largest member (by files, then id), namespaced. */
  anchor: string;
  /** Repository ids it spans (at least two). */
  repos: string[];
  /**
   * Its repository capabilities, largest first: each keeps its own name and
   * prose (summaries are repository-separated, never merged across repositories).
   */
  members: AtlasEntitySummary[];
  /** Files are each counted once: every file has one primary capability in its own repository. */
  counts: { files: number; capabilities: number; repos: number };
  /** Concepts shared by at least two members: id, name and how many members have it. */
  concepts: { id: string; name: string; members: number }[];
  /**
   * Why its members belong together: each link pairs a resolved dependency
   * (`from` imports packages `to`'s repository publishes) with the canonical
   * concepts both share. Evidence for a dependency: GET /links.
   */
  rationale: {
    from: string;
    to: string;
    publisher: string;
    packages: AtlasPackageRef[];
    concepts: { id: string; name: string }[];
  }[];
  composition: { producer: "atlas/compose"; version: number; evidence: string[] };
}

/** What a composition read from each selected repository. */
export interface AtlasCompositionCoverage {
  repoId: string;
  /** Capabilities composed (the largest first), of how many the snapshot has. */
  capabilities: { composed: number; total: number };
  /**
   * What the snapshot records the repository publishes: recorded, error (the
   * registry couldn't be read at build), unrecorded (built before it was
   * recorded) or none (no Atlas snapshot). Only recorded can resolve.
   */
  packages: "recorded" | "error" | "unrecorded" | "none";
  /** Imported packages considered for resolution, and whether there were more. */
  imports: { considered: number; truncated: boolean };
}

/** GET /api/accounts/:owner/atlas/composition */
export interface AtlasWorkspaceComposition extends AtlasWorkspacePage<AtlasCompositeCapability> {
  coverage: AtlasCompositionCoverage[];
  /** Resolved cross-repository dependencies (capability, package) in the scope. */
  resolved: number;
  /** Browsing composes with deterministic rules only. */
  inference: "none";
}

// ---- snapshot comparisons (CORE-175) -------------------------------------------
//
// What changed between two retained snapshots of one repository's main Atlas,
// `from` (older) and `to` (newer), both named explicitly. Each change record
// is a capability, area or file whose recorded state differs between them,
// classed by what kind of change it is; a record can be in several classes:
//
//   source      the code changed: a file added, removed or with another blob;
//               for a region, member files added or removed
//   regrouping  grouping placed things differently: a file's primary
//               capability/area moved, a region appeared, was retired (split,
//               merged, removed) or had files move in or out
//   summary     only the words changed: a file's summary with the same blob,
//               a region's name, summary or description state with the same
//               members (summary-only)
//   other       recorded differently with none of the above (analysis
//               details, concepts, layout, provenance…): `fields` says which
//
// Comparisons read only the rows that changed between the two snapshots
// (worker/atlas/compare.ts), are deterministic, and run no model. A snapshot
// past retention makes a comparison unavailable (`snapshot_expired`, with
// `side`), never an empty one. The model is the same whatever the two sides
// are, so a timeline-versus-main comparison can reuse it.

/** What kind of change a record is. */
export type AtlasChangeClass = "source" | "regrouping" | "summary" | "other";

export const ATLAS_CHANGE_CLASSES: readonly AtlasChangeClass[] = [
  "source",
  "regrouping",
  "summary",
  "other",
];

/** Which recorded parts of an entity differ between the two snapshots. */
export type AtlasChangeField =
  /** Its parent, primary capability or area. */
  | "placement"
  /** A file's blob. */
  | "source"
  | "name"
  | "summary"
  /** A region's model description (prose, or its current/stale/unavailable state). */
  | "description"
  /** Deduplicated counts. */
  | "counts"
  /** A file's membership evidence (rationale, cross-cutting references). */
  | "membership"
  /** A file's analysis (pending, skipped, language, role, lines, responsibilities). */
  | "analysis"
  | "concepts"
  | "layout"
  | "lineage"
  | "provenance";

/** One side of a change record: the entity as that snapshot recorded it. */
export interface AtlasChangeSide {
  name: string;
  path: string | null;
  parentId: string | null;
  /** A file's primary capability and area (null: unclassified, or not a file). */
  capability: string | null;
  area: string | null;
  /** A file's blob at that snapshot's commit. */
  blob: string | null;
  /** Cut to ATLAS_CATALOGUE_SUMMARY_CHARS. */
  summary: string;
  summaryTruncated: boolean;
  summaryState?: { status: AtlasDescriptionStatus; reason?: AtlasUnavailableReason };
  /** A region's primary files. */
  files: number | null;
}

/** An entity a record refers to, with its name in the snapshot it's from (null: not there). */
export interface AtlasChangeRef {
  id: string;
  share?: number;
  name: string | null;
}

export interface AtlasChange {
  id: string;
  kind: "capability" | "area" | "file";
  /** added: only in `to`; removed: only in `from`; changed: in both. */
  presence: "added" | "removed" | "changed";
  /** Never empty. */
  classes: AtlasChangeClass[];
  fields: AtlasChangeField[];
  from: AtlasChangeSide | null;
  to: AtlasChangeSide | null;
  /**
   * Names for the ids the sides mention (parents, capabilities, areas), each
   * read in the snapshot that mentions it.
   */
  names: Record<string, string>;
  /**
   * A region only in `to`: what the build that made it recorded (CORE-165).
   * Lineage is recorded build to build, so with builds between the two
   * snapshots a predecessor may itself be newer than `from` (its name is null then).
   */
  origin: {
    change: "split" | "merge" | "new";
    /** The snapshot sequence that recorded it; null when none was recorded. */
    since: number | null;
    predecessors: AtlasChangeRef[];
  } | null;
  /** A region only in `from`: its retirement between the two (successor names as `to` has them). */
  retired: {
    seq: number;
    change: "split" | "merged" | "removed";
    successors: AtlasChangeRef[];
  } | null;
  /**
   * A region: its member files between the two snapshots (moved in or out by
   * grouping; added or removed with the source). Null for files.
   */
  members: { movedIn: number; movedOut: number; added: number; removed: number } | null;
}

/** One side of a comparison: its snapshot, and the grouping version that built it. */
export interface AtlasComparisonSide {
  snapshot: AtlasSnapshotRef;
  groupingVersion: number | null;
}

/** Something that limits what a comparison can say. */
export type AtlasComparisonCaveat =
  /** Built by different projection or grouping versions: some regrouping is the algorithm's, not the code's. */
  | {
      code: "versions";
      from: { projection: number; grouping: number | null };
      to: { projection: number; grouping: number | null };
    }
  /** A side's upstream analysis was incomplete. */
  | { code: "partial"; side: "from" | "to" }
  /** Builds between the two: lineage was recorded build to build. */
  | { code: "between"; builds: number }
  /** Both sides were built from the same commit: nothing in the code changed. */
  | { code: "same-commit" }
  /** Capability relations aren't compared; read the lens on either snapshot. */
  | { code: "relations" };

/** Counts over the whole comparison (within its `within` filter, across classes). */
export interface AtlasComparisonSummary {
  /** Records in each class; a record can count in several. */
  classes: Record<AtlasChangeClass, number>;
  total: number;
  kinds: { capability: number; area: number; file: number };
  /** Source-level file changes. */
  files: { added: number; removed: number; modified: number };
  /**
   * Other entities (symbols, folders, components, concepts, packages) with
   * rows written between the two, which the records don't itemize: an upper
   * bound (a value changed and changed back counts). Null with `within`.
   */
  others: number | null;
}

/** GET /compare?from=&to=[&class=&within=] : a page of change records. `snapshot` is `to`. */
export interface AtlasComparison extends AtlasPage<AtlasChange> {
  from: AtlasComparisonSide;
  to: AtlasComparisonSide;
  /** The capability or area the records are limited to, as `to` (else `from`) has it. */
  within: AtlasEntitySummary | null;
  class: AtlasChangeClass | null;
  /** The first page's; null on continuation pages (it can't change: both sides are immutable). */
  summary: AtlasComparisonSummary | null;
  caveats: AtlasComparisonCaveat[];
}

/** A snapshot a comparison can name, as GET /snapshots lists it. */
export interface AtlasSnapshotListing extends AtlasSnapshotRef {
  /** current; retained (a readable prior); expired (past retention: unavailable to compare). */
  state: "current" | "retained" | "expired";
  groupingVersion: number | null;
  expiredReason: "age" | "count" | "storage" | null;
}

/** GET /snapshots: the scope's published snapshots, newest first. */
export interface AtlasSnapshotList {
  scope: string;
  current: string | null;
  items: AtlasSnapshotListing[];
  next: string | null;
}
