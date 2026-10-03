// The Atlas read API (CORE-160), mounted at /api/repos/:owner/:name/atlas.
//
//   GET /overview[?snapshot=]                      the root and the ≤12 largest top-level
//                                                  regions, plus the first catalogue page
//   GET /regions?cursor=                           more of that catalogue
//   GET /children?id=[&cursor=&limit=]             an entity's children, by name
//   GET /detail?id=                                an entity, its ancestors and counts
//   GET /ancestors?id=                             root-first ancestry, for deep links
//   GET /relations?id=&direction=in|out[&kind=]    one-hop edges with their other ends
//   GET /evidence?id=                              source locations backing an entity
//   GET /catalogue?q=[&kind=]                      entities whose name or path contains q
//
// Every route authorizes the repository first (unreadable looks like missing),
// then reads only the published projection (worker/atlas/projection.ts): no
// model, no Vectorize, no AI Search. Every response names its snapshot; any
// route takes `?snapshot=` to pin one, and every page's `next` cursor pins it
// too (worker/atlas/cursor.ts). Pages hold at most ATLAS_PAGE_MAX records.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ATLAS_CATALOGUE_SUMMARY_CHARS,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_OVERVIEW_SUMMARY_CHARS,
  ATLAS_PAGE_DEFAULT,
  ATLAS_PAGE_MAX,
  type AtlasAncestors,
  type AtlasCounts,
  type AtlasDetail,
  type AtlasEntity,
  type AtlasEntitySummary,
  type AtlasError,
  type AtlasErrorCode,
  type AtlasEvidence,
  type AtlasOverview,
  type AtlasPage,
  type AtlasRegion,
  type AtlasRelation,
  type AtlasSnapshotRef,
} from "../../shared/atlas.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import {
  cursorExpiresAt,
  cursorSecret,
  signCursor,
  verifyCursor,
  type CursorBinding,
  type CursorState,
} from "./cursor.ts";
import { currentPinned, pinnedSnapshot } from "./pinned.ts";
import {
  ancestorsAt,
  catalogueAt,
  catalogueCountAt,
  childCountAt,
  childrenAt,
  edgeCountsAt,
  entityAt,
  evidenceCountAt,
  evidenceFilesAt,
  regionsAt,
  relationsAt,
  repoScope,
  ROOT,
  type AtlasEntity as ProjectedEntity,
  type RegionKey,
  type RelationKey,
} from "./projection.ts";

export const atlas = new Hono<AppEnv>();

type C = Context<AppEnv>;

function failWith(
  c: C,
  status: ContentfulStatusCode,
  code: AtlasErrorCode,
  error: string,
  current?: AtlasSnapshotRef | null,
) {
  const body: AtlasError = { error, code };
  if (current !== undefined) body.current = current ? { id: current.id, seq: current.seq } : null;
  return c.json(body, status);
}

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

function lean(entity: ProjectedEntity): AtlasEntitySummary {
  return {
    id: entity.id,
    kind: entity.kind,
    parentId: entity.parentId,
    name: entity.name,
    path: entity.path,
    summary: entity.summary,
    counts: countsOf(entity.data),
    structural: entity.kind === "group" || entity.data.structural === true,
  };
}

const full = (entity: ProjectedEntity): AtlasEntity => ({ ...lean(entity), data: entity.data });

function region(
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

// ---- request context -----------------------------------------------------------

interface Pinned<K> {
  scope: string;
  repoId: string;
  snapshot: AtlasSnapshotRef;
  /** The verified cursor, when the request continues a traversal. */
  cursor: CursorState<K> | null;
  binding: CursorBinding;
  secret: string;
}

function principalOf(c: C): string {
  const actor = c.get("actor");
  if (!actor) return "anonymous";
  return actor.agent ? `user:${actor.id}/agent:${actor.agent.id}` : `user:${actor.id}`;
}

/**
 * Authorize, then work out which snapshot the request reads: its cursor's,
 * else `?snapshot=`, else the current one. Unknown and expired snapshots are
 * explicit errors. Nothing request-supplied is read before authorization.
 */
async function pin<K>(
  c: C,
  route: string,
  filters: Record<string, string | null>,
): Promise<Pinned<K> | Response> {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  const scope = repoScope(loaded.row.id);
  const secret = await cursorSecret(c.env);
  const binding: CursorBinding = { route, scope, filters, principal: principalOf(c) };
  const requested = c.req.query("snapshot") || null;

  let cursor: CursorState<K> | null = null;
  const raw = c.req.query("cursor");
  if (raw) {
    const verified = await verifyCursor<K>(secret, binding, raw, Date.now());
    if (!verified.ok) {
      const current = await currentPinned(c.env.DB, scope);
      return verified.reason === "expired"
        ? failWith(c, 410, "cursor_expired", "This page link has expired. Start again.", current)
        : failWith(
            c,
            400,
            "cursor_invalid",
            "This page link doesn't belong to this request. Start again.",
            current,
          );
    }
    cursor = verified.state;
    if (requested && requested !== cursor.snapshot) {
      return failWith(
        c,
        400,
        "cursor_invalid",
        "This page link belongs to another snapshot. Start again.",
        await currentPinned(c.env.DB, scope),
      );
    }
  }

  const id = cursor?.snapshot ?? requested;
  let snapshot: AtlasSnapshotRef;
  if (id) {
    const pinned = await pinnedSnapshot(c.env.DB, scope, id);
    if (pinned.state !== "ok") {
      const current = await currentPinned(c.env.DB, scope);
      return pinned.state === "expired"
        ? failWith(
            c,
            410,
            "snapshot_expired",
            "This Atlas snapshot has expired. Open the current one instead.",
            current,
          )
        : failWith(c, 404, "snapshot_unknown", "There's no such Atlas snapshot here.", current);
    }
    snapshot = pinned.snapshot;
  } else {
    const current = await currentPinned(c.env.DB, scope);
    if (!current)
      return failWith(
        c,
        404,
        "atlas_unavailable",
        "This repository has no Atlas yet. It appears after a Knowledge build.",
        null,
      );
    snapshot = current;
  }
  return { scope, repoId: loaded.row.id, snapshot, cursor, binding, secret };
}

function limitOf(c: C): number | Response {
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
            expires: cursorExpiresAt(Date.now(), ctx.snapshot.expiresAt),
          }),
  };
}

async function entityOr404<K>(c: C, ctx: Pinned<K>, id: string) {
  const entity = await entityAt(c.env.DB, ctx.scope, ctx.snapshot.seq, id);
  return entity ?? failWith(c, 404, "entity_unknown", "That isn't in this Atlas snapshot.");
}

// ---- routes --------------------------------------------------------------------

atlas.get("/overview", async (c) => {
  const ctx = await pin<RegionKey>(c, "regions", {});
  if (ctx instanceof Response) return ctx;
  const d1 = c.env.DB;
  const seq = ctx.snapshot.seq;
  const [root, top, totalRegions] = await Promise.all([
    entityAt(d1, ctx.scope, seq, ROOT),
    regionsAt(d1, ctx.scope, seq, null, ATLAS_OVERVIEW_REGIONS),
    childCountAt(d1, ctx.scope, seq, ROOT),
  ]);
  const rest = top.next
    ? await regionsAt(d1, ctx.scope, seq, top.next, ATLAS_PAGE_DEFAULT)
    : { regions: [], next: null };
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
    regions: top.regions.map((r) => region(r, ATLAS_OVERVIEW_SUMMARY_CHARS)),
    catalogue,
    totalRegions,
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

function analysisOf(data: Record<string, unknown>): AtlasEvidence["analysis"] {
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
