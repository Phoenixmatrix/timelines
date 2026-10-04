// The registry's D1 writes (do_instances), shared by the caller-side helper
// (registry.ts) and by instances recording their own retirement (contract.ts).

import { db, nowIso } from "../schema.ts";
import type { StorageReport } from "./contract.ts";

/**
 * Record a use: insert the instance, or move its last activity on. Throttled
 * here too (rows touched since `freshAfter` are left alone), because every
 * isolate keeps its own memory of what it recorded. A use of a purged
 * instance brings it back: it holds storage again.
 */
export async function recordUse(
  d1: D1Database,
  row: { class: string; name: string; account: string | null; repo: string | null },
  at: string,
  freshAfter: string,
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO do_instances (class, name, account_id, repo_id, created_at, last_active_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (class, name) DO UPDATE SET
         last_active_at = excluded.last_active_at,
         account_id = COALESCE(do_instances.account_id, excluded.account_id),
         repo_id = COALESCE(do_instances.repo_id, excluded.repo_id),
         purged_at = NULL,
         purge_reason = NULL
       WHERE do_instances.last_active_at < ?6
          OR do_instances.purged_at IS NOT NULL
          OR (do_instances.account_id IS NULL AND excluded.account_id IS NOT NULL)
          OR (do_instances.repo_id IS NULL AND excluded.repo_id IS NOT NULL)`,
    )
    .bind(row.class, row.name, row.account, row.repo, at, freshAfter)
    .run();
}

/** Record a purge (inserting the row if the instance was never registered). */
export async function recordPurge(
  env: Env,
  className: string,
  name: string,
  report: StorageReport & { reason: string; purgedAt: string },
): Promise<void> {
  const values = {
    purged_at: report.purgedAt,
    purge_reason: report.reason,
    retiring_at: null,
    storage_bytes: report.bytes,
    sized_at: report.purgedAt,
  };
  await db(env.DB)
    .insertInto("do_instances")
    .values({ class: className, name, account_id: null, repo_id: null, ...values })
    .onConflict((oc) => oc.columns(["class", "name"]).doUpdateSet(values))
    .execute();
}

/** Record that an instance was asked to retire. */
export async function recordRetiring(env: Env, className: string, name: string): Promise<void> {
  const at = nowIso();
  await db(env.DB)
    .insertInto("do_instances")
    .values({ class: className, name, account_id: null, repo_id: null, retiring_at: at })
    .onConflict((oc) =>
      oc
        .columns(["class", "name"])
        .doUpdateSet({ retiring_at: at })
        .where("do_instances.purged_at", "is", null),
    )
    .execute();
}

/** Record what an instance reported holding. */
export async function recordSize(
  env: Env,
  className: string,
  name: string,
  report: StorageReport,
): Promise<void> {
  await db(env.DB)
    .updateTable("do_instances")
    .set({ storage_bytes: report.bytes, sized_at: nowIso() })
    .where("class", "=", className)
    .where("name", "=", name)
    .execute();
}
