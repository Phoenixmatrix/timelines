import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import { repos } from "./repos.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkflowEntrypoint: class {} }));
const closers: { close(): void }[] = [];
beforeEach(() =>
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  for (const closer of closers.splice(0)) closer.close();
});

function setup(viewer = "reader") {
  const sqlite = migratedDatabase();
  closers.push(sqlite);
  const canonical = fakeHistory();
  const work = fakeHistory();
  const base = canonical.commit({ files: { "file.txt": "base" } });
  const workBase = work.commit({ files: { "file.txt": "base" } });
  const progress = work.commit({ parents: [workBase], files: { "file.txt": "retained progress" } });
  const suffix = crypto.randomUUID();
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner'),('reader','user','reader','Reader');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','owner','app','private','canonical-${suffix}','https://canonical');
    INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','reader','read');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,created_at,updated_at)
    VALUES('work_a','repo','timeline','topic','owner','work-${suffix}','https://work','ready','allocate','canonical','${base}','tree','refs/heads/main','canonical','${base}','tree','refs/heads/main',1,'now','now');
  `);
  const opened: string[] = [];
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: {
      get: async (name: string) => {
        opened.push(name);
        if (name === `canonical-${suffix}`) return canonical.artifacts.get();
        if (name === `work-${suffix}`) return work.artifacts.get();
        throw new Error("Unexpected physical repository");
      },
    },
  } as unknown as Env;
  const actor: Actor = { id: viewer, slug: viewer, displayName: viewer, isSiteAdmin: false };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos", repos);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
  return {
    sqlite,
    opened,
    progress,
    base,
    request: (path: string, init?: RequestInit) =>
      app.request(`/api/repos/owner/${path}`, init, env, ctx),
    call: (path: string) =>
      app.request(
        `/api/repos/owner/app${path.startsWith("?") ? "" : "/"}${path}`,
        undefined,
        env,
        ctx,
      ),
    pending,
  };
}

describe("source-qualified browser reads", () => {
  test("work OIDs and cached objects never fall back to canonical, including retained overwritten progress", async () => {
    const t = setup();
    const work = await t.call(`blob?source=work_a&ref=${t.progress}&path=file.txt`);
    expect(work.status).toBe(200);
    expect(await work.json()).toMatchObject({
      text: "retained progress",
      source: { sourceId: "work_a" },
    });
    expect(work.headers.get("cache-control")).toBe("private, no-store");
    for (const endpoint of ["blob", "tree", "history", "commits"]) {
      const path = endpoint === "blob" ? "&path=file.txt" : "";
      expect((await t.call(`${endpoint}?ref=${t.progress}${path}`)).status).toBe(404);
    }
    t.sqlite.exec("UPDATE timeline_work_sources SET state='archived' WHERE source_id='work_a'");
    const archived = await t.call(`blob?source=work_a&ref=${t.progress}&path=file.txt`);
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ text: "retained progress" });
    await Promise.allSettled(t.pending);
  });

  test("revoked access, foreign source substitution, expiry and canonical tombstones fail closed", async () => {
    const t = setup();
    expect((await t.call(`blob?source=foreign&ref=${t.progress}&path=file.txt`)).status).toBe(404);
    t.sqlite.exec("DELETE FROM repo_collaborators");
    expect((await t.call(`blob?source=work_a&ref=${t.progress}&path=file.txt`)).status).toBe(404);
    expect((await t.call(`sources/work_a/lineage?commit=${t.progress}`)).status).toBe(404);
    expect(t.opened).toEqual([]);
    t.sqlite.exec(
      "INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','reader','read'); UPDATE timeline_work_sources SET state='purged'",
    );
    const expired = await t.call(`blob?source=work_a&ref=${t.progress}&path=file.txt`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: "source_expired" });
    t.sqlite.exec("UPDATE repos SET deleted_at='2026-10-04T00:00:00Z'");
    expect((await t.call(`blob?source=work_a&ref=${t.progress}&path=file.txt`)).status).toBe(404);
    expect(t.opened).toEqual([]);
  });

  test("expired source metadata supports retained output without exposing canonical code", async () => {
    const t = setup();
    t.sqlite.exec("UPDATE timeline_work_sources SET state='purged', artifacts_remote=NULL");
    const detail = await t.call("?source=work_a&metadata=1");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      source: { sourceId: "work_a", kind: "timeline-work" },
      sourceState: "expired",
      head: null,
      branches: [],
      tags: [],
    });
    expect((await t.call("?source=work_a")).status).toBe(410);
    expect(
      (await t.call(`blob?source=work_a&metadata=1&ref=${t.progress}&path=file.txt`)).status,
    ).toBe(410);
    expect((await t.call("?source=foreign&metadata=1")).status).toBe(404);
    t.sqlite.exec("DELETE FROM repo_collaborators");
    expect((await t.call("?source=work_a&metadata=1")).status).toBe(404);
    t.sqlite.exec(
      "INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','reader','read'); UPDATE repos SET deleted_at='2026-10-04'",
    );
    expect((await t.call("?source=work_a&metadata=1")).status).toBe(404);
    expect(t.opened).toEqual([]);
  });
});

describe("repository rename", () => {
  const patch = (name: unknown, extra = {}) => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...extra }),
  });

  test("changes only the URL name, retaining physical sources, history and ID-keyed dependents", async () => {
    const t = setup("owner");
    t.sqlite.exec(`
      INSERT INTO repo_refs(repo_id,ref,oid) VALUES('repo','refs/heads/main','${t.base}');
      INSERT INTO ref_updates(repo_id,ref,new_oid) VALUES('repo','refs/heads/main','${t.base}');
      INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status)
        VALUES('run','repo',1,'${t.base}','main','push','succeeded');
      INSERT INTO repo_mirrors(repo_id,url) VALUES('repo','https://github.com/owner/mirror.git');
    `);
    const before = t.sqlite.prepare("SELECT * FROM repos WHERE id='repo'").get();
    const tables = [
      "repo_collaborators",
      "timeline_work_sources",
      "repo_refs",
      "ref_updates",
      "ci_runs",
      "repo_mirrors",
    ];
    const dependents = () =>
      tables.map((table) => t.sqlite.prepare(`SELECT * FROM ${table}`).all());
    const retained = dependents();
    // Prime object/ref caches through the old URL before the rename.
    expect((await t.request(`app/blob?ref=${t.base}&path=file.txt`)).status).toBe(200);
    const renamed = await t.request("app", patch("  renamed  "));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: "repo",
      name: "renamed",
      viewerRole: "admin",
    });
    expect(t.sqlite.prepare("SELECT * FROM repos WHERE id='repo'").get()).toEqual({
      ...before,
      name: "renamed",
    });
    expect(dependents()).toEqual(retained);
    expect((await t.request(`app/blob?ref=${t.base}&path=file.txt`)).status).toBe(404);
    const canonical = await t.request(`renamed/blob?ref=${t.base}&path=file.txt`);
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toMatchObject({
      text: "base",
      source: { repoId: "repo", sourceId: "canonical" },
    });
    const work = await t.request(`renamed/blob?source=work_a&ref=${t.progress}&path=file.txt`);
    expect(work.status).toBe(200);
    expect(await work.json()).toMatchObject({
      text: "retained progress",
      source: { repoId: "repo", sourceId: "work_a" },
    });
    expect(new Set(t.opened).size).toBe(2);
    await Promise.allSettled(t.pending);
  });

  test("readers and writers cannot rename; private repositories stay hidden from strangers", async () => {
    const t = setup();
    expect((await t.request("app", patch("renamed"))).status).toBe(403);
    t.sqlite.exec("UPDATE repo_collaborators SET role='write'");
    expect((await t.request("app", patch("renamed"))).status).toBe(403);
    t.sqlite.exec("DELETE FROM repo_collaborators");
    expect((await t.request("app", patch("renamed"))).status).toBe(404);
    expect(t.sqlite.prepare("SELECT name FROM repos").get()).toEqual({ name: "app" });
  });

  test("invalid names and live or tombstoned collisions leave both repositories untouched", async () => {
    const t = setup("owner");
    t.sqlite.exec(`INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('other','owner','taken','private','other','https://other')`);
    const before = t.sqlite.prepare("SELECT * FROM repos ORDER BY id").all();
    for (const name of ["", " ", ".hidden", "a/b", "app.GIT", "x".repeat(101), null, 42]) {
      expect((await t.request("app", patch(name, { description: "must not apply" }))).status).toBe(
        400,
      );
    }
    const conflict = await t.request("app", patch("taken", { visibility: "public" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "owner/taken already exists." });
    expect(t.sqlite.prepare("SELECT * FROM repos ORDER BY id").all()).toEqual(before);
    t.sqlite.exec("UPDATE repos SET deleted_at='now' WHERE id='other'");
    const tombstones = t.sqlite.prepare("SELECT * FROM repos ORDER BY id").all();
    const deleting = await t.request("app", patch("taken"));
    expect(deleting.status).toBe(409);
    expect(await deleting.json()).toEqual({
      error: "owner/taken is being deleted. Its name is free again once that finishes.",
    });
    expect(t.sqlite.prepare("SELECT * FROM repos ORDER BY id").all()).toEqual(tombstones);
    t.sqlite.exec("UPDATE repos SET deleted_at='now' WHERE id='repo'");
    expect((await t.request("app", patch("renamed"))).status).toBe(404);
  });

  test("omitted and unchanged names preserve the existing partial update contract", async () => {
    const t = setup("owner");
    expect((await t.request("app", patch(undefined, { description: "updated" }))).status).toBe(200);
    expect((await t.request("app", patch("app", { visibility: "public" }))).status).toBe(200);
    expect(t.sqlite.prepare("SELECT name,description,visibility FROM repos").get()).toEqual({
      name: "app",
      description: "updated",
      visibility: "public",
    });
  });
});
