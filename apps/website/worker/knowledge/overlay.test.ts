import { describe, expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { FileAnalysis } from "./analyze.ts";
import { ANALYZER } from "./analyze.ts";
import { applyGraph, buildGraph, saveSnapshot, type SnapshotFile } from "./graph.ts";
import {
  applyChanges,
  computeOverlay,
  overlayFailed,
  diffGraphs,
  diffTrees,
  endOverlays,
  mergeBase,
  overlayRef,
  planOverlay,
  scanOverlays,
  storeOverlay,
  toAnalyze,
  type OverlayState,
} from "./overlay.ts";

const analysis = (over: Partial<FileAnalysis>): FileAnalysis => ({
  language: "typescript",
  role: "source",
  lines: 10,
  summary: "",
  responsibilities: [],
  symbols: [],
  concepts: [],
  imports: [],
  ...over,
});

const commit = (hash: string, parents: string[], at: number, tree = `t-${hash}`) =>
  ({
    hash,
    treeHash: tree,
    message: hash,
    author: { name: "a", email: "a@x" },
    committer: { name: "a", email: "a@x" },
    parents,
    authoredAt: at,
    committedAt: at,
  }) satisfies ArtifactsCommitMetadata;

/** A history reader over a fixed set of commits and trees. */
function history(
  commits: ArtifactsCommitMetadata[],
  trees: Record<string, ArtifactsTreeEntry[]> = {},
) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const reads = { commits: 0, trees: [] as string[] };
  return {
    reads,
    async commit(oid: string) {
      reads.commits++;
      return byHash.get(oid) ?? null;
    },
    async tree(oid: string) {
      reads.trees.push(oid);
      return trees[oid] ?? null;
    },
  };
}

const file = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  hash,
  mode: "100644",
  type: "blob",
});
const dir = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  hash,
  mode: "40000",
  type: "tree",
});

test("overlay refs are timeline bookmarks only", () => {
  expect(overlayRef("timeline/fast-path")).toBe("refs/heads/timeline/fast-path");
  expect(overlayRef("refs/heads/timeline/fast-path")).toBe("refs/heads/timeline/fast-path");
  expect(overlayRef("main")).toBeNull();
  expect(overlayRef("timeline/Bad Slug")).toBeNull();
});

describe("mergeBase", () => {
  // root - m1 - m2 - m3            (main)
  //          \        \
  //           t1 - t2 - t3          (timeline, which merged m3 back in at t3)
  const commits = [
    commit("root", [], 1),
    commit("m1", ["root"], 2),
    commit("t1", ["m1"], 3),
    commit("m2", ["m1"], 4),
    commit("t2", ["t1"], 5),
    commit("m3", ["m2"], 6),
    commit("t3", ["t2", "m3"], 7),
    commit("m4", ["m3"], 8),
    commit("other", [], 9),
  ];

  test("finds the fork point when both lines moved", async () => {
    expect(await mergeBase(history(commits), "t2", "m3")).toEqual({
      base: "m1",
      truncated: false,
    });
  });

  test("moves up when the timeline merged main back in", async () => {
    expect(await mergeBase(history(commits), "t3", "m4")).toEqual({
      base: "m3",
      truncated: false,
    });
  });

  test("is main itself for a timeline that only added commits", async () => {
    expect((await mergeBase(history(commits), "t2", "m1")).base).toBe("m1");
    expect((await mergeBase(history(commits), "m3", "m3")).base).toBe("m3");
  });

  test("reports unrelated and truncated histories", async () => {
    expect(await mergeBase(history(commits), "other", "m4")).toEqual({
      base: null,
      truncated: false,
    });
    expect(await mergeBase(history(commits), "t2", "m4", 2)).toEqual({
      base: null,
      truncated: true,
    });
  });
});

