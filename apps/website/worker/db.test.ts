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
