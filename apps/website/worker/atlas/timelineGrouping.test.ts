// A timeline's computed regrouping (CORE-186): the bounded grouping pass on
// its own (a split, a merge and a move, each measured against main's own
// grouping of the same files), then against real D1 projections of the Atlas
// fixture and its stored timeline overlay, through the Atlas API: computed
// when the overlay is stored and read by the timeline view (a new file placed
// by it, a split said per capability with where its files would go), kept
// with its overlay (a newer overlay replaces it, an ended one keeps its own),
// bounded (too large or no map: not computed, and said), and never computed
// by reading.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { KnowledgeOverlayChange } from "../../shared/api.ts";
import type { AtlasTimeline } from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import type { BuiltGraph } from "../knowledge/graph.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Timing } from "../timing.ts";
import { atlasApi } from "../../src/lib/atlas.ts";
import { placementText, timelineCaveatText } from "../../src/routes/repo/atlasTimeline.ts";
import { atlas } from "./api.ts";
import {
  endAtlasFixtureOverlay,
  publishAtlasFixture,
  writeAtlasFixtureGraph,
  writeAtlasFixtureOverlay,
} from "./fixture.ts";
import type { GroupingInput } from "./grouping.ts";
import { readTimelineRegrouping, regroup, storeTimelineRegrouping } from "./timelineGrouping.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const f = (name: string) => `file:${name}.ts`;
const clique = (names: string[]) =>
  names.flatMap((a, i) => names.slice(i + 1).map((b) => ({ src: f(a), dst: f(b) })));
const input = (names: string[], imports: GroupingInput["imports"]): GroupingInput => ({
  files: names.map(f),
  imports,
  mentions: [],
  conceptNames: new Map(),
});

describe("regroup", () => {
  const A = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const B = ["b1", "b2", "b3", "b4"];
  const C = ["c1", "c2", "c3", "c4", "c5"];
  const all = [...A, ...B, ...C];
  const placed = new Map(
    all.map((x) => [f(x), { capability: `cap:${x[0]!.toUpperCase()}`, area: null }]),
  );
  const main = input(all, [...clique(A), ...clique(B), ...clique(C)]);

  test("the same files grouped the same way: nothing moves, nothing is proposed", () => {
    expect(regroup(main, main, placed, [f("a1"), f("b1")])).toEqual({
      files: {
        [f("a1")]: { capability: "cap:A", area: null, moved: false },
        [f("b1")]: { capability: "cap:B", area: null, moved: false },
      },
      groups: {},
      regions: [],
    });
  });

  test("a split, a merge and a move, with where each capability's files would go", () => {
    // A falls into two halves, a new file joining the second; B's files
    // import C's throughout.
    const timeline = input(
      [...all, "n1"],
      [
        ...clique(["a1", "a2", "a3"]),
        ...clique(["a4", "a5", "a6", "n1"]),
        ...clique(B),
        ...clique(C),
        ...B.flatMap((b) => C.map((c) => ({ src: f(b), dst: f(c) }))),
      ],
    );
    // Main's graph doesn't have the new file.
    const result = regroup(main, timeline, placed, [f("a1"), f("b1"), f("c1"), f("n1")]);
    // Neither half has more than half of A: both are groups main doesn't have.
    const halves = Object.keys(result.groups).sort(
      (a, b) => result.groups[a]!.files - result.groups[b]!.files,
    );
    expect(halves.map((id) => result.groups[id]!.files)).toEqual([3, 4]);
    for (const id of halves) {
      expect(id).toMatch(/^proposed:/);
      expect(result.groups[id]).toMatchObject({
        change: "split",
        from: [{ id: "cap:A", share: 0.5 }],
      });
    }
    expect(result.regions).toEqual([
      {
        id: "cap:A",
        change: "split",
        into: [...halves].sort().map((id) => ({ id, share: 0.5 })),
      },
      { id: "cap:B", change: "merged", into: [{ id: "cap:C", share: 1 }] },
    ]);
    expect(result.files[f("a1")]).toEqual({ capability: halves[0], area: null, moved: true });
    // b1 moves into C; c1 stays; the new file is in the larger half (it had
    // no place to move from).
    expect(result.files[f("b1")]).toEqual({ capability: "cap:C", area: null, moved: true });
    expect(result.files[f("c1")]).toEqual({ capability: "cap:C", area: null, moved: false });
    expect(result.files[f("n1")]).toEqual({ capability: halves[1], area: null, moved: false });
  });
});