describe("diffTrees", () => {
  const trees = {
    old: [file("README.md", "r1"), dir("src", "src1"), dir("docs", "d1")],
    new: [file("README.md", "r1"), dir("src", "src2"), file("docs", "d-file")],
    src1: [file("a.ts", "a1"), file("b.ts", "b1"), dir("lib", "lib1")],
    src2: [file("a.ts", "a2"), file("c.ts", "c1"), dir("lib", "lib1")],
    lib1: [file("x.ts", "x1")],
    d1: [file("guide.md", "g1")],
  };

  test("lists added, changed and deleted files, skipping equal subtrees", async () => {
    const reader = history([], trees);
    expect(await diffTrees(reader, "old", "new")).toEqual([
      { path: "docs", blob: "d-file", before: null, mode: "100644" },
      { path: "docs/guide.md", blob: null, before: "g1", mode: "100644" },
      { path: "src/a.ts", blob: "a2", before: "a1", mode: "100644" },
      { path: "src/b.ts", blob: null, before: "b1", mode: "100644" },
      { path: "src/c.ts", blob: "c1", before: null, mode: "100644" },
    ]);
    // src/lib is the same tree on both sides: never read.
    expect(reader.reads.trees).not.toContain("lib1");
  });

  test("compares nothing for equal trees", async () => {
    const reader = history([], trees);
    expect(await diffTrees(reader, "old", "old")).toEqual([]);
    expect(reader.reads.trees).toEqual([]);
  });
});

test("applyChanges puts the timeline's files over main's", () => {
  const main: SnapshotFile[] = [
    { path: "a.ts", blob: "a1", mode: "100644" },
    { path: "b.ts", blob: "b1", mode: "100644" },
    { path: "m.ts", blob: "m9", mode: "100644" },
  ];
  expect(
    applyChanges(main, [
      { path: "a.ts", blob: "a2", before: "a1", mode: "100644" },
      { path: "b.ts", blob: null, before: "b1", mode: "100644" },
      { path: "c.ts", blob: "c1", before: null, mode: "100644" },
    ]),
  ).toEqual([
    { path: "a.ts", blob: "a2", mode: "100644" },
    { path: "c.ts", blob: "c1", mode: "100644" },
    // Main's own later work stays.
    { path: "m.ts", blob: "m9", mode: "100644" },
  ]);
});

test("toAnalyze asks only about unknown blobs, with main's blob for reuse", () => {
  const changes = [
    { path: "a.ts", blob: "a2", before: "a0", mode: "100644" },
    { path: "b.ts", blob: "b2", before: null, mode: "100644" },
    { path: "copy.ts", blob: "b2", before: null, mode: "100644" },
    { path: "gone.ts", blob: null, before: "g1", mode: "100644" },
  ];
  const main = [{ path: "a.ts", blob: "a1", mode: "100644" }];
  expect(toAnalyze(changes, main, new Map([["b2", analysis({})]]))).toEqual([
    { path: "a.ts", blob: "a2", previousBlob: "a1" },
  ]);
});

