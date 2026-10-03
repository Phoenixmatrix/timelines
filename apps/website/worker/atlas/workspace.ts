// The Atlas across an explicit workspace scope (CORE-161), mounted at
// /api/accounts/:owner/atlas.
//
//   GET /overview?repos=a,b[&snapshot=]                 regions of every selected repository, ranked together
//   GET /regions?repos=…&cursor=                        more of that catalogue
//   GET /children?repos=…&id=<repoId>/<entity>          one entity's children, as /api/repos/…/atlas
//   GET /detail | /ancestors | /relations | /evidence   the same, by namespaced id
//   GET /catalogue?repos=…&q=[&kind=]                   lookup across every selected repository
//
// The scope. A workspace scope is the set of repositories the caller selected
// (`repos`, names under :owner, at most ATLAS_WORKSPACE_MAX_REPOS) intersected
// with what they can read *now*: one SQL query with readableRepo (worker/db.ts)
// on every request, cursor or not. Its id is `ws:<ownerId>:<hash of the sorted
// authorized repository ids>`, so it names exactly the authorized input set.
// Nothing about a selected repository the caller can't read reaches the
// response: a hidden or nonexistent name is dropped by the same query, the
// response is byte-for-byte what selecting only the readable ones gives, and
// it is never counted. Selection is a query parameter, not stored state: no
// subscription, and nothing here starts or enables a Knowledge build (a tracker
// workspace's repositories can seed it client-side).
//
// Composition is virtual. Every response reads the selected repositories' own
// published projections (worker/atlas/projection.ts) at read time; nothing is
// re-extracted or materialized. A composite snapshot is the vector of each
// repository's snapshot, with its own commit and build: there is no common
// HEAD. Its id, `ws1.<scope tag>.<seq per repository>`, pins every one of them
// and only means something with the same scope. Entities keep their
// repository's ids, namespaced `<repoId>/<entity id>`; ids inside `data` stay
// repository-local. Because every name, summary, count and rationale comes from
// exactly one repository's projection, no composed prose ever mixes inputs:
// narrowing the scope just stops reading a repository. Cross-repository
// capabilities that would need merged prose are CORE-167's, and must recompute
// from readable inputs or stay repository-separated.
//
// Why not materialize? A materialized composite would be a cache keyed by the
// authorized set and principal policy, multiply storage per selection (against
// the account composition pool in retention.ts) and need invalidation on every
// visibility change. Reading per-repository snapshots needs none of that: its
// cache identity is the per-repository snapshots themselves, which only an
// authorized request ever touches, so a denied repository can't influence
// content, counts or timing. The cost is one bounded query per selected
// repository for ranked pages (overview, regions, catalogue).
//
// Pinning, cursors and revocation. Cursors are the repository API's
// (worker/atlas/cursor.ts), bound to route, filters, principal and the scope
// id, i.e. the authorized set. When access changes, the scope id changes, so an
// open cursor or pinned composite fails as `cursor_invalid` / `snapshot_unknown`
// before any row is read. Every pinned repository snapshot is resolved through
// retention's `pinnedSnapshot` on every page, and expiry is explicit.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ATLAS_CATALOGUE_SUMMARY_CHARS,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_OVERVIEW_SUMMARY_CHARS,
  ATLAS_PAGE_DEFAULT,
  ATLAS_WORKSPACE_MAX_REPOS,
  type AtlasCounts,
  type AtlasEntitySummary,
  type AtlasErrorCode,
  type AtlasEvidence,
  type AtlasRegion,
  type AtlasRelation,
  type AtlasRepoState,
  type AtlasWorkspaceAncestors,
  type AtlasWorkspaceDetail,
  type AtlasWorkspaceEnvelope,
  type AtlasWorkspaceOverview,
  type AtlasWorkspacePage,
  type AtlasWorkspaceRepo,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import { findAccountBySlug, readableRepo, selectRepos } from "../db.ts";
import { sha256 } from "../knowledge/util.ts";
import { analysisOf, failWith, full, lean, limitOf, principalOf, refOf, region } from "./api.ts";
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
  evidenceFilesAt,
  regionsAt,
  relationsAt,
  repoScope,
  ROOT,
  toSnapshot,
  type AtlasEntity as ProjectedEntity,
  type AtlasSnapshot,
  type RegionKey,
  type RelationKey,
} from "./projection.ts";
import { capacityFailure, cursorExpiresAt, pinnedSnapshot } from "./retention.ts";

