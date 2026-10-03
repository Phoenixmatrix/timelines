// A typed client for the Atlas read API (worker/atlas/api.ts, CORE-160), and
// for the same pages over an explicit workspace scope (worker/atlas/workspace.ts,
// CORE-161) as `atlasWorkspaceApi`, with capabilities spanning repositories and
// their cross-repository links (CORE-167).
//
// Every call can pin a snapshot; continuing a page passes its `next` cursor,
// which pins its own. Failures throw an ApiError whose `code` is an
// AtlasErrorCode: "snapshot_expired", "cursor_expired" and "cursor_invalid"
// mean start again (the error body names the current snapshot); never retry
// them silently against the current snapshot.

import type {
  AtlasAncestors,
  AtlasContribution,
  AtlasCrossLink,
  AtlasDetail,
  AtlasDirection,
  AtlasEntitySummary,
  AtlasError,
  AtlasErrorCode,
  AtlasEvidence,
  AtlasLinkState,
  AtlasOverview,
  AtlasPage,
  AtlasRegion,
  AtlasRelation,
  AtlasWorkspaceAncestors,
  AtlasWorkspaceComposition,
  AtlasWorkspaceDetail,
  AtlasWorkspaceOverview,
  AtlasWorkspacePage,
} from "../../shared/atlas.ts";
import { api, ApiError } from "./api.ts";

export interface AtlasRepo {
  owner: string;
  name: string;
}

export interface AtlasRequest {
  /** Pin a snapshot; omitted, the current one (cursors carry their own). */
  snapshot?: string;
  signal?: AbortSignal;
}

export interface AtlasPageRequest extends AtlasRequest {
  cursor?: string | null;
  /** At most 100; the server clamps. */
  limit?: number;
}