describe("diffGraphs", () => {
  const empty = { components: new Map(), concepts: new Map() };
  const mainFiles: SnapshotFile[] = [
    { path: "src/billing.ts", blob: "bill1", mode: "100644" },
    { path: "src/legacy.ts", blob: "leg1", mode: "100644" },
    { path: "src/util.ts", blob: "util1", mode: "100644" },
  ];
  const analyses = new Map<string, FileAnalysis>([
    [
      "bill1",
      analysis({
        summary: "Bills customers.",
        symbols: [{ name: "charge", kind: "function", line: 3, exported: true }],
        concepts: ["invoice"],
      }),
    ],
    [
      "bill2",
      analysis({
        summary: "Bills customers.",
        // Moved down by an edit above it: not a change to the symbol.
        symbols: [
          { name: "charge", kind: "function", line: 9, exported: true },
          { name: "refund", kind: "function", line: 20, exported: true },
        ],
        concepts: ["invoice", "refund window"],
        imports: ["./ledger"],
      }),
    ],
    ["leg1", analysis({ summary: "Old billing." })],
    ["util1", analysis({ summary: "Helpers." })],
    [
      "ledger1",
      analysis({
        summary: "Keeps the ledger.",
        symbols: [{ name: "Ledger", kind: "class", line: 1, exported: true }],
        concepts: ["refund window"],
      }),
    ],
  ]);
  const timelineFiles = applyChanges(mainFiles, [
    { path: "src/billing.ts", blob: "bill2", before: "bill1", mode: "100644" },
    { path: "src/legacy.ts", blob: null, before: "leg1", mode: "100644" },
    { path: "src/ledger.ts", blob: "ledger1", before: null, mode: "100644" },
  ]);
  const changes = diffGraphs(
    buildGraph("org/app", mainFiles, analyses, empty),
    buildGraph("org/app", timelineFiles, analyses, empty),
  );
  const find = (id: string) => changes.find((c) => c.id === id);

  test("reports the files, symbols and concepts the timeline adds, changes and removes", () => {
    expect(changes.map((c) => [c.change, c.id])).toEqual([
      ["changed", "component:."],
      ["added", "concept:refund-window"],
      ["changed", "file:src/billing.ts"],
      ["added", "file:src/ledger.ts"],
      ["removed", "file:src/legacy.ts"],
      ["added", "sym:src/billing.ts#refund"],
      ["added", "sym:src/ledger.ts#Ledger"],
    ]);
    expect(find("sym:src/billing.ts#charge")).toBeUndefined();
    expect(find("file:src/util.ts")).toBeUndefined();
  });

  test("says what changed on a changed node, links included", () => {
    const billing = find("file:src/billing.ts")!;
    expect(billing.fields).toEqual(["blob", "links"]);
    expect(billing.links.added).toEqual(
      expect.arrayContaining([
        { id: "file:src/ledger.ts", kind: "imports" },
        { id: "sym:src/billing.ts#refund", kind: "defines" },
        { id: "concept:refund-window", kind: "mentions" },
      ]),
    );
    // Same size (one file in, one out), so only its links differ.
    const component = find("component:.")!;
    expect(component.fields).toEqual(["links"]);
    expect(component.links).toEqual({
      added: [{ id: "file:src/ledger.ts", kind: "contains" }],
      removed: [{ id: "file:src/legacy.ts", kind: "contains" }],
    });
  });
  test("adding a work file cannot reorder an unchanged canonical file's topics", () => {
    const main = [{ path: "verify-all.ts", blob: "verify", mode: "100644" }];
    const model = {
      canonical: new Map<string, string>(),
      salient: new Set<string>(),
      trimmed: new Set(["parcel-validation", "batch-processing"]),
      partOf: [] as [string, string][],
    };
    const cards = new Map([
      ["verify", analysis({ concepts: ["Parcel Validation", "Batch Processing"] })],
      ["limits", analysis({ concepts: ["Batch Processing"] })],
      ["verify-next", analysis({ concepts: ["Batch Processing"] })],
    ]);
    const base = buildGraph("org/app", main, cards, empty, model);
    const added = applyChanges(main, [
      { path: "limits.ts", blob: "limits", before: null, mode: "100644" },
    ]);
    const projected = diffGraphs(base, buildGraph("org/app", added, cards, empty, model));
    expect(
      projected
        .filter((change) => change.kind === "file")
        .map(({ id, change }) => ({ id, change })),
    ).toEqual([{ id: "file:limits.ts", change: "added" }]);

    const changed = applyChanges(added, [
      { path: "verify-all.ts", blob: "verify-next", before: "verify", mode: "100644" },
    ]);
    const revised = diffGraphs(base, buildGraph("org/app", changed, cards, empty, model));
    expect(revised.find((change) => change.id === "file:verify-all.ts")?.fields).toContain(
      "topics",
    );
  });
});