// ---- against D1 and the API --------------------------------------------------------

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const TIP = "7".repeat(40);
const REF = "refs/heads/timeline/plan";
const SOURCE = "work_regroup_plan";
let names = 0;

function setup(bookmarks: Record<string, string> = { [REF]: TIP }) {
  const sqlite = migratedDatabase();
  const artifacts = `atlas-regroup-${++names}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'shop', 'private', '${artifacts}', 'https://shop');
    INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, owner_id,
      artifacts_name, artifacts_remote, state, allocation_operation_id, fork_source_id,
      fork_commit, fork_tree, fork_ref, initial_source_id, initial_commit, initial_tree, initial_ref,
      initial_token_revoked, created_at, updated_at)
    VALUES ('${SOURCE}', 'r1', 'plan', 'plan', 'ann', '${artifacts}-work', 'https://shop-work',
      'ready', 'allocate-plan', 'canonical', '${C1}', '${C1}', 'refs/heads/main',
      'canonical', '${C1}', '${C1}', 'refs/heads/main', 1, '', '');
  `);
  const git = fakeRemotes();
  git.add("https://shop", { "refs/heads/main": C1 }, undefined, artifacts);
  git.add(
    "https://shop-work",
    bookmarks[REF] ? { "refs/heads/work": bookmarks[REF] } : {},
    "refs/heads/work",
    `${artifacts}-work`,
  );
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos/:owner/:name/atlas", atlas);
  const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : String(url);
    return href.startsWith("https://shop")
      ? git.fetch(url, init)
      : app.request(href, init ?? {}, env, executionCtx as unknown as ExecutionContext);
  });
  const rows = () =>
    sqlite
      .prepare("SELECT overlay_id, seq, state, reason FROM atlas_timeline_regroupings")
      .all() as { overlay_id: string; seq: number | null; state: string; reason: string | null }[];
  return { sqlite, env, rows };
}

const repo = { owner: "ann", name: "shop" };