export const workspaceAtlas = new Hono<AppEnv>();

type C = Context<AppEnv>;

const SNAPSHOT_VERSION = "ws1";

/** A selected repository the caller can read. */
interface Member {
  id: string;
  name: string;
  visibility: "public" | "private";
  scope: string;
}

/** A member with the snapshot this request reads, when it has one. */
interface Read extends Member {
  snapshot: AtlasSnapshot | null;
}

interface Scope<K> {
  owner: { id: string; slug: string };
  scope: string;
  /** Short form of the scope hash; composite snapshot ids carry it. */
  tag: string;
  /** Authorized members, by repository id. */
  members: Member[];
  /** Each member's snapshot in this view (null: none), by member index. */
  read: Read[];
  /** The composite snapshot id. */
  snapshotId: string;
  cursor: CursorState<K> | null;
  binding: CursorBinding;
  secret: string;
}

// ---- the authorized scope ------------------------------------------------------

/** Repository names the request selects, or a response saying why it can't. */
function selection(c: C, ownerSlug: string): string[] | Response {
  const raw = c.req.query("repos") ?? "";
  if (raw.length > 8192) return failWith(c, 400, "bad_request", "That selection is too long.");
  const names = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    // "name" or "<owner>/name"; another owner's repository never matches.
    const name =
      slash < 0 ? entry : entry.slice(0, slash) === ownerSlug ? entry.slice(slash + 1) : null;
    if (name && name.length <= 100 && !name.includes("/")) names.add(name);
    else names.add("\u0000"); // Matches nothing, like a name that doesn't exist.
  }
  if (names.size === 0)
    return failWith(c, 400, "bad_request", "Select repositories with ?repos=name,name.");
  if (names.size > ATLAS_WORKSPACE_MAX_REPOS)
    return failWith(
      c,
      400,
      "bad_request",
      `A workspace selects at most ${ATLAS_WORKSPACE_MAX_REPOS} repositories.`,
    );
  return [...names];
}

const SCOPE_EMPTY = "None of the selected repositories has an Atlas you can open.";

/**
 * Resolve the scope: the owner, then the selected repositories the actor can
 * read, authorized in SQL so a hidden repository never leaves the database.
 */
async function authorize(
  c: C,
): Promise<
  { owner: { id: string; slug: string }; members: Member[]; scope: string; tag: string } | Response
> {
  const ownerSlug = c.req.param("owner") ?? "";
  const owner = await findAccountBySlug(c.env.DB, ownerSlug);
  if (!owner) return failWith(c, 404, "scope_empty", SCOPE_EMPTY);
  const names = selection(c, owner.slug);
  if (names instanceof Response) return names;
  const actor = c.get("actor");
  const rows = await selectRepos(c.env.DB, actor?.id ?? "")
    .where("r.owner_id", "=", owner.id)
    .where("r.name", "in", names)
    .where(readableRepo(actor))
    .orderBy("r.id")
    .execute();
  if (rows.length === 0) return failWith(c, 404, "scope_empty", SCOPE_EMPTY);
  const members = rows.map((r) => ({
    id: r.id,
    name: r.name,
    visibility: r.visibility,
    scope: repoScope(r.id),
  }));
  const hash = await sha256(JSON.stringify(members.map((m) => m.id)));
  return {
    owner: { id: owner.id, slug: owner.slug },
    members,
    scope: `ws:${owner.id}:${hash.slice(0, 32)}`,
    tag: hash.slice(0, 12),
  };
}

const compositeId = (tag: string, seqs: (number | null)[]) =>
  [SNAPSHOT_VERSION, tag, ...seqs.map((s) => (s === null ? "-" : String(s)))].join(".");

/** A composite id's per-member seqs, if it belongs to this scope. */
function parseComposite(id: string, tag: string, count: number): (number | null)[] | null {
  if (id.length > 1024) return null;
  const [version, idTag, ...seqs] = id.split(".");
  if (version !== SNAPSHOT_VERSION || idTag !== tag || seqs.length !== count) return null;
  const parsed: (number | null)[] = [];
  for (const s of seqs) {
    if (s === "-") parsed.push(null);
    else if (/^\d{1,12}$/.test(s)) parsed.push(Number(s));
    else return null;
  }
  return parsed;
}

