// The Atlas authorization, revocation and privacy suite (CORE-178; PRD
// CORE-155 gates 5, 6 and 10), against the real HTTP application
// (worker/app.ts): its token authentication, its route mounting, separate
// people, an agent, an organization, public and private repositories, and the
// real migrations under D1. Every Atlas surface is exercised: the repository
// routes (/api/repos/:o/:n/atlas/*), the workspace routes
// (/api/spaces/:space/atlas/*), their cursors and pinned snapshots, and the
// other reads the Knowledge page's loader makes (status, the wiki catalog,
// timeline overlays) plus the explicit graph export.
//
// What it holds the product to:
// - A private repository the caller can't read is a 404 byte-identical to one
//   that doesn't exist, on every surface, cursor or snapshot attached; never a 403.
// - Revocation (a collaborator removed, a repository made private, an
//   organization membership or its default access ended, an agent revoked)
//   takes effect on the very next request, including mid-pagination with a
//   still-valid cursor and on a pinned snapshot, warm or cold.
// - A cursor is bound to its principal, scope, route and filters: nobody else
//   can replay it, and it can't be replayed against another repository.
// - A workspace never shows a repository the viewer lost access to, through
//   composition, cross-repository links, lineage, catalogue lookup or totals.
// - A deleted repository leaves no Atlas rows and nothing readable, even for a
//   new repository of the same name.
// - Unpublished (building, failed) projections are never readable, and pinned
//   pages keep their snapshot's content while a newer one publishes.
// - No browse path touches a model, Vectorize or AI Search: those bindings
//   throw, and every test checks none was touched.

import type { DatabaseSync } from "node:sqlite";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type {
  AtlasCrossLink,
  AtlasDetail,
  AtlasEntitySummary,
  AtlasError,
  AtlasOverview,
  AtlasPage,
  AtlasRegion,
  AtlasRelation,
  AtlasWorkspaceComposition,
  AtlasWorkspaceOverview,
  AtlasWorkspacePage,
} from "../../shared/atlas.ts";
import {
  atlasAccessLost,
  atlasApi,
  atlasNeedsRestart,
  onAtlasAccessLost,
} from "../../src/lib/atlas.ts";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import { app as server } from "../app.ts";
import { issueToken } from "../api/tokens.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import { d1, migratedRegistryDatabase } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { fakeDurableObjectId, fakeDurableState } from "../testing/durable-state.ts";
import { runPurge } from "../retention/repo-deletion.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Tracker } from "../tracker/object.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";
import { TrackerStore } from "../tracker/store.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { sha256 } from "../knowledge/util.ts";
import { cursorSecret, signCursor, verifyCursor, type CursorBinding } from "./cursor.ts";
import { clearCompositionCache } from "./compose.ts";
import { publishAtlasFixture, writeAtlasFixtureGraph } from "./fixture.ts";
import {
  beginRepoProjection,
  failProjection,
  projectEdges,
  projectEntities,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));
// The assistant's chat (mounted by the app, never reached here) runs on the Agents SDK.
vi.mock("agents", () => ({
  getAgentByName: () => {
    throw new Error("The Atlas never reaches the assistant");
  },
}));

/** Distinctive private names: none may ever reach someone who can't read their repository. */
const VAULT = "Zephyrvault"; // ann/vault, private, shared with ben
const CORE = "Quillmoor"; // acme/core, private to the acme organization
const OPEN = "Harborlight"; // ann/open, public until a test makes it private
const OTHER = "Marrowind"; // ann/other, private to ann

const oid = (n: number) => n.toString(16).padStart(40, "0");
const enc = encodeURIComponent;

/** A binding any touch of which fails the request, and is recorded. */
function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`An Atlas browse path touched ${name}.${String(key)}`);
      },
    },
  );
}

const REPOS = [
  { id: "r_vault", space: "ann", name: "vault", visibility: "private", marker: VAULT },
  { id: "r_other", space: "ann", name: "other", visibility: "private", marker: OTHER },
  { id: "r_open", space: "ann", name: "open", visibility: "public", marker: OPEN },
  { id: "r_core", space: "acme", name: "core", visibility: "private", marker: CORE },
  {
    id: "r_private",
    space: "acme-private",
    name: "private",
    visibility: "private",
    marker: "Ivoryhaven",
  },
] as const;

type Who = "ann" | "ben" | "carl" | "dora" | "annBot" | "benBot" | "anonymous";

let artifactsNames = 0;

/**
 * The world: ann has an explicit grant to vault (ben reads it as a collaborator),
 * other and public open. Dora reads acme/core through an explicit Space grant,
 * but cannot read acme-private in the same Organization. Carl owns that
 * Organization without any content grant. annBot and benBot act for people. Every
 * repository has a published fixture Atlas (projected the way a Knowledge
 * build does, without a model), a wiki page and a timeline overlay.
 */