describe("stored overlays", () => {
  function setup() {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
      INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('repo', 'm1');
    `);
    const insert = sqlite.prepare(
      `INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data) VALUES (?, ?, 'typescript', ?)`,
    );
    for (const [blob, a] of [
      ["a1", analysis({ summary: "A." })],
      ["a2", analysis({ summary: "A, faster." })],
      ["n1", analysis({ symbols: [{ name: "fresh", kind: "function", line: 1, exported: true }] })],
    ] as const)
      insert.run(blob, ANALYZER, JSON.stringify(a));
    return sqlite;
  }

  test("archiving a work source fences late overlay publication and page completion", async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO timeline_work_sources
        (source_id, repo_id, timeline_id, timeline_slug, owner_id, artifacts_name,
         state, allocation_operation_id, fork_source_id, fork_commit, fork_tree,
         fork_ref, created_at, updated_at, initial_source_id, initial_commit, initial_tree, initial_ref)
      VALUES ('work_one', 'repo', 'timeline-one', 'fast', 'acc', 'owned',
        'ready', 'allocate-one', 'canonical', 'm1', 'tree-main', 'refs/heads/main', 'now', 'now',
        'canonical', 'm1', 'tree-main', 'refs/heads/main');
      INSERT INTO kg_overlays (repo_id, source_id, ref, overlay_id, head_commit, status, attempted_commit)
        VALUES ('repo', 'work_one', 'refs/heads/timeline/fast', 'kept', 't1', 'succeeded', 't1');
      INSERT INTO kg_page_sets (repo_id, source_id, ref, set_key, commit_oid, status, build_id)
        VALUES ('repo', 'work_one', 'refs/heads/timeline/fast', 'checkpoint', 't1', 'writing', 'job');
      INSERT INTO kg_overlays (repo_id, source_id, ref, overlay_id, head_commit, status, attempted_commit)
        VALUES ('repo', 'canonical', 'refs/heads/timeline/fast', 'historical', 'legacy', 'succeeded', 'legacy');
      UPDATE timeline_work_sources SET state = 'archived', archived_at = 'ended', updated_at = 'ended'
        WHERE source_id = 'work_one';
    `);
    await overlayFailed(
      d1(sqlite),
      "repo",
      "refs/heads/timeline/fast",
      "late",
      "late failure",
      "work_one",
    );
    expect(
      sqlite
        .prepare(
          "SELECT overlay_id, head_commit, status, ended_at FROM kg_overlays WHERE source_id = 'work_one'",
        )
        .get(),
    ).toEqual({ overlay_id: "kept", head_commit: "t1", status: "succeeded", ended_at: "ended" });
    expect(sqlite.prepare("SELECT status FROM kg_page_sets").get()).toEqual({ status: "ended" });
    expect(
      sqlite
        .prepare(
          "SELECT overlay_id, head_commit, ended_at FROM kg_overlays WHERE source_id = 'canonical'",
        )
        .get(),
    ).toEqual({ overlay_id: "historical", head_commit: "legacy", ended_at: null });
    await overlayFailed(
      d1(sqlite),
      "repo",
      "refs/heads/timeline/late",
      "late",
      "late failure",
      "work_one",
    );
    for (const ref of ["refs/heads/timeline/fast", "refs/heads/timeline/late"]) {
      const late = await storeOverlay(
        d1(sqlite),
        "repo",
        ref,
        "late-build",
        "late",
        "m1",
        { mergeBase: "m1", historyTruncated: false, changes: [] },
        [
          {
            id: "file:late.ts",
            kind: "file",
            change: "added",
            name: "late.ts",
            path: "late.ts",
            summary: "Unpublished late file",
            fields: [],
            links: { added: [], removed: [] },
          },
        ],
        { sourceId: "work_one" },
      );
      expect(late.kept).toBe(false);
      expect(
        sqlite
          .prepare("SELECT node_id FROM kg_overlay_changes WHERE overlay_id='late-build'")
          .all(),
      ).toEqual([]);
    }
    expect(
      sqlite
        .prepare("SELECT overlay_id,head_commit FROM kg_overlays WHERE source_id='work_one'")
        .get(),
    ).toEqual({ overlay_id: "kept", head_commit: "t1" });
    expect(
      sqlite.prepare("SELECT ref FROM kg_overlays WHERE ref = 'refs/heads/timeline/late'").get(),
    ).toBeUndefined();
  });

  test("owned-source planning uses the explicit fork tree without requiring canonical main objects", async () => {
    const reader = history([commit("work-tip", ["fork"], 2, "work-tree")], {
      "fork-tree": [file("main.ts", "original")],
      "work-tree": [file("main.ts", "original"), file("limits.ts", "work-only")],
    });
    expect(
      await planOverlay(reader, "work-tip", "canonical-new", { commit: "fork", tree: "fork-tree" }),
    ).toEqual({
      base: "canonical-new",
      mergeBase: "fork",
      historyTruncated: false,
      changes: [{ path: "limits.ts", blob: "work-only", before: null, mode: "100644" }],
    });
  });

  test("computeOverlay stores the diff and leaves main's graph alone", async () => {
    const sqlite = setup();
    const db = d1(sqlite);
    const main = [{ path: "a.ts", blob: "a1", mode: "100644" }];
    await saveSnapshot(db, "repo", "current", main);
    await applyGraph(
      db,
      "repo",
      "build",
      "m1",
      buildGraph("org/app", main, new Map([["a1", analysis({ summary: "A." })]]), {
        components: new Map(),
        concepts: new Map(),
      }),
    );
    const mainGraph = () =>
      sqlite.prepare("SELECT id, content_hash FROM kg_nodes ORDER BY id").all();
    const before = mainGraph();
    const ref = "refs/heads/timeline/fast";
    const plan = {
      base: "m1",
      mergeBase: "m1",
      historyTruncated: false,
      changes: [
        { path: "a.ts", blob: "a2", before: "a1", mode: "100644" },
        { path: "n.ts", blob: "n1", before: null, mode: "100644" },
      ],
    };
    const first = await computeOverlay(
      db,
      { id: "repo", full_name: "org/app" },
      ref,
      "o1",
      "t1",
      plan,
      {},
    );
    expect(first.base).toBe("m1");
    expect(first.counts.file).toEqual({ added: 1, changed: 1, removed: 0 });
    expect(first.counts.symbol).toEqual({ added: 1, changed: 0, removed: 0 });
    expect(mainGraph()).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM kg_changes WHERE build_id != 'build'").get(),
    ).toEqual({ n: 0 });

    // The next push replaces the overlay and drops the old changes.
    await computeOverlay(
      db,
      { id: "repo", full_name: "org/app" },
      ref,
      "o2",
      "t2",
      { ...plan, changes: plan.changes.slice(1) },
      {},
    );
    expect(
      sqlite.prepare("SELECT overlay_id, head_commit, base_commit, status FROM kg_overlays").all(),
    ).toEqual([{ overlay_id: "o2", head_commit: "t2", base_commit: "m1", status: "succeeded" }]);
    expect(sqlite.prepare("SELECT DISTINCT overlay_id FROM kg_overlay_changes").all()).toEqual([
      { overlay_id: "o2" },
    ]);
    expect(
      sqlite
        .prepare("SELECT node_id FROM kg_overlay_changes WHERE change = 'changed'")
        .all()
        .map((r) => (r as { node_id: string }).node_id),
    ).not.toContain("file:a.ts");
    expect(mainGraph()).toEqual(before);

    // The bookmark goes: the last overlay stays, read-only, with why it ended.
    const changes = () => sqlite.prepare("SELECT * FROM kg_overlay_changes ORDER BY node_id").all();
    const kept = changes();
    await endOverlays(db, "repo", new Map([[ref, "abandoned"]]));
    expect(
      sqlite.prepare("SELECT overlay_id, head_commit, status, ended_reason FROM kg_overlays").all(),
    ).toEqual([
      { overlay_id: "o2", head_commit: "t2", status: "succeeded", ended_reason: "abandoned" },
    ]);
    expect(changes()).toEqual(kept);
    const row = () => sqlite.prepare("SELECT * FROM kg_overlays").get();
    const ended = row();
    expect((ended as { ended_at: string | null }).ended_at).toBeTruthy();

    // A run that was already under way, or a late failure, changes nothing.
    const late = await computeOverlay(
      db,
      { id: "repo", full_name: "org/app" },
      ref,
      "o3",
      "t3",
      plan,
      {},
    );
    expect(late.stored).toBe(0);
    // Retrying the already-published step after archive must not erase its own rows.
    const replay = await computeOverlay(
      db,
      { id: "repo", full_name: "org/app" },
      ref,
      "o2",
      "t2",
      { ...plan, changes: plan.changes.slice(1) },
      {},
    );
    expect(replay.stored).toBe(0);
    await overlayFailed(db, "repo", ref, "t3", "boom");
    // Ending it again keeps the first answer.
    await endOverlays(db, "repo", new Map([[ref, "ended"]]));
    expect(row()).toEqual(ended);
    expect(changes()).toEqual(kept);
  });

  test("a bookmark that never had an overlay leaves nothing behind", async () => {
    const sqlite = setup();
    const db = d1(sqlite);
    await overlayFailed(db, "repo", "refs/heads/timeline/broken", "t1", "boom");
    await endOverlays(db, "repo", new Map([["refs/heads/timeline/broken", "landed"]]));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM kg_overlays").get()).toEqual({ n: 0 });
  });

  test("planOverlay counts the timeline's changes from the merge base", async () => {
    const reader = history(
      [
        commit("m1", [], 1, "tm1"),
        commit("t1", ["m1"], 2, "tt1"),
        // Main moved on after the fork: not the timeline's change.
        commit("m2", ["m1"], 3, "tm2"),
      ],
      {
        tm1: [file("a.ts", "a1")],
        tt1: [file("a.ts", "a1"), file("n.ts", "n1")],
        tm2: [file("a.ts", "a9")],
      },
    );
    expect(await planOverlay(reader, "t1", "m2")).toEqual({
      base: "m2",
      mergeBase: "m1",
      historyTruncated: false,
      changes: [{ path: "n.ts", blob: "n1", before: null, mode: "100644" }],
    });
  });
});

