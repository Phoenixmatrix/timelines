import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  AtlasCrossLink,
  AtlasWorkspaceComposition,
  AtlasWorkspacePage,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { clearCompositionCache, compose, PublisherIndex } from "./compose.ts";
import {
  beginRepoProjection,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";
import { recordPublishedPackages, type RecordedPackage } from "./publishers.ts";
import { workspaceAtlas } from "./workspace.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

beforeEach(() => clearCompositionCache());

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };

/** The registry's own database, from its migrations. */
function registryDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../registry/migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  const now = "2026-10-01T00:00:00.000Z";
  sqlite.exec(`
    INSERT INTO repositories (id, key, format, owner_id, kind, visibility, created_at, updated_at) VALUES
      ('feed_npm', 'ann', 'npm', 'ann', 'local', 'private', '${now}', '${now}');
    INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at) VALUES
      ('p_core', 'feed_npm', '@ann/billing-core', '@ann/billing-core', '${now}', '${now}'),
      ('p_shared', 'feed_npm', '@ann/shared', '@ann/shared', '${now}', '${now}');
    INSERT INTO package_sources (package_id, git_repo_id, granted_by, granted_at) VALUES
      ('p_core', 'r_core', 'job:j1', '${now}'),
      ('p_shared', 'r_core', 'job:j2', '${now}'),
      ('p_shared', 'r_docs', 'job:j3', '${now}');
    INSERT INTO publishes (id, feed_id, format, package_id, version, action, git_repo_id, commit_oid, ref,
                           ci_run_id, ci_job_id, run_number, actor, actor_label, via, at) VALUES
      ('u1', 'feed_npm', 'npm', 'p_core', '1.1.0', 'publish', 'r_core', 'c0ffee1', 'refs/heads/main',
       'run6', 'j1', 6, 'job:j1', 'ann/core · CI #6', 'job', '2026-09-30T00:00:00.000Z'),
      ('u2', 'feed_npm', 'npm', 'p_core', '1.2.0', 'publish', 'r_core', 'c0ffee2', 'refs/heads/main',
       'run7', 'j1', 7, 'job:j1', 'ann/core · CI #7', 'job', '2026-10-01T00:00:00.000Z');
  `);
  return sqlite;
}

function database(visibility: "public" | "private" = "private") {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_app', 'ann', 'app', '${visibility}', 'a1', ''),
      ('r_core', 'ann', 'core', '${visibility}', 'a2', ''),
      ('r_docs', 'ann', 'docs', '${visibility}', 'a3', '');
    -- Ben reads the app and the docs, never the core.
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES
      ('r_app', 'ben', 'read'), ('r_docs', 'ben', 'read');
  `);
  return sqlite;
}

function node(sqlite: DatabaseSync, repo: string, id: string, kind: string, name = id) {
  const path = id.startsWith("file:") ? id.slice(5) : null;
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES (?, ?, ?, ?, ?, '', ?, 'h', 'c')`,
    )
    .run(
      repo,
      id,
      kind,
      kind === "file" ? (path ?? id).split("/").pop()! : name,
      path,
      JSON.stringify(kind === "file" ? { blob: `blob-${repo}-${path}`, lines: 20 } : {}),
    );
}
const edge = (sqlite: DatabaseSync, repo: string, src: string, dst: string, kind: string) =>
  sqlite
    .prepare(`INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1)`)
    .run(repo, src, dst, kind);

/** Files chained by imports, all mentioning `concepts`: one capability's worth. */
function cluster(sqlite: DatabaseSync, repo: string, paths: string[], concepts: string[]) {
  for (const path of paths) node(sqlite, repo, `file:${path}`, "file");
  for (let i = 1; i < paths.length; i++)
    edge(sqlite, repo, `file:${paths[i]}`, `file:${paths[i - 1]}`, "imports");
  for (const path of paths)
    for (const concept of concepts) edge(sqlite, repo, `file:${path}`, concept, "mentions");
}

/**
 * app: a billing UI importing @ann/billing-core (published by core), react
 * (published by nobody here) and @ann/shared (published by core and docs),
 * plus deployment scripts. core: the billing engine (invoicing, ledger) and
 * auth. docs: invoicing guides, sharing a concept with the UI and nothing else.
 */
