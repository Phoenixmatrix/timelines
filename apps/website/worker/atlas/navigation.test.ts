// The repository Atlas's navigation (CORE-171) against the real Atlas API:
// what a cold deep link, Back/Forward, a retired or expired link and the
// catalogue lookup actually request, through the browser client, with every
// model, index and search binding wired to fail if touched.

import { Hono } from "hono";
import { onTestFinished, afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AtlasEntitySummary, AtlasOverview } from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { atlasApi, atlasErrorOf } from "../../src/lib/atlas.ts";
import {
  CatalogueLookup,
  FocusResolver,
  type Focus,
  type LookupState,
} from "../../src/routes/repo/atlasNavigation.ts";
import { buildTerritory, ChildLoader, type Load } from "../../src/routes/repo/territory.ts";
import { atlas } from "./api.ts";
import { expireAtlasPriors, publishAtlasFixture, writeAtlasFixtureGraph } from "./fixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`Atlas navigation touched ${name}.${String(key)}`);
      },
    },
  );
}

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id)
      VALUES ('org-ann', 'personal-ann', 'ann', 'personal', 'ann', 'ann');
    INSERT INTO spaces (id, organization_id, slug, display_name)
      VALUES ('ann', 'org-ann', 'ann', 'ann');
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by)
      VALUES ('org-ann', 'ann', 'owner', 'test-fixture', 'ann');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
      VALUES ('ann', 'org-ann', 'ann', 'admin', 'write', 'write', 'test-fixture', 'ann');
    INSERT INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail)
      VALUES ('audit-ann', 'org-ann', 'ann', 'ann', 'space.grant', 'ann', '{"origin":"test-fixture"}');
    COMMIT;
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'shop', 'private', 'art-r1', ''),
      ('r2', 'ann', 'other', 'private', 'art-r2', '');
  `);
  const touched: string[] = [];
  const env = {
    ...fresh.env,
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    AI: forbidden("AI", touched),
    VECTORS: forbidden("VECTORS", touched),
    SEARCH: forbidden("SEARCH", touched),
    KNOWLEDGE: forbidden("KNOWLEDGE", touched),
    KNOWLEDGE_QUEUE: forbidden("KNOWLEDGE_QUEUE", touched),
    KNOWLEDGE_BUILD: forbidden("KNOWLEDGE_BUILD", touched),
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/repos/:space/:name/atlas", atlas);
  // Everything the browser client asks for, as "<route>?<query>", in order.
  const requests: string[] = [];
  let delay: (url: URL) => Promise<void> = async () => {};
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), "http://atlas.test");
    requests.push(`${url.pathname}${url.search}`);
    await delay(url);
    return app.request(String(input), init ?? {}, env);
  });
  return {
    env,
    sqlite,
    touched,
    requests,
    slow: (next: (url: URL) => Promise<void>) => {
      delay = next;
    },
  };
}

const repo = { space: "ann", name: "shop" };
const route = (request: string) => {
  const url = new URL(request, "http://atlas.test");
  return {
    route: url.pathname.replace("/api/repos/ann/shop/atlas/", ""),
    id: url.searchParams.get("id"),
    q: url.searchParams.get("q"),
    kind: url.searchParams.get("kind"),
    snapshot: url.searchParams.get("snapshot"),
    path: url.pathname,
  };
};

/** The page's own machinery: a children loader and a focus resolver over the client. */
function page(snapshot: string) {
  const loads = new Map<string, Load>();
  const requested = new Set<string>();
  const loader = new ChildLoader(
    snapshot,
    async (id, cursor, signal) => {
      const p = await atlasApi.children(repo, id, { snapshot, cursor, signal, limit: 100 });
      return { items: p.items, next: p.next, total: p.counts.knownTotal };
    },
    (id, load) => loads.set(id, load),
  );
  const focuses: Focus[] = [];
  const resolver = new FocusResolver(
    (id, signal) => atlasApi.ancestors(repo, id, { snapshot, signal }),
    (id) => {
      if (requested.has(id)) return;
      requested.add(id);
      void loader.load(id);
    },
    (focus) => focuses.push(focus),
  );
  const settled = () =>
    vi.waitFor(() => {
      expect([...loads.values()].every((l) => l.state !== "loading")).toBe(true);
      expect(focuses.at(-1)?.state).not.toBe("resolving");
    });
  const expanded = () => {
    const ready = new Map<string, AtlasEntitySummary[]>();
    for (const [id, load] of loads) if (load.state === "ready") ready.set(id, load.items);
    return ready;
  };
  return { loads, focuses, resolver, settled, expanded };
}

describe("the repository Atlas's navigation", () => {
  test("a cold link to a symbol reads its ancestors, the path's children and its detail, nothing else", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    await writeAtlasFixtureGraph(s.env.DB, "r2", "other", C1);
    await publishAtlasFixture(s.env, "r2", C1);

    // The loader reads the bounded overview; the link names a symbol inside it.
    const overview = await atlasApi.overview(repo);
    const target = "sym:billing/ledger/ledger.ts#post";
    const p = page(overview.snapshot.id);
    void p.resolver.focus(target);
    await p.settled();
    const focus = p.focuses.at(-1)!;
    expect(focus).toMatchObject({ state: "ready", id: target, entity: { kind: "symbol" } });
    const chain = (focus as Extract<Focus, { state: "ready" }>).ancestors!;
    // Repository, capability, maybe an area, then the file defining it.
    expect(chain[0]?.kind).toBe("repository");
    expect(chain[1]?.kind).toBe("capability");
    expect(chain.at(-1)?.id).toBe("file:billing/ledger/ledger.ts");
    // The inspector reads its detail.
    await atlasApi.detail(repo, target, { snapshot: overview.snapshot.id });

    // Exactly: overview, ancestors, one children page per level of the path, detail.
    const path = chain.slice(1).map((a) => a.id);
    expect(s.requests.map(route).map((r) => [r.route, r.id])).toEqual([
      ["overview", null],
      ["ancestors", target],
      ...path.map((id) => ["children", id]),
      ["detail", target],
    ]);
    expect(s.requests.every((r) => r.startsWith("/api/repos/ann/shop/atlas/"))).toBe(true);
    expect(s.requests.slice(1).every((r) => route(r).snapshot === overview.snapshot.id)).toBe(true);
    expect(s.touched).toEqual([]);

    // The map now draws the path down to the symbol's file, inside its area
    // and capability; the symbol is among the file's loaded children.
    const territory = buildTerritory(overview.regions, p.expanded(), overview.snapshot.seq);
    const file = territory.byId.get("file:billing/ledger/ledger.ts");
    expect(file?.depth).toBe(path.length - 1);
    expect(file?.parent).toBe(path.at(-2));
    expect(
      p
        .expanded()
        .get("file:billing/ledger/ledger.ts")
        ?.map((e) => e.id),
    ).toContain(target);
  });

  test("going back to something already on the map reads nothing new", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const overview = await atlasApi.overview(repo);
    const p = page(overview.snapshot.id);
    const billing = overview.regions.find((r) => r.name.toLowerCase().includes("billing"))!;
    expect(billing).toBeDefined();
    await p.resolver.focus(billing.id, billing);
    await p.settled();
    const before = s.requests.length;
    // Back to it again: drawn, and its children are already loaded.
    await p.resolver.focus(billing.id, billing);
    await p.settled();
    expect(s.requests.slice(before)).toEqual([]);
    expect(p.focuses.at(-1)).toMatchObject({ state: "ready", ancestors: null });
  });

  test("a late answer for an earlier selection never replaces the newer one", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const overview = await atlasApi.overview(repo);
    const p = page(overview.snapshot.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    s.slow(async (url) => {
      if (url.searchParams.get("id") === "file:search/rank.ts") await held;
    });
    void p.resolver.focus("file:search/rank.ts");
    void p.resolver.focus("file:ops/health.ts");
    await vi.waitFor(() => expect(p.focuses.at(-1)).toMatchObject({ state: "ready" }));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(
      p.focuses.filter((f) => f.state === "ready").map((f) => f.state === "ready" && f.id),
    ).toEqual(["file:ops/health.ts"]);
  });

  test("a retired capability's link says it merged and where, and its own snapshot still has it", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    const first = await publishAtlasFixture(s.env, "r1", C1);
    const before = await atlasApi.overview(repo);
    const ops = await atlasApi.ancestors(repo, "file:ops/deploy.ts");
    const opsCapability = ops.ancestors.find((a) => a.kind === "capability")!;
    const searchCapability = (await atlasApi.ancestors(repo, "file:search/rank.ts")).ancestors.find(
      (a) => a.kind === "capability",
    )!;
    expect(opsCapability.id).not.toBe(searchCapability.id);
    expect(before.regions.map((r) => r.id)).toContain(opsCapability.id);

    // Operations comes to run through search: the next build merges them.
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C2, "merged");
    const second = await publishAtlasFixture(s.env, "r1", C2);

    const current = page(second.snapshotId);
    await current.resolver.focus(opsCapability.id);
    const missing = current.focuses.at(-1)!;
    expect(missing).toMatchObject({
      state: "missing",
      error: {
        code: "entity_unknown",
        lineage: {
          change: "merged",
          retiredSeq: second.seq,
          successors: [{ id: searchCapability.id }],
        },
      },
    });

    // The old link, pinned to its own snapshot, still shows what it showed.
    const old = page(first.snapshotId);
    await old.resolver.focus(opsCapability.id);
    expect(old.focuses.at(-1)).toMatchObject({ state: "ready", entity: { id: opsCapability.id } });
  });

  test("an expired snapshot's link is explicit and names the current one, never switching", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    const first = await publishAtlasFixture(s.env, "r1", C1);
    const second = await publishAtlasFixture(s.env, "r1", C2);
    // Kept while retained, with when it goes.
    const pinned = await atlasApi.overview(repo, { snapshot: first.snapshotId });
    expect(pinned.snapshot).toMatchObject({ id: first.snapshotId });
    expect(pinned.snapshot.expiresAt).not.toBeNull();

    await expireAtlasPriors(s.env.DB, "r1");
    const error = await atlasApi
      .overview(repo, { snapshot: first.snapshotId })
      .then(() => null, atlasErrorOf);
    expect(error).toMatchObject({
      code: "snapshot_expired",
      current: { id: second.snapshotId, seq: second.seq },
      expired: { reason: "count" },
    });
    // A view still open on it learns the same way, and isn't moved.
    const p = page(first.snapshotId);
    await p.resolver.focus("file:search/rank.ts");
    expect(p.focuses.at(-1)).toMatchObject({
      state: "restart",
      error: { code: "snapshot_expired", current: { id: second.snapshotId } },
    });
  });

  test("the lookup reads only this repository's catalogue, once per pause, newest answer only", async () => {
    const s = await setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const overview: AtlasOverview = await atlasApi.overview(repo);
    const states: LookupState[] = [];
    const lookup = new CatalogueLookup(
      (q, kind, cursor, signal) =>
        atlasApi.catalogue(repo, q, {
          kind: kind ?? undefined,
          snapshot: overview.snapshot.id,
          cursor,
          signal,
          limit: 2,
        }),
      (state) => states.push(state),
      15,
    );
    s.requests.length = 0;
    for (const typed of ["l", "le", "led", "ledg"]) lookup.lookup(typed, null);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("done"));
    expect(s.requests.map(route).map((r) => [r.route, r.q])).toEqual([["catalogue", "ledg"]]);
    const done = states.at(-1) as Extract<LookupState, { status: "done" }>;
    expect(done.items.length).toBe(2);
    expect(done.next).not.toBeNull();
    // Page to the end: every match once, the ledger's file among them.
    const last = () => states.at(-1) as Extract<LookupState, { status: "done" }>;
    while (last().next) {
      lookup.more();
      await vi.waitFor(() => expect(last().more).toBe(false));
    }
    const all = last().items.map((e) => e.id);
    expect(all).toContain("file:billing/ledger/ledger.ts");
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(last().counts.knownTotal);
    expect(s.requests.map(route).every((r) => r.route === "catalogue" && r.q === "ledg")).toBe(
      true,
    );

    // Narrowed to files; then cleared, which reads nothing.
    s.requests.length = 0;
    lookup.lookup("ledg", "file", true);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("done"));
    lookup.lookup("", "file");
    expect(states.at(-1)).toEqual({ status: "idle" });
    expect(s.requests.map(route).map((r) => [r.route, r.q, r.kind])).toEqual([
      ["catalogue", "ledg", "file"],
    ]);
    expect(s.touched).toEqual([]);
    lookup.dispose();
  });
});
