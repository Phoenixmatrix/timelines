import { describe, expect, test } from "vite-plus/test";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import type { FileAnalysis } from "./analyze.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  alignPairs,
  cluster,
  mutualNeighbours,
  pairKey,
  partOfLinks,
  tokenCandidates,
  type ConceptModel,
  type Decision,
} from "./concepts.ts";
import { buildGraph } from "./graph.ts";

const decisions = (entries: [string, string, number, number?, number?][]) =>
  new Map<string, Decision>(
    entries.map(([a, b, score, aInB = 0, bInA = 0]) => [
      pairKey(a, b),
      a < b ? { score, aInB, bInA } : { score, aInB: bInA, bInA: aInB },
    ]),
  );

describe("tokenCandidates", () => {
  test("pairs names that share an uncommon word, or nest", () => {
    const names = new Map([
      ["dev-persona", "Dev Personas"],
      ["development-persona", "Development Personas"],
      ["cloudflare-d1", "Cloudflare D1"],
      ["d1-database", "D1 Database"],
      ["theme", "Theme"],
      ["theme-switching", "Theme Switching"],
      ["exit-code", "Exit Codes"],
    ]);
    const pairs = tokenCandidates(names).map(([a, b]) => pairKey(a, b));
    expect(pairs).toContain(pairKey("dev-persona", "development-persona"));
    expect(pairs).toContain(pairKey("cloudflare-d1", "d1-database"));
    expect(pairs).toContain(pairKey("theme", "theme-switching"));
    expect(pairs.some((p) => p.includes("exit-code"))).toBe(false);
  });

  test("keeps only each concept's closest candidates, nesting first", () => {
    // Eight names share the uncommon word "artifact": 28 pairs among them alone.
    const words = ["Build", "Blob", "Cache", "Token", "Upload", "Mirror", "Digest"];
    const names = new Map<string, string>([
      ["artifact-registry", "Artifact Registry"],
      ["registry", "Registry"],
      ...words.map((w) => [`artifact-${w.toLowerCase()}`, `Artifact ${w}`] as [string, string]),
    ]);
    const uncapped = tokenCandidates(names, 100);
    const capped = tokenCandidates(names, 2);
    expect(uncapped.length).toBe(29);
    // Each concept contributes at most its two closest.
    expect(capped.length).toBeLessThanOrEqual(2 * names.size);
    // Given newcomers, only their own closest count.
    const fresh = tokenCandidates(names, 2, new Set(["artifact-registry"]));
    expect(fresh.length).toBe(2);
    expect(fresh.every((p) => p.includes("artifact-registry"))).toBe(true);
    // Nesting outranks shared words: with room for one, "Artifact Registry"
    // keeps the name it is made of.
    expect(tokenCandidates(names, 1).map(([a, b]) => pairKey(a, b))).toContain(
      pairKey("artifact-registry", "registry"),
    );
  });
});

test("mutualNeighbours keeps only pairs that pick each other", () => {
  const keys = ["a", "b", "c"];
  const vectors = [
    [1, 0],
    [0.9, 0.1],
    [0, 1],
  ];
  expect(mutualNeighbours(keys, vectors, 1)).toEqual([["a", "b"]]);
});

describe("cluster", () => {
  const files = new Map([
    ["d1-database", 2],
    ["cloudflare-d1", 1],
    ["cloudflare-d1-database", 1],
    ["cloudflare-worker", 4],
  ]);

  test("merges the same concept under the most mentioned key", () => {
    const canonical = cluster(
      [...files.keys()],
      files,
      decisions([
        ["cloudflare-d1", "d1-database", 1.7],
        ["cloudflare-d1", "cloudflare-d1-database", 1.8],
      ]),
      new Map(),
    );
    expect(canonical.get("cloudflare-d1")).toBe("d1-database");
    expect(canonical.get("cloudflare-d1-database")).toBe("d1-database");
    expect(canonical.get("cloudflare-worker")).toBe("cloudflare-worker");
  });

  test("never chains into a group holding a concept judged different", () => {
    const canonical = cluster(
      ["a", "b", "c"],
      new Map(),
      decisions([
        ["a", "b", 1.9],
        ["b", "c", 1.6],
        ["a", "c", 0.2],
      ]),
      new Map(),
    );
    expect(canonical.get("a")).toBe(canonical.get("b"));
    expect(canonical.get("c")).toBe("c");
  });

  test("keeps the canonical key a group already had", () => {
    const canonical = cluster(
      ["d1-database", "cloudflare-d1"],
      files,
      decisions([["cloudflare-d1", "d1-database", 1.7]]),
      new Map([
        ["d1-database", "cloudflare-d1"],
        ["cloudflare-d1", "cloudflare-d1"],
      ]),
    );
    expect(canonical.get("d1-database")).toBe("cloudflare-d1");
  });
});

test("partOfLinks keeps clear directions between groups", () => {
  const canonical = new Map([
    ["token-revocation", "token-revocation"],
    ["access-token", "access-token"],
    ["personal-access-token", "access-token"],
    ["hono", "hono"],
    ["hono-server", "hono-server"],
  ]);
  const links = partOfLinks(
    decisions([
      ["token-revocation", "personal-access-token", 1.1, 0.9, 0.05],
      ["hono", "hono-server", 1.2, 0.5, 0.5],
      ["access-token", "hono", 0.3, 0.9, 0],
    ]),
    canonical,
  );
  expect(links).toEqual([["token-revocation", "access-token"]]);
});

const analysis = (concepts: string[]): FileAnalysis => ({
  language: "typescript",
  role: "source",
  lines: 10,
  summary: "",
  responsibilities: [],
  symbols: [],
  concepts,
  imports: [],
});

