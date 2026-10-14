import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "./testing/spaces.ts";
import {
  canCreateRepository,
  findRepo,
  readableRepo,
  repoSummary,
  roleFor,
  selectRepos,
  viewerFor,
  type Actor,
} from "./db.ts";

import { resolveSpaceAccess } from "./spaces/access.ts";
import { listOrganizations, listSpaceDirectory } from "./spaces/store.ts";

vi.mock("cloudflare:workers", () => import("./testing/runtime.ts"));
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
async function fixture() {
  const fresh = await createFreshSpaceTestEnvironment();
  closers.push(fresh.close);
  const { sqlite } = fresh;
  const database = fresh.env.DB;
  sqlite.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES
    ('admin','user','admin','Admin'),('member','user','member','Member'),
    ('collaborator','user','collaborator','Collaborator'),('same-id','user','same-id','Matching person');`);
  const actor = (id: string, isSiteAdmin = false): Actor => ({
    id,
    slug: id,
    displayName: id,
    isSiteAdmin,
  });
  for (const [id, slug] of [
    ["same-id", "first"],
    ["second", "second"],
  ] as const) {
    await seedSpaceFixture(database, {
      organization: {
        id: `org-${id}`,
        slug: `company-${slug}`,
        displayName: slug,
        kind: "company",
      },
      space: { id, slug, displayName: slug },
      actorId: "admin",
      members: [
        { accountId: "admin", role: "owner" },
        {
          accountId: "member",
          role: "member",
          grant: {
            role: "member",
            repositoryRole: id === "same-id" ? "read" : "none",
            packageRole: "read",
          },
        },
      ],
    });
  }
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES
    ('private','same-id','private','private','private','https://artifacts.test/private.git'),
    ('sibling','second','sibling','private','sibling','https://artifacts.test/sibling.git'),
    ('public','second','public','public','public','https://artifacts.test/public.git');
    INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('private','collaborator','write');`);
  return { sqlite, database, actor };
}

describe("Space repository resolution", () => {
  test("Organization owners and matching person IDs do not inherit content rights", async () => {
    const f = await fixture();
    for (const person of ["admin", "same-id"]) {
      const actor = f.actor(person);
      const repo = await findRepo(f.database, actor, "first", "private");
      expect(repo).not.toBeNull();
      expect(roleFor(repo!, actor)).toBe("none");
      expect(await canCreateRepository(f.database, actor, "same-id")).toBe(false);
    }
    expect(await findRepo(f.database, f.actor("admin"), "company-first", "private")).toBeNull();
  });

  test("SQL and DTO rights preserve independent public, collaborator and grant access", async () => {
    const f = await fixture();
    for (const actor of [
      null,
      f.actor("admin"),
      f.actor("member"),
      f.actor("collaborator"),
      f.actor("admin", true),
    ]) {
      const rows = await selectRepos(f.database, actor?.id ?? "").execute();
      const allowed = rows
        .filter((row) => roleFor(row, actor) !== "none")
        .map((row) => row.id)
        .sort();
      const sqlAllowed = await selectRepos(f.database, actor?.id ?? "")
        .where(readableRepo(actor))
        .execute();
      expect(sqlAllowed.map((row) => row.id).sort()).toEqual(allowed);
    }
    const repo = await findRepo(f.database, f.actor("collaborator"), "first", "private");
    expect(repoSummary(repo!, f.actor("collaborator"))).toMatchObject({
      space: { id: "same-id", slug: "first", organization: { id: "org-same-id" } },
      viewerRole: "write",
    });
    expect(repoSummary(repo!, f.actor("collaborator"))).not.toHaveProperty("owner");
    expect(await canCreateRepository(f.database, f.actor("collaborator"), "same-id")).toBe(false);
    expect(await canCreateRepository(f.database, f.actor("member"), "second")).toBe(true);
  });

  test("membership removal takes effect next request without stale grant or viewer navigation", async () => {
    const f = await fixture();
    const actor = f.actor("member");
    expect(roleFor((await findRepo(f.database, actor, "first", "private"))!, actor)).toBe("read");
    f.sqlite
      .prepare("DELETE FROM organization_members WHERE organization_id=? AND account_id=?")
      .run("org-same-id", "member");
    expect(roleFor((await findRepo(f.database, actor, "first", "private"))!, actor)).toBe("none");
    expect((await viewerFor(f.database, actor)).spaces.map((space) => space.id)).not.toContain(
      "same-id",
    );
  });
});