function seed(sqlite: DatabaseSync) {
  for (const repo of ["r_app", "r_core", "r_docs"]) node(sqlite, repo, "repo", "repository", repo);
  for (const [repo, ids] of [
    ["r_app", ["invoicing", "deployment"]],
    ["r_core", ["invoicing", "ledger", "auth"]],
    ["r_docs", ["invoicing", "publishing"]],
  ] as const)
    for (const id of ids)
      node(sqlite, repo, `concept:${id}`, "concept", id[0]!.toUpperCase() + id.slice(1));

  const ui = ["web/src/invoice-list.ts", "web/src/invoice-view.ts", "web/src/checkout.ts"];
  cluster(sqlite, "r_app", ui, ["concept:invoicing"]);
  cluster(
    sqlite,
    "r_app",
    ["ops/deploy.ts", "ops/rollback.ts", "ops/canary.ts"],
    ["concept:deployment"],
  );
  node(sqlite, "r_app", "file:web/package.json", "file");
  node(sqlite, "r_app", "file:package.json", "file");
  for (const pkg of ["pkg:npm:@ann/billing-core", "pkg:npm:react", "pkg:npm:@ann/shared"])
    node(sqlite, "r_app", pkg, "package", pkg.slice(8));
  edge(sqlite, "r_app", `file:${ui[1]}`, "pkg:npm:@ann/billing-core", "imports");
  edge(sqlite, "r_app", `file:${ui[2]}`, "pkg:npm:@ann/billing-core", "imports");
  edge(sqlite, "r_app", `file:${ui[0]}`, "pkg:npm:react", "imports");
  edge(sqlite, "r_app", `file:${ui[2]}`, "pkg:npm:@ann/shared", "imports");

  cluster(
    sqlite,
    "r_core",
    ["src/invoice.ts", "src/ledger.ts", "src/tax.ts"],
    ["concept:invoicing", "concept:ledger"],
  );
  cluster(
    sqlite,
    "r_core",
    ["src/auth/login.ts", "src/auth/session.ts", "src/auth/token.ts"],
    ["concept:auth"],
  );

  cluster(
    sqlite,
    "r_docs",
    ["guides/invoices.ts", "guides/credit-notes.ts", "guides/refunds.ts"],
    ["concept:invoicing"],
  );
  cluster(
    sqlite,
    "r_docs",
    ["site/build.ts", "site/deploy.ts", "site/theme.ts"],
    ["concept:publishing"],
  );
}

async function build(env: Env, repo: string, commit: string) {
  const db = env.DB;
  const { snapshotId, seq } = await beginRepoProjection(db, repo, [
    { repoId: repo, commit, buildId: `b-${repo}` },
  ]);
  await recordPublishedPackages(env, repo, snapshotId);
  await groupRepoCapabilities(db, repo, snapshotId, seq);
  let after: string | null = null;
  do ({ next: after } = await projectEntities(db, repo, snapshotId, seq, after));
  while (after);
  let cursor: EdgeCursor = null;
  do ({ next: cursor } = await projectEdges(db, repo, snapshotId, seq, cursor));
  while (cursor);
  await publishProjection(db, repoScope(repo), snapshotId, seq);
  return snapshotId;
}

async function world({ visibility = "private" as "public" | "private" } = {}) {
  const sqlite = database(visibility);
  const registry = registryDatabase();
  seed(sqlite);
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  for (const [repo, commit] of [
    ["r_app", "a1"],
    ["r_core", "k1"],
    ["r_docs", "d1"],
  ] as const)
    await build(env, repo, commit);
  let actor: Actor | null = ann;
  const hono = new Hono<AppEnv>();
  hono.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  hono.route("/api/accounts/:owner/atlas", workspaceAtlas);
  const call = (path: string) => hono.request(`/api/accounts/ann/atlas/${path}`, {}, env);
  const capOf = async (repo: string, anchor: string) => {
    const row = sqlite
      .prepare(
        `SELECT json_extract(data, '$.membership.capability') AS cap FROM atlas_entities
         WHERE scope = ? AND entity_id = ? AND to_seq IS NULL`,
      )
      .get(repoScope(repo), `file:${anchor}`) as { cap: string };
    return `${repo}/${row.cap}`;
  };
  return {
    sqlite,
    registry,
    env,
    as: (next: Actor | null) => {
      actor = next;
    },
    text: async (path: string) => {
      const response = await call(path);
      return `${response.status} ${await response.text()}`;
    },
    get: async <T>(path: string): Promise<T> => {
      const response = await call(path);
      if (response.status !== 200)
        throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    },
    status: async (path: string) => (await call(path)).status,
    ids: {
      ui: await capOf("r_app", "web/src/checkout.ts"),
      ops: await capOf("r_app", "ops/deploy.ts"),
      engine: await capOf("r_core", "src/invoice.ts"),
      auth: await capOf("r_core", "src/auth/login.ts"),
      guides: await capOf("r_docs", "guides/invoices.ts"),
    },
  };
}

