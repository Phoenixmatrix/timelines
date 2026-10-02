import { describe, expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { releaseIndex, releaseNotesFor } from "./read.ts";

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
    INSERT INTO release_notes (repo_id, release, to_oid, from_tag, released_at, updated_at, intro, intro_model, intro_trackers)
      VALUES ('repo', 'v1', 'c1', NULL, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'v1 intro', 'm', '[]'),
             ('repo', 'v2', 'c5', 'v1', '2026-09-20T00:00:00Z', '2026-10-01T00:00:00Z', 'Shaped by private work.', 'm', '["secret"]'),
             ('repo', '@unreleased', 'c9', 'v2', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', '', NULL, '[]');
    INSERT INTO release_note_state (repo_id, status, generated_at) VALUES ('repo', 'ready', '2026-10-01T00:00:00Z');
  `);
  const entry = (
    id: string,
    release: string,
    category: string,
    shipped: string,
    tracker: string | null,
  ) =>
    sqlite
      .prepare(
        `INSERT INTO release_note_entries (id, repo_id, release, subject, kind, category, title, summary,
          tracker_owner_id, issue_id, issue_key, team_id, team_key, issue_type, commits, shipped_at, model, inputs_hash, updated_at)
         VALUES (?, 'repo', ?, ?, ?, ?, ?, 'Summary.', ?, ?, ?, ?, ?, 'task', '["c1"]', ?, 'm', ?, '2026-10-01T00:00:00Z')`,
      )
      .run(
        id,
        release,
        `${tracker ? "issue" : "commit"}:${id}`,
        tracker ? "issue" : "commit",
        category,
        `Title ${id}`,
        tracker,
        tracker && `issue-${id}`,
        tracker && `ENG-${id.length}`,
        tracker && "team",
        tracker && "ENG",
        shipped,
        id,
      );
  entry("open-fix", "v2", "fix", "2026-09-10T00:00:00Z", "acc");
  entry("open-feature", "v2", "feature", "2026-09-05T00:00:00Z", "acc");
  entry("private", "v2", "feature", "2026-09-15T00:00:00Z", "secret");
  entry("chore", "v2", "internal", "2026-09-16T00:00:00Z", null);
  entry("later-feature", "v2", "feature", "2026-09-12T00:00:00Z", null);
  return { db: d1(sqlite) };
}

describe("reading release notes", () => {
  test("lists unreleased first, then tags newest first, counting what the viewer can see", async () => {
    const { db } = setup();
    const member = await releaseIndex(db, "repo", new Map([["acc", "org"]]), true);
    expect(member.status).toEqual({ state: "ready", generatedAt: "2026-10-01T00:00:00Z" });
    expect(member.releases.map((r) => [r.name, r.entries, r.fromTag])).toEqual([
      ["@unreleased", 0, "v2"],
      ["v2", 4, "v1"],
      ["v1", 0, null],
    ]);
    const anonymous = await releaseIndex(db, "repo", new Map(), false);
    expect(anonymous.status.state).toBe("disabled");
    expect(anonymous.releases[1]!.entries).toBe(2);
  });

  test("hides entries and introductions shaped by trackers the viewer can't read", async () => {
    const { db } = setup();
    const member = (await releaseNotesFor(db, "repo", "v2", new Map([["acc", "org"]])))!;
    // Features newest first, then fixes, then internal work.
    expect(member.entries.map((e) => e.id)).toEqual([
      "later-feature",
      "open-feature",
      "open-fix",
      "chore",
    ]);
    expect(member.entries[1]!.issue).toEqual({
      trackerOwner: "org",
      id: "issue-open-feature",
      key: "ENG-12",
      type: "task",
      team: { id: "team", key: "ENG" },
    });
    expect(member.release).toMatchObject({ intro: null, introModel: null, entries: 4 });

    const insider = (await releaseNotesFor(
      db,
      "repo",
      "v2",
      new Map([
        ["acc", "org"],
        ["secret", "secret-co"],
      ]),
    ))!;
    expect(insider.entries.map((e) => e.id)).toContain("private");
    expect(insider.release.intro).toBe("Shaped by private work.");

    const anonymous = (await releaseNotesFor(db, "repo", "v2", new Map()))!;
    expect(anonymous.entries.map((e) => e.kind)).toEqual(["commit", "commit"]);
    expect((await releaseNotesFor(db, "repo", "v1", new Map()))!.release.intro).toBe("v1 intro");
    expect(await releaseNotesFor(db, "repo", "v9", new Map())).toBeNull();
  });
});
