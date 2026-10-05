// The Atlas read API (CORE-160), mounted at /api/repos/:owner/:name/atlas.
//
//   GET /overview[?snapshot=]                      the root and the ≤12 largest top-level
//                                                  regions, the imports between them,
//                                                  plus the first catalogue page
//   GET /regions?cursor=                           more of that catalogue
//   GET /children?id=[&cursor=&limit=]             an entity's children, by name
//   GET /detail?id=                                an entity, its ancestors and counts
//   GET /ancestors?id=                             root-first ancestry, for deep links
//   GET /relations?id=&direction=in|out[&kind=]    one-hop edges with their other ends
//   GET /evidence?id=                              source locations backing an entity
//   GET /catalogue?q=[&kind=]                      entities whose name or path contains q
//   GET /snapshots[?cursor=]                       published snapshots, newest first
//   GET /compare?from=&to=[&class=&within=]        what changed between two retained
//                                                  snapshots (worker/atlas/compare.ts)
//   GET /timeline?ref=timeline/<slug>[&within=]    what a timeline changes, placed in
//                                                  capabilities (worker/atlas/timeline.ts)
//
// Every route authorizes the repository first (unreadable looks like missing),
// then reads only the published projection (worker/atlas/projection.ts): no
// model, no Vectorize, no AI Search. Every response names its snapshot; any
// route takes `?snapshot=` to pin one, and every page's `next` cursor pins it
// too (worker/atlas/cursor.ts). Pages hold at most ATLAS_PAGE_MAX records.
//
// Snapshots come and go under retention (worker/atlas/retention.ts), which
// can expire a snapshot and delete part of its rows at any time, cursors open
// or not. So every pinned request and every cursor page resolves its snapshot
// with retention's `pinnedSnapshot` before reading a row, and an expired one
// is an explicit `snapshot_expired` naming the current snapshot, never a
// silent switch. A cursor expires at retention's `cursorExpiresAt` from its
// issue time and its snapshot's expiry as it stands now.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ATLAS_CATALOGUE_SUMMARY_CHARS,
  ATLAS_OVERVIEW_AREAS,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_OVERVIEW_SUMMARY_CHARS,
  ATLAS_PAGE_DEFAULT,
  ATLAS_PAGE_MAX,
  type AtlasAncestors,
  type AtlasCounts,
  type AtlasDetail,
  type AtlasEntity,
  type AtlasDescription,
  type AtlasEntitySummary,
  type AtlasLayout,
  type AtlasContribution,
  type AtlasError,
  type AtlasErrorCode,
  type AtlasEvidence,
  type AtlasOverview,
  type AtlasPage,
  type AtlasRegion,
  type AtlasRelation,
  type AtlasSnapshotRef,
  ATLAS_CHANGE_CLASSES,
  type AtlasChangeClass,
  type AtlasComparison,
  type AtlasComparisonCaveat,
  type AtlasSnapshotList,
  type AtlasSnapshotListing,
  type AtlasTimeline,
} from "../../shared/atlas.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import type { RepoRow } from "../db.ts";
import { overlayRef } from "../knowledge/overlay.ts";
import {
  cursorSecret,
  signCursor,
  verifyCursor,
  type CursorBinding,
  type CursorState,
} from "./cursor.ts";
import {
  ancestorsAt,
  catalogueAt,
  catalogueCountAt,
  childCountAt,
  childrenAt,
  edgeCountsAt,
  entityAt,
  evidenceCountAt,
  areasAt,
  evidenceFilesAt,
  regionLinksAt,
  regionsAt,
  relationsAt,
  repoScope,
  ROOT,
  currentSnapshot,
  type AtlasEntity as ProjectedEntity,
  type AtlasSnapshot,
  type RegionKey,
  type RelationKey,
  contributingAt,
  edgesAt,
  toSnapshot,
} from "./projection.ts";
import { lineageOf } from "./identity.ts";
import { comparePage, compareSummary, type CompareKey } from "./compare.ts";
import { capacityFailure, cursorExpiresAt, pinnedSnapshot } from "./retention.ts";
import { readTimelineState, timelineView } from "./timeline.ts";

export const atlas = new Hono<AppEnv>();

type C = Context<AppEnv>;

export function failWith(
  c: C,
  status: ContentfulStatusCode,
  code: AtlasErrorCode,
  error: string,
  current?: { id: string; seq: number | null } | null,
  extra: Partial<AtlasError> = {},
) {
  const body: AtlasError = { error, code, ...extra };
  if (current !== undefined) body.current = current ? { id: current.id, seq: current.seq } : null;
  return c.json(body, status);
}