const idle = (commit: string, base: string | null): OverlayState => ({
  running: null,
  done: { commit, base },
  retries: 0,
  lastError: null,
});
const busy = (commit: string): OverlayState => ({
  running: { buildId: "b", commit, base: "m1", startedAt: 0 },
  done: null,
  retries: 0,
  lastError: null,
});

test("overlays start for bookmarks whose tip or main's graph moved", () => {
  const overlays = {
    "refs/heads/timeline/same": idle("s1", "m1"),
    "refs/heads/timeline/pushed": idle("p1", "m1"),
    "refs/heads/timeline/rebased": idle("r1", "m0"),
  };
  const tips = new Map([
    ["refs/heads/timeline/same", "s1"],
    ["refs/heads/timeline/pushed", "p2"],
    ["refs/heads/timeline/rebased", "r1"],
    ["refs/heads/timeline/new", "n1"],
  ]);
  expect(scanOverlays(overlays, tips, "m1")).toEqual({
    gone: [],
    start: [
      ["refs/heads/timeline/pushed", "p2"],
      ["refs/heads/timeline/rebased", "r1"],
      ["refs/heads/timeline/new", "n1"],
    ],
    deferred: false,
    seen: [],
    wakeAt: null,
  });
});

test("one overlay per timeline, a few per repository, and none before main has a graph", () => {
  const overlays = {
    "refs/heads/timeline/a": busy("a1"),
    "refs/heads/timeline/gone": idle("g1", "m1"),
    "refs/heads/timeline/gone-busy": busy("x1"),
  };
  const tips = new Map([
    ["refs/heads/timeline/a", "a2"],
    ["refs/heads/timeline/b", "b1"],
    ["refs/heads/timeline/c", "c1"],
  ]);
  // `a` is pushed again while running: its end triggers the next scan.
  expect(scanOverlays(overlays, tips, "m1", 3)).toEqual({
    gone: ["refs/heads/timeline/gone"],
    start: [["refs/heads/timeline/b", "b1"]],
    deferred: true,
    seen: [],
    wakeAt: null,
  });
  expect(scanOverlays({}, tips, null)).toEqual({
    gone: [],
    start: [],
    deferred: false,
    seen: [],
    wakeAt: null,
  });
});