async function world() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  const run = ++artifactsNames;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'),
      ('carl', 'user', 'carl', 'Carl'), ('dora', 'user', 'dora', 'Dora');
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
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, default_space_id)
      VALUES ('org-acme', 'acme', 'Acme', 'company', 'acme');
    INSERT INTO spaces (id, organization_id, slug, display_name) VALUES
      ('acme', 'org-acme', 'acme', 'Core'), ('acme-private', 'org-acme', 'acme-private', 'Private');
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by) VALUES
      ('org-acme', 'carl', 'owner', 'test-fixture', 'carl'),
      ('org-acme', 'dora', 'member', 'test-fixture', 'carl'),
      ('org-acme', 'ann', 'member', 'test-fixture', 'carl');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by) VALUES
      ('acme', 'org-acme', 'dora', 'member', 'read', 'read', 'test-fixture', 'carl'),
      ('acme-private', 'org-acme', 'ann', 'admin', 'write', 'write', 'test-fixture', 'carl');
    INSERT INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail) VALUES
      ('audit-dora', 'org-acme', 'acme', 'carl', 'space.grant', 'dora', '{"origin":"test-fixture"}'),
      ('audit-private', 'org-acme', 'acme-private', 'carl', 'space.grant', 'ann', '{"origin":"test-fixture"}');
    COMMIT;
    INSERT INTO agents (id, name, accountable_id) VALUES
      ('agt_ann', 'ann-bot', 'ann'), ('agt_ben', 'ben-bot', 'ben');
  `);
  const git = fakeRemotes();
  const head = oid(1);
  for (const r of REPOS) {
    const spaceId = r.space;
    sqlite
      .prepare(
        `INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, spaceId, r.name, r.visibility, `authz-${run}-${r.id}`, `https://${r.id}`);
    git.add(`https://${r.id}`, { "refs/heads/main": head }, undefined, `authz-${run}-${r.id}`);
    git.add(
      `https://${r.id}-work`,
      { "refs/heads/work": oid(2) },
      "refs/heads/work",
      `authz-${run}-${r.id}-work`,
    );
    sqlite.exec(`
      INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, space_id,
        artifacts_name, artifacts_remote, state, allocation_operation_id, fork_source_id,
        fork_commit, fork_tree, fork_ref, initial_source_id, initial_commit, initial_tree, initial_ref,
        initial_token_revoked, created_at, updated_at)
      VALUES ('work_${r.id}', '${r.id}', 'plan-${spaceId}', 'plan', '${spaceId}',
        'authz-${run}-${r.id}-work', 'https://${r.id}-work', 'ready', 'allocate-${r.id}',
        'canonical', '${head}', '${head}', 'refs/heads/main',
        'canonical', '${head}', '${head}', 'refs/heads/main', 1, '', '');
      INSERT INTO kg_state (repo_id, indexed_commit, indexed_at) VALUES ('${r.id}', '${head}', '2026-10-01T00:00:00Z');
      INSERT INTO wiki_pages (repo_id, slug, title, section, position, body, inputs_hash, generated_in)
        VALUES ('${r.id}', 'overview', '${r.marker} overview', 'Overview', 0, '${r.marker} body', 'h', '${head}');
      INSERT INTO kg_overlays (repo_id, source_id, ref, overlay_id, head_commit, base_commit, stats, updated_at, status, attempted_commit)
        VALUES ('${r.id}', 'work_${r.id}', 'refs/heads/timeline/plan', 'ov-${r.id}', '${oid(2)}', '${head}',
          '{"counts":{"file":{"added":1,"changed":0,"removed":0}},"stored":1}', '2026-10-01T00:00:00Z', 'succeeded', '${oid(2)}');
      INSERT INTO kg_overlay_changes (repo_id, overlay_id, node_id, kind, change, name, path)
        VALUES ('${r.id}', 'ov-${r.id}', 'file:plan.ts', 'file', 'added', '${r.marker} plan', 'plan.ts');
    `);
  }
  sqlite.exec(
    `INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('r_vault', 'ben', 'read')`,
  );

  const DB = d1(sqlite);
  for (const r of REPOS) await writeFixture(sqlite, DB, r.id, r.name, r.marker, head);
  for (const r of REPOS) await publishAtlasFixture({ DB }, r.id, head);

  const tokens: Record<Exclude<Who, "anonymous">, string> = {
    ann: (await issueToken(DB, "ann", "t", "write")).secret,
    // Write scope: ben revokes his own agent in one test.
    ben: (await issueToken(DB, "ben", "t", "write")).secret,
    carl: (await issueToken(DB, "carl", "t", "read")).secret,
    dora: (await issueToken(DB, "dora", "t", "read")).secret,
    annBot: (await issueToken(DB, "ann", "bot", "read", undefined, "agt_ann")).secret,
    benBot: (await issueToken(DB, "ben", "bot", "read", undefined, "agt_ben")).secret,
  };

  const touched: string[] = [];
  /** Statements prepared against D1, across every environment. */
  const queries = { count: 0 };
  const counted = (inner: D1Database): D1Database =>
    ({
      prepare: (sql: string) => {
        queries.count++;
        return inner.prepare(sql);
      },
      batch: inner.batch.bind(inner),
      exec: inner.exec.bind(inner),
    }) as unknown as D1Database;
  const trackerStates = new Map<string, { ctx: DurableObjectState; db: DatabaseSync }>();
  fresh.env.TRACKER = { idFromName: fakeDurableObjectId } as Env["TRACKER"];
  for (const { id } of sqlite.prepare("SELECT id FROM spaces").all()) {
    const spaceId = String(id);
    const state = fakeDurableState({ name: spaceId });
    onTestFinished(() => state.db.close());
    await initializeFreshTrackerSpace(fresh.env, state.ctx, spaceId);
    new TrackerStore(state.ctx.storage.sql, (work) => state.ctx.storage.transactionSync(work));
    for (const source of sqlite
      .prepare("SELECT * FROM timeline_work_sources WHERE space_id = ?")
      .all(spaceId)) {
      state.db
        .prepare(
          "INSERT INTO timeline_source_allocations (source_id, timeline_id, repo_id, data) VALUES (?, ?, ?, ?)",
        )
        .run(
          String(source.source_id),
          String(source.timeline_id),
          String(source.repo_id),
          JSON.stringify(source),
        );
    }
    trackerStates.set(spaceId, state);
  }
  /** Fresh bindings over the same database: a cold isolate. */
  const environment = () => {
    const coordinators = new Map<string, KnowledgeCoordinator>();
    const trackers = new Map<string, Tracker>();
    const env = {
      ...fresh.env,
      DB: counted(d1(sqlite)),
      REGISTRY_DB: forbidden("REGISTRY_DB", touched),
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      ARTIFACTS: { ...git.artifacts, delete: async () => {} },
      // A deleted repository's step screenshots go with it (CORE-383).
      STEP_ARTIFACTS: new FakeR2Bucket(),
      AI: forbidden("AI", touched),
      VECTORS: forbidden("VECTORS", touched),
      SEARCH: forbidden("SEARCH", touched),
      KNOWLEDGE_BUILD: forbidden("KNOWLEDGE_BUILD", touched),
      KNOWLEDGE_QUEUE: forbidden("KNOWLEDGE_QUEUE", touched),
      // Deleting a repository starts its purge (CORE-199); the test runs it.
      REPO_PURGE: { create: async () => ({}) },
      TRACKER: {
        idFromName: fakeDurableObjectId,
        getByName: (id: string) => {
          let found = trackers.get(id);
          if (!found) {
            const state = trackerStates.get(id);
            if (!state) throw new Error(`Unknown Tracker Space ${id}`);
            found = new Tracker(state.ctx, env);
            trackers.set(id, found);
          }
          return found;
        },
      },
      KNOWLEDGE_COORDINATOR: {
        getByName: (id: string) => {
          let found = coordinators.get(id);
          if (!found) {
            found = new KnowledgeCoordinator(fakeDurableState({ name: id }).ctx, env);
            coordinators.set(id, found);
          }
          return found;
        },
      },
    } as unknown as Env;
    return env;
  };
  /** Whose session the browser client's requests carry (see `serveClient`). */
  let browser: Who = "anonymous";
  let clientEnv: Env | null = null;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    if (!href.startsWith("/api/") || !clientEnv) return git.fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set(CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION));
    if (browser !== "anonymous") headers.set("authorization", `Bearer ${tokens[browser]}`);
    return server.request(href, { ...init, headers }, clientEnv, executionCtx);
  });
  const executionCtx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;

  const view = (env: Env) => {
    const call = (who: Who, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set(CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION));
      if (who !== "anonymous") headers.set("authorization", `Bearer ${tokens[who]}`);
      return server.request(path, { ...init, headers }, env, executionCtx);
    };
    return {
      call,
      /** Status and body, for byte-for-byte comparison. */
      text: async (who: Who, path: string) => {
        const response = await call(who, path);
        return `${response.status} ${await response.text()}`;
      },
      get: async <T>(who: Who, path: string): Promise<T> => {
        const response = await call(who, path);
        if (response.status !== 200)
          throw new Error(`${who} ${path}: ${response.status} ${await response.text()}`);
        return (await response.json()) as T;
      },
    };
  };
  const warmEnv = environment();
  const warm = view(warmEnv);
  return {
    sqlite,
    git,
    db: DB,
    env: warmEnv,
    touched,
    queries,
    /** Route the browser client's fetches (src/lib/atlas.ts) into the app, as `who`. */
    serveClient: (who: Who) => {
      browser = who;
      clientEnv = warmEnv;
    },
    ...warm,
    /** The same requests through new bindings, as a cold isolate would serve them. */
    cold: () => {
      clearCompositionCache();
      return view(environment());
    },
  };
}

