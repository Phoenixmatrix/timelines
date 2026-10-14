import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import type { SessionResponse } from "../../shared/api.ts";
import type { OrganizationPage, SpacePage } from "../../shared/spaces.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { organizations } from "./organizations.ts";
import { spaces } from "./spaces.ts";
import { contentContractGate } from "./content-contract.ts";
import { accounts } from "./accounts.ts";
import { aiSettingsApi } from "../settings/ai.ts";
import { spaceUsageApi } from "../usage/report-api.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, env } = fresh;
  closers.push(fresh.close);
  sqlite.exec(`PRAGMA foreign_keys = ON;
    BEGIN;
    INSERT INTO accounts(id,kind,slug,display_name) VALUES ('owner','user','owner','Owner'),('member','user','member','Member'),('outsider','user','outsider','Outsider');
    INSERT INTO organizations(id,slug,display_name,kind,default_space_id) VALUES ('company','company','Company','company','alpha');
    INSERT INTO spaces(id,organization_id,slug,display_name) VALUES ('alpha','company','alpha','Alpha'),('beta','company','beta','Beta');
    INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by) VALUES ('company','owner','owner','bootstrap','owner'),('company','member','member','explicit','owner');
    INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by) VALUES ('alpha','company','member','member','none','read','explicit','owner');
    COMMIT;`);
  const epoch = fresh.control.admission(4).epoch;
  let actor: Actor = { id: "owner", slug: "owner", displayName: "Owner", isSiteAdmin: false };
  // Request admission is always supplied by the real control journal.
  const app = new Hono<AppEnv>();
  app.use(contentContractGate);
  app.use(async (c, next) => {
    c.set("actor", actor);
    return next();
  });
  app.route("/api/organizations", organizations);
  app.route("/api/spaces", spaces);
  app.route("/api/spaces/:space/settings/ai", aiSettingsApi);
  app.route("/api/spaces/:space/usage", spaceUsageApi);
  app.route("/api", accounts);
  // Count what each request asks of D1 and of the singleton cutover control.
  const statements: string[] = [];
  const database = env.DB;
  Reflect.set(
    env,
    "DB",
    new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const admissions = vi.spyOn(fresh.control, "admission");
  return {
    sqlite,
    statements,
    admissions,
    as(id: string) {
      actor = { id, slug: id, displayName: id, isSiteAdmin: id === "outsider" };
    },
    agent() {
      actor = { ...actor, agent: { id: "agent", name: "agent" } };
    },
    epoch,
    async fence() {
      // Model a separate legacy installation undergoing its real cutover fence.
      const legacy = installCutoverTestControl(env);
      closers.push(legacy.close);
      await legacy.fence();
    },
    request(path: string, method = "GET", body?: unknown, version: string | null = "4") {
      return app.request(
        `/api${path}`,
        {
          method,
          headers: {
            "content-type": "application/json",
            ...(version === null ? {} : { "X-Gitmatrix-Content-Version": version }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );
    },
  };
}
describe("Organization directory and explicit Space grant APIs", () => {
  test("owners see directory without implicit content; ordinary member directory is grant-filtered", async () => {
    const t = await setup();
    const owner = await (await t.request("/spaces/alpha")).json();
    expect(owner).toMatchObject({
      grant: null,
      contractVersion: 4,
      migrationEpoch: t.epoch,
      capabilities: {
        canReadContent: false,
        canAdministerContent: false,
        canCreateRepository: false,
        canManageGrants: true,
      },
    });
    expect(
      (await (await t.request("/organizations/company")).json<OrganizationPage>()).spaces,
    ).toHaveLength(2);
    expect(await (await t.request("/spaces")).json()).toEqual({ spaces: [] });
    t.as("member");
    const directory = await (await t.request("/organizations/company")).json<OrganizationPage>();
    expect(directory.activeSpaceCount).toBe(2);
    expect(directory.spaces).toHaveLength(1);
    expect(directory.spaces[0]).toMatchObject({
      grant: { repositoryRole: "none", packageRole: "read" },
      capabilities: { canReadContent: true, canCreateRepository: true, canManageGrants: false },
    });
    expect((await t.request("/spaces/beta")).status).toBe(404);
    t.as("outsider");
    expect((await t.request("/spaces/alpha")).status).toBe(404);
  });
  test("sibling settings keep their own grants without opening directory administration", async () => {
    const t = await setup();
    // Organization ownership alone cannot read Space AI settings.
    expect((await t.request("/spaces/alpha/settings/ai")).status).toBe(404);
    t.as("member");
    const settings = await t.request("/spaces/alpha/settings/ai");
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ canManage: false });
    expect(
      (
        await t.request("/spaces/alpha/settings/ai", "PATCH", {
          releaseHighlights: { intervalHours: 12 },
        })
      ).status,
    ).toBe(403);
    expect((await t.request("/spaces/alpha/usage")).status).toBe(403);
    for (const actor of ["member", "outsider"]) {
      t.as(actor);
      for (const [path, method] of [
        ["/spaces/alpha/grants", "GET"],
        ["/spaces/alpha/grants/member", "PUT"],
        ["/spaces/alpha/grants/member", "DELETE"],
        ["/spaces/alpha/archive", "POST"],
        ["/spaces/alpha/restore", "POST"],
      ] as const) {
        expect((await t.request(path, method, method === "GET" ? undefined : {})).status).toBe(404);
      }
    }
    // The outsider is an Instance operator: AI administration is a separate
    // preserved power, not a Space grant or permission to read its usage.
    const operatorSettings = await t.request("/spaces/alpha/settings/ai");
    expect(operatorSettings.status).toBe(200);
    expect(await operatorSettings.json()).toMatchObject({ canManage: true });
    expect((await t.request("/spaces/alpha/usage")).status).toBe(404);
  });
  test("self-grant is explicit and audited; removing membership revokes next request", async () => {
    const t = await setup();
    expect(
      (
        await t.request("/spaces/alpha/grants/owner", "PUT", {
          role: "admin",
          repositoryRole: "write",
          packageRole: "none",
        })
      ).status,
    ).toBe(204);
    expect(
      t.sqlite.prepare("SELECT action, subject_id FROM space_audit WHERE action='grant.set'").get(),
    ).toEqual({ action: "grant.set", subject_id: "owner" });
    expect(
      (await (await t.request("/spaces/alpha")).json<SpacePage>()).capabilities.canReadContent,
    ).toBe(true);
    expect((await t.request("/organizations/company/members/member", "DELETE")).status).toBe(204);
    t.as("member");
    expect((await t.request("/spaces/alpha")).status).toBe(404);
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM space_grants WHERE account_id='member'").get(),
    ).toEqual({ n: 0 });
  });
  test("defaults require explicit active same-Organization replacement and preserve last owner", async () => {
    const t = await setup();
    expect((await t.request("/spaces/alpha/archive", "POST", {})).status).toBe(409);
    expect(
      (await t.request("/organizations/company/default-space", "PUT", { spaceId: "missing" }))
        .status,
    ).toBe(400);
    expect(
      (await t.request("/spaces/alpha/archive", "POST", { replacementDefaultSpaceId: "beta" }))
        .status,
    ).toBe(204);
    expect(
      t.sqlite.prepare("SELECT default_space_id FROM organizations WHERE id='company'").get(),
    ).toEqual({ default_space_id: "beta" });
    expect((await t.request("/organizations/company/members/owner", "DELETE")).status).toBe(409);
    expect((await t.request("/spaces/alpha/restore", "POST")).status).toBe(204);
  });
  test("listings read each Space's grant and role in a fixed number of queries", async () => {
    const t = await setup();
    t.sqlite.exec(`INSERT INTO spaces(id,organization_id,slug,display_name) VALUES
      ('gamma','company','gamma','Gamma'),('delta','company','delta','Delta'),
      ('epsilon','company','epsilon','Epsilon');
      UPDATE spaces SET archived_at='2026-01-01T00:00:00Z' WHERE id='epsilon';
      INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
        VALUES ('gamma','company','owner','admin','write','write','explicit','owner'),
               ('delta','company','member','member','read','none','explicit','owner');`);
    const read = async (path: string) => {
      t.statements.length = 0;
      t.admissions.mockClear();
      const response = await t.request(path);
      expect(response.status).toBe(200);
      return {
        body: await response.json<Record<string, unknown>>(),
        queries: t.statements.length,
        admissions: t.admissions.mock.calls.length,
      };
    };
    const owner = await read("/organizations/company");
    const directory = owner.body as unknown as OrganizationPage;
    expect(directory.spaces.map((page) => [page.space.slug, page.capabilities])).toEqual([
      ["alpha", expect.objectContaining({ canReadContent: false, canManageGrants: true })],
      ["beta", expect.objectContaining({ canReadContent: false, canManageGrants: true })],
      ["delta", expect.objectContaining({ canReadContent: false, canManageGrants: true })],
      ["epsilon", expect.objectContaining({ canReadContent: false, canManageGrants: true })],
      ["gamma", expect.objectContaining({ canReadContent: true, canAdministerContent: true })],
    ]);
    expect(directory.activeSpaceCount).toBe(4);
    // Organization lookup (gate and handler), role, directory, grants and Spaces;
    // one cutover read for the whole response, not one per Space.
    expect(owner.queries).toBeLessThanOrEqual(6);
    expect(owner.admissions).toBe(1);
    t.as("member");
    const member = await read("/organizations/company");
    expect(
      (member.body as unknown as OrganizationPage).spaces.map((page) => page.space.slug),
    ).toEqual(["alpha", "delta"]);
    expect(member.queries).toBeLessThanOrEqual(6);
    expect(member.admissions).toBe(1);
    const listed = await read("/spaces");
    expect((listed.body.spaces as SpacePage[]).map((page) => page.space.slug)).toEqual([
      "alpha",
      "delta",
    ]);
    expect(listed.queries).toBeLessThanOrEqual(2);
    expect(listed.admissions).toBe(1);
  });
  test("old JSON clients and fenced epochs fail closed", async () => {
    const t = await setup();
    for (const version of [null, "3", "04"])
      expect((await t.request("/spaces/alpha", "GET", undefined, version)).status).toBe(426);
    await t.fence();
    expect((await t.request("/spaces/alpha")).status).toBe(503);
  });
  test("creation persists explicit bootstrap grants and returns canonical pages", async () => {
    const t = await setup();
    const created = await t.request("/organizations", "POST", {
      slug: "second",
      displayName: "Second",
      spaceSlug: "second-general",
      spaceDisplayName: "General",
    });
    expect(created.status).toBe(201);
    const organization = await created.json<OrganizationPage>();
    expect(organization).toMatchObject({
      viewerRole: "owner",
      activeSpaceCount: 1,
      organization: { slug: "second" },
    });
    expect(organization.spaces[0]).toMatchObject({
      grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
    });
    const space = await t.request("/spaces", "POST", {
      organizationId: organization.organization.id,
      slug: "second-private",
      displayName: "Private",
    });
    expect(space.status).toBe(201);
    expect(await space.json()).toMatchObject({
      space: { slug: "second-private" },
      grant: { role: "admin" },
    });
    t.as("member");
    expect(
      (
        await t.request("/spaces/alpha/grants/member", "PUT", {
          role: "admin",
          repositoryRole: "write",
          packageRole: "write",
        })
      ).status,
    ).toBe(404);
    expect(
      (await t.request("/organizations/company/members/outsider", "PUT", { role: "member" }))
        .status,
    ).toBe(403);
  });
  test("person profiles contain identity, not Organization members or Space content", async () => {
    const t = await setup();
    const profile = await (await t.request("/accounts/owner", "GET", undefined, null)).json();
    expect(profile).toMatchObject({
      id: "owner",
      kind: "user",
      personalOrganizationId: null,
      defaultSpaceId: null,
    });
    for (const removed of ["repos", "teams", "members", "viewerCanManage"])
      expect(profile).not.toHaveProperty(removed);
    expect((await t.request("/accounts/company", "GET", undefined, null)).status).toBe(404);
  });
});

