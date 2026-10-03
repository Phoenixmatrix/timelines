import { describe, expect, test } from "vite-plus/test";
import { landedBy, walkRange, type HistoryReader } from "./range.ts";

/** Linear first-parent history c{n-1} → … → c0, newest first from any start. */
function history(n: number): HistoryReader & { pages: number } {
  const oids = Array.from({ length: n }, (_, i) => `c${i}`).reverse();
  const reader = {
    pages: 0,
    async commit() {
      return null;
    },
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

/** A commit graph from `name: parents` lines, oldest first; time follows the order. */
function graph(...lines: string[]): HistoryReader & { reads: number } {
  const commits = new Map<string, ArtifactsCommitMetadata>();
  lines.forEach((line, index) => {
    const [hash, parents = ""] = line.split(":").map((part) => part.trim());
    commits.set(hash!, {
      hash: hash!,
      message: hash!,
      parents: parents.split(" ").filter(Boolean),
      committedAt: index,
    } as unknown as ArtifactsCommitMetadata);
  });
  const reader = {
    reads: 0,
    async commit(oid: string) {
      reader.reads++;
      return commits.get(oid) ?? null;
    },
    async log(oid: string, limit: number, offset: number) {
      const line: ArtifactsCommitMetadata[] = [];
      for (let at = commits.get(oid); at; at = commits.get(at.parents[0] ?? "")) line.push(at);
      return line.slice(offset, offset + limit);
    },
  };
  return reader;
}

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
    expect(tagged).toEqual({ commits: [], landings: new Map(), base: "c6", truncated: false });
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

  test("a landing merge brings the timeline's commits, attributed to it", async () => {
    // main: m0 - m1 - L - m3, where L merged timeline t0 - t1 forked at m0.
    const reader = graph("m0", "t0: m0", "m1: m0", "t1: t0", "L: m1 t1", "m3: L");
    const walk = await walkRange(reader, "m3", () => false);
    expect(hashes(walk)).toEqual(["m3", "L", "t1", "t0", "m1", "m0"]);
    expect([...walk.landings]).toEqual([
      ["t1", "L"],
      ["t0", "L"],
    ]);
    expect(walk.truncated).toBe(false);
  });

  test("main merged into a timeline isn't the timeline's work", async () => {
    // The timeline synced with main (s merges m1) before landing.
    const reader = graph("m0", "t0: m0", "m1: m0", "s: t0 m1", "t1: s", "m2: m1", "L: m2 t1");
    expect(hashes(await landedBy(reader, (await reader.commit("L"))!))).toEqual(["t1", "s", "t0"]);
  });

  test("work an earlier landing brought isn't landed again", async () => {
    // Timeline A landed as LA; timeline B merged A and landed later as LB.
    const reader = graph("m0", "a0: m0", "b0: m0", "LA: m0 a0", "b1: b0 a0", "LB: LA b1");
    const walk = await walkRange(reader, "LB", () => false);
    expect(hashes(walk)).toEqual(["LB", "b1", "b0", "LA", "a0", "m0"]);
    expect(walk.landings.get("a0")).toBe("LA");
    expect(walk.landings.get("b0")).toBe("LB");
  });

  test("a release range stops at its base, landing merges and all", async () => {
    const reader = graph("m0", "t0: m0", "v1: m0", "t1: t0", "L: v1 t1");
    const walk = await walkRange(reader, "L", (oid) => oid === "v1", { includeStart: true });
    expect(hashes(walk)).toEqual(["L", "t1", "t0"]);
    expect(walk.base).toBe("v1");
  });

  test("a landing too long to search is reported as truncated", async () => {
    const reader = graph("m0", "t0: m0", "t1: t0", "t2: t1", "t3: t2", "m1: m0", "L: m1 t3");
    const landed = await landedBy(reader, (await reader.commit("L"))!, { max: 2 });
    expect(landed.truncated).toBe(true);
  });
});
