import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
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
  return {
    sqlite,
    as(id: string) {
      actor = { id, slug: id, displayName: id, isSiteAdmin: id === "outsider" };
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
