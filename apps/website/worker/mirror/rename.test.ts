import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { Timing } from "../timing.ts";
import { mirrors } from "./api.ts";
import { sealMirrorToken } from "./sync.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: unknown;
    public env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));
const closers: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) close();
});

async function setup(viewer = "owner", preview = false) {
  const fixture = await createFreshSpaceTestEnvironment();
  closers.push(fixture.close);
  const { sqlite } = fixture;
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name,email) VALUES
      ('owner','user','owner','Owner','owner@example.com'),
      ('writer','user','writer','Writer','writer@example.com');
  `);
  // The owner's personal Organization and default Space; the writer is a
  // repository-only collaborator, which never administers the mirror.
  await seedSpaceFixture(fixture.env.DB, {
    organization: {
      id: "org_owner",
      slug: "owner-personal",
      displayName: "Owner",
      kind: "personal",
      personalAccountId: "owner",
    },
    space: { id: "space_owner", slug: "owner", displayName: "Owner" },
    members: [
      {
        accountId: "owner",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "owner",
  });
  sqlite.exec(`
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','space_owner','app','private','physical','https://storage');
    INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','writer','write');
  `);
  const env = Object.assign(fixture.env, {
    OWNER_EMAIL: "owner@example.com",
    REGISTRY_KEK: btoa("01234567890123456789012345678901"),
    ...(preview ? { PREVIEW_MODE: "true" } : {}),
  }) as Env;
  const sealed = await sealMirrorToken(env, "push-only-token");
  sqlite
    .prepare(`INSERT INTO repo_mirrors(repo_id,url,username,token_sealed,enabled,prune,status,last_synced_commit)
    VALUES('repo','https://github.com/remote/backup.git','x-access-token',?,1,1,'ok','retained-head')`)
    .run(sealed);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { id: viewer, slug: viewer, displayName: viewer, isSiteAdmin: false });
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos", mirrors);
  const row = () => sqlite.prepare("SELECT * FROM repo_mirrors WHERE repo_id='repo'").get();
  const call = (body: object = { name: "renamed", expectedRepositoryId: 7 }) =>
    app.request(
      "/api/repos/owner/app/mirror/rename",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  return { sqlite, row, call, sealed };
}

function github(patch: () => Response, id = 7) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    if (url !== "https://api.github.com/repos/remote/backup")
      throw new Error("Unexpected credential destination");
    calls.push(options.method ?? "GET");
    return options.method === "PATCH" ? patch() : Response.json({ id, full_name: "remote/backup" });
  });
  return calls;
}

test("renaming the backup preserves source identity, push credentials and sync history", async () => {
  const t = await setup();
  const before = t.row();
  github(() => Response.json({ id: 7, full_name: "remote/renamed" }));
  const response = await t.call({
    name: "renamed",
    expectedRepositoryId: 7,
    token: "one-operation-admin-token",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    repositoryId: 7,
    mirror: {
      url: "https://github.com/remote/renamed.git",
      hasToken: true,
      lastSyncedCommit: "retained-head",
    },
  });
  expect(t.row()).toEqual({
    ...before,
    url: "https://github.com/remote/renamed.git",
    updated_at: expect.any(String),
  });
  expect(t.sqlite.prepare("SELECT id,artifacts_name FROM repos").get()).toEqual({
    id: "repo",
    artifacts_name: "physical",
  });
});

test("a reused remote name cannot rename another GitHub repository", async () => {
  const t = await setup();
  const before = t.row();
  const calls = github(() => {
    throw new Error("Must not rename a different identity");
  }, 8);
  expect((await t.call()).status).toBe(409);
  expect(calls).toEqual(["GET"]);
  expect(t.row()).toEqual(before);
});

test("provider refusal leaves target, credentials and history intact and releases the lease", async () => {
  const t = await setup();
  const before = t.row();
  github(() => Response.json({ message: "Forbidden" }, { status: 403 }));
  expect((await t.call()).status).toBe(502);
  expect(t.row()).toEqual(before);
});

test("an active sync lease excludes remote renames without clearing that lease", async () => {
  const t = await setup();
  t.sqlite
    .prepare("UPDATE repo_mirrors SET lease_until=?")
    .run(new Date(Date.now() + 60_000).toISOString());
  const before = t.row();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect((await t.call()).status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
  expect(t.row()).toEqual(before);
});

test.each([
  { viewer: "writer", preview: false },
  { viewer: "owner", preview: true },
])(
  "writers and preview deployments cannot rename external backups: $viewer/$preview",
  async ({ viewer, preview }) => {
    const t = await setup(viewer, preview);
    const before = t.row();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await t.call()).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(t.row()).toEqual(before);
  },
);

test("a concurrent target edit is preserved after GitHub accepts the rename", async () => {
  const t = await setup();
  github(() => {
    t.sqlite.prepare("UPDATE repo_mirrors SET url='https://github.com/remote/different.git'").run();
    return Response.json({ id: 7, full_name: "remote/renamed" });
  });
  expect((await t.call()).status).toBe(409);
  expect(t.row()).toMatchObject({
    url: "https://github.com/remote/different.git",
    token_sealed: t.sealed,
    lease_until: null,
  });
});

test("unexpected remote identity after mutation is not adopted automatically", async () => {
  const t = await setup();
  const before = t.row();
  github(() => Response.json({ id: 8, full_name: "remote/renamed" }));
  expect((await t.call()).status).toBe(502);
  expect(t.row()).toEqual(before);
});

test("untrusted targets and path-like names cannot receive administration credentials", async () => {
  const t = await setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await t.call({ name: "../../other", expectedRepositoryId: 7, token: "admin" })).status,
  ).toBe(400);
  t.sqlite
    .prepare("UPDATE repo_mirrors SET url='https://untrusted.example/remote/backup.git'")
    .run();
  expect((await t.call({ name: "renamed", expectedRepositoryId: 7, token: "admin" })).status).toBe(
    400,
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(t.row()).toMatchObject({ lease_until: null, token_sealed: t.sealed });
});
