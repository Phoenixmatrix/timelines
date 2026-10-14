// The Tracker under steady contract-4 admission (CORE-439): no ticket per call,
// a scope confirmed once per instance, and every call still re-resolving its grant.

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { issueToken } from "../api/tokens.ts";
import { forgetCachedAdmission } from "../durable/cutover-admission.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { fakeDurableObjectId, fakeDurableState } from "../testing/durable-state.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "./access.ts";
import { Tracker } from "./object.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const SPACE_READ = "SELECT id FROM spaces WHERE id=? AND archived_at IS NULL";

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(() => {
    vi.restoreAllMocks();
    fresh.close();
  });
  fresh.sqlite.exec(
    "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann','user','ann','Ann')",
  );
  await seedSpaceFixture(fresh.env.DB, {
    organization: { id: "org_orbit", slug: "orbit", displayName: "Orbit", kind: "company" },
    space: { id: "orbit", slug: "orbit", displayName: "Orbit" },
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "ann",
  });
  // The Space reads only the Tracker's own initialization makes.
  const queries: string[] = [];
  let failSpaceRead = false;
  const database = fresh.env.DB;
  const DB = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          queries.push(query);
          if (query === SPACE_READ && failSpaceRead) {
            failSpaceRead = false;
            throw new Error("D1 unavailable");
          }
          return target.prepare(query);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const state = fakeDurableState({ name: "orbit" });
  onTestFinished(() => {
    if (state.db.isOpen) state.db.close();
  });
  const ctx = state.ctx;
  const env = {
    ...fresh.env,
    DB,
    TRACKER: { idFromName: fakeDurableObjectId, getByName: () => tracker },
  } as unknown as Env;
  const tracker = new Tracker(ctx, env);
  const token = await issueToken(env.DB, "ann", "t", "write");
  const space = (await findSpaceById(env.DB, "orbit"))!;
  const access = await accessFor(env, space, "ann", null, true, { kind: "token", id: token.id });
  return {
    ...fresh,
    env,
    state,
    tracker,
    access,
    acquire: vi.spyOn(fresh.control, "acquire"),
    spaceReads: () => queries.filter((query) => query === SPACE_READ).length,
    failNextSpaceRead: () => {
      failSpaceRead = true;
    },
  };
}

describe("the Tracker under steady admission", () => {
  test("takes no ticket and confirms its scope once across calls", async () => {
    const t = await setup();
    expect(await t.tracker.openRequests(t.access)).toEqual({ ok: true, value: [] });
    expect(await t.tracker.openRequests(t.access)).toEqual({ ok: true, value: [] });
    expect(t.acquire).not.toHaveBeenCalled();
    expect(t.spaceReads()).toBe(1);
  });

  test("an isolate that never saw admission open takes a ticket, as before", async () => {
    const t = await setup();
    forgetCachedAdmission(t.env);
    vi.spyOn(t.control, "admission").mockReturnValue({ allowed: false, epoch: 0 });
    vi.spyOn(t.control, "installationState").mockReturnValue({
      admission: { allowed: false, epoch: 0 },
      runPhase: null,
      fresh: t.control.freshStatus(),
    });
    await expect(t.tracker.openRequests(t.access)).rejects.toThrow("space_cutover_fenced");
    expect(t.acquire).toHaveBeenCalledTimes(1);
  });

  test("archiving the Space after the scope is confirmed refuses the next call", async () => {
    const t = await setup();
    expect((await t.tracker.openRequests(t.access)).ok).toBe(true);
    t.sqlite.exec(
      "INSERT INTO spaces (id, organization_id, slug, display_name) VALUES ('other','org_orbit','other','Other')",
    );
    t.sqlite.exec(`
      UPDATE organizations SET default_space_id='other' WHERE id='org_orbit';
      UPDATE spaces SET archived_at='2026-10-01T00:00:00.000Z' WHERE id='orbit';
    `);
    expect(await t.tracker.openRequests(t.access)).toMatchObject({ ok: false, status: 403 });
    expect(t.spaceReads()).toBe(1);
  });

  test("a failed initialization is not remembered", async () => {
    const t = await setup();
    t.failNextSpaceRead();
    await expect(t.tracker.openRequests(t.access)).rejects.toThrow("D1 unavailable");
    expect((await t.tracker.openRequests(t.access)).ok).toBe(true);
    expect((await t.tracker.openRequests(t.access)).ok).toBe(true);
    expect(t.spaceReads()).toBe(2);
  });

  test("a purged instance confirms its scope from scratch", async () => {
    const t = await setup();
    expect((await t.tracker.openRequests(t.access)).ok).toBe(true);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as never);
    await t.tracker.purge("test");
    // (The runtime resets a purged instance; this one only shows the scope isn't assumed.)
    await t.tracker.openRequests(t.access).catch(() => undefined);
    expect(t.spaceReads()).toBe(2);
    expect(t.state.db.prepare("SELECT space_id FROM space_migration_scope").all()).toEqual([
      { space_id: "orbit" },
    ]);
  });

  test("authorization still fails in order: credential, grant, epoch, authorization version", async () => {
    const t = await setup();
    const call = (access = t.access) => t.tracker.openRequests(access);
    // A dead credential outranks a missing grant.
    t.sqlite.exec("DELETE FROM space_grants WHERE space_id='orbit' AND account_id='ann'");
    expect(await call({ ...t.access, credential: { kind: "token", id: "gone" } })).toMatchObject({
      ok: false,
      status: 403,
      error: "Tracker credential is expired, revoked or insufficiently scoped.",
    });
    expect(await call()).toMatchObject({
      ok: false,
      status: 403,
      error: "Tracker access requires a current explicit Space grant.",
    });
    t.sqlite.exec(`INSERT INTO space_grants
      (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
      VALUES ('orbit','org_orbit','ann','admin','write','write','test','ann')`);
    // A stale epoch outranks a changed authorization version.
    expect(await call({ ...t.access, migrationEpoch: 7 })).toMatchObject({
      ok: false,
      code: "migration_epoch_mismatch",
    });
    expect(await call()).toMatchObject({ ok: false, code: "authorization_changed" });
  });
});
