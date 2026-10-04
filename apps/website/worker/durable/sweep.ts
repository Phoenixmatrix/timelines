// The registry's hourly upkeep (CORE-197), bounded per run and resumable:
//
// 1. Backfill registry repositories (their rows live in REGISTRY_DB, which the
//    migration's backfill can't read), from a cursor.
// 2. Fill in owners the instance name alone doesn't give (a coordinator's or
//    sandbox's account, a registry repository's account).
// 3. Size instances used since they were last sized: each reports
//    ctx.storage.sql.databaseSize (never on a request path).
// 4. Forget self-cleaning instances (registry uploads and logins) a week after
//    their last use: their own alarms deleted them long before.
//
// It deletes no instance and no data other than those registry rows.

import { db, nowIso } from "../schema.ts";
import { DURABLE_CLASS_NAMES, durableClass, type DurableClass } from "./classes.ts";
import { recordSize } from "./record.ts";
import { instanceStorage } from "./registry.ts";

export const SWEEP_LIMITS = {
  /** Registry repositories registered per run. */
  backfill: 500,
  /** Rows whose owner is looked up per run, per kind. */
  owners: 500,
  /** Instances sized per run, and at once. */
  sizes: 100,
  sizeConcurrency: 8,
  /** Self-cleaning rows forgotten per run, and how long after last use. */
  forget: 1000,
  forgetAfterMs: 7 * 24 * 60 * 60_000,
};

const BACKFILL_CURSOR = "durable:registry-repos";
const REGISTRY_OWNER_CURSOR = "durable:registry-owners";

export interface DurableSweep {
  registered: number;
  owners: number;
  sized: number;
  failed: number;
  forgotten: number;
}

export async function sweepDurableInstances(
  env: Env,
  now = Date.now(),
  limits = SWEEP_LIMITS,
): Promise<DurableSweep> {
  const registered = await backfillRegistryRepos(env, limits.backfill);
  const owners = await fillOwners(env, limits.owners);
  const { sized, failed } = await refreshSizes(env, limits.sizes, limits.sizeConcurrency);
  const forgotten = await forgetSelfCleaned(
    env,
    new Date(now - limits.forgetAfterMs).toISOString(),
    limits.forget,
  );
  return { registered, owners, sized, failed, forgotten };
}

async function cursor(env: Env, name: string): Promise<string> {
  const row = await db(env.DB)
    .selectFrom("job_cursors")
    .select("cursor")
    .where("name", "=", name)
    .executeTakeFirst();
  return row?.cursor ?? "";
}

async function saveCursor(env: Env, name: string, value: string): Promise<void> {
  await db(env.DB)
    .insertInto("job_cursors")
    .values({ name, cursor: value, updated_at: nowIso() })
    .onConflict((oc) => oc.column("name").doUpdateSet({ cursor: value, updated_at: nowIso() }))
    .execute();
}

/** Register registry repositories past the cursor; new ones register on first use. */
async function backfillRegistryRepos(env: Env, limit: number): Promise<number> {
  const after = await cursor(env, BACKFILL_CURSOR);
  const { results } = await env.REGISTRY_DB.prepare(
    "SELECT id, owner_id, created_at FROM repositories WHERE id > ? ORDER BY id LIMIT ?",
  )
    .bind(after, limit)
    .all<{ id: string; owner_id: string; created_at: string }>();
  if (results.length === 0) return 0;
  await env.DB.batch(
    results.map((repo) =>
      env.DB.prepare(
        `INSERT INTO do_instances (class, name, account_id, created_at, last_active_at)
         VALUES ('RegistryRepo', ?1, ?2, ?3, ?3)
         ON CONFLICT (class, name) DO UPDATE SET account_id = COALESCE(do_instances.account_id, excluded.account_id)`,
      ).bind(repo.id, repo.owner_id, repo.created_at),
    ),
  );
  await saveCursor(env, BACKFILL_CURSOR, results.at(-1)!.id);
  return results.length;
}

