import { describe, expect, test, vi } from "vite-plus/test";
import type { LinkedIssue } from "../../shared/release-notes.ts";
import { AI_MODEL_CATALOG, LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import type { RepoRefs } from "../artifacts.ts";
import { generateReleaseNotes, type GeneratorSource } from "./generate.ts";
import {
  ensureReleaseNotes,
  notifyReleaseNotes,
  runReleaseNotesJob,
  type ReleaseNotesJob,
} from "./queue.ts";
import { releaseIndex, releaseNotesFor, toEntry, type EntryRow } from "./read.ts";
import { RepoReader } from "../objects.ts";
import { landedTimelines } from "./timelines.ts";
import { releaseNotes } from "../retention/cleanups/release-notes.ts";
import * as semantic from "../semantic/feed.ts";
import {
  releaseActor,
  releaseEnvironment,
  seedReleasePerson,
  seedReleaseSpace,
} from "./test-support.ts";
import { resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";

const actor = releaseActor("initiator");
const authority: WorkAuthority = {
  spaceId: "acc",
  migrationEpoch: 0,
  personId: actor.id,
  agentId: null,
  credential: actor.credential!,
};

const DAY = `@day:${new Date(1_790_000_000_000).toISOString().slice(0, 10)}`;

interface Call {
  model: string;
  prompt: string;
}

function issue(key: string, overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    id: `id-${key}`,
    key,
    title: `Title of ${key}`,
    description: `What ${key} asks for.`,
    type: "task",
    status: "done",
    labels: ["web"],
    projectIds: ["ws"],
    team: { id: "team", key: "ENG", name: "Engineering" },
    completedAt: "2026-09-01T00:00:00.000Z",
    evidence: [{ body: `Shipped ${key}`, actorId: "a", createdAt: "2026-09-01T00:00:00.000Z" }],
    trackerSpace: "acc",
    trackerSpaceId: "acc",
    ...overrides,
  };
}

/** A repository with linear history, tags, tracker issues and a fake model. */
async function setup() {
  const { sqlite, env } = await releaseEnvironment();
  seedReleasePerson(sqlite, actor.id);
  await seedReleaseSpace(sqlite, "acc", actor.id);
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const calls: Call[] = [];
  const AI = {
    async run(model: string, inputs: { messages: { content: string }[] }) {
      const prompt = inputs.messages[1]?.content ?? "";
      calls.push({ model, prompt });
      const content = inputs.messages[0]?.content.includes("You summarize")
        ? `Intro over ${prompt.split("\n").length} entries.`
        : JSON.stringify({
            category: prompt.includes("chore")
              ? "internal"
              : prompt.includes("fix")
                ? "fix"
                : "feature",
            title: `Entry: ${/^- (.*)$/m.exec(prompt)?.[1] ?? "?"}`,
            summary: "It changed.",
          });
      return {
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      };
    },
  };
  env.AI = AI as unknown as NonNullable<Env["AI"]>;
  // node:sqlite permits more bindings than deployed D1.
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      if (values.length > 100) throw new Error(`D1 binding limit exceeded: ${values.length}`);
      return bind(...values);
    };
    return statement;
  };

  // Every commit, oldest first; `head` is the default branch.
  const history = new Map<string, ArtifactsCommitMetadata>();
  let head: string | null = null;
  const tags = new Map<string, string>();
  const issues = new Map<string, LinkedIssue>();
  /** A commit off `parents` (default: the head) that moves the head unless `branch` is set. */
  const commit = (
    message: string,
    committedAt = 1_790_000_000 + history.size,
    authoredAt = committedAt,
    { parents = head ? [head] : [], branch = false }: { parents?: string[]; branch?: boolean } = {},
  ) => {
    const hash = `c${history.size}`;
    history.set(hash, {
      hash,
      message,
      author: { name: "A", email: "a@example.com" },
      authoredAt,
      committedAt,
      parents,
    } as unknown as ArtifactsCommitMetadata);
    if (!branch) head = hash;
    return hash;
  };
  const source: GeneratorSource = {
    authorize: async () => {
      await resolveWorkAuthority(env, authority, "repo");
    },
    async refs(): Promise<RepoRefs> {
      return {
        headBranch: "main",
        head,
        branches: head
          ? [{ name: "refs/heads/main", shortName: "main", kind: "branch", oid: head }]
          : [],
        tags: [...tags]
          .map(([name, oid]) => ({
            name: `refs/tags/${name}`,
            shortName: name,
            kind: "tag" as const,
            oid,
          }))
          .sort((a, b) => b.shortName.localeCompare(a.shortName, undefined, { numeric: true })),
      };
    },
    async log(oid, limit, offset) {
      const line: ArtifactsCommitMetadata[] = [];
      for (let at = history.get(oid); at; at = history.get(at.parents[0] ?? "")) line.push(at);
      return line.slice(offset, offset + limit);
    },
    async commit(oid) {
      return history.get(oid) ?? null;
    },
    timelines: (merges) => landedTimelines(env.DB, "repo", "main", merges),
    async issues(keys) {
      return keys.flatMap((key) => (issues.has(key) ? [issues.get(key)!] : []));
    },
    async changes(oid) {
      return [{ kind: "function.added", name: `fn_${oid}`, path: "src/a.ts", summary: "Added." }];
    },
  };
  const run = async (options: { maxModelCalls?: number } = {}) => {
    const before = calls.length;
    const result = await generateReleaseNotes(env, "repo", source, LEGACY_AI_SNAPSHOT.models, {
      ...options,
      now: () => "2026-10-02T00:00:00.000Z",
    });
    return { ...result, newCalls: calls.slice(before) };
  };
  const entries = (release: string) =>
    sqlite
      .prepare(
        "SELECT subject, kind, category, title, issue_key, team_key, commits, changes, shipped_at, landing_oid, timeline_id, timeline_branch FROM release_note_entries WHERE release = ? ORDER BY subject",
      )
      .all(release) as Record<string, string>[];
  const release = (name: string) =>
    sqlite.prepare("SELECT * FROM release_notes WHERE release = ?").get(name) as
      | Record<string, string | number | null>
      | undefined;
  return { sqlite, env, source, calls, commit, tags, issues, run, entries, release };
}

