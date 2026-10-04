// The commit-mention index (CORE-22) over real D1: a push records the issue
// keys its new commits name, resolved tier by tier (subscribing trackers, the
// owner's, the owner's organizations'), once per commit and key; ambiguous
// keys are kept unresolved and unknown ones dropped. The backfill reads each
// repository's recent history once; release notes resolve keys no
// subscription covers the same way.

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ShippedIssue } from "../../shared/release-notes.ts";
import type { PackCommit } from "../git/pack.ts";
import { recordRefs, type CommitReader } from "../ref-log/record.ts";
import { repoIssues } from "../release-notes/trackers.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { backfillMentions, type HistoryReader } from "./backfill.ts";
import { indexMentions, indexPushedMentions, trackerTiers, type IssueLookup } from "./index.ts";

const closers: { close(): void }[] = [];
afterEach(() => {
  for (const c of closers) c.close();
  closers.length = 0;
});

const oid = (n: number) => n.toString(16).padStart(40, "0");
const AT = 1790000000;

function issue(id: string, key: string): ShippedIssue {
  return {
    id,
    key,
    title: `Issue ${key}`,
    description: "",
    type: "task",
    status: "todo",
    labels: [],
    workspaceIds: [],
    team: { id: "t", key: key.split("-")[0]!, name: "Team" },
    completedAt: null,
    evidence: [],
  } as ShippedIssue;
}

/**
 * Ann owns `app`; she's in orgs orbit and nova. Orbit's tracker subscribes
 * to `app`. Each tracker has its own issues, some sharing keys.
 */
