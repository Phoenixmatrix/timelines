import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "./d1.ts";
import { installCutoverTestControl } from "./space-cutover.ts";

/** A freshly initialized installation's three databases, serialized. */
interface FreshSnapshot {
  db: Uint8Array;
  registry: Uint8Array;
  control: Uint8Array;
}

/** Initializing an installation takes about two seconds; each test file's worker does it once. */
let snapshot: Promise<FreshSnapshot> | null = null;

async function initializedSnapshot(): Promise<FreshSnapshot> {
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

function restored(bytes: Uint8Array): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.deserialize(bytes);
  return db;
}

/** Empty real schemas and control journal, initialized before callers seed content. */
export async function createFreshSpaceTestEnvironment() {
  const fresh = await (snapshot ??= initializedSnapshot().catch((error: unknown) => {
    snapshot = null;
    throw error;
  }));
  const sqlite = restored(fresh.db);
  const registry = restored(fresh.registry);
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
  const cutover = installCutoverTestControl(env, restored(fresh.control));
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
