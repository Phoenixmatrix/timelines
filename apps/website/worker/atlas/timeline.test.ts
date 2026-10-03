// Timelines in Atlas terms (CORE-176) against real D1 projections of the
// Atlas fixture and a stored knowledge overlay of the fixture timeline,
// through the Atlas API and its browser client: changed files placed in
// capabilities (main's placement, provisional for new files until the
// timeline's regrouping is computed, unclassified with nothing to go by;
// computed placements in timelineGrouping.test.ts), imports that reach another capability, per-repo
// base/head/merge-base and freshness against the snapshot on screen, exact
// capability filtering and paging, an ended overlay read without being
// recomputed, and wiki pages reachable from the capabilities they're about.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AtlasError, AtlasTimeline } from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Timing } from "../timing.ts";
import { atlasApi, atlasErrorOf } from "../../src/lib/atlas.ts";
import {
  coverageText,
  mergeBaseText,
  placementText,
  timelineCaveatText,
  wikiNote,
} from "../../src/routes/repo/atlasTimeline.ts";
import { atlas } from "./api.ts";
import {
  endAtlasFixtureOverlay,
  publishAtlasFixture,
  writeAtlasFixtureGraph,
  writeAtlasFixtureOverlay,
} from "./fixture.ts";

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
const C2 = "2".repeat(40);
const TIP = "7".repeat(40);
const REF = "refs/heads/timeline/plan";
/** The fixture timeline's regrouping: over search and billing's ledger, against #1. */
const COMPUTED = {
  code: "regrouping",
  state: "computed",
  seq: 1,
  basis: "same",
  capabilities: 2,
  files: 13,
} as const;

function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`Reading a timeline touched ${name}.${String(key)}`);
      },
    },
  );
}

let names = 0;

function setup(bookmarks: Record<string, string> = { [REF]: TIP }) {
  const sqlite = migratedDatabase();
  // A fresh Artifacts name each time: RepoReader caches refs by name.
  const artifacts = `atlas-timeline-${++names}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'shop', 'private', '${artifacts}', 'https://shop');
  `);
  const git = fakeRemotes();
  git.add("https://shop", { "refs/heads/main": C1, ...bookmarks });
  const touched: string[] = [];
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
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
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos/:owner/:name/atlas", atlas);
  const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init ?? {}, env, executionCtx as unknown as ExecutionContext);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    return href.startsWith("https://shop") ? git.fetch(input, init) : request(href, init);
  });
  return {
    sqlite,
    env,
    touched,
    call: (path: string) => request(`/api/repos/ann/shop/atlas/${path}`),
    as: (next: Actor | null) => {
      actor = next;
    },
  };
}

const repo = { owner: "ann", name: "shop" };

/** Main's Atlas at C1, and the plan timeline's overlay at TIP measured against it. */
async function planned(s: ReturnType<typeof setup>) {
  await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
  const main = await publishAtlasFixture(s.env, "r1", C1);
  const overlay = await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1);
  return { main, overlay };
}