function world() {
  const sqlite = migratedDatabase();
  closers.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('orbit', 'org', 'orbit', 'Orbit'),
      ('nova', 'org', 'nova', 'Nova'), ('zed', 'org', 'zed', 'Zed');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'member'), ('nova', 'ann', 'member');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote, pushed_at) VALUES
      ('app', 'ann', 'app', 'private', 'a', 'https://a', '2026-09-01T00:00:00Z'),
      ('lib', 'orbit', 'lib', 'private', 'b', 'https://b', '2026-09-02T00:00:00Z'),
      ('gone', 'orbit', 'gone', 'private', 'c', 'https://c', '2026-09-03T00:00:00Z');
    UPDATE repos SET deleted_at = '2026-09-04T00:00:00Z' WHERE id = 'gone';
    INSERT INTO tracker_repo_subscriptions (tracker_owner_id, repo_id) VALUES ('orbit', 'app');
  `);
  const trackers: Record<string, ShippedIssue[]> = {
    // Subscribed: wins for CORE-1 over Ann's own CORE-1.
    orbit: [issue("orbit-core-1", "CORE-1")],
    // The owner's: CORE-1 (shadowed), APP-2.
    ann: [issue("ann-core-1", "CORE-1"), issue("ann-app-2", "APP-2")],
    // An organization's.
    nova: [issue("nova-3", "NOVA-3"), issue("nova-dup-4", "DUP-4")],
    // Zed isn't Ann's, so its ZED-5 is never found.
    zed: [issue("zed-5", "ZED-5")],
  };
  const lookups: { owner: string; keys: string[] }[] = [];
  const lookup: IssueLookup = async (owner, keys) => {
    lookups.push({ owner, keys });
    return (trackers[owner] ?? []).filter((i) => keys.includes(i.key));
  };
  const mentions = () =>
    sqlite
      .prepare(
        `SELECT repo_id, commit_oid, issue_key, change_id, resolution, tracker_owner_id, issue_id,
                title, committed_at, first_ref
         FROM commit_issue_mentions ORDER BY repo_id, commit_oid, issue_key`,
      )
      .all();
  return { sqlite, db: d1(sqlite), trackers, lookup, lookups, mentions };
}

/** A commit graph and a reader that answers like the push log's fetch. */
function graph() {
  const commits = new Map<string, PackCommit>();
  const commit = (message: string, changeId: string | null, ...parents: string[]) => {
    const id = oid(commits.size + 1);
    commits.set(id, { oid: id, parents, changeId, message, committedAt: AT + commits.size });
    return id;
  };
  const reachable = (id: string, seen = new Set<string>()) => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const parent of commits.get(id)?.parents ?? []) reachable(parent, seen);
    return seen;
  };
  const read: CommitReader = async (want, haves) => {
    const had = new Set(haves.flatMap((have) => [...reachable(have)]));
    return {
      commits: [...reachable(want)]
        .filter((id) => !had.has(id))
        .reverse()
        .map((id) => commits.get(id)!),
      truncated: false,
    };
  };
  return { commit, read };
}

describe("indexing mentions on push", () => {
  test("records each new commit's keys, resolved by tier, with its ref, change and title", async () => {
    const w = world();
    const g = graph();
    const a = g.commit("CORE-1: Rank results\n\nAlso touches APP-2 and UTF-8.", "chgaaaa");
    const b = g.commit("NOVA-3 docs, ZED-5 isn't ours", null, a);
    const env = { DB: w.db } as Env;
    const logged = await recordRefs(w.db, "app", new Map([["refs/heads/main", b]]), null, g.read);
    await indexPushedMentions(env, "app", logged, w.lookup);
    expect(w.mentions()).toEqual([
      {
        repo_id: "app",
        commit_oid: a,
        issue_key: "APP-2",
        change_id: "chgaaaa",
        resolution: "linked",
        tracker_owner_id: "ann",
        issue_id: "ann-app-2",
        title: "CORE-1: Rank results",
        committed_at: new Date(AT * 1000).toISOString(),
        first_ref: "refs/heads/main",
      },
      expect.objectContaining({
        commit_oid: a,
        issue_key: "CORE-1",
        tracker_owner_id: "orbit",
        issue_id: "orbit-core-1",
      }),
      expect.objectContaining({
        commit_oid: b,
        issue_key: "NOVA-3",
        change_id: null,
        tracker_owner_id: "nova",
        title: "NOVA-3 docs, ZED-5 isn't ours",
      }),
    ]);
    // A key found in a tier isn't looked for further down; a tracker is asked
    // once (orbit, subscribed, isn't asked again as Ann's org); zed never.
    expect(w.lookups.map((l) => l.owner)).toEqual(["orbit", "ann", "nova"]);
    expect(w.lookups[1]!.keys).not.toContain("CORE-1");
  });

  test("is idempotent: a commit seen again keeps where and when it was first seen", async () => {
    const w = world();
    const commit = {
      oid: oid(1),
      changeId: null,
      message: "APP-2: first",
      committedAt: AT,
      ref: "refs/heads/feature",
    };
    await indexMentions(w.db, "app", [commit], w.lookup);
    const first = w.sqlite.prepare("SELECT pushed_at FROM commit_issue_mentions").get();
    await indexMentions(
      w.db,
      "app",
      [{ ...commit, changeId: "chglater", ref: "refs/heads/main" }, commit],
      w.lookup,
    );
    expect(w.mentions()).toMatchObject([
      { issue_key: "APP-2", first_ref: "refs/heads/feature", change_id: "chglater" },
    ]);
    expect(w.sqlite.prepare("SELECT pushed_at FROM commit_issue_mentions").get()).toEqual(first);
  });

  test("keeps a key two trackers of one tier share unresolved, until one tracker has it", async () => {
    const w = world();
    // A second organization of Ann's with its own DUP-4: nova and it tie.
    w.sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('vega', 'org', 'vega', 'Vega');
      INSERT INTO org_members (org_id, user_id, role) VALUES ('vega', 'ann', 'member');
    `);
    w.trackers.vega = [issue("vega-dup-4", "DUP-4")];
    expect(await trackerTiers(w.db, "app")).toEqual([
      [{ id: "orbit", slug: "orbit" }],
      [{ id: "ann", slug: "ann" }],
      [
        { id: "nova", slug: "nova" },
        { id: "vega", slug: "vega" },
      ],
    ]);
    const commit = { oid: oid(9), changeId: null, message: "DUP-4", committedAt: AT, ref: null };
    expect(await indexMentions(w.db, "app", [commit], w.lookup)).toEqual({
      linked: 0,
      ambiguous: 1,
    });
    expect(w.mentions()).toMatchObject([
      { issue_key: "DUP-4", resolution: "ambiguous", tracker_owner_id: null, issue_id: null },
    ]);
    // Vega's issue goes away: seen again, the key now resolves to nova's.
    w.trackers.vega = [];
    await indexMentions(w.db, "app", [commit], w.lookup);
    expect(w.mentions()).toMatchObject([
      {
        issue_key: "DUP-4",
        resolution: "linked",
        tracker_owner_id: "nova",
        issue_id: "nova-dup-4",
      },
    ]);
  });

  test("in a tie, the repository owner's tracker wins; an org's repository has no org tier", async () => {
    const w = world();
    // lib is orbit's; ann's tracker subscribes to it too, and both have CORE-1.
    w.sqlite.exec(
      `INSERT INTO tracker_repo_subscriptions (tracker_owner_id, repo_id) VALUES ('ann', 'lib'), ('orbit', 'lib')`,
    );
    expect(await trackerTiers(w.db, "lib")).toEqual([
      [
        { id: "ann", slug: "ann" },
        { id: "orbit", slug: "orbit" },
      ],
    ]);
    await indexMentions(
      w.db,
      "lib",
      [{ oid: oid(3), changeId: null, message: "CORE-1 NOVA-3", committedAt: null, ref: null }],
      w.lookup,
    );
    expect(w.mentions()).toMatchObject([
      { issue_key: "CORE-1", resolution: "linked", tracker_owner_id: "orbit", committed_at: null },
    ]);
  });

  test("writes nothing for a deleted repository, or commits without keys", async () => {
    const w = world();
    await indexMentions(
      w.db,
      "gone",
      [{ oid: oid(1), changeId: null, message: "CORE-1", committedAt: AT, ref: null }],
      w.lookup,
    );
    await indexMentions(
      w.db,
      "app",
      [{ oid: oid(2), changeId: null, message: "No keys here", committedAt: AT, ref: null }],
      w.lookup,
    );
    expect(w.mentions()).toEqual([]);
    expect(w.lookups).toEqual([]);
  });
});