describe("a person's own default Organization and Space (CORE-413)", () => {
  const session = async (t: Awaited<ReturnType<typeof setup>>) =>
    ((await (await t.request("/session", "GET", undefined, null)).json()) as SessionResponse)
      .viewer!;
  const choose = (t: Awaited<ReturnType<typeof setup>>, body: unknown) =>
    t.request("/account/default-scope", "PUT", body, null);

  test("saves only a choice that opens a Space, and falls back when access lapses", async () => {
    const t = await setup();
    t.sqlite.exec(`BEGIN;
      INSERT INTO organizations(id,slug,display_name,kind,personal_account_id,default_space_id) VALUES ('member-personal','member-personal','Member','personal','member','mine');
      INSERT INTO spaces(id,organization_id,slug,display_name) VALUES ('mine','member-personal','mine','Mine');
      INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by) VALUES ('member-personal','member','owner','bootstrap','member');
      INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by) VALUES ('mine','member-personal','member','admin','write','write','bootstrap','member');
      COMMIT;`);
    t.as("member");
    expect(await session(t)).toMatchObject({
      defaultSpaceId: "mine",
      savedDefault: { organizationId: null, spaceId: null },
    });

    // No grant in Beta, and no membership in someone else's Organization.
    expect((await choose(t, { organizationId: "company", spaceId: "beta" })).status).toBe(400);
    expect((await choose(t, { organizationId: "nowhere", spaceId: null })).status).toBe(400);
    const company = await choose(t, { organizationId: "company", spaceId: null });
    expect(company.status).toBe(200);
    expect(((await company.json()) as SessionResponse).viewer).toMatchObject({
      defaultSpaceId: "alpha",
      savedDefault: { organizationId: "company", spaceId: null },
    });

    t.sqlite.exec(
      `INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by) VALUES ('beta','company','member','member','none','read','explicit','owner');`,
    );
    expect((await choose(t, { organizationId: "company", spaceId: "beta" })).status).toBe(200);
    expect((await session(t)).defaultSpaceId).toBe("beta");

    // Losing the grant keeps the saved choice but opens the personal default again.
    t.sqlite.exec("DELETE FROM space_grants WHERE space_id='beta' AND account_id='member'");
    expect(await session(t)).toMatchObject({
      defaultSpaceId: "mine",
      savedDefault: { organizationId: "company", spaceId: "beta" },
    });

    expect((await choose(t, { organizationId: null, spaceId: null })).status).toBe(200);
    expect((await session(t)).savedDefault).toEqual({ organizationId: null, spaceId: null });
  });

  test("rejects malformed bodies, Spaces from another Organization and agents", async () => {
    const t = await setup();
    t.as("member");
    for (const body of [
      null,
      {},
      { organizationId: 5 },
      { organizationId: "", spaceId: null },
      { organizationId: "company", spaceId: "" },
      { organizationId: null, spaceId: "alpha" },
      { organizationId: "company", spaceId: 5 },
      { organizationId: "company", spaceId: "alpha", extra: true },
    ])
      expect((await choose(t, body)).status).toBe(400);
    t.sqlite.exec(`BEGIN;
      INSERT INTO organizations(id,slug,display_name,kind,default_space_id) VALUES ('other','other','Other','company','gamma');
      INSERT INTO spaces(id,organization_id,slug,display_name) VALUES ('gamma','other','gamma','Gamma');
      INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by) VALUES ('other','member','member','explicit','owner');
      INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by) VALUES ('gamma','other','member','member','none','read','explicit','owner');
      COMMIT;`);
    expect((await choose(t, { organizationId: "company", spaceId: "gamma" })).status).toBe(400);
    t.as("member");
    t.agent();
    expect((await choose(t, { organizationId: "other", spaceId: null })).status).toBe(403);
  });
});
