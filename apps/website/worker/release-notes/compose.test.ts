import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { chatText } from "../knowledge/models.ts";
import type * as Models from "../knowledge/models.ts";
import { recordAiCall } from "../usage/ai.ts";
import { releaseNotes, trackerReleaseNotes } from "./api.ts";
import { COMPOSE_CHAR_LIMIT, COMPOSE_DAILY_LIMIT, serializeEntries } from "./compose.ts";
import { WRITING_INSTRUCTIONS } from "./writing.ts";

// Like highlights.test.ts: only the Workers platform base class is shimmed.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../knowledge/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Models>()),
  chatText: vi.fn(),
  chatJson: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const carol: Actor = { id: "carol", slug: "carol", displayName: "Carol", isSiteAdmin: false };
const bob: Actor = { id: "bob", slug: "bob", displayName: "Bob", isSiteAdmin: false };
const day = "@day:2026-10-08";
const REPO = "/api/repos/orbit/public/release-notes/compose";
const TRACKER = "/api/tracker/orbit/release-notes/compose";

function fixture() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id,kind,slug,display_name) VALUES ('ann','user','ann','Ann'),('bob','user','bob','Bob'),('carol','user','carol','Carol'),('orbit','org','orbit','Orbit'),('secret','org','secret','Secret');
    UPDATE accounts SET member_repo_role='read' WHERE id IN ('orbit','secret');
    INSERT INTO org_members(org_id,user_id,role) VALUES ('orbit','ann','member'),('secret','ann','member'),('orbit','carol','member');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES ('public','orbit','public','public','a','https://a'),('private','orbit','private','private','b','https://b');
    INSERT INTO release_note_state(repo_id,status,format_version,dirty) VALUES ('public','ready',1,0),('private','ready',1,0);
    INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,format_version) VALUES ('public','${day}','c1','2026-10-08','2026-10-08',1),('private','${day}','c2','2026-10-08','2026-10-08',1);
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES
    ('open','public','${day}','commit:c1','commit','feature','Parcel verification','Batch parcels can be verified','h','2026-10-08','2026-10-08'),
    ('private-entry','private','${day}','commit:c2','commit','feature','Private outcome','Private repository text','h','2026-10-08','2026-10-08');
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at,tracker_owner_id,issue_id,issue_key,team_id,team_key) VALUES
    ('secret-entry','public','${day}','issue:secret:SEC-1','issue','fix','Secret tracker outcome','Confidential details','h','2026-10-08','2026-10-08','secret','i1','SEC-1','t1','SEC');
  `);
  const env = {
    DB: d1(sqlite),
    AI: {},
    JOBS: { send: async () => {} },
    TRACKER: {
      getByName: () => ({
        workspaceSlugs: async () => ({ ok: true, value: [] }),
        teamNames: async () => ({ ok: true, value: [] }),
      }),
    },
  } as unknown as Env;
  vi.mocked(chatText).mockImplementation(async (e) => {
    await recordAiCall(e, "test-model", { input: 100, output: 40 });
    return {
      text: "# Parcel verification\n\nVerify batches.\n",
      usage: { model: "test-model", tokens: 140 },
    };
  });
  let who: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", who);
    await next();
  });
  app.route("/api/repos/:owner/:name/release-notes", releaseNotes);
  app.route("/api/tracker/:owner/release-notes", trackerReleaseNotes);
  const post = (path: string, body: unknown, as: Actor | null = ann) => {
    who = as;
    return app.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  };
  const userMessage = () => vi.mocked(chatText).mock.calls[0]![3];
  return { sqlite, env, post, userMessage };
}

describe("custom release notes", () => {
  test("a repository's release is written once, from what the viewer may read, and metered", async () => {
    const t = fixture();
    const agent: Actor = { ...ann, agent: { id: "agent_1", name: "Helper" } };
    const response = await t.post(REPO, { prompt: "A customer announcement", release: day }, agent);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      markdown: "# Parcel verification\n\nVerify batches.",
      model: "test-model",
      entries: 2,
      truncated: false,
    });
    // One call: the writing rules as the system prompt, request and data apart.
    expect(chatText).toHaveBeenCalledTimes(1);
    const [, , system, user, options] = vi.mocked(chatText).mock.calls[0]!;
    expect(system).toBe(WRITING_INSTRUCTIONS);
    expect(user).toMatch(/^REQUEST[^\n]*\nA customer announcement\n\nRELEASE NOTE ENTRIES[^\n]*\n/);
    expect(user).toContain("Parcel verification");
    expect(user).toContain("Secret tracker outcome");
    expect(user).not.toContain("Private outcome");
    // One call, however the provider answers: no waiting out rate limits.
    expect(options).toMatchObject({ maxTokens: 2000, rateLimitRetries: 0 });
    // Billed to the repository's owner, for the person and the agent acting.
    expect(t.sqlite.prepare("SELECT * FROM ai_usage").all()).toMatchObject([
      {
        account_id: "orbit",
        feature: "release_notes_compose",
        actor_id: "ann",
        agent_id: "agent_1",
        calls: 1,
        model: "test-model",
      },
    ]);
  });

  test("without a release it writes from the newest daily update", async () => {
    const t = fixture();
    expect((await t.post(REPO, { prompt: "Changelog" })).status).toBe(200);
    expect(t.userMessage()).toContain(day);
  });

  test("tracker-private entries stay out for a member who can't read their tracker", async () => {
    const t = fixture();
    const response = await t.post(REPO, { prompt: "Announcement", release: day }, carol);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: 1 });
    expect(t.userMessage()).toContain("Parcel verification");
    expect(t.userMessage()).not.toMatch(/Secret|Confidential|SEC-1/);
  });

  test("only members of the billed account compose, and only where they can read", async () => {
    const t = fixture();
    // Anyone may read a public repository; its owner pays for the model.
    const refused = await t.post(REPO, { prompt: "Announcement" }, bob);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only members of Orbit can write custom release notes.",
    });
    // A private repository stays as hidden as it is for reading.
    expect(
      (await t.post("/api/repos/orbit/private/release-notes/compose", { prompt: "x" }, bob)).status,
    ).toBe(404);
    expect(chatText).not.toHaveBeenCalled();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ai_usage").get()).toEqual({ n: 0 });
    // A site admin counts as a member.
    const admin: Actor = { ...bob, isSiteAdmin: true };
    expect((await t.post(REPO, { prompt: "Announcement" }, admin)).status).toBe(200);
  });

  test("a timeline limits the entries and is recorded with the usage", async () => {
    const t = fixture();
    t.sqlite.exec(`
      INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at,timeline_branch,landing_oid) VALUES
      ('landed','public','${day}','commit:c3','commit','improvement','Landed from alpha','Alpha work','h','2026-10-08','2026-10-08','timeline/alpha','l1');
    `);
    const response = await t.post(REPO, { prompt: "Changelog", release: day, timeline: "alpha" });
    expect(await response.json()).toMatchObject({ entries: 1 });
    expect(t.userMessage()).toContain("Landed from alpha");
    expect(t.userMessage()).not.toContain("Parcel verification");
    expect(t.sqlite.prepare("SELECT feature, timeline FROM ai_usage").all()).toEqual([
      { feature: "release_notes_compose", timeline: "alpha" },
    ]);
  });

  test("a failing model is a clear 502, asked once", async () => {
    const t = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(chatText).mockRejectedValue(new Error("3021: Too many requests"));
    const response = await t.post(REPO, { prompt: "Announcement" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The model didn't answer. Try again in a minute.",
    });
    expect(chatText).toHaveBeenCalledTimes(1);
  });

  test("each person writes at most 50 a day for an account", async () => {
    const t = fixture();
    t.sqlite.exec(`INSERT INTO ai_usage(day,account_id,feature,model,calls,failed_calls,actor_id)
      VALUES (date('now'),'orbit','release_notes_compose','m',${COMPOSE_DAILY_LIMIT - 4},3,'ann')`);
    // 49 so far: one more is allowed, the next is not.
    expect((await t.post(REPO, { prompt: "Announcement" })).status).toBe(200);
    vi.mocked(chatText).mockClear();
    const capped = await t.post(REPO, { prompt: "Announcement" });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({
      error: "You've written 50 custom release notes today for Orbit; try again tomorrow.",
    });
    expect(chatText).not.toHaveBeenCalled();
    // The cap is per person: a colleague is unaffected.
    expect((await t.post(TRACKER, { prompt: "Announcement" }, carol)).status).toBe(200);
  });

  test("the organization route writes from its feed and keeps its membership check", async () => {
    const t = fixture();
    const response = await t.post(TRACKER, { prompt: "Summary for the team", q: "type:feature" });
    expect(response.status).toBe(200);
    // The filter keeps the two features, and drops the fix; ann is a member, so she reads both repositories.
    expect(await response.json()).toMatchObject({ entries: 2 });
    expect(t.userMessage()).toContain("Parcel verification");
    expect(t.userMessage()).toContain("Private outcome");
    expect(t.userMessage()).not.toContain("Secret tracker outcome");
    expect(t.sqlite.prepare("SELECT account_id, feature, actor_id FROM ai_usage").all()).toEqual([
      { account_id: "orbit", feature: "release_notes_compose", actor_id: "ann" },
    ]);

    vi.mocked(chatText).mockClear();
    const refused = await t.post(TRACKER, { prompt: "Summary" }, bob);
    expect(refused.status).toBe(403);
    expect(chatText).not.toHaveBeenCalled();

    // A member of orbit who isn't in the secret tracker: its entry is redacted by access alone.
    const redacted = await t.post(TRACKER, { prompt: "Summary" }, carol);
    expect(redacted.status).toBe(200);
    expect(await redacted.json()).toMatchObject({ entries: 2 });
    expect(t.userMessage()).toContain("Private outcome");
    expect(t.userMessage()).not.toMatch(/Secret tracker outcome|Confidential|SEC-1/);
  });

  test("signed-out callers are refused, and bad requests never reach the model", async () => {
    const t = fixture();
    for (const path of [REPO, TRACKER])
      expect((await t.post(path, { prompt: "Announcement" }, null)).status).toBe(401);
    for (const body of [
      {},
      { prompt: "   " },
      { prompt: 7 },
      { prompt: "x".repeat(2001) },
      { prompt: "Fine", release: 5 },
      { prompt: "Fine", release: "" },
      "not json",
    ])
      expect((await t.post(REPO, body)).status).toBe(400);
    expect((await t.post(TRACKER, { prompt: "Fine", q: 3 })).status).toBe(400);
    expect((await t.post(TRACKER, { prompt: "Fine", q: "x".repeat(501) })).status).toBe(400);
    expect((await t.post(REPO, { prompt: "x".repeat(2000), release: "v9" })).status).toBe(404);
    expect(chatText).not.toHaveBeenCalled();
  });

  test("when AI release notes are off for the billed account, nothing is called", async () => {
    const t = fixture();
    t.sqlite.exec(
      "INSERT INTO account_settings (account_id, ai_release_notes) VALUES ('orbit', 0)",
    );
    for (const path of [REPO, TRACKER]) {
      const response = await t.post(path, { prompt: "Announcement" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "AI release-note writing is off for Orbit.",
      });
    }
    t.sqlite.exec("DELETE FROM account_settings");
    const noAi = { ...t.env, AI: undefined } as unknown as Env;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", ann);
      await next();
    });
    app.route("/api/repos/:owner/:name/release-notes", releaseNotes);
    const response = await app.request(
      REPO,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Announcement" }),
      },
      noAi,
    );
    expect(response.status).toBe(503);
    expect(chatText).not.toHaveBeenCalled();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ai_usage").get()).toEqual({ n: 0 });
  });

  test("with no notes to write from it says so without a model call", async () => {
    const t = fixture();
    t.sqlite.exec("DELETE FROM release_note_entries");
    for (const [path, body] of [
      [REPO, { prompt: "Announcement", release: day }],
      [TRACKER, { prompt: "Announcement" }],
    ] as const) {
      const response = await t.post(path, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "No release notes to write from." });
    }
    expect(chatText).not.toHaveBeenCalled();
  });

  test("a long feed is capped and says it was truncated", async () => {
    const t = fixture();
    const insert = t.sqlite.prepare(
      `INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at)
       VALUES (?,'public',?,?,'commit','improvement',?,'More','h','2026-10-08','2026-10-08')`,
    );
    for (let i = 0; i < 250; i++) insert.run(`bulk-${i}`, day, `commit:b${i}`, `Bulk ${i}`);
    const response = await t.post(REPO, { prompt: "Changelog", release: day });
    expect(await response.json()).toMatchObject({ entries: 200, truncated: true });
  });

  test("one entry bigger than the whole budget is cut down, not dropped", () => {
    const out = serializeEntries([
      {
        release: day,
        category: "feature",
        title: "Huge",
        summary: "S".repeat(COMPOSE_CHAR_LIMIT * 2),
        kind: "commit",
        lastCommitAt: "2026-10-08T10:00:00.000Z",
        issue: null,
        labels: [],
      },
    ]);
    expect(out).toMatchObject({ count: 1, truncated: true });
    expect(out.text.length).toBeLessThanOrEqual(COMPOSE_CHAR_LIMIT);
    expect(JSON.parse(out.text)).toMatchObject({ title: "Huge" });
  });

  test("entries are serialized compactly and capped by size", () => {
    const entry = {
      release: day,
      category: "feature",
      title: "T",
      summary: "S".repeat(10_000),
      kind: "commit",
      lastCommitAt: "2026-10-08T10:00:00.000Z",
      issue: null,
      labels: ["ux"],
    };
    const out = serializeEntries(Array.from({ length: 20 }, () => entry));
    expect(out.truncated).toBe(true);
    expect(out.count).toBeLessThan(20);
    expect(out.text.length).toBeLessThanOrEqual(COMPOSE_CHAR_LIMIT);
    expect(JSON.parse(out.text.split("\n")[0]!)).toMatchObject({
      date: "2026-10-08",
      labels: ["ux"],
    });
  });
});
