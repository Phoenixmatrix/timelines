import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  advertiseV0,
  advertiseV2,
  concat,
  deflate,
  dec,
  enc,
  encodeCommit,
  encodeTree,
  FLUSH,
  handleV0,
  handleV2,
  hashObject,
  inflate,
  makeObject,
  ObjectGraph,
  parseCommit,
  parseTree,
  pkt,
  pktText,
  planFetch,
  readPkts,
  sideband,
  writePack,
  type EncodedObject,
  type GitRefs,
} from "./index.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();
const tmpDirs: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitmatrix-git-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q", "--bare", dir], { env: GIT_ENV });
  return dir;
}

function git(dir: string, args: string[], input?: Uint8Array | string): string {
  return execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, input }).toString();
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const IDENT = { name: "gitmatrix", email: "noreply@example.com", time: 1_700_000_000 };

/** A linear history: each step is the full set of top-level files plus Formula/. */
function buildHistory(steps: Record<string, string>[]): {
  objects: EncodedObject[];
  commits: string[];
} {
  const objects = new Map<string, EncodedObject>();
  const put = (o: EncodedObject) => {
    objects.set(o.oid, o);
    return o.oid;
  };
  const commits: string[] = [];
  steps.forEach((files, i) => {
    const formula: { mode: string; name: string; oid: string }[] = [];
    const root: { mode: string; name: string; oid: string }[] = [];
    for (const [path, content] of Object.entries(files)) {
      const oid = put(makeObject("blob", enc.encode(content)));
      if (path.startsWith("Formula/")) formula.push({ mode: "100644", name: path.slice(8), oid });
      else root.push({ mode: "100644", name: path, oid });
    }
    if (formula.length > 0) {
      root.push({
        mode: "40000",
        name: "Formula",
        oid: put(makeObject("tree", encodeTree(formula))),
      });
    }
    const tree = put(makeObject("tree", encodeTree(root)));
    commits.push(
      put(
        makeObject(
          "commit",
          encodeCommit({
            tree,
            parents: commits.length ? [commits.at(-1)!] : [],
            author: { ...IDENT, time: IDENT.time + i },
            committer: { ...IDENT, time: IDENT.time + i },
            message: `Step ${i}`,
          }),
        ),
      ),
    );
  });
  return { objects: [...objects.values()], commits };
}

function graphOf(objects: EncodedObject[]): ObjectGraph {
  return new ObjectGraph(
    objects.map((o) => ({ oid: o.oid, type: o.type, size: o.size, zdata: deflate(o.data) })),
  );
}

/** Pulls the pack out of band 1 of a side-band stream starting at `from`. */
function unband(pkts: ReturnType<typeof readPkts>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const p of pkts) {
    if (p.type === "data" && p.data[0] === 1) parts.push(p.data.subarray(1));
  }
  return concat(parts);
}

describe("pkt-line", () => {
  it("frames and parses lines, flush and delim", () => {
    expect(dec.decode(pkt("hello\n"))).toBe("000ahello\n");
    const buf = concat([pkt("a\n"), FLUSH, enc.encode("0001"), pkt("b")]);
    const pkts = readPkts(buf);
    expect(pkts.map((p) => p.type)).toEqual(["data", "flush", "delim", "data"]);
    expect(pktText(pkts[0]!)).toBe("a");
    expect(pktText(pkts[3]!)).toBe("b");
  });

  it("rejects bad framing", () => {
    expect(() => readPkts(enc.encode("zzzz"))).toThrow();
    expect(() => readPkts(enc.encode("0009abc"))).toThrow();
  });

  it("splits side-band data into packets that fit", () => {
    const data = new Uint8Array(70_000).fill(7);
    const pkts = sideband(1, data);
    expect(pkts).toHaveLength(2);
    expect(pkts[0]!.length).toBe(65520);
    const parsed = readPkts(concat(pkts));
    expect(unband(parsed)).toEqual(data);
    expect(sideband(1, data, 1000).every((p) => p.length <= 1000)).toBe(true);
  });
});

