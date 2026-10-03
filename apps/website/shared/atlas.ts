// The Atlas read API (CORE-160): bounded, snapshot-pinned pages over a
// repository's published Atlas projection. Served by worker/atlas/api.ts under
// /api/repos/:owner/:name/atlas, read by src/lib/atlas.ts.
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
  | "bad_request";

export interface AtlasError {
  error: string;
  code: AtlasErrorCode;
  /** The scope's current snapshot, for an explicit "go to current" action. */
  current?: { id: string; seq: number } | null;
  /** With snapshot_expired: when and why retention expired it. */
  expired?: { at: string; reason: "age" | "count" | "storage" };
}
