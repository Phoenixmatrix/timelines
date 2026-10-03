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