const enc = encodeURIComponent;
type Links = AtlasWorkspacePage<AtlasCrossLink>;

describe("Atlas cross-repository composition", () => {
  test("two repositories yield a capability spanning both, and a resolved dependency with evidence", async () => {
    const w = await world();
    const { ui, engine } = w.ids;
    const composition = await w.get<AtlasWorkspaceComposition>("composition?repos=app,core,docs");
    expect(composition.inference).toBe("none");
    expect(composition.resolved).toBe(1);
    expect(composition.coverage.map((c) => [c.repoId, c.packages, c.capabilities])).toEqual([
      ["r_app", "recorded", { composed: 2, total: 2 }],
      ["r_core", "recorded", { composed: 2, total: 2 }],
      ["r_docs", "recorded", { composed: 2, total: 2 }],
    ]);
    // One composite: the billing UI and the billing engine.
    expect(composition.items).toHaveLength(1);
    const composite = composition.items[0]!;
    expect(composite.id).toMatch(/^xcap:[0-9a-f]{16}$/);
    expect(composite.kind).toBe("composite-capability");
    expect(composite.repos).toEqual(["r_app", "r_core"]);
    expect(composite.members.map((m) => [m.id, m.repoId, m.kind])).toEqual(
      expect.arrayContaining([
        [ui, "r_app", "capability"],
        [engine, "r_core", "capability"],
      ]),
    );
    expect(composite.members).toHaveLength(2);
    // Files counted once each, from each member's own primary files.
    expect(composite.counts).toEqual({ files: 6, capabilities: 2, repos: 2 });
    expect(composite.concepts).toEqual([
      { id: "concept:invoicing", name: "Invoicing", members: 2 },
    ]);
    expect(composite.name).toBe("Invoicing");
    expect(composite.nameSource).toBe("concepts");
    expect(composite.rationale).toEqual([
      {
        from: ui,
        to: engine,
        publisher: "r_core",
        packages: [{ ecosystem: "npm", name: "@ann/billing-core" }],
        concepts: [{ id: "concept:invoicing", name: "Invoicing" }],
      },
    ]);
    expect(composite.composition).toEqual({
      producer: "atlas/compose",
      version: 1,
      evidence: ["resolved-dependencies", "concepts"],
    });

    // A link to one composite reads just it, at the same composite snapshot;
    // an id the scope doesn't compose is unknown, not an empty success.
    const one = await w.get<AtlasWorkspaceComposition>(
      `composition?repos=app,core,docs&id=${encodeURIComponent(composite.id)}&snapshot=${composition.snapshot.id}`,
    );
    expect(one.items).toEqual([composite]);
    expect(one.counts.knownTotal).toBe(1);
    expect(one.snapshot.id).toBe(composition.snapshot.id);
    const unknown = await w.text(`composition?repos=app,core,docs&id=xcap%3A0000000000000000`);
    expect(unknown).toMatch(/^404 .*"code":"entity_unknown"/);

    // The dependency, with inspectable evidence: who imports, the manifest
    // governing them, the package and the repository publishing it.
    const out = await w.get<Links>(`links?repos=app,core,docs&id=${enc(ui)}&state=resolved`);
    expect(out.counts).toEqual({ loaded: 1, knownTotal: 1, unknownTotal: false });
    expect(out.items).toEqual([
      {
        state: "resolved",
        kind: "depends_on",
        src: ui,
        dst: "r_core/repo",
        package: { ecosystem: "npm", name: "@ann/billing-core" },
        neighbor: expect.objectContaining({
          id: "r_core/repo",
          kind: "repository",
          repoId: "r_core",
        }),
        evidence: {
          package: { ecosystem: "npm", name: "@ann/billing-core" },
          publisher: {
            repoId: "r_core",
            registry: { format: "npm", feed: "ann", name: "@ann/billing-core" },
            publish: {
              version: "1.2.0",
              commit: "c0ffee2",
              ref: "refs/heads/main",
              runNumber: 7,
              at: "2026-10-01T00:00:00.000Z",
            },
            rule: "npm-name",
          },
          importers: {
            total: 2,
            files: [
              {
                repoId: "r_app",
                commit: "a1",
                path: "web/src/checkout.ts",
                blob: "blob-r_app-web/src/checkout.ts",
              },
              {
                repoId: "r_app",
                commit: "a1",
                path: "web/src/invoice-view.ts",
                blob: "blob-r_app-web/src/invoice-view.ts",
              },
            ],
          },
          manifest: {
            repoId: "r_app",
            commit: "a1",
            path: "web/package.json",
            blob: "blob-r_app-web/package.json",
          },
        },
        unresolved: null,
        concepts: null,
      },
    ]);

    // The same dependency, seen from the repository that publishes the package.
    const incoming = await w.get<Links>(
      `links?repos=app,core,docs&id=${enc("r_core/repo")}&state=resolved&direction=in`,
    );
    expect(
      incoming.items.map((l) => [l.src, l.dst, l.neighbor?.id, l.evidence?.importers.total]),
    ).toEqual([[ui, "r_core/repo", ui, 2]]);
  });

  test("similarity alone is related, and unresolved imports say why", async () => {
    const w = await world();
    const { ui, guides } = w.ids;
    // Docs shares the invoicing concept with the UI but nothing resolves to it.
    const related = await w.get<Links>(`links?repos=app,core,docs&id=${enc(ui)}&state=related`);
    expect(related.items.map((l) => [l.state, l.kind, l.dst, l.concepts, l.evidence])).toEqual([
      ["related", "related", guides, [{ id: "concept:invoicing", name: "Invoicing" }], null],
    ]);
    const composition = await w.get<AtlasWorkspaceComposition>("composition?repos=app,core,docs");
    expect(composition.items.flatMap((c) => c.members.map((m) => m.id))).not.toContain(guides);

    // React: no selected repository publishes it. @ann/shared: two do.
    // billing-core resolved, so it isn't listed.
    const unresolved = await w.get<Links>(
      `links?repos=app,core,docs&id=${enc(ui)}&state=unresolved`,
    );
    expect(unresolved.items.map((l) => [l.kind, l.dst, l.unresolved])).toEqual([
      [
        "imports",
        "r_app/pkg:npm:@ann/shared",
        { reason: "ambiguous", candidates: ["r_core", "r_docs"], files: 1 },
      ],
      ["imports", "r_app/pkg:npm:react", { reason: "no-publisher", candidates: [], files: 1 }],
    ]);
    expect(unresolved.counts.knownTotal).toBe(2);
    // Paging covers the same set.
    const first = await w.get<Links>(
      `links?repos=app,core,docs&id=${enc(ui)}&state=unresolved&limit=1`,
    );
    const second = await w.get<Links>(
      `links?repos=app,core,docs&id=${enc(ui)}&state=unresolved&limit=1&cursor=${enc(first.next!)}`,
    );
    expect([...first.items, ...second.items]).toEqual(unresolved.items);
    expect(second.next).toBeNull();
  });

  test("no dependency edge exists without resolution evidence", async () => {
    const w = await world();
    const { ui, ops, engine, guides } = w.ids;
    // Every resolved link anywhere carries its package, publisher and importers.
    for (const id of [ui, ops, engine, guides, "r_app/group:unclassified"]) {
      const page = await w.get<Links>(`links?repos=app,core,docs&id=${enc(id)}&state=resolved`);
      for (const link of page.items) {
        expect(link.evidence?.publisher.repoId).toBe(link.dst.split("/")[0]);
        expect(link.evidence?.importers.total).toBeGreaterThan(0);
        expect(link.evidence?.importers.files.length).toBeGreaterThan(0);
      }
      if (id !== ui) expect(page.items).toEqual([]);
    }

    // Without core in scope, billing-core has no publisher: unresolved, and
    // the UI no longer composes with the engine. @ann/shared, which only docs
    // publishes among these, now resolves to docs, so the UI composes with
    // the guides it shares a concept with: resolution is per scope.
    const narrowed = await w.get<AtlasWorkspaceComposition>("composition?repos=app,docs");
    expect(narrowed.resolved).toBe(1);
    expect(narrowed.items.map((c) => [c.repos, c.members.map((m) => m.id).sort()])).toEqual([
      [["r_app", "r_docs"], [ui, guides].sort()],
    ]);
    const imports = await w.get<Links>(`links?repos=app,docs&id=${enc(ui)}&state=unresolved`);
    expect(imports.items.map((l) => [l.dst, l.unresolved?.reason])).toEqual([
      ["r_app/pkg:npm:@ann/billing-core", "no-publisher"],
      ["r_app/pkg:npm:react", "no-publisher"],
    ]);
    const viaDocs = await w.get<Links>(`links?repos=app,docs&id=${enc(ui)}&state=resolved`);
    expect(viaDocs.items.map((l) => [l.dst, l.package?.name])).toEqual([
      ["r_docs/repo", "@ann/shared"],
    ]);

    // A registry that no longer names core a source resolves nothing to it.
    w.registry.exec(`DELETE FROM package_sources`);
    const rebuilt = await build(w.env, "r_core", "k2");
    expect(rebuilt).toBeTruthy();
    clearCompositionCache();
    const after = await w.get<AtlasWorkspaceComposition>("composition?repos=app,core");
    expect(after.items).toEqual([]);
    expect(after.resolved).toBe(0);

    // A snapshot built before packages were recorded resolves nothing either.
    w.sqlite.exec(`UPDATE atlas_snapshots SET packages = NULL`);
    clearCompositionCache();
    const old = await w.get<AtlasWorkspaceComposition>("composition?repos=app,core,docs");
    expect(old.coverage.map((c) => c.packages)).toEqual(["unrecorded", "unrecorded", "unrecorded"]);
    expect(old.resolved).toBe(0);
  });

  test("a package in a feed the caller can't read never resolves", async () => {
    // Public repositories, private feed: anonymous readers see the code, not
    // where its packages are published.
    const w = await world({ visibility: "public" });
    const { ui } = w.ids;
    w.as(null);
    const composition = await w.get<AtlasWorkspaceComposition>("composition?repos=app,core");
    expect(composition.items).toEqual([]);
    expect(composition.resolved).toBe(0);
    const unresolved = await w.get<Links>(`links?repos=app,core&id=${enc(ui)}&state=unresolved`);
    expect(unresolved.items.map((l) => [l.dst, l.unresolved?.reason])).toEqual([
      ["r_app/pkg:npm:@ann/billing-core", "no-publisher"],
      ["r_app/pkg:npm:@ann/shared", "no-publisher"],
      ["r_app/pkg:npm:react", "no-publisher"],
    ]);
    expect(JSON.stringify(unresolved)).not.toContain("c0ffee");
    // Ann, who reads the feed, gets the resolutions (both packages: docs, the
    // other publisher of @ann/shared, isn't selected).
    w.as(ann);
    expect((await w.get<AtlasWorkspaceComposition>("composition?repos=app,core")).resolved).toBe(2);
  });

  test("a denied repository leaves every result byte-identical to a selection without it", async () => {
    const w = await world();
    const { ui, ops, guides } = w.ids;
    w.as(ben);
    const routes = (repos: string) => [
      `composition?repos=${repos}`,
      `links?repos=${repos}&id=${enc(ui)}&state=resolved`,
      `links?repos=${repos}&id=${enc(ui)}&state=unresolved`,
      `links?repos=${repos}&id=${enc(ui)}&state=related`,
      `links?repos=${repos}&id=${enc(ops)}&state=unresolved`,
      `links?repos=${repos}&id=${enc(guides)}&state=related`,
      `links?repos=${repos}&id=${enc("r_docs/repo")}&state=resolved&direction=in`,
    ];
    // Cold, then warm: neither the content nor the cache reveals core.
    for (const warm of [false, true]) {
      if (!warm) clearCompositionCache();
      const withCore = [];
      for (const path of routes("app,core,docs")) withCore.push(await w.text(path));
      if (!warm) clearCompositionCache();
      const without = [];
      for (const path of routes("app,docs")) without.push(await w.text(path));
      expect(withCore).toEqual(without);
      for (const body of withCore) {
        expect(body.startsWith("200 ")).toBe(true);
        expect(body).not.toContain("r_core");
        expect(body).not.toContain("c0ffee");
      }
    }
    // Ann sees what core contributes.
    w.as(ann);
    expect(await w.text(routes("app,core,docs")[0]!)).not.toEqual(
      await w.text(routes("app,docs")[0]!),
    );
    // A link into a denied repository is unknown, like one that never existed.
    w.as(ben);
    expect(
      await w.status(
        `links?repos=app,core,docs&id=${enc("r_core/repo")}&state=resolved&direction=in`,
      ),
    ).toBe(404);
  });

  test("bad link requests are refused", async () => {
    const w = await world();
    const { ui } = w.ids;
    expect(await w.status(`links?repos=app,core&id=${enc(ui)}&state=maybe`)).toBe(400);
    expect(await w.status(`links?repos=app,core&id=${enc(ui)}&state=resolved&direction=in`)).toBe(
      400,
    );
    expect(
      await w.status(`links?repos=app,core&id=${enc("r_app/file:ops/deploy.ts")}&state=resolved`),
    ).toBe(400);
    expect(await w.status(`links?repos=app,core&state=resolved`)).toBe(400);
    expect(await w.status(`links?repos=app,core&id=${enc("r_app/cap:nope")}&state=resolved`)).toBe(
      404,
    );
  });
});

