// Test helpers: the Tracker Durable Object's synchronous SQL over node:sqlite.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlDatabase } from "../tracker/store.ts";
import { boundVariables } from "./durable.ts";
import { fakeDurableObjectId, fakeDurableState } from "./durable-state.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture, type SpaceFixture } from "./spaces.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";
import { findSpaceById } from "../spaces/access.ts";

/** Real fresh installation and named Tracker scope; grants are caller-specified, never inferred. */
export async function freshTrackerStorage(spaceId = "org", members: SpaceFixture["members"] = []) {
  const installation = await createFreshSpaceTestEnvironment();
  const state = fakeDurableState({ name: spaceId });
  const close = () => {
    if (state.db.isOpen) state.db.close();
    installation.close();
  };
  try {
    for (const member of members) {
      await installation.env.DB.prepare(
        "INSERT INTO accounts (id, kind, slug, display_name) VALUES (?, 'user', ?, ?)",
      )
        .bind(member.accountId, member.accountId, member.accountId)
        .run();
    }
    await seedSpaceFixture(installation.env.DB, {
      organization: {
        id: `organization_${spaceId}`,
        slug: spaceId,
        displayName: spaceId,
        kind: "company",
      },
      space: { id: spaceId, slug: spaceId, displayName: spaceId },
      actorId: members[0]?.accountId ?? "test-fixture",
      members,
    });
    Reflect.set(installation.env, "TRACKER", {
      idFromName: fakeDurableObjectId,
    });
    const scope = await initializeFreshTrackerSpace(installation.env, state.ctx, spaceId);
    const space = await findSpaceById(installation.env.DB, spaceId);
    if (!space) throw new Error("Missing seeded Tracker Space");
    return {
      db: state.db,
      sql: state.ctx.storage.sql,
      transactionSync: <T>(fn: () => T): T => state.ctx.storage.transactionSync(fn),
      env: installation.env,
      ctx: state.ctx,
      scope,
      space,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Durable Object SQL storage's exec(), enough for TrackerStore. */
export function trackerSql(db: DatabaseSync): SqlDatabase {
  return {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      boundVariables(bindings);
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return {
          toArray: () => [] as T[],
          one: (): T => {
            throw new Error("DDL has no rows");
          },
        };
      }
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected exactly one SQL row");
          return rows[0]!;
        },
      };
    },
  };
}

/** ctx.storage.transactionSync over node:sqlite. */
export function transactional(db: DatabaseSync) {
  return <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}