describe("release note generation", () => {
  test("compact landing groups exact durable source inputs and regenerates after work Git expires", async () => {
    const r = await setup();
    r.issues.set("ENG-1", issue("ENG-1"));
    const base = r.commit("Initial import");
    const wip = r.commit("Implement parser ENG-1", undefined, undefined, {
      parents: [base],
      branch: true,
    });
    const revised = r.commit("Finish parser ENG-1", undefined, undefined, {
      parents: [wip],
      branch: true,
    });
    const input = [await r.source.commit(revised), await r.source.commit(wip)];
    const compact = r.commit("Land parser", undefined, undefined, { parents: [base] });
    r.sqlite.exec(`
      INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,created_at,updated_at)
      VALUES('work_parser','repo','tl_parser','parser','acc','work-physical','https://work','archived','allocation','canonical','${base}','base-tree','refs/heads/main','canonical','${base}','base-tree','refs/heads/main',1,'now','now');
      INSERT INTO source_integration_receipts(id,landing_id,checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at)
      VALUES('receipt','landing','checkpoint','repo','work_parser','${revised}','work-tree','{}','[]','${base}','${compact}','compact-tree',0,'complete','now','now');
    `);
    r.sqlite
      .prepare(
        "INSERT INTO source_integration_inputs(receipt_id,repo_id,commits_json) VALUES('receipt','repo',?)",
      )
      .run(JSON.stringify(input));
    const readCommit = r.source.commit.bind(r.source);
    r.source.commit = async (oid) => {
      if (oid === wip || oid === revised)
        throw new Error("WIP object must never be read in canonical");
      return readCommit(oid);
    };
    const changed: string[] = [];
    r.source.changes = async (oid) => {
      if (oid === wip || oid === revised) throw new Error("Source diff requested from canonical");
      changed.push(oid);
      return [
        { kind: "function.added", name: "parser", path: "parser.ts", summary: "Added parser" },
      ];
    };
    await r.run();
    const first = r.entries(DAY);
    expect(first.find((entry) => entry.issue_key === "ENG-1")).toMatchObject({
      commits: JSON.stringify([compact]),
      landing_oid: compact,
      timeline_id: "tl_parser",
    });
    expect(changed).toContain(compact);
    const saved = r.sqlite
      .prepare(
        "SELECT provenance, regeneration_inputs FROM release_note_entries WHERE issue_key='ENG-1'",
      )
      .get() as { provenance: string; regeneration_inputs: string };
    expect(JSON.parse(saved.provenance)).toEqual([
      {
        source: {
          sourceId: "work_parser",
          repoId: "repo",
          timelineId: "tl_parser",
          kind: "timeline-work",
          ref: "refs/heads/work",
          commit: revised,
          tree: "work-tree",
        },
        receiptId: "receipt",
        commits: [revised, wip],
      },
    ]);
    expect(
      JSON.parse(saved.regeneration_inputs).commits.map(
        (commit: ArtifactsCommitMetadata) => commit.hash,
      ),
    ).toEqual([revised, wip]);
    r.sqlite.exec(
      "UPDATE timeline_work_sources SET state='purged', artifacts_remote=NULL; DELETE FROM release_note_entries; DELETE FROM release_notes;",
    );
    await r.run();
    expect(r.entries(DAY)).toEqual(first);
  });

  test("groups commits under the issues they cite, writes each entry once, and introduces the release", async () => {
    const r = await setup();
    r.issues.set("ENG-1", issue("ENG-1"));
    r.commit("Initial import");
    r.commit("Start the parser (ENG-1)");
    r.tags.set("v1.0.0", r.commit("Finish the parser, ENG-1"));
    r.commit("Decode UTF-8 names");
    r.commit("chore: bump deps");

    const first = await r.run();
    expect(first).toMatchObject({ releases: 2, more: false });
    // Four daily entries, reused by the tag snapshot, plus one intro each.
    expect(first.newCalls.filter((c) => c.model.includes("glm"))).toHaveLength(4);
    expect(first.newCalls.filter((c) => c.model.includes("qwen3.8"))).toHaveLength(2);

    const tagged = r.entries("v1.0.0");
    expect(tagged.map((e) => [e.subject, e.kind, e.issue_key])).toEqual([
      ["commit:c0", "commit", null],
      ["issue:acc:ENG-1", "issue", "ENG-1"],
    ]);
    const parser = tagged[1]!;
    expect(JSON.parse(parser.commits!)).toEqual(["c2", "c1"]);
    expect(parser).toMatchObject({
      team_key: "ENG",
      category: "feature",
      shipped_at: new Date(1_790_000_002_000).toISOString(),
    });
    expect(JSON.parse(parser.changes!)).toHaveLength(2);

    expect(r.entries(DAY).map((e) => [e.subject, e.category])).toEqual([
      ["commit:c0", "feature"],
      ["commit:c3", "feature"],
      ["commit:c4", "internal"],
      ["issue:acc:ENG-1", "feature"],
    ]);
    expect(r.release("v1.0.0")).toMatchObject({
      to_oid: "c2",
      from_oid: null,
      intro_trackers: '["acc"]',
    });
    expect(r.release(DAY)).toMatchObject({
      from_tag: null,
      from_oid: null,
      intro_trackers: '["acc"]',
    });
    const mentions = r.sqlite
      .prepare("SELECT issue_key FROM release_note_mentions ORDER BY issue_key")
      .all()
      .map((row) => row.issue_key);
    expect(mentions).toEqual(["ENG-1", "UTF-8"]);
  });

  test("a landing's work joins its issues' entries, labelled with its timeline; the rest is one landing entry", async () => {
    const r = await setup();
    r.issues.set("ENG-1", issue("ENG-1"));
    const base = r.commit("Initial import");
    const side = (message: string, parents: string[]) =>
      r.commit(message, undefined, undefined, { parents, branch: true });
    const start = side("Start search (ENG-1)", [base]);
    const tidy = side("Tidy fixtures", [start]);
    const main = r.commit("Decode UTF-8 names");
    const synced = side("Merge main", [tidy, main]);
    const finish = side("Finish search, ENG-1", [synced]);
    // The push log saw the checkpoint on the timeline's branch.
    r.sqlite.exec(
      `INSERT INTO ref_updates (repo_id, ref, old_oid, new_oid) VALUES ('repo', 'refs/heads/timeline/search', NULL, '${finish}')`,
    );
    const landing = r.commit("Land checkpoint", undefined, undefined, {
      parents: [main, finish],
    });
    const polish = side("Polish styles", [landing]);
    const second = r.commit("Merge branch 'timeline/polish'", undefined, undefined, {
      parents: [landing, polish],
    });

    const run = await r.run();
    expect(run.more).toBe(false);
    const entries = r.entries(DAY);
    expect(
      entries.map((e) => [e.subject, e.kind, JSON.parse(e.commits!), e.timeline_branch]),
    ).toEqual([
      [`commit:${base}`, "commit", [base], null],
      [`commit:${main}`, "commit", [main], null],
      ["issue:acc:ENG-1", "issue", [finish, start], "timeline/search"],
      // The timeline's sync with main is no one's work; the landing heads its entry.
      [`landing:${landing}`, "landing", [landing, tidy], "timeline/search"],
      [`landing:${second}`, "landing", [second, polish], "timeline/polish"],
    ]);
    const search = entries[2]!;
    expect(search).toMatchObject({ landing_oid: landing, timeline_id: null });
    // Landed work shipped when it landed.
    expect(search.shipped_at).toBe(new Date(1_790_000_006_000).toISOString());
    // A merge's own diff is everything it landed: entries use their commits'.
    expect(JSON.parse(entries[3]!.changes!).map((c: { name: string }) => c.name)).toEqual([
      `fn_${tidy}`,
    ]);

    const row = r.sqlite
      .prepare("SELECT * FROM release_note_entries WHERE subject = 'issue:acc:ENG-1'")
      .get() as EntryRow;
    expect(toEntry(row, new Map([["acc", "org"]]))!.timeline).toEqual({
      id: null,
      branch: "timeline/search",
      landing,
    });
    // Commits on the default branch carry no timeline.
    const direct = r.sqlite
      .prepare(`SELECT * FROM release_note_entries WHERE subject = 'commit:${main}'`)
      .get() as EntryRow;
    expect(toEntry(direct, new Map())!.timeline).toBeNull();
  });

  test("same-day pushes reuse unchanged entries; tags coexist without rewriting them", async () => {
    const r = await setup();
    r.issues.set("ENG-2", issue("ENG-2"));
    r.tags.set("v1", r.commit("Base"));
    r.commit("Add search (ENG-2)");
    await r.run();
    expect((await r.run()).newCalls).toEqual([]);

    r.commit("fix: search ranking");
    const push = await r.run();
    expect(push.newCalls.map((c) => c.model.includes("glm"))).toEqual([true, false]);
    expect(r.entries(DAY)).toHaveLength(3);

    // Tagging the head copies matching entries without rewriting them.
    r.tags.set("v2", "c2");
    const tag = await r.run();
    expect(tag.newCalls.filter((c) => c.model.includes("glm"))).toEqual([]);
    expect(r.entries("v2").map((e) => e.subject)).toEqual(["commit:c2", "issue:acc:ENG-2"]);
    expect(r.entries(DAY)).toHaveLength(3);
    expect(r.release(DAY)).toMatchObject({ from_tag: null, from_oid: null });
  });

  test("a changed issue rewrites its entry; unresolved keys and lost tags drop out", async () => {
    const r = await setup();
    r.issues.set(
      "ENG-3",
      issue("ENG-3", { status: "in_progress", completedAt: null, evidence: [] }),
    );
    r.tags.set("v1", r.commit("Base"));
    r.tags.set("v2", r.commit("Export CSV (ENG-3)"));
    await r.run();
    expect(r.entries("v2")[0]!.shipped_at).toBe(new Date(1_790_000_001_000).toISOString());

    r.issues.set("ENG-3", issue("ENG-3"));
    const completed = await r.run();
    expect(completed.newCalls.filter((c) => c.model.includes("glm"))).toHaveLength(1);
    expect(r.entries("v2")[0]!.shipped_at).toBe(new Date(1_790_000_001_000).toISOString());

    // The issue leaves the tracker's reach: the commit stands alone.
    r.issues.clear();
    await r.run();
    expect(r.entries("v2").map((e) => e.subject)).toEqual(["commit:c1"]);

    r.tags.delete("v2");
    await r.run();
    expect(r.release("v2")).toBeUndefined();
    expect(r.entries("v2")).toEqual([]);
  });

  test("a model budget leaves the rest for the next run without losing earlier entries", async () => {
    const r = await setup();
    for (let i = 0; i < 4; i++) r.commit(`Change ${i}`);
    const partial = await r.run({ maxModelCalls: 2 });
    expect(partial.more).toBe(true);
    expect(r.entries(DAY)).toHaveLength(2);
    expect(r.release(DAY)!.intro).toBe("");
    const rest = await r.run({ maxModelCalls: 10 });
    expect(rest.more).toBe(false);
    expect(r.entries(DAY)).toHaveLength(4);
    expect(rest.modelCalls).toBe(3);
  });

  test("large daily groups converge, preserve pending entries and prune stale subjects within D1 limits", async () => {
    const r = await setup();
    const commits = Array.from({ length: 120 }, (_, i) => r.commit(`Change ${i}`));
    const subjects = commits.map((hash) => `commit:${hash}`).sort();
    try {
      for (let pass = 0; pass < 3; pass++) {
        expect((await r.run()).more).toBe(true);
        expect(r.entries(DAY).map((e) => e.subject)).toEqual(
          commits
            .slice(-(pass + 1) * 40)
            .map((hash) => `commit:${hash}`)
            .sort(),
        );
      }
      expect((await r.run()).more).toBe(false);
      expect(r.entries(DAY).map((e) => e.subject)).toEqual(subjects);
      expect(r.release(DAY)!.format_version).toBe(1);

      // Changed drafts with no remaining budget must retain their previous output.
      const log = r.source.log.bind(r.source);
      r.source.log = async (...args) =>
        (await log(...args)).map((commit) => ({ ...commit, message: `Updated ${commit.message}` }));
      const previous = r.entries(DAY);
      expect((await r.run({ maxModelCalls: 0 })).more).toBe(true);
      expect(r.entries(DAY)).toEqual(previous);

      // Resolve 110 commits into one issue, requiring more than one stale-ID batch.
      r.issues.set("ENG-1", issue("ENG-1"));
      const grouped = new Set(commits.slice(0, 110));
      r.source.log = async (...args) =>
        (await log(...args)).map((commit) =>
          grouped.has(commit.hash) ? { ...commit, message: `${commit.message} ENG-1` } : commit,
        );
      expect((await r.run()).more).toBe(false);
      const entries = r.entries(DAY);
      expect(entries.map((e) => e.subject)).toEqual(
        [...commits.slice(110).map((hash) => `commit:${hash}`), "issue:acc:ENG-1"].sort(),
      );
      expect(JSON.parse(entries.find((e) => e.subject === "issue:acc:ENG-1")!.commits!)).toEqual(
        commits.slice(0, 110).reverse(),
      );
    } finally {
      r.sqlite.close();
    }
  });
  test("UTC committer days group noncontiguous ancestry, never author or completion dates", async () => {
    const r = await setup();
    r.issues.set("ENG-1", issue("ENG-1", { completedAt: "2040-01-01T00:00:00Z" }));
    const seconds = (date: string) => Date.parse(date) / 1000;
    r.commit("Older ancestry ENG-1", seconds("2026-09-02T23:59:00Z"), seconds("2020-01-01"));
    r.commit("Previous UTC day", seconds("2026-09-02T00:30:00+02:00"));
    r.commit("Head ENG-1", seconds("2026-09-02T01:00:00Z"), seconds("2030-01-01"));
    const result = await r.run();
    expect(result).toMatchObject({ releases: 2, more: false });
    expect(r.release("@day:2026-09-02")).toMatchObject({
      to_oid: "c2",
      from_oid: null,
      from_tag: null,
      released_at: "2026-09-02T23:59:00.000Z",
    });
    expect(r.entries("@day:2026-09-02")[0]).toMatchObject({
      commits: '["c2","c0"]',
      shipped_at: "2026-09-02T23:59:00.000Z",
    });
    expect(r.entries("@day:2026-09-01").map((e) => e.subject)).toEqual(["commit:c1"]);
    expect(r.release("@unreleased")).toBeUndefined();
  });

  test("empty histories persist no daily group and stale days and sentinels disappear", async () => {
    const r = await setup();
    r.sqlite.exec(`INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at)
      VALUES ('repo', '@unreleased', 'old', '2020-01-01', '2020-01-01'),
      ('repo', '@day:2020-01-01', 'old', '2020-01-01', '2020-01-01')`);
    expect((await r.run()).releases).toBe(0);
    expect(r.sqlite.prepare("SELECT release FROM release_notes").all()).toEqual([]);
  });
  test("retention removes old releases' notes and mentions, keeps the latest, and they never come back", async () => {
    const r = await setup();
    const T0 = 1_790_000_000;
    const day = (n: number) =>
      `@day:${new Date((T0 + n * 86_400) * 1000).toISOString().slice(0, 10)}`;
    for (const key of ["ENG-1", "ENG-2", "ENG-3"]) r.issues.set(key, issue(key));
    r.tags.set("v0", r.commit("Old work (ENG-1) (ENG-9)", T0));
    r.commit("More old work (ENG-2)", T0 + 86_400);
    r.tags.set("v1", r.commit("New work (ENG-3) (ENG-2)", T0 + 2 * 86_400));
    await r.run();
    const notes = () =>
      (
        r.sqlite.prepare("SELECT release FROM release_notes ORDER BY release").all() as {
          release: string;
        }[]
      ).map((n) => n.release);
    const mentions = () =>
      (
        r.sqlite
          .prepare("SELECT issue_key FROM release_note_mentions ORDER BY issue_key")
          .all() as {
          issue_key: string;
        }[]
      ).map((m) => m.issue_key);
    expect(notes()).toEqual([day(0), day(1), day(2), "v0", "v1"]);
    expect(mentions()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-9"]);

    // Half a day after the newest work, keeping one day: days 0 and 1 go, and
    // tag v0 (its work is day 0's).
    const now = new Date((T0 + 2.5 * 86_400) * 1000);
    const ctx = {
      env: r.env,
      target: { kind: "space", id: "acc" } as const,
      thresholds: { days: 1 },
      now,
      limit: 10,
    };
    const { items } = await releaseNotes.select(ctx, null);
    expect(items.map((i) => i.release)).toEqual([day(0), day(1), "v0"]);
    const removed = await releaseNotes.remove(ctx, items);
    expect(removed.count).toBe(items.reduce((n, i) => n + i.rows, 0));
    expect(notes()).toEqual([day(2), "v1"]);
    expect(r.entries(day(0))).toEqual([]);
    // ENG-1 was cited only there; ENG-2 still is. ENG-9 never resolved: the
    // next generation recomputes it.
    expect(mentions()).toEqual(["ENG-2", "ENG-3", "ENG-9"]);
    expect(r.sqlite.prepare("SELECT retained_from FROM release_note_state").get()).toEqual({
      retained_from: new Date(now.getTime() - 86_400_000).toISOString(),
    });

    // The generator writes nothing for the removed releases and pays nothing.
    const again = await r.run();
    expect(again.newCalls).toEqual([]);
    expect(notes()).toEqual([day(2), "v1"]);
    expect(mentions()).toEqual(["ENG-2", "ENG-3"]);
    expect(await releaseNotes.remove(ctx, items)).toEqual({ count: 0, bytes: 0 });

    // Much later every release is old: the latest day and the latest tag stay.
    const later = { ...ctx, now: new Date((T0 + 400 * 86_400) * 1000) };
    expect((await releaseNotes.select(later, null)).items).toEqual([]);
    // A new push after the horizon is written as usual; the old latest day
    // stays until something newer is out, then goes.
    r.commit("Fresh work (ENG-3)", T0 + 401 * 86_400);
    await r.run();
    expect(notes()).toEqual([day(2), day(401), "v1"]);
    const last = await releaseNotes.select(later, null);
    expect(last.items.map((i) => i.release)).toEqual([day(2)]);
  });

  test("bounded daily history marks every observed day incomplete", async () => {
    const r = await setup();
    r.issues.set("ENG-1", issue("ENG-1"));
    for (let i = 0; i < 1001; i++) r.commit("ENG-1");
    await r.run();
    expect(r.release(DAY)!.truncated).toBe(1);
    const commits = JSON.parse(r.entries(DAY)[0]!.commits!) as string[];
    expect(commits).toHaveLength(1000);
    expect(commits).not.toContain("c0");
  });
  test("legacy stored tags upgrade in bounded batches without backfilling untouched historical tags", async () => {
    const r = await setup();
    for (let i = 0; i < 16; i++) r.tags.set(`v${i}`, r.commit(`chore: change ${i}`));
    for (let i = 1; i <= 12; i++)
      r.sqlite
        .prepare(`INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at)
        VALUES ('repo', ?, ?, '2000-01-01', '2000-01-01')`)
        .run(`v${i}`, `c${i}`);
    const first = await r.run();
    expect(first.more).toBe(true);
    expect(first.releases).toBe(11);
    expect(r.release("v1")!.format_version).toBe(0);
    const second = await r.run();
    expect(second.more).toBe(true);
    expect(second.releases).toBe(6);
    const final = await r.run();
    expect(final.more).toBe(false);
    expect(final.releases).toBe(11);
    expect(r.release("v1")).toMatchObject({
      format_version: 1,
      released_at: new Date(1_790_000_001_000).toISOString(),
    });
    expect(r.entries("v1")[0]!.shipped_at).toBe(new Date(1_790_000_001_000).toISOString());
    expect(r.release("v0")).toBeUndefined();
  });
});

describe("release note scheduling", () => {
  test("unbound legacy generations retain frozen inputs for reconciliation without replay", async () => {
    const r = await setup();
    r.commit("Preserved release");
    await r.run();
    const before = r.entries(DAY);
    const snapshot = JSON.stringify(LEGACY_AI_SNAPSHOT);
    const refs = JSON.stringify(await r.source.refs());
    r.sqlite
      .prepare(
        "INSERT INTO release_note_state(repo_id,dirty,status,ai_snapshot,generation_refs) VALUES ('repo',1,'generating',?,?)",
      )
      .run(snapshot, refs);
    const delivery = message("repo");
    await runReleaseNotesJob(r.env, delivery.message, () => {});
    expect(delivery.outcome).toEqual({ acked: true, retried: false });
    expect(
      r.sqlite.prepare("SELECT status,ai_snapshot,generation_refs FROM release_note_state").get(),
    ).toEqual({ status: "failed", ai_snapshot: snapshot, generation_refs: refs });
    expect(r.entries(DAY)).toEqual(before);
  });
  test("repository-only writers do not gain Space provider access through push notifications", async () => {
    const q = await queued(true);
    q.sqlite.exec(
      "DELETE FROM space_grants WHERE space_id='acc'; INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('repo','initiator','write')",
    );
    await notifyReleaseNotes(q.env, "repo", actor);
    expect(q.sent).toEqual([]);
    expect(q.sqlite.prepare("SELECT * FROM release_note_state").all()).toEqual([]);
  });
  test("revoked initiating agents cannot consume queued release work", async () => {
    const q = await queued(true);
    q.sqlite.exec(
      "INSERT INTO agents(id,name,accountable_id) VALUES ('agent','Agent','initiator'); UPDATE access_tokens SET agent_id='agent' WHERE id='token-initiator'",
    );
    const agentActor = { ...actor, agent: { id: "agent", name: "Agent" } };
    await notifyReleaseNotes(q.env, "repo", agentActor);
    q.sqlite.exec("UPDATE agents SET revoked_at=datetime('now') WHERE id='agent'");
    const delivery = message("repo");
    Object.assign(delivery.message.body, q.sent[0] as ReleaseNotesJob);
    await runReleaseNotesJob(q.env, delivery.message, () => {});
    expect(delivery.outcome).toEqual({ acked: true, retried: false });
    expect(q.sqlite.prepare("SELECT COUNT(*) AS n FROM release_notes").get()).toEqual({ n: 0 });
  });
  test.each(["grant", "credential", "epoch"])(
    "rejects delayed %s revocation without changing release history",
    async (kind) => {
      const r = await setup();
      r.commit("Existing release");
      await r.run();
      historyFor(r);
      const before = r.release(DAY);
      const entries = r.entries(DAY);
      await notifyReleaseNotes(r.env, "repo", actor);
      if (kind === "grant") r.sqlite.exec("DELETE FROM space_grants WHERE space_id='acc'");
      if (kind === "credential")
        r.sqlite.exec("DELETE FROM access_tokens WHERE id='token-initiator'");
      const delivery = message("repo");
      if (kind === "epoch") {
        delivery.message.body.authority = {
          ...authority,
          migrationEpoch: authority.migrationEpoch - 1,
        };
        r.sqlite
          .prepare("UPDATE release_note_state SET dirty_binding=? WHERE repo_id='repo'")
          .run(JSON.stringify(delivery.message.body.authority));
      }
      await runReleaseNotesJob(r.env, delivery.message, () => {});
      expect(delivery.outcome).toEqual({ acked: true, retried: false });
      expect(r.release(DAY)).toEqual(before);
      expect(r.entries(DAY)).toEqual(entries);
      vi.restoreAllMocks();
    },
  );

  test("revocation during inference blocks publication and preserves existing entry identities", async () => {
    const r = await setup();
    r.commit("Existing release");
    await r.run();
    const entries = r.sqlite
      .prepare("SELECT id,title,summary FROM release_note_entries ORDER BY id")
      .all();
    r.commit("New unauthorized publication");
    const provider = r.env.AI!.run.bind(r.env.AI);
    vi.spyOn(r.env.AI!, "run").mockImplementationOnce(async (...args) => {
      const result = await provider(...args);
      r.sqlite.exec("DELETE FROM access_tokens WHERE id='token-initiator'");
      return result;
    });
    await expect(r.run()).rejects.toThrow();
    expect(
      r.sqlite.prepare("SELECT id,title,summary FROM release_note_entries ORDER BY id").all(),
    ).toEqual(entries);
    vi.restoreAllMocks();
  });
  async function queued(ai: boolean) {
    const { sqlite, env } = await releaseEnvironment();
    seedReleasePerson(sqlite, actor.id);
    await seedReleaseSpace(sqlite, "acc", actor.id);
    sqlite.exec(`
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
    `);
    const sent: unknown[] = [];
    env.JOBS = { send: async (body: unknown) => void sent.push(body) } as unknown as Env["JOBS"];
    if (ai) env.AI = {} as NonNullable<Env["AI"]>;
    return { sqlite, env, sent };
  }
  const message = (repoId: string) => {
    const outcome = { acked: false, retried: false };
    return {
      outcome,
      message: {
        body: { type: "release-notes", repoId, authority },
        attempts: 1,
        ack: () => void (outcome.acked = true),
        retry: () => void (outcome.retried = true),
      } as unknown as Message<ReleaseNotesJob>,
    };
  };

  function historyFor(r: { env: Env; source: GeneratorSource }) {
    r.env.JOBS = { send: async () => {} } as unknown as Env["JOBS"];
    vi.spyOn(RepoReader.prototype, "refs").mockImplementation(() => r.source.refs());
    vi.spyOn(RepoReader.prototype, "log").mockImplementation((oid, limit, offset) =>
      r.source.log(oid, limit, offset),
    );
    vi.spyOn(RepoReader.prototype, "commit").mockImplementation((oid) => r.source.commit(oid));
    vi.spyOn(semantic, "semanticFeed").mockResolvedValue({
      version: 1,
      ref: "HEAD",
      head: "",
      entries: [],
      coverage: [],
      nextCursor: null,
    });
  }

  test("disabled admission and a disabled queued consumer spend nothing and retain stored notes", async () => {
    const r = await setup();
    r.commit("Existing work");
    await r.run();
    r.sqlite.exec(
      "INSERT INTO release_note_state (repo_id, status, format_version) VALUES ('repo', 'ready', 1)",
    );
    const stored = r.release(DAY);
    const calls = r.calls.length;
    const sent: unknown[] = [];
    r.env.JOBS = { send: async (body: unknown) => void sent.push(body) } as unknown as Env["JOBS"];
    await notifyReleaseNotes(r.env, "repo", actor);
    r.sqlite.exec("INSERT INTO space_settings (space_id, ai_release_notes) VALUES ('acc', 0)");
    await notifyReleaseNotes(r.env, "repo", actor);
    await ensureReleaseNotes(r.env, "repo", actor);
    await runReleaseNotesJob(r.env, message("repo").message, () => {});
    expect(sent).toEqual([{ type: "release-notes", repoId: "repo", authority }]);
    expect(r.calls.length).toBe(calls);
    expect(r.release(DAY)).toEqual(stored);
    expect((await releaseNotesFor(r.env.DB, "repo", DAY, new Map()))!.entries).toHaveLength(1);
  });

  test("a failed generation and its budget continuation retain policy and refs, then a push starts fresh", async () => {
    const r = await setup();
    historyFor(r);
    const glm = AI_MODEL_CATALOG.fast.find((option) => option.id === "glm-5.3-flash")!.model;
    const gemma = AI_MODEL_CATALOG.fast.find((option) => option.id === "gemma-4-26b-a4b-it")!.model;
    for (let i = 0; i < 41; i++) r.commit(`Original ${i}`);
    const provider = vi
      .spyOn(r.env.AI!, "run")
      .mockRejectedValue(new Error("Provider temporarily unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notifyReleaseNotes(r.env, "repo", actor);
      const failed = message("repo");
      await runReleaseNotesJob(r.env, failed.message, () => {});
      expect(failed.outcome.retried).toBe(true);
      provider.mockRestore();
      r.sqlite.exec(`INSERT INTO space_settings
        (space_id, ai_fast_model, ai_task_model) VALUES
        ('acc', 'gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it')`);
      r.commit("Successor only");
      await notifyReleaseNotes(r.env, "repo", actor);
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.entries(DAY)).toHaveLength(40);
      expect(r.entries(DAY).flatMap((entry) => JSON.parse(entry.commits!))).not.toContain("c41");
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.entries(DAY)).toHaveLength(41);
      expect(r.calls.map((call) => call.model)).toEqual(Array(42).fill(glm));
      const before = r.calls.length;
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.entries(DAY)).toHaveLength(42);
      expect(r.calls.slice(before).map((call) => call.model)).toEqual([gemma, gemma]);
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).status.state).toBe("ready");
    } finally {
      errors.mockRestore();
      vi.restoreAllMocks();
    }
  });

  test("turning release notes off after start does not cancel its continuation", async () => {
    const r = await setup();
    historyFor(r);
    for (let i = 0; i < 41; i++) r.commit(`Accepted ${i}`);
    try {
      await notifyReleaseNotes(r.env, "repo", actor);
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      r.sqlite.exec("INSERT INTO space_settings (space_id, ai_release_notes) VALUES ('acc', 0)");
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).status.state).toBe(
        "generating",
      );
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.entries(DAY)).toHaveLength(41);
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).status.state).toBe("disabled");
      r.commit("Disabled successor");
      const before = r.calls.length;
      await notifyReleaseNotes(r.env, "repo", actor);
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.calls.length).toBe(before);
      expect(r.entries(DAY)).toHaveLength(41);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("completed notes stay readable when a push's successor is disabled", async () => {
    const r = await setup();
    historyFor(r);
    const original = r.commit("Shipped work");
    const provider = r.env.AI!.run.bind(r.env.AI);
    vi.spyOn(r.env.AI!, "run").mockImplementationOnce(async (...args) => {
      const result = await provider(...args);
      r.commit("Future work");
      await notifyReleaseNotes(r.env, "repo", actor);
      r.sqlite.exec("INSERT INTO space_settings (space_id, ai_release_notes) VALUES ('acc', 0)");
      return result;
    });
    try {
      await notifyReleaseNotes(r.env, "repo", actor);
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      const notes = await releaseNotesFor(r.env.DB, "repo", DAY, new Map());
      expect(notes?.entries.flatMap((entry) => entry.commits)).toEqual([original]);
      const spent = r.calls.length;
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.calls.length).toBe(spent);
      expect(await releaseNotesFor(r.env.DB, "repo", DAY, new Map())).toEqual(notes);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test.each([true, false])(
    "a refs-fetch failure leaves admission pending (enabled=%s)",
    async (enabled) => {
      const r = await setup();
      historyFor(r);
      r.commit("Original work");
      vi.spyOn(RepoReader.prototype, "refs").mockRejectedValueOnce(
        new Error("Artifacts unavailable"),
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await notifyReleaseNotes(r.env, "repo", actor);
        const failed = message("repo");
        await runReleaseNotesJob(r.env, failed.message, () => {});
        expect(failed.outcome.retried).toBe(true);
        r.sqlite
          .prepare(`INSERT INTO space_settings
        (space_id, ai_release_notes, ai_fast_model, ai_task_model)
        VALUES ('acc', ?, 'gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it')`)
          .run(Number(enabled));
        r.commit("Newly admitted work");
        await notifyReleaseNotes(r.env, "repo", actor);
        await runReleaseNotesJob(r.env, message("repo").message, () => {});
        const gemma = AI_MODEL_CATALOG.task.find(
          (option) => option.id === "gemma-4-26b-a4b-it",
        )!.model;
        expect(r.calls.map((call) => call.model)).toEqual(enabled ? [gemma, gemma, gemma] : []);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  test("an expired generation lease retains its snapshot and a superseded holder cannot clear it", async () => {
    const r = await setup();
    historyFor(r);
    r.commit("Resumed work");
    r.sqlite
      .exec(`INSERT INTO release_note_state (repo_id, status, lease_until, lease_id, ai_snapshot)
      VALUES ('repo', 'generating', 1, 'old', '${JSON.stringify(LEGACY_AI_SNAPSHOT)}');
      INSERT INTO space_settings (space_id, ai_release_notes) VALUES ('acc', 0);`);
    r.sqlite
      .prepare("UPDATE release_note_state SET generation_binding=?")
      .run(JSON.stringify(authority));
    try {
      vi.spyOn(RepoReader.prototype, "refs").mockImplementationOnce(async () => {
        r.sqlite.exec(
          "UPDATE release_note_state SET lease_id = 'replacement', lease_until = 9999999999999",
        );
        return r.source.refs();
      });
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.calls).toEqual([]);
      expect(r.sqlite.prepare("SELECT lease_id FROM release_note_state").get()).toEqual({
        lease_id: "replacement",
      });
      r.sqlite.exec("UPDATE release_note_state SET lease_until = 1");
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.calls.map((call) => call.model)).toEqual([
        LEGACY_AI_SNAPSHOT.models.fast,
        LEGACY_AI_SNAPSHOT.models.task,
      ]);
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).status.state).toBe("disabled");
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("without AI bindings nothing is scheduled or generated", async () => {
    const q = await queued(false);
    await notifyReleaseNotes(q.env, "repo", actor);
    expect(q.sent).toEqual([]);
    expect(q.sqlite.prepare("SELECT * FROM release_note_state").all()).toEqual([]);
    const m = message("repo");
    await runReleaseNotesJob(q.env, m.message, () => {});
    expect(m.outcome).toEqual({ acked: true, retried: false });
  });

  test("a change marks the repository dirty and enqueues it; a held lease defers to its holder", async () => {
    const q = await queued(true);
    await notifyReleaseNotes(q.env, "repo", actor);
    expect(q.sent).toEqual([{ type: "release-notes", repoId: "repo", authority }]);
    expect(q.sqlite.prepare("SELECT dirty FROM release_note_state").get()).toEqual({ dirty: 1 });
    q.sqlite.exec(`UPDATE release_note_state SET lease_until = ${Date.now() + 60_000}`);
    const m = message("repo");
    await runReleaseNotesJob(q.env, m.message, () => {});
    expect(m.outcome).toEqual({ acked: true, retried: false });
    // The holder will see the dirty mark and follow up.
    expect(q.sqlite.prepare("SELECT dirty FROM release_note_state").get()).toEqual({ dirty: 1 });
  });
  test("reads coalesce lazy upgrades and keep failed retries visible", async () => {
    const q = await queued(true);
    q.sqlite.exec(`INSERT INTO release_note_state (repo_id, status) VALUES ('repo', 'ready')`);
    await Promise.all([
      ensureReleaseNotes(q.env, "repo", actor),
      ensureReleaseNotes(q.env, "repo", actor),
    ]);
    expect(q.sent).toEqual([{ type: "release-notes", repoId: "repo", authority }]);
    expect((await releaseIndex(q.env.DB, "repo", new Map(), true)).status.state).toBe("generating");
    q.sqlite.exec(`UPDATE release_note_state SET status = 'failed', dirty = 1`);
    await ensureReleaseNotes(q.env, "repo", actor);
    expect(q.sent).toHaveLength(1);
    expect((await releaseIndex(q.env.DB, "repo", new Map(), true)).status.state).toBe("failed");
  });

  test("queue continuations hide partial upgraded data until the budget converges", async () => {
    const r = await setup();
    const sent: unknown[] = [];
    r.env.JOBS = { send: async (body: unknown) => void sent.push(body) } as unknown as Env["JOBS"];
    for (let i = 0; i < 41; i++) r.commit(`Change ${i}`);
    vi.spyOn(RepoReader.prototype, "refs").mockImplementation(() => r.source.refs());
    vi.spyOn(RepoReader.prototype, "log").mockImplementation((oid, limit, offset) =>
      r.source.log(oid, limit, offset),
    );
    vi.spyOn(RepoReader.prototype, "commit").mockImplementation((oid) => r.source.commit(oid));
    vi.spyOn(semantic, "semanticFeed").mockResolvedValue({
      version: 1,
      ref: "HEAD",
      head: "c40",
      entries: [],
      coverage: [],
      nextCursor: null,
    });
    try {
      await ensureReleaseNotes(r.env, "repo", actor);
      const first = message("repo");
      await runReleaseNotesJob(r.env, first.message, () => {});
      expect(first.outcome).toEqual({ acked: true, retried: false });
      expect(
        r.sqlite.prepare("SELECT format_version, status, dirty FROM release_note_state").get(),
      ).toEqual({ format_version: 0, status: "generating", dirty: 0 });
      expect(r.entries(DAY)).toHaveLength(40);
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).releases).toEqual([]);
      expect(await releaseNotesFor(r.env.DB, "repo", DAY, new Map())).toBeNull();
      await ensureReleaseNotes(r.env, "repo", actor);
      expect(sent).toHaveLength(2);
      const second = message("repo");
      await runReleaseNotesJob(r.env, second.message, () => {});
      expect(second.outcome).toEqual({ acked: true, retried: false });
      expect(
        r.sqlite.prepare("SELECT format_version, status, dirty FROM release_note_state").get(),
      ).toEqual({ format_version: 1, status: "ready", dirty: 0 });
      expect((await releaseNotesFor(r.env.DB, "repo", DAY, new Map()))!.entries).toHaveLength(41);
      const calls = r.calls.length;
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect(r.calls).toHaveLength(calls);
      // Once upgraded, normal budget continuations must not erase readable history.
      for (let i = 0; i < 41; i++) r.commit(`Follow-up change ${i}`);
      await notifyReleaseNotes(r.env, "repo", actor);
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      const updating = await releaseIndex(r.env.DB, "repo", new Map(), true);
      expect(updating.status.state).toBe("generating");
      expect(updating.releases.map((release) => release.name)).toEqual([DAY]);
      expect(
        (await releaseNotesFor(r.env.DB, "repo", DAY, new Map()))!.entries.flatMap(
          (entry) => entry.commits,
        ),
      ).toContain("c0");
      await runReleaseNotesJob(r.env, message("repo").message, () => {});
      expect((await releaseIndex(r.env.DB, "repo", new Map(), true)).status.state).toBe("ready");
    } finally {
      vi.restoreAllMocks();
    }
  });
  test("failed upgrades stay private and retry without losing the failure state", async () => {
    const q = await queued(true);
    vi.spyOn(RepoReader.prototype, "refs").mockRejectedValue(new Error("History unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureReleaseNotes(q.env, "repo", actor);
      const attempt = message("repo");
      await runReleaseNotesJob(q.env, attempt.message, () => {});
      expect(attempt.outcome).toEqual({ acked: false, retried: true });
      expect((await releaseIndex(q.env.DB, "repo", new Map(), true)).status.state).toBe("failed");
      await ensureReleaseNotes(q.env, "repo", actor);
      expect(q.sent).toHaveLength(1);
    } finally {
      errorLog.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
