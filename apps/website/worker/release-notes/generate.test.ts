import { describe, expect, test } from "vite-plus/test";
import type { LinkedIssue } from "../../shared/release-notes.ts";
import type { RepoRefs } from "../artifacts.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { generateReleaseNotes, type GeneratorSource } from "./generate.ts";
import { notifyReleaseNotes, runReleaseNotesJob, type ReleaseNotesJob } from "./queue.ts";

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
    workspaceIds: ["ws"],
    team: { id: "team", key: "ENG", name: "Engineering" },
    completedAt: "2026-09-01T00:00:00.000Z",
    evidence: [{ body: `Shipped ${key}`, actorId: "a", createdAt: "2026-09-01T00:00:00.000Z" }],
    trackerOwner: "org",
    trackerOwnerId: "acc",
    ...overrides,
  };
}

/** A repository with linear history, tags, tracker issues and a fake model. */
function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const calls: Call[] = [];
  const AI = {
    async run(model: string, inputs: { messages: { content: string }[] }) {
      const prompt = inputs.messages[1]?.content ?? "";
      calls.push({ model, prompt });
      const content = model.includes("qwen3.8")
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
  const env = { DB: d1(sqlite), AI } as unknown as Env;

  // Oldest first; the newest commit is the head.
  const history: { hash: string; message: string }[] = [];
  const tags = new Map<string, string>();
  const issues = new Map<string, LinkedIssue>();
  const commit = (message: string) => {
    history.push({ hash: `c${history.length}`, message });
    return `c${history.length - 1}`;
  };
  const source: GeneratorSource = {
    async refs(): Promise<RepoRefs> {
      const head = history.at(-1)?.hash ?? null;
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
      const index = history.findIndex((c) => c.hash === oid);
      return history
        .slice(0, index + 1)
        .reverse()
        .slice(offset, offset + limit)
        .map(
          (c) =>
            ({
              hash: c.hash,
              message: c.message,
              author: { name: "A", email: "a@example.com" },
              authoredAt: 1_790_000_000 + Number(c.hash.slice(1)),
              parents: [],
            }) as unknown as ArtifactsCommitMetadata,
        );
    },
    async issues(keys) {
      return keys.flatMap((key) => (issues.has(key) ? [issues.get(key)!] : []));
    },
    async changes(oid) {
      return [{ kind: "function.added", name: `fn_${oid}`, path: "src/a.ts", summary: "Added." }];
    },
  };
  const run = async (options: { maxModelCalls?: number } = {}) => {
    const before = calls.length;
    const result = await generateReleaseNotes(env, "repo", source, {
      ...options,
      now: () => "2026-10-02T00:00:00.000Z",
    });
    return { ...result, newCalls: calls.slice(before) };
  };
  const entries = (release: string) =>
    sqlite
      .prepare(
        "SELECT subject, kind, category, title, issue_key, team_key, commits, changes, shipped_at FROM release_note_entries WHERE release = ? ORDER BY subject",
      )
      .all(release) as Record<string, string>[];
  const release = (name: string) =>
    sqlite.prepare("SELECT * FROM release_notes WHERE release = ?").get(name) as
      | Record<string, string | number | null>
      | undefined;
  return { sqlite, env, calls, commit, tags, issues, run, entries, release };
}

describe("release note generation", () => {
  test("groups commits under the issues they cite, writes each entry once, and introduces the release", async () => {
    const r = setup();
    r.issues.set("ENG-1", issue("ENG-1"));
    r.commit("Initial import");
    r.commit("Start the parser (ENG-1)");
    r.tags.set("v1.0.0", r.commit("Finish the parser, ENG-1"));
    r.commit("Decode UTF-8 names");
    r.commit("chore: bump deps");

    const first = await r.run();
    expect(first).toMatchObject({ releases: 2, more: false });
    // Two entries in v1.0.0 and two unreleased, plus one intro each.
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
      shipped_at: "2026-09-01T00:00:00.000Z",
    });
    expect(JSON.parse(parser.changes!)).toHaveLength(2);
    // The prompt carries the issue, its evidence, the commits and their code changes.
    const prompt = first.newCalls.find((c) => c.prompt.includes("## Issue ENG-1"))!.prompt;
    expect(prompt).toContain("Shipped ENG-1");
    expect(prompt).toContain("Finish the parser, ENG-1");
    expect(prompt).toContain("fn_c2");

    expect(r.entries("@unreleased").map((e) => [e.subject, e.category])).toEqual([
      ["commit:c3", "feature"],
      ["commit:c4", "internal"],
    ]);
    expect(r.release("v1.0.0")).toMatchObject({
      to_oid: "c2",
      from_oid: null,
      intro: "Intro over 2 entries.",
      intro_trackers: '["acc"]',
    });
    // Internal entries stay out of the introduction.
    expect(r.release("@unreleased")).toMatchObject({
      from_tag: "v1.0.0",
      intro: "Intro over 1 entries.",
      intro_trackers: "[]",
    });
    const mentions = r.sqlite
      .prepare("SELECT issue_key FROM release_note_mentions ORDER BY issue_key")
      .all()
      .map((row) => row.issue_key);
    expect(mentions).toEqual(["ENG-1", "UTF-8"]);
  });

  test("reruns are free; a push pays only for what is new; a tag freezes unreleased entries", async () => {
    const r = setup();
    r.issues.set("ENG-2", issue("ENG-2"));
    r.tags.set("v1", r.commit("Base"));
    r.commit("Add search (ENG-2)");
    await r.run();
    expect((await r.run()).newCalls).toEqual([]);

    r.commit("fix: search ranking");
    const push = await r.run();
    expect(push.newCalls.map((c) => c.model.includes("glm"))).toEqual([true, false]);
    expect(r.entries("@unreleased")).toHaveLength(2);

    // Tagging the head moves both entries into the release without rewriting them.
    r.tags.set("v2", "c2");
    const tag = await r.run();
    expect(tag.newCalls.filter((c) => c.model.includes("glm"))).toEqual([]);
    expect(r.entries("v2").map((e) => e.title)).toEqual([
      "Entry: fix: search ranking",
      "Entry: Add search (ENG-2)",
    ]);
    expect(r.entries("@unreleased")).toEqual([]);
    expect(r.release("@unreleased")).toMatchObject({ from_tag: "v2", intro: "" });
  });

  test("a changed issue rewrites its entry; unresolved keys and lost tags drop out", async () => {
    const r = setup();
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
    expect(r.entries("v2")[0]!.shipped_at).toBe("2026-09-01T00:00:00.000Z");

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
    const r = setup();
    for (let i = 0; i < 4; i++) r.commit(`Change ${i}`);
    const partial = await r.run({ maxModelCalls: 2 });
    expect(partial.more).toBe(true);
    expect(r.entries("@unreleased")).toHaveLength(2);
    expect(r.release("@unreleased")!.intro).toBe("");
    const rest = await r.run({ maxModelCalls: 10 });
    expect(rest.more).toBe(false);
    expect(r.entries("@unreleased")).toHaveLength(4);
    expect(r.release("@unreleased")!.intro).toBe("Intro over 4 entries.");
  });
});

