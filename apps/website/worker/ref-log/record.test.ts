import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { PackCommit } from "../git/pack.ts";
import { DELIM, FLUSH, pkt } from "../git/pktline.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { buildPack, commitBody, objectId } from "../testing/pack.ts";
import { readNewCommits, recordRefs, type CommitReader } from "./record.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: unknown;
    public env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
const ann = { id: "acc_ann", agent: { id: "agt_builder", name: "builder" } };

async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  closers.push(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
  `);
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "ann-org",
      slug: "ann-org",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "acc_ann",
    },
    space: { id: "acc_ann", slug: "ann", displayName: "General" },
    members: [
      {
        accountId: "acc_ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "acc_ann",
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc_ann', 'app', 'private', 'a', 'https://a');
  `);
  // A commit graph standing in for the repository, and a reader over it that
  // answers like the fetch: what `want` reaches and no `have` does, newest first.
  const commits = new Map<string, PackCommit>();
  const commit = (changeId: string | null, ...parents: string[]) => {
    const oid = (commits.size + 1).toString(16).padStart(40, "0");
    commits.set(oid, { oid, parents, changeId });
    return oid;
  };
  const reachable = (oid: string, seen = new Set<string>()) => {
    if (seen.has(oid)) return seen;
    seen.add(oid);
    for (const parent of commits.get(oid)?.parents ?? []) reachable(parent, seen);
    return seen;
  };
  const reads: { want: string; haves: string[] }[] = [];
  const read: CommitReader = async (want, haves) => {
    reads.push({ want, haves });
    const had = new Set(haves.flatMap((have) => [...reachable(have)]));
    return {
      commits: [...reachable(want)].filter((oid) => !had.has(oid)).map((oid) => commits.get(oid)!),
      truncated: false,
    };
  };
  const push = (tips: Record<string, string>, reader: CommitReader = read) =>
    recordRefs(d1(sqlite), "repo", new Map(Object.entries(tips)), ann, reader);
  const updates = () =>
    sqlite
      .prepare(
        "SELECT ref, old_oid, new_oid, forced, actor_id, agent_id FROM ref_updates ORDER BY id",
      )
      .all();
  const membership = () =>
    sqlite
      .prepare(
        "SELECT change_id, ref, first_commit_oid, last_commit_oid, first_update_id FROM change_refs ORDER BY change_id, ref",
      )
      .all();
  return { sqlite, commit, read, reads, push, updates, membership };
}

