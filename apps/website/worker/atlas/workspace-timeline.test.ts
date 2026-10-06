// A timeline across a workspace (CORE-186): GET /api/accounts/:owner/atlas/timeline
// against real D1 projections of three repositories, through the browser
// client. Each repository's part is its own: one with the timeline (placed in
// its own snapshot, ids namespaced, its regrouping read), one without it
// (`none`), one with an overlay but no Atlas (facts and `no-map`). Files page
// across repositories; the cursor is bound to every overlay; a repository the
// caller can't read is never mentioned; nothing is computed by reading.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AtlasWorkspaceTimeline } from "../../shared/atlas.ts";
import { atlasErrorOf, atlasWorkspaceApi } from "../../src/lib/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Timing } from "../timing.ts";
import {
  publishAtlasFixture,
  writeAtlasFixtureGraph,
  writeAtlasFixtureOverlay,
} from "./fixture.ts";
import { workspaceAtlas } from "./workspace.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const C1 = "1".repeat(40);
const TIP = "7".repeat(40);
let names = 0;

async function setup() {
  const sqlite = migratedDatabase();
  const n = ++names;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'shop', 'public', 'ws-shop-${n}', 'https://shop'),
      ('r2', 'ann', 'docs', 'public', 'ws-docs-${n}', 'https://docs'),
      ('r3', 'ann', 'notes', 'private', 'ws-notes-${n}', 'https://notes');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('r3', 'ben', 'read');
    INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, owner_id,
      artifacts_name, artifacts_remote, state, allocation_operation_id, fork_source_id,
      fork_commit, fork_tree, fork_ref, initial_source_id, initial_commit, initial_tree, initial_ref,
      initial_token_revoked, created_at, updated_at)
    VALUES
      ('work_shop', 'r1', 'plan', 'plan', 'ann', 'ws-shop-work-${n}', 'https://shop-work',
       'ready', 'allocate-shop', 'canonical', '${C1}', '${C1}', 'refs/heads/main',
       'canonical', '${C1}', '${C1}', 'refs/heads/main', 1, '', ''),
      ('work_notes', 'r3', 'plan', 'plan', 'ann', 'ws-notes-work-${n}', 'https://notes-work',
       'ready', 'allocate-notes', 'canonical', '${C1}', '${C1}', 'refs/heads/main',
       'canonical', '${C1}', '${C1}', 'refs/heads/main', 1, '', '');
  `);
  const git = fakeRemotes();
  git.add("https://shop", { "refs/heads/main": C1 }, undefined, `ws-shop-${n}`);
  git.add("https://shop-work", { "refs/heads/work": TIP }, "refs/heads/work", `ws-shop-work-${n}`);
  git.add("https://docs", { "refs/heads/main": C1 }, undefined, `ws-docs-${n}`);
  git.add("https://notes", { "refs/heads/main": C1 }, undefined, `ws-notes-${n}`);
  git.add(
    "https://notes-work",
    { "refs/heads/work": TIP },
    "refs/heads/work",
    `ws-notes-work-${n}`,
  );
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/accounts/:owner/atlas", workspaceAtlas);
  const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    return /^https:\/\/(shop|docs|notes)/.test(href)
      ? git.fetch(input, init)
      : app.request(href, init ?? {}, env, executionCtx as unknown as ExecutionContext);
  });
  // shop: an Atlas and the timeline's overlay. docs: an Atlas, no timeline.
  // notes: the timeline's overlay, no Atlas.
  for (const [id, name] of [
    ["r1", "shop"],
    ["r2", "docs"],
    ["r3", "notes"],
  ] as const)
    await writeAtlasFixtureGraph(env.DB, id, name, C1);
  await publishAtlasFixture(env, "r1", C1);
  await publishAtlasFixture(env, "r2", C1);
  const shop = await writeAtlasFixtureOverlay(env.DB, "r1", "timeline/plan", TIP, C1, "work_shop");
  await writeAtlasFixtureOverlay(env.DB, "r3", "timeline/plan", TIP, C1, "work_notes");
  return {
    sqlite,
    env,
    shop,
    as: (next: Actor | null) => {
      actor = next;
    },
  };
}

const workspace = { owner: "ann", repos: ["shop", "docs", "notes"] };

async function all(request: Parameters<typeof atlasWorkspaceApi.timeline>[2] = {}) {
  const pages: AtlasWorkspaceTimeline[] = [];
  let cursor: string | null = null;
  do {
    const page: AtlasWorkspaceTimeline = await atlasWorkspaceApi.timeline(
      workspace,
      "timeline/plan",
      { ...request, cursor },
    );
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return { pages, items: pages.flatMap((p) => p.items), first: pages[0]! };
}

describe("A timeline across a workspace", () => {
  test("each repository's part is its own, and files are placed in their own repository's map", async () => {
    const s = await setup();
    const { first, items } = await all();
    const byName = new Map(first.repos.map((r) => [r.name, r]));
    expect(first.ref).toBe("timeline/plan");
    expect(first.timeline).toBe("plan");
    expect([...byName.keys()]).toEqual(["shop", "docs", "notes"]);
    expect(byName.get("shop")).toMatchObject({
      sourceId: "work_shop",
      state: "up-to-date",
      head: TIP,
      commit: TIP,
      baseCommit: C1,
      mergeBaseState: "found",
      projectionCommit: C1,
      base: "same",
    });
    expect(byName.get("docs")).toMatchObject({
      sourceId: null,
      state: "none",
      head: null,
      commit: null,
      projectionCommit: C1,
      base: "unknown",
    });
    expect(byName.get("notes")).toMatchObject({
      sourceId: "work_notes",
      state: "up-to-date",
      head: TIP,
      commit: TIP,
      projectionCommit: null,
      base: "unknown",
      coverage: { files: 4, syntax: 4 },
    });
    // The repository with a map: its files, ids and placements namespaced.
    expect(items.map((f) => [f.repoId, f.path])).toEqual([
      ["r1", "misc/legacy.ts"],
      ["r1", "notify/email.ts"],
      ["r1", "search/rank.ts"],
      ["r1", "search/suggest.ts"],
    ]);
    const suggest = items.find((f) => f.path === "search/suggest.ts")!;
    expect(suggest.id).toBe("r1/file:search/suggest.ts");
    expect(suggest.placement).toMatchObject({
      state: "computed",
      capability: { id: expect.stringMatching(/^r1\/cap:/) },
    });
    expect(first.regions!.every((r) => r.repoId === "r1" && r.id.startsWith("r1/"))).toBe(true);
    expect(first.regions![0]!.id).toBe(suggest.placement.capability!.id);
    expect(first.caveats).toContainEqual({
      code: "regrouping",
      state: "computed",
      seq: 1,
      basis: "same",
      capabilities: 2,
      files: 13,
      repoId: "r1",
    });
    expect(first.caveats).toContainEqual({ code: "no-map", repoId: "r3" });
    expect(first.caveats.some((c) => c.repoId === "r2")).toBe(false);
    expect(first.wiki).toEqual({ r1: null, r2: null, r3: null });
    // The envelope says which snapshot each repository was read at.
    expect(first.snapshot.repos.map((r) => [r.name, r.state])).toEqual([
      ["shop", "ready"],
      ["docs", "ready"],
      ["notes", "not-enabled"],
    ]);

    // Filtering by a (namespaced) capability, and paging one at a time.
    const search = suggest.placement.capability!.id;
    const only = await all({ within: search, limit: 1 });
    expect(only.items.map((f) => f.path)).toEqual(["search/rank.ts", "search/suggest.ts"]);
    expect(only.first.within).toMatchObject({ id: search, kind: "capability" });
    expect(only.pages).toHaveLength(2);
    expect((await all({ limit: 1 })).items).toEqual(items);

    // Reading computed nothing.
    expect(s.sqlite.prepare("SELECT count(*) AS n FROM atlas_timeline_regroupings").get()).toEqual({
      n: 2,
    });
  });

  test("a push to any repository's timeline stops a traversal; unreadable ones are never mentioned", async () => {
    const s = await setup();
    const page = await atlasWorkspaceApi.timeline(workspace, "timeline/plan", { limit: 1 });
    await writeAtlasFixtureOverlay(s.env.DB, "r3", "timeline/plan", TIP, C1, "work_notes");
    const stopped = await atlasWorkspaceApi
      .timeline(workspace, "timeline/plan", { limit: 1, cursor: page.next })
      .then(() => null, atlasErrorOf);
    expect(stopped?.code).toBe("timeline_changed");

    // Ben reads notes (shared with him) and the public ones; selecting a
    // repository he can't see is the same as not selecting it.
    s.sqlite.exec("UPDATE repos SET visibility = 'private' WHERE id = 'r2'");
    s.as(ben);
    const his = await atlasWorkspaceApi.timeline(workspace, "timeline/plan");
    const without = await atlasWorkspaceApi.timeline(
      { owner: "ann", repos: ["shop", "notes"] },
      "timeline/plan",
    );
    expect(his.repos.map((r) => r.name)).toEqual(["shop", "notes"]);
    expect(JSON.stringify(his)).not.toContain("docs");
    expect(JSON.stringify(his)).toBe(JSON.stringify(without));

    const bad = await atlasWorkspaceApi.timeline(workspace, "main").then(() => null, atlasErrorOf);
    expect(bad?.code).toBe("bad_request");
  });
});