describe("the backfill", () => {
  test("reads each live, pushed repository once, newest first, and survives a failed read", async () => {
    const w = world();
    const reads: string[] = [];
    const read: HistoryReader = async (repo, limit) => {
      reads.push(repo.id);
      expect(limit).toBe(2);
      if (repo.id === "lib") throw new Error("Artifacts is down");
      return [
        { oid: oid(1), changeId: null, message: "APP-2 old work", committedAt: AT, ref: null },
      ];
    };
    const env = { DB: w.db } as Env;
    const first = await backfillMentions(env, read, w.lookup, { repos: 5, commits: 2 });
    expect(first).toEqual({ repos: 2, linked: 1, ambiguous: 0, failed: 1 });
    expect(reads).toEqual(["lib", "app"]);
    expect(w.mentions()).toMatchObject([
      { repo_id: "app", issue_key: "APP-2", issue_id: "ann-app-2", first_ref: null },
    ]);
    expect(
      w.sqlite
        .prepare("SELECT repo_id, commits, note FROM commit_mention_backfills ORDER BY repo_id")
        .all(),
    ).toEqual([
      { repo_id: "app", commits: 1, note: null },
      { repo_id: "lib", commits: 0, note: "Artifacts is down" },
    ]);
    expect(await backfillMentions(env, read, w.lookup, { repos: 5, commits: 2 })).toEqual({
      repos: 0,
      linked: 0,
      ambiguous: 0,
      failed: 0,
    });
  });
});

describe("release notes", () => {
  test("resolve a key no subscribed workspace covers through the owner's tracker", async () => {
    const w = world();
    // No tracker reports a subscribed workspace (the live AGENT-1 case).
    const env = {
      DB: w.db,
      TRACKER: {
        getByName: () => ({ subscribedWorkspaces: async () => ({ ok: true, value: [] }) }),
      },
    } as unknown as Env;
    const issues = await repoIssues(
      env,
      { id: "app", owner_id: "ann" },
      ["APP-2", "ZED-5"],
      w.lookup,
    );
    expect(issues.map((i) => [i.key, i.trackerOwner, i.trackerOwnerId, i.id])).toEqual([
      ["APP-2", "ann", "ann", "ann-app-2"],
    ]);
  });
});
