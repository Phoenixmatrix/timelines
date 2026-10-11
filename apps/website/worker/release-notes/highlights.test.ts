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
import { releaseNotes, trackerReleaseNotes } from "./api.ts";
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
const day = "@day:2026-10-08";
// The fixture clock is 2026-10-11, so this daily note is outside the 7-day window.
const oldDay = "@day:2026-10-03";
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
    INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,format_version,intro) VALUES ('public','${day}','c1','2026-10-08','2026-10-08',1,'Detailed introduction'),('private','${day}','c2','2026-10-08','2026-10-08',1,'Private introduction');
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES
    ('open','public','${day}','commit:c1','commit','feature','Parcel verification','Batch parcels can be verified','h','2026-10-08','2026-10-08'),
    ('private-entry','private','${day}','commit:c2','commit','feature','Private outcome','Private repository text','h','2026-10-08','2026-10-08');
    INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at,tracker_owner_id,issue_id,issue_key,team_id,team_key) VALUES
    ('secret-entry','public','${day}','issue:secret:SEC-1','issue','fix','Secret tracker outcome','Confidential details','h','2026-10-08','2026-10-08','secret','i1','SEC-1','t1','SEC');
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
    scope: "tracker",
    scopeId: "orbit",
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
  test("an organization projects only authorized daily sources and exact backlinks", async () => {
    const t = fixture();
    const sources = await projectReleaseHighlights(t.env, t.job);
    expect(sources.sources.map((s) => s.id)).toEqual(["open", "private-entry", "secret-entry"]);
    await expect(
      projectReleaseHighlights(t.env, { ...t.job, viewerId: "bob" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readReleaseHighlights(t.env, outsider, { ...t.job, viewerId: "bob" }),
    ).rejects.toMatchObject({ status: 403 });
    // Losing the other organization's membership removes its entry from the projection.
    t.sqlite.exec("DELETE FROM org_members WHERE org_id='secret'");
    expect((await projectReleaseHighlights(t.env, t.job)).sources.map((s) => s.id)).toEqual([
      "open",
      "private-entry",
    ]);
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    const result = await readReleaseHighlights(t.env, actor, t.job);
    expect(result.status.state).toBe("ready");
    expect(result.owner).toEqual({ slug: "orbit", displayName: "Orbit" });
    expect(result.notes).toEqual([
      { repo: { owner: "orbit", name: "public" }, release: day },
      { repo: { owner: "orbit", name: "private" }, release: day },
    ]);
    expect(vi.mocked(chatText).mock.calls[0]![3]).not.toMatch(/Secret|Confidential|SEC-1/);
  });

  test("only daily entries from the last seven days feed a summary", async () => {
    const t = fixture();
    t.sqlite.exec(`
      INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,format_version,intro) VALUES ('public','${oldDay}','c0','2026-10-03','2026-10-03',1,'Old'),('public','@day:2026-10-04','c0','2026-10-04','2026-10-04',1,'Edge');
      INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES
      ('stale','public','${oldDay}','commit:old','commit','feature','Stale outcome','Too old','h','2026-10-03','2026-10-03'),
      ('edge','public','@day:2026-10-04','commit:edge','commit','feature','Edge outcome','Seven days back','h','2026-10-04','2026-10-04');
    `);
    // 2026-10-11 minus seven days is 2026-10-04: that day still counts, the day before does not.
    expect((await projectReleaseHighlights(t.env, t.job)).sources.map((s) => s.id)).toContain(
      "edge",
    );
    expect((await projectReleaseHighlights(t.env, t.job)).sources.map((s) => s.id)).not.toContain(
      "stale",
    );
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    expect(vi.mocked(chatText).mock.calls[0]![3]).not.toMatch(/Stale outcome/);
    // Entries age out of the window as time passes, so the summary is invalidated.
    const later = new Date("2026-10-12T00:00:00Z").getTime();
    expect(
      (await projectReleaseHighlights(t.env, t.job, undefined, later)).sources.map((s) => s.id),
    ).not.toContain("edge");
  });

  test("ageing out of the window waits for the next scheduled refresh", async () => {
    const t = fixture();
    t.sqlite.exec(
      "INSERT INTO account_settings(account_id,release_highlights_interval_hours) VALUES ('orbit',168)",
    );
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    const generated = await readReleaseHighlights(t.env, actor, t.job);
    expect(generated.status.state).toBe("ready");
    const due = t.sqlite.prepare("SELECT due_at FROM release_highlights").get();
    // Every summarized day (2026-10-08) is now outside the window, but the cadence rules.
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    expect(await readReleaseHighlights(t.env, actor, t.job)).toEqual(generated);
    await sweepReleaseHighlights(t.env);
    expect(t.sqlite.prepare("SELECT due_at FROM release_highlights").get()).toEqual(due);
    expect(t.sent).toHaveLength(1);
    expect(chatText).toHaveBeenCalledOnce();
    t.sqlite.exec(`
      INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,format_version,intro) VALUES ('public','@day:2026-10-16','c3','2026-10-16','2026-10-16',1,'Fresh');
      INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,inputs_hash,shipped_at,updated_at) VALUES ('fresh','public','@day:2026-10-16','commit:fresh','commit','feature','Fresh outcome','Added this week','h','2026-10-16','2026-10-16');
    `);
    vi.setSystemTime(new Date("2026-10-18T00:00:01Z"));
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(2);
    await t.deliver();
    expect(chatText).toHaveBeenCalledTimes(2);
    const input = vi.mocked(chatText).mock.calls[1]![3];
    expect(input).toMatch(/Fresh outcome/);
    expect(input).not.toMatch(/Parcel verification/);
    expect((await readReleaseHighlights(t.env, actor, t.job)).status.state).toBe("ready");
  });

  test("losing access to an aged-out source still blanks the prose", async () => {
    const t = fixture();
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    expect((await readReleaseHighlights(t.env, actor, t.job)).body).not.toBeNull();
    t.sqlite.exec("DELETE FROM org_members WHERE org_id='secret'");
    expect((await readReleaseHighlights(t.env, actor, t.job)).body).toBeNull();
  });

  test("stale non-tracker jobs and rows are skipped without generating", async () => {
    const t = fixture();
    const stale = { ...t.job, scope: "repo", scopeId: "public" } as unknown as ReleaseHighlightsJob;
    await t.deliver(stale);
    await expect(readReleaseHighlights(t.env, actor, stale)).rejects.toMatchObject({
      status: 404,
    });
    await expect(projectReleaseHighlights(t.env, stale)).rejects.toMatchObject({ status: 404 });
    t.sqlite
      .prepare(`INSERT INTO release_highlights
        (scope,scope_id,viewer_id,owner_account_id,source_hash,body,updated_at,due_at,lease_until)
        VALUES ('site','ann','ann','ann','','',?,0,0)`)
      .run(new Date().toISOString());
    await sweepReleaseHighlights(t.env);
    expect(t.sent).toHaveLength(0);
    expect(chatText).not.toHaveBeenCalled();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
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
      expect(await attribution(t.env)).toEqual({ account: "orbit", feature: "release_highlights" });
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

  test("an exact sweep isolates organization and viewer while cron still admits unrelated due rows", async () => {
    const t = fixture();
    t.sqlite.exec(`
      INSERT INTO accounts (id,kind,slug,display_name) VALUES ('public','org','public','Public');
      INSERT INTO org_members(org_id,user_id,role) VALUES ('public','ann','member');
      INSERT INTO org_members(org_id,user_id,role) VALUES ('orbit','bob','member');
    `);
    const unrelated: ReleaseHighlightsJob[] = [
      { ...t.job, scopeId: "public", ownerAccountId: "public" },
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
    await sweepReleaseHighlights(t.env, { scope: "tracker", scopeId: "orbit", viewerId: "ann" });
    expect(t.sent).toEqual([t.job]);
    expect(
      rows.all().filter((row) => !(row.scope_id === "orbit" && row.viewer_id === "ann")),
    ).toEqual(before.filter((row) => !(row.scope_id === "orbit" && row.viewer_id === "ann")));
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
      await readReleaseHighlights(t.env, actor, t.job);
      await t.deliver();
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
      const staleRead = readReleaseHighlights(t.env, actor, t.job);
      await readerPaused.wait;
      await sweepReleaseHighlights(t.env);
      const inferenceStarted = barrier();
      const resumeInference = barrier();
      vi.mocked(chatText).mockImplementationOnce(async () => {
        inferenceStarted.release();
        await resumeInference.wait;
        return { text: "- Changed source.", usage: { model: "test-model", tokens: 20 } };
      });
      const delivery = t.deliver();
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
        expect((await readReleaseHighlights(t.env, actor, t.job)).body).toBe("- Changed source.");
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
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
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
    await t.deliver();
    hashing.mockRestore();
    expect(inputs).toBe(60);
    expect(chatText).toHaveBeenCalledOnce();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });

    await readReleaseHighlights(t.env, actor, t.job);
    expect(t.sent).toHaveLength(3);
    await t.deliver();
    expect(chatText).toHaveBeenCalledTimes(2);
    expect((await readReleaseHighlights(t.env, actor, t.job)).status.state).toBe("ready");
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

  test("revocation after admission prevents a model call", async () => {
    const t = fixture();
    await readReleaseHighlights(t.env, actor, t.job);
    t.sqlite.exec("DELETE FROM org_members WHERE org_id='orbit'");
    await t.deliver();
    expect(chatText).not.toHaveBeenCalled();
    await expect(readReleaseHighlights(t.env, actor, t.job)).rejects.toMatchObject({
      status: 403,
    });
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
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    const predicate = CHILD_ROWS.find(([name]) => name === "release_highlights")![1];
    t.sqlite.prepare(`DELETE FROM release_highlights WHERE ${predicate}`).run("public");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    t.sqlite.exec("DELETE FROM accounts WHERE id='secret'");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
    await readReleaseHighlights(t.env, actor, t.job);
    await t.deliver();
    t.sqlite.exec("DELETE FROM repos WHERE id='public'");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM release_highlights").get()).toEqual({
      n: 0,
    });
  });

  test("routes require person access, never cache, and exist only for organizations", async () => {
    const t = fixture();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      await next();
    });
    app.route("/api/repos/:owner/:name/release-notes", releaseNotes);
    app.route("/api/tracker/:owner/release-notes", trackerReleaseNotes);
    const tracker = await app.request("/api/tracker/orbit/release-notes/highlights", {}, t.env);
    expect(tracker.status).toBe(401);
    expect(tracker.headers.get("cache-control")).toBe("private, no-store");
    // The repository and site endpoints are gone.
    expect(
      (await app.request("/api/repos/orbit/public/release-notes/highlights", {}, t.env)).status,
    ).toBe(404);
    expect((await app.request("/api/release-notes/highlights", {}, t.env)).status).toBe(404);
    expect(t.sent).toHaveLength(0);
  });
});
