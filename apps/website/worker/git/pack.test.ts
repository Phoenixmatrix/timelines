import { describe, expect, test } from "vite-plus/test";
import { buildPack, commitBody, makeDelta, objectId } from "../testing/pack.ts";
import { packCommits, parseCommitHeaders } from "./pack.ts";

const encoder = new TextEncoder();

/** Text that doesn't compress, so cutting a pack's tail cuts into its object. */
const noise = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes / 2))).toString("hex");

describe("packCommits", () => {
  test("reads each commit's id, parents and change id, skipping other objects", async () => {
    const root = commitBody({ changeId: "zzzzkkkk", message: "Root" });
    const rootId = objectId("commit", root);
    const child = commitBody({ parents: [rootId], changeId: "yyyykkkk", message: "Child" });
    const plain = commitBody({ parents: [rootId], message: "Plain git" });
    const pack = buildPack([
      { type: "commit", body: child },
      { type: "tree", body: new Uint8Array(0) },
      { type: "blob", body: encoder.encode("hello\n") },
      { type: "commit", body: root },
      { type: "commit", body: plain },
    ]);
    expect(await packCommits(pack)).toEqual([
      { oid: objectId("commit", child), parents: [rootId], changeId: "yyyykkkk" },
      { oid: rootId, parents: [], changeId: "zzzzkkkk" },
      { oid: objectId("commit", plain), parents: [rootId], changeId: null },
    ]);
  });

  test("resolves commits stored as deltas, by offset and by id", async () => {
    const base = commitBody({ changeId: "zzzzkkkk", message: "First version" });
    const baseId = objectId("commit", base);
    const second = commitBody({ changeId: "zzzzkkkk", message: "Second version, reworded" });
    const third = commitBody({ changeId: "zzzzkkkk", message: "Third version" });
    const pack = buildPack([
      { type: "commit", body: base },
      { type: "ofs-delta", base: 0, delta: makeDelta(base, second) },
      { type: "ref-delta", base: baseId, delta: makeDelta(base, third) },
      // A delta against something that isn't a commit in the pack is skipped.
      { type: "ref-delta", base: "f".repeat(40), delta: makeDelta(base, third) },
    ]);
    expect((await packCommits(pack)).map((c) => c.oid)).toEqual([
      baseId,
      objectId("commit", second),
      objectId("commit", third),
    ]);
  });

  test("a pack cut short yields the commits before the cut", async () => {
    const first = commitBody({ changeId: "zzzzkkkk", message: "First" });
    const pack = buildPack([
      { type: "commit", body: first },
      { type: "commit", body: commitBody({ changeId: "yyyykkkk", message: noise(4000) }) },
    ]);
    const commits = await packCommits(pack.subarray(0, pack.length - 200));
    expect(commits.map((c) => c.changeId)).toEqual(["zzzzkkkk"]);
  });

  test("rejects what isn't a pack", async () => {
    await expect(packCommits(encoder.encode("not a pack at all"))).rejects.toThrow(/pack/);
  });
});

test("commit headers stop at the message", () => {
  const body = encoder.encode(
    "tree t\nparent a\nparent b\nchange-id kkkk\n\nchange-id in the message\n",
  );
  expect(parseCommitHeaders(body)).toEqual({ parents: ["a", "b"], changeId: "kkkk" });
});
