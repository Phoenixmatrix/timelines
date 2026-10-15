// The history route's cover=1 (CORE-451): one request answers a directory's
// last changes, the same as paging, and later reads and later heads reuse it
// from the Cache API.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { HistoryPage } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { tokenCredential } from "../auth.ts";
import { forgetObjectMemory } from "../objects.ts";
import { fakeHistory } from "../testing/history.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { Timing } from "../timing.ts";
import { repos } from "./repos.ts";
import { issueToken } from "./tokens.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const closers: { close(): void }[] = [];
const store = new Map<string, Response>();
beforeEach(() => {
  store.clear();
  forgetObjectMemory();
  vi.stubGlobal("caches", {
    default: {
      match: async (key: string) => store.get(String(key))?.clone(),
      put: async (key: string, value: Response) => {
        store.set(String(key), value.clone());
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const closer of closers.splice(0)) closer.close();
});

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  closers.push(fresh);
  const { sqlite, env } = fresh;
  const git = fakeHistory();
  // LICENSE never changes after the first commit: the root's answer reaches it,
  // more than one plain page back.
  const first = git.commit({ files: { LICENSE: "mit", "src/app.ts": "0", readme: "0" } });
  let head = first;
  for (let n = 1; n < 150; n++)
    head = git.commit({
      parents: [head],
      files: { LICENSE: "mit", "src/app.ts": String(n), readme: String(n % 7) },
    });
  const suffix = crypto.randomUUID();
  sqlite.exec(`
    BEGIN;
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO organizations(id,slug,display_name,kind,default_space_id) VALUES('organization','organization','Organization','company','space');
    INSERT INTO spaces(id,organization_id,slug,display_name) VALUES('space','organization','owner','Space');
    INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by) VALUES('organization','owner','owner','test-fixture','owner');
    INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
      VALUES('space','organization','owner','admin','write','write','test-fixture','owner');
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','space','app','private','app-${suffix}','https://app');
    COMMIT;
  `);
  const calls: string[] = [];
  Reflect.set(env, "ARTIFACTS", {
    get: async () => {
      const repo = await git.artifacts.get();
      return new Proxy(repo, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function" || typeof key !== "string") return value;
          return (...args: unknown[]) => {
            calls.push(key);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  });
  const token = await issueToken(env.DB, "owner", "history-fixture", "write");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos", repos);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
  const call = async (query: string) => {
    const response = await app.request(
      `/api/repos/owner/app/history?${query}`,
      { headers: { authorization: `Bearer ${token.secret}` } },
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response;
  };
  return { git, first, head, calls, call };
}

const comparable = (page: HistoryPage) => ({
  scanned: page.scanned,
  next: page.next,
  commits: page.commits.map((commit) => commit.oid),
  entries: Object.fromEntries(
    Object.entries(page.entries).map(([path, entry]) => [
      path,
      [entry.latest.oid, entry.count] as [string, number],
    ]),
  ),
});

/** What the client's paging loop adds up to, from plain pages. */
async function paged(call: (query: string) => Promise<Response>, head: string) {
  const merged = { scanned: 0, next: null as string | null, commits: [] as string[] };
  const entries: Record<string, [string, number]> = {};
  for (let cursor = ""; ;) {
    const page = await (
      await call(`ref=${head}&entries=true${cursor ? `&cursor=${cursor}` : ""}`)
    ).json<HistoryPage>();
    const view = comparable(page);
    merged.scanned += view.scanned;
    merged.commits.push(...view.commits);
    for (const [path, [latest, count]] of Object.entries(view.entries))
      entries[path] = [entries[path]?.[0] ?? latest, (entries[path]?.[1] ?? 0) + count];
    if (!page.next) return { ...merged, entries };
    cursor = page.next;
  }
}

describe("history cover requests (CORE-451)", () => {
  test("answer in one request what paging adds up to, then from the Cache API alone", async () => {
    const { git, first, head, calls, call } = await setup();
    const response = await call(`ref=${head}&entries=true&cover=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    const cover = await response.json<HistoryPage>();
    expect(cover.scanned).toBe(150);
    expect(cover.next).toBeNull();
    expect(cover.entries.LICENSE?.latest.oid).toBe(first);
    expect(calls).toContain("log");
    expect(comparable(cover)).toEqual(await paged(call, head));

    // Another isolate: memory gone, the Cache API kept. The stored answer
    // needs no log, no tree and no commit from Artifacts.
    forgetObjectMemory();
    calls.length = 0;
    const again = await (await call(`ref=${head}&entries=true&cover=1`)).json<HistoryPage>();
    expect(comparable(again)).toEqual(comparable(cover));
    expect(calls).toEqual([]);

    // A push: the next head walks one commit, then takes the rest from its parent's answer.
    const pushed = git.commit({
      parents: [head],
      files: { LICENSE: "mit", "src/app.ts": "pushed", readme: "0" },
    });
    forgetObjectMemory();
    calls.length = 0;
    const later = await (await call(`ref=${pushed}&entries=true&cover=1`)).json<HistoryPage>();
    expect(calls).not.toContain("log");
    expect(later.scanned).toBe(151);
    expect(later.entries.src?.latest.oid).toBe(pushed);
    expect(comparable(later)).toEqual(await paged(call, pushed));
  });

  test("a folder's answer stops at the commit that completes it; plain requests keep pages", async () => {
    const { head, call } = await setup();
    const folder = await (
      await call(`ref=${head}&path=src&entries=true&cover=1`)
    ).json<HistoryPage>();
    expect(folder.scanned).toBe(1);
    expect(Object.keys(folder.entries)).toEqual(["src/app.ts"]);
    const plain = await (await call(`ref=${head}&path=src&entries=true`)).json<HistoryPage>();
    expect(plain.scanned).toBe(100);
    expect(plain.entries["src/app.ts"]?.latest.oid).toBe(folder.entries["src/app.ts"]?.latest.oid);
  });
});
