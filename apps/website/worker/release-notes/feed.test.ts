import { describe, expect, test } from "vite-plus/test";
import { parseReleaseQuery, parseReleaseWhen } from "../../shared/release-notes.ts";
import { buildFeed, releaseFeed, type FeedRow } from "./feed.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";

let next = 0;
function row(overrides: Partial<FeedRow> & { subject: string }): FeedRow {
  const issue = overrides.subject.startsWith("issue:");
  return {
    id: `id-${next++}`,
    repo_id: "engine",
    repo_owner: "orbit",
    repo_name: "engine",
    release: "@day:2026-09-20",
    kind: issue ? "issue" : "commit",
    category: "feature",
    title: "A change",
    summary: "It changed.",
    tracker_owner_id: issue ? "orbit" : null,
    issue_id: issue ? "issue-id" : null,
    issue_key: issue ? overrides.subject.split(":")[2]! : null,
    team_id: issue ? "team-eng" : null,
    team_key: issue ? "ENG" : null,
    issue_type: issue ? "task" : null,
    labels: "[]",
    workspace_ids: "[]",
    commits: '["c1"]',
    changes: "[]",
    shipped_at: "2026-09-10T00:00:00.000Z",
    model: "m",
    inputs_hash: "h",
    updated_at: "2026-10-01T00:00:00.000Z",
    landing_oid: null,
    timeline_id: null,
    timeline_branch: null,
    provenance: "[]",
    regeneration_inputs: "{}",
    ...overrides,
  };
}

const rows = (): FeedRow[] => [
  row({
    subject: "issue:orbit:ENG-1",
    title: "Faster search",
    labels: '["web"]',
    workspace_ids: '["ws-platform"]',
    shipped_at: "2026-09-20T00:00:00.000Z",
  }),
  // The same issue has an independent code update in the website.
  row({
    subject: "issue:orbit:ENG-1",
    repo_id: "website",
    repo_name: "website",
    release: "@day:2026-09-21",
    title: "Faster search (draft)",
    commits: '["w1"]',
    labels: '["web"]',
    workspace_ids: '["ws-platform"]',
    shipped_at: "2026-09-20T00:00:00.000Z",
  }),
  row({
    subject: "issue:orbit:OPS-3",
    category: "fix",
    title: "Fix deploy rollback",
    team_id: "team-ops",
    team_key: "OPS",
    shipped_at: "2026-09-25T00:00:00.000Z",
  }),
  row({
    subject: "commit:c9",
    category: "internal",
    title: "Bump deps",
    shipped_at: "2026-08-01T00:00:00.000Z",
  }),
  // From a tracker the viewer can't read, and from a repository they can't see.
  row({ subject: "issue:secret:SEC-1", tracker_owner_id: "secret", title: "Secret work" }),
  row({ subject: "commit:p1", repo_id: "private", repo_name: "private", title: "Private repo" }),
];

const feed = (q: string) =>
  buildFeed(rows(), {
    trackers: new Map([["orbit", "orbit"]]),
    visibleRepoIds: new Set(["engine", "website"]),
    workspaces: new Map([["ws-platform", "platform"]]),
    query: parseReleaseQuery(q),
    now: Date.parse("2026-10-01T00:00:00Z"),
    limit: 50,
  });

describe("release feed query", () => {
  test("parses filters, aliases, negation, quoting and daily selectors", () => {
    expect(
      parseReleaseQuery(
        'team:Core -category:internal tag:day:2026-09-21 label:"needs docs" fast -slow color:red',
      ),
    ).toEqual({
      filters: [
        { key: "team", value: "core", negated: false },
        { key: "type", value: "internal", negated: true },
        { key: "release", value: "@day:2026-09-21", negated: false },
        { key: "tag", value: "needs docs", negated: false },
      ],
      words: [
        { text: "fast", negated: false },
        { text: "slow", negated: true },
      ],
      unknown: ["color:red"],
    });
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(parseReleaseWhen("2w", now)).toBe("2026-09-17T00:00:00.000Z");
    expect(parseReleaseWhen("2026-09-01", now)).toBe("2026-09-01T00:00:00.000Z");
    expect(parseReleaseWhen("last week", now)).toBeNull();
  });
});