test("a pushed timeline waits for its pushes to pause, unless a checkpoint wants it now (CORE-238)", () => {
  const quiet = (now: number, now_refs?: Set<string>) => ({ now, ms: 600_000, now_refs });
  const tips = new Map([
    ["refs/heads/timeline/busy", "b2"],
    ["refs/heads/timeline/rebased", "r1"],
  ]);
  const overlays: Record<string, OverlayState> = {
    "refs/heads/timeline/busy": idle("b1", "m1"),
    // Only main moved under it: no step to wait for.
    "refs/heads/timeline/rebased": idle("r1", "m0"),
  };
  // A new tip is remembered and waited for.
  expect(scanOverlays(overlays, tips, "m1", 3, quiet(1_000))).toEqual({
    gone: [],
    start: [["refs/heads/timeline/rebased", "r1"]],
    deferred: false,
    seen: [["refs/heads/timeline/busy", "b2"]],
    wakeAt: 601_000,
  });
  overlays["refs/heads/timeline/busy"]!.seen = { commit: "b2", at: 1_000 };
  // Still quiet: nothing new to remember, the same wake time.
  expect(scanOverlays(overlays, tips, "m1", 3, quiet(300_000)).wakeAt).toBe(601_000);
  // A checkpoint wants it now.
  expect(
    scanOverlays(overlays, tips, "m1", 3, quiet(300_000, new Set(["refs/heads/timeline/busy"])))
      .start,
  ).toContainEqual(["refs/heads/timeline/busy", "b2"]);
  // The quiet period passed with no newer push: it starts.
  const due = scanOverlays(overlays, tips, "m1", 3, quiet(601_000));
  expect(due.start).toContainEqual(["refs/heads/timeline/busy", "b2"]);
  expect(due.wakeAt).toBeNull();
  // A newer push restarts the wait.
  tips.set("refs/heads/timeline/busy", "b3");
  expect(scanOverlays(overlays, tips, "m1", 3, quiet(601_000))).toMatchObject({
    seen: [["refs/heads/timeline/busy", "b3"]],
    wakeAt: 1_201_000,
  });
});
