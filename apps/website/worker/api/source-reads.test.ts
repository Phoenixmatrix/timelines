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

function setup() {
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
  const actor: Actor = { id: "reader", slug: "reader", displayName: "Reader", isSiteAdmin: false };
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