describe("recordRefs", () => {
  test("identical refs and OIDs in three sources retain independent rewrite histories", async () => {
    const t = await setup();
    const a = t.commit("samechange");
    const rewritten = t.commit("samechange");
    const push = (source: string, oid: string) =>
      recordRefs(d1(t.sqlite), "repo", new Map([["refs/heads/main", oid]]), ann, t.read, source);
    for (const source of ["canonical", "work_a", "work_b"]) await push(source, a);
    await push("work_a", rewritten);
    expect(
      t.sqlite.prepare("SELECT source_id, oid FROM repo_refs ORDER BY source_id").all(),
    ).toEqual([
      { source_id: "canonical", oid: a },
      { source_id: "work_a", oid: rewritten },
      { source_id: "work_b", oid: a },
    ]);
    expect(
      t.sqlite
        .prepare(
          "SELECT source_id, first_commit_oid, last_commit_oid FROM change_refs ORDER BY source_id",
        )
        .all(),
    ).toEqual([
      { source_id: "canonical", first_commit_oid: a, last_commit_oid: a },
      { source_id: "work_a", first_commit_oid: a, last_commit_oid: rewritten },
      { source_id: "work_b", first_commit_oid: a, last_commit_oid: a },
    ]);
    expect(
      t.sqlite
        .prepare("SELECT source_id, old_oid, new_oid FROM ref_updates WHERE old_oid IS NOT NULL")
        .all(),
    ).toEqual([{ source_id: "work_a", old_oid: a, new_oid: rewritten }]);
    expect(await push("canonical", a)).toEqual([]);
    expect(await push("work_b", a)).toEqual([]);
  });

  test("source-scoped change batches remain within D1's binding limit", async () => {
    const t = await setup();
    let tip = t.commit("change0");
    for (let n = 1; n < 35; n++) tip = t.commit(`change${n}`, tip);
    const database = d1(t.sqlite);
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        if (values.length > 100) throw new Error("D1 binding limit exceeded");
        return bind(...values);
      };
      return statement;
    };
    await recordRefs(
      database,
      "repo",
      new Map([["refs/heads/work", tip]]),
      ann,
      t.read,
      "work_many",
    );
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM change_refs WHERE source_id='work_many'").get(),
    ).toEqual({ n: 35 });
  });

  test("a first push logs the created refs, attributed to the person and agent, with their changes", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    const b = t.commit("bbbb", a);
    const logged = await t.push({ "refs/heads/main": b, "refs/tags/v1": a });
    expect(logged.map((u) => u.ref)).toEqual(["refs/heads/main", "refs/tags/v1"]);
    expect(t.updates()).toEqual([
      {
        ref: "refs/heads/main",
        old_oid: null,
        new_oid: b,
        forced: 0,
        actor_id: "acc_ann",
        agent_id: "agt_builder",
      },
      {
        ref: "refs/tags/v1",
        old_oid: null,
        new_oid: a,
        forced: 0,
        actor_id: "acc_ann",
        agent_id: "agt_builder",
      },
    ]);
    // Both refs are new to the repository, so the tag's commit reached both.
    expect(t.membership()).toEqual([
      expect.objectContaining({ change_id: "aaaa", ref: "refs/heads/main", first_commit_oid: a }),
      expect.objectContaining({ change_id: "aaaa", ref: "refs/tags/v1", first_commit_oid: a }),
      expect.objectContaining({ change_id: "bbbb", ref: "refs/heads/main", first_commit_oid: b }),
    ]);
    // A tag made later, on a commit main already has, reached nothing new.
    await t.push({ "refs/heads/main": b, "refs/tags/v1": a, "refs/tags/v2": b });
    expect(t.reads.at(-1)).toEqual({ want: b, haves: [b, a] });
    expect(t.membership()).toHaveLength(3);
  });

  test("a push verifies step context reported for its commits (CORE-231)", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    const other = "f".repeat(40);
    t.sqlite.exec(`
      INSERT INTO step_contexts (repo_id, change_id, commit_oid, author_id, accountable_id, committed_at)
      VALUES ('repo', 'aaaa', '${a}', 'agt_builder', 'acc_ann', '2026-10-04T00:00:00Z'),
             ('repo', 'zzzz', '${other}', 'agt_builder', 'acc_ann', '2026-10-04T00:00:00Z');
    `);
    await t.push({ "refs/heads/timeline/search": a });
    const verified = t.sqlite
      .prepare(
        "SELECT commit_oid, verified_at IS NOT NULL AS verified FROM step_contexts ORDER BY commit_oid",
      )
      .all();
    expect(verified).toEqual([
      { commit_oid: a, verified: 1 },
      { commit_oid: other, verified: 0 },
    ]);
  });

  test("fast-forwards, force pushes and deletions are all logged", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    const b = t.commit("bbbb", a);
    await t.push({ "refs/heads/main": a, "refs/heads/topic": b });

    const c = t.commit("cccc", a);
    await t.push({ "refs/heads/main": c, "refs/heads/topic": b });
    // topic rewritten: bbbb's new version replaces its old commit.
    const b2 = t.commit("bbbb", c);
    await t.push({ "refs/heads/main": c, "refs/heads/topic": b2 });
    await t.push({ "refs/heads/main": c });

    expect(t.updates().slice(2)).toEqual([
      expect.objectContaining({ ref: "refs/heads/main", old_oid: a, new_oid: c, forced: 0 }),
      expect.objectContaining({ ref: "refs/heads/topic", old_oid: b, new_oid: b2, forced: 1 }),
      expect.objectContaining({ ref: "refs/heads/topic", old_oid: b2, new_oid: null, forced: 0 }),
    ]);
    const bbbb = t
      .membership()
      .find((row) => (row as { change_id: string; ref: string }).change_id === "bbbb");
    expect(bbbb).toMatchObject({
      ref: "refs/heads/topic",
      first_commit_oid: b,
      last_commit_oid: b2,
    });
    // Merging a change into another ref records that it reached it.
    const m = t.commit("mmmm", c, b2);
    await t.push({ "refs/heads/main": m });
    expect(t.membership()).toContainEqual(
      expect.objectContaining({ change_id: "bbbb", ref: "refs/heads/main", first_commit_oid: b2 }),
    );
  });

  test("a new branch records only the commits no other ref had", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    await t.push({ "refs/heads/main": a });
    const f = t.commit("ffff", a);
    await t.push({ "refs/heads/main": a, "refs/heads/timeline/x": f });
    expect(t.membership()).toEqual([
      expect.objectContaining({ change_id: "aaaa", ref: "refs/heads/main" }),
      expect.objectContaining({ change_id: "ffff", ref: "refs/heads/timeline/x" }),
    ]);
  });

  test("racing recordings of the same push log it once", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    await t.push({ "refs/heads/main": a });
    const b = t.commit("bbbb", a);
    const [first, second] = await Promise.all([
      t.push({ "refs/heads/main": b }),
      t.push({ "refs/heads/main": b }),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(await t.push({ "refs/heads/main": b })).toEqual([]);
    expect(t.updates()).toHaveLength(2);
  });

  test("an update is logged even when its commits can't be read, with forced unknown", async () => {
    const t = await setup();
    const a = t.commit("aaaa");
    await t.push({ "refs/heads/main": a });
    const b = t.commit("bbbb", a);
    await t.push({ "refs/heads/main": b }, async () => {
      throw new Error("Artifacts is down");
    });
    const c = t.commit("cccc");
    await t.push({ "refs/heads/main": c }, async (want, haves) => ({
      ...(await t.read(want, haves)),
      truncated: true,
    }));
    expect(t.updates().slice(1)).toEqual([
      expect.objectContaining({ old_oid: a, new_oid: b, forced: null }),
      expect.objectContaining({ old_oid: b, new_oid: c, forced: null }),
    ]);
    expect(t.membership().map((row) => (row as { change_id: string }).change_id)).toEqual([
      "aaaa",
      "cccc",
    ]);
  });
});