function path(
  repo: AtlasRepo,
  route: string,
  query: Record<string, string | number | null | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const search = params.toString();
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/atlas/${route}${search ? `?${search}` : ""}`;
}

const get = <T>(
  repo: AtlasRepo,
  route: string,
  query: Record<string, string | number | null | undefined>,
  request: AtlasRequest,
) =>
  api<T>(path(repo, route, { ...query, snapshot: request.snapshot }), {
    signal: request.signal,
  }).catch((error: unknown) => {
    if (atlasAccessLost(error))
      for (const listener of lostListeners.get(repoKey(repo)) ?? []) listener();
    throw error;
  });

// ---- access lost (CORE-178) ----------------------------------------------------

const repoKey = (repo: AtlasRepo) => `${repo.owner}/${repo.name}`.toLowerCase();
const lostListeners = new Map<string, Set<() => void>>();

/**
 * The repository itself can't be read any more: access was revoked, it was
 * made private or deleted, or the session ended. The server answers every
 * Atlas route for it as a missing repository (a 404 or 401 with no Atlas
 * code), where Atlas errors about a snapshot, cursor or entity carry a code.
 */
export function atlasAccessLost(error: unknown): boolean {
  return error instanceof ApiError && !error.code && (error.status === 404 || error.status === 401);
}

/**
 * Call `listener` whenever an Atlas request for `repo` finds it unreadable,
 * so an open view can discard what it holds instead of keeping content its
 * viewer may no longer see. Returns the unsubscribe.
 */
export function onAtlasAccessLost(repo: AtlasRepo, listener: () => void): () => void {
  const key = repoKey(repo);
  const set = lostListeners.get(key) ?? new Set();
  set.add(listener);
  lostListeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) lostListeners.delete(key);
  };
}

const paged = (request: AtlasPageRequest) => ({ cursor: request.cursor, limit: request.limit });

export const atlasApi = {
  overview: (repo: AtlasRepo, request: AtlasRequest = {}) =>
    get<AtlasOverview>(repo, "overview", {}, request),
  /** The overview catalogue past its first page: pass `overview.catalogue.next`. */
  regions: (repo: AtlasRepo, request: AtlasPageRequest = {}) =>
    get<AtlasPage<AtlasRegion>>(repo, "regions", paged(request), request),
  children: (repo: AtlasRepo, id: string, request: AtlasPageRequest = {}) =>
    get<AtlasPage<AtlasEntitySummary>>(repo, "children", { id, ...paged(request) }, request),
  detail: (repo: AtlasRepo, id: string, request: AtlasRequest = {}) =>
    get<AtlasDetail>(repo, "detail", { id }, request),
  /** The file imports behind a capability relation, from `id` toward `other` (or back, with "in"). */
  contributing: (
    repo: AtlasRepo,
    id: string,
    other: string,
    direction: AtlasDirection,
    request: AtlasPageRequest = {},
  ) =>
    get<AtlasPage<AtlasContribution>>(
      repo,
      "contributing",
      { id, other, direction, ...paged(request) },
      request,
    ),
  ancestors: (repo: AtlasRepo, id: string, request: AtlasRequest = {}) =>
    get<AtlasAncestors>(repo, "ancestors", { id }, request),
  relations: (
    repo: AtlasRepo,
    id: string,
    direction: AtlasDirection,
    request: AtlasPageRequest & { kind?: string } = {},
  ) =>
    get<AtlasPage<AtlasRelation>>(
      repo,
      "relations",
      { id, direction, kind: request.kind, ...paged(request) },
      request,
    ),
  evidence: (repo: AtlasRepo, id: string, request: AtlasPageRequest = {}) =>
    get<AtlasPage<AtlasEvidence>>(repo, "evidence", { id, ...paged(request) }, request),
  /** Entities whose name or path contains `q`: a projection lookup, not search. */
  catalogue: (repo: AtlasRepo, q: string, request: AtlasPageRequest & { kind?: string } = {}) =>
    get<AtlasPage<AtlasEntitySummary>>(
      repo,
      "catalogue",
      { q, kind: request.kind, ...paged(request) },
      request,
    ),
  /** Capabilities spanning the selected repositories, largest first. */
  composition: (workspace: AtlasWorkspace, request: AtlasPageRequest = {}) =>
    getIn<AtlasWorkspaceComposition>(workspace, "composition", paged(request), request),
  /**
   * A capability's (or a repository's unclassified files') cross-repository
   * links: `resolved` dependencies with evidence, `unresolved` package
   * imports, or `related` capabilities (shared concepts, not a dependency).
   * `direction: "in"` lists resolved dependencies on a repository (`<repoId>/repo`).
   */
  links: (
    workspace: AtlasWorkspace,
    id: string,
    state: AtlasLinkState,
    request: AtlasPageRequest & { direction?: AtlasDirection } = {},
  ) =>
    getIn<AtlasWorkspacePage<AtlasCrossLink>>(
      workspace,
      "links",
      { id, state, direction: request.direction, ...paged(request) },
      request,
    ),
};

/**
 * An explicit workspace selection: repository names under one owning account.
 * The server re-authorizes it on every call and silently keeps only what the
 * caller can read; `snapshot.repos` in each response says which, and their
 * states. A tracker workspace's repositories can seed `repos`.
 */
export interface AtlasWorkspace {
  owner: string;
  repos: string[];
}

function workspacePath(
  workspace: AtlasWorkspace,
  route: string,
  query: Record<string, string | number | null | undefined>,
) {
  const params = new URLSearchParams();
  params.set("repos", [...new Set(workspace.repos)].sort().join(","));
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  return `/accounts/${encodeURIComponent(workspace.owner)}/atlas/${route}?${params.toString()}`;
}

const getIn = <T>(
  workspace: AtlasWorkspace,
  route: string,
  query: Record<string, string | number | null | undefined>,
  request: AtlasRequest,
) =>
  api<T>(workspacePath(workspace, route, { ...query, snapshot: request.snapshot }), {
    signal: request.signal,
  });

/**
 * The Atlas across a workspace. Entity ids are `<repoId>/<id>` as the
 * responses give them; `snapshot` pins the composite id from a response.
 */
export const atlasWorkspaceApi = {
  overview: (workspace: AtlasWorkspace, request: AtlasRequest = {}) =>
    getIn<AtlasWorkspaceOverview>(workspace, "overview", {}, request),
  regions: (workspace: AtlasWorkspace, request: AtlasPageRequest = {}) =>
    getIn<AtlasWorkspacePage<AtlasRegion>>(workspace, "regions", paged(request), request),
  children: (workspace: AtlasWorkspace, id: string, request: AtlasPageRequest = {}) =>
    getIn<AtlasWorkspacePage<AtlasEntitySummary>>(
      workspace,
      "children",
      { id, ...paged(request) },
      request,
    ),
  detail: (workspace: AtlasWorkspace, id: string, request: AtlasRequest = {}) =>
    getIn<AtlasWorkspaceDetail>(workspace, "detail", { id }, request),
  ancestors: (workspace: AtlasWorkspace, id: string, request: AtlasRequest = {}) =>
    getIn<AtlasWorkspaceAncestors>(workspace, "ancestors", { id }, request),
  relations: (
    workspace: AtlasWorkspace,
    id: string,
    direction: AtlasDirection,
    request: AtlasPageRequest & { kind?: string } = {},
  ) =>
    getIn<AtlasWorkspacePage<AtlasRelation>>(
      workspace,
      "relations",
      { id, direction, kind: request.kind, ...paged(request) },
      request,
    ),
  evidence: (workspace: AtlasWorkspace, id: string, request: AtlasPageRequest = {}) =>
    getIn<AtlasWorkspacePage<AtlasEvidence>>(
      workspace,
      "evidence",
      { id, ...paged(request) },
      request,
    ),
  catalogue: (
    workspace: AtlasWorkspace,
    q: string,
    request: AtlasPageRequest & { kind?: string } = {},
  ) =>
    getIn<AtlasWorkspacePage<AtlasEntitySummary>>(
      workspace,
      "catalogue",
      { q, kind: request.kind, ...paged(request) },
      request,
    ),
  /** Capabilities spanning the selected repositories, largest first. */
  composition: (workspace: AtlasWorkspace, request: AtlasPageRequest = {}) =>
    getIn<AtlasWorkspaceComposition>(workspace, "composition", paged(request), request),
  /**
   * A capability's (or a repository's unclassified files') cross-repository
   * links: `resolved` dependencies with evidence, `unresolved` package
   * imports, or `related` capabilities (shared concepts, not a dependency).
   * `direction: "in"` lists resolved dependencies on a repository (`<repoId>/repo`).
   */
  links: (
    workspace: AtlasWorkspace,
    id: string,
    state: AtlasLinkState,
    request: AtlasPageRequest & { direction?: AtlasDirection } = {},
  ) =>
    getIn<AtlasWorkspacePage<AtlasCrossLink>>(
      workspace,
      "links",
      { id, state, direction: request.direction, ...paged(request) },
      request,
    ),
};

const RESTART: ReadonlySet<string> = new Set<AtlasErrorCode>([
  "snapshot_expired",
  "snapshot_unknown",
  "cursor_expired",
  "cursor_invalid",
]);

/** The pinned view can't continue: offer an explicit move to the current snapshot. */
export function atlasNeedsRestart(error: unknown): boolean {
  return error instanceof ApiError && error.code !== undefined && RESTART.has(error.code);
}

/**
 * The Atlas error behind a failed call: its code, message and, where the API
 * gives them, the scope's current snapshot (for an explicit "open the current
 * view"), when and why a snapshot expired, and a retired entity's lineage.
 * Null for anything that isn't an Atlas API error.
 */
export function atlasErrorOf(error: unknown): AtlasError | null {
  if (!(error instanceof ApiError) || !error.code) return null;
  const body = (error.body ?? {}) as Partial<AtlasError>;
  return {
    error: error.message,
    code: error.code as AtlasErrorCode,
    current: body.current ?? null,
    ...(body.expired ? { expired: body.expired } : {}),
    ...(body.lineage ? { lineage: body.lineage } : {}),
  };
}
