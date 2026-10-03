// The workspace Atlas's navigation (CORE-184) against the real workspace API:
// two repositories built from the Atlas fixture, one publishing the package
// the other's billing imports, browsed through the page's own client and
// session the way WorkspaceAtlas.tsx does. Finds the capability spanning both,
// drills to files, cites sources at each repository's immutable commit, and
// proves every read is a bounded /api/accounts/:owner/atlas page, with every
// model, index and search binding wired to fail if touched.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { ATLAS_FIXTURE_PACKAGE } from "../../shared/atlasFixture.ts";
import type { AtlasEvidence } from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { atlasWorkspaceApi, workspaceReader } from "../../src/lib/atlas.ts";
import { FocusResolver, type Focus } from "../../src/routes/repo/atlasNavigation.ts";
import {
  compositeSummary,
  WorkspaceSession,
  type WorkspaceState,
} from "../../src/routes/atlas/workspace.ts";
import { clearCompositionCache } from "./compose.ts";
import { publishAtlasFixture, registerFixturePackage, writeAtlasFixtureGraph } from "./fixture.ts";
import { workspaceAtlas } from "./workspace.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCompositionCache();
});

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const LEDGER = "a".repeat(40);
const SHOP = "b".repeat(40);

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

function registryDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../registry/migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  return sqlite;
}

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_ledger', 'ann', 'ledger', 'private', 'art-1', ''),
      ('r_shop', 'ann', 'shop', 'private', 'art-2', '');
  `);
  const touched: string[] = [];
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registryDatabase()),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    AI: forbidden("AI", touched),
    VECTORS: forbidden("VECTORS", touched),
    SEARCH: forbidden("SEARCH", touched),
    KNOWLEDGE: forbidden("KNOWLEDGE", touched),
    KNOWLEDGE_QUEUE: forbidden("KNOWLEDGE_QUEUE", touched),
    KNOWLEDGE_BUILD: forbidden("KNOWLEDGE_BUILD", touched),
  } as unknown as Env;
  // As the dev endpoint does for the live E2E: ledger publishes the package,
  // shop's billing imports it.
  await registerFixturePackage(
    env.REGISTRY_DB,
    { id: "ann", slug: "ann" },
    "r_ledger",
    ATLAS_FIXTURE_PACKAGE,
  );
  await writeAtlasFixtureGraph(env.DB, "r_ledger", "ledger", LEDGER);
  await publishAtlasFixture(env, "r_ledger", LEDGER, { packages: true });
  await writeAtlasFixtureGraph(env.DB, "r_shop", "shop", SHOP, "consumer");
  await publishAtlasFixture(env, "r_shop", SHOP, { packages: true });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/accounts/:owner/atlas", workspaceAtlas);
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    requests.push(new URL(String(input), "http://atlas.test"));
    return app.request(String(input), init ?? {}, env);
  });
  return { env, touched, requests };
}

describe("the workspace Atlas's navigation", () => {
  test("a capability spanning two repositories, drilled to files and cited at immutable commits", async () => {
    const s = await setup();
    const workspace = { owner: "ann", repos: ["shop", "ledger"] };
    const states: WorkspaceState[] = [];
    const session = new WorkspaceSession(workspace, atlasWorkspaceApi, (state) =>
      states.push(state),
    );
    await session.open();
    await vi.waitFor(() => expect(states.at(-1)?.composition?.status).toBe("ready"));
    const state = states.at(-1)!;
    const overview = state.overview!;
    const repos = new Map(overview.snapshot.repos.map((r) => [r.name, r]));
    expect([...repos.keys()].sort()).toEqual(["ledger", "shop"]);
    // Each repository is read at its own commit: there's no common head.
    expect(repos.get("ledger")!.snapshot!.vector[0]!.commit).toBe(LEDGER);
    expect(repos.get("shop")!.snapshot!.vector[0]!.commit).toBe(SHOP);

    // The capability spanning both: the two billing capabilities, files counted once.
    const composition = state.composition;
    if (composition?.status !== "ready") throw new Error("no composition");
    // Billing is two capabilities in each repository (ledger, invoicing), and
    // each imports the package in shop: two composites, both spanning both.
    expect(composition.resolved).toBe(2);
    expect(composition.items).toHaveLength(2);
    for (const x of composition.items) {
      expect([...x.repos].sort()).toEqual(["r_ledger", "r_shop"]);
      expect(x.rationale).toEqual([
        expect.objectContaining({
          publisher: "r_ledger",
          packages: [{ ecosystem: "npm", name: ATLAS_FIXTURE_PACKAGE }],
        }),
      ]);
    }
    const composite = composition.items[0]!;
    expect(
      composite.members
        .map((m) => [m.repoId, m.kind])
        .sort((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([
      ["r_ledger", "capability"],
      ["r_shop", "capability"],
    ]);
    // Files are counted once each, in the member that holds them.
    const memberFiles = composite.members.map((m) => m.counts.files ?? 0);
    expect(composite.counts.files).toBe(memberFiles[0]! + memberFiles[1]!);
    expect(compositeSummary(composite).counts.files).toBe(composite.counts.files);
    const all = composition.items.flatMap((x) => x.members.map((m) => m.id));
    expect(new Set(all).size).toBe(all.length);
    // A link to it reads only it.
    expect(await session.composite(composite.id)).toEqual(composite);

    // Its purpose: each member's own detail, and its cross-repository evidence.
    const reader = workspaceReader(workspace);
    const snapshot = overview.snapshot.id;
    const shopBilling = composite.members.find((m) => m.repoId === "r_shop")!;
    const links = await atlasWorkspaceApi.links(workspace, shopBilling.id, "resolved", {
      snapshot,
    });
    expect(links.items).toHaveLength(1);
    const evidence = links.items[0]!.evidence!;
    expect(evidence.publisher.repoId).toBe("r_ledger");
    expect(evidence.importers.total).toBe(1);
    expect(evidence.importers.files).toHaveLength(1);
    expect(evidence.importers.files[0]!.commit).toBe(SHOP);
    expect(["billing/invoices/invoice.ts", "billing/ledger/ledger.ts"]).toContain(
      evidence.importers.files[0]!.path,
    );

    // Drill: member capability -> its children -> a file, in each repository,
    // as the page does (focus resolution and a children page per level).
    const cite: AtlasEvidence[] = [];
    for (const member of composite.members) {
      const children = await reader.children(member.id, { snapshot, limit: 100 });
      const area = children.items.find((c) => c.kind === "area") ?? children.items[0]!;
      const inside =
        area.kind === "file" ? children : await reader.children(area.id, { snapshot, limit: 100 });
      const file = inside.items.find((c) => c.kind === "file")!;
      expect(file.repoId).toBe(member.repoId);
      // A cold link to that file resolves through its ancestors.
      const focuses: Focus[] = [];
      const opened: string[] = [];
      const resolver = new FocusResolver(
        (id, signal) => reader.ancestors(id, { snapshot, signal }),
        (id) => opened.push(id),
        (focus) => focuses.push(focus),
      );
      await resolver.focus(file.id);
      expect(focuses.at(-1)).toMatchObject({ state: "ready", entity: { id: file.id } });
      expect(opened).toContain(member.id);
      const sources = await reader.evidence(file.id, { snapshot });
      cite.push(sources.items[0]!);
    }
    // Two source locations, one in each repository, each at its own indexed commit.
    expect(
      cite
        .map((e) => [e.repoId, e.commit, e.kind])
        .sort((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([
      ["r_ledger", LEDGER, "file"],
      ["r_shop", SHOP, "file"],
    ]);

    // Every read was a bounded page of the workspace API; nothing else ran.
    for (const url of s.requests) {
      expect(url.pathname).toMatch(
        /^\/api\/accounts\/ann\/atlas\/(overview|composition|links|children|ancestors|evidence)$/,
      );
      expect(Number(url.searchParams.get("limit") ?? 0)).toBeLessThanOrEqual(100);
    }
    expect(s.touched).toEqual([]);
    session.dispose();
  });
});
