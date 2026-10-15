import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import type { HistoryPage } from "../../shared/api.ts";
import {
  CHANGES,
  commitSummary,
  derivedId,
  HISTORY_PAGE_SIZE,
  LAST_CHANGES,
  readHistory,
  type HistoryRead,
} from "./read.ts";

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
  // The derived-data caches, serialized as the Cache API would.
  const derived = new Map<string, string>();
  const stores: string[] = [];
  const recall = <T>(kind: string, id: string): T | undefined => {
    const value = derived.get(`${kind}/${id}`);
    return value === undefined ? undefined : (JSON.parse(value) as T);
  };
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
    async peekTree(_oid: string): Promise<ArtifactsTreeEntry[] | undefined> {
      return undefined;
    },
    async fetchTree(oid: string) {
      reads++;
      return trees[oid] ?? null;
    },
    async peekDerived<T>(kind: string, id: string) {
      return recall<T>(kind, id);
    },
    recallDerived: recall,
    storeDerived(kind: string, id: string, value: unknown) {
      stores.push(`${kind}/${id}`);
      derived.set(`${kind}/${id}`, JSON.stringify(value));
    },
  };
  return { reader, commits, reads: () => reads, derived, stores };
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

// A history of whole trees from flat path specs, content-addressed as Git is.
interface Spec {
  mode: string;
  content: string;
}
/** Path to file; a Map, since `__proto__` is one of the names. */
type Files = Map<string, Spec>;
const typeOf = (mode: string): ArtifactsTreeEntry["type"] =>
  mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob";
function history(states: Files[]) {
  const trees: Record<string, ArtifactsTreeEntry[]> = {};
  const write = (files: Files): string => {
    const here = new Map<string, Files | Spec>();
    for (const [path, spec] of files) {
      const [first, ...rest] = path.split("/");
      if (!rest.length) here.set(first!, spec);
      else {
        const sub = (here.get(first!) as Files | undefined) ?? new Map<string, Spec>();
        sub.set(rest.join("/"), spec);
        here.set(first!, sub);
      }
    }
    const entries = [...here]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]): ArtifactsTreeEntry => {
        if (value instanceof Map) return { name, mode: "040000", hash: write(value), type: "tree" };
        return { name, mode: value.mode, hash: `b-${value.content}`, type: typeOf(value.mode) };
      });
    const hash = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
    trees[hash] = entries;
    return hash;
  };
  const roots = states.map(write);
  return { trees, roots };
}

