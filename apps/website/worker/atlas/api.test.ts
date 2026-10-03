import { gzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  ATLAS_OVERVIEW_MAX_BYTES,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_PAGE_DEFAULT,
  ATLAS_PAGE_MAX,
  type AtlasAncestors,
  type AtlasDetail,
  type AtlasEntitySummary,
  type AtlasError,
  type AtlasEvidence,
  type AtlasOverview,
  type AtlasPage,
  type AtlasRegion,
  type AtlasRelation,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { atlasApi, atlasNeedsRestart } from "../../src/lib/atlas.ts";
import { atlas } from "./api.ts";
import {
  beginRepoProjection,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";
import { admitProjection, CURSOR_TTL_MS, enforceRetention } from "./retention.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => vi.restoreAllMocks());

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };

/** Any touch of a model, index or build binding fails the request (and is recorded). */
function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`Atlas reads touched ${name}.${String(key)}`);
      },
    },
  );
}

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'engine', 'private', 'art-r1', ''),
      ('r2', 'ann', 'other', 'private', 'art-r2', '');
  `);
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
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/repos/:owner/:name/atlas", atlas);
  const call = (path: string, repo = "engine") =>
    app.request(`/api/repos/ann/${repo}/atlas/${path}`, {}, env);
  const get = async <T>(path: string, repo = "engine"): Promise<T> => {
    const response = await call(path, repo);
    if (response.status !== 200)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  return {
    sqlite,
    db: env.DB,
    /** Route the browser client's fetches into this app. */
    serveClient: () =>
      vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
        app.request(String(input), init ?? {}, env),
      ),
    touched,
    call,
    get,
    as: (next: Actor | null) => {
      actor = next;
    },
  };
}

type Setup = ReturnType<typeof setup>;

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
      `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT DO NOTHING`,
    )
    .run(repo, src, dst, kind);
}

/** Project a repository's stored graph and publish it, the way the build does. */
async function publish(db: D1Database, repo: string, commit: string, { grouped = false } = {}) {
  const { snapshotId, seq } = await beginRepoProjection(db, repo, [
    { repoId: repo, commit, buildId: `b-${commit}` },
  ]);
  if (grouped) await groupRepoCapabilities(db, repo, snapshotId, seq);
  let after: string | null = null;
  do ({ next: after } = await projectEntities(db, repo, snapshotId, seq, after, 500));
  while (after);
  let cursor: EdgeCursor = null;
  do ({ next: cursor } = await projectEdges(db, repo, snapshotId, seq, cursor, 1000));
  while (cursor);
  await publishProjection(db, repoScope(repo), snapshotId, seq);
  return { snapshotId, seq };
}

const pad = (n: number) => String(n).padStart(4, "0");

/**
 * A repository with `components` components of decreasing size, a hub file
 * imported by `importers` files, a concept mentioned by them, a symbol and a
 * package. Component c0000 has the most files.
 */
function seed(
  sqlite: DatabaseSync,
  repo: string,
  { components = 3, filesPerComponent = (i: number) => 3 + (components - i), importers = 5 } = {},
) {
  node(sqlite, repo, "repo", "repository", "engine", null, "The engine");
  for (let i = 0; i < components; i++) {
    const id = `component:c${pad(i)}`;
    node(sqlite, repo, id, "component", `Component ${pad(i)}`, `c${pad(i)}`, `Does ${i}`);
    edge(sqlite, repo, "repo", id, "contains");
    for (let f = 0; f < filesPerComponent(i); f++) {
      const path = `c${pad(i)}/f${pad(f)}.ts`;
      node(sqlite, repo, `file:${path}`, "file", `f${pad(f)}.ts`, path, "", {
        blob: `blob-${i}-${f}`,
        lines: 10 + f,
      });
      edge(sqlite, repo, id, `file:${path}`, "contains");
    }
  }
  node(sqlite, repo, "file:hub.ts", "file", "hub.ts", "hub.ts", "The hub", {
    blob: "blob-hub",
    lines: 99,
  });
  node(sqlite, repo, "sym:hub.ts#route", "symbol", "route", "hub.ts", "Routes", { line: 12 });
  edge(sqlite, repo, "file:hub.ts", "sym:hub.ts#route", "defines");
  node(sqlite, repo, "concept:routing", "concept", "Routing", null, "Where requests go");
  node(sqlite, repo, "pkg:npm:hono", "package", "hono", null);
  edge(sqlite, repo, "file:hub.ts", "pkg:npm:hono", "imports");
  for (let i = 0; i < importers; i++) {
    const path = `users/u${pad(i)}.ts`;
    node(sqlite, repo, `file:${path}`, "file", `u${pad(i)}.ts`, path, "", { blob: `ub-${i}` });
    edge(sqlite, repo, `file:${path}`, "file:hub.ts", "imports");
    edge(sqlite, repo, `file:${path}`, "concept:routing", "mentions");
  }
}

/** Follow `next` from `first` to the end, collecting every page. */
async function traverse<T>(
  s: Setup,
  route: string,
  query: string,
  between?: (pageIndex: number) => Promise<void>,
) {
  const pages: AtlasPage<T>[] = [];
  let next: string | null = null;
  do {
    const cursor: string = next ? `&cursor=${encodeURIComponent(next)}` : "";
    const page: AtlasPage<T> = await s.get<AtlasPage<T>>(`${route}?${query}${cursor}`);
    pages.push(page);
    next = page.next;
    if (between) await between(pages.length);
  } while (next);
  return pages;
}

describe("Atlas read API", () => {
  test("the overview ranks at most 12 regions by primary files and pages the rest", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 40 });
    const { snapshotId, seq } = await publish(s.db, "r1", "c1");

    const overview = await s.get<AtlasOverview>("overview");
    expect(overview.scope).toBe("repo:r1");
    expect(overview.snapshot).toMatchObject({
      id: snapshotId,
      seq,
      vector: [{ repoId: "r1", commit: "c1", buildId: "b-c1" }],
      partial: false,
      expiresAt: null,
    });
    expect(overview.root?.id).toBe("repo");
    expect(overview.regions).toHaveLength(ATLAS_OVERVIEW_REGIONS);
    // Largest first: c0000 has the most files.
    expect(overview.regions.map((r) => r.id).slice(0, 3)).toEqual([
      "component:c0000",
      "component:c0001",
      "component:c0002",
    ]);
    expect(overview.regions[0]?.size).toEqual({ files: 43, members: 43 });
    // 40 components + the unclassified (hub and users) and concepts/dependencies groups.
    expect(overview.totalRegions).toBe(43);
    expect(overview.catalogue.counts).toEqual({
      loaded: overview.catalogue.items.length,
      knownTotal: 43 - ATLAS_OVERVIEW_REGIONS,
      unknownTotal: false,
    });
    expect(overview.catalogue.items.length).toBeLessThanOrEqual(ATLAS_PAGE_DEFAULT);

    // The rest of the catalogue continues at /regions, pinned to the same snapshot.
    const all: AtlasRegion[] = [...overview.regions, ...overview.catalogue.items];
    let next = overview.catalogue.next;
    while (next) {
      const page = await s.get<AtlasPage<AtlasRegion>>(
        `regions?cursor=${encodeURIComponent(next)}`,
      );
      expect(page.snapshot.id).toBe(snapshotId);
      all.push(...page.items);
      next = page.next;
    }
    expect(new Set(all.map((r) => r.id)).size).toBe(43);
    expect(all).toHaveLength(43);
    // Components by primary files, then the structural groups, though the
    // unclassified group (6 files) outweighs the smallest components (4).
    const semantic = all.slice(0, 40);
    expect(semantic.every((r) => !r.structural)).toBe(true);
    const files = semantic.map((r) => r.size.files);
    expect(files).toEqual([...files].sort((a, b) => b - a));
    expect(all.slice(40).map((r) => r.id)).toEqual([
      "group:unclassified",
      "group:concepts",
      "group:dependencies",
    ]);
    expect(overview.capacityFailure).toBeNull();
  });

  test("children, relations and evidence traverse completely while a newer snapshot publishes", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 250, importers: 230 });
    const first = await publish(s.db, "r1", "c1");

    const expected = {
      children: Array.from({ length: 250 }, (_, f) => `file:c0000/f${pad(f)}.ts`),
      importers: Array.from({ length: 230 }, (_, i) => `file:users/u${pad(i)}.ts`),
    };
    /** Mid-traversal push: files go, new ones arrive, edges move; a new snapshot publishes. */
    let pushes = 0;
    const pushAfterFirstPage = async (pageIndex: number) => {
      if (pageIndex !== 1) return;
      pushes++;
      const tag = `${pushes}`;
      s.sqlite.exec(`
        DELETE FROM kg_nodes WHERE repo_id = 'r1' AND id IN ('file:c0000/f0001.ts', 'file:c0000/f0200.ts', 'file:users/u0003.ts', 'file:users/u0150.ts');
        DELETE FROM kg_edges WHERE repo_id = 'r1' AND (src IN ('file:users/u0003.ts', 'file:users/u0150.ts') OR dst IN ('file:c0000/f0001.ts', 'file:c0000/f0200.ts'));
      `);
      node(
        s.sqlite,
        "r1",
        `file:c0000/a-new-${tag}.ts`,
        "file",
        `a-new-${tag}.ts`,
        `c0000/a-new-${tag}.ts`,
      );
      edge(s.sqlite, "r1", "component:c0000", `file:c0000/a-new-${tag}.ts`, "contains");
      edge(s.sqlite, "r1", `file:c0000/a-new-${tag}.ts`, "file:hub.ts", "imports");
      edge(s.sqlite, "r1", `file:c0000/a-new-${tag}.ts`, "concept:routing", "mentions");
      await publish(s.db, "r1", `c${pushes + 1}`);
    };

    const children = await traverse<AtlasEntitySummary>(
      s,
      "children",
      "id=component%3Ac0000&limit=100",
      pushAfterFirstPage,
    );
    expect(children.map((p) => p.items.length)).toEqual([100, 100, 50]);
    expect(children.every((p) => p.snapshot.id === first.snapshotId)).toBe(true);
    expect(children.flatMap((p) => p.items.map((e) => e.id))).toEqual(expected.children);
    expect(children.at(-1)?.counts).toEqual({ loaded: 250, knownTotal: 250, unknownTotal: false });

    const relations = await traverse<AtlasRelation>(
      s,
      "relations",
      `id=file%3Ahub.ts&direction=in&kind=imports&limit=100&snapshot=${first.snapshotId}`,
      pushAfterFirstPage,
    );
    expect(relations.every((p) => p.snapshot.id === first.snapshotId)).toBe(true);
    const sources = relations.flatMap((p) => p.items.map((r) => r.src));
    expect(sources).toEqual(expected.importers);
    expect(relations.flatMap((p) => p.items).every((r) => r.neighbor?.id === r.src)).toBe(true);
    expect(relations.at(-1)?.counts).toEqual({ loaded: 230, knownTotal: 230, unknownTotal: false });

    const evidence = await traverse<AtlasEvidence>(
      s,
      "evidence",
      `id=concept%3Arouting&limit=100&snapshot=${first.snapshotId}`,
      pushAfterFirstPage,
    );
    expect(evidence.every((p) => p.snapshot.id === first.snapshotId)).toBe(true);
    expect(evidence.flatMap((p) => p.items.map((e) => e.entityId))).toEqual(expected.importers);
    expect(
      evidence.flatMap((p) => p.items).every((e) => e.via === "mentions" && e.commit === "c1"),
    ).toBe(true);

    // Meanwhile the current snapshot moved on and reads differently.
    const current = await s.get<AtlasPage<AtlasEntitySummary>>(
      "children?id=component%3Ac0000&limit=5",
    );
    expect(current.snapshot.seq).toBe(first.seq + 3);
    expect(current.items[0]?.id).toBe("file:c0000/a-new-1.ts");
    expect(current.counts.knownTotal).toBe(250 - 2 + 3);
  });

  test("pages hold at most 100 records whatever the request asks", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 150, importers: 120 });
    await publish(s.db, "r1", "c1");
    const children = await s.get<AtlasPage<unknown>>("children?id=component%3Ac0000&limit=5000");
    expect(children.items).toHaveLength(ATLAS_PAGE_MAX);
    expect(children.next).not.toBeNull();
    const relations = await s.get<AtlasPage<unknown>>(
      "relations?id=file%3Ahub.ts&direction=in&limit=101",
    );
    expect(relations.items).toHaveLength(ATLAS_PAGE_MAX);
    const catalogue = await s.get<AtlasPage<unknown>>("catalogue?limit=1000");
    expect(catalogue.items).toHaveLength(ATLAS_PAGE_MAX);
    const evidence = await s.get<AtlasPage<unknown>>("evidence?id=concept%3Arouting&limit=1000");
    expect(evidence.items).toHaveLength(ATLAS_PAGE_MAX);
    expect((await s.call("children?id=component%3Ac0000&limit=0")).status).toBe(400);
  });

  test("the initial overview stays well inside 256 KiB on a large projection", async () => {
    const s = setup();
    const long = "Handles a great many things in a very particular way. ".repeat(200);
    node(s.sqlite, "r1", "repo", "repository", "engine", null, long, {
      techStack: Array.from({ length: 500 }, (_, i) => `tech-${i}`),
    });
    for (let i = 0; i < 1500; i++) {
      const id = `component:c${pad(i)}`;
      node(
        s.sqlite,
        "r1",
        id,
        "component",
        `Component ${pad(i)} ${"x".repeat(80)}`,
        `c${pad(i)}`,
        long,
        {
          responsibilities: Array.from({ length: 200 }, (_, r) => `responsibility ${r} of ${i}`),
          keyFiles: Array.from({ length: 100 }, (_, r) => `c${pad(i)}/key-${r}.ts`),
        },
      );
      edge(s.sqlite, "r1", "repo", id, "contains");
      node(s.sqlite, "r1", `file:c${pad(i)}/a.ts`, "file", "a.ts", `c${pad(i)}/a.ts`, long);
      edge(s.sqlite, "r1", id, `file:c${pad(i)}/a.ts`, "contains");
    }
    await publish(s.db, "r1", "c1");

    const response = await s.call("overview");
    expect(response.status).toBe(200);
    const json = await response.text();
    const overview = JSON.parse(json) as AtlasOverview;
    expect(overview.regions).toHaveLength(ATLAS_OVERVIEW_REGIONS);
    expect(overview.regions.every((r) => r.summaryTruncated)).toBe(true);
    expect(overview.totalRegions).toBe(1500);
    // Uncompressed, it's under half the compressed bound; compressed, far less.
    const bytes = new TextEncoder().encode(json).length;
    expect(bytes).toBeLessThan(ATLAS_OVERVIEW_MAX_BYTES / 2);
    expect(gzipSync(json).length).toBeLessThan(ATLAS_OVERVIEW_MAX_BYTES / 8);
  });

  test("forged and replayed cursors are rejected, recoverably", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 2, filesPerComponent: () => 30, importers: 30 });
    seed(s.sqlite, "r2", { components: 2, filesPerComponent: () => 30, importers: 30 });
    s.sqlite.exec(`UPDATE repos SET visibility = 'public'`);
    const one = await publish(s.db, "r1", "c1");
    await publish(s.db, "r2", "c1");

    const page = await s.get<AtlasPage<unknown>>("children?id=component%3Ac0000&limit=10");
    const cursor = page.next ?? "";
    expect(cursor).not.toBe("");
    const expectInvalid = async (path: string, repo = "engine") => {
      const response = await s.call(path, repo);
      expect(response.status).toBe(400);
      const body = (await response.json()) as AtlasError;
      expect(body.code).toBe("cursor_invalid");
      // Recoverable: it names the current snapshot to restart from.
      expect(body.current?.id).toBeDefined();
    };
    const c = encodeURIComponent(cursor);

    // It works where it was issued.
    expect((await s.call(`children?id=component%3Ac0000&limit=10&cursor=${c}`)).status).toBe(200);
    // Another filter, route, scope or snapshot.
    await expectInvalid(`children?id=component%3Ac0001&cursor=${c}`);
    await expectInvalid(`evidence?id=component%3Ac0000&cursor=${c}`);
    await expectInvalid(`children?id=component%3Ac0000&cursor=${c}`, "other");
    s.sqlite.exec(`UPDATE kg_nodes SET summary = 'changed' WHERE repo_id = 'r1' AND id = 'repo'`);
    const two = await publish(s.db, "r1", "c2");
    await expectInvalid(`children?id=component%3Ac0000&snapshot=${two.snapshotId}&cursor=${c}`);
    expect(
      (await s.call(`children?id=component%3Ac0000&snapshot=${one.snapshotId}&cursor=${c}`)).status,
    ).toBe(200);
    // Another principal, signed in or not.
    s.as(ben);
    await expectInvalid(`children?id=component%3Ac0000&cursor=${c}`);
    s.as(null);
    await expectInvalid(`children?id=component%3Ac0000&cursor=${c}`);
    s.as({ ...ann, agent: { id: "agt_1", name: "bot" } });
    await expectInvalid(`children?id=component%3Ac0000&cursor=${c}`);
    s.as(ann);
    // Tampered payloads and made-up cursors.
    const [payload, mac] = cursor.split(".");
    const decoded = JSON.parse(
      atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as unknown[];
    decoded[2] = "";
    const forged = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expectInvalid(
      `children?id=component%3Ac0000&cursor=${encodeURIComponent(`${forged}.${mac}`)}`,
    );
    await expectInvalid(`children?id=component%3Ac0000&cursor=garbage`);
    await expectInvalid(
      `children?id=component%3Ac0000&cursor=${encodeURIComponent(`${payload}.`)}`,
    );

    // Past 30 minutes, it has expired.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CURSOR_TTL_MS + 1);
    const expired = await s.call(`children?id=component%3Ac0000&limit=10&cursor=${c}`);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as AtlasError).code).toBe("cursor_expired");
  });

  test("unknown and expired snapshots are explicit, never the current one", async () => {
    const s = setup();
    seed(s.sqlite, "r1");
    const missing = await s.call("overview");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as AtlasError).code).toBe("atlas_unavailable");

    const one = await publish(s.db, "r1", "c1");
    s.sqlite.exec(`UPDATE kg_nodes SET summary = 'v2' WHERE repo_id = 'r1' AND id = 'repo'`);
    const two = await publish(s.db, "r1", "c2");

    // Pinned to the older one, it reads what it published.
    const pinned = await s.get<AtlasOverview>(`overview?snapshot=${one.snapshotId}`);
    expect(pinned.snapshot.id).toBe(one.snapshotId);
    expect(pinned.root?.summary).toBe("The engine");

    const unknown = await s.call("overview?snapshot=nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      code: "snapshot_unknown",
      current: { id: two.snapshotId, seq: two.seq },
    });

    // A cursor into a snapshot that then expires stops too.
    const page = await s.get<AtlasPage<unknown>>(
      `children?id=component%3Ac0000&limit=2&snapshot=${one.snapshotId}`,
    );
    s.sqlite
      .prepare(`UPDATE atlas_snapshots SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), one.snapshotId);
    for (const path of [
      `overview?snapshot=${one.snapshotId}`,
      `children?id=component%3Ac0000&limit=2&cursor=${encodeURIComponent(page.next ?? "")}`,
      `detail?id=repo&snapshot=${one.snapshotId}`,
    ]) {
      const response = await s.call(path);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "snapshot_expired",
        current: { id: two.snapshotId },
      });
    }
    s.sqlite
      .prepare(`UPDATE atlas_snapshots SET status = 'expired', expires_at = NULL WHERE id = ?`)
      .run(one.snapshotId);
    expect((await s.call(`overview?snapshot=${one.snapshotId}`)).status).toBe(410);

    // A snapshot of another scope is unknown here.
    seed(s.sqlite, "r2");
    const other = await publish(s.db, "r2", "c1");
    expect((await s.call(`overview?snapshot=${other.snapshotId}`)).status).toBe(404);
  });

  test("an unreadable repository looks exactly like a missing one, cursor or not", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 20 });
    await publish(s.db, "r1", "c1");
    const page = await s.get<AtlasPage<unknown>>("children?id=component%3Ac0000&limit=5");
    const cursor = encodeURIComponent(page.next ?? "");

    s.as(ben);
    const nowhere = await s.call("overview", "nowhere");
    const missingBody = await nowhere.text();
    expect(nowhere.status).toBe(404);
    for (const path of [
      "overview",
      "regions",
      "children?id=component%3Ac0000",
      `children?id=component%3Ac0000&limit=5&cursor=${cursor}`,
      "children?cursor=garbage",
      "detail?id=repo",
      "ancestors?id=file%3Ac0000%2Ff0001.ts",
      "relations?id=file%3Ahub.ts&direction=sideways",
      "evidence?id=component%3Ac0000",
      "catalogue?q=Component",
      "overview?snapshot=nope",
    ]) {
      const response = await s.call(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe(missingBody);
    }
    s.as(null);
    const anonymous = await s.call("overview");
    expect(anonymous.status).toBe(404);
    expect(await anonymous.text()).toBe(missingBody);
  });

  test("detail, ancestors, evidence and catalogue serve deep links without a model", async () => {
    const s = setup();
    seed(s.sqlite, "r1");
    await publish(s.db, "r1", "c1");

    const detail = await s.get<AtlasDetail>("detail?id=file%3Ac0000%2Ff0001.ts");
    expect(detail.entity).toMatchObject({
      id: "file:c0000/f0001.ts",
      kind: "file",
      parentId: "component:c0000",
      data: { blob: "blob-0-1", lines: 11 },
    });
    expect(detail.ancestors.map((a) => a.id)).toEqual(["repo", "component:c0000"]);

    const hub = await s.get<AtlasDetail>("detail?id=file%3Ahub.ts");
    expect(hub.counts).toEqual({
      children: 1,
      outgoing: { defines: 1, imports: 1 },
      incoming: { imports: 5 },
    });

    const ancestors = await s.get<AtlasAncestors>("ancestors?id=sym%3Ahub.ts%23route");
    expect(ancestors.ancestors.map((a) => a.id)).toEqual([
      "repo",
      "group:unclassified",
      "file:hub.ts",
    ]);
    expect((await s.call("ancestors?id=nothing")).status).toBe(404);
    expect(((await (await s.call("detail?id=nothing")).json()) as AtlasError).code).toBe(
      "entity_unknown",
    );

    const symbol = await s.get<AtlasPage<AtlasEvidence>>("evidence?id=sym%3Ahub.ts%23route");
    expect(symbol.items).toEqual([
      {
        entityId: "sym:hub.ts#route",
        kind: "symbol",
        repoId: "r1",
        commit: "c1",
        path: "hub.ts",
        blob: "blob-hub",
        range: { startLine: 12, endLine: null, status: "start-line" },
        via: "defines",
        analysis: "analyzed",
      },
    ]);
    const file = await s.get<AtlasPage<AtlasEvidence>>("evidence?id=file%3Ausers%2Fu0001.ts");
    expect(file.items[0]?.range).toEqual({ startLine: null, endLine: null, status: "unavailable" });
    const component = await s.get<AtlasPage<AtlasEvidence>>("evidence?id=component%3Ac0001");
    expect(component.items.map((e) => [e.path, e.via])).toEqual([
      ["c0001/f0000.ts", "member"],
      ["c0001/f0001.ts", "member"],
      ["c0001/f0002.ts", "member"],
      ["c0001/f0003.ts", "member"],
      ["c0001/f0004.ts", "member"],
    ]);
    const pkg = await s.get<AtlasPage<AtlasEvidence>>("evidence?id=pkg%3Anpm%3Ahono");
    expect(pkg.items.map((e) => [e.path, e.via])).toEqual([["hub.ts", "imports"]]);

    const out = await s.get<AtlasPage<AtlasRelation>>("relations?id=file%3Ahub.ts&direction=out");
    expect(out.items.map((r) => [r.dst, r.kind, r.neighbor?.name])).toEqual([
      ["pkg:npm:hono", "imports", "hono"],
      ["sym:hub.ts#route", "defines", "route"],
    ]);
    expect((await s.call("relations?id=file%3Ahub.ts&direction=sideways")).status).toBe(400);

    const lookup = await s.get<AtlasPage<AtlasEntitySummary>>("catalogue?q=HUB");
    expect(lookup.items.map((e) => e.id)).toEqual(["file:hub.ts", "sym:hub.ts#route"]);
    const files = await s.get<AtlasPage<AtlasEntitySummary>>("catalogue?q=hub&kind=file");
    expect(files.items.map((e) => e.id)).toEqual(["file:hub.ts"]);
    // LIKE wildcards are literal.
    expect((await s.get<AtlasPage<unknown>>("catalogue?q=%25")).items).toEqual([]);
    expect((await s.get<AtlasPage<unknown>>("catalogue?q=_")).items).toEqual([]);

    // Not one route reached a model, an index or a build.
    expect(s.touched).toEqual([]);
  });

  test("a partial snapshot says its totals are floors", async () => {
    const s = setup();
    seed(s.sqlite, "r1");
    node(s.sqlite, "r1", "file:late.ts", "file", "late.ts", "late.ts", "", { pending: true });
    await publish(s.db, "r1", "c1");
    const page = await s.get<AtlasPage<AtlasEvidence>>("evidence?id=file%3Alate.ts");
    expect(page.snapshot.partial).toBe(true);
    expect(page.counts).toEqual({ loaded: 1, knownTotal: 1, unknownTotal: true });
    expect(page.items[0]?.analysis).toBe("pending");
  });

  test("the typed client pages through a pinned traversal and knows when to restart", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 7 });
    const first = await publish(s.db, "r1", "c1");
    s.serveClient();
    try {
      const repo = { owner: "ann", name: "engine" };
      const overview = await atlasApi.overview(repo);
      expect(overview.snapshot.id).toBe(first.snapshotId);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: AtlasPage<AtlasEntitySummary> = await atlasApi.children(
          repo,
          "component:c0000",
          {
            cursor,
            limit: 3,
          },
        );
        ids.push(...page.items.map((e) => e.id));
        cursor = page.next;
      } while (cursor);
      expect(ids).toHaveLength(7);
      const detail = await atlasApi.detail(repo, "file:c0000/f0001.ts", {
        snapshot: first.snapshotId,
      });
      expect(detail.ancestors.map((a) => a.id)).toEqual(["repo", "component:c0000"]);
      const lookup = await atlasApi.catalogue(repo, "f0002", { kind: "file" });
      expect(lookup.items.map((e) => e.id)).toEqual(["file:c0000/f0002.ts"]);

      const error = await atlasApi.overview(repo, { snapshot: "gone" }).catch((e: unknown) => e);
      expect(atlasNeedsRestart(error)).toBe(true);
      const page = await atlasApi.children(repo, "component:c0000", { limit: 3 });
      const replayed = await atlasApi
        .evidence(repo, "component:c0000", { cursor: page.next })
        .catch((e: unknown) => e);
      expect(atlasNeedsRestart(replayed)).toBe(true);
      expect(s.touched).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("retention evicting a snapshot mid-traversal stops its cursor and pins explicitly", async () => {
    const scenarios = [
      {
        reason: "count",
        evict: (db: D1Database) =>
          enforceRetention(db, [repoScope("r1")], { policy: { maxPrior: 0 } }),
      },
      {
        reason: "storage",
        evict: (db: D1Database) =>
          enforceRetention(db, [repoScope("r1")], { policy: { capBytes: 1 } }),
      },
      {
        reason: "age",
        // Stamped now, due in an hour; read past that, before any sweep marks it.
        evict: async (db: D1Database) => {
          await enforceRetention(db, [repoScope("r1")], { policy: { priorTtlMs: 60 * 60 * 1000 } });
          const now = Date.now();
          vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60 * 1000);
          return null;
        },
      },
    ] as const;
    for (const { reason, evict } of scenarios) {
      const s = setup();
      seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 30 });
      const one = await publish(s.db, "r1", "c1");
      const first = await s.get<AtlasPage<AtlasEntitySummary>>(
        "children?id=component%3Ac0000&limit=10",
      );
      expect(first.snapshot).toMatchObject({ id: one.snapshotId, expiresAt: null });
      // A push publishes a new snapshot: the cursor still reads its own.
      s.sqlite.exec(`DELETE FROM kg_nodes WHERE repo_id = 'r1' AND id LIKE 'file:c0000/f001%'`);
      const two = await publish(s.db, "r1", "c2");
      const second = await s.get<AtlasPage<AtlasEntitySummary>>(
        `children?id=component%3Ac0000&limit=10&cursor=${encodeURIComponent(first.next ?? "")}`,
      );
      expect(second.snapshot.id).toBe(one.snapshotId);
      expect(second.items.map((e) => e.id)[0]).toBe("file:c0000/f0010.ts");

      // Retention evicts it before the next page.
      const result = await evict(s.db);
      if (result) {
        expect(result.expired).toEqual([
          { id: one.snapshotId, scope: "repo:r1", seq: one.seq, reason },
        ]);
        // Its rows really are going: reading them would be wrong, not just stale.
        expect(result.reclaimed.entities).toBeGreaterThan(0);
      }
      for (const path of [
        `children?id=component%3Ac0000&limit=10&cursor=${encodeURIComponent(second.next ?? "")}`,
        `children?id=component%3Ac0000&snapshot=${one.snapshotId}`,
        `overview?snapshot=${one.snapshotId}`,
        `catalogue?q=f00&snapshot=${one.snapshotId}`,
      ]) {
        const response = await s.call(path);
        expect(response.status, `${reason} ${path}`).toBe(410);
        const body = (await response.json()) as AtlasError;
        expect(body, `${reason} ${path}`).toMatchObject({
          code: "snapshot_expired",
          current: { id: two.snapshotId, seq: two.seq },
          expired: { reason },
        });
      }
      // The current snapshot is unaffected.
      expect((await s.get<AtlasOverview>("overview")).snapshot.id).toBe(two.snapshotId);
      vi.restoreAllMocks();
    }
  });

  test("cursors expire 30 minutes after issue by retention's rule, each page issuing anew", async () => {
    const s = setup();
    seed(s.sqlite, "r1", { components: 1, filesPerComponent: () => 30 });
    await publish(s.db, "r1", "c1");
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const first = await s.get<AtlasPage<unknown>>("children?id=component%3Ac0000&limit=10");
    // Just inside its 30 minutes it works, and the page it returns issues a new cursor.
    clock.mockReturnValue(start + CURSOR_TTL_MS - 1);
    const second = await s.get<AtlasPage<unknown>>(
      `children?id=component%3Ac0000&limit=10&cursor=${encodeURIComponent(first.next ?? "")}`,
    );
    clock.mockReturnValue(start + CURSOR_TTL_MS + 1);
    const expired = await s.call(
      `children?id=component%3Ac0000&limit=10&cursor=${encodeURIComponent(first.next ?? "")}`,
    );
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as AtlasError).code).toBe("cursor_expired");
    const third = await s.get<AtlasPage<unknown>>(
      `children?id=component%3Ac0000&limit=10&cursor=${encodeURIComponent(second.next ?? "")}`,
    );
    expect(third.counts.loaded).toBe(30);
  });

  test("the overview reports a capacity failure that left the current snapshot stale", async () => {
    const s = setup();
    seed(s.sqlite, "r1");
    const one = await publish(s.db, "r1", "c1");
    s.sqlite.exec(`UPDATE kg_nodes SET summary = 'v2' WHERE repo_id = 'r1' AND id = 'repo'`);
    const { snapshotId, seq } = await beginRepoProjection(s.db, "r1", [
      { repoId: "r1", commit: "c2", buildId: "b-c2" },
    ]);
    let after: string | null = null;
    do ({ next: after } = await projectEntities(s.db, "r1", snapshotId, seq, after, 500));
    while (after);
    const admission = await admitProjection(s.db, repoScope("r1"), snapshotId, {
      policy: { capBytes: 1 },
    });
    expect(admission.admitted).toBe(false);

    const overview = await s.get<AtlasOverview>("overview");
    expect(overview.snapshot.id).toBe(one.snapshotId);
    expect(overview.root?.summary).toBe("The engine");
    expect(overview.capacityFailure).toMatchObject({ snapshotId, seq });
    expect(overview.capacityFailure?.error).toMatch(/Capacity/);

    // The next build that fits clears it.
    await publish(s.db, "r1", "c3");
    expect((await s.get<AtlasOverview>("overview")).capacityFailure).toBeNull();
  });

  test("a grouped projection leads with capabilities, groups after, areas beneath", async () => {
    const s = setup();
    const sqlite = s.sqlite;
    node(sqlite, "r1", "repo", "repository", "shop", null, "A shop");
    const cluster = (dir: string, n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `file:${dir}/f${i}.ts`);
      for (const id of ids) {
        const path = id.slice(5);
        node(sqlite, "r1", id, "file", path.split("/").pop()!, path, "", { blob: path, lines: 5 });
      }
      for (const a of ids) for (const b of ids) if (a !== b) edge(sqlite, "r1", a, b, "imports");
      return ids;
    };
    // Two tight parts woven together form one capability with two areas; a
    // lightly linked group stays its own capability, related to it (v3).
    const pay = cluster("pay/a", 4);
    const cart = cluster("pay/b", 4);
    for (let i = 0; i < 4; i++) {
      edge(sqlite, "r1", pay[i]!, cart[i]!, "imports");
      edge(sqlite, "r1", cart[i]!, pay[(i + 1) % 4]!, "imports");
    }
    const notify = cluster("notify", 3);
    edge(sqlite, "r1", notify[0]!, pay[0]!, "imports");
    cluster("big", 6);
    // Ten files with no evidence: an unclassified group bigger than any capability.
    for (let i = 0; i < 10; i++)
      node(sqlite, "r1", `file:misc/n${i}.ts`, "file", `n${i}.ts`, `misc/n${i}.ts`);
    await publish(s.db, "r1", "c1", { grouped: true });

    const overview = await s.get<AtlasOverview>("overview");
    expect(overview.regions.map((r) => [r.kind, r.size.files, r.size.members])).toEqual([
      ["capability", 8, 2],
      ["capability", 6, 6],
      ["capability", 3, 3],
      ["group", 10, 10],
    ]);
    // The lightly linked group is a separate capability that depends on payments.
    const notifyCap = overview.regions[2]!;
    const related = await s.get<AtlasPage<{ dst: string; kind: string; weight: number }>>(
      `relations?id=${encodeURIComponent(notifyCap.id)}&direction=out`,
    );
    expect(related.items).toEqual([
      expect.objectContaining({ dst: overview.regions[0]!.id, kind: "depends_on", weight: 1 }),
    ]);
    expect(overview.regions[3]?.id).toBe("group:unclassified");
    expect(overview.regions.map((r) => r.structural)).toEqual([false, false, false, true]);
    expect(overview.totalRegions).toBe(4);
    const payments = overview.regions[0]!;

    // Its areas are its children; their files are theirs.
    const areas = await s.get<AtlasPage<AtlasEntitySummary>>(
      `children?id=${encodeURIComponent(payments.id)}`,
    );
    expect(areas.items.map((a) => [a.kind, a.counts.files])).toEqual([
      ["area", 4],
      ["area", 4],
    ]);
    const files = await Promise.all(
      areas.items.map((a) =>
        s.get<AtlasPage<AtlasEntitySummary>>(`children?id=${encodeURIComponent(a.id)}`),
      ),
    );
    expect(files.flatMap((p) => p.items.map((f) => f.id)).sort()).toEqual([...pay, ...cart].sort());
    const detail = await s.get<AtlasDetail>(`detail?id=${encodeURIComponent(pay[2]!)}`);
    expect(detail.ancestors.map((a) => a.kind)).toEqual(["repository", "capability", "area"]);
    expect(
      (await s.get<AtlasDetail>(`detail?id=${encodeURIComponent(payments.id)}`)).counts.children,
    ).toBe(2);

    // A capability's evidence is its areas' files, each once.
    const evidence = await s.get<AtlasPage<AtlasEvidence>>(
      `evidence?id=${encodeURIComponent(payments.id)}`,
    );
    expect(evidence.items.map((e) => e.entityId).sort()).toEqual([...pay, ...cart].sort());
    expect(evidence.items.every((e) => e.via === "member" && e.commit === "c1")).toBe(true);
    expect(evidence.counts.knownTotal).toBe(8);

    // The catalogue finds capabilities and areas by kind.
    const caps = await s.get<AtlasPage<AtlasEntitySummary>>("catalogue?kind=capability");
    expect(caps.items).toHaveLength(3);
    expect(caps.counts.knownTotal).toBe(3);
    const named = await s.get<AtlasPage<AtlasEntitySummary>>(
      `catalogue?q=${encodeURIComponent(payments.name)}&kind=capability`,
    );
    expect(named.items.map((e) => e.id)).toContain(payments.id);
    const areaHits = await s.get<AtlasPage<AtlasEntitySummary>>("catalogue?kind=area");
    expect(areaHits.items.map((a) => a.id).sort()).toEqual(areas.items.map((a) => a.id).sort());
  });
});
