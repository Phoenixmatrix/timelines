import { describe, expect, test } from "vite-plus/test";
import { d1 } from "../testing/d1.ts";
import { releaseIndex, releaseNotesFor } from "./read.ts";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import { releaseEnvironment, seedReleasePerson, seedReleaseSpace } from "./test-support.ts";

async function setup() {
  const { sqlite } = await releaseEnvironment();
  seedReleasePerson(sqlite, "reader");
  await seedReleaseSpace(sqlite, "acc", "reader");
  await seedReleaseSpace(sqlite, "secret", "reader");
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
    INSERT INTO release_notes (repo_id, release, to_oid, from_tag, released_at, updated_at, intro, intro_model, intro_trackers)
      VALUES ('repo', 'v1', 'c1', NULL, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'v1 intro', 'm', '[]'),
             ('repo', 'v2', 'c5', 'v1', '2026-09-20T00:00:00Z', '2026-10-01T00:00:00Z', 'Shaped by private work.', 'm', '["secret"]'),
             ('repo', '@day:2026-09-30', 'c9', NULL, '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', '', NULL, '[]');
    INSERT INTO release_note_state (repo_id, status, generated_at, format_version) VALUES ('repo', 'ready', '2026-10-01T00:00:00Z', 1);
    UPDATE release_notes SET format_version = 1;
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
          tracker_space_id, issue_id, issue_key, team_id, team_key, issue_type, commits, shipped_at, model, inputs_hash, updated_at)
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
  return { db: d1(sqlite), sqlite };
}

describe("reading release notes", () => {
  test("lists daily digests first, then tags newest first, counting what the viewer can see", async () => {
    const { db } = await setup();
    const member = await releaseIndex(db, "repo", new Map([["acc", "org"]]), true);
    expect(member.status).toEqual({ state: "ready", generatedAt: "2026-10-01T00:00:00Z" });
    expect(member.releases.map((r) => [r.name, r.entries, r.fromTag])).toEqual([
      ["@day:2026-09-30", 0, null],
      ["v2", 4, "v1"],
      ["v1", 0, null],
    ]);
    const anonymous = await releaseIndex(db, "repo", new Map(), false);
    expect(anonymous.status.state).toBe("disabled");
    expect(anonymous.releases[1]!.entries).toBe(2);
  });

  test("Space opt-out reports disabled without hiding stored notes or masking a started generation", async () => {
    const { db, sqlite } = await setup();
    sqlite.exec(`INSERT INTO space_settings (space_id, ai_release_notes) VALUES ('acc', 0);
      UPDATE release_note_state SET status = 'generating', dirty = 1;`);
    const disabled = await releaseIndex(db, "repo", new Map(), true);
    expect(disabled.status.state).toBe("disabled");
    expect(disabled.releases.map((release) => release.name)).toEqual([
      "@day:2026-09-30",
      "v2",
      "v1",
    ]);
    sqlite
      .prepare("UPDATE release_note_state SET ai_snapshot = ?")
      .run(JSON.stringify(LEGACY_AI_SNAPSHOT));
    expect((await releaseIndex(db, "repo", new Map(), true)).status.state).toBe("generating");
    sqlite.exec("UPDATE release_note_state SET status = 'failed'");
    expect((await releaseIndex(db, "repo", new Map(), true)).status.state).toBe("failed");
  });

  test("hides entries and introductions shaped by trackers the viewer can't read", async () => {
    const { db } = await setup();
    const member = (await releaseNotesFor(db, "repo", "v2", new Map([["acc", "org"]])))!;
    // Features newest first, then fixes, then internal work.
    expect(member.entries.map((e) => e.id)).toEqual([
      "later-feature",
      "open-feature",
      "open-fix",
      "chore",
    ]);
    expect(member.entries[1]!.issue).toEqual({
      trackerSpace: "org",
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

  test("timeline scope filters visible daily and tagged entries and suppresses broad introductions", async () => {
    const { db, sqlite } = await setup();
    sqlite.exec(`
      UPDATE release_note_entries SET timeline_branch = 'timeline/search', landing_oid = 'landed'
        WHERE id IN ('open-fix', 'private', 'later-feature');
      UPDATE release_note_entries SET release = '@day:2026-09-30' WHERE id = 'later-feature';
      UPDATE release_note_entries SET timeline_branch = 'timeline/search' WHERE id = 'open-feature';
      UPDATE release_note_entries SET timeline_id = 'search', timeline_branch = 'timeline/other',
        landing_oid = 'other-landing' WHERE id = 'chore';
      UPDATE release_notes SET intro = 'All changes.', intro_model = 'intro-model', intro_trackers = '[]';
    `);
    const trackers = new Map([["acc", "org"]]);
    const scoped = await releaseIndex(db, "repo", trackers, true, "search");
    expect(scoped.releases.map((release) => [release.name, release.entries])).toEqual([
      ["@day:2026-09-30", 1],
      ["v2", 1],
    ]);
    expect(
      (await releaseIndex(db, "repo", new Map(), true, "search")).releases.map((r) => r.name),
    ).toEqual(["@day:2026-09-30"]);
    for (const [name, ids] of [
      ["@day:2026-09-30", ["later-feature"]],
      ["v2", ["open-fix"]],
      ["v1", []],
    ] as const) {
      const notes = (await releaseNotesFor(db, "repo", name, trackers, "search"))!;
      expect(notes.entries.map((entry) => entry.id)).toEqual(ids);
      expect(notes.release).toMatchObject({ entries: ids.length, intro: null, introModel: null });
    }
    const insider = new Map([...trackers, ["secret", "secret-co"]]);
    expect(
      (await releaseNotesFor(db, "repo", "v2", insider, "search"))!.entries.map((e) => e.id),
    ).toEqual(["private", "open-fix"]);
    for (const scope of ["missing", "SEARCH", "timeline/search"]) {
      expect((await releaseIndex(db, "repo", trackers, true, scope)).releases).toEqual([]);
      const notes = (await releaseNotesFor(db, "repo", "v2", trackers, scope))!;
      expect(notes.entries).toEqual([]);
      expect(notes.release).toMatchObject({ entries: 0, intro: null, introModel: null });
    }
    for (const scope of ["", "main"]) {
      expect(await releaseIndex(db, "repo", trackers, true, scope)).toEqual(
        await releaseIndex(db, "repo", trackers, true),
      );
      expect(await releaseNotesFor(db, "repo", "v2", trackers, scope)).toEqual(
        await releaseNotesFor(db, "repo", "v2", trackers),
      );
    }
  });
  test("old format rows and their tracker-shaped introductions stay hidden until cutover", async () => {
    const { db, sqlite } = await setup();
    sqlite.exec("UPDATE release_note_state SET format_version = 0");
    expect(
      (await releaseIndex(db, "repo", new Map([["secret", "secret-co"]]), true)).releases,
    ).toEqual([]);
    expect(await releaseNotesFor(db, "repo", "v2", new Map([["secret", "secret-co"]]))).toBeNull();
    sqlite.exec("UPDATE release_note_state SET format_version = 1");
    const ready = (await releaseNotesFor(db, "repo", "v2", new Map()))!;
    expect(ready.release).toMatchObject({
      kind: "tag",
      lastCommitAt: "2026-09-20T00:00:00Z",
      intro: null,
    });
    expect(ready.entries.map((e) => e.id)).toEqual(["later-feature", "chore"]);
  });
});