describe("release feed", () => {
  test("entries show the timeline they landed with, and searches match its branch", () => {
    const feed = (q: string, trackers = new Map([["orbit", "orbit"]])) =>
      buildFeed(
        [
          row({
            subject: "landing:l1",
            kind: "landing",
            title: "Polish styles",
            landing_oid: "l1",
            timeline_branch: "timeline/polish",
          }),
          row({
            subject: "issue:orbit:ENG-1",
            title: "Faster search",
            landing_oid: "l2",
            timeline_branch: "timeline/search",
          }),
        ],
        {
          trackers,
          visibleRepoIds: new Set(["engine"]),
          workspaces: new Map(),
          query: parseReleaseQuery(q),
          now: Date.parse("2026-10-01T00:00:00Z"),
          limit: 50,
        },
      );
    const landed = (q: string, trackers?: Map<string, string>) => feed(q, trackers).entries;
    expect(landed("timeline/search").map((e) => [e.title, e.timeline])).toEqual([
      ["Faster search", { id: null, branch: "timeline/search", landing: "l2" }],
    ]);
    // A landing's own entry cites no issue, so any reader of the repository sees it.
    expect(landed("", new Map()).map((e) => [e.kind, e.title])).toEqual([
      ["landing", "Polish styles"],
    ]);
    // In a timeline's scope the page offers what it landed as a filter (CORE-82).
    expect(landed("timeline:polish").map((e) => e.title)).toEqual(["Polish styles"]);
    expect(landed("-timeline:polish").map((e) => e.title)).toEqual(["Faster search"]);
    expect(feed("").facets.timelines?.map((f) => [f.value, f.label, f.count])).toEqual([
      ["polish", "timeline/polish", 1],
      ["search", "timeline/search", 1],
    ]);
  });

  test("lists each daily update newest first, within the viewer's access, with facets", () => {
    const all = feed("");
    expect(all.entries.map((e) => [e.title, e.repos[0]!.name, e.release])).toEqual([
      ["Fix deploy rollback", "engine", "@day:2026-09-20"],
      ["Faster search", "engine", "@day:2026-09-20"],
      ["Faster search (draft)", "website", "@day:2026-09-21"],
      ["Bump deps", "engine", "@day:2026-09-20"],
    ]);
    expect(all.facets.teams).toEqual([
      { value: "eng", label: "ENG", count: 2 },
      { value: "ops", label: "OPS", count: 1 },
    ]);
    expect(all.facets.releases.map((f) => f.label)).toEqual(["2026-09-20", "2026-09-21"]);
    expect(all.facets.repos.map((f) => [f.label, f.count])).toEqual([
      ["orbit/engine", 3],
      ["orbit/website", 1],
    ]);
    expect(all.facets.workspaces).toEqual([{ value: "platform", label: "platform", count: 2 }]);
  });

  test("filters by team, repository, workspace, type, tag, release, dates and words", () => {
    const titles = (q: string) => feed(q).entries.map((e) => e.title);
    expect(titles("team:ops")).toEqual(["Fix deploy rollback"]);
    expect(titles("-team:eng type:fix")).toEqual(["Fix deploy rollback"]);
    // Narrowed to the website, only its own entry is left.
    expect(titles("repo:website")).toEqual(["Faster search (draft)"]);
    expect(titles("repo:orbit/engine -type:internal")).toEqual([
      "Fix deploy rollback",
      "Faster search",
    ]);
    expect(titles("ws:platform tag:web")).toEqual(["Faster search", "Faster search (draft)"]);
    // label: is the old spelling of tag: (CORE-271), and the facet keeps its old name too.
    expect(titles("ws:platform label:web")).toEqual(["Faster search", "Faster search (draft)"]);
    expect(titles("-label:web")).toEqual(titles("-tag:web"));
    expect(feed("").facets.labels).toEqual(feed("").facets.tags);
    expect(titles("release:day:2026-09-21")).toEqual(["Faster search (draft)"]);
    expect(titles("since:2026-09-21")).toEqual(["Fix deploy rollback"]);
    expect(titles("until:30d")).toEqual(["Bump deps"]);
    expect(titles("rollback")).toEqual(["Fix deploy rollback"]);
    expect(titles("ENG-1")).toEqual(["Faster search", "Faster search (draft)"]);
    const bad = feed("since:yesterday");
    expect(bad.query.unknown).toEqual(["since:yesterday"]);
    expect(bad.entries).toHaveLength(4);
  });

  test("caps what it returns and reports the rest", () => {
    const capped = buildFeed(rows(), {
      trackers: new Map([["orbit", "orbit"]]),
      visibleRepoIds: new Set(["engine", "website"]),
      workspaces: new Map(),
      query: parseReleaseQuery(""),
      now: 0,
      limit: 1,
    });
    expect(capped.entries).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(capped.facets.categories.reduce((n, f) => n + f.count, 0)).toBe(4);
  });
  test("tags coexist without duplicating the default feed; explicit selectors obey negation and access", () => {
    const daily = row({ subject: "commit:c1" });
    const tagged = { ...daily, id: "tagged", release: "v1" };
    const secret = row({
      subject: "issue:secret:SEC-1",
      release: "v1",
      tracker_owner_id: "secret",
    });
    const privateRepo = row({ subject: "commit:p1", release: "v1", repo_id: "private" });
    const selected = (q: string) =>
      buildFeed([daily, tagged, secret, privateRepo], {
        trackers: new Map([["orbit", "orbit"]]),
        visibleRepoIds: new Set(["engine"]),
        workspaces: new Map(),
        query: parseReleaseQuery(q),
        now: 0,
        limit: 50,
      }).entries.map((e) => e.id);
    expect(selected("")).toEqual([daily.id]);
    expect(selected("-release:other")).toEqual([daily.id]);
    expect(selected("kind:daily")).toEqual([daily.id]);
    expect(selected("kind:tag")).toEqual(["tagged"]);
    expect(selected("-kind:daily")).toEqual(["tagged"]);
    expect(selected("-kind:tag")).toEqual([daily.id]);
    expect(selected("release:v1")).toEqual(["tagged"]);
    expect(selected("release:v1 -kind:tag")).toEqual([]);
    expect(selected("release:day:2026-09-20")).toEqual([daily.id]);
    // Before CORE-271 tag: meant release:; a tag: naming a release still selects it.
    expect(selected("tag:v1")).toEqual(["tagged"]);
    expect(selected("tag:day:2026-09-20")).toEqual([daily.id]);
  });
  test("tracker reads lazily upgrade only accessible related repositories and conceal stale rows", async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES
        ('ann', 'user', 'ann', 'Ann'), ('orbit', 'org', 'orbit', 'Orbit'),
        ('other', 'org', 'other', 'Other');
      UPDATE accounts SET member_repo_role = 'read' WHERE id = 'orbit';
      INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'member');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
        ('owned', 'orbit', 'app', 'private', 'a', 'https://a'),
        ('public', 'other', 'public', 'public', 'b', 'https://b'),
        ('private', 'other', 'private', 'private', 'c', 'https://c');
      INSERT INTO tracker_repo_subscriptions (tracker_owner_id, repo_id) VALUES
        ('orbit', 'public'), ('orbit', 'private');
      INSERT INTO release_note_state (repo_id, status) VALUES ('owned', 'ready');
      INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at) VALUES
        ('owned', '@day:2026-09-20', 'c1', '2026-09-20', '2026-09-20'),
        ('owned', 'v1', 'c1', '2026-09-20', '2026-09-20');
      INSERT INTO release_note_entries
        (id, repo_id, release, subject, kind, category, title, summary, inputs_hash, shipped_at, updated_at) VALUES
        ('day', 'owned', '@day:2026-09-20', 'commit:c1', 'commit', 'feature', 'Feature', 'Change', 'h', '2026-09-20', '2026-09-20'),
        ('tag', 'owned', 'v1', 'commit:c1', 'commit', 'feature', 'Feature', 'Change', 'h', '2026-09-20', '2026-09-20');
    `);
    const sent: unknown[] = [];
    const env = {
      DB: d1(sqlite),
      AI: {},
      JOBS: { send: async (body: unknown) => void sent.push(body) },
      TRACKER: { getByName: () => ({ workspaceSlugs: async () => ({ ok: true, value: [] }) }) },
    } as unknown as Env;
    const actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
    await expect(releaseFeed(env, null, "orbit", "")).rejects.toMatchObject({ status: 401 });
    expect(sent).toEqual([]);
    expect((await releaseFeed(env, actor, "orbit", "")).entries).toEqual([]);
    expect(sent).toEqual(
      expect.arrayContaining([
        { type: "release-notes", repoId: "owned" },
        { type: "release-notes", repoId: "public" },
      ]),
    );
    await releaseFeed(env, actor, "orbit", "");
    expect(sent).toHaveLength(2);
    sqlite.exec(`UPDATE release_note_state SET format_version = 1, dirty = 0, status = 'ready' WHERE repo_id = 'owned';
      UPDATE release_notes SET format_version = 1;`);
    expect((await releaseFeed(env, actor, "orbit", "")).entries.map((e) => e.id)).toEqual(["day"]);
    expect((await releaseFeed(env, actor, "orbit", "kind:tag")).entries.map((e) => e.id)).toEqual([
      "tag",
    ]);
    expect((await releaseFeed(env, actor, "orbit", "release:v1")).entries.map((e) => e.id)).toEqual(
      ["tag"],
    );
  });
});
