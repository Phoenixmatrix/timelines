import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  ATLAS_OVERVIEW_REGIONS,
  type AtlasEntitySummary,
  type AtlasError,
  type AtlasEvidence,
  type AtlasRegion,
  type AtlasRelation,
  type AtlasWorkspaceAncestors,
  type AtlasWorkspaceDetail,
  type AtlasWorkspaceOverview,
  type AtlasWorkspacePage,
} from "../../shared/atlas.ts";
import { atlasNeedsRestart, atlasWorkspaceApi } from "../../src/lib/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  beginRepoProjection,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";
import { CURSOR_TTL_MS, enforceRetention } from "./retention.ts";
import { workspaceAtlas } from "./workspace.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => vi.restoreAllMocks());

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const carl: Actor = { id: "carl", slug: "carl", displayName: "Carl", isSiteAdmin: false };

/** A private name nothing outside ann/secret may ever show. */
const SECRET = "Zephyrvault";

function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`Workspace Atlas touched ${name}.${String(key)}`);
      },
    },
  );
}

function database() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'), ('carl', 'user', 'carl', 'Carl');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_open', 'ann', 'open', 'public', 'a1', ''),
      ('r_secret', 'ann', 'secret', 'private', 'a2', ''),
      ('r_twin', 'ann', 'twin', 'private', 'a3', ''),
      ('r_nokg', 'ann', 'nokg', 'private', 'a4', ''),
      ('r_building', 'ann', 'building', 'private', 'a5', ''),
      ('r_failed', 'ann', 'failed', 'private', 'a6', ''),
      ('r_bens', 'ben', 'bens', 'public', 'a7', '');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('r_secret', 'ben', 'read');
    INSERT INTO kg_builds (id, repo_id, to_commit, status) VALUES
      ('kb1', 'r_building', 'c1', 'running'),
      ('kb2', 'r_failed', 'c1', 'failed');
  `);
  return sqlite;
}

/** An app over `sqlite`; a second one over the same database is a cold start. */
function app(sqlite: DatabaseSync) {
  const touched: string[] = [];
  const env = {
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    AI: forbidden("AI", touched),
    VECTORS: forbidden("VECTORS", touched),
    SEARCH: forbidden("SEARCH", touched),
    KNOWLEDGE: forbidden("KNOWLEDGE", touched),
    KNOWLEDGE_QUEUE: forbidden("KNOWLEDGE_QUEUE", touched),
    KNOWLEDGE_BUILD: forbidden("KNOWLEDGE_BUILD", touched),
  } as unknown as Env;
  let actor: Actor | null = ann;
  const hono = new Hono<AppEnv>();
  hono.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  hono.route("/api/accounts/:owner/atlas", workspaceAtlas);
  const call = (path: string, owner = "ann") =>
    hono.request(`/api/accounts/${owner}/atlas/${path}`, {}, env);
  return {
    db: env.DB,
    touched,
    call,
    /** Status and body text, for comparing responses byte for byte. */
    text: async (path: string, owner = "ann") => {
      const response = await call(path, owner);
      return `${response.status} ${await response.text()}`;
    },
    get: async <T>(path: string, owner = "ann"): Promise<T> => {
      const response = await call(path, owner);
      if (response.status !== 200)
        throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    },
    serveClient: () =>
      vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
        hono.request(String(input), init ?? {}, env),
      ),
    as: (next: Actor | null) => {
      actor = next;
    },
  };
}

function node(
  sqlite: DatabaseSync,
  repo: string,
  id: string,
  kind: string,
  name: string,
  path: string | null,
  summary = "",
  data: Record<string, unknown> = {},
) {
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'h', 'c')
       ON CONFLICT (repo_id, id) DO UPDATE SET name = excluded.name, summary = excluded.summary, data = excluded.data`,
    )
    .run(repo, id, kind, name, path, summary, JSON.stringify(data));
}
function edge(sqlite: DatabaseSync, repo: string, src: string, dst: string, kind: string) {
  sqlite
    .prepare(
      `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
    )
    .run(repo, src, dst, kind);
}

const pad = (n: number) => String(n).padStart(4, "0");

/** Components named `<label> NNNN`, component i holding `files(i)` files, plus a hub and its importers. */
function seed(
  sqlite: DatabaseSync,
  repo: string,
  label: string,
  { components = 3, files = (i: number) => 3 + (components - i) } = {},
) {
  node(sqlite, repo, "repo", "repository", repo, null, `${label} root`);
  for (let i = 0; i < components; i++) {
    const id = `component:c${pad(i)}`;
    node(sqlite, repo, id, "component", `${label} ${pad(i)}`, `c${pad(i)}`, `${label} does ${i}`);
    edge(sqlite, repo, "repo", id, "contains");
    for (let f = 0; f < files(i); f++) {
      const path = `c${pad(i)}/${label.toLowerCase()}${pad(f)}.ts`;
      node(sqlite, repo, `file:${path}`, "file", `${label.toLowerCase()}${pad(f)}.ts`, path, "", {
        blob: `${repo}-${i}-${f}`,
        lines: 10,
      });
      edge(sqlite, repo, id, `file:${path}`, "contains");
    }
  }
  node(sqlite, repo, "file:hub.ts", "file", "hub.ts", "hub.ts", `${label} hub`, { blob: "hub" });
  for (let i = 0; i < 3; i++) {
    const path = `c0000/${label.toLowerCase()}${pad(i)}.ts`;
    edge(sqlite, repo, `file:${path}`, "file:hub.ts", "imports");
  }
}

async function publish(db: D1Database, repo: string, commit: string) {
  const { snapshotId, seq } = await beginRepoProjection(db, repo, [
    { repoId: repo, commit, buildId: `b-${repo}-${commit}` },
  ]);
  let after: string | null = null;
  do ({ next: after } = await projectEntities(db, repo, snapshotId, seq, after, 500));
  while (after);
  let cursor: EdgeCursor = null;
  do ({ next: cursor } = await projectEdges(db, repo, snapshotId, seq, cursor, 1000));
  while (cursor);
  await publishProjection(db, repoScope(repo), snapshotId, seq);
  return { snapshotId, seq };
}

/** ann's open (public) and secret (private, shared with ben) repositories, built. */
async function world() {
  const sqlite = database();
  seed(sqlite, "r_open", "Harbor", { components: 10 });
  seed(sqlite, "r_secret", SECRET, { components: 6, files: (i) => 20 - i });
  const s = app(sqlite);
  const open = await publish(s.db, "r_open", "o1");
  const secret = await publish(s.db, "r_secret", "s1");
  return { sqlite, s, open, secret };
}

const enc = encodeURIComponent;

/** Follow a page's `next` through `route`, collecting every page. */
async function traverse<T>(
  s: ReturnType<typeof app>,
  route: string,
  query: string,
  first?: AtlasWorkspacePage<T>,
) {
  const pages: AtlasWorkspacePage<T>[] = first ? [first] : [];
  let next = first ? first.next : null;
  if (!first) {
    const page = await s.get<AtlasWorkspacePage<T>>(`${route}?${query}`);
    pages.push(page);
    next = page.next;
  }
  while (next) {
    const page: AtlasWorkspacePage<T> = await s.get<AtlasWorkspacePage<T>>(
      `${route}?${query}&cursor=${enc(next)}`,
    );
    pages.push(page);
    next = page.next;
  }
  return pages;
}

describe("Atlas workspace scope", () => {
  test("the overview composes every selected repository, each with its own vector and state", async () => {
    const { s, open, secret } = await world();
    const overview = await s.get<AtlasWorkspaceOverview>(
      "overview?repos=open,secret,nokg,building,failed,ghost",
    );
    expect(overview.scope).toMatch(/^ws:ann:[0-9a-f]{32}$/);
    expect(overview.owner).toEqual({ id: "ann", slug: "ann" });
    // Listed by id, each with its own snapshot: no common HEAD. A name that
    // doesn't exist (ghost) is simply not there.
    expect(
      overview.snapshot.repos.map((r) => [r.name, r.state, r.snapshot?.vector ?? null, r.building]),
    ).toEqual([
      ["building", "building", null, true],
      ["failed", "unavailable", null, false],
      ["nokg", "not-enabled", null, false],
      [
        "open",
        "ready",
        [{ repoId: "r_open", sourceId: "canonical", commit: "o1", buildId: "b-r_open-o1" }],
        false,
      ],
      [
        "secret",
        "ready",
        [{ repoId: "r_secret", sourceId: "canonical", commit: "s1", buildId: "b-r_secret-s1" }],
        false,
      ],
    ]);
    expect(overview.snapshot.repos.find((r) => r.name === "open")?.snapshot?.id).toBe(
      open.snapshotId,
    );
    expect(overview.snapshot.repos.every((r) => r.capacityFailure === null)).toBe(true);

    // Regions of both ranked as one list, largest first, groups last.
    const all = [...overview.regions, ...overview.catalogue.items];
    expect(overview.catalogue.next).toBeNull();
    expect(overview.regions).toHaveLength(ATLAS_OVERVIEW_REGIONS);
    expect(overview.totalRegions).toBe(all.length);
    expect(all.slice(4, 8).map((r) => [r.repoId, r.id, r.size.files])).toEqual([
      ["r_secret", "r_secret/component:c0004", 16],
      ["r_secret", "r_secret/component:c0005", 15],
      ["r_open", "r_open/component:c0000", 13],
      ["r_open", "r_open/component:c0001", 12],
    ]);
    const semantic = all.filter((r) => !r.structural);
    expect(all.slice(0, semantic.length)).toEqual(semantic);
    expect(
      all.every((r) => r.id.startsWith(`${r.repoId}/`) && r.parentId === `${r.repoId}/repo`),
    ).toBe(true);
    expect(secret.seq).toBeGreaterThan(0);
    // Browsing never reached a model, an index or a build, and started nothing.
    expect(s.touched).toEqual([]);
  });

  test("ranked pages merge repositories exactly, ties broken by repository", async () => {
    const sqlite = database();
    // Identical repositories: every key ties across them.
    seed(sqlite, "r_open", "Same", { components: 30, files: (i) => 3 + (i % 4) });
    seed(sqlite, "r_twin", "Same", { components: 30, files: (i) => 3 + (i % 4) });
    const s = app(sqlite);
    await publish(s.db, "r_open", "o1");
    await publish(s.db, "r_twin", "t1");

    const overview = await s.get<AtlasWorkspaceOverview>("overview?repos=open,twin");
    const pages = await traverse<AtlasRegion>(s, "regions", "repos=open,twin&limit=7");
    const ids = [...overview.regions, ...pages.flatMap((p) => p.items)].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(overview.totalRegions);
    // Same place, both repositories, open's id first.
    for (let i = 0; i < 20; i += 2) {
      expect(ids[i]?.split("/")[1]).toBe(ids[i + 1]?.split("/")[1]);
      expect([ids[i]?.split("/")[0], ids[i + 1]?.split("/")[0]]).toEqual(["r_open", "r_twin"]);
    }
    expect(pages.at(-1)?.counts).toMatchObject({
      loaded: overview.totalRegions - ATLAS_OVERVIEW_REGIONS,
      knownTotal: overview.totalRegions - ATLAS_OVERVIEW_REGIONS,
    });

    const lookups = await traverse<AtlasEntitySummary>(
      s,
      "catalogue",
      "repos=open,twin&q=same0001&limit=9",
    );
    const found = lookups.flatMap((p) => p.items);
    expect(found).toHaveLength(60);
    expect(new Set(found.map((e) => e.id)).size).toBe(60);
    expect(lookups[0]?.counts.knownTotal).toBe(60);
    expect(found.filter((e) => e.repoId === "r_twin")).toHaveLength(30);
  });

  test("entities are read by namespaced id from their repository's snapshot", async () => {
    const { s, sqlite, open } = await world();
    const q = "repos=open,secret";
    const detail = await s.get<AtlasWorkspaceDetail>(
      `detail?${q}&id=${enc("r_open/component:c0000")}`,
    );
    expect(detail.entity).toMatchObject({
      id: "r_open/component:c0000",
      repoId: "r_open",
      parentId: "r_open/repo",
      name: "Harbor 0000",
    });
    expect(detail.ancestors.map((a) => a.id)).toEqual(["r_open/repo"]);
    // Only the repository read is described.
    expect(detail.snapshot.repos.map((r) => r.id)).toEqual(["r_open"]);

    const file = "r_open/file:c0000/harbor0002.ts";
    const ancestors = await s.get<AtlasWorkspaceAncestors>(`ancestors?${q}&id=${enc(file)}`);
    expect(ancestors.ancestors.map((a) => a.id)).toEqual(["r_open/repo", "r_open/component:c0000"]);

    const relations = await s.get<AtlasWorkspacePage<AtlasRelation>>(
      `relations?${q}&id=${enc("r_open/file:hub.ts")}&direction=in`,
    );
    expect(relations.items.map((r) => [r.src, r.dst, r.neighbor?.repoId])).toEqual([
      ["r_open/file:c0000/harbor0000.ts", "r_open/file:hub.ts", "r_open"],
      ["r_open/file:c0000/harbor0001.ts", "r_open/file:hub.ts", "r_open"],
      ["r_open/file:c0000/harbor0002.ts", "r_open/file:hub.ts", "r_open"],
    ]);

    const evidence = await s.get<AtlasWorkspacePage<AtlasEvidence>>(
      `evidence?${q}&id=${enc("r_open/component:c0001")}`,
    );
    expect(evidence.items.map((e) => [e.entityId, e.repoId, e.commit])).toEqual(
      Array.from({ length: 12 }, (_, f) => [
        `r_open/file:c0001/harbor${pad(f)}.ts`,
        "r_open",
        "o1",
      ]),
    );

    // Children page through the composite they were pinned to while open moves on.
    const children = await s.get<AtlasWorkspacePage<AtlasEntitySummary>>(
      `children?${q}&id=${enc("r_open/component:c0000")}&limit=3`,
    );
    sqlite.exec(
      `UPDATE kg_nodes SET name = 'Renamed' WHERE repo_id = 'r_open' AND id LIKE 'file:c0000/%'`,
    );
    await publish(s.db, "r_open", "o2");
    const rest = await traverse(
      s,
      "children",
      `${q}&id=${enc("r_open/component:c0000")}&limit=3`,
      children,
    );
    const names = rest.flatMap((p) => p.items.map((e) => e.name));
    expect(names).toHaveLength(13);
    expect(names.some((n) => n === "Renamed")).toBe(false);
    expect(rest.every((p) => p.snapshot.id === children.snapshot.id)).toBe(true);
    expect(rest.every((p) => p.snapshot.repos[0]?.snapshot?.id === open.snapshotId)).toBe(true);
    // Pinned explicitly, the old composite still reads the old snapshot.
    const old = await s.get<AtlasWorkspaceDetail>(
      `detail?${q}&id=${enc(file)}&snapshot=${enc(children.snapshot.id)}`,
    );
    expect(old.entity.name).toBe("harbor0002.ts");
    const now = await s.get<AtlasWorkspaceDetail>(`detail?${q}&id=${enc(file)}`);
    expect(now.entity.name).toBe("Renamed");
    expect(now.snapshot.id).not.toBe(children.snapshot.id);

    // Unknown entities, malformed ids and repositories outside the scope look alike.
    const unknown = await s.text(`detail?${q}&id=${enc("r_open/nothing")}`);
    expect(unknown).toMatch(/^404 .*entity_unknown/);
    for (const id of ["r_bens/repo", "r_nokg/repo", "repo", "r_open/", "/repo", "r_twin/repo"])
      expect(await s.text(`detail?${q}&id=${enc(id)}`), id).toBe(unknown);
  });

  test("a selected repository the caller can't read changes nothing, and looks like one that doesn't exist", async () => {
    const { s } = await world();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T12:00:00Z"));
    s.as(carl);
    const routes = [
      "overview",
      "regions?limit=2",
      "catalogue?q=a",
      `catalogue?q=${SECRET}`,
      `children?id=${enc("r_open/component:c0000")}&limit=2`,
      `detail?id=${enc("r_secret/repo")}`,
      `evidence?id=${enc("r_secret/component:c0000")}`,
      `relations?id=${enc("r_secret/file:hub.ts")}&direction=in`,
    ];
    for (const route of routes) {
      const join = route.includes("?") ? "&" : "?";
      const only = await s.text(`${route}${join}repos=open`);
      expect(await s.text(`${route}${join}repos=open,secret`), route).toBe(only);
      expect(await s.text(`${route}${join}repos=secret,open,ghost`), route).toBe(only);
      expect(await s.text(`${route}${join}repos=ann/secret,open,ben/bens`), route).toBe(only);
      expect(only).not.toContain(SECRET);
      expect(only).not.toContain("r_secret");
    }
    // Nothing readable selected: the same answer whatever the reason.
    const empty = await s.text("overview?repos=secret");
    expect(empty).toMatch(/^404 .*scope_empty/);
    for (const [path, owner] of [
      ["overview?repos=ghost", "ann"],
      ["overview?repos=secret,ghost", "ann"],
      ["detail?repos=secret&id=r_secret%2Frepo", "ann"],
      ["overview?repos=secret", "nobody"],
    ] as const)
      expect(await s.text(path, owner), path).toBe(empty);
    s.as(null);
    expect(await s.text("overview?repos=secret")).toBe(empty);
    // Another account's repository never joins ann's workspace.
    s.as(ann);
    const mine = await s.get<AtlasWorkspaceOverview>("overview?repos=open,ben/bens,bens");
    expect(mine.snapshot.repos.map((r) => r.id)).toEqual(["r_open"]);
    // The selection must be explicit and bounded.
    expect((await s.call("overview")).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `r${i}`).join(",");
    expect((await s.call(`overview?repos=${many}`)).status).toBe(400);
  });

  test("forged scope, snapshot and cursor ids can't widen the scope", async () => {
    const { s } = await world();
    // ann's scope holds secret: her composite id and cursors are hers alone.
    const annView = await s.get<AtlasWorkspaceOverview>("overview?repos=open,secret");
    const annPage = await s.get<AtlasWorkspacePage<AtlasEntitySummary>>(
      `children?repos=open,secret&id=${enc("r_secret/component:c0000")}&limit=2`,
    );
    const openView = await s.get<AtlasWorkspaceOverview>("overview?repos=open");
    expect(openView.scope).not.toBe(annView.scope);

    s.as(carl);
    const expectCode = async (path: string, status: number, code: string) => {
      const response = await s.call(path);
      const text = await response.text();
      expect(response.status, path).toBe(status);
      expect((JSON.parse(text) as AtlasError).code, path).toBe(code);
      expect(text, path).not.toContain(SECRET);
      expect(text, path).not.toContain("r_secret");
    };
    // ann's composite id doesn't belong to carl's (narrower) scope.
    await expectCode(
      `overview?repos=open,secret&snapshot=${enc(annView.snapshot.id)}`,
      404,
      "snapshot_unknown",
    );
    // Made-up composites: wrong version, tag, length, or seqs.
    const [, tag] = openView.snapshot.id.split(".");
    for (const forged of [
      "nope",
      `ws1.${tag}`,
      `ws1.${tag}.1.1`,
      `ws1.${tag}.x`,
      `ws1.000000000000.1`,
      `ws1.${tag}.999`,
    ])
      await expectCode(`overview?repos=open&snapshot=${enc(forged)}`, 404, "snapshot_unknown");
    // ann's cursor, replayed by carl, or by ann under another selection.
    const cursor = enc(annPage.next ?? "");
    await expectCode(
      `children?repos=open,secret&id=${enc("r_secret/component:c0000")}&cursor=${cursor}`,
      400,
      "cursor_invalid",
    );
    s.as(ann);
    await expectCode(
      `children?repos=open,secret&id=${enc("r_secret/component:c0001")}&cursor=${cursor}`,
      400,
      "cursor_invalid",
    );
    await expectCode(
      `regions?repos=open&cursor=${enc(annView.catalogue.next ?? "x.y")}`,
      400,
      "cursor_invalid",
    );
    expect(
      (
        await s.call(
          `children?repos=open,secret&id=${enc("r_secret/component:c0000")}&cursor=${cursor}`,
        )
      ).status,
    ).toBe(200);
  });

  test("revoking access while an overview and cursors are open discloses nothing, warm or cold", async () => {
    const { s, sqlite } = await world();
    s.as(ben);
    const q = "repos=open,secret";
    const before = await s.get<AtlasWorkspaceOverview>(`overview?${q}`);
    expect(JSON.stringify(before)).toContain(SECRET);
    const children = await s.get<AtlasWorkspacePage<AtlasEntitySummary>>(
      `children?${q}&id=${enc("r_secret/component:c0000")}&limit=5`,
    );
    const lookup = await s.get<AtlasWorkspacePage<AtlasEntitySummary>>(
      `catalogue?${q}&q=${SECRET.toLowerCase()}&limit=5`,
    );
    expect(lookup.items.length).toBe(5);
    const regions = await s.get<AtlasWorkspacePage<AtlasRegion>>(`regions?${q}&limit=1`);
    expect(regions.next).not.toBeNull();

    sqlite.exec(`DELETE FROM repo_collaborators WHERE repo_id = 'r_secret' AND user_id = 'ben'`);

    const cold = app(sqlite);
    cold.as(ben);
    for (const [label, view] of [
      ["warm", s],
      ["cold", cold],
    ] as const) {
      const continued = [
        `children?${q}&id=${enc("r_secret/component:c0000")}&limit=5&cursor=${enc(children.next ?? "")}`,
        `catalogue?${q}&q=${SECRET.toLowerCase()}&limit=5&cursor=${enc(lookup.next ?? "")}`,
        `regions?${q}&limit=1&cursor=${enc(regions.next ?? "")}`,
      ];
      for (const path of continued) {
        const text = await view.text(path);
        expect(text, `${label} ${path}`).toMatch(/^400 .*cursor_invalid/);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("r_secret");
      }
      const pinned = await view.text(`overview?${q}&snapshot=${enc(before.snapshot.id)}`);
      expect(pinned, label).toMatch(/^404 .*snapshot_unknown/);
      expect(pinned).not.toContain(SECRET);
      // Fresh requests: exactly what ben gets without secret selected.
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T12:00:00Z"));
      for (const route of [
        "overview",
        `catalogue?q=${SECRET.toLowerCase()}`,
        `detail?id=${enc("r_secret/component:c0000")}`,
        `evidence?id=${enc("r_secret/component:c0000")}`,
      ]) {
        const join = route.includes("?") ? "&" : "?";
        const after = await view.text(`${route}${join}${q}`);
        expect(after, `${label} ${route}`).toBe(await view.text(`${route}${join}repos=open`));
        expect(after).not.toContain(SECRET);
        expect(after).not.toContain("r_secret");
      }
      vi.restoreAllMocks();
    }
    const after = await s.get<AtlasWorkspaceOverview>(`overview?${q}`);
    expect(after.snapshot.repos.map((r) => r.id)).toEqual(["r_open"]);
    expect(after.totalRegions).toBeLessThan(before.totalRegions);
    expect(after.scope).not.toBe(before.scope);

    // Making a public repository private revokes it the same way.
    s.as(carl);
    const carls = await s.get<AtlasWorkspacePage<AtlasRegion>>("regions?repos=open&limit=1");
    sqlite.exec(`UPDATE repos SET visibility = 'private' WHERE id = 'r_open'`);
    expect(await s.text(`regions?repos=open&limit=1&cursor=${enc(carls.next ?? "")}`)).toMatch(
      /^404 .*scope_empty/,
    );
  });

  test("an expired repository snapshot in a pinned composite is explicit", async () => {
    const { s, sqlite } = await world();
    const q = "repos=open,secret";
    const page = await s.get<AtlasWorkspacePage<AtlasRegion>>(`regions?${q}&limit=2`);
    sqlite.exec(`UPDATE kg_nodes SET summary = 'v2' WHERE repo_id = 'r_open' AND id = 'repo'`);
    await publish(s.db, "r_open", "o2");
    // Still retained: the composite reads on.
    expect((await s.call(`regions?${q}&limit=2&cursor=${enc(page.next ?? "")}`)).status).toBe(200);
    await enforceRetention(s.db, [repoScope("r_open")], { policy: { maxPrior: 0 } });
    const current = await s.get<AtlasWorkspaceOverview>(`overview?${q}`);
    for (const path of [
      `regions?${q}&limit=2&cursor=${enc(page.next ?? "")}`,
      `overview?${q}&snapshot=${enc(page.snapshot.id)}`,
      `detail?${q}&id=${enc("r_open/repo")}&snapshot=${enc(page.snapshot.id)}`,
    ]) {
      const response = await s.call(path);
      expect(response.status, path).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "snapshot_expired",
        current: { id: current.snapshot.id, seq: null },
        expired: { reason: "count" },
      });
    }
    // secret's snapshot wasn't touched: its entities still read pinned.
    expect(
      (await s.call(`detail?${q}&id=${enc("r_secret/repo")}&snapshot=${enc(page.snapshot.id)}`))
        .status,
    ).toBe(200);
  });

  test("workspace cursors expire 30 minutes after issue", async () => {
    const { s } = await world();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const page = await s.get<AtlasWorkspacePage<AtlasRegion>>("regions?repos=open,secret&limit=2");
    const next = `regions?repos=open,secret&limit=2&cursor=${enc(page.next ?? "")}`;
    clock.mockReturnValue(start + CURSOR_TTL_MS - 1);
    expect((await s.call(next)).status).toBe(200);
    clock.mockReturnValue(start + CURSOR_TTL_MS + 1);
    const expired = await s.call(next);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as AtlasError).code).toBe("cursor_expired");
  });

  test("the typed client browses a workspace and knows when to restart", async () => {
    const { s } = await world();
    s.serveClient();
    try {
      const workspace = { owner: "ann", repos: ["secret", "open"] };
      const overview = await atlasWorkspaceApi.overview(workspace);
      expect(overview.snapshot.repos.map((r) => r.name)).toEqual(["open", "secret"]);
      const region = overview.regions[0]!;
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: AtlasWorkspacePage<AtlasEntitySummary> = await atlasWorkspaceApi.children(
          workspace,
          region.id,
          { cursor, limit: 7 },
        );
        ids.push(...page.items.map((e) => e.id));
        cursor = page.next;
      } while (cursor);
      expect(ids).toHaveLength(20);
      const detail = await atlasWorkspaceApi.detail(workspace, ids[0]!, {
        snapshot: overview.snapshot.id,
      });
      expect(detail.ancestors.map((a) => a.id)).toEqual(["r_secret/repo", region.id]);
      const found = await atlasWorkspaceApi.catalogue(workspace, "harbor0003", { kind: "file" });
      expect(found.items.every((e) => e.repoId === "r_open")).toBe(true);
      const gone = await atlasWorkspaceApi
        .overview(workspace, { snapshot: "ws1.bad" })
        .catch((e: unknown) => e);
      expect(atlasNeedsRestart(gone)).toBe(true);
      expect(s.touched).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
