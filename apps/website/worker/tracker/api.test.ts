import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { cutoverControl, forgetCachedAdmission } from "../durable/cutover-admission.ts";
import { CONTENT_CONTRACT_HEADER } from "../../shared/spaces.ts";
import type { Access } from "./store.ts";
import type { CompletedWorkList } from "../../shared/tracker.ts";
import { defaultSpace, preferencesFor, savePreferences } from "./preferences.ts";
import { tracker } from "./api.ts";
import { accessFor } from "./access.ts";
import { findSpaceById } from "../spaces/access.ts";

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});

async function setup(actor: Actor | null = ann) {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  cleanups.push(close);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO agents (id, name, accountable_id) VALUES
      ('agent-1', 'claude', 'ann'), ('agent-ben', 'ben-agent', 'ben');
  `);
  const database = env.DB;
  for (const slug of ["ann", "orbit", "private", "ben"]) {
    const personal = slug === "ann" || slug === "ben";
    const person = slug === "ben" ? "ben" : "ann";
    await seedSpaceFixture(database, {
      organization: {
        id: `org-${slug}`,
        slug: `org-${slug}`,
        displayName: slug,
        kind: personal ? "personal" : "company",
        ...(personal ? { personalAccountId: person } : {}),
      },
      space: { id: `space-${slug}`, slug, displayName: slug },
      members: [
        {
          accountId: person,
          role: "owner",
          ...(slug === "private"
            ? {}
            : {
                grant: {
                  role: slug === "orbit" ? ("member" as const) : ("admin" as const),
                  repositoryRole: "none" as const,
                  packageRole: "read" as const,
                },
              }),
        },
      ],
      actorId: person,
    });
  }
  const snapshot = vi.fn(async (access: Access) => ({
    ok: true,
    value: {
      space: access.space,
      spaceId: access.spaceId,
      contractVersion: access.contractVersion,
      migrationEpoch: access.migrationEpoch,
      canAdmin: access.canAdmin,
      members: access.members,
      issues: [],
    },
  }));
  const tagCatalog = vi.fn(async () => ({
    ok: true,
    value: [{ name: "ux", issues: 2, open: 1 }],
  }));
  const teamDirectory = vi.fn(async (access: Access) => ({
    ok: true,
    value: [{ id: access.spaceId === "space-ann" ? "t-ann" : "t-core" }],
  }));
  const changes = vi.fn(
    async (access: Access, _after: number, _limit: number, _timelines: boolean) => ({
      ok: true,
      value: {
        spaceId: access.spaceId,
        contractVersion: access.contractVersion,
        migrationEpoch: access.migrationEpoch,
        events: [],
        cursor: 0,
      },
    }),
  );
  const completedWork = vi.fn(async (_access: Access, _filter: unknown) => ({
    ok: true,
    value: { items: [] as unknown[], truncated: false },
  }));
  const getByName = vi.fn((_space: string) => ({
    snapshot,
    tagCatalog,
    teamDirectory,
    changes,
    completedWork,
  }));
  Reflect.set(env, "TRACKER", { getByName });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api", tracker);
  return {
    env,
    database,
    sqlite,
    control: cutoverControl(env),
    call: (path: string, init: RequestInit = {}, version: string | null = "4") => {
      const headers = new Headers(init.headers);
      if (version !== null) headers.set(CONTENT_CONTRACT_HEADER, version);
      return app.request(`/api${path}`, { ...init, headers }, env);
    },
    snapshot,
    changes,
    getByName,
    completedWork,
  };
}

describe("scoped tracker cursors", () => {
  test("rejects missing, foreign and stale cursor scope before dispatch", async () => {
    const { call, changes, getByName } = await setup();
    for (const query of [
      "",
      "?spaceId=space-orbit",
      "?migrationEpoch=0",
      "?spaceId=space-ann&migrationEpoch=0",
      "?spaceId=space-orbit&migrationEpoch=1",
      "?spaceId=space-orbit&migrationEpoch=not-a-number",
    ]) {
      const response = await call(`/tracker/orbit/changes${query}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "migration_epoch_mismatch" });
    }
    expect(changes).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  });

  test("dispatches a current scoped cursor and denies it immediately after grant revocation", async () => {
    const { call, changes, sqlite } = await setup();
    const path =
      "/tracker/orbit/changes?spaceId=space-orbit&migrationEpoch=0&after=12&limit=25&timelines=1";
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      spaceId: "space-orbit",
      contractVersion: 4,
      migrationEpoch: 0,
    });
    sqlite.exec("DELETE FROM space_grants WHERE space_id='space-orbit' AND account_id='ann'");
    expect((await call(path)).status).toBe(403);
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe("tracker browser data", () => {
  test("lists only explicit Space grants and identifies the viewer for per-person preferences", async () => {
    const { call } = await setup();
    const result = await call("/tracker");
    expect(await result.json()).toMatchObject({
      viewerId: "ann",
      trackers: [{ slug: "ann" }, { slug: "orbit" }],
    });
  });
  test.each([
    ["anonymous", null, "orbit", 401],
    ["Organization owner without a grant", ann, "private", 403],
    ["another person's private Space", ann, "ben", 403],
    ["unknown Space", ann, "missing", 404],
    ["Instance administrator without a grant", { ...ann, isSiteAdmin: true }, "private", 403],
  ] as const)("denies %s", async (_scenario, actor, space, status) => {
    const { call, getByName } = await setup(actor);
    expect((await call(`/tracker/${space}/view`)).status).toBe(status);
    expect(getByName).not.toHaveBeenCalled();
  });

  test("rejects missing and obsolete content versions before Durable Object dispatch", async () => {
    const { call, getByName } = await setup();
    for (const version of [null, "3", "5"]) {
      const response = await call("/tracker/orbit/snapshot", {}, version);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "client_upgrade_required" });
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  test("re-resolves the grant on every request and reads the control epoch a cold isolate sees", async () => {
    const { call, snapshot, sqlite, control, env } = await setup();
    expect((await call("/tracker/orbit/snapshot")).status).toBe(200);
    const first = snapshot.mock.calls[0]![0];
    expect(first).toMatchObject({
      actorId: "ann",
      principalId: "ann",
      agentId: null,
      spaceId: "space-orbit",
      contractVersion: 4,
      migrationEpoch: 0,
      canAdmin: false,
    });
    sqlite.exec(
      "UPDATE space_grants SET role='admin' WHERE space_id='space-orbit' AND account_id='ann'",
    );
    const admission = vi.spyOn(control, "admission").mockResolvedValue({
      allowed: true,
      epoch: 8,
      [Symbol.dispose]() {},
    });
    // Open admission is absorbing: this isolate's positive read stands, the grant does not.
    expect((await call("/tracker/orbit/snapshot")).status).toBe(200);
    const second = snapshot.mock.calls[1]![0];
    expect(second).toMatchObject({ migrationEpoch: 0, canAdmin: true });
    expect(second.authorizationVersion).toBeGreaterThan(first.authorizationVersion);
    expect(admission).not.toHaveBeenCalled();
    // An isolate without that read asks the control object.
    forgetCachedAdmission(env);
    expect((await call("/tracker/orbit/snapshot")).status).toBe(200);
    expect(snapshot.mock.calls[2]![0]).toMatchObject({ migrationEpoch: 8, canAdmin: true });
    expect(admission).toHaveBeenCalledWith(4);
    admission.mockResolvedValue({ allowed: false, epoch: 8, [Symbol.dispose]() {} });
    forgetCachedAdmission(env);
    const denied = await call("/tracker/orbit/snapshot");
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "migration_epoch_mismatch" });
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  test.each([
    ["Space grant", "DELETE FROM space_grants WHERE space_id='space-orbit' AND account_id='ann'"],
    [
      "Organization membership",
      "DELETE FROM organization_members WHERE organization_id='org-orbit' AND account_id='ann'",
    ],
  ])(
    "%s revocation is effective on the next request with the same authenticated person",
    async (_kind, revoke) => {
      const { call, sqlite, getByName } = await setup();
      expect((await call("/tracker/orbit/snapshot")).status).toBe(200);
      sqlite.exec(revoke);
      for (const endpoint of ["snapshot", "tags", "preferences"]) {
        expect((await call(`/tracker/orbit/${endpoint}`)).status).toBe(403);
      }
      expect(getByName).toHaveBeenCalledTimes(1);
      const listed = (await (await call("/tracker")).json()) as { trackers: Array<{ id: string }> };
      expect(listed.trackers.some((space) => space.id === "space-orbit")).toBe(false);
    },
  );

  test("a deleted person's cached identity cannot dispatch to the tracker", async () => {
    const { call, database, sqlite, getByName } = await setup({
      id: "carol",
      slug: "carol",
      displayName: "Carol",
      isSiteAdmin: false,
    });
    sqlite.exec(
      "INSERT INTO accounts (id,kind,slug,display_name) VALUES ('carol','user','carol','Carol')",
    );
    await seedSpaceFixture(database, {
      organization: {
        id: "org-carol",
        slug: "carol-company",
        displayName: "Company",
        kind: "company",
      },
      space: { id: "space-carol", slug: "carol-work", displayName: "Work" },
      members: [
        {
          accountId: "carol",
          role: "member",
          grant: { role: "member", repositoryRole: "none", packageRole: "none" },
        },
      ],
      actorId: "ann",
    });
    expect((await call("/tracker/carol-work/snapshot")).status).toBe(200);
    sqlite.exec(`
      DELETE FROM organization_members WHERE account_id='carol';
      DELETE FROM accounts WHERE id='carol';
    `);
    expect((await call("/tracker/carol-work/snapshot")).status).toBe(403);
    expect(getByName).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "agent revocation",
      "UPDATE agents SET revoked_at='2026-10-11T00:00:00.000Z' WHERE id='agent-1'",
    ],
    [
      "accountable-person reassignment",
      "UPDATE agents SET accountable_id='ben' WHERE id='agent-1'",
    ],
    [
      "Space grant removal",
      "DELETE FROM space_grants WHERE space_id='space-orbit' AND account_id='ann'",
    ],
    [
      "Organization membership removal",
      "DELETE FROM organization_members WHERE organization_id='org-orbit' AND account_id='ann'",
    ],
  ])("%s immediately removes agent access", async (_scenario, revoke) => {
    const { call, sqlite, snapshot } = await setup({
      ...ann,
      agent: { id: "agent-1", name: "claude" },
    });
    expect((await call("/tracker/orbit/snapshot")).status).toBe(200);
    sqlite.exec(revoke);
    expect((await call("/tracker/orbit/snapshot")).status).toBe(403);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
  test.each(["agent-ben", "missing-agent"])("denies untrusted agent %s", async (id) => {
    const { call, getByName } = await setup({ ...ann, agent: { id, name: "untrusted" } });
    expect((await call("/tracker/orbit/snapshot")).status).toBe(403);
    expect(getByName).not.toHaveBeenCalled();
  });
});

describe("tag catalog", () => {
  test("lists a tracker's tags with counts for members, never for others (CORE-271)", async () => {
    const { call } = await setup();
    const result = await call("/tracker/orbit/tags");
    expect(result.status).toBe(200);
    expect((await call("/tracker/private/tags")).status).toBe(403);
  });
  test("requires sign-in to read the tag catalog", async () => {
    const { call } = await setup(null);
    expect((await call("/tracker/orbit/tags")).status).toBe(401);
  });
});

describe("tracker preferences", () => {
  const put = (json: unknown): RequestInit => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  test("are saved per person and tracker, and open the last tracker set", async () => {
    const { call } = await setup();
    expect(await (await call("/tracker/orbit/preferences")).json()).toEqual({ preferences: null });
    await call("/tracker/ann/preferences", put({ teamId: "t-ann", view: "list", query: "" }));
    const saved = await call(
      "/tracker/orbit/preferences",
      put({ teamId: "t-core", view: "board", query: "is:ready" }),
    );
    expect(saved.status).toBe(200);
    expect(await (await call("/tracker/orbit/view")).json()).toMatchObject({
      preferences: { teamId: "t-core", view: "board", query: "is:ready" },
    });
    expect(await (await call("/tracker/ann/preferences")).json()).toMatchObject({
      preferences: { teamId: "t-ann" },
    });
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultSpaceId: "space-orbit" });
    expect((await call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(204);
    expect(await (await call("/tracker/orbit/preferences")).json()).toEqual({ preferences: null });
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultSpaceId: "space-ann" });
  });
  test("the person's own default Space outranks the last tuned tracker while they can open it", async () => {
    const { call, sqlite } = await setup();
    await call("/tracker/ann/preferences", put({ teamId: "t-ann", view: "list", query: "" }));
    const choose = (organization: string | null, space: string | null) =>
      sqlite
        .prepare(
          "UPDATE accounts SET preferred_organization_id=?, preferred_space_id=? WHERE id='ann'",
        )
        .run(organization, space);
    choose("org-orbit", null);
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultSpaceId: "space-orbit" });
    // Without a Space grant, the saved choice no longer opens anything: back to the last tuned.
    choose("org-private", "space-private");
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultSpaceId: "space-ann" });
  });
  test("the last save wins at the same clock time, including an existing tracker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    try {
      const { call } = await setup();
      const preferences = { teamId: null, view: "list", query: "" };
      for (const space of ["ann", "orbit", "ann", "orbit"]) {
        expect((await call(`/tracker/${space}/preferences`, put(preferences))).status).toBe(200);
        expect(await (await call("/tracker")).json()).toMatchObject({
          defaultSpaceId: `space-${space}`,
        });
      }
      expect((await call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(204);
      expect(await (await call("/tracker")).json()).toMatchObject({ defaultSpaceId: "space-ann" });
    } finally {
      vi.useRealTimers();
    }
  });
  test("concurrent same-clock saves are ordered atomically and isolated by person and tracker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new Date("2026-10-04T12:00:00.000Z");
    try {
      const { database } = await setup();
      const benPreferences = { teamId: "t-ben", view: "board" as const, query: "is:blocked" };
      vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
      const ben = await savePreferences(database, "ben", "space-orbit", benPreferences);
      vi.setSystemTime(clock);
      const saves = [
        { spaceId: "space-ann", teamId: "t-ann", view: "list" as const, query: "" },
        { spaceId: "space-orbit", teamId: "t-core", view: "board" as const, query: "is:ready" },
      ];
      const saved = await Promise.all(
        saves.map(({ spaceId, ...preferences }) =>
          savePreferences(database, "ann", spaceId, preferences),
        ),
      );
      expect(saved[0]!.updatedAt).toBe(clock.toISOString());
      expect(saved[1]!.updatedAt > saved[0]!.updatedAt).toBe(true);
      for (const [index, { spaceId }] of saves.entries())
        expect(await preferencesFor(database, "ann", spaceId)).toEqual(saved[index]);
      expect(await defaultSpace(database, "ann")).toBe("space-orbit");
      expect(await preferencesFor(database, "ben", "space-orbit")).toEqual(ben);
      expect(await defaultSpace(database, "ben")).toBe("space-orbit");
      expect(await preferencesFor(database, "ben", "space-ann")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  test("reject malformed values and trackers the person can't open", async () => {
    const { call } = await setup();
    for (const body of [
      { teamId: 1, view: "list", query: "" },
      { teamId: null, view: "table", query: "" },
      { teamId: null, view: "list", query: "x".repeat(501) },
      { teamId: null, view: "list", query: "", extra: true },
      { teamId: "t-ann", view: "list", query: "" },
      { teamId: "missing-team", view: "list", query: "" },
    ])
      expect((await call("/tracker/orbit/preferences", put(body))).status).toBe(400);
    expect(
      (await call("/tracker/private/preferences", put({ teamId: null, view: "list", query: "" })))
        .status,
    ).toBe(403);
  });
  test("are read by the person's agents but only set by the person", async () => {
    const agent = await setup({ ...ann, agent: { id: "agent-1", name: "claude" } });
    const write = await agent.call(
      "/tracker/orbit/preferences",
      put({ teamId: null, view: "list", query: "" }),
    );
    expect(write.status).toBe(403);
    expect((await agent.call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(403);
    expect((await agent.call("/tracker/orbit/preferences")).status).toBe(200);
  });
});

describe("agent work (CORE-220)", () => {
  const credit = (actorId: string, at: string) => ({
    actorId,
    accountableId: "ann",
    agent: "laptop",
    at,
  });
  const item = (key: string, actorId: string, at: string) => ({
    issue: { id: key.toLowerCase(), key, title: key, type: "task", status: "done" },
    completion: credit(actorId, at),
    timeline: null,
    evidence: null,
  });
  const world = setup;
  // ann already has agent-1 ("claude") from setup.
  async function seedAgents(database: D1Database) {
    await database
      .prepare(
        `INSERT INTO agents (id, name, accountable_id, revoked_at) VALUES
          ('agt-bot', 'bot', 'ann', NULL), ('agt-old', 'old', 'ann', '2026-01-01T00:00:00Z'),
          ('agt-ben', 'helper', 'ben', NULL)`,
      )
      .run();
  }

  test("by default: every readable tracker, anything ann's agents finished, newest first", async () => {
    const t = await world();
    await seedAgents(t.database);
    t.getByName.mockImplementation(
      (space: string) =>
        ({
          snapshot: t.snapshot,
          completedWork: vi.fn(async (access: Access) => ({
            ok: true,
            value: {
              items:
                access.spaceId === "space-ann"
                  ? [item("ANN-1", "agt-bot", "2026-10-01T00:00:00Z")]
                  : [item("ORB-1", "agt-old", "2026-10-02T00:00:00Z")],
              truncated: space === "space-orbit",
            },
          })),
        }) as never,
    );
    const result = await t.call("/agent-work?since=30d");
    expect(result.status).toBe(200);
    const body = (await result.json()) as CompletedWorkList;
    expect(body).toMatchObject({
      agents: [
        { id: "agt-bot", name: "bot", revoked: false },
        { id: "agent-1", name: "claude", revoked: false },
        { id: "agt-old", name: "old", revoked: true },
      ],
      trackers: [{ slug: "ann" }, { slug: "orbit" }],
      truncated: true,
      items: [
        { tracker: { slug: "orbit" }, issue: { key: "ORB-1" } },
        { tracker: { slug: "ann" }, issue: { key: "ANN-1" } },
      ],
    });
    // Ben's agent is not ann's; a Space without ann's grant is not readable.
    expect(JSON.stringify(body)).not.toContain("helper");
    expect(
      t.getByName.mock.calls.map(([space]) => space).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["space-ann", "space-orbit"]);
    expect(Date.now() - Date.parse(body.since)).toBeGreaterThan(29 * 86_400_000);
  });

  test("asks each tracker for ann's agents, or just the one named", async () => {
    const t = await world();
    await seedAgents(t.database);
    await t.call("/agent-work");
    expect(t.completedWork).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: expect.any(String) }),
      expect.objectContaining({ accountableId: "ann", actorIds: null }),
    );
    const since = (t.completedWork.mock.calls[0]![1] as { since: string }).since;
    expect(Math.round((Date.now() - Date.parse(since)) / 86_400_000)).toBe(14);
    t.completedWork.mockClear();
    const one = await t.call("/agent-work?agent=bot&tracker=orbit");
    expect(one.status).toBe(200);
    expect(t.completedWork).toHaveBeenCalledTimes(1);
    expect(t.completedWork).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space-orbit" }),
      expect.objectContaining({ accountableId: "ann", actorIds: ["agt-bot"] }),
    );
    expect(t.getByName).toHaveBeenLastCalledWith("space-orbit");
    // Someone else's agent, a tracker ann isn't in, or a bad window.
    expect((await t.call("/agent-work?agent=helper")).status).toBe(404);
    expect((await t.call("/agent-work?tracker=private")).status).toBe(404);
    expect((await t.call("/agent-work?since=soon")).status).toBe(400);
  });

  test("an agent signed in sees only its own work", async () => {
    const t = await world({ ...ann, agent: { id: "agt-bot", name: "bot" } });
    await seedAgents(t.database);
    const result = await t.call("/agent-work");
    expect(await result.json()).toMatchObject({ agents: [{ id: "agt-bot" }] });
    expect(t.completedWork).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt-bot" }),
      expect.objectContaining({ accountableId: "ann", actorIds: ["agt-bot"] }),
    );
    expect((await t.call("/agent-work?agent=old")).status).toBe(404);
  });

  test("needs a signed-in person", async () => {
    const t = await world(null);
    expect((await t.call("/agent-work")).status).toBe(401);
  });
});

