import type {
  SpaceMigrationContext,
  SpaceParticipantOperation,
} from "../../shared/space-cutover.ts";

/** Storage fencing also protects a genuinely empty installation, without inventing a tenant. */
export type D1FenceContext = Pick<
  SpaceMigrationContext,
  "runId" | "migrationEpoch" | "manifestDigest"
>;

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** D1 serializes the final fence transaction after earlier database writers.
 * Installed triggers also reject writes from pre-preparation Worker versions.
 */
export async function fenceBusinessDatabase(
  db: D1Database,
  context: D1FenceContext,
  authorityToken: string,
  revokedAuthorityToken?: string,
): Promise<void> {
  const current = await db
    .prepare(
      "SELECT run_id,migration_epoch,manifest_digest,authority_token,fenced,bypass FROM _space_cutover_fence WHERE id=1",
    )
    .first<{
      run_id: string | null;
      migration_epoch: number | null;
      manifest_digest: string | null;
      fenced: number;
      bypass: number;
      authority_token: string;
    }>();
  if (
    !current ||
    current.bypass !== 0 ||
    (current.fenced &&
      current.authority_token !== authorityToken &&
      current.authority_token !== revokedAuthorityToken) ||
    (current.fenced &&
      (current.run_id !== context.runId ||
        current.migration_epoch !== context.migrationEpoch ||
        current.manifest_digest !== context.manifestDigest) &&
      // A newer run may take over a fence whose authority it revoked (it
      // superseded a restored run that changed no data); nothing else may.
      !(
        revokedAuthorityToken !== undefined &&
        current.authority_token === revokedAuthorityToken &&
        (current.migration_epoch ?? 0) < context.migrationEpoch
      ))
  )
    throw new Error("Independent D1 fence context mismatch");
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> '_space_cutover_fence' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  for (let offset = 0; offset < tables.length; offset += 16) {
    const statements: D1PreparedStatement[] = [];
    for (const { name } of tables.slice(offset, offset + 16))
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const trigger = identifier(`_space_cutover_write_${name}_${operation.toLowerCase()}`);
        statements.push(
          db.prepare(
            `CREATE TRIGGER IF NOT EXISTS ${trigger} BEFORE ${operation} ON ${identifier(name)} WHEN COALESCE((SELECT fenced=0 OR bypass=1 FROM _space_cutover_fence WHERE id=1),0)=0 BEGIN SELECT RAISE(ABORT,'space_cutover_fenced'); END`,
          ),
        );
      }
    await db.batch(statements);
  }
  const result = await db
    .prepare(
      "UPDATE _space_cutover_fence SET run_id=?,migration_epoch=?,manifest_digest=?,authority_token=?,fenced=1,bypass=0 WHERE id=1 AND authority_token=? AND run_id IS ? AND migration_epoch IS ? AND manifest_digest IS ? AND bypass=0",
    )
    .bind(
      context.runId,
      context.migrationEpoch,
      context.manifestDigest,
      authorityToken,
      current.authority_token,
      current.run_id,
      current.migration_epoch,
      current.manifest_digest,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new Error("Storage authority changed while installing its fence");
}

/** No unrelated request can observe bypass=1: it exists only INSIDE the same
 * atomic D1 batch as the authorized migration statements, then resets to zero.
 * The independent journal is rechecked for every mutating transaction.
 */
export function migrationDatabase<C extends D1FenceContext>(
  db: D1Database,
  context: C,
  operation: SpaceParticipantOperation,
  guard: (context: C, operation: SpaceParticipantOperation) => Promise<void>,
  authorityToken: string,
): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  async function execute<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    await guard(context, operation);
    const fence = await db
      .prepare(
        "SELECT run_id,migration_epoch,manifest_digest,fenced,bypass FROM _space_cutover_fence WHERE id=1",
      )
      .first<{
        run_id: string;
        migration_epoch: number;
        manifest_digest: string;
        fenced: number;
        bypass: number;
      }>();
    if (
      !fence ||
      fence.run_id !== context.runId ||
      fence.migration_epoch !== context.migrationEpoch ||
      fence.manifest_digest !== context.manifestDigest ||
      fence.fenced !== 1 ||
      fence.bypass !== 0
    )
      throw new Error("D1 migration fence is not closed");
    const result = await db.batch<T>([
      db
        .prepare(
          "UPDATE _space_cutover_fence SET bypass=CASE WHEN run_id=? AND migration_epoch=? AND manifest_digest=? AND authority_token=? AND fenced=1 AND bypass=0 THEN 1 ELSE NULL END WHERE id=1",
        )
        .bind(context.runId, context.migrationEpoch, context.manifestDigest, authorityToken),
      ...statements,
      db.prepare("UPDATE _space_cutover_fence SET bypass=0 WHERE id=1"),
    ]);
    return result.slice(1, -1);
  }
  function prepared(base: D1PreparedStatement, sql: string): D1PreparedStatement {
    const statement = new Proxy(base, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => prepared(target.bind(...values), sql);
        if (key === "run") return async <T>() => (await execute<T>([target]))[0]!;
        if (
          (key === "all" || key === "first" || key === "raw") &&
          !/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(sql)
        )
          throw new Error("Use atomic run/batch for migration writes");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(statement, base);
    return statement;
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => prepared(target.prepare(sql), sql);
      if (key === "batch")
        return async <T>(statements: D1PreparedStatement[]) =>
          execute<T>(
            statements.map((statement) => {
              const original = originals.get(statement);
              if (!original) throw new Error("Unowned migration statement");
              return original;
            }),
          );
      if (key === "exec" || key === "withSession")
        throw new Error("Migration writes require the atomic fenced batch interface");
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
