import { randomUUID } from "node:crypto";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { d1, migratedDatabase, migratedRegistryDatabase, restoredDatabase } from "./d1.ts";
import { providedDatabase } from "./provided.ts";
import { installCutoverTestControl } from "./space-cutover.ts";

/** A freshly initialized installation's three databases, serialized. */
interface FreshSnapshot {
  db: Uint8Array;
  registry: Uint8Array;
  control: Uint8Array;
}

/**
 * Initializing an installation takes about a second. The unit run does it once
 * (worker/testing/provided.ts); other runs, once per module.
 */
let snapshot: Promise<FreshSnapshot> | null = null;

export async function initializedSnapshot(): Promise<FreshSnapshot> {
  const sqlite = migratedDatabase();
  const registry = migratedRegistryDatabase();
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
  const cutover = installCutoverTestControl(env);
  try {
    await initializeFreshSpaceInstallation(env);
    return {
      db: sqlite.serialize(),
      registry: registry.serialize(),
      control: cutover.state.db.serialize(),
    };
  } finally {
    cutover.close();
    sqlite.close();
    registry.close();
  }
}

function providedSnapshot(): FreshSnapshot | null {
  const db = providedDatabase("installed");
  const registry = providedDatabase("installedRegistry");
  const control = providedDatabase("installedControl");
  return db && registry && control ? { db, registry, control } : null;
}

/**
 * Copies of a freshly initialized installation: the migrated DB and
 * REGISTRY_DB, and the control journal to pass to installCutoverTestControl.
 * Restoring takes milliseconds; migrating and initializing per test took most
 * of the unit suite's time.
 */
export async function freshInstallationDatabases() {
  const fresh = await (snapshot ??= Promise.resolve()
    .then(() => providedSnapshot() ?? initializedSnapshot())
    .catch((error: unknown) => {
      snapshot = null;
      throw error;
    }));
  return {
    sqlite: restoredDatabase(fresh.db),
    registry: restoredDatabase(fresh.registry),
    control: restoredDatabase(fresh.control),
  };
}

/** Empty real schemas and control journal, initialized before callers seed content. */
export async function createFreshSpaceTestEnvironment() {
  const fresh = await freshInstallationDatabases();
  const { sqlite, registry } = fresh;
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
  const cutover = installCutoverTestControl(env, fresh.control);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    cutover.close();
    if (sqlite.isOpen) sqlite.close();
    if (registry.isOpen) registry.close();
  };
  try {
    await initializeFreshSpaceInstallation(env);
    return { sqlite, registry, env, control: cutover.control, close };
  } catch (error) {
    close();
    throw error;
  }
}

export interface SpaceFixture {
  organization: {
    id: string;
    slug: string;
    displayName: string;
    kind: "company" | "personal";
    personalAccountId?: string;
  };
  space: { id: string; slug: string; displayName: string };
  members: Array<{
    accountId: string;
    role: "owner" | "member";
    grant?: {
      role: "admin" | "member";
      repositoryRole: "none" | "read" | "write";
      packageRole: "none" | "read" | "write";
    };
  }>;
  actorId: string;
}

/** Seed a real default Space atomically. People must already exist; no role implies a grant. */
export async function seedSpaceFixture(db: D1Database, input: SpaceFixture): Promise<void> {
  const { organization, space, members, actorId } = input;
  const statements = [
    db
      .prepare(
        `INSERT INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        organization.id,
        organization.slug,
        organization.displayName,
        organization.kind,
        organization.personalAccountId ?? null,
        space.id,
      ),
    db
      .prepare(`INSERT INTO spaces (id, organization_id, slug, display_name) VALUES (?, ?, ?, ?)`)
      .bind(space.id, organization.id, space.slug, space.displayName),
  ];
  for (const member of members) {
    statements.push(
      db
        .prepare(
          `INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by)
       VALUES (?, ?, ?, 'test-fixture', ?)`,
        )
        .bind(organization.id, member.accountId, member.role, actorId),
    );
    if (!member.grant) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO space_grants
       (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
       VALUES (?, ?, ?, ?, ?, ?, 'test-fixture', ?)`,
        )
        .bind(
          space.id,
          organization.id,
          member.accountId,
          member.grant.role,
          member.grant.repositoryRole,
          member.grant.packageRole,
          actorId,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail)
       VALUES (?, ?, ?, ?, 'space.grant', ?, ?)`,
        )
        .bind(
          `fixture_audit_${randomUUID()}`,
          organization.id,
          space.id,
          actorId,
          member.accountId,
          JSON.stringify({ ...member.grant, origin: "test-fixture" }),
        ),
    );
  }
  await db.batch(statements);
}
