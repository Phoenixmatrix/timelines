import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { RefContext, RefResolution, ResolveRefsResponse } from "../../shared/refs.ts";
import type { Mutation } from "../../shared/tracker.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { invalidateRefs } from "../objects.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";
import { TrackerStore, type Access } from "../tracker/store.ts";
import { refs } from "./api.ts";
import { isActorCredentialLive } from "../auth.ts";
import { fakeDurableState, fakeDurableObjectId } from "../testing/durable-state.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";
import { findSpaceById } from "../spaces/access.ts";

const ann: Actor = {
  id: "ann",
  slug: "ann",
  displayName: "Ann",
  isSiteAdmin: false,
  credential: { kind: "token", id: "ann-token" },
};
const ben: Actor = {
  id: "ben",
  slug: "ben",
  displayName: "Ben",
  isSiteAdmin: false,
  credential: { kind: "token", id: "ben-token" },
};

const HEAD = "3f2a9c1b".padEnd(40, "0");
const RAN = "7e5d4c3b".padEnd(40, "1");
const OTHER = "3f2a9c1c".padEnd(40, "2");

const databases: DatabaseSync[] = [];
const environments: Array<() => void> = [];
afterEach(() => {
  for (const close of environments.splice(0)) close();
  for (const db of databases) db.close();
  databases.length = 0;
  vi.unstubAllGlobals();
});

interface TestTracker {
  store: TrackerStore;
  add(title: string): string;
}

interface TestWorld {
  sqlite: DatabaseSync;
  git: { add(url: string, refs: Record<string, string>): void };
  tracker(id: string): TestTracker;
  getByName: { mock: { calls: [string][] } };
  as(actor: Actor | null): void;
  request(path: string, init?: RequestInit): Response | Promise<Response>;
  resolve(list: string[], context?: RefContext): Promise<RefResolution[]>;
}

/** A real TrackerStore for one Space, with a team ENG. */
async function trackerFor(env: Env, spaceId: string) {
  const { db, ctx } = fakeDurableState({ name: spaceId });
  databases.push(db);
  const scope = await initializeFreshTrackerSpace(env, ctx, spaceId);
  const space = (await findSpaceById(env.DB, spaceId))!;
  const store = new TrackerStore(trackerSql(db), transactional(db), () => Date.now());
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    agentId: null,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let operation = 0;
  const mutate = (...mutations: Mutation[]) =>
    store.mutate(access, {
      contractVersion: 4,
      spaceId,
      migrationEpoch: scope.migrationEpoch,
      operationId: `${spaceId}-${++operation}`,
      mutations,
    });
  mutate({ kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } });
  let n = 0;
  return {
    store,
    add(title: string) {
      const id = `${spaceId}-issue-${++n}`;
      mutate({ kind: "issue.create", id, data: { teamId: "team", title } });
      return id;
    },
  };
}

