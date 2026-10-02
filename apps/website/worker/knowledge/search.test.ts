import { describe, expect, test } from "vite-plus/test";
import { selectPassages } from "./indexes.ts";

// Scores measured on a real AI Search instance (2026-10-02): the reranker
// scored the throttle.ts chunk 0.112 although vector search ranked it first.
const chunk = (key: string, reranking: number, vector: number) =>
  ({
    id: key,
    type: "text",
    score: reranking,
    text: key,
    item: { key },
    scoring_details: { reranking_score: reranking, vector_score: vector, fusion_method: "rrf" },
  }) as Parameters<typeof selectPassages>[0][number];

describe("search passages", () => {
  test("keeps code the reranker underrates when vector similarity vouches for it", () => {
    const picked = selectPassages([
      chunk("page:components/root", 0.893, 0.548),
      chunk("page:glossary", 0.755, 0.57),
      chunk("file:throttle.ts", 0.112, 0.605),
      chunk("page:architecture", 0.019, 0.32),
      chunk("file:engine.yml", 0.018, 0.566),
      chunk("file:README.md", 0, 0.307),
    ]);
    expect(picked.map((c) => c.item.key)).toEqual([
      "page:components/root",
      "page:glossary",
      "file:throttle.ts",
      "file:engine.yml",
    ]);
  });

  test("returns nothing for an unrelated query, and at most ten passages", () => {
    expect(
      selectPassages([chunk("file:README.md", 0, 0.36), chunk("page:overview", 0, 0.306)]),
    ).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => chunk(`page:${i}`, 0.9, 0.6));
    expect(selectPassages(many)).toHaveLength(10);
  });
});
