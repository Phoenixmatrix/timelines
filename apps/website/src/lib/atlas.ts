// A typed client for the Atlas read API (worker/atlas/api.ts, CORE-160).
//
// Every call can pin a snapshot; continuing a page passes its `next` cursor,
// which pins its own. Failures throw an ApiError whose `code` is an
// AtlasErrorCode: "snapshot_expired", "cursor_expired" and "cursor_invalid"
// mean start again (the error body names the current snapshot); never retry
// them silently against the current snapshot.

import type {
  AtlasAncestors,
  AtlasDetail,
  AtlasDirection,
  AtlasEntitySummary,
  AtlasErrorCode,
  AtlasEvidence,
  AtlasOverview,
  AtlasPage,
  AtlasRegion,
  AtlasRelation,
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
  api<T>(path(repo, route, { ...query, snapshot: request.snapshot }), { signal: request.signal });

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
