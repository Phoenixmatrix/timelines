import { describe, expect, test } from "vite-plus/test";
import type { FileAnalysis, SemanticFeedEntry } from "../../shared/semantic/types.ts";
import { analyzeFile } from "../../shared/semantic/index.ts";
import {
  diffTree,
  parseFeedQuery,
  semanticFeed,
  type AnalysisCache,
  type FeedReader,
} from "./feed.ts";

const oid = (value: number) => value.toString(16).padStart(40, "0");
function fixture() {
  const commits = new Map<string, ArtifactsCommitMetadata>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, string>();
  const analyses = new Map<string, FileAnalysis>();
  let head: string | null = null;
  const cache: AnalysisCache = {
    async get(key) {
      return analyses.get(key);
    },
    async put(key, value) {
      analyses.set(key, value);
    },
  };
  const reader: FeedReader = {
    async resolve() {
      return head;
    },
    async commit(hash) {
      return commits.get(hash) ?? null;
    },
    async tree(hash) {
      return trees.get(hash) ?? null;
    },
    async blobLimited(hash) {
      const source = blobs.get(hash);
      if (source === undefined) return null;
      const bytes = new TextEncoder().encode(source);
      return { bytes, size: bytes.length };
    },
  };
  function add(number: number, files: Record<string, string>, parents: string[] = []) {
    const hash = oid(number);
    const treeHash = oid(number + 100);
    const entries: ArtifactsTreeEntry[] = [];
    for (const [name, source] of Object.entries(files)) {
      const blobHash = oid(number * 1000 + entries.length);
      blobs.set(blobHash, source);
      entries.push({ name, hash: blobHash, type: "blob", mode: "100644" });
    }
    trees.set(treeHash, entries);
    commits.set(hash, {
      hash,
      treeHash,
      parents,
      message: `commit ${number}`,
      author: { name: "Author", email: "author@example.test" },
      committer: { name: "Author", email: "author@example.test" },
      authoredAt: 1,
      committedAt: 1,
    });
    head = hash;
    return hash;
  }
  return { reader, cache, add, commits, trees, blobs };
}

describe("semantic repository feed", () => {
  test("pages individual changes without duplicates and pins history across pushes", async () => {
    const f = fixture();
    const source = '{"alpha":1,"beta":2,"gamma":3}';
    const first = f.add(1, { "config.json": source });
    const expected = analyzeFile("config.json", null, source).changes;
    expect(expected.some((change) => change.name.includes("alpha"))).toBe(true);
    const query = parseFeedQuery({ limit: "1" });
    let page = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", query);
    const entries: SemanticFeedEntry[] = [...page.entries];
    f.add(2, { "pushed.json": '{"pushed":true}' }, [first]);
    for (let count = 0; page.nextCursor && count < 30; count++) {
      page = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", {
        ...query,
        cursor: page.nextCursor,
      });
      expect(page.head).toBe(first);
      entries.push(...page.entries);
    }
    expect(page.nextCursor).toBeNull();
    expect(entries.map((entry) => entry.id)).toEqual(
      expected.map((change) => `${first}:config.json:${change.id}`),
    );
    expect(
      entries.every(
        (entry) =>
          entry.commit.oid === first &&
          entry.links.before === null &&
          entry.links.after?.includes(`/blob/${first}/config.json#L`),
      ),
    ).toBe(true);
  });

  test("binds cursors to the repository and exact filters", async () => {
    const f = fixture();
    f.add(1, { "config.json": '{"alpha":1,"beta":2}' });
    const query = parseFeedQuery({ limit: "1" });
    const page = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", query);
    expect(page.nextCursor).not.toBeNull();
    await expect(
      semanticFeed(f.reader, f.cache, "other", "/owner/other", {
        ...query,
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow("Invalid cursor");
    await expect(
      semanticFeed(f.reader, f.cache, "repo", "/owner/repo", {
        ...query,
        language: "rust",
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow("Invalid cursor");
  });

  test("returns resumable empty pages and coverage rather than dropping unsupported files", async () => {
    const f = fixture();
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`file${index}.unknown`, "source"]),
    );
    f.add(1, files);
    const query = parseFeedQuery({ language: "rust" });
    const first = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", query);
    expect(first.entries).toEqual([]);
    expect(first.coverage.map((item) => item.status)).toEqual(Array(8).fill("unsupported"));
    expect(first.nextCursor).not.toBeNull();
    const second = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", {
      ...query,
      cursor: first.nextCursor!,
    });
    expect(second.nextCursor).toBeNull();
    expect([...first.coverage, ...second.coverage].map((item) => item.path).sort()).toEqual(
      Object.keys(files).sort(),
    );
  });

  test("walks only the first parent of merges", async () => {
    const f = fixture();
    const first = f.add(1, { "one.unknown": "first" });
    const second = f.add(2, { "two.unknown": "second" });
    const merge = f.add(3, { "merge.unknown": "merge" }, [first, second]);
    const page = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", parseFeedQuery({}));
    expect([...new Set(page.coverage.map((item) => item.commit))]).toEqual([merge, first]);
  });

  test("reports oversized and binary content and fails on missing objects", async () => {
    const f = fixture();
    f.add(1, { "large.json": "x".repeat(262145), "binary.json": "\0", "invalid.json": "{" });
    const page = await semanticFeed(f.reader, f.cache, "repo", "/owner/repo", parseFeedQuery({}));
    expect(Object.fromEntries(page.coverage.map((item) => [item.path, item.status]))).toEqual({
      "large.json": "too_large",
      "binary.json": "binary",
      "invalid.json": "parse_error",
    });
    const broken = fixture();
    broken.add(1, { "missing.json": "{}" });
    broken.blobs.clear();
    await expect(
      semanticFeed(broken.reader, broken.cache, "repo", "/owner/repo", parseFeedQuery({})),
    ).rejects.toThrow("Missing Git blob");
  });

  test("retains removed files when replaced by directories, and skips identical subtrees", () => {
    const before: ArtifactsTreeEntry[] = [
      { name: "same", type: "tree", mode: "40000", hash: oid(1) },
      { name: "replaced", type: "blob", mode: "100644", hash: oid(2) },
    ];
    const after: ArtifactsTreeEntry[] = [
      { name: "same", type: "tree", mode: "40000", hash: oid(1) },
      { name: "replaced", type: "tree", mode: "40000", hash: oid(3) },
    ];
    expect(
      diffTree(before, after, "src").map((task) => ({
        path: task.path,
        tree: task.tree,
        before: task.before?.hash,
        after: task.after?.hash,
      })),
    ).toEqual([
      { path: "src/replaced", tree: false, before: oid(2), after: undefined },
      { path: "src/replaced", tree: true, before: undefined, after: oid(3) },
    ]);
  });
});
