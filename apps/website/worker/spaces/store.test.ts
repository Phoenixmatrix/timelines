import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
import type { Actor } from "../db.ts";
import type { SpaceMapping } from "../../shared/space-cutover.ts";
import { CONTENT_CONTRACT_VERSION, legacyMemberRoles } from "../../shared/spaces.ts";
import { findSpaceById, findSpaceBySlug, resolveSpaceAccess } from "./access.ts";
import {
  archiveSpace,
  buildSpaceImportStage,
  SPACE_IMPORT_BATCH,
  type SpaceImportProvenance,
  type SpaceImportStage,
  createOrganization,
  createSpace,
  listOrganizations,
  listSpaceDirectory,
  removeOrganizationMember,
  resolveDefaultSpaceAccess,
  restoreSpace,
  revokeSpaceGrant,
  setDefaultSpace,
  setOrganizationMember,
  setSpaceGrant,
  updateOrganization,
  updateSpace,
} from "./store.ts";

async function importFields(
  db: D1Database,
  actor: Actor,
  mapping: SpaceMapping,
  provenance: SpaceImportProvenance,
) {
  const stages: SpaceImportStage[] = [{ kind: "identity" }];
  for (let offset = 0; offset < mapping.organizationMembers.length; offset += SPACE_IMPORT_BATCH)
    stages.push({ kind: "members", offset });
  for (let offset = 0; offset < mapping.spaceGrants.length; offset += SPACE_IMPORT_BATCH)
    stages.push({ kind: "grants", offset });
  stages.push({ kind: "complete" });
  for (const stage of stages)
    await db.batch(buildSpaceImportStage(db, actor, mapping, provenance, stage).statements);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture(legacy = false) {
  const fresh = legacy ? null : await createFreshSpaceTestEnvironment();
  const sqlite = fresh?.sqlite ?? migratedDatabase();
  cleanups.push(fresh ? fresh.close : () => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const database = fresh?.env.DB ?? d1(sqlite);
  const person = (id: string, isSiteAdmin = false): Actor => {
    sqlite
      .prepare(
        "INSERT INTO accounts (id, kind, slug, display_name, is_site_admin) VALUES (?, 'user', ?, ?, ?)",
      )
      .run(id, id, id, Number(isSiteAdmin));
    return { id, slug: id, displayName: id, isSiteAdmin };
  };
  const owner = person("owner");
  const member = person("member");
  const outsider = person("outsider");
  const operator = person("operator", true);
  const bootstrap = (slug = "company", actor = owner) =>
    createOrganization(database, actor, {
      slug,
      displayName: slug,
      kind: "company",
      spaceSlug: `${slug}-general`,
      spaceDisplayName: "General",
    });
  return { sqlite, database, person, owner, member, outsider, operator, bootstrap };
}

describe("Organization/Space domain", () => {
  test("bootstraps a real default and explicit grant atomically without legacy backfill", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    const access = await resolveDefaultSpaceAccess(f.database, f.owner, scope.organizationId);
    expect(access?.spaceId).toBe(scope.spaceId);
    expect(access?.grant.role).toBe("admin");
    expect(access?.contractVersion).toBe(CONTENT_CONTRACT_VERSION);
    expect(scope.spaceId).not.toBe(f.owner.id);
    expect(await findSpaceBySlug(f.database, "COMPANY-GENERAL")).toMatchObject({
      id: scope.spaceId,
    });
    const before = f.sqlite.prepare("SELECT count(*) AS n FROM organizations").get();
    await expect(
      createOrganization(f.database, f.owner, {
        slug: "different",
        displayName: "different",
        kind: "company",
        spaceSlug: "company-general",
        spaceDisplayName: "General",
      }),
    ).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM organizations").get()).toEqual(before);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM space_audit").get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("SELECT id FROM accounts WHERE kind = 'org'").all()).toEqual([]);
  });

  test("two Organizations and two Spaces separate ordinary owners, members and Instance operators", async () => {
    const f = await fixture();
    const first = await f.bootstrap();
    const second = await f.bootstrap("other", f.outsider);
    const firstSibling = await createSpace(f.database, f.owner, first.organizationId, {
      slug: "first-private",
      displayName: "Private",
    });
    const secondSibling = await createSpace(f.database, f.outsider, second.organizationId, {
      slug: "second-private",
      displayName: "Private",
    });
    await setOrganizationMember(f.database, f.owner, first.organizationId, f.member.id, "owner");
    expect(await listOrganizations(f.database, f.member)).toHaveLength(1);
    expect(await listSpaceDirectory(f.database, f.member, first.organizationId)).toHaveLength(2);
    expect(await listSpaceDirectory(f.database, f.member, second.organizationId)).toEqual([]);
    for (const id of [first.spaceId, firstSibling, second.spaceId, secondSibling]) {
      expect(await resolveSpaceAccess(f.database, f.member, id)).toBeNull();
      expect(await resolveSpaceAccess(f.database, f.operator, id)).toBeNull();
    }
    expect(await resolveSpaceAccess(f.database, f.owner, secondSibling)).toBeNull();
    await expect(
      setSpaceGrant(f.database, f.member, second.organizationId, secondSibling, {
        accountId: f.member.id,
        role: "admin",
        repositoryRole: "write",
        packageRole: "write",
      }),
    ).rejects.toThrow();
    await setSpaceGrant(f.database, f.member, first.organizationId, firstSibling, {
      accountId: f.member.id,
      role: "member",
      ...legacyMemberRoles("none"),
    });
    expect((await resolveSpaceAccess(f.database, f.member, firstSibling))?.grant).toMatchObject({
      repositoryRole: "none",
      packageRole: "read",
    });
    expect(await resolveSpaceAccess(f.database, f.member, first.spaceId)).toBeNull();
    await setOrganizationMember(f.database, f.owner, first.organizationId, f.member.id, "member");
    expect(await listSpaceDirectory(f.database, f.member, first.organizationId)).toEqual([
      {
        id: firstSibling,
        slug: "first-private",
        displayName: "Private",
        archivedAt: null,
        isDefault: false,
      },
    ]);
  });

  test.each(["none", "read", "write"] as const)(
    "preserves independent legacy %s repository/package baselines",
    async (baseline) => {
      const f = await fixture();
      const scope = await f.bootstrap();
      await setOrganizationMember(f.database, f.owner, scope.organizationId, f.member.id, "member");
      await setSpaceGrant(f.database, f.owner, scope.organizationId, scope.spaceId, {
        accountId: f.member.id,
        role: "member",
        ...legacyMemberRoles(baseline),
      });
      const access = await resolveSpaceAccess(f.database, f.member, scope.spaceId);
      expect(access?.grant.repositoryRole).toBe(baseline);
      expect(access?.grant.packageRole).toBe(baseline === "write" ? "write" : "read");
      await revokeSpaceGrant(f.database, f.owner, scope.organizationId, scope.spaceId, f.member.id);
      expect(await resolveSpaceAccess(f.database, f.member, scope.spaceId)).toBeNull();
      expect(
        (await findSpaceById(f.database, scope.spaceId))!.authorizationVersion,
      ).toBeGreaterThan(access!.authorizationVersion);
    },
  );

  test("defaults reject cross-Organization, archived and last-Space removal; access loss never chooses a sibling", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    const other = await f.bootstrap("other");
    await expect(
      archiveSpace(f.database, f.owner, scope.organizationId, scope.spaceId),
    ).rejects.toThrow();
    await expect(
      setDefaultSpace(f.database, f.owner, scope.organizationId, other.spaceId),
    ).rejects.toThrow();
    const sibling = await createSpace(f.database, f.owner, scope.organizationId, {
      slug: "sibling",
      displayName: "Sibling",
    });
    await archiveSpace(f.database, f.owner, scope.organizationId, scope.spaceId, sibling);
    expect(
      (await resolveDefaultSpaceAccess(f.database, f.owner, scope.organizationId))?.spaceId,
    ).toBe(sibling);
    await expect(
      setDefaultSpace(f.database, f.owner, scope.organizationId, scope.spaceId),
    ).rejects.toThrow();
    await restoreSpace(f.database, f.owner, scope.organizationId, scope.spaceId);
    await revokeSpaceGrant(f.database, f.owner, scope.organizationId, sibling, f.owner.id);
    expect(await resolveDefaultSpaceAccess(f.database, f.owner, scope.organizationId)).toBeNull();
    expect(await resolveSpaceAccess(f.database, f.owner, scope.spaceId)).not.toBeNull();
  });

  test("global handles and Organization ownership are immutable even through direct SQL", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    const other = await f.bootstrap("other");
    expect(() =>
      f.sqlite
        .prepare("UPDATE spaces SET organization_id = ? WHERE id = ?")
        .run(other.organizationId, scope.spaceId),
    ).toThrow();
    expect(() =>
      f.sqlite.prepare("UPDATE spaces SET slug = 'renamed' WHERE id = ?").run(scope.spaceId),
    ).toThrow();
    expect(() =>
      f.sqlite
        .prepare("UPDATE organizations SET slug = 'renamed' WHERE id = ?")
        .run(scope.organizationId),
    ).toThrow();
    await expect(
      createSpace(f.database, f.owner, scope.organizationId, {
        slug: "accounts",
        displayName: "Invalid",
      }),
    ).rejects.toThrow();
    await expect(
      createSpace(f.database, f.owner, scope.organizationId, {
        slug: "organizations",
        displayName: "Invalid",
      }),
    ).rejects.toThrow();
    await updateOrganization(f.database, f.owner, scope.organizationId, "New display");
    await updateSpace(
      f.database,
      f.owner,
      scope.organizationId,
      scope.spaceId,
      "New Space display",
    );
    expect(await findSpaceById(f.database, scope.spaceId)).toMatchObject({
      displayName: "New Space display",
      organization: { displayName: "New display" },
    });
  });

  test("membership revoke atomically deletes every same-Organization grant and attributes each revocation", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    const sibling = await createSpace(f.database, f.owner, scope.organizationId, {
      slug: "sibling",
      displayName: "Sibling",
    });
    await setOrganizationMember(f.database, f.owner, scope.organizationId, f.member.id, "member");
    for (const id of [scope.spaceId, sibling])
      await setSpaceGrant(f.database, f.owner, scope.organizationId, id, {
        accountId: f.member.id,
        role: "member",
        ...legacyMemberRoles("none"),
      });
    f.sqlite.exec(
      "CREATE TRIGGER fail_revoke BEFORE DELETE ON organization_members BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    await expect(
      removeOrganizationMember(f.database, f.owner, scope.organizationId, f.member.id),
    ).rejects.toThrow("injected");
    for (const id of [scope.spaceId, sibling])
      expect(await resolveSpaceAccess(f.database, f.member, id)).not.toBeNull();
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM space_audit WHERE action = 'grant.revoke-membership'")
        .get(),
    ).toEqual({ n: 0 });
    f.sqlite.exec("DROP TRIGGER fail_revoke");
    f.sqlite
      .prepare("INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'Agent', ?)")
      .run(f.owner.id);
    await removeOrganizationMember(
      f.database,
      { ...f.owner, agent: { id: "agent", name: "Untrusted name" } },
      scope.organizationId,
      f.member.id,
    );
    for (const id of [scope.spaceId, sibling])
      expect(await resolveSpaceAccess(f.database, f.member, id)).toBeNull();
    expect(
      f.sqlite
        .prepare(
          "SELECT actor_id, agent_id FROM space_audit WHERE action = 'grant.revoke-membership'",
        )
        .all(),
    ).toEqual([
      { actor_id: f.owner.id, agent_id: "agent" },
      { actor_id: f.owner.id, agent_id: "agent" },
    ]);
    await expect(
      removeOrganizationMember(f.database, f.owner, scope.organizationId, f.owner.id),
    ).rejects.toThrow();
    await expect(
      setOrganizationMember(f.database, f.owner, scope.organizationId, f.owner.id, "member"),
    ).rejects.toThrow();
  });

  test("re-resolves person and accountable agent on every access and mutation", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    f.sqlite
      .prepare("INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'Current name', ?)")
      .run(f.owner.id);
    const actor = { ...f.owner, agent: { id: "agent", name: "Stale name" } };
    expect((await resolveSpaceAccess(f.database, actor, scope.spaceId))?.agent?.name).toBe(
      "Current name",
    );
    expect(
      await resolveSpaceAccess(f.database, { ...f.outsider, agent: actor.agent }, scope.spaceId),
    ).toBeNull();
    f.sqlite.exec("UPDATE agents SET revoked_at = '2026-10-11T00:00:00Z' WHERE id = 'agent'");
    expect(await resolveSpaceAccess(f.database, actor, scope.spaceId)).toBeNull();
    await expect(
      createSpace(f.database, actor, scope.organizationId, {
        slug: "denied",
        displayName: "Denied",
      }),
    ).rejects.toThrow();
    expect(() =>
      f.sqlite.prepare("UPDATE accounts SET kind = 'org' WHERE id = ?").run(f.owner.id),
    ).toThrow();
    expect(await resolveSpaceAccess(f.database, f.owner, scope.spaceId)).not.toBeNull();
  });

  test("personal default and account identity stay separate; no equality grant", async () => {
    const f = await fixture();
    const personal = await createOrganization(f.database, f.owner, {
      kind: "personal",
      slug: "personal",
      displayName: "Personal",
      spaceSlug: "personal-home",
      spaceDisplayName: "General",
    });
    expect(
      (await findSpaceById(f.database, personal.spaceId))?.organization.personalAccountId,
    ).toBe(f.owner.id);
    await expect(
      createOrganization(f.database, f.owner, {
        kind: "personal",
        slug: "again",
        displayName: "Again",
        spaceSlug: "again-home",
        spaceDisplayName: "General",
      }),
    ).rejects.toThrow();
    await seedSpaceFixture(f.database, {
      organization: {
        id: "member-org",
        slug: "member-org",
        displayName: "Member",
        kind: "company",
      },
      space: { id: f.member.id, slug: "member-home", displayName: "General" },
      actorId: f.member.id,
      members: [
        {
          accountId: f.member.id,
          role: "owner",
          grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
        },
      ],
    });
    expect(await resolveSpaceAccess(f.database, f.member, f.member.id)).not.toBeNull();
    await revokeSpaceGrant(f.database, f.member, "member-org", f.member.id, f.member.id);
    expect(await resolveSpaceAccess(f.database, f.member, f.member.id)).toBeNull();
  });

  test("explicit import preserves origins, allows exact grouped Organization reuse and rejects conflicting reuse", async () => {
    const f = await fixture(true);
    const first = legacyMapping("legacy-one", f.owner.id);
    first.organizationMembers.push({ accountId: f.member.id, role: "member" });
    first.spaceGrants.push({
      accountId: f.member.id,
      role: "member",
      ...legacyMemberRoles("none"),
      origin: "legacy-org-membership:member",
    });
    const second = legacyMapping("legacy-two", f.member.id);
    second.organization = first.organization;
    second.space.organizationId = first.organization.id;
    await expect(
      importFields(f.database, f.owner, first, { runId: "run", manifestDigest: "digest" }),
    ).rejects.toThrow();
    await importFields(f.database, f.operator, first, { runId: "run", manifestDigest: "digest" });
    await importFields(f.database, f.operator, second, { runId: "run", manifestDigest: "digest" });
    expect(
      f.sqlite
        .prepare(
          "SELECT role, repository_role, package_role, origin FROM space_grants WHERE space_id = ? AND account_id = ?",
        )
        .get(first.space.id, f.member.id),
    ).toEqual({
      role: "member",
      repository_role: "none",
      package_role: "read",
      origin: "legacy-org-membership:member",
    });
    expect(
      f.sqlite
        .prepare("SELECT * FROM space_grants WHERE space_id = ? AND account_id = ?")
        .get(second.space.id, f.owner.id),
    ).toBeUndefined();
    expect(
      f.sqlite
        .prepare("SELECT origin FROM space_grants WHERE space_id = ? AND account_id = ?")
        .get(second.space.id, f.member.id),
    ).toEqual({ origin: "legacy-org-membership:owner" });
    const conflicting = legacyMapping("legacy-three", f.owner.id);
    conflicting.organization = { ...first.organization, displayName: "Conflict" };
    conflicting.space.organizationId = first.organization.id;
    await expect(
      importFields(f.database, f.operator, conflicting, { runId: "run", manifestDigest: "digest" }),
    ).rejects.toThrow();
    expect(
      f.sqlite.prepare("SELECT id FROM spaces WHERE id = 'legacy-three'").get(),
    ).toBeUndefined();
    expect(
      f.sqlite
        .prepare(
          "SELECT actor_id, migration_run_id, manifest_digest FROM space_audit WHERE action = 'migration.import'",
        )
        .all(),
    ).toEqual([
      { actor_id: f.operator.id, migration_run_id: "run", manifest_digest: "digest" },
      { actor_id: f.operator.id, migration_run_id: "run", manifest_digest: "digest" },
    ]);
  });

  test("import stages stay bounded and reauthenticate each batch before granting", async () => {
    const f = await fixture(true);
    const mapping = legacyMapping("bounded-import", f.owner.id);
    for (let index = 0; index < 96; index++) {
      const id = `import-member-${index}`;
      f.sqlite
        .prepare("INSERT INTO accounts(id,kind,slug,display_name) VALUES(?,'user',?,?)")
        .run(id, id, id);
      mapping.organizationMembers.push({ accountId: id, role: "member" });
      mapping.spaceGrants.push({
        accountId: id,
        role: "member",
        repositoryRole: "none",
        packageRole: "read",
        origin: "legacy-org-membership:member",
      });
    }
    const provenance = { runId: "bounded-run", manifestDigest: "bounded-digest" };
    const identity = buildSpaceImportStage(f.database, f.operator, mapping, provenance, {
      kind: "identity",
    });
    await f.database.batch(identity.statements);
    const first = buildSpaceImportStage(f.database, f.operator, mapping, provenance, {
      kind: "members",
      offset: 0,
    });
    expect(first.statements.length).toBeLessThanOrEqual(SPACE_IMPORT_BATCH + 1);
    await f.database.batch(first.statements);
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM space_audit WHERE action='migration.import'")
        .get(),
    ).toEqual({ n: 0 });
    f.sqlite.prepare("UPDATE accounts SET is_site_admin=0 WHERE id=?").run(f.operator.id);
    const next = buildSpaceImportStage(f.database, f.operator, mapping, provenance, {
      kind: "members",
      offset: SPACE_IMPORT_BATCH,
    });
    await expect(f.database.batch(next.statements)).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM organization_members").get()).toEqual({
      n: SPACE_IMPORT_BATCH,
    });
  });

  test("invalid membership/grant targets and stale administrative actors fail atomically", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    const before = f.sqlite.prepare("SELECT count(*) AS n FROM space_audit").get();
    await expect(
      setSpaceGrant(f.database, f.owner, scope.organizationId, scope.spaceId, {
        accountId: f.outsider.id,
        role: "admin",
        repositoryRole: "write",
        packageRole: "write",
      }),
    ).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM space_audit").get()).toEqual(before);
    await setOrganizationMember(f.database, f.owner, scope.organizationId, f.member.id, "owner");
    await removeOrganizationMember(f.database, f.owner, scope.organizationId, f.member.id);
    await expect(
      createSpace(f.database, f.member, scope.organizationId, {
        slug: "stale-owner",
        displayName: "Denied",
      }),
    ).rejects.toThrow();
    expect(await findSpaceBySlug(f.database, "stale-owner")).toBeNull();
    await expect(
      f.database.batch([
        f.database.prepare(
          "INSERT INTO organizations (id, slug, display_name, kind, default_space_id) VALUES ('broken', 'broken', 'Broken', 'company', 'missing')",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      f.sqlite.prepare("SELECT id FROM organizations WHERE id = 'broken'").get(),
    ).toBeUndefined();
  });

  test("repository-only collaboration does not create a Space or package grant", async () => {
    const f = await fixture();
    const scope = await f.bootstrap();
    f.sqlite
      .prepare(`INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', ?, 'private-repo', 'private', 'artifact', 'remote')`)
      .run(scope.spaceId);
    f.sqlite
      .prepare(
        "INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('repo', ?, 'admin')",
      )
      .run(f.member.id);
    expect(await resolveSpaceAccess(f.database, f.member, scope.spaceId)).toBeNull();
    expect(await listSpaceDirectory(f.database, f.member, scope.organizationId)).toEqual([]);
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM space_grants WHERE account_id = ?")
        .get(f.member.id),
    ).toEqual({ n: 0 });
  });
});

function legacyMapping(id: string, accountId: string): SpaceMapping {
  return {
    legacyOwner: { id, kind: "org", slug: id },
    organization: {
      id: `org-${id}`,
      slug: `org-${id}`,
      displayName: id,
      kind: "company",
      personalAccountId: null,
      defaultSpaceId: id,
    },
    space: { id, organizationId: `org-${id}`, slug: id, displayName: "General", archived: false },
    organizationMembers: [{ accountId, role: "owner" }],
    spaceGrants: [
      {
        accountId,
        role: "admin",
        repositoryRole: "write",
        packageRole: "write",
        origin: "legacy-org-membership:owner",
      },
    ],
    trackerDoName: id,
    repositories: [],
    repositoryCollaborators: [],
    registryFeeds: [],
    providers: [],
    hasContentSettings: false,
  };
}
