import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { RefContext, RefResolution, ResolveRefsResponse } from "../../shared/refs.ts";
import type { Mutation } from "../../shared/tracker.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { invalidateRefs } from "../objects.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";
import { TrackerStore, type Access } from "../tracker/store.ts";
import { refs } from "./api.ts";

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };

const HEAD = "3f2a9c1b".padEnd(40, "0");
const RAN = "7e5d4c3b".padEnd(40, "1");
const OTHER = "3f2a9c1c".padEnd(40, "2");

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  vi.unstubAllGlobals();
});

/** A real TrackerStore for one owner, with a team ENG. */
function trackerFor(ownerId: string) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new TrackerStore(trackerSql(db), transactional(db), () => Date.now());
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    owner: { id: ownerId, slug: ownerId, displayName: ownerId },
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let operation = 0;
  const mutate = (...mutations: Mutation[]) =>
    store.mutate(access, { operationId: `${ownerId}-${++operation}`, mutations });
  mutate({ kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } });
  let n = 0;
  return {
    store,
    add(title: string) {
      const id = `${ownerId}-issue-${++n}`;
      mutate({ kind: "issue.create", id, data: { teamId: "team", title } });
      return id;
    },
  };
}

function setup(publicUrl?: string) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role) VALUES
      ('ann', 'user', 'ann', 'Ann', NULL), ('ben', 'user', 'ben', 'Ben', NULL),
      ('orbit', 'org', 'orbit', 'Orbit', 'read'), ('acme', 'org', 'acme', 'Acme', 'read'),
      ('vault', 'org', 'vault', 'Vault', 'none');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('orbit', 'ann', 'member'), ('acme', 'ann', 'member'), ('vault', 'ben', 'owner');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_engine', 'orbit', 'engine', 'public', 'a-engine', 'https://remote.test/engine'),
      ('r_secret', 'vault', 'secret', 'private', 'a-secret', 'https://remote.test/secret');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('run1', 'r_engine', 1, '${RAN}', 'refs/heads/main', 'push', 'succeeded');
  `);
  const git = fakeRemotes();
  git.add("https://remote.test/engine", { "refs/heads/main": HEAD, "refs/heads/other": OTHER });
  git.add("https://remote.test/secret", { "refs/heads/main": "9".repeat(40) });
  invalidateRefs("a-engine");
  invalidateRefs("a-secret");
  vi.stubGlobal("fetch", git.fetch);
  vi.stubGlobal("caches", {
    default: { match: async () => undefined, put: async () => {}, delete: async () => false },
  });

  const trackers = new Map<string, ReturnType<typeof trackerFor>>();
  const tracker = (id: string) => {
    let found = trackers.get(id);
    if (!found) trackers.set(id, (found = trackerFor(id)));
    return found;
  };
  const getByName = vi.fn((id: string) => ({
    issueRefs: async (wanted: string[]) => ({
      ok: true,
      value: tracker(id).store.issueRefs(wanted),
    }),
  }));
  const env = {
    DB: d1(sqlite),
    TRACKER: { getByName },
    ARTIFACTS: {
      get: async () => ({ ...(await git.artifacts.get()), log: async () => [] }),
    },
    ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}),
  } as unknown as Env;
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/refs", refs);
  return {
    git,
    tracker,
    getByName,
    as(next: Actor | null) {
      actor = next;
    },
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
    async resolve(list: string[], context?: RefContext): Promise<RefResolution[]> {
      const response = await app.request(
        "/api/refs/resolve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refs: list, context }),
        },
        env,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as ResolveRefsResponse).results;
    },
  };
}

/** Each result as `ref -> what it is`, compactly. */
function summary(results: RefResolution[]) {
  return Object.fromEntries(
    results.map((r) => [
      r.ref,
      r.status === "resolved"
        ? r.target.path
        : r.status === "ambiguous"
          ? r.candidates.map((c) => c.path)
          : r.ours
            ? "unresolved (ours)"
            : null,
    ]),
  );
}

let world: ReturnType<typeof setup>;
beforeEach(() => {
  world = setup();
  world.tracker("orbit").add("Orbit work"); // ENG-1
  world.tracker("acme").add("Acme work"); // ENG-1
  world.tracker("acme").add("Acme only"); // ENG-2
  world.tracker("vault").add("Vault secret"); // ENG-1
  world.tracker("vault").add("Vault two"); // ENG-2
  world.tracker("vault").add("Vault three"); // ENG-3
  world.tracker("ann"); // a team, no issues
});

describe("issue keys", () => {
  test("a key in two of your trackers is ambiguous; context decides", async () => {
    expect(summary(await world.resolve(["ENG-1"]))).toEqual({
      "ENG-1": ["/tracker/acme/issues/acme-issue-1", "/tracker/orbit/issues/orbit-issue-1"],
    });
    // The page's tracker first.
    expect(summary(await world.resolve(["ENG-1"], { tracker: "orbit" }))).toEqual({
      "ENG-1": "/tracker/orbit/issues/orbit-issue-1",
    });
    // Then the trackers subscribed to the page's repository (its owner's is).
    expect(summary(await world.resolve(["ENG-1"], { owner: "orbit", repo: "engine" }))).toEqual({
      "ENG-1": "/tracker/orbit/issues/orbit-issue-1",
    });
    // A context tracker without the key falls through to the others.
    expect(summary(await world.resolve(["ENG-2"], { tracker: "orbit" }))).toEqual({
      "ENG-2": "/tracker/acme/issues/acme-issue-2",
    });
  });

  test("an issue in a tracker you can't read stays text", async () => {
    // ENG-3 exists only in vault's tracker, which Ann doesn't belong to.
    expect(summary(await world.resolve(["ENG-3"]))).toEqual({ "ENG-3": null });
    // Not even asked.
    expect(world.getByName.mock.calls.map(([id]) => id)).not.toContain("vault");
    // A tracker context the viewer can't read is ignored.
    expect(summary(await world.resolve(["ENG-3"], { tracker: "vault" }))).toEqual({
      "ENG-3": null,
    });
    world.as(ben);
    expect(summary(await world.resolve(["ENG-3", "ENG-1"]))).toEqual({
      "ENG-3": "/tracker/vault/issues/vault-issue-3",
      "ENG-1": "/tracker/vault/issues/vault-issue-1",
    });
    world.as(null);
    expect(summary(await world.resolve(["ENG-1"]))).toEqual({ "ENG-1": null });
  });

  test("keys that might be another tracker's are left alone", async () => {
    const results = await world.resolve(["JIRA-12", "ENG-99", "UTF-8"]);
    expect(results.every((r) => r.status === "unresolved" && !r.ours)).toBe(true);
  });

  test("a resolved issue carries what a link needs", async () => {
    const [result] = await world.resolve(["ENG-2"]);
    expect(result).toEqual({
      ref: "ENG-2",
      status: "resolved",
      target: {
        kind: "issue",
        path: "/tracker/acme/issues/acme-issue-2",
        label: "ENG-2 · Acme only",
        tracker: "acme",
        id: "acme-issue-2",
        key: "ENG-2",
        title: "Acme only",
        status: "todo",
      },
    });
  });
});

describe("tracker URLs", () => {
  test("only this deployment's, only trackers you belong to", async () => {
    const ours = "http://localhost/tracker/orbit/issues/ENG-1";
    const byId = "http://localhost/tracker/acme/issues/acme-issue-2";
    const theirs = "https://elsewhere.test/tracker/orbit/issues/ENG-1";
    const closed = "http://localhost/tracker/vault/issues/ENG-1";
    const missing = "http://localhost/tracker/orbit/issues/ENG-404";
    expect(summary(await world.resolve([ours, byId, theirs, closed, missing]))).toEqual({
      [ours]: "/tracker/orbit/issues/orbit-issue-1",
      [byId]: "/tracker/acme/issues/acme-issue-2",
      [theirs]: null,
      [closed]: "unresolved (ours)",
      [missing]: "unresolved (ours)",
    });
  });

  test("PUBLIC_URL's origin is ours too", async () => {
    world = setup("https://gm.example/");
    world.tracker("orbit").add("Orbit work");
    const url = "https://gm.example/tracker/orbit/issues/ENG-1";
    expect(summary(await world.resolve([url]))).toEqual({
      [url]: "/tracker/orbit/issues/orbit-issue-1",
    });
  });
});

describe("repositories and commits", () => {
  test("owner/repo resolves only when readable", async () => {
    expect(summary(await world.resolve(["orbit/engine", "vault/secret", "nobody/none"]))).toEqual({
      "orbit/engine": "/orbit/engine",
      "vault/secret": null,
      "nobody/none": null,
    });
    world.as(ben);
    expect(summary(await world.resolve(["vault/secret"]))).toEqual({
      "vault/secret": "/vault/secret",
    });
  });

  test("hashes resolve in the page's repository, short ones to their full hash", async () => {
    const context = { owner: "orbit", repo: "engine" };
    expect(
      summary(
        await world.resolve(
          [HEAD, "3f2a9c1b", "7e5d4c3", "3f2a9c1", "abc1234", "a".repeat(40)],
          context,
        ),
      ),
    ).toEqual({
      [HEAD]: `/orbit/engine?commit=${HEAD}`,
      // A branch tip.
      "3f2a9c1b": `/orbit/engine?commit=${HEAD}`,
      // A CI run's commit.
      "7e5d4c3": `/orbit/engine?commit=${RAN}`,
      // Prefixes two commits: not guessed.
      "3f2a9c1": null,
      abc1234: null,
      ["a".repeat(40)]: null,
    });
  });

  test("explicit letters-only and numeric SHA prefixes resolve without bypassing repository access", async () => {
    const letters = "afeaaab".padEnd(40, "d");
    const digits = "1234567".padEnd(40, "8");
    world.git.add("https://remote.test/engine", {
      "refs/heads/main": letters,
      "refs/heads/numeric": digits,
    });
    world.git.add("https://remote.test/secret", { "refs/heads/main": letters });
    expect(
      summary(await world.resolve(["afeaaab", "1234567"], { owner: "orbit", repo: "engine" })),
    ).toEqual({
      afeaaab: `/orbit/engine?commit=${letters}`,
      "1234567": `/orbit/engine?commit=${digits}`,
    });
    expect(summary(await world.resolve(["afeaaab"]))).toEqual({ afeaaab: null });
    expect(summary(await world.resolve(["afeaaab"], { owner: "vault", repo: "secret" }))).toEqual({
      afeaaab: null,
    });
    world.as(ben);
    expect(summary(await world.resolve(["afeaaab"], { owner: "vault", repo: "secret" }))).toEqual({
      afeaaab: `/vault/secret?commit=${letters}`,
    });
  });

  test("hashes need a repository the viewer can read", async () => {
    expect(summary(await world.resolve(["3f2a9c1b"]))).toEqual({ "3f2a9c1b": null });
    expect(summary(await world.resolve(["9999999a"], { owner: "vault", repo: "secret" }))).toEqual({
      "9999999a": null,
    });
  });
});

describe("the endpoints", () => {
  test("rejects malformed batches", async () => {
    const post = (body: unknown) =>
      world.request("/api/refs/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({})).status).toBe(400);
    expect((await post({ refs: [""] })).status).toBe(400);
    expect((await post({ refs: Array(101).fill("ENG-1") })).status).toBe(400);
    expect((await post({ refs: ["x".repeat(301)] })).status).toBe(400);
    // Results keep request order, repeats included.
    const results = await world.resolve(["orbit/engine", "ENG-99", "orbit/engine"]);
    expect(results.map((r) => r.ref)).toEqual(["orbit/engine", "ENG-99", "orbit/engine"]);
  });

  test("go redirects, defers to the chooser, or answers JSON", async () => {
    const resolved = await world.request("/api/refs/go/ENG-2");
    expect(resolved.status).toBe(302);
    expect(resolved.headers.get("location")).toBe("/tracker/acme/issues/acme-issue-2");

    const ambiguous = await world.request("/api/refs/go/ENG-1");
    expect(ambiguous.headers.get("location")).toBe("/-/go/ENG-1");

    const scoped = await world.request(
      `/api/refs/go/${encodeURIComponent("3f2a9c1b")}?owner=orbit&repo=engine`,
    );
    expect(scoped.headers.get("location")).toBe(`/orbit/engine?commit=${HEAD}`);

    const json = await world.request("/api/refs/go/ENG-1", {
      headers: { accept: "application/json" },
    });
    expect(json.status).toBe(200);
    const body = (await json.json()) as RefResolution;
    expect(body.status).toBe("ambiguous");

    const none = await world.request("/api/refs/go/orbit%2Fnope?format=json");
    expect(none.status).toBe(404);
  });
});