describe("objects", () => {
  it("hashes like git", () => {
    expect(hashObject("blob", enc.encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(hashObject("tree", new Uint8Array())).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("sorts tree entries the way git does (directories as name/)", () => {
    const blob = hashObject("blob", enc.encode("x"));
    const tree = encodeTree([
      { mode: "100644", name: "lib.rb", oid: blob },
      { mode: "40000", name: "lib", oid: hashObject("tree", new Uint8Array()) },
      { mode: "100644", name: "a", oid: blob },
    ]);
    expect(parseTree(tree).map((e) => e.name)).toEqual(["a", "lib.rb", "lib"]);
  });

  it("round-trips zlib and commits", () => {
    const data = encodeCommit({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [],
      author: IDENT,
      committer: IDENT,
      message: "Init",
    });
    expect(inflate(deflate(data))).toEqual(data);
    const parsed = parseCommit(data);
    expect(parsed.tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(parsed.message).toBe("Init\n");
    expect(parsed.author).toBe("gitmatrix <noreply@example.com> 1700000000 +0000");
  });

  it.skipIf(!GIT)("matches git mktree and commit-tree", () => {
    const dir = tempRepo();
    const blob = git(dir, ["hash-object", "-w", "--stdin"], "class Foo < Formula\nend\n").trim();
    expect(hashObject("blob", enc.encode("class Foo < Formula\nend\n"))).toBe(blob);
    const sub = git(dir, ["mktree"], `100644 blob ${blob}\tfoo.rb\n`).trim();
    const root = git(
      dir,
      ["mktree"],
      `040000 tree ${sub}\tFormula\n100644 blob ${blob}\tFormula.rb\n100755 blob ${blob}\tbin-x\n`,
    ).trim();
    expect(hashObject("tree", encodeTree([{ mode: "100644", name: "foo.rb", oid: blob }]))).toBe(
      sub,
    );
    const ours = encodeTree([
      { mode: "100755", name: "bin-x", oid: blob },
      { mode: "40000", name: "Formula", oid: sub },
      { mode: "100644", name: "Formula.rb", oid: blob },
    ]);
    expect(hashObject("tree", ours)).toBe(root);
    const commit = execFileSync("git", ["-C", dir, "commit-tree", root, "-m", "Update foo 1.0"], {
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: "gitmatrix",
        GIT_AUTHOR_EMAIL: "noreply@example.com",
        GIT_COMMITTER_NAME: "gitmatrix",
        GIT_COMMITTER_EMAIL: "noreply@example.com",
        GIT_AUTHOR_DATE: "@1700000000 +0000",
        GIT_COMMITTER_DATE: "@1700000000 +0000",
      },
    })
      .toString()
      .trim();
    const mine = encodeCommit({
      tree: root,
      parents: [],
      author: IDENT,
      committer: IDENT,
      message: "Update foo 1.0",
    });
    expect(hashObject("commit", mine)).toBe(commit);
  });
});

describe("packs", () => {
  it.skipIf(!GIT)("writes packs git can index and verify", () => {
    const { objects, commits } = buildHistory([
      { "README.md": "# tap\n", "Formula/foo.rb": "foo 1\n" },
      { "README.md": "# tap\n", "Formula/foo.rb": "foo 2\n", "Formula/bar.rb": "bar\n" },
    ]);
    const graph = graphOf(objects);
    const pack = concat(
      writePack(
        graph,
        objects.map((o) => o.oid),
      ),
    );
    const dir = tempRepo();
    const packPath = join(dir, "objects", "pack", "pack-test.pack");
    writeFileSync(packPath, pack);
    git(dir, ["index-pack", "--strict", packPath]);
    const verify = git(dir, ["verify-pack", "-v", packPath.replace(/\.pack$/, ".idx")]);
    expect(verify).toContain(commits[1]!);
    git(dir, ["update-ref", "refs/heads/main", commits[1]!]);
    git(dir, ["fsck", "--strict", "--no-dangling"]);
    expect(git(dir, ["log", "--format=%s", "main"]).trim().split("\n")).toEqual([
      "Step 1",
      "Step 0",
    ]);
  });
});

describe("upload-pack", () => {
  const history = buildHistory([
    { "README.md": "# tap\n", "Formula/foo.rb": "foo 1\n" },
    { "README.md": "# tap\n", "Formula/foo.rb": "foo 2\n" },
    { "README.md": "# tap 3\n", "Formula/foo.rb": "foo 1\n", "Formula/bar.rb": "bar\n" },
  ]);
  const graph = graphOf(history.objects);
  const [c0, c1, c2] = history.commits as [string, string, string];
  const refs: GitRefs = {
    headTarget: "refs/heads/main",
    refs: [{ name: "refs/heads/main", oid: c2 }],
  };

  it("advertises v0 refs with capabilities and v2 capabilities", () => {
    const v0 = readPkts(advertiseV0(refs));
    expect(pktText(v0[0]!)).toBe("# service=git-upload-pack");
    expect(v0[1]!.type).toBe("flush");
    const head = pktText(v0[2]!);
    expect(head.startsWith(`${c2} HEAD\0`)).toBe(true);
    expect(head).toContain("symref=HEAD:refs/heads/main");
    expect(head).toContain("side-band-64k");
    expect(pktText(v0[3]!)).toBe(`${c2} refs/heads/main`);
    const v2 = readPkts(advertiseV2()).map(pktText);
    expect(v2).toContain("version 2");
    expect(v2).toContain("ls-refs=unborn");
    expect(v2).toContain("fetch=shallow");
  });

  it("lists refs with symref targets and prefixes", () => {
    const body = concat([
      pkt("command=ls-refs\n"),
      pkt("object-format=sha1\n"),
      enc.encode("0001"),
      pkt("symrefs\n"),
      pkt("ref-prefix HEAD\n"),
      pkt("ref-prefix refs/heads/\n"),
      FLUSH,
    ]);
    const lines = readPkts(concat(handleV2(body, graph, refs))).map(pktText);
    expect(lines).toEqual([
      `${c2} HEAD symref-target:refs/heads/main`,
      `${c2} refs/heads/main`,
      "",
    ]);
  });

  it("plans incremental fetches from common commits", () => {
    const full = planFetch(graph, { wants: [c2] });
    expect(full.objects).toHaveLength(graph.size);
    const incremental = planFetch(graph, { wants: [c2], common: [c1] });
    // c2, root tree, Formula tree, README blob, bar blob ("foo 1" is in c0).
    expect(incremental.objects).toHaveLength(5);
    expect(incremental.objects[0]).toBe(c2);
    const shallow = planFetch(graph, { wants: [c2], depth: 1 });
    expect(shallow.shallow).toEqual([c2]);
    expect(shallow.objects).not.toContain(c1);
    // A shallow client with c2 that deepens by 2 gets c1 and unshallows c2.
    const deeper = planFetch(graph, { wants: [c2], common: [c2], clientShallow: [c2], depth: 2 });
    expect(deeper.unshallow).toEqual([c2]);
    expect(deeper.shallow).toEqual([c1]);
    expect(deeper.objects[0]).toBe(c1);
    expect(planFetch(graph, { wants: [c0] }).objects).toHaveLength(5);
  });

  it.skipIf(!GIT)("serves a v2 fetch whose pack git accepts", () => {
    const body = concat([
      pkt("command=fetch\n"),
      pkt("object-format=sha1\n"),
      enc.encode("0001"),
      pkt("ofs-delta\n"),
      pkt(`want ${c2}\n`),
      pkt("done\n"),
      FLUSH,
    ]);
    const pkts = readPkts(concat(handleV2(body, graph, refs)));
    expect(pktText(pkts[0]!)).toBe("packfile");
    const dir = tempRepo();
    git(dir, ["index-pack", "--stdin", "--strict"], unband(pkts.slice(1)));
    git(dir, ["update-ref", "refs/heads/main", c2]);
    git(dir, ["fsck", "--strict", "--no-dangling"]);
  });

  it("acknowledges haves and says ready in v2 when not done", () => {
    const body = concat([
      pkt("command=fetch\n"),
      enc.encode("0001"),
      pkt(`want ${c2}\n`),
      pkt(`have ${c1}\n`),
      pkt(`have ${"1".repeat(40)}\n`),
      FLUSH,
    ]);
    const pkts = readPkts(concat(handleV2(body, graph, refs)));
    expect(pkts.slice(0, 5).map((p) => (p.type === "data" ? pktText(p) : p.type))).toEqual([
      "acknowledgments",
      `ACK ${c1}`,
      "ready",
      "delim",
      "packfile",
    ]);
  });

  it("refuses unknown wants with an ERR packet", () => {
    const body = concat([
      pkt("command=fetch\n"),
      enc.encode("0001"),
      pkt(`want ${"2".repeat(40)}\n`),
      pkt("done\n"),
      FLUSH,
    ]);
    expect(pktText(readPkts(concat(handleV2(body, graph, refs)))[0]!)).toMatch(
      /^ERR .*not our ref/,
    );
  });

  it.skipIf(!GIT)("serves a v0 clone: NAK then a side-band pack", () => {
    const body = concat([
      pkt(`want ${c2} multi_ack_detailed side-band-64k ofs-delta agent=git/2\n`),
      FLUSH,
      pkt("done\n"),
    ]);
    const pkts = readPkts(concat(handleV0(body, graph)));
    expect(pktText(pkts[0]!)).toBe("NAK");
    expect(pkts.at(-1)!.type).toBe("flush");
    const dir = tempRepo();
    git(dir, ["index-pack", "--stdin", "--strict"], unband(pkts.slice(1)));
  });

  it("negotiates v0 haves statelessly", () => {
    const round = concat([
      pkt(`want ${c2} multi_ack_detailed side-band-64k\n`),
      FLUSH,
      pkt(`have ${"3".repeat(40)}\n`),
      pkt(`have ${c1}\n`),
      FLUSH,
    ]);
    expect(readPkts(concat(handleV0(round, graph))).map(pktText)).toEqual([
      `ACK ${c1} common`,
      `ACK ${c1} ready`,
      "NAK",
    ]);
    const final = concat([
      pkt(`want ${c2} multi_ack_detailed side-band-64k\n`),
      FLUSH,
      pkt(`have ${c1}\n`),
      pkt("done\n"),
    ]);
    const pkts = readPkts(concat(handleV0(final, graph)));
    expect(pktText(pkts[0]!)).toBe(`ACK ${c1} common`);
    expect(pktText(pkts[1]!)).toBe(`ACK ${c1}`);
    const pack = unband(pkts.slice(2));
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(5);
  });

  it("sends the shallow list first for v0 deepen", () => {
    const body = concat([
      pkt(`want ${c2} multi_ack_detailed side-band-64k shallow\n`),
      pkt("deepen 1\n"),
      FLUSH,
    ]);
    expect(
      readPkts(concat(handleV0(body, graph))).map((p) => (p.type === "data" ? pktText(p) : p.type)),
    ).toEqual([`shallow ${c2}`, "flush"]);
  });
});
