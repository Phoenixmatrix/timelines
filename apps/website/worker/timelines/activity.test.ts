import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { PackCommit } from "../git/pack.ts";
import { recordRefs, type CommitReader } from "../ref-log/record.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { timelineActivity } from "./activity.ts";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: DurableObjectState;
    public env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const repo = {
  id: "repo",
  space_id: "space_ann",
  space_slug: "ann",
  name: "app",
  default_branch: "main",
  artifacts_name: "a",
  artifacts_remote: "https://a",
};
const builder = { id: "acc_ann", agent: { id: "agt_builder", name: "builder" } };

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite, env } = fresh;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
  `);
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "org_ann",
      slug: "ann",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "acc_ann",
    },
    space: { id: "space_ann", slug: "ann", displayName: "Ann" },
    members: [
      {
        accountId: "acc_ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "acc_ann",
  });
  sqlite.exec(`INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
    VALUES ('repo', 'space_ann', 'app', 'private', 'a', 'https://a');`);
  // The repository's commit graph, and a reader answering like the fetch does.
  const commits = new Map<string, PackCommit>();
  const commit = (...parents: string[]) => {
    const oid = (commits.size + 1).toString(16).padStart(40, "0");
    commits.set(oid, { oid, parents, changeId: null });
    return oid;
  };
  const reachable = (oid: string, seen = new Set<string>()) => {
    if (seen.has(oid)) return seen;
    seen.add(oid);
    for (const parent of commits.get(oid)?.parents ?? []) reachable(parent, seen);
    return seen;
  };
  const read: CommitReader = async (want, haves) => {
    const had = new Set(haves.flatMap((have) => [...reachable(have)]));
    return {
      commits: [...reachable(want)].filter((oid) => !had.has(oid)).map((oid) => commits.get(oid)!),
      truncated: false,
    };
  };
  const tips = new Map<string, string>();
  /** Move refs as one push, and work out what it did to timelines. */
  const push = async (refs: Record<string, string>, actor = builder) => {
    for (const [ref, oid] of Object.entries(refs)) tips.set(`refs/heads/${ref}`, oid);
    const logged = await recordRefs(d1(sqlite), "repo", new Map(tips), actor, read);
    return timelineActivity(d1(sqlite), repo, actor, logged);
  };
  return { commit, push };
}

describe("timeline activity from the push log", () => {
  test("pushing work to a bookmark notes who worked in it, but forking doesn't", async () => {
    const t = await setup();
    const m1 = t.commit();
    await t.push({ main: m1 });
    // A fork only notes where the bookmark points.
    expect(await t.push({ "timeline/search": m1 })).toMatchObject({
      pushed: [],
      heads: [{ slug: "search", commit: m1 }],
      merges: [],
    });
    const a1 = t.commit(m1);
    expect(await t.push({ "timeline/search": a1 })).toEqual({
      repo: { id: "repo", spaceId: "space_ann", space: "ann", name: "app" },
      actorId: "agt_builder",
      accountableId: "acc_ann",
      pushed: ["search"],
      heads: [{ slug: "search", commit: a1 }],
      merges: [],
    });
  });

  test("merges from main, between timelines, and into main", async () => {
    const t = await setup();
    const m1 = t.commit();
    await t.push({ main: m1, "timeline/search": m1, "timeline/ranking": m1 });
    const a1 = t.commit(m1);
    const b1 = t.commit(m1);
    await t.push({ "timeline/search": a1, "timeline/ranking": b1 });
    const m2 = t.commit(m1);
    await t.push({ main: m2 });

    // Main into search, then ranking into search.
    const a2 = t.commit(a1, m2);
    const a3 = t.commit(a2, b1);
    const intoSearch = await t.push({ "timeline/search": a3 });
    expect(intoSearch?.merges).toMatchObject([
      { into: "search", from: "ranking", commit: a3, parent: b1 },
      { into: "search", from: null, commit: a2, parent: m2 },
    ]);
    expect(intoSearch?.pushed).toEqual(["search"]);

    // Search lands: one merge into main, not search's own merges again.
    const m3 = t.commit(m2, a3);
    const landing = await t.push({ main: m3 });
    expect(landing).toMatchObject({
      pushed: [],
      merges: [{ into: null, from: "search", commit: m3, parent: a3 }],
    });
    expect(landing!.merges[0]!.refUpdateId).toEqual(expect.any(Number));
  });

  test("a parent that is main's tip and a fresh fork's counts as main", async () => {
    const t = await setup();
    const m1 = t.commit();
    await t.push({ main: m1, "timeline/search": m1 });
    const a1 = t.commit(m1);
    await t.push({ "timeline/search": a1 });
    const m2 = t.commit(m1);
    await t.push({ main: m2, "timeline/fresh": m2 });
    const a2 = t.commit(a1, m2);
    expect((await t.push({ "timeline/search": a2 }))?.merges).toMatchObject([
      { into: "search", from: null, parent: m2 },
    ]);
  });

  test("merges from other branches, and pushes to other branches, are not timelines'", async () => {
    const t = await setup();
    const m1 = t.commit();
    await t.push({ main: m1, feature: m1 });
    const f1 = t.commit(m1);
    expect(await t.push({ feature: f1 })).toBeNull();
    const m2 = t.commit(m1, f1);
    expect(await t.push({ main: m2 })).toBeNull();
  });
});