/** Every file record, a page at a time. */
async function all(request: Parameters<typeof atlasApi.timeline>[2] = {}) {
  const pages: AtlasTimeline[] = [];
  let cursor: string | null = null;
  do {
    const page: AtlasTimeline = await atlasApi.timeline(repo, "timeline/plan", {
      ...request,
      cursor,
    });
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return { pages, items: pages.flatMap((p) => p.items), first: pages[0]! };
}

describe("Timelines in the Atlas", () => {
  test("a timeline's files are placed in capabilities, with what's inferred said so", async () => {
    const s = setup();
    const { main } = await planned(s);
    // An overlay whose regrouping isn't computed yet (as one kept before
    // CORE-186): new files are placed by inference, and that's said.
    s.sqlite.exec("DELETE FROM atlas_timeline_regroupings");
    const { first, items } = await all();

    expect(first.snapshot.id).toBe(main.snapshotId);
    expect(first.ref).toBe("timeline/plan");
    expect(first.timeline).toBe("plan");
    // The one repository: its bookmark, overlay, base and merge base, each known.
    expect(first.repos).toEqual([
      expect.objectContaining({
        repoId: "r1",
        owner: "ann",
        name: "shop",
        ref: "timeline/plan",
        state: "up-to-date",
        head: TIP,
        headKnown: true,
        commit: TIP,
        baseCommit: C1,
        mergeBase: C1,
        mergeBaseState: "found",
        ended: null,
        projectionCommit: C1,
        base: "same",
        changes: { total: 5, stored: 5 },
        coverage: { files: 4, syntax: 4 },
        graph: { symbol: { added: 1, changed: 0, removed: 0 } },
      }),
    ]);
    expect(first.caveats).toEqual([{ code: "regrouping", state: "pending" }]);

    const byPath = new Map(items.map((f) => [f.path, f]));
    expect([...byPath.keys()]).toEqual([
      "misc/legacy.ts",
      "notify/email.ts",
      "search/rank.ts",
      "search/suggest.ts",
    ]);
    const rank = byPath.get("search/rank.ts")!;
    const search = rank.placement.capability!;
    expect(rank).toMatchObject({
      change: "changed",
      classes: ["source"],
      placement: { state: "projected", basis: null },
    });
    expect(rank.fields).toContain("blob");
    expect(search.name).toBeTruthy();
    // Its new import of the ledger reaches billing's capability.
    expect(rank.imports.added).toHaveLength(1);
    const billing = rank.imports.added[0]!;
    expect(billing.id).not.toBe(search.id);
    expect(billing.name).toBeTruthy();

    // A new file in search's folder: provisionally search's, and why.
    expect(byPath.get("search/suggest.ts")).toMatchObject({
      change: "added",
      classes: ["source"],
      fields: [],
      placement: {
        state: "provisional",
        capability: { id: search.id, name: search.name },
        basis: { folder: "search", files: 6, of: 6 },
      },
      imports: { added: [], removed: [] },
    });
    // A new folder: nothing to place it by.
    expect(byPath.get("notify/email.ts")!.placement).toEqual({
      state: "unclassified",
      capability: null,
      area: null,
      basis: null,
    });
    // Removed: where main had it (unclassified there too).
    expect(byPath.get("misc/legacy.ts")).toMatchObject({
      change: "removed",
      classes: ["source"],
      placement: { state: "unclassified", capability: null },
    });

    // In words, as the panel says them: an inferred place is said to be one.
    expect(placementText(byPath.get("search/suggest.ts")!)).toBe(
      `Provisionally in ${search.name}: 6 files of 6 in search/ are there. Main's next build places it.`,
    );
    expect(placementText(byPath.get("notify/email.ts")!)).toBe(
      "Unclassified: nothing in the map places its folder yet.",
    );
    expect(placementText(byPath.get("misc/legacy.ts")!)).toBe("Was unclassified in this map.");
    expect(mergeBaseText(first.repos[0]!)).toBe(C1.slice(0, 7));
    expect(coverageText(first.repos[0]!)).toBe(
      "Syntax changes cover all 4 changed files (by language).",
    );

    // The capabilities touched: search first, the unclassified last.
    expect(first.regionCount).toBe(2);
    expect(first.regions).toEqual([
      expect.objectContaining({
        id: search.id,
        name: search.name,
        files: { added: 1, changed: 1, removed: 0 },
        provisional: 1,
        classes: { source: 2, summary: 0, other: 0, regrouping: 0 },
        imports: { added: [billing], removed: [] },
      }),
      expect.objectContaining({
        id: "group:unclassified",
        name: "Unclassified",
        files: { added: 1, changed: 0, removed: 1 },
        provisional: 0,
      }),
    ]);
    expect(first.wiki).toBeNull();
    expect(s.touched).toEqual([]);

    // Filtering by a capability includes its changes, says which, and pages exactly.
    const only = await all({ within: search.id, limit: 1 });
    expect(only.first.within).toMatchObject({ id: search.id, kind: "capability" });
    expect(only.items.map((f) => f.path)).toEqual(["search/rank.ts", "search/suggest.ts"]);
    expect(only.pages).toHaveLength(2);
    expect(only.first.counts.knownTotal).toBe(2);
    expect(only.pages.slice(1).every((p) => p.regions === null)).toBe(true);
    const none = await all({ within: billing.id });
    expect(none.items).toEqual([]);
    expect(none.first.counts.knownTotal).toBe(0);

    // A page at a time, the same records once each.
    const paged = await all({ limit: 1 });
    expect(paged.pages).toHaveLength(4);
    expect(paged.items).toEqual(items);
  });

  test("against a newer main, the overlay says it was measured against an older one", async () => {
    const s = setup();
    const { main } = await planned(s);
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C2, "merged");
    const later = await publishAtlasFixture(s.env, "r1", C2);

    const now = await atlasApi.timeline(repo, "timeline/plan");
    expect(now.snapshot.id).toBe(later.snapshotId);
    expect(now.repos[0]).toMatchObject({ baseCommit: C1, projectionCommit: C2, base: "older" });
    expect(now.caveats).toContainEqual({
      code: "base",
      relation: "older",
      baseCommit: C1,
      projectionCommit: C2,
    });
    expect(timelineCaveatText(now.caveats.find((c) => c.code === "base")!)).toBe(
      `The overlay was computed against main at ${C1.slice(0, 7)}, an older main than this map (${C2.slice(0, 7)}): main's own changes in between can show here.`,
    );
    // Main's wiki page from C1, against the newer map, is labelled as older.
    expect(wikiNote({ generatedIn: C1, updatedAt: "2020-01-01T00:00:00.000Z" }, now.snapshot)).toBe(
      `Written from ${C1.slice(0, 7)}, before this map (${C2.slice(0, 7)}) was built: it may describe older code.`,
    );
    expect(wikiNote({ generatedIn: C2, updatedAt: "2020-01-01T00:00:00.000Z" }, now.snapshot)).toBe(
      `Written from this map's commit, ${C2.slice(0, 7)}.`,
    );
    // Pinned to the snapshot it was measured against, it's the same main.
    const then = await atlasApi.timeline(repo, "timeline/plan", { snapshot: main.snapshotId });
    expect(then.repos[0]).toMatchObject({ projectionCommit: C1, base: "same" });
    expect(then.caveats).toEqual([COMPUTED]);
    // Against the newer map, its regrouping says it was computed on an older one.
    expect(now.caveats).toContainEqual({ ...COMPUTED, basis: "older" });
  });

  test("an ended timeline is read as kept, and reading it changes nothing", async () => {
    // The bookmark is gone: the timeline landed.
    const s = setup({});
    await planned(s);
    await endAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", "landed");
    const kept = () =>
      s.sqlite
        .prepare(
          "SELECT overlay_id, head_commit, base_commit, updated_at, ended_at, ended_reason, status FROM kg_overlays",
        )
        .all();
    const before = kept();
    const changes = s.sqlite.prepare("SELECT count(*) AS n FROM kg_overlay_changes").get();

    const { first, items } = await all();
    expect(first.repos[0]).toMatchObject({
      state: "ended",
      head: null,
      headKnown: true,
      commit: TIP,
      ended: { reason: "landed" },
    });
    expect(items).toHaveLength(4);
    expect(first.caveats).toEqual([COMPUTED]);
    const regrouping = s.sqlite.prepare("SELECT * FROM atlas_timeline_regroupings").all();
    await all({ limit: 1 });
    expect(kept()).toEqual(before);
    expect(s.sqlite.prepare("SELECT * FROM atlas_timeline_regroupings").all()).toEqual(regrouping);
    expect(s.sqlite.prepare("SELECT count(*) AS n FROM kg_overlay_changes").get()).toEqual(changes);
    expect(s.touched).toEqual([]);
  });

  test("wiki pages are reachable from the capabilities they're about, labelled by their main", async () => {
    const s = setup();
    await planned(s);
    // Main's page about the search concept, and the timeline's checkpoint set.
    s.sqlite.exec(`
      INSERT INTO kg_overlay_changes (repo_id, overlay_id, node_id, kind, change, name, path, summary, detail)
        SELECT 'r1', overlay_id, 'concept:search', 'concept', 'changed', 'Search', NULL, '',
          '{"fields":["summary"],"links":{"added":[],"removed":[]}}' FROM kg_overlays;
      INSERT INTO wiki_pages (repo_id, slug, title, section, position, node_id, body, inputs_hash, generated_in)
        VALUES ('r1', 'search', 'Search', 'Concepts', 3, 'concept:search', 'Search.', 'h', '${C1}');
      INSERT INTO kg_page_sets (repo_id, ref, set_key, checkpoint_id, checkpoint_number, commit_oid,
          base_commit, status, finished_at)
        VALUES ('r1', '${REF}', 'cp_1', 'cp_1', 1, '${TIP}', '${C1}', 'succeeded', '2026-10-03T00:00:00.000Z');
      INSERT INTO kg_page_set_pages (repo_id, ref, set_key, slug, title, section, position, node_id,
          kind, change, outcome, inputs_hash)
        VALUES ('r1', '${REF}', 'cp_1', 'search', 'Search', 'Concepts', 0, 'concept:search',
          'glossary', 'changed', 'written', 'h');
    `);
    const page = await atlasApi.timeline(repo, "timeline/plan");
    expect(page.wiki).toMatchObject({
      key: "cp_1",
      checkpoint: { id: "cp_1", number: 1 },
      commit: TIP,
      baseCommit: C1,
      base: "same",
      state: "succeeded",
      pages: 1,
    });
    const search = page.regions!.find((r) => r.id !== "group:unclassified")!;
    expect(search.pages).toEqual([
      { slug: "search", title: "Search", set: "cp_1", change: "changed", outcome: "written" },
    ]);
    expect(search.mainPages).toEqual([
      expect.objectContaining({
        slug: "search",
        nodeId: "concept:search",
        generatedIn: C1,
        relation: "same",
      }),
    ]);
    // The unclassified files mention no concept: no page is about them.
    const unclassified = page.regions!.find((r) => r.id === "group:unclassified")!;
    expect(unclassified.pages).toEqual([]);
  });

  test("a cursor is bound to the overlay it started on, and requests are checked", async () => {
    const s = setup();
    await planned(s);
    const first = await atlasApi.timeline(repo, "timeline/plan", { limit: 1 });
    // A push recomputes the overlay: the traversal stops, it doesn't mix two.
    await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1);
    const changed = await atlasApi
      .timeline(repo, "timeline/plan", { limit: 1, cursor: first.next })
      .then(() => null, atlasErrorOf);
    expect(changed?.code).toBe("timeline_changed");

    const status = async (path: string) => {
      const response = await s.call(path);
      return [response.status, ((await response.json()) as AtlasError).code] as const;
    };
    expect(await status("timeline?ref=timeline/nope")).toEqual([404, "timeline_unknown"]);
    expect(await status("timeline?ref=main")).toEqual([400, "bad_request"]);
    expect(await status("timeline?ref=timeline/plan&within=cap%3Anope")).toEqual([
      404,
      "entity_unknown",
    ]);
    expect(
      await status(
        `timeline?ref=timeline/plan&within=${encodeURIComponent("file:search/rank.ts")}`,
      ),
    ).toEqual([400, "bad_request"]);
    // The cursor is bound to its bookmark and filter.
    const fresh = await atlasApi.timeline(repo, "timeline/plan", { limit: 1 });
    const cursor = encodeURIComponent(fresh.next ?? "");
    expect(
      await status(`timeline?ref=timeline/plan&within=group%3Aunclassified&cursor=${cursor}`),
    ).toEqual([400, "cursor_invalid"]);

    // Someone who can't read the repository sees it missing.
    s.as(ben);
    const missing = await s.call("overview");
    const body = await missing.text();
    for (const path of ["timeline?ref=timeline/plan", "timeline?ref=timeline/nope", "timeline"]) {
      const response = await s.call(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe(body);
    }
  });
});
