import { describe, expect, test } from "vite-plus/test";
import { parseReleaseQuery, parseReleaseWhen } from "../../shared/release-notes.ts";
import { buildFeed, type FeedRow } from "./feed.ts";

let next = 0;
function row(overrides: Partial<FeedRow> & { subject: string }): FeedRow {
  const issue = overrides.subject.startsWith("issue:");
  return {
    id: `id-${next++}`,
    repo_id: "engine",
    repo_owner: "orbit",
    repo_name: "engine",
    release: "v1",
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
  // The same issue also shipped in the website, and is unreleased there.
  row({
    subject: "issue:orbit:ENG-1",
    repo_id: "website",
    repo_name: "website",
    release: "@unreleased",
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
  test("parses filters, aliases, negation, quoting and unreleased", () => {
    expect(
      parseReleaseQuery(
        'team:Core -category:internal tag:Unreleased label:"needs docs" fast -slow color:red',
      ),
    ).toEqual({
      filters: [
        { key: "team", value: "core", negated: false },
        { key: "type", value: "internal", negated: true },
        { key: "release", value: "@unreleased", negated: false },
        { key: "label", value: "needs docs", negated: false },
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
  test("lists each shipment newest first, within the viewer's access, with facets", () => {
    const all = feed("");
    expect(all.entries.map((e) => [e.title, e.repos[0]!.name, e.release])).toEqual([
      ["Fix deploy rollback", "engine", "v1"],
      ["Faster search", "engine", "v1"],
      ["Faster search (draft)", "website", "@unreleased"],
      ["Bump deps", "engine", "v1"],
    ]);
    expect(all.facets.teams).toEqual([
      { value: "eng", label: "ENG", count: 2 },
      { value: "ops", label: "OPS", count: 1 },
    ]);
    expect(all.facets.releases.map((f) => f.label)).toEqual(["v1", "Unreleased"]);
    expect(all.facets.repos.map((f) => [f.label, f.count])).toEqual([
      ["orbit/engine", 3],
      ["orbit/website", 1],
    ]);
    expect(all.facets.workspaces).toEqual([{ value: "platform", label: "platform", count: 2 }]);
  });

  test("filters by team, repository, workspace, type, label, release, dates and words", () => {
    const titles = (q: string) => feed(q).entries.map((e) => e.title);
    expect(titles("team:ops")).toEqual(["Fix deploy rollback"]);
    expect(titles("-team:eng type:fix")).toEqual(["Fix deploy rollback"]);
    // Narrowed to the website, only its own (unreleased) entry is left.
    expect(titles("repo:website")).toEqual(["Faster search (draft)"]);
    expect(titles("repo:orbit/engine -type:internal")).toEqual([
      "Fix deploy rollback",
      "Faster search",
    ]);
    expect(titles("ws:platform label:web")).toEqual(["Faster search", "Faster search (draft)"]);
    expect(titles("release:unreleased")).toEqual(["Faster search (draft)"]);
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
});