/** Owners from the rows that name them. Bounded; rows nothing resolves are skipped. */
async function fillOwners(env: Env, limit: number): Promise<number> {
  const [sandboxes, byRepo] = await env.DB.batch([
    // A sandbox's repository, from its job.
    env.DB.prepare(
      `UPDATE do_instances SET repo_id = (SELECT repo_id FROM ci_jobs WHERE ci_jobs.id = do_instances.name)
       WHERE rowid IN (
         SELECT rowid FROM do_instances
         WHERE class = 'CiSandbox' AND repo_id IS NULL
           AND EXISTS (SELECT 1 FROM ci_jobs WHERE ci_jobs.id = do_instances.name)
         LIMIT ?1)`,
    ).bind(limit),
    // Anything with a repository: its account.
    env.DB.prepare(
      `UPDATE do_instances SET account_id = (SELECT owner_id FROM repos WHERE repos.id = do_instances.repo_id)
       WHERE rowid IN (
         SELECT rowid FROM do_instances
         WHERE account_id IS NULL AND repo_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM repos WHERE repos.id = do_instances.repo_id)
         LIMIT ?1)`,
    ).bind(limit),
  ]);
  const changed = (sandboxes?.meta.changes ?? 0) + (byRepo?.meta.changes ?? 0);
  return changed + (await fillRegistryOwners(env, limit));
}

/** Registry repositories' accounts, from REGISTRY_DB, walking a cursor over the names. */
async function fillRegistryOwners(env: Env, limit: number): Promise<number> {
  const after = await cursor(env, REGISTRY_OWNER_CURSOR);
  const rows = await db(env.DB)
    .selectFrom("do_instances")
    .select("name")
    .where("class", "=", "RegistryRepo")
    .where("account_id", "is", null)
    .where("name", ">", after)
    .orderBy("name")
    .limit(Math.min(limit, 100))
    .execute();
  // Back to the start next time: rows left unresolved get another look.
  const next = rows.length < Math.min(limit, 100) ? "" : rows.at(-1)!.name;
  if (rows.length === 0) {
    if (after) await saveCursor(env, REGISTRY_OWNER_CURSOR, "");
    return 0;
  }
  const names = rows.map((r) => r.name);
  const { results } = await env.REGISTRY_DB.prepare(
    `SELECT id, owner_id FROM repositories WHERE id IN (${names.map(() => "?").join(",")})`,
  )
    .bind(...names)
    .all<{ id: string; owner_id: string }>();
  if (results.length > 0)
    await env.DB.batch(
      results.map((repo) =>
        env.DB.prepare(
          "UPDATE do_instances SET account_id = ? WHERE class = 'RegistryRepo' AND name = ? AND account_id IS NULL",
        ).bind(repo.owner_id, repo.id),
      ),
    );
  await saveCursor(env, REGISTRY_OWNER_CURSOR, next);
  return results.length;
}

/** The classes worth sizing: they keep storage and live past their work. */
export const SIZED_CLASSES = DURABLE_CLASS_NAMES.filter((name) => {
  const info = durableClass(name);
  return !info?.selfCleaning && !info?.stateless;
});

/** Size live instances never sized, then those used since their last size. */
async function refreshSizes(
  env: Env,
  limit: number,
  concurrency: number,
): Promise<{ sized: number; failed: number }> {
  const rows = await db(env.DB)
    .selectFrom("do_instances")
    .select(["class", "name"])
    .where("purged_at", "is", null)
    .where("retiring_at", "is", null)
    .where("class", "in", SIZED_CLASSES)
    .where((eb) =>
      eb.or([eb("sized_at", "is", null), eb("sized_at", "<", eb.ref("last_active_at"))]),
    )
    .orderBy((eb) => eb("sized_at", "is not", null))
    .orderBy("last_active_at", "desc")
    .limit(limit)
    .execute();
  let sized = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += concurrency) {
    await Promise.all(
      rows.slice(i, i + concurrency).map(async (row) => {
        const cls = row.class as DurableClass;
        try {
          const report = await instanceStorage(env, cls, row.name);
          await recordSize(env, cls, row.name, report);
          sized++;
        } catch (error) {
          failed++;
          console.warn("Durable: sizing an instance failed", cls, row.name, error);
          // Marked sized anyway, so one broken instance can't hold up the rest;
          // its next use puts it back in line.
          await db(env.DB)
            .updateTable("do_instances")
            .set({ sized_at: nowIso() })
            .where("class", "=", cls)
            .where("name", "=", row.name)
            .execute()
            .catch(() => {});
        }
      }),
    );
  }
  return { sized, failed };
}

async function forgetSelfCleaned(env: Env, before: string, limit: number): Promise<number> {
  const selfCleaning = DURABLE_CLASS_NAMES.filter((name) => durableClass(name)?.selfCleaning);
  const result = await env.DB.prepare(
    `DELETE FROM do_instances WHERE rowid IN (
       SELECT rowid FROM do_instances
       WHERE class IN (${selfCleaning.map(() => "?").join(",")}) AND last_active_at < ?
       LIMIT ?)`,
  )
    .bind(...selfCleaning, before, limit)
    .run();
  return result.meta.changes ?? 0;
}