/** What a response says about its snapshot. */
export const refOf = (snapshot: AtlasSnapshot): AtlasSnapshotRef => ({
  id: snapshot.id,
  seq: snapshot.seq,
  vector: snapshot.vector,
  publishedAt: snapshot.publishedAt,
  partial: snapshot.partial,
  projectionVersion: snapshot.projectionVersion,
  expiresAt: snapshot.expiresAt,
});

// ---- shaping -------------------------------------------------------------------

const cut = (text: string, max: number) =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

function countsOf(data: Record<string, unknown>): Record<string, number> {
  const raw = data.counts;
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

export function lean(entity: ProjectedEntity): AtlasEntitySummary {
  return {
    id: entity.id,
    kind: entity.kind,
    parentId: entity.parentId,
    name: entity.name,
    path: entity.path,
    summary: entity.summary,
    counts: countsOf(entity.data),
    structural: entity.kind === "group" || entity.data.structural === true,
    ...summaryStateOf(entity.data),
    ...(entity.since === undefined ? {} : { since: entity.since }),
    ...layoutOf(entity.data),
  };
}

function layoutOf(data: Record<string, unknown>): Pick<AtlasEntitySummary, "layout"> {
  const l = data.layout as AtlasLayout | undefined;
  if (!l || typeof l !== "object" || typeof l.slot !== "number") return {};
  return { layout: { slot: l.slot, col: l.col, row: l.row, bucket: l.bucket, fill: l.fill } };
}

/** A described entity's summary state (CORE-164), so lists can label stale or missing prose. */
function summaryStateOf(data: Record<string, unknown>): Pick<AtlasEntitySummary, "summaryState"> {
  const d = data.description as AtlasDescription | undefined;
  if (!d || typeof d !== "object" || typeof d.status !== "string") return {};
  return { summaryState: d.reason ? { status: d.status, reason: d.reason } : { status: d.status } };
}

export const full = (entity: ProjectedEntity): AtlasEntity => ({
  ...lean(entity),
  data: entity.data,
});

export function region(
  entity: ProjectedEntity & { files: number; members: number },
  summaryChars: number,
): AtlasRegion {
  const summary = cut(entity.summary, summaryChars);
  return {
    ...lean(entity),
    summary: summary.text,
    summaryTruncated: summary.truncated,
    size: { files: entity.files, members: entity.members },
  };
}

/** A region as an overview shows it: with its first areas, when it has any, for the map. */
export function overviewRegion(
  entity: ProjectedEntity & { files: number; members: number },
  areas: readonly ProjectedEntity[] | undefined,
): AtlasRegion {
  const shaped = region(entity, ATLAS_OVERVIEW_SUMMARY_CHARS);
  if (!areas?.length) return shaped;
  return {
    ...shaped,
    areas: areas.map((a) =>
      lean({ ...a, summary: cut(a.summary, ATLAS_CATALOGUE_SUMMARY_CHARS).text }),
    ),
  };
}

// ---- request context -----------------------------------------------------------

interface Pinned<K> {
  scope: string;
  repoId: string;
  repo: RepoRow;
  snapshot: AtlasSnapshotRef;
  /** The verified cursor, when the request continues a traversal. */
  cursor: CursorState<K> | null;
  binding: CursorBinding;
  secret: string;
}

export function principalOf(c: C): string {
  const actor = c.get("actor");
  if (!actor) return "anonymous";
  return actor.agent ? `user:${actor.id}/agent:${actor.agent.id}` : `user:${actor.id}`;
}

/**
 * Authorize, then work out which snapshot the request reads: its cursor's,
 * else `?snapshot=`, else the current one. A pinned snapshot (cursor or
 * query) goes through retention's `pinnedSnapshot` on every request, so an
 * eviction mid-traversal stops the next page with `snapshot_expired`.
 * Unknown and expired snapshots are explicit errors. Nothing request-supplied
 * is read before authorization.
 */
async function pin<K>(
  c: C,
  route: string,
  filters: Record<string, string | null>,
  /** A comparison pins its `to` snapshot (not `?snapshot=`), and says so in errors. */
  options: { snapshot?: string; side?: "to" } = {},
): Promise<Pinned<K> | Response> {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  if (route !== "timeline" && c.req.query("source") && c.req.query("source") !== "canonical")
    return failWith(
      c,
      400,
      "bad_request",
      "Atlas projections describe canonical sources; use the timeline view for work sources.",
    );
  const d1 = c.env.DB;
  const scope = repoScope(loaded.row.id);
  const secret = await cursorSecret(c.env);
  const binding: CursorBinding = { route, scope, filters, principal: principalOf(c) };
  const requested = (options.snapshot ?? c.req.query("snapshot")) || null;
  const side = options.side ? { side: options.side } : {};
  const restart = async (code: AtlasErrorCode, status: ContentfulStatusCode, error: string) =>
    failWith(c, status, code, error, await currentSnapshot(d1, scope), side);

  let cursor: CursorState<K> | null = null;
  const raw = c.req.query("cursor");
  if (raw) {
    const verified = await verifyCursor<K>(secret, binding, raw);
    if (!verified.ok)
      return restart(
        "cursor_invalid",
        400,
        "This page link doesn't belong to this request. Start again.",
      );
    cursor = verified.state;
    if (requested && requested !== cursor.snapshot)
      return restart(
        "cursor_invalid",
        400,
        "This page link belongs to another snapshot. Start again.",
      );
  }

  const id = cursor?.snapshot ?? requested;
  if (!id) {
    const current = await currentSnapshot(d1, scope);
    if (!current)
      return failWith(
        c,
        404,
        "atlas_unavailable",
        "This repository has no Atlas yet. It appears after a Knowledge build.",
        null,
      );
    return {
      scope,
      repoId: loaded.row.id,
      repo: loaded.row,
      snapshot: refOf(current),
      cursor,
      binding,
      secret,
    };
  }
  const now = Date.now();
  const pinned = await pinnedSnapshot(d1, scope, id, new Date(now));
  if (pinned.state === "unknown")
    return restart("snapshot_unknown", 404, "There's no such Atlas snapshot here.");
  if (pinned.state === "expired")
    return failWith(
      c,
      410,
      "snapshot_expired",
      "This Atlas snapshot has expired. Open the current one instead.",
      pinned.current,
      { expired: { at: pinned.expiredAt, reason: pinned.reason }, ...side },
    );
  if (cursor && now >= cursorExpiresAt(cursor.issuedAt, pinned.snapshot.expiresAt))
    return restart("cursor_expired", 410, "This page link has expired. Start again.");
  return {
    scope,
    repoId: loaded.row.id,
    repo: loaded.row,
    snapshot: refOf(pinned.snapshot),
    cursor,
    binding,
    secret,
  };
}

export function limitOf(c: C): number | Response {
  const raw = c.req.query("limit");
  if (!raw) return ATLAS_PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    return failWith(c, 400, "bad_request", "limit must be a positive whole number.");
  return Math.min(n, ATLAS_PAGE_MAX);
}

const rawId = (c: C) => c.req.query("id") ?? "";

/** The requested entity id; checked after authorization, like everything request-supplied. */
function idOf(c: C): string | Response {
  const id = c.req.query("id");
  if (!id || id.length > 2048) return failWith(c, 400, "bad_request", "Name an entity with ?id=.");
  return id;
}

/** Shape a page: cumulative counts, and a cursor for the rest when there is any. */
async function page<T, K>(
  ctx: Pinned<K>,
  items: T[],
  next: K | null,
  countAll: () => Promise<number>,
): Promise<AtlasPage<T>> {
  const loaded = (ctx.cursor?.loaded ?? 0) + items.length;
  // Counted once, on the first page: the snapshot can't change under the traversal.
  const knownTotal = ctx.cursor ? ctx.cursor.total : await countAll();
  const counts: AtlasCounts = { loaded, knownTotal, unknownTotal: ctx.snapshot.partial };
  return {
    scope: ctx.scope,
    snapshot: ctx.snapshot,
    items,
    counts,
    next:
      next === null
        ? null
        : await signCursor(ctx.secret, ctx.binding, {
            snapshot: ctx.snapshot.id,
            after: next,
            loaded,
            total: knownTotal,
            issuedAt: Date.now(),
          }),
  };
}

async function entityOr404<K>(c: C, ctx: Pinned<K>, id: string) {
  const entity = await entityAt(c.env.DB, ctx.scope, ctx.snapshot.seq, id);
  if (entity) return entity;
  // A capability or area a later build retired: say where it went.
  const lineage = await lineageOf(c.env.DB, ctx.scope, id, ctx.snapshot.seq);
  return lineage
    ? failWith(
        c,
        404,
        "entity_unknown",
        `"${lineage.name}" was ${lineage.change === "removed" ? "removed" : lineage.change} in a later build.`,
        undefined,
        { lineage },
      )
    : failWith(c, 404, "entity_unknown", "That isn't in this Atlas snapshot.");
}

// ---- routes --------------------------------------------------------------------

atlas.get("/overview", async (c) => {
  const ctx = await pin<RegionKey>(c, "regions", {});
  if (ctx instanceof Response) return ctx;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const [root, top, totalRegions, capacity] = await Promise.all([
    entityAt(d1, ctx.scope, seq, ROOT),
    regionsAt(d1, ctx.scope, seq, null, ATLAS_OVERVIEW_REGIONS),
    childCountAt(d1, ctx.scope, seq, ROOT),
    capacityFailure(d1, ctx.scope),
  ]);
  const ids = top.regions.map((r) => r.id);
  const [rest, links, areas] = await Promise.all([
    top.next
      ? regionsAt(d1, ctx.scope, seq, top.next, ATLAS_PAGE_DEFAULT)
      : { regions: [], next: null },
    regionLinksAt(d1, ctx.scope, seq, ids),
    areasAt(d1, ctx.scope, seq, ids, ATLAS_OVERVIEW_AREAS),
  ]);
  // The overview always starts the catalogue; /regions continues it.
  const catalogue = await page(
    { ...ctx, cursor: null },
    rest.regions.map((r) => region(r, ATLAS_CATALOGUE_SUMMARY_CHARS)),
    rest.next,
    async () => Math.max(0, totalRegions - top.regions.length),
  );
  const body: AtlasOverview = {
    scope: ctx.scope,
    snapshot: ctx.snapshot,
    root: root
      ? lean({ ...root, summary: cut(root.summary, ATLAS_OVERVIEW_SUMMARY_CHARS).text })
      : null,
    regions: top.regions.map((r) => overviewRegion(r, areas.get(r.id))),
    catalogue,
    totalRegions,
    links,
    capacityFailure: capacity,
  };
  return c.json(body);
});

/** The overview's catalogue: top-level regions past the first ATLAS_OVERVIEW_REGIONS, ranked. */
atlas.get("/regions", async (c) => {
  const ctx = await pin<RegionKey>(c, "regions", {});
  if (ctx instanceof Response) return ctx;
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  let after = ctx.cursor?.after ?? null;
  if (!ctx.cursor) {
    const top = await regionsAt(d1, ctx.scope, seq, null, ATLAS_OVERVIEW_REGIONS);
    if (!top.next) {
      return c.json(await page(ctx, [] as AtlasRegion[], null, async () => 0));
    }
    after = top.next;
  }
  const rest = await regionsAt(d1, ctx.scope, seq, after, limit);
  return c.json(
    await page(
      ctx,
      rest.regions.map((r) => region(r, ATLAS_CATALOGUE_SUMMARY_CHARS)),
      rest.next,
      async () =>
        Math.max(0, (await childCountAt(d1, ctx.scope, seq, ROOT)) - ATLAS_OVERVIEW_REGIONS),
    ),
  );
});

atlas.get("/children", async (c) => {
  const ctx = await pin<string>(c, "children", { id: rawId(c) });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const result = await childrenAt(d1, ctx.scope, seq, id, ctx.cursor?.after ?? null, limit);
  return c.json(
    await page(ctx, result.entities.map(lean), result.next, () =>
      childCountAt(d1, ctx.scope, seq, id),
    ),
  );
});

atlas.get("/detail", async (c) => {
  const ctx = await pin(c, "detail", { id: rawId(c) });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const [chain, children, outgoing, incoming] = await Promise.all([
    ancestorsAt(d1, ctx.scope, seq, id),
    childCountAt(d1, ctx.scope, seq, id),
    edgeCountsAt(d1, ctx.scope, seq, id, false),
    edgeCountsAt(d1, ctx.scope, seq, id, true),
  ]);
  const body: AtlasDetail = {
    scope: ctx.scope,
    snapshot: ctx.snapshot,
    entity: full(entity),
    ancestors: chain.ancestors.map(lean),
    counts: { children, outgoing, incoming },
  };
  return c.json(body);
});

atlas.get("/ancestors", async (c) => {
  const ctx = await pin(c, "ancestors", { id: rawId(c) });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const chain = await ancestorsAt(c.env.DB, ctx.scope, ctx.snapshot.seq, id);
  const body: AtlasAncestors = {
    scope: ctx.scope,
    snapshot: ctx.snapshot,
    entity: lean(entity),
    ancestors: chain.ancestors.map(lean),
  };
  return c.json(body);
});

atlas.get("/relations", async (c) => {
  const direction = c.req.query("direction") ?? "out";
  const kind = c.req.query("kind") || null;
  const ctx = await pin<RelationKey>(c, "relations", { id: rawId(c), direction, kind });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  if (direction !== "in" && direction !== "out")
    return failWith(c, 400, "bad_request", "direction is in or out.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const incoming = direction === "in";
  const result = await relationsAt(
    d1,
    ctx.scope,
    seq,
    id,
    incoming,
    kind,
    ctx.cursor?.after ?? null,
    limit,
  );
  const items: AtlasRelation[] = result.relations.map((r) => ({
    ...r,
    neighbor: r.neighbor ? lean(r.neighbor) : null,
  }));
  return c.json(
    await page(ctx, items, result.next, async () =>
      Object.values(await edgeCountsAt(d1, ctx.scope, seq, id, incoming, kind)).reduce(
        (a, b) => a + b,
        0,
      ),
    ),
  );
});

/**
 * The file imports behind a capability relation (CORE-169): ?id=<capability>
 * &other=<capability>&direction=out|in, paged by (src, dst). The total is the
 * relation's weight, counted when the capability edges were built.
 */
atlas.get("/contributing", async (c) => {
  const direction = c.req.query("direction") ?? "out";
  const other = c.req.query("other") ?? "";
  const ctx = await pin<[string, string]>(c, "contributing", { id: rawId(c), other, direction });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  if (direction !== "in" && direction !== "out")
    return failWith(c, 400, "bad_request", "direction is in or out.");
  if (!other)
    return failWith(c, 400, "bad_request", "other names the capability at the other end.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const [from, to] = direction === "out" ? [id, other] : [other, id];
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const result = await contributingAt(
    d1,
    ctx.scope,
    seq,
    from,
    to,
    ctx.cursor?.after ?? null,
    limit,
  );
  const items: AtlasContribution[] = result.links;
  return c.json(
    await page(ctx, items, result.next, async () => {
      const edge = (await edgesAt(d1, ctx.scope, seq, from, false)).find(
        (e) => e.dst === to && e.kind === "depends_on",
      );
      return edge?.weight ?? 0;
    }),
  );
});

export function analysisOf(data: Record<string, unknown>): AtlasEvidence["analysis"] {
  if (data.pending) return "pending";
  if (data.skipped) return "skipped";
  return "analyzed";
}

atlas.get("/evidence", async (c) => {
  const ctx = await pin<string>(c, "evidence", { id: rawId(c) });
  if (ctx instanceof Response) return ctx;
  const id = idOf(c);
  if (id instanceof Response) return id;
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const entity = await entityOr404(c, ctx, id);
  if (entity instanceof Response) return entity;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const commit = ctx.snapshot.vector.find((v) => v.repoId === ctx.repoId)?.commit ?? "";
  const fileEvidence = (file: ProjectedEntity, via: string): AtlasEvidence => {
    const lines = typeof file.data.lines === "number" ? file.data.lines : null;
    return {
      entityId: file.id,
      kind: "file",
      repoId: ctx.repoId,
      sourceId: "canonical",
      commit,
      path: file.path ?? "",
      blob: typeof file.data.blob === "string" ? file.data.blob : null,
      range: lines
        ? { startLine: 1, endLine: lines, status: "whole-file" }
        : { startLine: null, endLine: null, status: "unavailable" },
      via,
      analysis: analysisOf(file.data),
    };
  };

  if (entity.kind === "file") {
    return c.json(await page(ctx, [fileEvidence(entity, "self")], null, async () => 1));
  }
  if (entity.kind === "symbol") {
    // A symbol's evidence is where it's defined: its file, from its first line.
    const file = entity.parentId ? await entityAt(d1, ctx.scope, seq, entity.parentId) : null;
    const line = typeof entity.data.line === "number" ? entity.data.line : null;
    const items: AtlasEvidence[] =
      file?.kind === "file"
        ? [
            {
              ...fileEvidence(file, "defines"),
              entityId: entity.id,
              kind: "symbol",
              range: line
                ? { startLine: line, endLine: null, status: "start-line" }
                : { startLine: null, endLine: null, status: "unavailable" },
            },
          ]
        : [];
    return c.json(await page(ctx, items, null, async () => items.length));
  }
  const result = await evidenceFilesAt(d1, ctx.scope, seq, id, ctx.cursor?.after ?? null, limit);
  return c.json(
    await page(
      ctx,
      result.files.map((f) => fileEvidence(f, f.via)),
      result.next,
      () => evidenceCountAt(d1, ctx.scope, seq, id),
    ),
  );
});

atlas.get("/catalogue", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const kind = c.req.query("kind") || null;
  const ctx = await pin<string>(c, "catalogue", { q, kind });
  if (ctx instanceof Response) return ctx;
  if (q.length > 200) return failWith(c, 400, "bad_request", "That lookup is too long.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const result = await catalogueAt(d1, ctx.scope, seq, q, kind, ctx.cursor?.after ?? null, limit);
  return c.json(
    await page(ctx, result.entities.map(lean), result.next, () =>
      catalogueCountAt(d1, ctx.scope, seq, q, kind),
    ),
  );
});

// ---- snapshots and comparisons (CORE-175) --------------------------------------

/**
 * The scope's published snapshots, newest first, with which are still
 * readable: what a comparison can name. Expired ones stay listed (while
 * retention keeps their record) so a person sees why one can't be compared.
 */
atlas.get("/snapshots", async (c) => {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  if (c.req.query("source") && c.req.query("source") !== "canonical")
    return failWith(c, 400, "bad_request", "Atlas snapshots describe canonical sources.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  const scope = repoScope(loaded.row.id);
  const secret = await cursorSecret(c.env);
  const binding: CursorBinding = {
    route: "snapshots",
    scope,
    filters: {},
    principal: principalOf(c),
  };
  let before = Number.MAX_SAFE_INTEGER;
  const raw = c.req.query("cursor");
  if (raw) {
    const verified = await verifyCursor<number>(secret, binding, raw);
    if (!verified.ok || typeof verified.state.after !== "number")
      return failWith(
        c,
        400,
        "cursor_invalid",
        "This page link doesn't belong to this request. Start again.",
      );
    if (Date.now() >= cursorExpiresAt(verified.state.issuedAt, null))
      return failWith(c, 410, "cursor_expired", "This page link has expired. Start again.");
    before = verified.state.after;
  }
  const rows = await d1
    .prepare(
      `SELECT s.*, c.snapshot_id AS current_id FROM atlas_snapshots s
       LEFT JOIN atlas_current c ON c.snapshot_id = s.id
       WHERE s.scope = ? AND s.status IN ('published', 'expired') AND s.seq < ?
       ORDER BY s.seq DESC LIMIT ?`,
    )
    .bind(scope, before, limit + 1)
    .all<
      Parameters<typeof toSnapshot>[0] & {
        grouping_version: number | null;
        current_id: string | null;
      }
    >();
  const now = new Date().toISOString();
  const page = rows.results.slice(0, limit);
  const items: AtlasSnapshotListing[] = page.map((row) => ({
    ...refOf(toSnapshot(row)),
    // As retention's pinnedSnapshot decides: a prior past its expiry is expired already.
    state: row.current_id
      ? "current"
      : row.status === "expired" || (row.expires_at !== null && row.expires_at <= now)
        ? "expired"
        : "retained",
    groupingVersion: row.grouping_version,
    expiredReason: (row.expired_reason as AtlasSnapshotListing["expiredReason"]) ?? null,
  }));
  const current = await currentSnapshot(d1, scope);
  const last = page.at(-1);
  const body: AtlasSnapshotList = {
    scope,
    current: current?.id ?? null,
    items,
    next:
      rows.results.length > limit && last
        ? await signCursor(secret, binding, {
            snapshot: "",
            after: Number(last.seq),
            loaded: 0,
            total: null,
            issuedAt: Date.now(),
          })
        : null,
  };
  return c.json(body);
});

/**
 * What changed between two retained snapshots, `from` older than `to`, both
 * named: change records classed source / regrouping / summary / other,
 * optionally only one class or within one capability or area. `to` pins the
 * pages as `?snapshot=` does elsewhere, and the cursor is bound to `from`,
 * the class and `within` too. Either snapshot past retention makes the
 * comparison unavailable (an explicit error naming the side), never empty.
 */
atlas.get("/compare", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const cls = c.req.query("class") || null;
  const within = c.req.query("within") || null;
  if (!from || !to || from.length > 2048 || to.length > 2048) {
    // Still authorize first: an unreadable repository looks missing whatever was asked.
    const loaded = await loadRepo(c, "read");
    if (loaded instanceof Response) return loaded;
    return failWith(c, 400, "bad_request", "Name both snapshots: ?from=<older>&to=<newer>.");
  }
  const ctx = await pin<CompareKey>(
    c,
    "compare",
    { from, to, class: cls, within },
    { snapshot: to, side: "to" },
  );
  if (ctx instanceof Response) return ctx;
  if (cls !== null && !(ATLAS_CHANGE_CLASSES as readonly string[]).includes(cls))
    return failWith(
      c,
      400,
      "bad_request",
      "class is source, regrouping, summary, evidence or other.",
    );
  if (within !== null && within.length > 2048)
    return failWith(c, 400, "bad_request", "That capability id is too long.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  const older = await pinnedSnapshot(d1, ctx.scope, from);
  if (older.state === "unknown")
    return failWith(
      c,
      404,
      "snapshot_unknown",
      "The earlier snapshot isn't one this repository has, so this comparison is unavailable.",
      await currentSnapshot(d1, ctx.scope),
      { side: "from" },
    );
  if (older.state === "expired")
    return failWith(
      c,
      410,
      "snapshot_expired",
      "The earlier snapshot has expired, so this comparison is unavailable. That isn't the same as no changes.",
      older.current,
      { expired: { at: older.expiredAt, reason: older.reason }, side: "from" },
    );
  const fromRef = refOf(older.snapshot);
  if (fromRef.seq >= ctx.snapshot.seq)
    return failWith(c, 400, "bad_request", "from must be an older snapshot than to.");

  const toSeq = ctx.snapshot.seq;
  let withinEntity: ProjectedEntity | null = null;
  if (within) {
    withinEntity =
      (await entityAt(d1, ctx.scope, toSeq, within)) ??
      (await entityAt(d1, ctx.scope, fromRef.seq, within));
    if (!withinEntity)
      return failWith(
        c,
        404,
        "entity_unknown",
        "That isn't in either snapshot of this comparison.",
      );
    if (withinEntity.kind !== "capability" && withinEntity.kind !== "area")
      return failWith(c, 400, "bad_request", "within names a capability or an area.");
  }
  const filter = { within, class: cls as AtlasChangeClass | null };
  const [result, summary, versions, between] = await Promise.all([
    comparePage(d1, ctx.scope, fromRef.seq, toSeq, filter, ctx.cursor?.after ?? null, limit),
    ctx.cursor ? null : compareSummary(d1, ctx.scope, fromRef.seq, toSeq, within),
    d1
      .prepare("SELECT id, grouping_version FROM atlas_snapshots WHERE scope = ? AND id IN (?, ?)")
      .bind(ctx.scope, fromRef.id, ctx.snapshot.id)
      .all<{ id: string; grouping_version: number | null }>(),
    d1
      .prepare(
        `SELECT count(*) AS n FROM atlas_snapshots
         WHERE scope = ? AND seq > ? AND seq < ? AND status IN ('published', 'expired')`,
      )
      .bind(ctx.scope, fromRef.seq, toSeq)
      .first<{ n: number }>(),
  ]);
  const grouping = new Map(versions.results.map((v) => [v.id, v.grouping_version]));
  const fromSide = { snapshot: fromRef, groupingVersion: grouping.get(fromRef.id) ?? null };
  const toSide = { snapshot: ctx.snapshot, groupingVersion: grouping.get(ctx.snapshot.id) ?? null };
  const paged = await page(ctx, result.changes, result.next, async () =>
    summary ? (filter.class ? summary.classes[filter.class] : summary.total) : 0,
  );
  const body: AtlasComparison = {
    ...paged,
    counts: { ...paged.counts, unknownTotal: fromRef.partial || ctx.snapshot.partial },
    from: fromSide,
    to: toSide,
    within: withinEntity ? lean(withinEntity) : null,
    class: filter.class,
    summary,
    caveats: caveatsOf(fromSide, toSide, Number(between?.n ?? 0)),
  };
  return c.json(body);
});

// ---- timelines (CORE-176) -------------------------------------------------------

/**
 * What a timeline changes, in Atlas terms: its kept overlay placed in this
 * snapshot's capabilities (worker/atlas/timeline.ts), the capabilities it
 * touches on the first page, then its files by path, optionally only those in
 * one capability or area. The cursor is bound to the bookmark and the filter,
 * and to the overlay it started on: a push that recomputes the overlay stops
 * the traversal (`timeline_changed`) instead of mixing two. Reading never
 * computes an overlay, so an ended one stays exactly as it was kept.
 */
atlas.get("/timeline", async (c) => {
  const raw = c.req.query("ref") ?? "";
  const within = c.req.query("within") || null;
  const sourceId = c.req.query("source") || null;
  const ctx = await pin<[string, string]>(c, "timeline", { ref: raw, within, source: sourceId });
  if (ctx instanceof Response) return ctx;
  const ref = raw.length <= 512 ? overlayRef(raw) : null;
  if (!ref) return failWith(c, 400, "bad_request", "Pass ref=timeline/<slug>.");
  if (within !== null && within.length > 2048)
    return failWith(c, 400, "bad_request", "That capability id is too long.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  let withinEntity: ProjectedEntity | null = null;
  if (within) {
    withinEntity = await entityAt(d1, ctx.scope, ctx.snapshot.seq, within);
    if (!withinEntity) return failWith(c, 404, "entity_unknown", "That isn't in this snapshot.");
    if (withinEntity.kind !== "capability" && withinEntity.kind !== "area")
      return failWith(c, 400, "bad_request", "within names a capability or an area.");
  }
  const state = await readTimelineState(c.env, ctx.repo, ref, c.get("timing"), (work) =>
    c.executionCtx.waitUntil(work),
  );
  if (!state)
    return failWith(
      c,
      404,
      "timeline_unknown",
      "This repository has no such timeline bookmark, and keeps no overlay of one.",
    );
  if (sourceId && state.sourceId !== sourceId)
    return failWith(
      c,
      409,
      "timeline_changed",
      "The requested source does not belong to this timeline.",
    );
  const view = await timelineView(d1, ctx.scope, ctx.snapshot, ctx.repo, state, Boolean(c.env.AI));
  const after = ctx.cursor?.after ?? null;
  if (after && after[0] !== (view.overlayId ?? ""))
    return failWith(
      c,
      409,
      "timeline_changed",
      "The timeline was pushed again since this list started, so its changes were computed again. Start again.",
    );
  const matching = within
    ? view.files.filter(
        (f) => f.placement.capability?.id === within || f.placement.area?.id === within,
      )
    : view.files;
  const from = after ? matching.findIndex((f) => f.path > after[1]) : 0;
  const start = from === -1 ? matching.length : from;
  const items = matching.slice(start, start + limit);
  const last = items.at(-1);
  const paged = await page(
    ctx,
    items,
    last && start + limit < matching.length ? [view.overlayId ?? "", last.path] : null,
    async () => matching.length,
  );
  const body: AtlasTimeline = {
    ...paged,
    counts: { ...paged.counts, unknownTotal: false },
    ref: view.repo.ref,
    timeline: view.repo.ref.replace(/^timeline\//, ""),
    repos: [view.repo],
    within: withinEntity ? lean(withinEntity) : null,
    regions: ctx.cursor ? null : view.regions,
    regionCount: ctx.cursor ? null : view.regionCount,
    wiki: view.wiki,
    caveats: view.caveats,
  };
  return c.json(body);
});

function caveatsOf(
  from: AtlasComparison["from"],
  to: AtlasComparison["to"],
  between: number,
): AtlasComparisonCaveat[] {
  const caveats: AtlasComparisonCaveat[] = [];
  if (
    from.snapshot.projectionVersion !== to.snapshot.projectionVersion ||
    from.groupingVersion !== to.groupingVersion
  )
    caveats.push({
      code: "versions",
      from: { projection: from.snapshot.projectionVersion, grouping: from.groupingVersion },
      to: { projection: to.snapshot.projectionVersion, grouping: to.groupingVersion },
    });
  if (from.snapshot.partial) caveats.push({ code: "partial", side: "from" });
  if (to.snapshot.partial) caveats.push({ code: "partial", side: "to" });
  if (between > 0) caveats.push({ code: "between", builds: between });
  const commits = (s: AtlasSnapshotRef) =>
    s.vector
      .map((v) => `${v.repoId}@${v.commit}`)
      .sort()
      .join(",");
  if (commits(from.snapshot) === commits(to.snapshot)) caveats.push({ code: "same-commit" });
  caveats.push({ code: "relations" });
  return caveats;
}