/** Counts statements a D1 prepares: each is a round trip from the Worker. */
function countingD1(database: D1Database) {
  const sql: string[] = [];
  const counted = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: counted, sql };
}

/** The viewer's Spaces as the per-Space lookups resolve them, one at a time. */
async function spacesOneByOne(database: D1Database, actor: Actor) {
  const ids: string[] = [];
  for (const organization of await listOrganizations(database, actor))
    for (const entry of await listSpaceDirectory(database, actor, organization.id)) {
      const access = await resolveSpaceAccess(database, actor, entry.id);
      if (access) ids.push(access.space.id);
    }
  return ids;
}

describe("Viewer navigation", () => {
  async function wideFixture() {
    const f = await fixture();
    f.sqlite.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES
      ('wide','user','wide','Wide'),('stranger','user','stranger','Stranger');
      INSERT INTO agents(id,name,accountable_id) VALUES ('live-agent','live','wide');
      INSERT INTO agents(id,name,accountable_id,revoked_at)
        VALUES ('revoked-agent','revoked','wide','2026-01-01T00:00:00Z');`);
    for (const org of ["alpha", "beta", "gamma"]) {
      await seedSpaceFixture(f.database, {
        organization: { id: `org-${org}`, slug: org, displayName: org, kind: "company" },
        space: { id: `${org}-0`, slug: `${org}-0`, displayName: `${org} 0` },
        actorId: "admin",
        members: [
          { accountId: "admin", role: "owner" },
          // Beta's owner holds no grant on its default Space: directory, not content.
          org === "beta"
            ? { accountId: "wide", role: "owner" }
            : {
                accountId: "wide",
                role: "member",
                grant: { role: "member", repositoryRole: "read", packageRole: "read" },
              },
        ],
      });
      for (const n of [1, 2, 3]) {
        f.sqlite.exec(`INSERT INTO spaces(id,organization_id,slug,display_name)
          VALUES ('${org}-${n}','org-${org}','${org}-${n}','${org} ${n}')`);
        // Every third Space carries no grant for the viewer.
        if (n === 3) continue;
        f.sqlite.exec(`INSERT INTO space_grants
          (space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
          VALUES ('${org}-${n}','org-${org}','wide','member','read','none','test-fixture','admin')`);
      }
    }
    // A granted but archived Space, and an Organization the viewer has left.
    f.sqlite.exec(`UPDATE spaces SET archived_at='2026-01-01T00:00:00Z' WHERE id='alpha-2'`);
    f.sqlite.exec(
      `DELETE FROM organization_members WHERE organization_id='org-gamma' AND account_id='wide'`,
    );
    return f;
  }

  test("the viewer resolves every Space grant in a fixed number of queries", async () => {
    const f = await wideFixture();
    for (const actor of [
      f.actor("wide"),
      { ...f.actor("wide"), agent: { id: "live-agent", name: "live" } },
      { ...f.actor("wide"), agent: { id: "revoked-agent", name: "revoked" } },
      f.actor("stranger"),
      f.actor("member"),
    ]) {
      const expected = await spacesOneByOne(f.database, actor);
      const counted = countingD1(f.database);
      const viewer = await viewerFor(counted.database, actor);
      expect(viewer.spaces.map((space) => space.id)).toEqual(expected);
      // Organizations and the account row together, then every granted Space at once,
      // however many Spaces there are.
      expect(counted.sql.length).toBeLessThanOrEqual(3);
    }
    const viewer = await viewerFor(f.database, f.actor("wide"));
    expect(viewer.spaces.map((space) => space.id)).toEqual([
      "alpha-0",
      "alpha-1",
      "beta-1",
      "beta-2",
    ]);
    expect(viewer.organizations.map((organization) => organization.slug)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