test("buildGraph merges aliases, links part_of and turns trimmed concepts into topics", () => {
  const files = [
    { path: "a.ts", blob: "a", mode: "100644" },
    { path: "b.ts", blob: "b", mode: "100644" },
  ];
  const analyses = new Map([
    ["a", analysis(["Cloudflare D1", "Token Revocation", "Grapheme Segmentation"])],
    ["b", analysis(["D1 Database", "Access Tokens"])],
  ]);
  const model: ConceptModel = {
    canonical: new Map([["cloudflare-d1", "d1-database"]]),
    salient: new Set(["d1-database", "access-token", "token-revocation"]),
    trimmed: new Set(["grapheme-segmentation"]),
    partOf: [["token-revocation", "access-token"]],
  };
  const graph = buildGraph(
    "orbit/demo",
    files,
    analyses,
    { components: new Map(), concepts: new Map() },
    model,
  );
  const concepts = graph.nodes.filter((n) => n.kind === "concept");
  expect(concepts.map((n) => n.id).sort()).toEqual([
    "concept:access-token",
    "concept:d1-database",
    "concept:token-revocation",
  ]);
  const d1 = concepts.find((n) => n.id === "concept:d1-database");
  expect(d1?.data).toMatchObject({ files: 2, aliases: ["Cloudflare D1"], salient: true });
  expect(graph.conceptFiles.get("d1-database")).toEqual(["a.ts", "b.ts"]);
  expect(
    graph.edges.some(
      (e) =>
        e.kind === "part_of" &&
        e.src === "concept:token-revocation" &&
        e.dst === "concept:access-token",
    ),
  ).toBe(true);
  expect(graph.nodes.find((n) => n.id === "file:a.ts")?.data.topics).toEqual([
    "Grapheme Segmentation",
  ]);
});

test("alignPairs counts stored pair decisions only, not reviews", async () => {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
    INSERT INTO kg_concept_reviews (repo_id, a, b, score, inputs_hash)
      VALUES ('repo', 'billing', 'invoice', 0, 'h');
  `);
  const AI = {
    // Small repositories also embed names; orthogonal vectors pair nothing.
    run: async (_model: string, inputs: { text?: string[] }) =>
      inputs.text
        ? { data: inputs.text.map((_, i) => inputs.text!.map((__, j) => (i === j ? 1 : 0))) }
        : {
            answers: {
              link: { type: "score", score: 0, probabilities: [1, 0, 0], confidence: 1 },
              a_in_b: { type: "noul", noul: 0 },
              b_in_a: { type: "noul", noul: 0 },
            },
          },
  };
  const env = { DB: d1(sqlite), AI } as unknown as Env;
  const files = [{ path: "src/a.ts", blob: "a1", mode: "100644" }];
  const analyses = new Map([
    ["a1", { concepts: ["Theme", "Theme Switching"], skipped: undefined } as never],
  ]);
  const stats = await alignPairs(env, LEGACY_AI_SNAPSHOT.models, "repo", files, analyses);
  expect(stats.asked).toBe(1);
  // One stored first-pass decision; the review-only pair must not read as asked.
  expect(stats.decided).toBe(1);
});

test("alignPairs decides what a newcomer changes in its neighbours' closest candidates (CORE-286)", async () => {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const asked: string[] = [];
  const AI = {
    // Orthogonal name vectors pair nothing by embedding.
    run: async (
      _model: string,
      inputs: { text?: string[]; state?: Record<string, { name: string }> },
    ) => {
      if (inputs.text)
        return { data: inputs.text.map((_, i) => inputs.text!.map((__, j) => (i === j ? 1 : 0))) };
      asked.push(pairKey(inputs.state!.entity_a!.name, inputs.state!.entity_b!.name));
      return {
        answers: {
          link: { type: "score", score: 0, probabilities: [1, 0, 0], confidence: 1 },
          a_in_b: { type: "noul", noul: 0 },
          b_in_a: { type: "noul", noul: 0 },
        },
      };
    },
  };
  const env = { DB: d1(sqlite), AI } as unknown as Env;
  const stores = ["Token Store", "Session Store", "Blob Store", "Key Store", "Cache Store"];
  const file = (path: string, concepts: string[]) => ({
    file: { path, blob: path, mode: "100644" },
    analysis: { concepts, skipped: undefined } as never,
  });
  const before = stores.map((name, i) => file(`src/${i}.ts`, [name]));
  const run = async (entries: ReturnType<typeof file>[]) =>
    alignPairs(
      env,
      LEGACY_AI_SNAPSHOT.models,
      "repo",
      entries.map((e) => e.file),
      new Map(entries.map((e) => [e.file.blob, e.analysis])),
    );
  await run(before);
  // Settled: these concepts are known now.
  for (const name of stores)
    sqlite
      .prepare("INSERT INTO kg_concepts (repo_id, key, canonical) VALUES ('repo', ?, ?)")
      .run(name.toLowerCase().replace(" ", "-"), name.toLowerCase().replace(" ", "-"));
  asked.length = 0;
  // "Store" nests in all five; it keeps only four of them as its own closest,
  // but it is among the closest of the fifth too.
  await run([...before, file("src/new.ts", ["Store"])]);
  const names = new Map(
    [...stores, "Store"].map((n) => [n.toLowerCase().replace(" ", "-"), n] as [string, string]),
  );
  const own = tokenCandidates(names, 4, new Set(["store"]));
  expect(own.length).toBe(4);
  // Every pair with the newcomer is decided, the fifth too: what a full rebuild decides.
  expect(asked.length).toBe(5);
  expect(asked.every((p) => p.includes("Store\u0000") || p.endsWith("\u0000Store"))).toBe(true);
});