/** Current snapshots of these repository scopes, in one query. */
async function currentSnapshots(d1: D1Database, scopes: string[]) {
  const rows = await d1
    .prepare(
      `SELECT s.* FROM atlas_current c JOIN atlas_snapshots s ON s.id = c.snapshot_id
       WHERE c.scope IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(scopes))
    .all<Parameters<typeof toSnapshot>[0]>();
  return new Map(rows.results.map((r) => [r.scope, toSnapshot(r)]));
}

/**
 * Authorize, then work out the composite snapshot: the cursor's, else
 * `?snapshot=`, else every member's current one. `involved` names the member
 * the request reads (entity routes); omitted, it reads them all. Pinned
 * snapshots go through retention's pinnedSnapshot on every request.
 */
async function pin<K>(
  c: C,
  route: string,
  filters: Record<string, string | null>,
  involved?: (members: Member[]) => Member | null,
): Promise<{ ctx: Scope<K>; target: Read | null } | Response> {
  const authorized = await authorize(c);
  if (authorized instanceof Response) return authorized;
  const { owner, members, scope, tag } = authorized;
  const d1 = c.env.DB;
  const secret = await cursorSecret(c.env);
  const binding: CursorBinding = {
    route: `workspace/${route}`,
    scope,
    filters,
    principal: principalOf(c),
  };
  const requested = c.req.query("snapshot") || null;
  const currents = await currentSnapshots(
    d1,
    members.map((m) => m.scope),
  );
  const currentId = compositeId(
    tag,
    members.map((m) => currents.get(m.scope)?.seq ?? null),
  );
  const restart = (status: ContentfulStatusCode, code: AtlasErrorCode, error: string) =>
    failWith(c, status, code, error, { id: currentId, seq: null });

  let cursor: CursorState<K> | null = null;
  const raw = c.req.query("cursor");
  if (raw) {
    const verified = await verifyCursor<K>(secret, binding, raw);
    if (!verified.ok)
      return restart(
        400,
        "cursor_invalid",
        "This page link doesn't belong to this request. Start again.",
      );
    cursor = verified.state;
    if (requested && requested !== cursor.snapshot)
      return restart(
        400,
        "cursor_invalid",
        "This page link belongs to another snapshot. Start again.",
      );
  }

  const target = involved ? involved(members) : null;
  const pinnedId = cursor?.snapshot ?? requested;
  let read: Read[];
  if (!pinnedId) {
    read = members.map((m) => ({ ...m, snapshot: currents.get(m.scope) ?? null }));
  } else {
    const seqs = parseComposite(pinnedId, tag, members.length);
    if (!seqs)
      return restart(404, "snapshot_unknown", "There's no such Atlas snapshot in this scope.");
    // Only what this request reads is resolved (and must still be retained).
    const wanted = members
      .map((m, i) => ({ m, seq: seqs[i] ?? null }))
      .filter(({ m, seq }) => seq !== null && (!involved || m.id === target?.id));
    const ids = await d1
      .prepare(
        `SELECT s.id, s.scope FROM atlas_snapshots s JOIN json_each(?) p
           ON s.scope = json_extract(p.value, '$[0]') AND s.seq = json_extract(p.value, '$[1]')`,
      )
      .bind(JSON.stringify(wanted.map(({ m, seq }) => [m.scope, seq])))
      .all<{ id: string; scope: string }>();
    const idOf = new Map(ids.results.map((r) => [r.scope, r.id]));
    const now = new Date();
    const resolved = new Map<string, AtlasSnapshot>();
    for (const { m } of wanted) {
      const id = idOf.get(m.scope);
      const pinned = id
        ? await pinnedSnapshot(d1, m.scope, id, now)
        : { state: "unknown" as const };
      if (pinned.state === "unknown")
        return restart(404, "snapshot_unknown", "There's no such Atlas snapshot in this scope.");
      if (pinned.state === "expired")
        return failWith(
          c,
          410,
          "snapshot_expired",
          "This Atlas snapshot has expired. Open the current one instead.",
          { id: currentId, seq: null },
          { expired: { at: pinned.expiredAt, reason: pinned.reason } },
        );
      resolved.set(m.scope, pinned.snapshot);
    }
    read = members.map((m) => ({ ...m, snapshot: resolved.get(m.scope) ?? null }));
    if (cursor) {
      const now = Date.now();
      const expiries = [null, ...read.map((r) => (r.snapshot ? r.snapshot.expiresAt : null))];
      if (expiries.some((at) => now >= cursorExpiresAt(cursor.issuedAt, at)))
        return restart(410, "cursor_expired", "This page link has expired. Start again.");
    }
  }
  const snapshotId = pinnedId ?? currentId;
  return {
    ctx: { owner, scope, tag, members, read, snapshotId, cursor, binding, secret },
    target: target ? (read.find((r) => r.id === target.id) ?? null) : null,
  };
}

// ---- namespaced ids ------------------------------------------------------------

const SEP = "/";
const qualify = (repoId: string, id: string) => `${repoId}${SEP}${id}`;

/** `<repoId>/<entity>` split, if the repository is in the scope; otherwise null, the same either way. */
function splitId(
  raw: string | undefined,
  members: Member[],
): { member: Member; id: string } | null {
  if (!raw || raw.length > 2048) return null;
  const at = raw.indexOf(SEP);
  if (at <= 0) return null;
  const member = members.find((m) => m.id === raw.slice(0, at));
  const id = raw.slice(at + 1);
  return member && id ? { member, id } : null;
}

function inRepo<T extends AtlasEntitySummary>(repoId: string, entity: T): T {
  return {
    ...entity,
    id: qualify(repoId, entity.id),
    parentId: entity.parentId === null ? null : qualify(repoId, entity.parentId),
    repoId,
  };
}

// ---- envelopes and pages -------------------------------------------------------

async function repoStates(d1: D1Database, members: Member[]) {
  const rows = await d1
    .prepare(
      `SELECT repo_id, max(status = 'running') AS running, count(*) AS builds FROM kg_builds
       WHERE repo_id IN (SELECT value FROM json_each(?)) GROUP BY repo_id`,
    )
    .bind(JSON.stringify(members.map((m) => m.id)))
    .all<{ repo_id: string; running: number; builds: number }>();
  return new Map(rows.results.map((r) => [r.repo_id, r]));
}

/** The selected repositories a response read, each with its own vector and state. */
async function describe(
  c: C,
  ctx: Scope<unknown>,
  which: Read[],
  withCapacity = false,
): Promise<AtlasWorkspaceRepo[]> {
  const d1 = c.env.DB;
  const builds = await repoStates(d1, which);
  return Promise.all(
    which.map(async (r) => {
      const b = builds.get(r.id);
      const building = Boolean(b?.running);
      const state: AtlasRepoState = r.snapshot
        ? "ready"
        : building
          ? "building"
          : b?.builds
            ? "unavailable"
            : "not-enabled";
      const repo: AtlasWorkspaceRepo = {
        id: r.id,
        owner: ctx.owner.slug,
        name: r.name,
        visibility: r.visibility,
        state,
        snapshot: r.snapshot ? refOf(r.snapshot) : null,
        building,
      };
      if (withCapacity) repo.capacityFailure = await capacityFailure(d1, r.scope);
      return repo;
    }),
  );
}

async function envelope(
  c: C,
  ctx: Scope<unknown>,
  which: Read[],
  withCapacity = false,
): Promise<AtlasWorkspaceEnvelope> {
  return {
    scope: ctx.scope,
    owner: ctx.owner,
    snapshot: { id: ctx.snapshotId, repos: await describe(c, ctx, which, withCapacity) },
  };
}

async function page<T, K>(
  c: C,
  ctx: Scope<K>,
  which: Read[],
  items: T[],
  next: K | null,
  countAll: () => Promise<number>,
): Promise<AtlasWorkspacePage<T>> {
  const loaded = (ctx.cursor?.loaded ?? 0) + items.length;
  const knownTotal = ctx.cursor ? ctx.cursor.total : await countAll();
  const counts: AtlasCounts = {
    loaded,
    knownTotal,
    unknownTotal: which.some((r) => r.snapshot?.partial),
  };
  return {
    ...(await envelope(c, ctx as Scope<unknown>, which)),
    items,
    counts,
    next:
      next === null
        ? null
        : await signCursor(ctx.secret, ctx.binding, {
            snapshot: ctx.snapshotId,
            after: next,
            loaded,
            total: knownTotal,
            issuedAt: Date.now(),
          }),
  };
}

// ---- ranked merges across repositories -----------------------------------------

const utf8 = new TextEncoder();

/** UTF-8 byte order: what SQLite's BINARY collation sorts sort_key by. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** Top-level regions in all across the members read. */
async function totalRegionsOf(d1: D1Database, read: Read[]): Promise<number> {
  const totals = await Promise.all(
    read.map(async (r) => (r.snapshot ? childCountAt(d1, r.scope, r.snapshot.seq, ROOT) : 0)),
  );
  return totals.reduce((a, b) => a + b, 0);
}

/** Where a merged region page stopped: the repository's key, then the repository. */
type WorkspaceRegionKey = [...RegionKey, string];
type RankedRegion = Awaited<ReturnType<typeof regionsAt>>["regions"][number] & { repoId: string };

function compareRegions(a: WorkspaceRegionKey, b: WorkspaceRegionKey): number {
  return (
    a[0] - b[0] || b[1] - a[1] || b[2] - a[2] || compareText(a[3], b[3]) || compareText(a[4], b[4])
  );
}

/**
 * The next `limit` top-level regions across the readable members after
 * `after`, ranked as one list (capabilities before groups, then by primary
 * files, members, name, repository), and whether there are more.
 */
async function mergedRegions(
  d1: D1Database,
  read: Read[],
  after: WorkspaceRegionKey | null,
  limit: number,
): Promise<{ regions: RankedRegion[]; more: boolean }> {
  const lists = await Promise.all(
    read.map(async (r) => {
      if (!r.snapshot) return [];
      const key: RegionKey | null = after ? [after[0], after[1], after[2], after[3]] : null;
      // A repository after the last one shares its key's place: include an equal key.
      const inclusive = after !== null && compareText(r.id, after[4]) > 0;
      const page = await regionsAt(d1, r.scope, r.snapshot.seq, key, limit + 1, inclusive);
      return page.regions.map((region) => ({ ...region, repoId: r.id }));
    }),
  );
  const all = lists
    .flat()
    .sort((a, b) => compareRegions([...a.key, a.repoId], [...b.key, b.repoId]));
  return { regions: all.slice(0, limit), more: all.length > limit };
}

const regionKeyOf = (r: RankedRegion): WorkspaceRegionKey => [...r.key, r.repoId];

const shapeRegion = (r: RankedRegion, chars: number): AtlasRegion =>
  inRepo(r.repoId, region(r, chars));

// ---- routes --------------------------------------------------------------------

workspaceAtlas.get("/overview", async (c) => {
  const pinned = await pin<WorkspaceRegionKey>(c, "regions", {});
  if (pinned instanceof Response) return pinned;
  const { ctx } = pinned;
  const d1 = c.env.DB;
  const first = ATLAS_OVERVIEW_REGIONS + ATLAS_PAGE_DEFAULT;
  const [merged, totalRegions] = await Promise.all([
    mergedRegions(d1, ctx.read, null, first),
    totalRegionsOf(d1, ctx.read),
  ]);
  const top = merged.regions.slice(0, ATLAS_OVERVIEW_REGIONS);
  const rest = merged.regions.slice(ATLAS_OVERVIEW_REGIONS);
  const last = rest.at(-1);
  const catalogue = await page(
    c,
    { ...ctx, cursor: null },
    ctx.read,
    rest.map((r) => shapeRegion(r, ATLAS_CATALOGUE_SUMMARY_CHARS)),
    merged.more && last ? regionKeyOf(last) : null,
    async () => Math.max(0, totalRegions - top.length),
  );
  const body: AtlasWorkspaceOverview = {
    ...(await envelope(c, ctx as Scope<unknown>, ctx.read, true)),
    regions: top.map((r) => shapeRegion(r, ATLAS_OVERVIEW_SUMMARY_CHARS)),
    catalogue,
    totalRegions,
  };
  return c.json(body);
});

workspaceAtlas.get("/regions", async (c) => {
  const pinned = await pin<WorkspaceRegionKey>(c, "regions", {});
  if (pinned instanceof Response) return pinned;
  const { ctx } = pinned;
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  let after = ctx.cursor?.after ?? null;
  if (!ctx.cursor) {
    const top = await mergedRegions(d1, ctx.read, null, ATLAS_OVERVIEW_REGIONS);
    const last = top.regions.at(-1);
    if (!top.more || !last)
      return c.json(await page(c, ctx, ctx.read, [] as AtlasRegion[], null, async () => 0));
    after = regionKeyOf(last);
  }
  const rest = await mergedRegions(d1, ctx.read, after, limit);
  const last = rest.regions.at(-1);
  return c.json(
    await page(
      c,
      ctx,
      ctx.read,
      rest.regions.map((r) => shapeRegion(r, ATLAS_CATALOGUE_SUMMARY_CHARS)),
      rest.more && last ? regionKeyOf(last) : null,
      async () => {
        return Math.max(0, (await totalRegionsOf(d1, ctx.read)) - ATLAS_OVERVIEW_REGIONS);
      },
    ),
  );
});

const ENTITY_UNKNOWN = "That isn't in this Atlas snapshot.";

/** Pin an entity route: the id's repository must be in the scope and readable in this view. */
async function pinEntity<K>(c: C, route: string, filters: Record<string, string | null>) {
  const raw = c.req.query("id");
  let parsed: { member: Member; id: string } | null = null;
  const pinned = await pin<K>(c, route, { id: raw ?? "", ...filters }, (members) => {
    parsed = splitId(raw, members);
    return parsed?.member ?? null;
  });
  if (pinned instanceof Response) return pinned;
  const split = parsed as { member: Member; id: string } | null;
  if (!raw) return failWith(c, 400, "bad_request", "Name an entity with ?id=.");
  const target = pinned.target;
  if (!split || !target?.snapshot) return failWith(c, 404, "entity_unknown", ENTITY_UNKNOWN);
  const entity = await entityAt(c.env.DB, target.scope, target.snapshot.seq, split.id);
  if (!entity) return failWith(c, 404, "entity_unknown", ENTITY_UNKNOWN);
  return {
    ctx: pinned.ctx,
    target: target as Read & { snapshot: AtlasSnapshot },
    id: split.id,
    entity,
  };
}

workspaceAtlas.get("/children", async (c) => {
  const limit = limitOf(c);
  const p = await pinEntity<string>(c, "children", {});
  if (p instanceof Response) return p;
  if (limit instanceof Response) return limit;
  const { ctx, target, id } = p;
  const d1 = c.env.DB;
  const seq = target.snapshot.seq;
  const result = await childrenAt(d1, target.scope, seq, id, ctx.cursor?.after ?? null, limit);
  return c.json(
    await page(
      c,
      ctx,
      [target],
      result.entities.map((e) => inRepo(target.id, lean(e))),
      result.next,
      () => childCountAt(d1, target.scope, seq, id),
    ),
  );
});

workspaceAtlas.get("/detail", async (c) => {
  const p = await pinEntity(c, "detail", {});
  if (p instanceof Response) return p;
  const { ctx, target, id, entity } = p;
  const d1 = c.env.DB;
  const seq = target.snapshot.seq;
  const [chain, children, outgoing, incoming] = await Promise.all([
    ancestorsAt(d1, target.scope, seq, id),
    childCountAt(d1, target.scope, seq, id),
    edgeCountsAt(d1, target.scope, seq, id, false),
    edgeCountsAt(d1, target.scope, seq, id, true),
  ]);
  const body: AtlasWorkspaceDetail = {
    ...(await envelope(c, ctx as Scope<unknown>, [target])),
    entity: inRepo(target.id, full(entity)),
    ancestors: chain.ancestors.map((a) => inRepo(target.id, lean(a))),
    counts: { children, outgoing, incoming },
  };
  return c.json(body);
});

workspaceAtlas.get("/ancestors", async (c) => {
  const p = await pinEntity(c, "ancestors", {});
  if (p instanceof Response) return p;
  const { ctx, target, id, entity } = p;
  const chain = await ancestorsAt(c.env.DB, target.scope, target.snapshot.seq, id);
  const body: AtlasWorkspaceAncestors = {
    ...(await envelope(c, ctx as Scope<unknown>, [target])),
    entity: inRepo(target.id, lean(entity)),
    ancestors: chain.ancestors.map((a) => inRepo(target.id, lean(a))),
  };
  return c.json(body);
});

workspaceAtlas.get("/relations", async (c) => {
  const direction = c.req.query("direction") ?? "out";
  const kind = c.req.query("kind") || null;
  const limit = limitOf(c);
  const p = await pinEntity<RelationKey>(c, "relations", { direction, kind });
  if (p instanceof Response) return p;
  if (direction !== "in" && direction !== "out")
    return failWith(c, 400, "bad_request", "direction is in or out.");
  if (limit instanceof Response) return limit;
  const { ctx, target, id } = p;
  const d1 = c.env.DB;
  const seq = target.snapshot.seq;
  const incoming = direction === "in";
  const result = await relationsAt(
    d1,
    target.scope,
    seq,
    id,
    incoming,
    kind,
    ctx.cursor?.after ?? null,
    limit,
  );
  const items: AtlasRelation[] = result.relations.map((r) => ({
    src: qualify(target.id, r.src),
    dst: qualify(target.id, r.dst),
    kind: r.kind,
    weight: r.weight,
    neighbor: r.neighbor ? inRepo(target.id, lean(r.neighbor)) : null,
  }));
  return c.json(
    await page(c, ctx, [target], items, result.next, async () =>
      Object.values(await edgeCountsAt(d1, target.scope, seq, id, incoming, kind)).reduce(
        (a, b) => a + b,
        0,
      ),
    ),
  );
});

workspaceAtlas.get("/evidence", async (c) => {
  const limit = limitOf(c);
  const p = await pinEntity<string>(c, "evidence", {});
  if (p instanceof Response) return p;
  if (limit instanceof Response) return limit;
  const { ctx, target, id, entity } = p;
  const d1 = c.env.DB;
  const seq = target.snapshot.seq;
  const commit = target.snapshot.vector.find((v) => v.repoId === target.id)?.commit ?? "";
  const fileEvidence = (file: ProjectedEntity, via: string): AtlasEvidence => {
    const lines = typeof file.data.lines === "number" ? file.data.lines : null;
    return {
      entityId: qualify(target.id, file.id),
      kind: "file",
      repoId: target.id,
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
  if (entity.kind === "file")
    return c.json(
      await page(c, ctx, [target], [fileEvidence(entity, "self")], null, async () => 1),
    );
  if (entity.kind === "symbol") {
    const file = entity.parentId ? await entityAt(d1, target.scope, seq, entity.parentId) : null;
    const line = typeof entity.data.line === "number" ? entity.data.line : null;
    const items: AtlasEvidence[] =
      file?.kind === "file"
        ? [
            {
              ...fileEvidence(file, "defines"),
              entityId: qualify(target.id, entity.id),
              kind: "symbol",
              range: line
                ? { startLine: line, endLine: null, status: "start-line" }
                : { startLine: null, endLine: null, status: "unavailable" },
            },
          ]
        : [];
    return c.json(await page(c, ctx, [target], items, null, async () => items.length));
  }
  const result = await evidenceFilesAt(d1, target.scope, seq, id, ctx.cursor?.after ?? null, limit);
  return c.json(
    await page(
      c,
      ctx,
      [target],
      result.files.map((f) => fileEvidence(f, f.via)),
      result.next,
      () => evidenceCountAt(d1, target.scope, seq, id),
    ),
  );
});

/** Where a merged catalogue page stopped: [sort_key, repository id]. */
type CatalogueKey = [string, string];

workspaceAtlas.get("/catalogue", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const kind = c.req.query("kind") || null;
  const pinned = await pin<CatalogueKey>(c, "catalogue", { q, kind });
  if (pinned instanceof Response) return pinned;
  const { ctx } = pinned;
  if (q.length > 200) return failWith(c, 400, "bad_request", "That lookup is too long.");
  const limit = limitOf(c);
  if (limit instanceof Response) return limit;
  const d1 = c.env.DB;
  const after = ctx.cursor?.after ?? null;
  const lists = await Promise.all(
    ctx.read.map(async (r) => {
      if (!r.snapshot) return [];
      const inclusive = after !== null && compareText(r.id, after[1]) > 0;
      const result = await catalogueAt(
        d1,
        r.scope,
        r.snapshot.seq,
        q,
        kind,
        after?.[0] ?? null,
        limit + 1,
        inclusive,
      );
      return result.entities.map((e) => ({ entity: e, key: [e.sortKey, r.id] as CatalogueKey }));
    }),
  );
  const all = lists
    .flat()
    .sort((a, b) => compareText(a.key[0], b.key[0]) || compareText(a.key[1], b.key[1]));
  const items = all.slice(0, limit);
  const last = items.at(-1);
  return c.json(
    await page(
      c,
      ctx,
      ctx.read,
      items.map(({ entity, key }) => inRepo(key[1], lean(entity))),
      all.length > limit && last ? last.key : null,
      async () => {
        const counts = await Promise.all(
          ctx.read.map(async (r) =>
            r.snapshot ? catalogueCountAt(d1, r.scope, r.snapshot.seq, q, kind) : 0,
          ),
        );
        return counts.reduce((a, b) => a + b, 0);
      },
    ),
  );
});