describe("Needs you summary (CORE-301)", () => {
  type Item = { request: { routeTo: string } };
  type Reply =
    | { ok: true; value: Item[] }
    | { ok: false; status: 409; error: string; code: string };
  async function world(actor: Actor, replies: Record<string, Reply> = {}) {
    const t = await setup(actor);
    // A company whose handle sorts last holds the Space whose handle sorts first,
    // and a second, archived Space that keeps its grant: it is never asked.
    await seedSpaceFixture(t.database, {
      organization: { id: "org-alpha", slug: "zz-company", displayName: "Z", kind: "company" },
      space: { id: "space-alpha", slug: "alpha", displayName: "alpha" },
      members: [
        {
          accountId: "ann",
          role: "owner",
          grant: { role: "member", repositoryRole: "none", packageRole: "none" },
        },
      ],
      actorId: "ann",
    });
    t.sqlite.exec(`
      INSERT INTO spaces (id, organization_id, slug, display_name, archived_at)
        VALUES ('space-archived', 'org-alpha', 'archived', 'archived', '2026-10-01T00:00:00.000Z');
      INSERT INTO space_grants
        (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
        VALUES ('space-archived', 'org-alpha', 'ann', 'admin', 'none', 'none', 'test-fixture', 'ann');
    `);
    const asked: Access[] = [];
    const openRequests = vi.fn(async (access: Access) => {
      asked.push(access);
      return (
        replies[access.spaceId] ?? {
          ok: true,
          value:
            access.spaceId === "space-ann"
              ? [{ request: { routeTo: "ann" } }, { request: { routeTo: "ben" } }]
              : access.spaceId === "space-orbit"
                ? [{ request: { routeTo: "ann" } }]
                : [],
        }
      );
    });
    Reflect.set(t.env, "TRACKER", { getByName: () => ({ openRequests }) });
    return { ...t, asked, openRequests };
  }

  test("asks each open Space with exactly the access accessFor builds, in handle order", async () => {
    const credential = { kind: "token" as const, id: "tok-ann" };
    const t = await world({ ...ann, credential });
    const response = await t.call("/requests/summary");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forYou: 2, open: 3 });
    expect(t.asked.map((access) => access.spaceId)).toEqual([
      "space-alpha",
      "space-ann",
      "space-orbit",
    ]);
    for (const access of t.asked) {
      const space = (await findSpaceById(t.env.DB, access.spaceId))!;
      expect(access).toEqual(await accessFor(t.env, space, "ann", null, false, credential));
    }
  });

  test("an agent asks as itself, and asks nothing once revoked", async () => {
    const t = await world({ ...ann, agent: { id: "agent-1", name: "claude" } });
    expect(await (await t.call("/requests/summary")).json()).toEqual({ forYou: 2, open: 3 });
    expect(t.asked.map((access) => [access.actorId, access.agentId])).toEqual([
      ["agent-1", "agent-1"],
      ["agent-1", "agent-1"],
      ["agent-1", "agent-1"],
    ]);
    t.sqlite.exec("UPDATE agents SET revoked_at='2026-10-11T00:00:00.000Z' WHERE id='agent-1'");
    expect(await (await t.call("/requests/summary")).json()).toEqual({ forYou: 0, open: 0 });
    expect(t.openRequests).toHaveBeenCalledTimes(3);
  });

  test("the first Space's failure wins, and closed admission asks no Space", async () => {
    const refused = (code: string) =>
      ({ ok: false, status: 409, error: code, code }) as const satisfies Reply;
    const t = await world(ann, {
      "space-alpha": refused("first"),
      "space-orbit": refused("last"),
    });
    const response = await t.call("/requests/summary");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "first" });
    const closed = await world(ann);
    vi.spyOn(closed.control, "admission").mockResolvedValue({
      allowed: false,
      epoch: 0,
      [Symbol.dispose]() {},
    });
    // Open admission never closes in protocol; model an isolate that never saw it open.
    forgetCachedAdmission(closed.env);
    const denied = await closed.call("/requests/summary");
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "migration_epoch_mismatch" });
    expect(closed.openRequests).not.toHaveBeenCalled();
  });
});

