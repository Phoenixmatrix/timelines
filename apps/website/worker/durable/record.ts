// The registry's D1 writes (do_instances), shared by the caller-side helper
// (registry.ts) and by instances recording their own retirement (contract.ts).

import { db, nowIso } from "../schema.ts";
import type { StorageReport } from "./contract.ts";
import { durableClass } from "./classes.ts";

/** Resolve metadata from its actual producer, never by equality of person and Space ids. */
export async function resolveDurableOwner(
  env: Env,
  className: string,
  name: string,
  hint?: { account?: string | null; repo?: string | null },
): Promise<{ space: string | null; account: string | null; repo: string | null }> {
  const derived = durableClass(className)?.owner(name);
  if (!derived) throw new Error(`Unknown durable class: ${className}`);
  if (className === "Tracker") {
    const space = await env.DB.prepare("SELECT id FROM spaces WHERE id = ?")
      .bind(derived.space)
      .first<{ id: string }>();
    return { space: space?.id ?? null, account: null, repo: null };
  }
  if (className === "Assistant") {
    const person = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND kind = 'user'")
      .bind(derived.account)
      .first<{ id: string }>();
    return { space: null, account: person?.id ?? null, repo: null };
  }
  const previous = await env.DB.prepare(
    "SELECT space_id, account_id, repo_id FROM do_instances WHERE class = ? AND name = ?",
  )
    .bind(className, name)
    .first<{ space_id: string | null; account_id: string | null; repo_id: string | null }>();
  if (className === "RegistryRepo") {
    const repository = await env.REGISTRY_DB.prepare(
      "SELECT space_id FROM repositories WHERE id = ?",
    )
      .bind(name)
      .first<{ space_id: string }>();
    const space = repository
      ? await env.DB.prepare("SELECT id FROM spaces WHERE id = ?")
          .bind(repository.space_id)
          .first<{ id: string }>()
      : null;
    return { space: space?.id ?? previous?.space_id ?? null, account: null, repo: null };
  }
  let repo = derived.repo;
  if (className === "CiSandbox") {
    // Jobs and verification runs both name sandboxes. A name is never a person id.
    const job = await env.DB.prepare(
      "SELECT repo_id FROM ci_jobs WHERE id = ?1 UNION ALL SELECT repo_id FROM ci_runs WHERE id = ?1 LIMIT 1",
    )
      .bind(name)
      .first<{ repo_id: string }>();
    repo = job?.repo_id ?? hint?.repo ?? previous?.repo_id ?? null;
  }
  if (repo) {
    const repository = await env.DB.prepare("SELECT space_id FROM repos WHERE id = ?")
      .bind(repo)
      .first<{ space_id: string }>();
    return { space: repository?.space_id ?? previous?.space_id ?? null, account: null, repo };
  }
  if (className === "KnowledgeCoordinator" || className === "StepFeed")
    return { space: previous?.space_id ?? null, account: null, repo };
  const account = hint?.account ?? previous?.account_id ?? null;
  const person = account
    ? await env.DB.prepare("SELECT id FROM accounts WHERE id = ?")
        .bind(account)
        .first<{ id: string }>()
    : null;
  return {
    space: previous?.space_id ?? null,
    account: previous?.space_id ? null : (person?.id ?? null),
    repo: null,
  };
}

/**
 * Record a use: insert the instance, or move its last activity on. Throttled
 * here too (rows touched since `freshAfter` are left alone), because every
 * isolate keeps its own memory of what it recorded. A use of a purged
 * instance brings it back: it holds storage again.
 */
export async function recordUse(
  d1: D1Database,
  row: {
    class: string;
    name: string;
    space: string | null;
    account: string | null;
    repo: string | null;
  },
  at: string,
  freshAfter: string,
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO do_instances (class, name, space_id, account_id, repo_id, created_at, last_active_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (class, name) DO UPDATE SET
         last_active_at = MAX(do_instances.last_active_at, excluded.last_active_at),
         space_id = excluded.space_id,
         account_id = excluded.account_id,
         repo_id = excluded.repo_id,
         purged_at = NULL,
         purge_reason = NULL
       WHERE do_instances.last_active_at < ?7
          OR do_instances.purged_at IS NOT NULL
          OR do_instances.space_id IS NOT excluded.space_id
          OR do_instances.account_id IS NOT excluded.account_id
          OR do_instances.repo_id IS NOT excluded.repo_id`,
    )
    .bind(row.class, row.name, row.space, row.account, row.repo, at, freshAfter)
    .run();
}

/** Record a purge (inserting the row if the instance was never registered). */
export async function recordPurge(
  env: Env,
  className: string,
  name: string,
  report: StorageReport & { reason: string; purgedAt: string },
): Promise<void> {
  const owner = await resolveDurableOwner(env, className, name);
  const values = {
    purged_at: report.purgedAt,
    purge_reason: report.reason,
    retiring_at: null,
    storage_bytes: report.bytes,
    sized_at: report.purgedAt,
  };
  await db(env.DB)
    .insertInto("do_instances")
    .values({
      class: className,
      name,
      space_id: owner.space,
      account_id: owner.account,
      repo_id: owner.repo,
      ...values,
    })
    .onConflict((oc) =>
      oc.columns(["class", "name"]).doUpdateSet({
        ...values,
        space_id: owner.space,
        account_id: owner.account,
        repo_id: owner.repo,
      }),
    )
    .execute();
}

/** Record that an instance was asked to retire. */
export async function recordRetiring(env: Env, className: string, name: string): Promise<void> {
  const owner = await resolveDurableOwner(env, className, name);
  const at = nowIso();
  await db(env.DB)
    .insertInto("do_instances")
    .values({
      class: className,
      name,
      space_id: owner.space,
      account_id: owner.account,
      repo_id: owner.repo,
      retiring_at: at,
    })
    .onConflict((oc) =>
      oc
        .columns(["class", "name"])
        .doUpdateSet({
          retiring_at: at,
          space_id: owner.space,
          account_id: owner.account,
          repo_id: owner.repo,
        })
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