/** The fixture's graph, with the repository's distinctive marker in its concept names. */
async function writeFixture(
  sqlite: DatabaseSync,
  db: D1Database,
  repoId: string,
  name: string,
  marker: string,
  commit: string,
  variant: "base" | "merged" = "base",
) {
  await writeAtlasFixtureGraph(db, repoId, name, commit, variant);
  sqlite
    .prepare(`UPDATE kg_nodes SET name = ? || ' ' || name WHERE repo_id = ? AND kind = 'concept'`)
    .run(marker, repoId);
  // Operations reaches into search: a capability relation with a contributing import.
  sqlite
    .prepare(
      `INSERT INTO kg_edges (repo_id, src, dst, kind, weight)
       VALUES (?, 'file:ops/deploy.ts', 'file:search/query.ts', 'imports', 1) ON CONFLICT DO NOTHING`,
    )
    .run(repoId);
  // Twelve more small capabilities, so the overview has a catalogue to page.
  const node = sqlite.prepare(
    `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
     VALUES (?, ?, ?, ?, ?, '', ?, 'h', ?)`,
  );
  const edge = sqlite.prepare(
    `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1)`,
  );
  for (let k = 0; k < 12; k++) {
    const concept = `concept:extra${k}`;
    node.run(repoId, concept, "concept", `${marker} Extra ${k}`, null, "{}", commit);
    const files = ["a", "b", "c"].map((f) => `extra/k${k}/${f}.ts`);
    for (const path of files)
      node.run(repoId, `file:${path}`, "file", path.split("/").pop()!, path, '{"lines":3}', commit);
    for (const path of files) {
      edge.run(repoId, `file:${path}`, concept, "mentions");
      for (const other of files)
        if (other !== path) edge.run(repoId, `file:${path}`, `file:${other}`, "imports");
    }
  }
}

type World = Awaited<ReturnType<typeof world>>;
type View = Pick<World, "call" | "text" | "get">;

const repoBase = (space: string, name: string) => `/api/repos/${space}/${name}`;

/** What a viewer has open in a repository's Atlas: ids, a pinned snapshot and a cursor per paged route. */
interface Open {
  snapshot: string;
  capability: string;
  file: string;
  symbol: string;
  /** A capability `capability` depends on, for /contributing. */
  dependency: string;
  cursors: Record<string, string>;
}

/** Open a repository's Atlas as `who`, the way the Knowledge tab does, and page one step everywhere. */
async function openAtlas(v: View, who: Who, space: string, name: string): Promise<Open> {
  const atlas = `${repoBase(space, name)}/atlas`;
  const overview = await v.get<AtlasOverview>(who, `${atlas}/overview`);
  const capabilities = [...overview.regions, ...overview.catalogue.items].filter(
    (r) => r.kind === "capability",
  );
  // The capability with an outgoing capability relation (operations, into search).
  let capability = "";
  let dependency = "";
  for (const c of capabilities) {
    const out = await v.get<AtlasPage<AtlasRelation>>(
      who,
      `${atlas}/relations?id=${enc(c.id)}&direction=out&kind=depends_on`,
    );
    if (out.items.length) {
      capability = c.id;
      dependency = out.items[0]!.dst;
      break;
    }
  }
  expect(capability, "the fixture has a capability relation").not.toBe("");
  const file = "file:billing/ledger/ledger.ts";
  const symbol = "sym:billing/ledger/ledger.ts#post";
  const first = async (path: string) => {
    const page = await v.get<AtlasPage<unknown>>(who, `${atlas}/${path}`);
    expect(page.next, path).not.toBeNull();
    return page.next!;
  };
  const search = capabilities.find((c) => c.id === dependency)!;
  const cursors = {
    regions: await first("regions?limit=1"),
    children: await first(`children?id=${enc(search.id)}&limit=1`),
    relations: await first(`relations?id=${enc(file)}&direction=out&limit=1`),
    evidence: await first(`evidence?id=${enc(search.id)}&limit=1`),
    catalogue: await first("catalogue?q=s&limit=1"),
  };
  return { snapshot: overview.snapshot.id, capability, dependency, file, symbol, cursors };
}

/**
 * Every Atlas surface of a repository, relative to its /api/repos/:o/:n:
 * fresh reads, reads pinned to `o.snapshot`, and each paged route continued
 * with `o`'s cursor. Plus the Knowledge page loader's other reads and the
 * explicit graph export.
 */
function surfaces(o: Open): string[] {
  const s = `snapshot=${enc(o.snapshot)}`;
  const id = (x: string) => `id=${enc(x)}`;
  return [
    "/atlas/overview",
    `/atlas/overview?${s}`,
    "/atlas/regions?limit=1",
    `/atlas/regions?limit=1&cursor=${enc(o.cursors.regions!)}`,
    `/atlas/children?${id(o.dependency)}&limit=1`,
    `/atlas/children?${id(o.dependency)}&limit=1&cursor=${enc(o.cursors.children!)}`,
    `/atlas/children?${id(o.dependency)}&${s}`,
    `/atlas/detail?${id(o.capability)}`,
    `/atlas/detail?${id(o.symbol)}&${s}`,
    `/atlas/ancestors?${id(o.symbol)}`,
    `/atlas/ancestors?${id(o.symbol)}&${s}`,
    `/atlas/relations?${id(o.file)}&direction=out&limit=1`,
    `/atlas/relations?${id(o.file)}&direction=out&limit=1&cursor=${enc(o.cursors.relations!)}`,
    `/atlas/relations?${id(o.dependency)}&direction=in&kind=depends_on&${s}`,
    `/atlas/contributing?${id(o.capability)}&other=${enc(o.dependency)}&direction=out`,
    `/atlas/contributing?${id(o.capability)}&other=${enc(o.dependency)}&direction=out&${s}`,
    `/atlas/evidence?${id(o.dependency)}&limit=1`,
    `/atlas/evidence?${id(o.dependency)}&limit=1&cursor=${enc(o.cursors.evidence!)}`,
    `/atlas/evidence?${id(o.symbol)}&${s}`,
    "/atlas/catalogue?q=s&limit=1",
    `/atlas/catalogue?q=s&limit=1&cursor=${enc(o.cursors.catalogue!)}`,
    `/atlas/catalogue?q=${enc(VAULT)}&${s}`,
    `/atlas/detail?${id("cap:does-not-exist")}`,
    `/atlas/overview?snapshot=made-up`,
    `/atlas/timeline?ref=${enc("timeline/plan")}`,
    `/atlas/timeline?ref=${enc("timeline/plan")}&${s}`,
    "/knowledge/status",
    "/knowledge/wiki",
    "/knowledge/overlays",
    `/knowledge/overlay?ref=${enc("timeline/plan")}`,
    "/knowledge/graph/export",
  ];
}

const hides = (body: string, ...secrets: string[]) => {
  for (const secret of secrets) expect(body).not.toContain(secret);
};

