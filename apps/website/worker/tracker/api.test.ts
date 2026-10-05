import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { Access } from "./store.ts";
import { defaultOwner, preferencesFor, savePreferences } from "./preferences.ts";
import { tracker } from "./api.ts";

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
function setup(actor: Actor | null = ann) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'),
      ('orbit', 'org', 'orbit', 'Orbit'), ('private', 'org', 'private', 'Private');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'member');
  `);
  const snapshot = vi.fn(async (access: Access) => ({
    ok: true,
    value: { owner: access.owner, canAdmin: access.canAdmin, members: access.members, issues: [] },
  }));
  const tagCatalog = vi.fn(async () => ({
    ok: true,
    value: [{ name: "ux", issues: 2, open: 1 }],
  }));
  const getByName = vi.fn(() => ({ snapshot, tagCatalog }));
  const env = { DB: d1(sqlite), TRACKER: { getByName } } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api", tracker);
  return {
    database: env.DB,
    call: (path: string, init: RequestInit = {}) => app.request(`/api${path}`, init, env),
    snapshot,
    getByName,
  };
}

describe("tracker browser data", () => {
  test("lists only memberships and identifies the viewer for per-person preferences", async () => {
    const { call } = setup();
    const result = await call("/tracker");
    expect(await result.json()).toMatchObject({
      viewerId: "ann",
      trackers: [{ slug: "ann" }, { slug: "orbit" }],
    });
  });
  test("returns the authorized snapshot and owner switcher together", async () => {
    const { call, snapshot, getByName } = setup();
    const result = await call("/tracker/orbit/view");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      snapshot: { owner: { slug: "orbit" }, canAdmin: false, members: [{ id: "ann" }], issues: [] },
      trackers: [{ slug: "ann" }, { slug: "orbit" }],
    });
    expect(getByName).toHaveBeenCalledWith("orbit");
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
  test("does not open a tracker for signed-out, unauthorized or missing owners", async () => {
    for (const [actor, owner, status] of [
      [null, "orbit", 401],
      [ann, "private", 403],
      [ann, "ben", 403],
      [ann, "missing", 404],
      [{ ...ann, isSiteAdmin: true }, "private", 403],
    ] as const) {
      const { call, getByName } = setup(actor);
      expect((await call(`/tracker/${owner}/view`)).status).toBe(status);
      expect(getByName).not.toHaveBeenCalled();
    }
  });
  test("?timeline= asks for that timeline's view; main is the default", async () => {
    const { call, snapshot } = setup();
    await call("/tracker/orbit/view?timeline=search");
    await call("/tracker/orbit/snapshot?timeline=search");
    await call("/tracker/orbit/snapshot?timeline=main");
    expect(snapshot.mock.calls.map((args) => (args as unknown[])[1])).toEqual([
      "search",
      "search",
      undefined,
    ]);
  });
  test("keeps the snapshot API response unchanged for CLI and refresh consumers", async () => {
    const { call } = setup();
    const result = await call("/tracker/ann/snapshot");
    expect(await result.json()).toMatchObject({
      owner: { slug: "ann" },
      canAdmin: true,
      issues: [],
    });
  });
});

describe("tag catalog", () => {
  test("lists a tracker's tags with counts for members, never for others (CORE-271)", async () => {
    const { call } = setup();
    const result = await call("/tracker/orbit/tags");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ tags: [{ name: "ux", issues: 2, open: 1 }] });
    expect((await call("/tracker/private/tags")).status).toBe(403);
    expect((await setup(null).call("/tracker/orbit/tags")).status).toBe(401);
  });
});

describe("tracker preferences", () => {
  const put = (json: unknown): RequestInit => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  test("are saved per person and tracker, and open the last tracker set", async () => {
    const { call } = setup();
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
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultOwnerId: "orbit" });
    expect((await call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(204);
    expect(await (await call("/tracker/orbit/preferences")).json()).toEqual({ preferences: null });
    expect(await (await call("/tracker")).json()).toMatchObject({ defaultOwnerId: "ann" });
  });
  test("the last save wins at the same clock time, including an existing tracker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    try {
      const { call } = setup();
      const preferences = { teamId: null, view: "list", query: "" };
      for (const owner of ["ann", "orbit", "ann", "orbit"]) {
        expect((await call(`/tracker/${owner}/preferences`, put(preferences))).status).toBe(200);
        expect(await (await call("/tracker")).json()).toMatchObject({ defaultOwnerId: owner });
      }
      expect((await call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(204);
      expect(await (await call("/tracker")).json()).toMatchObject({ defaultOwnerId: "ann" });
    } finally {
      vi.useRealTimers();
    }
  });
  test("concurrent same-clock saves are ordered atomically and isolated by person and tracker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new Date("2026-10-04T12:00:00.000Z");
    try {
      const { database } = setup();
      const benPreferences = { teamId: "t-ben", view: "board" as const, query: "is:blocked" };
      vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
      const ben = await savePreferences(database, "ben", "orbit", benPreferences);
      vi.setSystemTime(clock);
      const saves = [
        { owner: "ann", teamId: "t-ann", view: "list" as const, query: "" },
        { owner: "orbit", teamId: "t-core", view: "board" as const, query: "is:ready" },
      ];
      const saved = await Promise.all(
        saves.map(({ owner, ...preferences }) =>
          savePreferences(database, "ann", owner, preferences),
        ),
      );
      expect(saved[0]!.updatedAt).toBe(clock.toISOString());
      expect(saved[1]!.updatedAt > saved[0]!.updatedAt).toBe(true);
      for (const [index, { owner }] of saves.entries())
        expect(await preferencesFor(database, "ann", owner)).toEqual(saved[index]);
      expect(await defaultOwner(database, "ann")).toBe("orbit");
      expect(await preferencesFor(database, "ben", "orbit")).toEqual(ben);
      expect(await defaultOwner(database, "ben")).toBe("orbit");
      expect(await preferencesFor(database, "ben", "ann")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  test("reject malformed values and trackers the person can't open", async () => {
    const { call } = setup();
    for (const body of [
      { teamId: 1, view: "list", query: "" },
      { teamId: null, view: "table", query: "" },
      { teamId: null, view: "list", query: "x".repeat(501) },
      { teamId: null, view: "list", query: "", extra: true },
    ])
      expect((await call("/tracker/orbit/preferences", put(body))).status).toBe(400);
    expect(
      (await call("/tracker/private/preferences", put({ teamId: null, view: "list", query: "" })))
        .status,
    ).toBe(403);
  });
  test("are read by the person's agents but only set by the person", async () => {
    const agent = setup({ ...ann, agent: { id: "agent-1", name: "claude" } });
    const write = await agent.call(
      "/tracker/orbit/preferences",
      put({ teamId: null, view: "list", query: "" }),
    );
    expect(write.status).toBe(403);
    expect((await agent.call("/tracker/orbit/preferences", { method: "DELETE" })).status).toBe(403);
    expect((await agent.call("/tracker/orbit/preferences")).status).toBe(200);
  });
});
