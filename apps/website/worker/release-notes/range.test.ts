import { describe, expect, test } from "vite-plus/test";
import { walkRange, type HistoryReader } from "./range.ts";

/** Linear first-parent history c{n-1} → … → c0, newest first from any start. */
function history(n: number): HistoryReader & { pages: number } {
  const oids = Array.from({ length: n }, (_, i) => `c${i}`).reverse();
  const reader = {
    pages: 0,
    async log(oid: string, limit: number, offset: number) {
      reader.pages++;
      const start = oids.indexOf(oid);
      return oids.slice(start + offset, start + offset + limit).map(
        (hash) =>
          ({
            hash,
            message: hash,
            author: { name: "A", email: "a@example.com" },
            authoredAt: 0,
            parents: [],
          }) as unknown as ArtifactsCommitMetadata,
      );
    },
  };
  return reader;
}
const hashes = (walk: { commits: ArtifactsCommitMetadata[] }) => walk.commits.map((c) => c.hash);

describe("release ranges", () => {
  test("tag to previous tag includes the tagged commit and stops before the base", async () => {
    const tags = new Set(["c9", "c5"]);
    const walk = await walkRange(history(10), "c9", (oid) => tags.has(oid), {
      includeStart: true,
    });
    expect(hashes(walk)).toEqual(["c9", "c8", "c7", "c6"]);
    expect(walk).toMatchObject({ base: "c5", truncated: false });
  });

  test("unreleased work stops at the newest tag, and is empty when head is tagged", async () => {
    const tags = new Set(["c6"]);
    const unreleased = await walkRange(history(10), "c9", (oid) => tags.has(oid));
    expect(hashes(unreleased)).toEqual(["c9", "c8", "c7"]);
    expect(unreleased.base).toBe("c6");
    const tagged = await walkRange(history(10), "c6", (oid) => tags.has(oid));
    expect(tagged).toEqual({ commits: [], base: "c6", truncated: false });
  });

  test("without a previous tag the range reaches the root across pages", async () => {
    const reader = history(250);
    const walk = await walkRange(reader, "c249", () => false, { includeStart: true });
    expect(walk.commits).toHaveLength(250);
    expect(walk).toMatchObject({ base: null, truncated: false });
    expect(reader.pages).toBe(3);
  });

  test("a base outside reach is reported as truncated at the limit", async () => {
    const walk = await walkRange(history(50), "c49", (oid) => oid === "elsewhere", { max: 20 });
    expect(walk.commits).toHaveLength(20);
    expect(walk).toMatchObject({ base: null, truncated: true });
  });
});
