import { beforeEach, describe, expect, it } from "vite-plus/test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeD1 } from "@gitmatrix/testing";

import type {
  SpaceCheckpointPage,
  SpaceMigrationContext,
  SpaceParticipantGuard,
  SpaceParticipantInventory,
  SpaceParticipantOperation,
} from "../../shared/space-cutover.ts";
import { createDb } from "./db.ts";
import { seal, unseal } from "./seal.ts";
import {
  createRegistrySpaceMigration,
  inspectD1SpaceCheckpointStep,
  type D1InspectionState,
  type D1InventoryState,
  type D1RestoreState,
  type RegistryMigrationState,
  type RegistryReconcileState,
  type SpaceCheckpointReader,
  type SpaceMigrationStep,
} from "./space-migration.ts";
import {
  fenceBusinessDatabase,
  migrationDatabase,
} from "../../worker/space-cutover/storage-fence.ts";

const OWNER_ID = "acc_test";

function legacyDatabase(relative: string): FakeD1 {
  const database = new FakeD1();
  const directory = fileURLToPath(new URL(relative, import.meta.url).href);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    database.applySql(readFileSync(`${directory}/${file}`, "utf8"));
  return database;
}

/** Migration evidence is seeded in the real legacy schema, never through the v4 publisher. */
function makeLegacyFixture() {
  const application = legacyDatabase("../../migrations/");
  const registry = legacyDatabase("../migrations/");
  application.applySql(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES
      ('acc_test','org','test','Test'),('person','user','person','Person'),
      ('resource-only','user','resource-only','Collaborator'),('acc_outside','user','outside','Outside');
    INSERT INTO org_members(org_id,user_id,role) VALUES('acc_test','person','owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('legacy-source','acc_test','source','private','opaque-source','https://example.invalid/source.git');
    INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('legacy-source','resource-only','read');
    INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,actor_id,status)
      VALUES('legacy-run','legacy-source',1,'original-commit','feature/provenance','push','person','running');
    INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner)
      VALUES('legacy-job','legacy-run','legacy-source','publish','{}','running','local');
    INSERT INTO ci_job_tokens(token_hash,job_id,expires_at)
      VALUES('original-job-token-hash','legacy-job','2099-01-01T00:00:00.000Z');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
      VALUES('personal-token','person','Original personal credential','write','original-person-token-hash','inal');
  `);
  registry.applySql(`
    INSERT INTO repositories(id,key,format,owner_id,kind,visibility,created_by,created_at,updated_at)
      VALUES('legacy-feed','test','generic','acc_test','local','private','person','2026-01-01','2026-01-01');
    INSERT INTO packages(id,repo_id,name,normalized_name,created_at,updated_at)
      VALUES('legacy-package','legacy-feed','library','library','2026-01-01','2026-01-01');
    INSERT INTO versions(id,package_id,version,published_by,created_at)
      VALUES('legacy-version','legacy-package','1.0.0','job:legacy-job','2026-01-01');
    INSERT INTO blobs(digest,r2_key,size,created_at)
      VALUES('original-digest','opaque-artifact-key',21,'2026-01-01');
    INSERT INTO files(id,repo_id,path,version_id,digest,size,created_by,created_at)
      VALUES('legacy-file','legacy-feed','library/1.0.0/file.bin','legacy-version','original-digest',21,'job:legacy-job','2026-01-01');
    INSERT INTO package_sources(package_id,git_repo_id,granted_by,granted_at)
      VALUES('legacy-package','legacy-source','person','2026-01-01');
    INSERT INTO publishes(id,feed_id,format,package_id,version,digest,size,action,git_repo_id,commit_oid,ref,ci_run_id,ci_job_id,run_number,actor,actor_label,via,at)
      VALUES('legacy-publish','legacy-feed','generic','legacy-package','1.0.0','original-digest',21,'publish','legacy-source','original-commit','feature/provenance','legacy-run','legacy-job',1,'job:legacy-job','Publish job','job-token','2026-01-01');
  `);
  const env = {
    DB: application,
    REGISTRY_DB: registry,
    REGISTRY_KEK: btoa("k".repeat(32)),
  } as unknown as Env;
  return { env, db: registry, rawRegistry: env.REGISTRY_DB };
}

const context: SpaceMigrationContext = {
  runId: "registry-cutover-test",
  migrationEpoch: 7,
  manifestDigest: "approved-test-mapping",
  legacyOwnerId: OWNER_ID,
  spaceId: OWNER_ID,
  organizationId: "organization-test",
  spaceSlug: "test",
  contractVersion: 4,
};
interface QueryBudget {
  queries: number;
  maximum: number;
  maximumSql: number;
}

/** Real D1 platform restrictions that the SQLite test double does not impose. */
function limitedDatabase(db: D1Database, budget: QueryBudget): D1Database {
  const charge = () => {
    budget.queries++;
    budget.maximum = Math.max(budget.maximum, budget.queries);
    if (budget.queries > 100) throw new Error("per-step D1 query budget exceeded");
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first")
          return (column?: string) => {
            charge();
            return column === undefined ? target.first() : target.first(column);
          };
        if (key === "all")
          return () => {
            charge();
            return target.all();
          };
        if (key === "run")
          return () => {
            charge();
            return target.run();
          };
        return Reflect.get(target, key, target);
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const bytes = new TextEncoder().encode(sql).byteLength;
          budget.maximumSql = Math.max(budget.maximumSql, bytes);
          if (bytes > 100_000) throw new Error("D1 SQL statement exceeds 100KB");
          return wrap(target.prepare(sql));
        };
      // FakeD1 executes each statement's all(), so wrapped statements charge
      // every query in a batch rather than treating a batch as one query.
      if (key === "batch") return (statements: D1PreparedStatement[]) => target.batch(statements);
      return Reflect.get(target, key, target);
    },
  });
}
function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function readerFor(pages: readonly SpaceCheckpointPage[]): SpaceCheckpointReader {
  const byCursor = new Map(pages.map((page) => [page.cursor, page]));
  return async (cursor) => {
    const page = byCursor.get(cursor);
    if (!page) throw new Error("space_registry_checkpoint_invalid");
    return page;
  };
}

describe("independent registry Space migration participant", () => {
  let h: ReturnType<typeof makeLegacyFixture>;
  let appDb: D1Database;
  let registryDb: D1Database;
  let guard: SpaceParticipantGuard;
  let budget: QueryBudget;
  let admitted: boolean;
  let failAt: SpaceParticipantOperation | null;
  let feedId: string;
  let sourceId: string;
  let signingCiphertext: string;
  let upstreamCiphertext: string;

  beforeEach(async () => {
    h = makeLegacyFixture();
    admitted = false;
    failAt = null;
    sourceId = "legacy-source";
    feedId = "legacy-feed";
    await h.env.DB.batch([
      h.env.DB.prepare(
        "INSERT INTO organizations(id,slug,display_name,kind,default_space_id) VALUES(?,?,?,?,?)",
      ).bind(context.organizationId, "test", "Test", "company", OWNER_ID),
      h.env.DB.prepare(
        "INSERT INTO spaces(id,organization_id,slug,display_name) VALUES(?,?,?,?)",
      ).bind(OWNER_ID, context.organizationId, "test", "General"),
    ]);
    signingCiphertext = await seal(h.env, "signing-key-fixture");
    upstreamCiphertext = await seal(h.env, "upstream-secret-fixture");
    await h.env.REGISTRY_DB.prepare(
      "INSERT INTO signing_keys(repo_id,algorithm,fingerprint,public_key,private_key_sealed,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        feedId,
        "rsa",
        "stable-fingerprint",
        "public-fixture",
        signingCiphertext,
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    await h.env.REGISTRY_DB.prepare("UPDATE repositories SET config=? WHERE id=?")
      .bind(
        JSON.stringify({
          upstream: "https://upstream.invalid",
          password_sealed: upstreamCiphertext,
        }),
        feedId,
      )
      .run();
    guard = async (candidate, operation) => {
      if (
        candidate.runId !== context.runId ||
        candidate.migrationEpoch !== context.migrationEpoch ||
        candidate.manifestDigest !== context.manifestDigest ||
        candidate.contractVersion !== 4
      )
        throw new Error("control_context_mismatch");
      if (admitted && operation === "restore") throw new Error("control_forward_recovery_only");
      if (operation === failAt) throw new Error("control_interruption");
    };
    await fenceBusinessDatabase(h.rawRegistry, context, "registry-migration-fixture");
    budget = { queries: 0, maximum: 0, maximumSql: 0 };
    h.env.REGISTRY_DB = migrationDatabase(
      limitedDatabase(h.rawRegistry, budget),
      context,
      "migrate",
      guard,
      "registry-migration-fixture",
    );
    appDb = limitedDatabase(h.env.DB, budget);
    registryDb = h.env.REGISTRY_DB;
  });

  // Each test advance recreates the participant and serializes progress exactly
  // as separate controller requests do. There is no hidden in-memory cursor.
  const participant = () => createRegistrySpaceMigration(appDb, registryDb, guard);
  async function advance<S, R>(
    run: () => Promise<SpaceMigrationStep<S, R>>,
  ): Promise<SpaceMigrationStep<S, R>> {
    budget.queries = 0;
    const step = await run();
    expect(budget.queries).toBeLessThanOrEqual(100);
    return { ...step, state: roundtrip(step.state) };
  }
  async function checkpoint(candidate = context) {
    let state: D1InventoryState | null = null;
    const pages: SpaceCheckpointPage[] = [];
    for (let count = 0; count < 20_000; count++) {
      const step = await advance(() => participant().inventoryStep(candidate, state));
      state = step.state;
      if (step.page) {
        expect(new TextEncoder().encode(step.page.payload).byteLength).toBeLessThanOrEqual(
          512 * 1024,
        );
        pages.push(step.page);
      }
      if (step.done) {
        const replay = await advance(() => participant().inventoryStep(candidate, state));
        expect(replay.done && replay.result).toEqual(step.result);
        return { pages, inventory: step.result };
      }
    }
    throw new Error("inventory did not complete");
  }
  async function migrate(baseline: SpaceParticipantInventory, candidate = context) {
    let state: RegistryMigrationState | null = null;
    for (let count = 0; count < 20_000; count++) {
      const step = await advance(() => participant().migrateStep(candidate, state, baseline));
      state = step.state;
      if (step.done) return state;
    }
    throw new Error("migration did not complete");
  }
  async function reconcile(baseline: SpaceParticipantInventory, candidate = context) {
    let state: RegistryReconcileState | null = null;
    for (let count = 0; count < 20_000; count++) {
      const step = await advance(() =>
        participant().reconcileStep(candidate, [candidate], state, baseline),
      );
      state = step.state;
      if (step.done) return step.result;
    }
    throw new Error("reconciliation did not complete");
  }
  async function restore(
    readPage: SpaceCheckpointReader,
    candidate = context,
    initial: D1RestoreState | null = null,
  ) {
    let state = initial;
    for (let count = 0; count < 20_000; count++) {
      const step = await advance(() => participant().restoreStep(candidate, readPage, state));
      state = step.state;
      if (step.done) return step.result;
    }
    throw new Error("restoration did not complete");
  }
  async function inspect(readPage: SpaceCheckpointReader) {
    let state: D1InspectionState | null = null;
    for (let count = 0; count < 20_000; count++) {
      const step = await inspectD1SpaceCheckpointStep(context, "registry", readPage, state);
      state = roundtrip(step.state);
      if (step.done) return step.result;
    }
    throw new Error("inspection did not complete");
  }

  it("preserves exact identities, provenance, visibility, source rights, ciphertext and person credentials", async () => {
    const db = createDb(h.env.REGISTRY_DB);
    const publishes = await db.selectFrom("publishes").selectAll().execute();
    const sources = await db.selectFrom("package_sources").selectAll().execute();
    const blobs = await db.selectFrom("blobs").selectAll().execute();
    const credentials = (
      await h.env.DB.prepare("SELECT * FROM ci_job_tokens ORDER BY token_hash").all()
    ).results;
    const collaborators = (
      await h.env.DB.prepare("SELECT * FROM repo_collaborators ORDER BY repo_id,user_id").all()
    ).results;
    const before = await checkpoint();
    await migrate(before.inventory);
    await migrate(before.inventory);
    const preserved = await reconcile(before.inventory);
    expect(preserved).toEqual({ ...before.inventory, preserved: true });
    // The ordinary changed-state digest must differ; the coordinator compares
    // the normalized preservation digest above with the original checkpoint.
    expect((await checkpoint()).inventory.digest).not.toBe(before.inventory.digest);
    expect(
      await h.env.REGISTRY_DB.prepare(
        "SELECT id,owner_id,space_id,key,visibility FROM repositories WHERE id=?",
      )
        .bind(feedId)
        .first(),
    ).toEqual({
      id: feedId,
      owner_id: OWNER_ID,
      space_id: OWNER_ID,
      key: "test",
      visibility: "private",
    });
    expect(await db.selectFrom("publishes").selectAll().execute()).toEqual(publishes);
    expect(await db.selectFrom("package_sources").selectAll().execute()).toEqual(sources);
    expect(await db.selectFrom("blobs").selectAll().execute()).toEqual(blobs);
    expect(
      (await h.env.DB.prepare("SELECT * FROM ci_job_tokens ORDER BY token_hash").all()).results,
    ).toEqual(credentials);
    expect(
      (await h.env.DB.prepare("SELECT * FROM repo_collaborators ORDER BY repo_id,user_id").all())
        .results,
    ).toEqual(collaborators);
    expect(
      (await h.env.DB.prepare("SELECT count(*) AS n FROM space_grants").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await db.selectFrom("signing_keys").select("private_key_sealed").executeTakeFirstOrThrow())
        .private_key_sealed,
    ).toBe(signingCiphertext);
    expect(await unseal(h.env, signingCiphertext)).toBe("signing-key-fixture");
    expect((await restore(readerFor(before.pages))).digest).toBe(before.inventory.digest);
    expect(
      (
        await db
          .selectFrom("repositories")
          .select("config")
          .where("id", "=", feedId)
          .executeTakeFirstOrThrow()
      ).config,
    ).toContain(upstreamCiphertext);
    expect(
      (
        await db
          .selectFrom("repositories")
          .select("space_id")
          .where("id", "=", feedId)
          .executeTakeFirstOrThrow()
      ).space_id,
    ).toBeNull();
  });

  it("resumes after committed conversion and interrupted reconciliation without duplicating receipts", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    failAt = "reconcile";
    await expect(reconcile(before.inventory)).rejects.toThrow("control_interruption");
    failAt = null;
    await migrate(before.inventory);
    expect((await reconcile(before.inventory)).preserved).toBe(true);
    expect(
      (
        await h.env.REGISTRY_DB.prepare(
          "SELECT count(*) AS n FROM registry_space_migrations",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("resumes persisted restoration after triggers are removed and an invocation is interrupted", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    const readPage = readerFor(before.pages);
    let state: D1RestoreState | null = null;
    while (state?.phase !== "delete") {
      const step = await advance(() => participant().restoreStep(context, readPage, state));
      state = step.state;
    }
    failAt = "restore";
    await expect(
      advance(() => participant().restoreStep(context, readPage, state)),
    ).rejects.toThrow("control_interruption");
    failAt = null;
    expect((await restore(readPage, context, state)).digest).toBe(before.inventory.digest);
    expect((await h.env.REGISTRY_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("replays a committed restore block when its journal progress was not saved", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    const readPage = readerFor(before.pages);
    let state: D1RestoreState | null = null;
    while (true) {
      const step = await advance(() => participant().restoreStep(context, readPage, state));
      state = step.state;
      if (state.phase === "insert" && state.ordered[state.index]?.name === "repositories") break;
    }
    const unsaved = roundtrip(state);
    await advance(() => participant().restoreStep(context, readPage, unsaved));
    const replay = await advance(() => participant().restoreStep(context, readPage, unsaved));
    expect((await restore(readPage, context, replay.state)).digest).toBe(before.inventory.digest);
  });

  it("rejects cross-Space source repositories before recording an ownership receipt", async () => {
    const before = await checkpoint();
    await h.env.DB.prepare("UPDATE repos SET owner_id='acc_outside' WHERE id=?")
      .bind(sourceId)
      .run();
    await expect(migrate(before.inventory)).rejects.toThrow("space_registry_cross_space_source");
    expect(
      (
        await h.env.REGISTRY_DB.prepare(
          "SELECT count(*) AS n FROM registry_space_migrations",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("rejects missing or colliding target mappings without changing registry bytes", async () => {
    const before = await checkpoint();
    await expect(
      migrate(before.inventory, { ...context, organizationId: "unapproved" }),
    ).rejects.toThrow("space_registry_mapping_invalid");
    await expect(
      migrate(before.inventory, { ...context, spaceId: "another-space" }),
    ).rejects.toThrow("space_registry_mapping_invalid");
    await expect(migrate(before.inventory, { ...context, spaceSlug: "renamed" })).rejects.toThrow(
      "space_registry_mapping_invalid",
    );
    expect((await checkpoint()).inventory.digest).toBe(before.inventory.digest);
  });

  it("keeps partial ownership and altered sealed bytes unreconciled", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    await h.env.REGISTRY_DB.prepare("UPDATE repositories SET space_id=NULL WHERE id=?")
      .bind(feedId)
      .run();
    await expect(reconcile(before.inventory)).rejects.toThrow(
      "space_registry_migration_incomplete",
    );
    await h.env.REGISTRY_DB.prepare("UPDATE repositories SET space_id=? WHERE id=?")
      .bind(OWNER_ID, feedId)
      .run();
    await h.env.REGISTRY_DB.prepare(
      "UPDATE signing_keys SET private_key_sealed='changed' WHERE repo_id=?",
    )
      .bind(feedId)
      .run();
    await expect(reconcile(before.inventory)).rejects.toThrow(
      "space_registry_preservation_mismatch",
    );
    expect((await restore(readerFor(before.pages))).preserved).toBe(true);
  });

  it("rejects mismatched context, mismatched persisted progress and post-admission restoration", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    await expect(
      migrate(before.inventory, { ...context, manifestDigest: "different" }),
    ).rejects.toThrow("control_context_mismatch");
    await expect(
      restore(readerFor(before.pages), { ...context, migrationEpoch: 8 }),
    ).rejects.toThrow("control_context_mismatch");
    const step = await advance(() => participant().migrateStep(context, null, before.inventory));
    await expect(
      advance(() =>
        participant().migrateStep(context, step.state, { ...before.inventory, digest: "other" }),
      ),
    ).rejects.toThrow("space_registry_checkpoint_invalid");
    admitted = true;
    const changed = await checkpoint();
    await expect(restore(readerFor(before.pages))).rejects.toThrow("control_forward_recovery_only");
    expect((await checkpoint()).inventory.digest).toBe(changed.inventory.digest);
  });

  it("rejects incomplete, reordered and tampered archive pages before deleting data", async () => {
    const before = await checkpoint();
    await migrate(before.inventory);
    const changed = await checkpoint();
    await expect(restore(readerFor(before.pages.slice(0, -1)))).rejects.toThrow(
      "space_registry_checkpoint_invalid",
    );
    const readPage = readerFor(before.pages);
    await expect(
      restore(async (cursor) => (cursor === null ? before.pages[1]! : readPage(cursor))),
    ).rejects.toThrow("space_registry_checkpoint_invalid");
    await expect(
      restore(
        readerFor([
          { ...before.pages[0]!, payload: before.pages[0]!.payload + " " },
          ...before.pages.slice(1),
        ]),
      ),
    ).rejects.toThrow("space_registry_checkpoint_invalid");
    expect((await checkpoint()).inventory.digest).toBe(changed.inventory.digest);
  });

  it("binds large TEXT/BLOB values, embedded NUL and wide integers below the real D1 SQL limit", async () => {
    h.db.applySql(
      "CREATE TABLE checkpoint_bytes(id INTEGER PRIMARY KEY, value BLOB, text_value TEXT, wide INTEGER)",
    );
    const columns = Array.from({ length: 100 }, (_, index) => `c${index}`);
    h.db.applySql(
      `CREATE TABLE checkpoint_wide(${columns.map((name) => `${name} TEXT`).join(",")})`,
    );
    await h.env.REGISTRY_DB.prepare(
      `INSERT INTO checkpoint_wide VALUES(${columns.map(() => "?").join(",")})`,
    )
      .bind(...columns)
      .run();
    const bytes = new Uint8Array(100_000).fill(255);
    await h.env.REGISTRY_DB.prepare(
      "INSERT INTO checkpoint_bytes VALUES(1,?,?,9223372036854775807)",
    )
      .bind(bytes.buffer, "before\u0000after" + "x".repeat(90_000))
      .run();
    const before = await checkpoint();
    await migrate(before.inventory);
    await h.env.REGISTRY_DB.prepare("DELETE FROM checkpoint_bytes").run();
    expect((await restore(readerFor(before.pages))).digest).toBe(before.inventory.digest);
    const restored = await h.env.REGISTRY_DB.prepare(
      "SELECT length(value) AS size,hex(substr(value,1,4)) AS prefix,hex(substr(CAST(text_value AS BLOB),1,12)) AS text_prefix,quote(wide) AS wide FROM checkpoint_bytes",
    ).first<{ size: number; prefix: string; text_prefix: string; wide: string }>();
    expect(restored).toEqual({
      size: 100_000,
      prefix: "FFFFFFFF",
      text_prefix: "6265666F7265006166746572",
      wide: "9223372036854775807",
    });
    expect(await h.env.REGISTRY_DB.prepare("SELECT c0,c99 FROM checkpoint_wide").first()).toEqual({
      c0: "c0",
      c99: "c99",
    });
    expect(budget.maximumSql).toBeLessThan(100_000);
  });

  it("advances inventory, reconciliation and restore over 4000 rows below the per-invocation query limit", async () => {
    h.db.applySql(
      "CREATE TABLE checkpoint_many(id INTEGER PRIMARY KEY, value TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4100) INSERT INTO checkpoint_many SELECT x,'row-' || x FROM n",
    );
    const before = await checkpoint();
    expect(before.inventory.counts.checkpoint_many).toBe(4100);
    await migrate(before.inventory);
    expect((await reconcile(before.inventory)).digest).toBe(before.inventory.digest);
    await h.env.REGISTRY_DB.prepare("DELETE FROM checkpoint_many WHERE id%2=0").run();
    expect((await restore(readerFor(before.pages))).digest).toBe(before.inventory.digest);
    expect(budget.maximum).toBeLessThanOrEqual(100);
  }, 120_000);

  it("preserves declared Git oids and physical rowids through independently shadowed aliases", async () => {
    await h.env.REGISTRY_DB.prepare(
      "INSERT INTO brew_git_objects(_rowid_,repo_id,oid,type,size,seq,data) VALUES(37,?,?,'blob',4,99,?)",
    )
      .bind(feedId, "opaque-git-object-id", "YWJjZA==")
      .run();
    h.db.applySql(`CREATE TABLE checkpoint_shadow("_ROWID_" TEXT, rowid TEXT, payload TEXT);
      INSERT INTO checkpoint_shadow(oid,"_ROWID_",rowid,payload)
      VALUES(83,'declared-internal-id','declared-row-id','stable-payload')`);
    const before = await checkpoint();
    const archive = await inspect(readerFor(before.pages));
    expect(archive.schema.tables.find((table) => table.name === "brew_git_objects")?.keys).toEqual([
      "_rowid_",
    ]);
    expect(archive.schema.tables.find((table) => table.name === "checkpoint_shadow")?.keys).toEqual(
      ["oid"],
    );
    await migrate(before.inventory);
    await h.env.REGISTRY_DB.prepare("DELETE FROM brew_git_objects").run();
    await h.env.REGISTRY_DB.prepare("DELETE FROM checkpoint_shadow").run();
    expect((await restore(readerFor(before.pages))).digest).toBe(before.inventory.digest);
    expect(
      await h.env.REGISTRY_DB.prepare(
        "SELECT _rowid_ AS physical,oid,seq,data FROM brew_git_objects WHERE repo_id=?",
      )
        .bind(feedId)
        .first(),
    ).toEqual({ physical: 37, oid: "opaque-git-object-id", seq: 99, data: "YWJjZA==" });
    expect(
      await h.env.REGISTRY_DB.prepare(
        'SELECT oid AS physical,"_ROWID_" AS declared_internal,rowid AS declared_rowid,payload FROM checkpoint_shadow',
      ).first(),
    ).toEqual({
      physical: 83,
      declared_internal: "declared-internal-id",
      declared_rowid: "declared-row-id",
      payload: "stable-payload",
    });
  });

  it("fails closed when every hidden rowid alias is shadowed", async () => {
    h.db.applySql("CREATE TABLE checkpoint_inaccessible_rowid(oid TEXT,rowid TEXT,_rowid_ TEXT)");
    await expect(checkpoint()).rejects.toThrow("space_registry_checkpoint_invalid");
    expect(
      (
        await h.env.REGISTRY_DB.prepare(
          "SELECT count(*) AS n FROM registry_space_migrations",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("never snapshots, restores or removes the independent storage admission fence", async () => {
    const before = await checkpoint();
    const archive = await inspect(readerFor(before.pages));
    expect(archive.schema.tables.some((table) => table.name === "_space_cutover_fence")).toBe(
      false,
    );
    expect(
      archive.schema.schema.some((entry) => entry.name.startsWith("_space_cutover_write_")),
    ).toBe(false);
    await migrate(before.inventory);
    await h.rawRegistry
      .prepare(
        "UPDATE _space_cutover_fence SET run_id=?,migration_epoch=?,manifest_digest=?,fenced=1,authority_token='restore-authority' WHERE id=1",
      )
      .bind(context.runId, context.migrationEpoch, context.manifestDigest)
      .run();
    h.env.REGISTRY_DB = migrationDatabase(
      limitedDatabase(h.rawRegistry, budget),
      context,
      "restore",
      guard,
      "restore-authority",
    );
    registryDb = h.env.REGISTRY_DB;
    expect((await restore(readerFor(before.pages))).preserved).toBe(true);
    expect(
      await h.env.REGISTRY_DB.prepare(
        "SELECT run_id,migration_epoch,manifest_digest,fenced,bypass,authority_token FROM _space_cutover_fence WHERE id=1",
      ).first(),
    ).toEqual({
      run_id: context.runId,
      migration_epoch: context.migrationEpoch,
      manifest_digest: context.manifestDigest,
      fenced: 1,
      bypass: 0,
      authority_token: "restore-authority",
    });
    await expect(
      h.rawRegistry
        .prepare("UPDATE repositories SET description='stale write' WHERE id=?")
        .bind(feedId)
        .run(),
    ).rejects.toThrow("space_cutover_fenced");
  });
});
