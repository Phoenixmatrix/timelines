import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { FileAnalysis } from "./analyze.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { applyGraph, buildGraph, conceptKey, planComponents } from "./graph.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));

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

describe("planComponents", () => {
  test("keeps small directories whole", () => {
    expect(planComponents(["src/a.ts", "src/b.ts", "README.md"])).toEqual([
      { id: "component:.", dir: "", files: ["README.md", "src/a.ts", "src/b.ts"], loose: false },
    ]);
  });

  test("splits big directories by subdirectory, with loose files on their own", () => {
    const files = [
      ...Array.from({ length: 12 }, (_, i) => `app/web/f${i}.ts`),
      ...Array.from({ length: 10 }, (_, i) => `app/cli/f${i}.rs`),
      "app/README.md",
    ];
    const plans = planComponents(files);
    expect(plans.map((p) => [p.id, p.files.length])).toEqual([
      ["component:app/*", 1],
      ["component:app/cli", 10],
      ["component:app/web", 12],
    ]);
  });
});

test("concept keys ignore case, punctuation and plurals", () => {
  expect(conceptKey("Personal Access Tokens")).toBe(conceptKey("personal access token"));
  expect(conceptKey("Git Smart-HTTP")).toBe("git-smart-http");
});

test("buildGraph links files, symbols, packages, concepts and components", () => {
  const files = [
    { path: "src/a.ts", blob: "a1", mode: "100644" },
    { path: "src/b.ts", blob: "b1", mode: "100644" },
    { path: "pnpm-lock.yaml", blob: "l1", mode: "100644" },
  ];
  const analyses = new Map([
    [
      "a1",
      analysis({
        imports: ["./b.ts", "hono"],
        concepts: ["Git Proxy"],
        symbols: [{ name: "run", kind: "function", line: 1, exported: true }],
      }),
    ],
    ["b1", analysis({ concepts: ["git proxies"] })],
    ["l1", analysis({ language: "yaml", skipped: "lockfile" })],
  ]);
  const graph = buildGraph("orbit/demo", files, analyses, {
    components: new Map(),
    concepts: new Map(),
  });
  const edge = (src: string, dst: string, kind: string) =>
    graph.edges.some((e) => e.src === src && e.dst === dst && e.kind === kind);
  expect(edge("file:src/a.ts", "file:src/b.ts", "imports")).toBe(true);
  expect(edge("file:src/a.ts", "pkg:npm:hono", "imports")).toBe(true);
  expect(edge("file:src/a.ts", "sym:src/a.ts#run", "defines")).toBe(true);
  // Both spellings land on one concept.
  expect(graph.nodes.filter((n) => n.kind === "concept")).toHaveLength(1);
  expect(graph.conceptFiles.get(conceptKey("Git Proxy"))).toEqual(["src/a.ts", "src/b.ts"]);
  // The lockfile is a file node but belongs to no component.
  expect(graph.components.flatMap((c) => c.files)).toEqual(["src/a.ts", "src/b.ts"]);
});

test("applyGraph moves the graph version only when the stored graph changes", async () => {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`
    BEGIN;
    INSERT INTO organizations (id,slug,display_name,kind,default_space_id) VALUES ('org','org','Org','company','acc');
    INSERT INTO spaces (id,organization_id,slug,display_name) VALUES ('acc','org','org','Org');
    COMMIT;
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const version = () =>
    (
      sqlite.prepare("SELECT graph_at FROM kg_state WHERE repo_id = 'repo'").get() as
        | { graph_at: string | null }
        | undefined
    )?.graph_at ?? null;
  const graphOf = (files: string[]) =>
    buildGraph(
      "org/app",
      files.map((path) => ({ path, blob: path, mode: "100644" })),
      new Map(files.map((path) => [path, analysis({})])),
      { components: new Map(), concepts: new Map() },
    );

  await applyGraph(d1(sqlite), "repo", "b1", "c1", graphOf(["src/a.ts"]));
  const first = version();
  expect(first).not.toBeNull();
  // No build has finished, but the graph is there to show.
  expect(sqlite.prepare("SELECT indexed_commit FROM kg_state").get()).toEqual({
    indexed_commit: null,
  });

  sqlite.exec("UPDATE kg_state SET graph_at = 'unchanged'");
  await applyGraph(d1(sqlite), "repo", "b2", "c1", graphOf(["src/a.ts"]));
  expect(version()).toBe("unchanged");

  await applyGraph(d1(sqlite), "repo", "b3", "c2", graphOf(["src/a.ts", "src/b.ts"]));
  expect(version()).not.toBe("unchanged");
});