let w: World;

beforeEach(async () => {
  clearCompositionCache();
  w = await world();
});

afterEach(() => {
  // Browsing never reached a model, Vectorize, AI Search or a build.
  expect(w.touched).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Atlas authorization, revocation and privacy", () => {
  test("every surface serves its reader, with no model, index or AI Search", async () => {
    const vault = await openAtlas(w, "ben", "ann", "vault");
    for (const path of surfaces(vault)) {
      const response = await w.call("ben", `${repoBase("ann", "vault")}${path}`);
      const expected = path.includes("does-not-exist") || path.includes("made-up") ? 404 : 200;
      expect(response.status, path).toBe(expected);
    }
    const overview = await w.text("ben", `${repoBase("ann", "vault")}/atlas/overview`);
    expect(overview).toContain(VAULT);
    const contributing = await w.get<AtlasPage<unknown>>(
      "ben",
      `${repoBase("ann", "vault")}/atlas/contributing?id=${enc(vault.capability)}&other=${enc(vault.dependency)}&direction=out`,
    );
    expect(contributing.items.length).toBeGreaterThan(0);
  });

  test("an unreadable private repository is a 404 identical to a missing one, on every surface", async () => {
    const vault = await openAtlas(w, "ann", "ann", "vault");
    const core = await openAtlas(w, "dora", "acme", "core");
    const privateSpace = await openAtlas(w, "ann", "acme-private", "private");
    const cases: [Who, string, string, Open, string[]][] = [
      ["carl", "ann", "vault", vault, [VAULT, "r_vault"]],
      ["anonymous", "ann", "vault", vault, [VAULT, "r_vault"]],
      ["dora", "ann", "vault", vault, [VAULT, "r_vault"]],
      ["carl", "acme", "core", core, [CORE, "r_core"]],
      ["ben", "acme", "core", core, [CORE, "r_core"]],
      ["benBot", "acme", "core", core, [CORE, "r_core"]],
      ["anonymous", "acme", "core", core, [CORE, "r_core"]],
      ["dora", "acme-private", "private", privateSpace, ["Ivoryhaven", "r_private"]],
      ["carl", "acme-private", "private", privateSpace, ["Ivoryhaven", "r_private"]],
    ];
    for (const [who, space, name, open, secrets] of cases) {
      for (const path of surfaces(open)) {
        const hidden = await w.text(who, `${repoBase(space, name)}${path}`);
        const missing = await w.text(who, `${repoBase(space, "ghost")}${path}`);
        expect(hidden, `${who} ${space}/${name}${path}`).toBe(missing);
        expect(hidden.startsWith("404 "), `${who} ${path}`).toBe(true);
        hides(hidden, ...secrets);
      }
      // A Space that doesn't exist looks the same too.
      expect(await w.text(who, `${repoBase(space, name)}/atlas/overview`)).toBe(
        await w.text(who, `${repoBase("nobody", name)}/atlas/overview`),
      );
    }
  });

  test("Organization ownership and sibling Space membership do not reveal a private composition", async () => {
    const base = "/api/spaces/acme-private/atlas";
    const overview = await w.get<AtlasWorkspaceOverview>("ann", `${base}/overview?repos=private`);
    const page = await w.get<AtlasWorkspacePage<AtlasRegion>>(
      "ann",
      `${base}/regions?repos=private&limit=1`,
    );
    expect(page.next).not.toBeNull();
    await w.get<AtlasWorkspaceComposition>("ann", `${base}/composition?repos=private`);
    for (const who of ["carl", "dora"] as const) {
      for (const openView of [() => w, () => w.cold()]) {
        const view = openView();
        for (const route of [
          "overview",
          `overview?snapshot=${enc(overview.snapshot.id)}`,
          `regions?limit=1&cursor=${enc(page.next!)}`,
          "composition",
          `composition?snapshot=${enc(overview.snapshot.id)}`,
          "links?id=r_private%2Frepo&state=resolved",
        ]) {
          const join = route.includes("?") ? "&" : "?";
          const denied = await view.text(who, `${base}/${route}${join}repos=private`);
          expect(denied).toBe(await view.text(who, `${base}/${route}${join}repos=ghost`));
          expect(denied).toMatch(/^404 /);
          hides(denied, "Ivoryhaven", "r_private", overview.snapshot.id);
        }
      }
    }
  });

  const revocations: {
    label: string;
    who: Who;
    space: string;
    name: string;
    marker: string;
    id: string;
    revoke: (w: World) => Promise<void>;
    status: number;
  }[] = [
    {
      label: "a collaborator removed",
      who: "ben",
      space: "ann",
      name: "vault",
      marker: VAULT,
      id: "r_vault",
      status: 404,
      revoke: async (w) => {
        const response = await w.call("ann", "/api/repos/ann/vault/collaborators/ben", {
          method: "DELETE",
        });
        expect(response.status).toBeLessThan(300);
      },
    },
    {
      label: "a public repository made private",
      who: "carl",
      space: "ann",
      name: "open",
      marker: OPEN,
      id: "r_open",
      status: 404,
      revoke: async (w) => {
        const response = await w.call("ann", "/api/repos/ann/open", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visibility: "private" }),
        });
        expect(response.status).toBe(200);
      },
    },
    {
      label: "an organization membership ended",
      who: "dora",
      space: "acme",
      name: "core",
      marker: CORE,
      id: "r_core",
      status: 404,
      revoke: async (w) => {
        w.sqlite.exec(
          `DELETE FROM organization_members WHERE organization_id = 'org-acme' AND account_id = 'dora'`,
        );
      },
    },
    {
      label: "a Space repository baseline withdrawn",
      who: "dora",
      space: "acme",
      name: "core",
      marker: CORE,
      id: "r_core",
      status: 404,
      revoke: async (w) => {
        w.sqlite.exec(
          `UPDATE space_grants SET repository_role = 'none' WHERE space_id = 'acme' AND account_id = 'dora'`,
        );
      },
    },
    {
      label: "an explicit Space grant revoked",
      who: "dora",
      space: "acme",
      name: "core",
      marker: CORE,
      id: "r_core",
      status: 404,
      revoke: async (w) => {
        w.sqlite.exec(`DELETE FROM space_grants WHERE space_id = 'acme' AND account_id = 'dora'`);
      },
    },
    {
      label: "a personal Space grant revoked despite matching person and Space IDs",
      who: "ann",
      space: "ann",
      name: "vault",
      marker: VAULT,
      id: "r_vault",
      status: 404,
      revoke: async (w) => {
        w.sqlite.exec(`DELETE FROM space_grants WHERE space_id = 'ann' AND account_id = 'ann'`);
      },
    },
    {
      label: "an agent revoked",
      who: "benBot",
      space: "ann",
      name: "vault",
      marker: VAULT,
      id: "r_vault",
      status: 401,
      revoke: async (w) => {
        const response = await w.call("ben", "/api/agents/agt_ben", { method: "DELETE" });
        expect(response.status).toBeLessThan(300);
      },
    },
  ];

  test.each(revocations)(
    "$label: the next request, mid-traversal or pinned, warm or cold, discloses nothing",
    async ({ who, space, name, marker, id, revoke, status }) => {
      // The viewer has the overview, the loader's reads and a cursor on every paged route open.
      const open = await openAtlas(w, who, space, name);
      const base = repoBase(space, name);
      expect(await w.text(who, `${base}/atlas/overview`)).toContain(marker);
      for (const path of surfaces(open))
        if (!path.includes("does-not-exist") && !path.includes("made-up"))
          expect((await w.call(who, `${base}${path}`)).status, path).toBe(200);
      const workspace = `/api/spaces/${space}/atlas`;
      const selected = `repos=${enc(name)}`;
      const overview = await w.get<AtlasWorkspaceOverview>(
        who,
        `${workspace}/overview?${selected}`,
      );
      const page = await w.get<AtlasWorkspacePage<AtlasRegion>>(
        who,
        `${workspace}/regions?${selected}&limit=1`,
      );
      expect(page.next).not.toBeNull();
      const composition = await w.get<AtlasWorkspaceComposition>(
        who,
        `${workspace}/composition?${selected}`,
      );
      expect(composition.coverage.map((entry) => entry.repoId)).toEqual([id]);
      const workspacePaths = [
        "overview",
        `overview?snapshot=${enc(overview.snapshot.id)}`,
        `regions?limit=1&cursor=${enc(page.next!)}`,
        "composition",
        `composition?snapshot=${enc(overview.snapshot.id)}`,
      ];

      await revoke(w);

      for (const [label, openView] of [
        ["warm", () => w],
        ["cold", () => w.cold()],
      ] as const) {
        const v = openView();
        for (const path of surfaces(open)) {
          const after = await v.text(who, `${base}${path}`);
          expect(after, `${label} ${path}`).toBe(
            await v.text(who, `${repoBase(space, "ghost")}${path}`),
          );
          expect(after.startsWith(`${status} `), `${label} ${path}: ${after}`).toBe(true);
          hides(after, marker, id, open.snapshot);
        }
        for (const path of workspacePaths) {
          const join = path.includes("?") ? "&" : "?";
          const after = await v.text(who, `${workspace}/${path}${join}${selected}`);
          expect(after, `${label} workspace ${path}`).toBe(
            await v.text(who, `${workspace}/${path}${join}repos=ghost`),
          );
          expect(after.startsWith(`${status} `), `${label} workspace ${path}`).toBe(true);
          hides(after, marker, id, overview.snapshot.id);
        }
      }
    },
  );

  test("validly signed cursors with a mismatched migration epoch are refused warm and cold", async () => {
    const repo = await openAtlas(w, "dora", "acme", "core");
    const base = "/api/spaces/acme/atlas";
    const overview = await w.get<AtlasWorkspaceOverview>("dora", `${base}/overview?repos=core`);
    const regions = await w.get<AtlasWorkspacePage<AtlasRegion>>(
      "dora",
      `${base}/regions?repos=core&limit=1`,
    );
    expect(regions.next).not.toBeNull();
    const admission = await cutoverControl(w.env).admission(CONTENT_CONTRACT_VERSION);
    expect(admission.allowed).toBe(true);
    const secret = await cursorSecret(w.env);
    const version = overview.space.authorizationVersion;
    const repoBinding: CursorBinding = {
      route: "regions",
      scope: `repo:r_core:space:acme:authorization:${version}:epoch:${admission.epoch}`,
      filters: {},
      principal: "user:dora",
    };
    const workspaceBinding: CursorBinding = {
      route: "workspace/regions",
      scope: overview.scope,
      filters: {},
      principal: "user:dora",
    };
    const cases = [
      {
        binding: repoBinding,
        cursor: repo.cursors.regions!,
        path: "/api/repos/acme/core/atlas/regions?limit=1",
      },
      {
        binding: workspaceBinding,
        cursor: regions.next!,
        path: `${base}/regions?repos=core&limit=1`,
      },
    ];
    // Deliberately mismatched persisted tokens, not a fabricated successful activation.
    for (const epoch of [admission.epoch - 1, admission.epoch + 1]) {
      const hash = await sha256(JSON.stringify([4, epoch, "acme", version, ["r_core"]]));
      for (const entry of cases) {
        const current = await verifyCursor(secret, entry.binding, entry.cursor);
        expect(current.ok).toBe(true);
        if (!current.ok) throw new Error("The real request must issue an authentic cursor");
        const binding = {
          ...entry.binding,
          scope:
            entry.binding.route === "regions"
              ? `repo:r_core:space:acme:authorization:${version}:epoch:${epoch}`
              : `ws:acme:${hash.slice(0, 32)}`,
        };
        const mismatched = await signCursor(secret, binding, current.state);
        expect((await verifyCursor(secret, binding, mismatched)).ok).toBe(true);
        for (const openView of [() => w, () => w.cold()]) {
          const view = openView();
          const rejected = await view.text("dora", `${entry.path}&cursor=${enc(mismatched)}`);
          expect(rejected).toMatch(/^400 .*cursor_invalid/);
          expect(rejected).toBe(await view.text("dora", `${entry.path}&cursor=malformed`));
          hides(rejected, CORE, mismatched);
        }
      }
    }
  });

  test("authorization-version changes invalidate old cursors and composite pins without rebuilding repositories", async () => {
    const repo = await openAtlas(w, "dora", "acme", "core");
    const base = "/api/spaces/acme/atlas";
    const overview = await w.get<AtlasWorkspaceOverview>("dora", `${base}/overview?repos=core`);
    const regions = await w.get<AtlasWorkspacePage<AtlasRegion>>(
      "dora",
      `${base}/regions?repos=core&limit=1`,
    );
    expect(regions.next).not.toBeNull();
    await w.get<AtlasWorkspaceComposition>("dora", `${base}/composition?repos=core`);
    w.sqlite.exec(
      `UPDATE spaces SET authorization_version = authorization_version + 1 WHERE id = 'acme'`,
    );
    for (const openView of [() => w, () => w.cold()]) {
      const view = openView();
      expect(
        await view.text(
          "dora",
          `/api/repos/acme/core/atlas/regions?limit=1&cursor=${enc(repo.cursors.regions!)}`,
        ),
      ).toMatch(/^400 .*cursor_invalid/);
      expect(
        await view.text("dora", `${base}/regions?repos=core&limit=1&cursor=${enc(regions.next!)}`),
      ).toMatch(/^400 .*cursor_invalid/);
      for (const route of ["overview", "composition"]) {
        const rejected = await view.text(
          "dora",
          `${base}/${route}?repos=core&snapshot=${enc(overview.snapshot.id)}`,
        );
        expect(rejected).toMatch(/^404 .*snapshot_unknown/);
        hides(rejected, CORE, overview.snapshot.id);
      }
      const current = await view.get<AtlasWorkspaceOverview>("dora", `${base}/overview?repos=core`);
      expect(current.snapshot.id).not.toBe(overview.snapshot.id);
      expect(
        (
          await view.get<AtlasOverview>(
            "dora",
            `/api/repos/acme/core/atlas/overview?snapshot=${enc(repo.snapshot)}`,
          )
        ).snapshot.id,
      ).toBe(repo.snapshot);
    }
  });

  test("cursors are bound to their principal, repository, route and filters", async () => {
    const atlas = (name: string) => `${repoBase("ann", name)}/atlas`;
    const ann = await openAtlas(w, "ann", "ann", "vault");
    const { cursors } = ann;
    const continued: Record<string, (cursor: string) => string> = {
      regions: (c) => `regions?limit=1&cursor=${enc(c)}`,
      children: (c) => `children?id=${enc(ann.dependency)}&limit=1&cursor=${enc(c)}`,
      relations: (c) => `relations?id=${enc(ann.file)}&direction=out&limit=1&cursor=${enc(c)}`,
      evidence: (c) => `evidence?id=${enc(ann.dependency)}&limit=1&cursor=${enc(c)}`,
      catalogue: (c) => `catalogue?q=s&limit=1&cursor=${enc(c)}`,
    };
    const invalid = async (who: Who, name: string, path: string) => {
      const text = await w.text(who, `${atlas(name)}/${path}`);
      expect(text, `${who} ${name} ${path}`).toMatch(/^400 /);
      const body = JSON.parse(text.slice(4)) as AtlasError;
      expect(body.code).toBe("cursor_invalid");
      return text;
    };
    for (const [route, path] of Object.entries(continued)) {
      const cursor = cursors[route]!;
      // Ann continues her own traversal.
      expect((await w.call("ann", `${atlas("vault")}/${path(cursor)}`)).status, route).toBe(200);
      // ben reads vault too, but not through ann's cursor; nor does ann's own agent.
      await invalid("ben", "vault", path(cursor));
      await invalid("annBot", "vault", path(cursor));
      // The same entity ids exist in ann's other repository: the cursor still belongs to vault.
      const elsewhere = await invalid("ann", "other", path(cursor));
      hides(elsewhere, VAULT, "r_vault", ann.snapshot);
      // Another route.
      for (const [other, otherPath] of Object.entries(continued))
        if (other !== route) await invalid("ann", "vault", otherPath(cursor));
      // Tampered.
      const [payload, mac] = cursor.split(".");
      await invalid("ann", "vault", path(`${payload}x.${mac}`));
      // Change significant MAC bits; replacing a suffix can leave it unchanged.
      const tamperedMac = `${mac![0] === "A" ? "B" : "A"}${mac!.slice(1)}`;
      await invalid("ann", "vault", path(`${payload}.${tamperedMac}`));
    }
    // Other filters on the same route.
    await invalid(
      "ann",
      "vault",
      `children?id=${enc(ann.capability)}&limit=1&cursor=${enc(cursors.children!)}`,
    );
    await invalid(
      "ann",
      "vault",
      `relations?id=${enc(ann.file)}&direction=in&limit=1&cursor=${enc(cursors.relations!)}`,
    );
    await invalid(
      "ann",
      "vault",
      `relations?id=${enc(ann.file)}&direction=out&kind=imports&limit=1&cursor=${enc(cursors.relations!)}`,
    );
    await invalid("ann", "vault", `catalogue?q=b&limit=1&cursor=${enc(cursors.catalogue!)}`);
    await invalid(
      "ann",
      "vault",
      `catalogue?q=s&kind=file&limit=1&cursor=${enc(cursors.catalogue!)}`,
    );
    // On a public repository, one anonymous reader's cursor isn't a signed-in reader's.
    const open = await openAtlas(w, "anonymous", "ann", "open");
    await invalid("carl", "open", `regions?limit=1&cursor=${enc(open.cursors.regions!)}`);
    // A repository cursor isn't a workspace cursor, nor the other way round.
    const ws = await w.get<AtlasWorkspacePage<AtlasRegion>>(
      "ann",
      "/api/spaces/ann/atlas/regions?repos=vault&limit=1",
    );
    await invalid("ann", "vault", `regions?limit=1&cursor=${enc(ws.next!)}`);
    const wsText = await w.text(
      "ann",
      `/api/spaces/ann/atlas/regions?repos=vault&limit=1&cursor=${enc(cursors.regions!)}`,
    );
    expect(wsText).toMatch(/^400 .*cursor_invalid/);
  });

  test("a snapshot from another repository is unknown here, exactly like a made-up one", async () => {
    const vault = await openAtlas(w, "ann", "ann", "vault");
    const atlas = `${repoBase("ann", "other")}/atlas`;
    for (const route of [
      "overview",
      "regions",
      `children?id=repo`,
      `detail?id=repo`,
      `ancestors?id=repo`,
      `relations?id=repo&direction=out`,
      `evidence?id=repo`,
      `catalogue?q=s`,
      `contributing?id=${enc(vault.capability)}&other=${enc(vault.dependency)}`,
    ]) {
      const join = route.includes("?") ? "&" : "?";
      const foreign = await w.text(
        "ann",
        `${atlas}/${route}${join}snapshot=${enc(vault.snapshot)}`,
      );
      const madeUp = await w.text("ann", `${atlas}/${route}${join}snapshot=no-such-snapshot`);
      expect(foreign, route).toBe(madeUp);
      expect(foreign).toMatch(/^404 .*snapshot_unknown/);
      hides(foreign, VAULT, "r_vault", vault.snapshot);
    }
  });

  test("a deleted repository leaves nothing: no rows, no reads, not even for its namesake", async () => {
    const ben = await openAtlas(w, "ben", "ann", "vault");
    const ann = await openAtlas(w, "ann", "ann", "vault");
    const ws = await w.get<AtlasWorkspaceOverview>(
      "ben",
      "/api/spaces/ann/atlas/overview?repos=vault,open",
    );
    expect(JSON.stringify(ws)).toContain(VAULT);
    const scope = repoScope("r_vault");
    const rows = () =>
      [
        "atlas_scopes",
        "atlas_snapshots",
        "atlas_current",
        "atlas_entities",
        "atlas_edges",
        "atlas_assignments",
        "atlas_lineage",
      ].map(
        (table) =>
          [
            table,
            (
              w.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE scope = ?`).get(scope) as {
                n: number;
              }
            ).n,
          ] as const,
      );
    expect(rows().find(([t]) => t === "atlas_entities")![1]).toBeGreaterThan(0);

    const deleted = await w.call("ann", "/api/repos/ann/vault", { method: "DELETE" });
    expect(deleted.status).toBeLessThan(300);
    // The purge (CORE-199), without the providers this world forbids.
    const purged = await runPurge(
      {
        ...w.env,
        VECTORS: undefined,
        SEARCH: undefined,
        KNOWLEDGE_BUILD: undefined,
        REGISTRY_DB: d1(migratedRegistryDatabase()),
      } as unknown as Env,
      "r_vault",
      { do: (_name, _config, work) => work(), sleep: async () => {} },
      { waitUntil: () => {} },
    );
    expect(purged).toBe("done");
    expect(rows().filter(([, n]) => n > 0)).toEqual([]);
    for (const table of ["atlas_feed", "kg_nodes", "kg_edges", "wiki_pages", "kg_overlays"])
      expect(
        w.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE repo_id = 'r_vault'`).get(),
        table,
      ).toEqual({ n: 0 });

    // A new repository takes the name, with an Atlas of its own.
    w.sqlite.exec(`
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('r_vault2', 'ann', 'vault', 'private', 'authz-vault2', 'https://r_vault');
      INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('r_vault2', 'ben', 'read');
    `);
    w.git.add("https://r_vault", { "refs/heads/main": oid(1) }, undefined, "authz-vault2");
    await writeFixture(w.sqlite, w.db, "r_vault2", "vault", "Newleaf", oid(1));
    await publishAtlasFixture({ DB: w.db }, "r_vault2", oid(1));

    for (const [who, open] of [
      ["ben", ben],
      ["ann", ann],
    ] as const) {
      for (const [label, openView] of [
        ["warm", () => w],
        ["cold", () => w.cold()],
      ] as const) {
        const v = openView();
        for (const path of surfaces(open)) {
          const text = await v.text(who, `${repoBase("ann", "vault")}${path}`);
          hides(text, VAULT, 'r_vault"', open.snapshot);
          // Old cursors and snapshots name the deleted repository: refused, never re-pointed.
          if (path.includes("cursor="))
            expect(text, `${label} ${path}`).toMatch(/^400 .*cursor_invalid/);
          if (path.includes(`snapshot=${enc(open.snapshot)}`))
            expect(text, `${label} ${path}`).toMatch(/^404 .*snapshot_unknown/);
        }
      }
    }
    // The workspace reads only the namesake.
    const after = await w.get<AtlasWorkspaceOverview>(
      "ben",
      "/api/spaces/ann/atlas/overview?repos=vault,open",
    );
    expect(after.snapshot.repos.map((r) => r.id)).toEqual(["r_open", "r_vault2"]);
    hides(JSON.stringify(after), VAULT);
    expect(
      await w.text(
        "ben",
        `/api/spaces/ann/atlas/overview?repos=vault,open&snapshot=${enc(ws.snapshot.id)}`,
      ),
    ).toMatch(/^404 .*snapshot_unknown/);
  });

  test("a workspace never shows a repository its viewer lost: content, links, lineage, lookup or totals", async () => {
    // vault's second build merges operations into search, retiring a capability with lineage.
    const before = await w.get<AtlasOverview>("ben", `${repoBase("ann", "vault")}/atlas/overview`);
    const ops = [...before.regions, ...before.catalogue.items].find((r) =>
      r.name.includes("Operations"),
    );
    expect(ops, "operations is a capability").toBeDefined();
    await writeFixture(w.sqlite, w.db, "r_vault", "vault", VAULT, oid(3), "merged");
    await publishAtlasFixture({ DB: w.db }, "r_vault", oid(3));
    const retired = await w.call(
      "ben",
      `${repoBase("ann", "vault")}/atlas/detail?id=${enc(ops!.id)}`,
    );
    expect(((await retired.json()) as AtlasError).lineage).toBeDefined();

    const ws = "/api/spaces/ann/atlas";
    const both = "repos=open,vault";
    const overview = await w.get<AtlasWorkspaceOverview>("ben", `${ws}/overview?${both}`);
    expect(JSON.stringify(overview)).toContain(VAULT);
    const regionsOf = [...overview.regions, ...overview.catalogue.items];
    const openCap = regionsOf.find((r) => r.repoId === "r_open" && r.kind === "capability")!;
    const vaultCap = regionsOf.find((r) => r.repoId === "r_vault" && r.kind === "capability")!;
    // Capabilities sharing concepts across the two are related: the cross-repository path a leak would take.
    const related = await w.get<AtlasWorkspacePage<AtlasCrossLink>>(
      "ben",
      `${ws}/links?${both}&id=${enc(openCap.id)}&state=related&limit=1`,
    );
    expect(JSON.stringify(related)).toContain("r_vault");
    const lookup = await w.get<AtlasWorkspacePage<AtlasEntitySummary>>(
      "ben",
      `${ws}/catalogue?${both}&q=${enc(VAULT.toLowerCase())}&limit=1`,
    );
    expect(lookup.items.length).toBe(1);
    const cursors = [
      `regions?${both}&limit=1&cursor=${enc(
        (await w.get<AtlasWorkspacePage<AtlasRegion>>("ben", `${ws}/regions?${both}&limit=1`))
          .next!,
      )}`,
      `catalogue?${both}&q=${enc(VAULT.toLowerCase())}&limit=1&cursor=${enc(lookup.next!)}`,
      `children?${both}&id=${enc(vaultCap.id)}&limit=1&cursor=${enc(
        (
          await w.get<AtlasWorkspacePage<AtlasEntitySummary>>(
            "ben",
            `${ws}/children?${both}&id=${enc(vaultCap.id)}&limit=1`,
          )
        ).next!,
      )}`,
    ];
    if (related.next)
      cursors.push(
        `links?${both}&id=${enc(openCap.id)}&state=related&limit=1&cursor=${enc(related.next)}`,
      );
    const composition = await w.get<AtlasWorkspaceComposition>("ben", `${ws}/composition?${both}`);
    expect(composition.coverage.map((c) => c.repoId)).toEqual(["r_open", "r_vault"]);

    await w.call("ann", "/api/repos/ann/vault/collaborators/ben", { method: "DELETE" });

    const fresh = (repos: string) => [
      `overview?${repos}`,
      `regions?${repos}&limit=5`,
      `catalogue?${repos}&q=${enc(VAULT.toLowerCase())}`,
      `catalogue?${repos}&q=s&limit=100`,
      `children?${repos}&id=${enc(vaultCap.id)}`,
      `detail?${repos}&id=${enc(vaultCap.id)}`,
      `detail?${repos}&id=${enc(`r_vault/${ops!.id}`)}`,
      `ancestors?${repos}&id=${enc(`r_vault/file:billing/ledger/ledger.ts`)}`,
      `relations?${repos}&id=${enc(`r_vault/file:billing/ledger/ledger.ts`)}&direction=out`,
      `evidence?${repos}&id=${enc(vaultCap.id)}`,
      `composition?${repos}`,
      `links?${repos}&id=${enc(openCap.id)}&state=related`,
      `links?${repos}&id=${enc(openCap.id)}&state=unresolved`,
      `links?${repos}&id=${enc("r_vault/repo")}&state=resolved&direction=in`,
    ];
    // Pages issued in the same millisecond: byte-for-byte comparable cursors.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (const [label, openView] of [
      ["warm", () => w],
      ["cold", () => w.cold()],
    ] as const) {
      const v = openView();
      for (const path of cursors) {
        const text = await v.text("ben", `${ws}/${path}`);
        expect(text, `${label} ${path}`).toMatch(/^400 .*cursor_invalid/);
        hides(text, VAULT, "r_vault");
      }
      const pinned = await v.text(
        "ben",
        `${ws}/overview?${both}&snapshot=${enc(overview.snapshot.id)}`,
      );
      expect(pinned, label).toMatch(/^404 .*snapshot_unknown/);
      hides(pinned, VAULT, "r_vault");
      const withVault = fresh(both);
      const without = fresh("repos=open");
      for (let i = 0; i < withVault.length; i++) {
        const text = await v.text("ben", `${ws}/${withVault[i]}`);
        expect(text, `${label} ${withVault[i]}`).toBe(await v.text("ben", `${ws}/${without[i]}`));
        hides(text, VAULT, "r_vault");
      }
    }
    // Nothing readable left in a vault-only selection: the same answer as a name that never existed.
    expect(await w.text("ben", `${ws}/overview?repos=vault`)).toBe(
      await w.text("ben", `${ws}/overview?repos=ghost`),
    );
  });

  test("only complete projections publish; pinned pages keep their snapshot while a newer one lands", async () => {
    const atlas = `${repoBase("ann", "vault")}/atlas`;
    const before = await w.get<AtlasOverview>("ben", `${atlas}/overview`);
    const catalogue = async (cursor?: string) =>
      w.get<AtlasPage<AtlasEntitySummary>>(
        "ben",
        `${atlas}/catalogue?q=s&limit=7${cursor ? `&cursor=${enc(cursor)}` : `&snapshot=${enc(before.snapshot.id)}`}`,
      );
    const whole = await w.get<AtlasPage<AtlasEntitySummary>>(
      "ben",
      `${atlas}/catalogue?q=s&limit=100&snapshot=${enc(before.snapshot.id)}`,
    );
    expect(whole.next).toBeNull();
    const firstPage = await catalogue();

    // An interrupted build: a projection begun with new names, never published.
    w.sqlite.exec(
      `UPDATE kg_nodes SET name = 'Nightjar ' || name WHERE repo_id = 'r_vault' AND kind = 'file'`,
    );
    const building = await beginRepoProjection(w.db, "r_vault", [
      { repoId: "r_vault", commit: oid(4), buildId: "b-interrupted" },
    ]);
    let after: string | null = null;
    do
      ({ next: after } = await projectEntities(
        w.db,
        "r_vault",
        building.snapshotId,
        building.seq,
        after,
      ));
    while (after);
    let edges: EdgeCursor = null;
    do
      ({ next: edges } = await projectEdges(
        w.db,
        "r_vault",
        building.snapshotId,
        building.seq,
        edges,
      ));
    while (edges);
    const unpublished = async () => {
      const now = await w.get<AtlasOverview>("ben", `${atlas}/overview`);
      expect(now.snapshot.id).toBe(before.snapshot.id);
      expect(now.regions).toEqual(before.regions);
      const lookup = await w.get<AtlasPage<AtlasEntitySummary>>(
        "ben",
        `${atlas}/catalogue?q=nightjar`,
      );
      expect(lookup.items).toEqual([]);
      const pinned = await w.call("ben", `${atlas}/overview?snapshot=${enc(building.snapshotId)}`);
      expect(pinned.status).toBe(404);
      const body = (await pinned.json()) as AtlasError;
      expect(body.code).toBe("snapshot_unknown");
      expect(body.current?.id).toBe(before.snapshot.id);
    };
    await unpublished();
    await failProjection(w.db, repoScope("r_vault"), building.snapshotId, "interrupted");
    await unpublished();

    // A push lands a new snapshot while the traversal is open.
    await writeFixture(w.sqlite, w.db, "r_vault", "vault", VAULT, oid(5), "merged");
    await publishAtlasFixture({ DB: w.db }, "r_vault", oid(5));
    expect((await w.get<AtlasOverview>("ben", `${atlas}/overview`)).snapshot.id).not.toBe(
      before.snapshot.id,
    );
    const items = [...firstPage.items];
    let next = firstPage.next;
    while (next) {
      const page = await catalogue(next);
      expect(page.snapshot.id).toBe(before.snapshot.id);
      expect(page.snapshot.vector).toEqual(before.snapshot.vector);
      items.push(...page.items);
      next = page.next;
    }
    // Every page of the pinned snapshot: exactly its result set, no duplicates, no omissions.
    expect(items).toEqual(whole.items);
    const pinned = await w.get<AtlasOverview>(
      "ben",
      `${atlas}/overview?snapshot=${enc(before.snapshot.id)}`,
    );
    expect(pinned.regions).toEqual(before.regions);
    const detail = await w.get<AtlasDetail>(
      "ben",
      `${atlas}/detail?id=${enc(before.regions[0]!.id)}&snapshot=${enc(before.snapshot.id)}`,
    );
    expect(detail.snapshot.vector).toEqual(before.snapshot.vector);
  });

  test("an open view hears that its repository became unreadable, and nothing else does", async () => {
    w.serveClient("ben");
    const vault = { space: "ann", name: "vault" };
    const lost = { vault: 0, open: 0 };
    const stop = onAtlasAccessLost(vault, () => lost.vault++);
    onAtlasAccessLost({ space: "ann", name: "open" }, () => lost.open++)();
    const overview = await atlasApi.overview(vault);
    const page = await atlasApi.regions(vault, { cursor: overview.catalogue.next, limit: 1 });
    expect(page.next).not.toBeNull();
    // Atlas errors about a snapshot or an entity aren't lost access.
    const unknown = await atlasApi
      .overview(vault, { snapshot: "made-up" })
      .catch((e: unknown) => e);
    expect(atlasNeedsRestart(unknown)).toBe(true);
    expect(atlasAccessLost(unknown)).toBe(false);
    await atlasApi.detail(vault, "cap:does-not-exist").catch(() => null);
    expect(lost).toEqual({ vault: 0, open: 0 });

    await w.call("ann", "/api/repos/ann/vault/collaborators/ben", { method: "DELETE" });

    const error = await atlasApi
      .regions(vault, { cursor: page.next, limit: 1 })
      .catch((e: unknown) => e);
    expect(atlasAccessLost(error)).toBe(true);
    expect(atlasNeedsRestart(error)).toBe(false);
    expect(lost).toEqual({ vault: 1, open: 0 });
    await atlasApi.ancestors(vault, "repo").catch(() => null);
    expect(lost.vault).toBe(2);
    // Unsubscribed, it hears nothing more; another repository is unaffected.
    stop();
    await atlasApi.overview(vault).catch(() => null);
    expect(lost.vault).toBe(2);
    expect(
      (await atlasApi.overview({ space: "ann", name: "open" })).regions.length,
    ).toBeGreaterThan(0);
  });

  test("a composition one reader computed is never served warm to another", async () => {
    const path = "/api/spaces/ann/atlas/composition?repos=open,vault";
    const cost = async (who: Who) => {
      const before = w.queries.count;
      const text = await w.text(who, path);
      expect(text.startsWith("200 "), text).toBe(true);
      return { queries: w.queries.count - before, text };
    };
    // ann and ben read the same two repositories: the same authorized input set.
    const annCold = await cost("ann");
    const annWarm = await cost("ann");
    expect(annWarm.queries).toBeLessThan(annCold.queries);
    expect(annWarm.text).toBe(annCold.text);
    // ben's first request costs what a cold one does: ann's warm answer isn't his.
    const benFirst = await cost("ben");
    expect(benFirst.queries).toBe(annCold.queries);
    expect(benFirst.text).toBe(annCold.text);
    expect((await cost("ben")).queries).toBe(annWarm.queries);
    // Nor is ben's agent's, though it reads with ben's access.
    expect((await cost("benBot")).queries).toBe(annCold.queries);
  });
});
