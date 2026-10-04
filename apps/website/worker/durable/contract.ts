// The purge contract every Durable Object class implements (CORE-197), and
// the helpers its methods share. Only types from the runtime: this module is
// loaded by plain unit tests too.
//
//   purge(reason)        now: cancel the alarm, release external resources
//                        (containers, multipart uploads), delete all storage.
//                        Idempotent, and it checks its own work: it throws
//                        unless no table, key or alarm is left.
//   retire(reason, name) later: the instance purges itself from its alarm
//                        once its in-flight work ends (or after RETIRE_MAX_WAIT_MS),
//                        and records that in the registry.
//   storageReport()      what the instance holds, for the registry's sizes.
//
// Callers never call these by hand-built stubs: worker/durable/registry.ts
// (`purgeInstance`, `retireInstance`) does, and records the outcome.

import { recordPurge } from "./record.ts";

export interface StorageReport {
  /** ctx.storage.sql.databaseSize: what the instance is billed for, in bytes. */
  bytes: number;
  /** Application tables in its SQLite database (not SQLite's or Cloudflare's own). */
  tables: string[];
  /** Keys left in its key-value storage. */
  keys: number;
  /** The pending alarm (ms since the epoch), if any. */
  alarm: number | null;
}

export interface PurgeReport extends StorageReport {
  reason: string;
  purgedAt: string;
}

/** The RPC surface the registry relies on; the conformance test checks every class has it. */
export interface Purgeable {
  purge(reason: string): Promise<PurgeReport>;
  retire(reason: string, name: string): Promise<void>;
  storageReport(): Promise<StorageReport>;
}

/** A retiring instance waits at most this long for in-flight work before purging anyway. */
export const RETIRE_MAX_WAIT_MS = 3 * 60 * 60_000;
const RETIRE_KEY = "gitmatrix:retire";

export interface Retirement {
  reason: string;
  name: string;
  /** When retire() was asked. */
  at: number;
}

/** What `storage` holds right now. */
export async function storageReport(storage: DurableObjectStorage): Promise<StorageReport> {
  // substr, not LIKE: `_` is LIKE's single-character wildcard. The local
  // runtime keeps an instance's name in `__miniflare_do_name` (development only).
  const tables = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_' AND substr(name, 1, 12) != '__miniflare_' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
  const keys = (await storage.list({ limit: 1000 })).size;
  return { bytes: storage.sql.databaseSize, tables, keys, alarm: await storage.getAlarm() };
}

/** True when nothing is left: no table, no key, no alarm. */
export function isEmpty(report: StorageReport): boolean {
  return report.tables.length === 0 && report.keys === 0 && report.alarm === null;
}

/**
 * Cancel the alarm, delete everything and confirm it: the end of every
 * class's purge(). Throws when anything survived, so a purge never reports
 * success over leftovers.
 */
export async function clearStorage(
  storage: DurableObjectStorage,
  reason: string,
): Promise<PurgeReport> {
  await storage.deleteAlarm();
  await storage.deleteAll();
  return confirmPurged(storage, reason);
}

/** The report of a purge already done (agents' destroy()), checked like clearStorage's. */
export async function confirmPurged(
  storage: DurableObjectStorage,
  reason: string,
): Promise<PurgeReport> {
  const report = await storageReport(storage);
  if (!isEmpty(report))
    throw new Error(
      `Purge left storage behind: tables ${report.tables.join(", ") || "none"}, ${report.keys} keys, alarm ${report.alarm ?? "none"}`,
    );
  return { ...report, reason, purgedAt: new Date().toISOString() };
}

/**
 * Drop the instance's memory once the current call has answered: its caches
 * and handles describe storage that no longer exists. The next call starts a
 * fresh instance. (agents' destroy() does the same for the assistant.)
 */
export function resetSoon(ctx: DurableObjectState): void {
  setTimeout(() => {
    try {
      ctx.abort("purged");
    } catch {
      // Already gone.
    }
  }, 0);
}

/** retire(): mark the instance and wake it shortly; its alarm does the rest. */
export async function scheduleRetirement(
  storage: DurableObjectStorage,
  reason: string,
  name: string,
  delayMs = 1_000,
): Promise<void> {
  const existing = await storage.get<Retirement>(RETIRE_KEY);
  if (!existing) await storage.put(RETIRE_KEY, { reason, name, at: Date.now() });
  const due = Date.now() + delayMs;
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > due) await storage.setAlarm(due);
}

export function pendingRetirement(storage: DurableObjectStorage): Promise<Retirement | undefined> {
  return storage.get<Retirement>(RETIRE_KEY);
}

/**
 * From alarm(), for a retiring instance: purge once `busy` is false (or the
 * wait is over) and record it in the registry; otherwise check back later.
 * `purge` clears without resetSoon(): an alarm invocation the runtime sees
 * aborted is retried, and the retry would build the instance up again.
 */
export async function settleRetirement(
  options: {
    storage: DurableObjectStorage;
    env: Env;
    className: string;
    retirement: Retirement;
    busy: boolean;
    purge: (reason: string) => Promise<PurgeReport>;
  },
  recheckMs = 60_000,
): Promise<"waiting" | "purged"> {
  const { storage, retirement } = options;
  if (options.busy && Date.now() - retirement.at < RETIRE_MAX_WAIT_MS) {
    await storage.setAlarm(Date.now() + recheckMs);
    return "waiting";
  }
  const report = await options.purge(retirement.reason);
  await recordPurge(options.env, options.className, retirement.name, report).catch((error) =>
    console.error("Durable: recording a retirement failed", options.className, error),
  );
  return "purged";
}