async function all(): Promise<{ first: AtlasTimeline; items: AtlasTimeline["items"] }> {
  const pages: AtlasTimeline[] = [];
  let cursor: string | null = null;
  do {
    const page: AtlasTimeline = await atlasApi.timeline(repo, "timeline/plan", { cursor });
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return { first: pages[0]!, items: pages.flatMap((p) => p.items) };
}

/** Main's graph as the fixture stored it, in memory, as an overlay builds it. */
function storedGraph(sqlite: ReturnType<typeof migratedDatabase>): BuiltGraph {
  const nodes = (
    sqlite
      .prepare("SELECT id, kind, name, path, data FROM kg_nodes WHERE repo_id = 'r1'")
      .all() as {
      id: string;
      kind: string;
      name: string;
      path: string | null;
      data: string;
    }[]
  ).map((n) => ({
    ...n,
    kind: n.kind as BuiltGraph["nodes"][number]["kind"],
    summary: "",
    changedIn: "",
    data: JSON.parse(n.data) as Record<string, unknown>,
  }));
  const edges = sqlite
    .prepare("SELECT src, dst, kind, weight FROM kg_edges WHERE repo_id = 'r1'")
    .all() as unknown as BuiltGraph["edges"];
  return {
    nodes,
    edges,
    components: [],
    componentDeps: new Map(),
    conceptFiles: new Map(),
    topicNames: new Map(),
  };
}

describe("A timeline's regrouping", () => {
  test("is computed when its overlay is stored, and the timeline view reads it", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const { overlayId } = await writeAtlasFixtureOverlay(
      s.env.DB,
      "r1",
      "timeline/plan",
      TIP,
      C1,
      SOURCE,
    );
    expect(s.rows()).toEqual([{ overlay_id: overlayId, seq: 1, state: "computed", reason: null }]);

    const { first, items } = await all();
    const byPath = new Map(items.map((file) => [file.path, file]));
    const rank = byPath.get("search/rank.ts")!;
    const search = rank.placement.capability!;
    // Main's placement stays; the regrouping keeps it there.
    expect(rank).toMatchObject({
      placement: { state: "projected" },
      regrouping: { capability: { id: search.id, proposed: false }, moved: false },
      classes: ["source"],
    });
    // The new file: placed by the regrouping, not by its folder.
    const suggest = byPath.get("search/suggest.ts")!;
    expect(suggest).toMatchObject({
      change: "added",
      placement: {
        state: "computed",
        capability: { id: search.id, name: search.name },
        basis: null,
      },
      regrouping: { capability: { id: search.id, proposed: false }, moved: false },
    });
    expect(placementText(suggest)).toBe(
      `New: the timeline's regrouping puts it in ${search.name}.`,
    );
    // With no evidence at all, it stays unclassified, as computed.
    expect(byPath.get("notify/email.ts")).toMatchObject({
      placement: { state: "unclassified", capability: null },
      regrouping: { capability: null, moved: false },
    });
    // A removed file has nothing to place.
    expect(byPath.get("misc/legacy.ts")!.regrouping).toBeNull();

    const caveat = first.caveats.find((c) => c.code === "regrouping")!;
    expect(caveat).toEqual({
      code: "regrouping",
      state: "computed",
      seq: 1,
      basis: "same",
      capabilities: 2,
      files: 13,
    });
    expect(timelineCaveatText(caveat)).toBe(
      "Regrouping was computed for this timeline over the 2 capabilities it touches (13 files), not the whole repository, against main's build #1, this map. Main's own next build may still group differently.",
    );
    expect(first.regions![0]).toMatchObject({
      id: search.id,
      provisional: 0,
      proposed: null,
      regrouping: null,
    });
  });

  test("says which capability the timeline would split, and where its files would go", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const { overlayId } = await writeAtlasFixtureOverlay(
      s.env.DB,
      "r1",
      "timeline/plan",
      TIP,
      C1,
      SOURCE,
    );
    // The timeline cuts search in two: its files stop importing across the
    // halves and stop sharing its concept.
    const main = storedGraph(s.sqlite);
    const half = [
      ["cache", "index", "query"],
      ["rank", "store", "tokens"],
    ].map((h) => h.map((n) => `search/${n}`));
    const searchFiles = new Set(half.flat().map(f));
    const timeline: BuiltGraph = {
      ...main,
      edges: [
        ...main.edges.filter((e) => !searchFiles.has(e.src) && !searchFiles.has(e.dst)),
        ...half.flatMap((h) =>
          clique(h).map((e) => ({ ...e, kind: "imports" as const, weight: 1 })),
        ),
      ],
    };
    const changes: KnowledgeOverlayChange[] = [...searchFiles].map((id) => ({
      id,
      kind: "file",
      change: "changed",
      name: id,
      path: id.slice("file:".length),
      summary: "",
      fields: ["blob"],
      links: { added: [], removed: [] },
    }));
    await storeTimelineRegrouping(s.env.DB, "r1", overlayId, { main, timeline }, changes);
    const kept = await readTimelineRegrouping(s.env.DB, "r1", overlayId);
    expect(kept?.data?.neighbourhood).toEqual({
      capabilities: [expect.stringMatching(/^cap:/)],
      files: 6,
    });

    const { first, items } = await all();
    const searchRegion = first.regions!.find((r) => r.regrouping)!;
    expect(searchRegion.regrouping).toEqual({
      change: "split",
      into: [
        expect.objectContaining({ share: 0.5, proposed: true }),
        expect.objectContaining({ share: 0.5, proposed: true }),
      ],
    });
    for (const into of searchRegion.regrouping!.into) expect(into.name).toBeTruthy();
    // The overlay's own records for search's files: each would move.
    const rank = items.find((file) => file.path === "search/rank.ts")!;
    expect(rank.classes).toContain("regrouping");
    expect(rank.regrouping).toMatchObject({ capability: { proposed: true }, moved: true });
    expect(placementText(rank)).toBe(
      `In ${rank.placement.capability!.name}. The timeline's regrouping puts it in a capability main doesn't have, ${rank.regrouping!.capability!.name}.`,
    );
  });

  test("is kept with its overlay: replaced by a newer one, kept by an ended one", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    const first = await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1, SOURCE);
    // A push computes the overlay again, and its regrouping with it.
    const second = await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1, SOURCE);
    expect(s.rows().map((r) => r.overlay_id)).toEqual([second.overlayId]);
    expect(await readTimelineRegrouping(s.env.DB, "r1", first.overlayId)).toBeNull();

    // Ended: a late overlay isn't kept, and neither is a regrouping for it.
    await endAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", "landed");
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C2, "merged");
    await publishAtlasFixture(s.env, "r1", C2);
    const late = await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C2, SOURCE);
    expect(late.stored).toBe(0);
    expect(s.rows()).toEqual([
      { overlay_id: second.overlayId, seq: 1, state: "computed", reason: null },
    ]);
  });

  test("is bounded, and not computing it is said", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    // No map of main yet when the overlay is stored.
    const early = await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1, SOURCE);
    expect(s.rows()).toEqual([
      { overlay_id: early.overlayId, seq: null, state: "skipped", reason: "no-snapshot" },
    ]);
    await publishAtlasFixture(s.env, "r1", C1);
    let page = await atlasApi.timeline(repo, "timeline/plan");
    expect(page.caveats).toContainEqual({
      code: "regrouping",
      state: "skipped",
      reason: "no-snapshot",
    });
    // Without it, a new file is placed by its folder, as an inference.
    expect(page.items.find((file) => file.path === "search/suggest.ts")!.placement.state).toBe(
      "provisional",
    );

    // More capabilities than the bound: not computed.
    const main = storedGraph(s.sqlite);
    const changes: KnowledgeOverlayChange[] = ["search/rank", "billing/ledger/ledger"].map((n) => ({
      id: f(n),
      kind: "file",
      change: "changed",
      name: n,
      path: `${n}.ts`,
      summary: "",
      fields: ["blob"],
      links: { added: [], removed: [] },
    }));
    await storeTimelineRegrouping(
      s.env.DB,
      "r1",
      early.overlayId,
      { main, timeline: main },
      changes,
      { capabilities: 1, files: 100 },
    );
    expect(s.rows()).toEqual([
      { overlay_id: early.overlayId, seq: 1, state: "skipped", reason: "too-large" },
    ]);
    page = await atlasApi.timeline(repo, "timeline/plan");
    const caveat = page.caveats.find((c) => c.code === "regrouping")!;
    expect(caveat).toEqual({ code: "regrouping", state: "skipped", reason: "too-large" });
    expect(timelineCaveatText(caveat)).toMatch(/touches too many capabilities/);
  });

  test("reading a timeline never computes it", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    await publishAtlasFixture(s.env, "r1", C1);
    await writeAtlasFixtureOverlay(s.env.DB, "r1", "timeline/plan", TIP, C1);
    s.sqlite.exec("DELETE FROM atlas_timeline_regroupings");
    const { first } = await all();
    expect(first.caveats).toContainEqual({ code: "regrouping", state: "pending" });
    expect(s.rows()).toEqual([]);
  });
});