/** Every commit's changes at a path worked out naively, and the cover answer from them. */
function reference(
  trees: Record<string, ArtifactsTreeEntry[]>,
  commits: ArtifactsCommitMetadata[],
  path: string,
) {
  const at = (root: string) => {
    let entries = trees[root] ?? [];
    let entry: ArtifactsTreeEntry | null = { name: "", mode: "040000", hash: root, type: "tree" };
    for (const segment of path ? path.split("/") : []) {
      entry = entry?.type === "tree" ? (entries.find((e) => e.name === segment) ?? null) : null;
      entries = entry?.type === "tree" ? (trees[entry.hash] ?? []) : [];
    }
    return {
      identity: entry ? `${entry.type}:${entry.mode}:${entry.hash}` : null,
      children: new Map(
        (entry?.type === "tree" ? entries : []).map((e) => [
          e.name,
          `${e.type}:${e.mode}:${e.hash}`,
        ]),
      ),
    };
  };
  const change = (i: number) => {
    const after = at(commits[i]!.treeHash);
    const before = i ? at(commits[i - 1]!.treeHash) : { identity: null, children: new Map() };
    const names = new Set(
      [...after.children.keys(), ...before.children.keys()].filter(
        (name) => after.children.get(name) !== before.children.get(name),
      ),
    );
    return { changed: !path || after.identity !== before.identity, names };
  };
  return (head: number) => {
    const names = new Set(at(commits[head]!.treeHash).children.keys());
    const unresolved = new Set(names);
    let self = false;
    const result: Omit<HistoryPage, "ref"> = {
      head: commits[head]!.hash,
      path,
      scanned: 0,
      next: null,
      commits: [],
      entries: {},
    };
    for (let i = head; i >= 0; i--) {
      const { changed, names: changedNames } = change(i);
      const commit = commitSummary(commits[i]!);
      result.scanned++;
      if (changed) result.commits.push(commit);
      for (const name of changedNames) {
        if (!names.has(name)) continue;
        const key = path ? `${path}/${name}` : name;
        const previous = Object.hasOwn(result.entries, key) ? result.entries[key] : undefined;
        Object.defineProperty(result.entries, key, {
          value: { latest: previous?.latest ?? commit, count: (previous?.count ?? 0) + 1 },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        unresolved.delete(name);
      }
      self ||= changed;
      if (!unresolved.size && self) {
        result.next = i ? commits[i - 1]!.hash : null;
        break;
      }
    }
    return plain(result);
  };
}

/** What the client receives: JSON, with the server-only flag aside. */
const plain = (page: Omit<HistoryPage, "ref"> | HistoryRead) => {
  const { cut: _cut, ...rest } = page as HistoryRead;
  return JSON.parse(JSON.stringify(rest)) as Omit<HistoryPage, "ref">;
};

/** The client's merge of consecutive pages (History.tsx mergeHistory). */
function merge(previous: Omit<HistoryPage, "ref"> | null, page: Omit<HistoryPage, "ref">) {
  if (!previous) return plain(page);
  const entries = JSON.parse(JSON.stringify(previous.entries)) as HistoryPage["entries"];
  for (const [key, entry] of Object.entries(plain(page).entries)) {
    const old = Object.hasOwn(entries, key) ? entries[key] : undefined;
    Object.defineProperty(entries, key, {
      value: { latest: old?.latest ?? entry.latest, count: (old?.count ?? 0) + entry.count },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return plain({
    ...page,
    scanned: previous.scanned + page.scanned,
    commits: [...previous.commits, ...page.commits],
    entries,
  });
}

type Reader = ReturnType<typeof fixture>["reader"];
async function plainPages(reader: Reader, head: string, path: string, cursor: string | null) {
  let merged: Omit<HistoryPage, "ref"> | null = null;
  for (let next = cursor; next;) {
    const page = await readHistory(reader, head, path, true, next);
    merged = merge(merged, page);
    next = page.next;
  }
  return merged;
}

/** A seeded generator, so a failure names the history that caused it. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = [
  "readme",
  "__proto__",
  "constructor",
  "src/a",
  "src/b",
  "src/lib",
  "src/lib/x",
  "src/lib/y",
  "docs",
  "docs/guide",
  "tool",
];
/** Random edits: content changes that sometimes restore an old one, chmod, symlinks,
 * deletion, and files that become folders and back. LICENSE never changes after
 * the first commit, so the root's answer always reaches it; the rare files make
 * the folders' answers reach far back, but not that far. */
function randomStates(seed: number, length: number): Files[] {
  const next = random(seed);
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  let files: Files = new Map([
    ["LICENSE", { mode: "100644", content: "mit" }],
    ["src/rare", { mode: "100644", content: "0" }],
    ["src/lib/rare", { mode: "100644", content: "0" }],
  ]);
  const states: Files[] = [];
  const put = (path: string, spec: Spec) => {
    for (const other of files.keys())
      if (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) files.delete(other);
    files.set(path, spec);
  };
  for (let n = 0; n < length; n++) {
    files = new Map(files);
    for (const rare of ["src/rare", "src/lib/rare"])
      if (next() < 0.008) put(rare, { mode: "100644", content: String(n) });
    const edits = next() < 0.15 ? 0 : 1 + Math.floor(next() * 2);
    for (let e = 0; e < edits; e++) {
      const path = pick(PATHS);
      const old = files.get(path);
      const roll = next();
      if (roll < 0.25) files.delete(path);
      else
        put(
          path,
          roll < 0.4 && old
            ? { ...old, mode: old.mode === "100644" ? "100755" : "100644" }
            : roll < 0.5
              ? { mode: "120000", content: pick(["a", "b"]) }
              : { mode: "100644", content: pick(["1", "2", "3"]) },
        );
    }
    states.push(files);
  }
  return states;
}

describe("a directory's last changes in one request (CORE-451)", () => {
  const LENGTH = 330;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`equal the full walk, paged or merged from a stored base (history ${seed})`, async () => {
      const { trees, roots } = history(randomStates(seed, LENGTH));
      const head = LENGTH - 1;
      for (const path of ["", "src", "src/lib", "docs", "absent"]) {
        const f = fixture(trees, roots);
        const expected = reference(trees, f.commits, path);
        const cover = await readHistory(f.reader, `c${head}`, path, true, `c${head}`, {
          cover: true,
        });
        expect(plain(cover), `path "${path}"`).toEqual(expected(head));
        expect(cover.cut).toBeUndefined();
        expect(f.derived.has(`${LAST_CHANGES}/${derivedId(`c${head}`, path)}`)).toBe(true);
        // A stored answer reads back the same.
        f.stores.length = 0;
        expect(
          plain(await readHistory(f.reader, `c${head}`, path, true, `c${head}`, { cover: true })),
        ).toEqual(expected(head));
        expect(f.stores).toEqual([]);
        // Paging on from the cover answer adds up to paging from the head.
        const paged = await plainPages(f.reader, `c${head}`, path, `c${head}`);
        expect(
          merge(
            plain(cover),
            (await plainPages(f.reader, `c${head}`, path, cover.next)) ?? {
              ...plain(cover),
              scanned: 0,
              commits: [],
              entries: {},
            },
          ),
        ).toEqual(paged);

        for (const distance of [1, 2, 7, 31, 40, 150]) {
          const g = fixture(trees, roots);
          const base = head - distance;
          await readHistory(g.reader, `c${base}`, path, true, `c${base}`, { cover: true });
          expect(g.derived.has(`${LAST_CHANGES}/${derivedId(`c${base}`, path)}`)).toBe(true);
          for (const key of g.derived.keys())
            if (key.startsWith(`${CHANGES}/`)) g.derived.delete(key);
          g.stores.length = 0;
          const merged = await readHistory(g.reader, `c${head}`, path, true, `c${head}`, {
            cover: true,
          });
          expect(plain(merged), `path "${path}", base ${distance} back`).toEqual(expected(head));
          // It walked no further than the base.
          expect(
            g.stores.filter((key) => key.startsWith(`${CHANGES}/`)).length,
          ).toBeLessThanOrEqual(distance);
          expect(g.derived.has(`${LAST_CHANGES}/${derivedId(`c${head}`, path)}`)).toBe(true);
          // And what it stored serves a later head too.
          g.stores.length = 0;
          expect(
            plain(await readHistory(g.reader, `c${head}`, path, true, `c${head}`, { cover: true })),
          ).toEqual(expected(head));
        }
      }
    });
  }

  test("a name missing at the base keeps its older changes; special names survive storage", async () => {
    const f = (content: string, mode = "100644") => ({ mode, content });
    const { trees, roots } = history(
      [
        { LICENSE: f("mit"), keep: f("1"), gone: f("g"), other: f("p") },
        { LICENSE: f("mit"), keep: f("1"), other: f("p") },
        { LICENSE: f("mit"), keep: f("1"), other: f("q") },
        { LICENSE: f("mit"), keep: f("1"), gone: f("g"), fresh: f("n"), other: f("q") },
        { LICENSE: f("mit"), keep: f("1", "100755"), gone: f("g"), fresh: f("n"), other: f("q") },
      ].map((files) => new Map(Object.entries(files))),
    );
    const g = fixture(trees, roots);
    const expected = reference(trees, g.commits, "")(4);
    await readHistory(g.reader, "c2", "", true, "c2", { cover: true });
    const merged = await readHistory(g.reader, "c4", "", true, "c4", { cover: true });
    expect(plain(merged)).toEqual(expected);
    expect(merged.entries.gone).toMatchObject({ count: 3, latest: { oid: "c3" } });
    expect(merged.entries.keep).toMatchObject({ count: 2, latest: { oid: "c4" } });
    // `__proto__` itself, through the stored answer.
    const special = fixture(
      { a: [file("__proto__", "1"), file("constructor", "2")] },
      Array(5).fill("a"),
    );
    await readHistory(special.reader, "c3", "", true, "c3", { cover: true });
    const fromStored = await readHistory(special.reader, "c4", "", true, "c4", { cover: true });
    expect(JSON.parse(JSON.stringify(fromStored.entries)).__proto__).toMatchObject({ count: 1 });
    expect(fromStored.entries.constructor).toMatchObject({ count: 1, latest: { oid: "c0" } });
  });

  test("a missing parent fails and stores no answer", async () => {
    const { trees, roots } = history(randomStates(9, 20));
    const g = fixture(trees, roots);
    g.commits[10]!.parents = ["missing"];
    await expect(readHistory(g.reader, "c19", "", true, "c19", { cover: true })).rejects.toThrow(
      "parent commit is unavailable",
    );
    expect([...g.derived.keys()].filter((key) => key.startsWith(`${LAST_CHANGES}/`))).toEqual([]);
  });

  test("a walk its budget cuts short says so, stores nothing, and pages on exactly", async () => {
    const { trees, roots } = history(randomStates(5, 150));
    for (const options of [
      { cover: true, budget: { commits: 10, ms: 1e9 } },
      {
        cover: true,
        budget: { commits: 1e9, ms: 500 },
        now: (
          (t) => () =>
            (t += 1000)
        )(0),
      },
    ]) {
      const g = fixture(trees, roots);
      const first = await readHistory(g.reader, "c149", "", true, "c149", options);
      expect(first.cut).toBe(true);
      expect(first.next).not.toBeNull();
      expect(first.scanned).toBe(options.budget.commits === 10 ? 10 : HISTORY_PAGE_SIZE + 1);
      expect([...g.derived.keys()].filter((key) => key.startsWith(`${LAST_CHANGES}/`))).toEqual([]);
      // The client pages on with cover from the cursor.
      let merged = plain(first);
      for (let next = first.next; next;) {
        const page = await readHistory(g.reader, "c149", "", true, next, { cover: true });
        merged = merge(merged, page);
        next = page.next;
      }
      expect(merged).toEqual(reference(trees, g.commits, "")(149));
    }
  });
});
