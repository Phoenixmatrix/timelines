import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { chatText } from "../knowledge/models.ts";
import type * as Models from "../knowledge/models.ts";
import { attribution } from "../usage/ai.ts";
import {
  readReleaseHighlights,
  runReleaseHighlightsJob,
  projectReleaseHighlights,
  sweepReleaseHighlights,
  type ReleaseHighlightsJob,
} from "./highlights.ts";
import { releaseNotesFor, viewerTrackers } from "./read.ts";
import { releaseNotes, siteReleaseNotes, trackerReleaseNotes } from "./api.ts";
import { CHILD_ROWS } from "../retention/repo-deletion.ts";

// The real routes reach the knowledge coordinator through loadRepo; only shim
// its Workers platform base class, leaving route and authorization logic intact.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../knowledge/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Models>()),
  chatText: vi.fn(),
  chatJson: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const outsider = { id: "bob", slug: "bob", displayName: "Bob", isSiteAdmin: false };
const day = "@day:2026-09-20";
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id,kind,slug,display_name) VALUES ('ann','user','ann','Ann'),('bob','user','bob','Bob'),('orbit','org','orbit','Orbit'),('secret','org','secret','Secret');
    UPDATE accounts SET member_repo_role='read' WHERE id IN ('orbit','secret');
    INSERT INTO org_members(org_id,user_id,role) VALUES ('orbit','ann','member'),('secret','ann','member');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES ('public','orbit','public','public','a','https://a'),('private','orbit','private','private','b','https://b');
    INSERT INTO release_note_state(repo_id,status,format_version,dirty) VALUES ('public','ready',1,0),('private','ready',1,0);
    INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,format_version,intro) VALUES ('public','${day}','c1','2026-09-20','2026-09-20',1,'Detailed introduction'),('private','${day}','c2','2026-09-20','2026-09-20',1,'Private introduction');
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES
    ('open','public','${day}','commit:c1','commit','feature','Parcel verification','Batch parcels can be verified','h','2026-09-20','2026-09-20'),
    ('private-entry','private','${day}','commit:c2','commit','feature','Private outcome','Private repository text','h','2026-09-20','2026-09-20');
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at,tracker_owner_id,issue_id,issue_key,team_id,team_key) VALUES
    ('secret-entry','public','${day}','issue:secret:SEC-1','issue','fix','Secret tracker outcome','Confidential details','h','2026-09-20','2026-09-20','secret','i1','SEC-1','t1','SEC');
  `);
  const sent: ReleaseHighlightsJob[] = [];
  const env = {
    DB: d1(sqlite),
    AI: {},
    JOBS: {
      send: async (job: ReleaseHighlightsJob) => {
        if (job.type === "release-highlights") sent.push(job);
      },
    },
    TRACKER: { getByName: () => ({ workspaceSlugs: async () => ({ ok: true, value: [] }) }) },
  } as unknown as Env;
  const job: ReleaseHighlightsJob = {
    type: "release-highlights",
    scope: "repo",
    scopeId: "public",
    viewerId: "ann",
    ownerAccountId: "orbit",
  };
  vi.mocked(chatText).mockResolvedValue({
    text: "- Batch parcel verification is available in the code updates.",
    usage: { model: "test-model", tokens: 20 },
  });
  const deliver = async (body = job) => {
    const ack = vi.fn();
    await runReleaseHighlightsJob(env, { body, ack } as unknown as Message<ReleaseHighlightsJob>);
    expect(ack).toHaveBeenCalledOnce();
  };
  return { sqlite, env, job, sent, deliver };
}

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

describe("viewer-owned release highlights", () => {
  test("all scopes project only authorized daily sources and exact backlinks", async () => {
    const t = fixture();
    const repo = await projectReleaseHighlights(t.env, t.job);
    expect(repo.sources.map((s) => s.id)).toEqual(["open", "secret-entry"]);
    const bobRepo = { ...t.job, viewerId: "bob" };
    expect((await projectReleaseHighlights(t.env, bobRepo)).sources.map((s) => s.id)).toEqual([
      "open",
    ]);
    const tracker = { ...t.job, scope: "tracker" as const, scopeId: "orbit" };
    expect((await projectReleaseHighlights(t.env, tracker)).sources.map((s) => s.repoId)).toContain(
      "private",
    );
    await expect(
      projectReleaseHighlights(t.env, { ...tracker, viewerId: "bob" }),
    ).rejects.toMatchObject({ status: 403 });
    const site = {
      ...t.job,
      scope: "site" as const,
      scopeId: "bob",
      viewerId: "bob",
      ownerAccountId: "bob",
    };
    expect((await projectReleaseHighlights(t.env, site)).sources.map((s) => s.id)).toEqual([
      "open",
    ]);
    await readReleaseHighlights(t.env, outsider, bobRepo);
    await t.deliver(bobRepo);
    const result = await readReleaseHighlights(t.env, outsider, bobRepo);
    expect(result.status.state).toBe("ready");
    expect(result.notes).toEqual([{ repo: { owner: "orbit", name: "public" }, release: day }]);
    expect(vi.mocked(chatText).mock.calls[0]![3]).not.toMatch(
      /Secret|Confidential|Private repository|SEC-1/,
    );
  });

  test("site calls bill the viewer account, not an arbitrary source repository", async () => {
    const t = fixture();
    const site = { ...t.job, scope: "site" as const, scopeId: "ann", ownerAccountId: "ann" };
    vi.mocked(chatText).mockImplementation(async () => {
      expect(await attribution(t.env)).toEqual({ account: "ann", feature: "release_notes" });
      return { text: "- Batch parcel verification.", usage: { model: "test-model", tokens: 20 } };
    });
    await readReleaseHighlights(t.env, actor, site);
    await t.deliver(site);
    expect((await readReleaseHighlights(t.env, actor, site)).status.state).toBe("ready");
  });

  test("source changes during paid work discard the result without retrying", async () => {
    const t = fixture();
    vi.mocked(chatText).mockImplementation(async () => {
      t.sqlite.exec("DELETE FROM org_members WHERE org_id='secret'");
      return { text: "- Confidential details.", usage: { model: "test-model", tokens: 20 } };
    });
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    const response = await readReleaseHighlights(t.env, actor, t.job);
    expect(response.body).toBeNull();
    expect(response.status.state).toBe("failed");
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(1);
    expect(chatText).toHaveBeenCalledOnce();
  });

  test("concurrent admission and delivery use one paid call, correctly attributed", async () => {
    const t = fixture();
    vi.mocked(chatText).mockImplementation(async () => {
      expect(await attribution(t.env)).toEqual({ account: "orbit", feature: "release_notes" });
      return { text: "- Batch parcel verification.", usage: { model: "test-model", tokens: 20 } };
    });
    await Promise.all([
      readReleaseHighlights(t.env, actor, t.job),
      readReleaseHighlights(t.env, actor, t.job),
    ]);
    expect(t.sent).toHaveLength(1);
    await Promise.all([t.deliver(), t.deliver()]);
    expect(chatText).toHaveBeenCalledOnce();
    const ready = await readReleaseHighlights(t.env, actor, t.job);
    expect(ready).toMatchObject({
      body: "- Batch parcel verification.",
      model: "test-model",
      status: { state: "ready", generatedAt: "2026-10-11T00:00:00.000Z" },
    });
    t.sqlite.exec(
      `INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES ('new','public','${day}','commit:new','commit','feature','New entry','Unrelated addition','new','2026-10-11','2026-10-11')`,
    );
    expect((await readReleaseHighlights(t.env, actor, t.job)).body).toBe(ready.body);
    expect(t.sent).toHaveLength(1);
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-12T00:00:01Z"));
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(2);
    await t.deliver();
    expect(chatText).toHaveBeenCalledTimes(2);
  });

  test("an exact sweep isolates scope, repository and viewer while cron still admits unrelated due rows", async () => {
    const t = fixture();
    // A tracker can share a repository's identifier without sharing its scope.
    t.sqlite.exec(`
      INSERT INTO accounts (id,kind,slug,display_name) VALUES ('public','org','public','Public');
      INSERT INTO org_members(org_id,user_id,role) VALUES ('public','ann','member');
    `);
    const unrelated: ReleaseHighlightsJob[] = [
      { ...t.job, scope: "tracker", ownerAccountId: "public" },
      { ...t.job, scopeId: "private" },
      { ...t.job, viewerId: "bob" },
    ];
    const jobs = [t.job, ...unrelated];
    for (const job of jobs) {
      t.sqlite
        .prepare(`INSERT INTO release_highlights
        (scope,scope_id,viewer_id,owner_account_id,source_hash,body,updated_at,due_at,lease_until)
        VALUES (?,?,?,?,?,?,?,0,0)`)
        .run(
          job.scope,
          job.scopeId,
          job.viewerId,
          job.ownerAccountId,
          "",
          "",
          new Date().toISOString(),
        );
    }
    const rows = t.sqlite.prepare(
      "SELECT * FROM release_highlights ORDER BY scope,scope_id,viewer_id",
    );
    const before = rows.all();
    await sweepReleaseHighlights(t.env, { scope: "repo", scopeId: "public", viewerId: "ann" });
    expect(t.sent).toEqual([t.job]);
    expect(
      rows
        .all()
        .filter(
          (row) => !(row.scope === "repo" && row.scope_id === "public" && row.viewer_id === "ann"),
        ),
    ).toEqual(
      before.filter(
        (row) => !(row.scope === "repo" && row.scope_id === "public" && row.viewer_id === "ann"),
      ),
    );
    await t.deliver();
    expect(chatText).toHaveBeenCalledOnce();

    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(jobs.length);
    expect(t.sent).toEqual(expect.arrayContaining(jobs));
  });

  test.each(["complete", "delete"])(
    "stale invalidation preserves an active generation before %s",
    async (outcome) => {
      const t = fixture();
      const site = { ...t.job, scope: "site" as const, scopeId: "ann", ownerAccountId: "ann" };
      await readReleaseHighlights(t.env, actor, site);
      await t.deliver(site);
      vi.setSystemTime(new Date("2026-10-12T00:00:01Z"));
      t.sqlite.exec("UPDATE release_note_entries SET summary='Changed source' WHERE id='open'");

      const readerPaused = barrier();
      const resumeReader = barrier();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
        const result = await digest(...args);
        readerPaused.release();
        await resumeReader.wait;
        return result;
      });
      const staleRead = readReleaseHighlights(t.env, actor, site);
      await readerPaused.wait;
      await sweepReleaseHighlights(t.env);
      const inferenceStarted = barrier();
      const resumeInference = barrier();
      vi.mocked(chatText).mockImplementationOnce(async () => {
        inferenceStarted.release();
        await resumeInference.wait;
        return { text: "- Changed source.", usage: { model: "test-model", tokens: 20 } };
      });
      const delivery = t.deliver(site);
      await inferenceStarted.wait;
      const active = t.sqlite.prepare("SELECT * FROM release_highlights").get();
      resumeReader.release();
      expect((await staleRead).body).toBeNull();
      expect(t.sqlite.prepare("SELECT * FROM release_highlights").get()).toEqual(active);
      expect(t.sent).toHaveLength(2);

      if (outcome === "delete") {
        t.sqlite.exec("DELETE FROM repos WHERE id='public'");
        expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
          n: 0,
        });
      }
      resumeInference.release();
      await delivery;
      if (outcome === "complete") {
        expect((await readReleaseHighlights(t.env, actor, site)).body).toBe("- Changed source.");
        expect(t.sqlite.prepare("SELECT due_at FROM release_highlights").get()).toEqual({
          due_at: Date.now() + 24 * 3600_000,
        });
        await sweepReleaseHighlights(t.env);
        expect(t.sent).toHaveLength(2);
      } else {
        expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
          n: 0,
        });
      }
      expect(chatText).toHaveBeenCalledTimes(2);
    },
  );

  test("deletion of the previous manifest cancels admission before paying for replacement sources", async () => {
    const t = fixture();
    const site = { ...t.job, scope: "site" as const, scopeId: "ann", ownerAccountId: "ann" };
    await readReleaseHighlights(t.env, actor, site);
    await t.deliver(site);
    const insert = t.sqlite.prepare(
      `INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES (?,'private',?,?,'commit','feature','New private outcome','Replacement source','new','2026-10-11','2026-10-11')`,
    );
    for (let i = 0; i < 60; i++) insert.run(`replacement-${i}`, day, `commit:replacement-${i}`);
    vi.setSystemTime(new Date("2026-10-12T00:00:01Z"));
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(2);

    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let inputs = 0;
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      const result = await digest(...args);
      if (++inputs === 60) {
        // The latest 60 no longer reference public, but the persisted manifest does.
        t.sqlite.exec("DELETE FROM repos WHERE id='public'");
        expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
          n: 0,
        });
      }
      return result;
    });
    await t.deliver(site);
    hashing.mockRestore();
    expect(inputs).toBe(60);
    expect(chatText).toHaveBeenCalledOnce();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });

    await readReleaseHighlights(t.env, actor, site);
    expect(t.sent).toHaveLength(3);
    await t.deliver(site);
    expect(chatText).toHaveBeenCalledTimes(2);
    expect((await readReleaseHighlights(t.env, actor, site)).status.state).toBe("ready");
  });

  test.each(["edit", "delete", "revoke"])(
    "%s suppresses previously summarized text before cadence",
    async (change) => {
      const t = fixture();
      await readReleaseHighlights(t.env, actor, t.job);
      await t.deliver();
      if (change === "edit")
        t.sqlite.exec(
          "UPDATE release_note_entries SET summary='Changed source' WHERE id='secret-entry'",
        );
      if (change === "delete")
        t.sqlite.exec("DELETE FROM release_note_entries WHERE id='secret-entry'");
      if (change === "revoke") t.sqlite.exec("DELETE FROM org_members WHERE org_id='secret'");
      const result = await readReleaseHighlights(t.env, actor, t.job);
      expect(result.body).toBeNull();
      expect(result.notes).toEqual([]);
      expect(result.status.state).toBe("generating");
      expect(t.sent).toHaveLength(2);
    },
  );

  test("revocation after admission prevents a private-scope model call", async () => {
    const t = fixture();
    const job = { ...t.job, scopeId: "private" };
    await readReleaseHighlights(t.env, actor, job);
    t.sqlite.exec("DELETE FROM org_members WHERE org_id='orbit'");
    await t.deliver(job);
    expect(chatText).not.toHaveBeenCalled();
    await expect(readReleaseHighlights(t.env, actor, job)).rejects.toMatchObject({ status: 404 });
  });

  test("provider failure is observable, waits for cadence, and preserves detailed notes", async () => {
    const t = fixture();
    const before = await releaseNotesFor(
      t.env.DB,
      "public",
      day,
      await viewerTrackers(t.env.DB, actor),
    );
    vi.mocked(chatText).mockRejectedValue(new Error("Provider unavailable"));
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    expect((await readReleaseHighlights(t.env, actor, t.job)).status.state).toBe("failed");
    expect(t.sqlite.prepare("SELECT error FROM release_highlights").get()).toMatchObject({
      error: "Error: Provider unavailable",
    });
    await sweepReleaseHighlights(t.env);
    await t.deliver();
    expect(chatText).toHaveBeenCalledOnce();
    expect(
      await releaseNotesFor(t.env.DB, "public", day, await viewerTrackers(t.env.DB, actor)),
    ).toEqual(before);
  });

  test("disabled, AI-off and empty projections never invoke a model", async () => {
    const t = fixture();
    t.sqlite.exec("INSERT INTO account_settings(account_id,ai_release_notes) VALUES ('orbit',0)");
    expect((await readReleaseHighlights(t.env, actor, t.job)).status.state).toBe("disabled");
    expect(t.sent).toHaveLength(0);
    t.sqlite.exec("UPDATE account_settings SET ai_release_notes=1");
    expect(
      (await readReleaseHighlights({ ...t.env, AI: undefined } as unknown as Env, actor, t.job))
        .status.state,
    ).toBe("disabled");
    t.sqlite.exec("DELETE FROM release_note_entries");
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    expect(chatText).not.toHaveBeenCalled();
    expect((await readReleaseHighlights(t.env, actor, t.job)).status.state).toBe("idle");
  });

  test("purge predicate and deletion triggers remove referencing cross-scope projections", async () => {
    const t = fixture();
    const site = { ...t.job, scope: "site" as const, scopeId: "ann", ownerAccountId: "ann" };
    await readReleaseHighlights(t.env, actor, site);
    await t.deliver(site);
    const predicate = CHILD_ROWS.find(([name]) => name === "release_highlights")![1];
    t.sqlite.prepare(`DELETE FROM release_highlights WHERE ${predicate}`).run("public");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
    await readReleaseHighlights(t.env, actor, site);
    await t.deliver(site);
    t.sqlite.exec("DELETE FROM accounts WHERE id='secret'");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
    await readReleaseHighlights(t.env, actor, site);
    await t.deliver(site);
    t.sqlite.exec("DELETE FROM repos WHERE id='public'");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
  });

  test("routes require person access and never offer a shared public cache", async () => {
    const t = fixture();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      await next();
    });
    app.route("/api/repos/:owner/:name/release-notes", releaseNotes);
    app.route("/api/tracker/:owner/release-notes", trackerReleaseNotes);
    app.route("/api/release-notes", siteReleaseNotes);
    const repo = await app.request("/api/repos/orbit/public/release-notes/highlights", {}, t.env);
    expect(repo.status).toBe(200);
    expect(repo.headers.get("cache-control")).toBe("private, no-store");
    expect(await repo.json()).toMatchObject({ status: { state: "disabled" }, body: null });
    expect(
      (await app.request("/api/tracker/orbit/release-notes/highlights", {}, t.env)).status,
    ).toBe(401);
    expect((await app.request("/api/release-notes/highlights", {}, t.env)).status).toBe(401);
    expect(t.sent).toHaveLength(0);
  });
});
