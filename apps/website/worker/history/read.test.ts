import { describe, expect, test } from "vite-plus/test";
import { HISTORY_PAGE_SIZE, readHistory } from "./read.ts";

const author = { name: "Dev", email: "dev@example.test" };
const file = (name: string, hash: string, mode = "100644"): ArtifactsTreeEntry => ({
  name,
  hash,
  mode,
  type: mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob",
});
const folder = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  hash,
  mode: "040000",
  type: "tree",
});
function fixture(trees: Record<string, ArtifactsTreeEntry[]>, roots: string[]) {
  const commits = roots.map((treeHash, n): ArtifactsCommitMetadata => ({
    hash: `c${n}`,
    treeHash,
    message: `Change ${n}`,
    author,
    committer: author,
    authoredAt: n,
    committedAt: n,
    parents: n ? [`c${n - 1}`] : [],
  }));
  let reads = 0;
  const reader = {
    async commit(oid: string) {
      return commits.find((c) => c.hash === oid) ?? null;
    },
    async log(oid: string, limit: number, offset: number) {
      const i = commits.findIndex((c) => c.hash === oid);
      return commits
        .slice(0, i + 1)
        .reverse()
        .slice(offset, offset + limit);
    },
    async tree(oid: string) {
      reads++;
      return trees[oid] ?? null;
    },
    async treeAt(root: string, path: string): Promise<string | null> {
      if (!path) return root;
      const entry = await reader.entryAt(root, path);
      return entry?.type === "tree" ? entry.hash : null;
    },
    async entryAt(root: string, path: string): Promise<ArtifactsTreeEntry | null> {
      const [name, ...rest] = path.split("/");
      const entry = trees[root]?.find((e) => e.name === name) ?? null;
      return rest.length
        ? entry?.type === "tree"
          ? reader.entryAt(entry.hash, rest.join("/"))
          : null
        : entry;
    },
  };
  return { reader, commits, reads: () => reads };
}

describe("repository file history", () => {
  test("counts actual changes per entry and scope, not every repository commit", async () => {
    const { reader } = fixture(
      {
        a: [file("readme", "1"), folder("src", "s1")],
        b: [file("readme", "2"), folder("src", "s1")],
        c: [file("readme", "2"), folder("src", "s2")],
        s1: [file("app", "a")],
        s2: [file("app", "b")],
      },
      ["a", "b", "c", "c"],
    );
    const root = await readHistory(reader, "c3", "", true);
    expect(root.commits).toHaveLength(4);
    expect(root.entries.readme).toMatchObject({ count: 2, latest: { oid: "c1" } });
    expect(root.entries.src).toMatchObject({ count: 2, latest: { oid: "c2" } });
    const nested = await readHistory(reader, "c3", "src", true);
    expect(nested.commits.map((c) => c.oid)).toEqual(["c2", "c0"]);
    expect(nested.entries["src/app"]).toMatchObject({ count: 2, latest: { oid: "c2" } });
    const blob = await readHistory(reader, "c3", "readme", false);
    expect(blob.commits.map((c) => c.oid)).toEqual(["c1", "c0"]);
    expect(blob.next).toBeNull();
  });
  test("includes deletion, re-addition, mode changes and symlinks", async () => {
    const { reader } = fixture(
      {
        a: [file("file", "same")],
        b: [file("file", "same", "100755")],
        c: [],
        d: [file("file", "target", "120000")],
      },
      ["a", "b", "c", "d"],
    );
    const result = await readHistory(reader, "c3", "file", false);
    expect(result.commits.map((c) => c.oid)).toEqual(["c3", "c2", "c1", "c0"]);
  });
  test("follows the first parent of a merge, even if its timestamp is older", async () => {
    const { reader, commits } = fixture({ a: [file("f", "1")], b: [file("f", "2")] }, ["a", "b"]);
    commits[1]!.parents.push("side-branch");
    commits[1]!.authoredAt = -10;
    expect((await readHistory(reader, "c1", "f", false)).commits.map((c) => c.oid)).toEqual([
      "c1",
      "c0",
    ]);
  });
  test("pages through old changes without losing the boundary comparison", async () => {
    const { reader } = fixture({ a: [file("old", "one")], b: [file("old", "two")] }, [
      ...Array(HISTORY_PAGE_SIZE).fill("a"),
      "b",
    ]);
    const page = await readHistory(reader, `c${HISTORY_PAGE_SIZE}`, "old", false);
    expect(page.scanned).toBe(HISTORY_PAGE_SIZE);
    expect(page.next).toBe("c0");
    expect(page.commits.map((c) => c.oid)).toEqual([`c${HISTORY_PAGE_SIZE}`]);
    const rest = await readHistory(reader, `c${HISTORY_PAGE_SIZE}`, "old", false, page.next!);
    expect(rest.commits.map((c) => c.oid)).toEqual(["c0"]);
    expect(rest.next).toBeNull();
  });
  test("reports absent paths without claiming the tip changed them; renames start a new path", async () => {
    const { reader } = fixture({ a: [file("before", "same")], b: [file("after", "same")] }, [
      "a",
      "b",
    ]);
    expect((await readHistory(reader, "c1", "after", false)).commits.map((c) => c.oid)).toEqual([
      "c1",
    ]);
    expect((await readHistory(reader, "c1", "missing", false)).commits).toEqual([]);
    expect((await readHistory(reader, "c1", "before", false)).commits.map((c) => c.oid)).toEqual([
      "c1",
      "c0",
    ]);
  });
  test("handles special filenames and shares tree reads across unchanged commits", async () => {
    const f = fixture(
      { a: [file("__proto__", "1"), file("constructor", "2")] },
      Array(20).fill("a"),
    );
    const result = await readHistory(f.reader, "c19", "", true);
    expect(JSON.parse(JSON.stringify(result.entries)).__proto__.count).toBe(1);
    expect(result.entries.constructor).toMatchObject({ count: 1 });
    expect(f.reads()).toBeLessThanOrEqual(2);
  });
  test("fails explicitly if a parent object is missing", async () => {
    const { reader, commits } = fixture({ a: [] }, ["a"]);
    commits[0]!.parents = ["missing"];
    await expect(readHistory(reader, "c0", "file", false)).rejects.toThrow(
      "parent commit is unavailable",
    );
  });
});