async function setup(publicUrl?: string) {
  const fresh = await createFreshSpaceTestEnvironment();
  environments.push(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name) VALUES
    ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'), ('vault', 'user', 'unrelated-person', 'Unrelated');
    INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four) VALUES
    ('ann-token', 'ann', 'Test', 'read', 'ann-hash', 'hash'),
    ('ben-token', 'ben', 'Test', 'read', 'ben-hash', 'hash');`);
  for (const id of ["ann", "orbit", "acme", "vault"]) {
    const person = id === "vault" ? "ben" : "ann";
    await seedSpaceFixture(fresh.env.DB, {
      organization: { id: `org-${id}`, slug: `org-${id}`, displayName: id, kind: "company" },
      space: { id, slug: id, displayName: id },
      actorId: person,
      members: [
        {
          accountId: person,
          role: "owner",
          grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
        },
        ...(id === "vault" ? [{ accountId: "ann", role: "owner" as const }] : []),
      ],
    });
  }
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
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

  Reflect.set(fresh.env, "TRACKER", { idFromName: fakeDurableObjectId });
  const trackers = new Map<string, TestTracker>();
  for (const id of ["ann", "orbit", "acme", "vault"]) {
    trackers.set(id, await trackerFor(fresh.env, id));
  }
  const tracker = (id: string) => {
    const found = trackers.get(id);
    if (!found) throw new Error(`Missing fixture Tracker ${id}`);
    return found;
  };
  const getByName = vi.fn((id: string) => ({
    issueRefs: async (access: Access, wanted: string[]) => {
      expect(access.spaceId).toBe(id);
      expect(access.contractVersion).toBe(4);
      const identity = access.principalId === "ann" ? ann : ben;
      expect(access.credential).toEqual(identity.credential);
      if (
        !(await isActorCredentialLive(fresh.env.DB, { ...identity, credential: access.credential }))
      )
        return { ok: false as const, status: 403, code: "forbidden", error: "Credential revoked" };
      return {
        ok: true,
        value: tracker(id).store.issueRefs(wanted),
      };
    },
  }));
  const env = {
    ...fresh.env,
    TRACKER: { idFromName: fakeDurableObjectId, getByName },
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
    sqlite,
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

let world: TestWorld;
beforeEach(async () => {
  world = await setup();
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
    // Then the repository's Space, provided the viewer has its grant.
    expect(summary(await world.resolve(["ENG-1"], { space: "orbit", repo: "engine" }))).toEqual({
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
    world = await setup("https://gm.example/");
    world.tracker("orbit").add("Orbit work");
    const url = "https://gm.example/tracker/orbit/issues/ENG-1";
    expect(summary(await world.resolve([url]))).toEqual({
      [url]: "/tracker/orbit/issues/orbit-issue-1",
    });
  });
});

test("Organization ownership and a matching person ID never grant private content", async () => {
  expect(summary(await world.resolve(["vault/secret", "ENG-3"], { tracker: "vault" }))).toEqual({
    "vault/secret": null,
    "ENG-3": null,
  });
  world.as({ id: "vault", slug: "unrelated-person", displayName: "Unrelated", isSiteAdmin: false });
  expect(summary(await world.resolve(["vault/secret", "ENG-3"], { tracker: "vault" }))).toEqual({
    "vault/secret": null,
    "ENG-3": null,
  });
});

test("grant revocation removes warm-batch Tracker resolution on the next request", async () => {
  expect(summary(await world.resolve(["ENG-2"]))).toEqual({
    "ENG-2": "/tracker/acme/issues/acme-issue-2",
  });
  world.sqlite.exec("DELETE FROM space_grants WHERE space_id='acme' AND account_id='ann'");
  expect(summary(await world.resolve(["ENG-2"]))).toEqual({ "ENG-2": null });
});

test("a repository collaborator can resolve only that resource, never its Tracker", async () => {
  world.sqlite.exec(
    "INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('r_secret', 'ann', 'read')",
  );
  expect(
    summary(await world.resolve(["vault/secret", "ENG-3"], { space: "vault", repo: "secret" })),
  ).toEqual({
    "vault/secret": "/vault/secret",
    "ENG-3": null,
  });
});

test("the current credential accompanies every Tracker read and revocation stays unresolved", async () => {
  expect(summary(await world.resolve(["ENG-2"]))).toEqual({
    "ENG-2": "/tracker/acme/issues/acme-issue-2",
  });
  world.sqlite.exec("DELETE FROM access_tokens WHERE id='ann-token'");
  expect(summary(await world.resolve(["ENG-2"]))).toEqual({ "ENG-2": null });
});

describe("repositories and commits", () => {
  test("space/repo resolves only when readable", async () => {
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
    const context = { space: "orbit", repo: "engine" };
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
      summary(await world.resolve(["afeaaab", "1234567"], { space: "orbit", repo: "engine" })),
    ).toEqual({
      afeaaab: `/orbit/engine?commit=${letters}`,
      "1234567": `/orbit/engine?commit=${digits}`,
    });
    expect(summary(await world.resolve(["afeaaab"]))).toEqual({ afeaaab: null });
    expect(summary(await world.resolve(["afeaaab"], { space: "vault", repo: "secret" }))).toEqual({
      afeaaab: null,
    });
    world.as(ben);
    expect(summary(await world.resolve(["afeaaab"], { space: "vault", repo: "secret" }))).toEqual({
      afeaaab: `/vault/secret?commit=${letters}`,
    });
  });

  test("hashes need a repository the viewer can read", async () => {
    expect(summary(await world.resolve(["3f2a9c1b"]))).toEqual({ "3f2a9c1b": null });
    expect(summary(await world.resolve(["9999999a"], { space: "vault", repo: "secret" }))).toEqual({
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
      `/api/refs/go/${encodeURIComponent("3f2a9c1b")}?space=orbit&repo=engine`,
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
