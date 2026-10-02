import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { Access } from "./store.ts";
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
  const getByName = vi.fn(() => ({ snapshot }));
  const env = { DB: d1(sqlite), TRACKER: { getByName } } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api", tracker);
  return { call: (path: string) => app.request(`/api${path}`, {}, env), snapshot, getByName };
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