describe("readNewCommits", () => {
  const encoder = new TextEncoder();
  /** A fetch response: pkt-lines, with pack bytes on side-band 1. */
  const response = (before: string, pack: Uint8Array | null) => {
    const parts: Uint8Array[] = [encoder.encode(before)];
    if (pack) {
      parts.push(encoder.encode(pkt("packfile\n")));
      for (let at = 0; at < pack.length; at += 1000) {
        const chunk = pack.subarray(at, at + 1000);
        parts.push(encoder.encode((chunk.length + 5).toString(16).padStart(4, "0")));
        parts.push(new Uint8Array([1, ...chunk]));
      }
    }
    parts.push(encoder.encode(FLUSH));
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  };
  const root = commitBody({ changeId: "aaaa" });
  const child = commitBody({ parents: [objectId("commit", root)], changeId: "bbbb" });
  const pack = buildPack([
    { type: "commit", body: child },
    { type: "commit", body: root },
  ]);

  test("reads the pack's commits", async () => {
    const found = await readNewCommits(response("", pack), 1 << 20);
    expect(found.truncated).toBe(false);
    expect(found.commits.map((c) => c.changeId)).toEqual(["bbbb", "aaaa"]);
  });

  test("shallow lines and the size cap mark history as cut short", async () => {
    const shallow = pkt("shallow-info\n") + pkt(`shallow ${"1".repeat(40)}\n`) + DELIM;
    expect((await readNewCommits(response(shallow, pack), 1 << 20)).truncated).toBe(true);
    const capped = await readNewCommits(response("", pack), 10);
    expect(capped.truncated).toBe(true);
  });

  test("no pack means no new commits", async () => {
    expect(await readNewCommits(response("", null), 1 << 20)).toEqual({
      commits: [],
      truncated: false,
    });
  });

  test("an error from the server is thrown", async () => {
    await expect(
      readNewCommits(response(pkt("ERR upload-pack: nope\n"), null), 10),
    ).rejects.toThrow(/nope/);
  });
});