describe("composition rules", () => {
  const pkg = (
    format: RecordedPackage["format"],
    name: string,
    normalized = name,
  ): RecordedPackage => ({
    format,
    name,
    normalized,
    feedId: `feed_${format}`,
    feed: "ann",
    publish: null,
  });

  test("imports resolve by each format's rule, never to the importer itself or to several repositories", () => {
    const index = new PublisherIndex([
      {
        repoId: "r_b",
        packages: [
          pkg("npm", "@ann/ui"),
          pkg("cargo", "fast-json"),
          pkg("pypi", "Data.Tools", "data-tools"),
          pkg("go", "git.example/ann/kit"),
        ],
      },
      { repoId: "r_c", packages: [pkg("npm", "left-pad")] },
      { repoId: "r_d", packages: [pkg("npm", "left-pad")] },
    ]);
    const state = (id: string, from = "r_a") => {
      const r = index.resolve(id, from);
      return r.state === "resolved" ? `${r.publisher.repoId}:${r.publisher.rule}` : r.state;
    };
    expect(state("pkg:npm:@ann/ui")).toBe("r_b:npm-name");
    expect(state("pkg:crates:fast_json")).toBe("r_b:cargo-crate");
    expect(state("pkg:pypi:data_tools")).toBe("r_b:pypi-module");
    expect(state("pkg:go:git.example/ann/kit/http")).toBe("r_b:go-module");
    expect(state("pkg:go:git.example/ann/kitchen")).toBe("none");
    expect(state("pkg:npm:@ann/ui", "r_b")).toBe("self");
    expect(state("pkg:npm:left-pad")).toBe("ambiguous");
    expect(state("pkg:npm:react")).toBe("none");
    expect(state("pkg:platform:node:fs")).toBe("none");
  });

  test("identical inputs compose identically, whatever their order", async () => {
    const cap = (id: string, files: number, concepts: string[]) => ({
      entity: {
        id,
        kind: "capability",
        parentId: "repo",
        name: id,
        path: null,
        summary: "",
        data: {},
      },
      files,
      concepts: concepts.map((c) => ({ id: c, name: c, weight: 2 })),
    });
    const repos = [
      { repoId: "r_a", capabilities: [cap("cap:a1", 5, ["x", "y"]), cap("cap:a2", 3, ["z"])] },
      { repoId: "r_b", capabilities: [cap("cap:b1", 4, ["x"]), cap("cap:b2", 4, ["y", "x"])] },
      { repoId: "r_c", capabilities: [cap("cap:c1", 9, ["z"])] },
    ];
    const imports = [
      { repoId: "r_a", capability: "cap:a1", pkg: "pkg:npm:b", files: 2 },
      { repoId: "r_c", capability: "cap:c1", pkg: "pkg:npm:a", files: 1 },
    ];
    const index = new PublisherIndex([
      { repoId: "r_b", packages: [pkg("npm", "b")] },
      { repoId: "r_a", packages: [pkg("npm", "a")] },
    ]);
    const one = await compose(repos, imports, index);
    const two = await compose([...repos].reverse(), [...imports].reverse(), index);
    const plain = (c: Awaited<ReturnType<typeof compose>>) =>
      JSON.stringify([
        c.composites,
        [...c.related].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        c.resolved,
      ]);
    expect(plain(one)).toBe(plain(two));
    // a1 links to b2 (two shared concepts beat one); c1 to a2 (z), so two composites.
    expect(one.composites.map((c) => c.memberIds)).toEqual([
      ["r_c/cap:c1", "r_a/cap:a2"],
      ["r_a/cap:a1", "r_b/cap:b2"],
    ]);
  });
});