describe("repository tracker summary (CORE-451)", () => {
  type Reply =
    | { ok: true; value: { projects: number; ready: number } }
    | { ok: false; status: 409; error: string; code: string };
  async function world(actor: Actor | null, reply?: Reply) {
    const t = await setup(actor);
    t.sqlite.exec(`
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
        ('r-engine', 'space-orbit', 'engine', 'public', 'a-engine', 'https://artifacts.test/a-engine'),
        ('r-hidden', 'space-private', 'hidden', 'public', 'a-hidden', 'https://artifacts.test/a-hidden');
    `);
    const asked: { access: Access; repoId: string; timeline: string | undefined }[] = [];
    const repoReadySummary = vi.fn(
      async (access: Access, repoId: string, timeline?: string): Promise<Reply> => {
        asked.push({ access, repoId, timeline });
        return reply ?? { ok: true, value: { projects: 2, ready: 5 } };
      },
    );
    Reflect.set(t.env, "TRACKER", { getByName: () => ({ repoReadySummary }) });
    // As app.ts does: every /api response carries this request's Server-Timing.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
      const timing = c.get("timing");
      if (timing) c.res.headers.set("server-timing", timing.header());
    });
    app.route("/api", tracker);
    const call = (path: string) =>
      app.request(`/api${path}`, { headers: { [CONTENT_CONTRACT_HEADER]: "4" } }, t.env);
    const closeAdmission = () => {
      vi.spyOn(t.control, "admission").mockResolvedValue({
        allowed: false,
        epoch: 0,
        [Symbol.dispose]() {},
      });
      // Open admission never closes in protocol; model an isolate that never saw it open.
      forgetCachedAdmission(t.env);
    };
    return { ...t, call, asked, repoReadySummary, closeAdmission };
  }

  test("asks the repository's Space with exactly the access accessFor builds, timed", async () => {
    const credential = { kind: "token" as const, id: "tok-ann" };
    const t = await world({ ...ann, credential });
    const response = await t.call("/repos/orbit/engine/tracker/summary?timeline=focus");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: 5, projects: 2 });
    expect(t.asked).toHaveLength(1);
    const [{ access, repoId, timeline }] = t.asked as [(typeof t.asked)[number]];
    expect([repoId, timeline]).toEqual(["r-engine", "focus"]);
    const space = (await findSpaceById(t.env.DB, "space-orbit"))!;
    expect(access).toEqual(await accessFor(t.env, space, "ann", null, false, credential));
    const timings = response.headers.get("server-timing") ?? "";
    expect(timings).toMatch(/\bd1;desc="\d+ queries \(summed\)"/);
    expect(timings).toContain('do;desc="1 calls (summed)"');
    // main is the default view, as before.
    await t.call("/repos/orbit/engine/tracker/summary?timeline=main");
    expect(t.asked[1]!.timeline).toBeUndefined();
  });

  test("an agent asks as itself, and counts nothing once revoked", async () => {
    const t = await world({ ...ann, agent: { id: "agent-1", name: "claude" } });
    expect(await (await t.call("/repos/orbit/engine/tracker/summary")).json()).toEqual({
      ready: 5,
      projects: 2,
    });
    const space = (await findSpaceById(t.env.DB, "space-orbit"))!;
    expect(t.asked[0]!.access).toEqual(await accessFor(t.env, space, "ann", "agent-1", false));
    expect([t.asked[0]!.access.actorId, t.asked[0]!.access.agentId]).toEqual([
      "agent-1",
      "agent-1",
    ]);
    t.sqlite.exec("UPDATE agents SET revoked_at='2026-10-11T00:00:00.000Z' WHERE id='agent-1'");
    expect(await (await t.call("/repos/orbit/engine/tracker/summary")).json()).toEqual({
      ready: null,
      projects: 0,
    });
    expect(t.repoReadySummary).toHaveBeenCalledTimes(1);
  });

  test("a repository nobody subscribed counts nothing, not zero", async () => {
    const t = await world(ann, { ok: true, value: { projects: 0, ready: 0 } });
    expect(await (await t.call("/repos/orbit/engine/tracker/summary")).json()).toEqual({
      ready: null,
      projects: 0,
    });
  });

  test("an unknown repository is not found, before anything else", async () => {
    const t = await world(ann);
    t.closeAdmission();
    const response = await t.call(
      `/repos/orbit/missing/tracker/summary?timeline=${"x".repeat(101)}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Repository not found." });
    expect(t.repoReadySummary).not.toHaveBeenCalled();
  });

  test("signed out, a public repository counts nothing and asks no Tracker", async () => {
    const t = await world(null);
    const response = await t.call(
      `/repos/orbit/engine/tracker/summary?timeline=${"x".repeat(101)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: null, projects: 0 });
    expect(t.repoReadySummary).not.toHaveBeenCalled();
  });

  test("an invalid timeline is refused before any Tracker is asked", async () => {
    const t = await world(ann);
    const response = await t.call(
      `/repos/orbit/engine/tracker/summary?timeline=${"x".repeat(101)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
    expect(t.repoReadySummary).not.toHaveBeenCalled();
  });

  test("without a grant in the repository's Space it counts nothing, even with admission closed", async () => {
    const t = await world(ann);
    t.closeAdmission();
    const response = await t.call("/repos/private/hidden/tracker/summary");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: null, projects: 0 });
    expect(t.repoReadySummary).not.toHaveBeenCalled();
  });

  test("closed admission refuses a granted reader without asking the Tracker", async () => {
    const t = await world(ann);
    t.closeAdmission();
    const response = await t.call("/repos/orbit/engine/tracker/summary");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "migration_epoch_mismatch" });
    expect(t.repoReadySummary).not.toHaveBeenCalled();
  });

  test("the Tracker's refusal is passed on as it is", async () => {
    const t = await world(ann, { ok: false, status: 409, error: "Stale.", code: "stale" });
    const response = await t.call("/repos/orbit/engine/tracker/summary");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Stale.", code: "stale" });
  });
});