describe("release note scheduling", () => {
  function queued(ai: boolean) {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
    `);
    const sent: unknown[] = [];
    const env = {
      DB: d1(sqlite),
      JOBS: { send: async (body: unknown) => void sent.push(body) },
      ...(ai ? { AI: {} } : {}),
    } as unknown as Env;
    return { sqlite, env, sent };
  }
  const message = (repoId: string) => {
    const outcome = { acked: false, retried: false };
    return {
      outcome,
      message: {
        body: { type: "release-notes", repoId },
        attempts: 1,
        ack: () => void (outcome.acked = true),
        retry: () => void (outcome.retried = true),
      } as unknown as Message<ReleaseNotesJob>,
    };
  };

  test("without AI bindings nothing is scheduled or generated", async () => {
    const q = queued(false);
    await notifyReleaseNotes(q.env, "repo");
    expect(q.sent).toEqual([]);
    expect(q.sqlite.prepare("SELECT * FROM release_note_state").all()).toEqual([]);
    const m = message("repo");
    await runReleaseNotesJob(q.env, m.message, () => {});
    expect(m.outcome).toEqual({ acked: true, retried: false });
  });

  test("a change marks the repository dirty and enqueues it; a held lease defers to its holder", async () => {
    const q = queued(true);
    await notifyReleaseNotes(q.env, "repo");
    expect(q.sent).toEqual([{ type: "release-notes", repoId: "repo" }]);
    expect(q.sqlite.prepare("SELECT dirty FROM release_note_state").get()).toEqual({ dirty: 1 });
    q.sqlite.exec(`UPDATE release_note_state SET lease_until = ${Date.now() + 60_000}`);
    const m = message("repo");
    await runReleaseNotesJob(q.env, m.message, () => {});
    expect(m.outcome).toEqual({ acked: true, retried: false });
    // The holder will see the dirty mark and follow up.
    expect(q.sqlite.prepare("SELECT dirty FROM release_note_state").get()).toEqual({ dirty: 1 });
  });
});
