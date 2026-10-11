import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  hostId,
  listReservations,
  readEnvironmentLimits,
  releaseListedReservation,
} from "./quota.ts";
import type { ListedReservation, QuotaReservation } from "./quota.ts";

// Imports only quota.ts and builtins: the hourly janitors copy this file.
const registry = join(homedir(), ".local", "state", "gitmatrix-agent");

/**
 * - `live`: a journal on this machine still holds it. Never released here.
 * - `released-locally`: its journal recorded an acknowledged release, yet the row
 *   remains. Safe to release again.
 * - `own-orphan`: reserved by this machine (its host id), with no journal left.
 * - `expired-foreign`: a `foreign` row whose expiry is more than EXPIRED_GRACE_MS
 *   past. Released only on explicit request (`--release --expired`), never by sweeps.
 * - `foreign`: another machine's, or a row without a host (legacy rows and hosted
 *   children). Listed only: this machine cannot know whether it is live.
 */
export type ReservationClass =
  | "live"
  | "released-locally"
  | "own-orphan"
  | "expired-foreign"
  | "foreign";

/**
 * How long past its expiry an unjournaled row must be before `--expired` may
 * release it. A row's expiry already marks the end of its environment's 24-hour
 * lifetime; this is one more day for its owning machine's hourly janitor.
 */
export const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

export interface JournalView {
  /** Ids a journal here holds: unreleased local, remote parent and hosted child journals. */
  live: Set<string>;
  /** Ids whose journal recorded a release, with the authority that acknowledged it. */
  released: Map<string, string>;
}

function note(view: JournalView, id: string, quota: QuotaReservation | undefined): void {
  // Anything not acknowledged as released, including legacy journals without
  // quota metadata, is live. Live wins over a released copy elsewhere.
  if (quota?.state === "released" && typeof quota.authority === "string") {
    if (!view.live.has(id)) view.released.set(id, quota.authority);
  } else {
    view.live.add(id);
    view.released.delete(id);
  }
}

async function journals(directory: string): Promise<unknown[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const values: unknown[] = [];
  // Any unreadable journal aborts reconciliation: a skipped live journal would
  // turn its reservation into an apparent orphan.
  for (const name of names.filter((name) => name.endsWith(".json")))
    values.push(JSON.parse(await readFile(join(directory, name), "utf8")));
  return values;
}

function record(value: unknown): { id: string; quota?: QuotaReservation; resources?: unknown } {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
    throw new Error("Unreadable ownership journal; refusing to reconcile reservations.");
  return value as { id: string; quota?: QuotaReservation };
}

/** Every local, remote parent and hosted child journal on this machine. */
export async function readJournals(root = registry): Promise<JournalView> {
  const view: JournalView = { live: new Set(), released: new Map() };
  for (const value of await journals(join(root, "environments"))) {
    const { id, quota } = record(value);
    note(view, id, quota);
  }
  for (const value of await journals(join(root, "remote", "environments"))) {
    const parent = record(value);
    note(view, parent.id, parent.quota);
    if (!Array.isArray(parent.resources))
      throw new Error("Unreadable remote ownership journal; refusing to reconcile reservations.");
    // A hosted child the parent still lists unreleased is live, whatever else says.
    for (const child of parent.resources) {
      const { id, quota } = record(child);
      note(view, id, quota);
    }
  }
  return view;
}

export function classifyReservation(
  row: ListedReservation,
  view: JournalView,
  host: string | undefined,
  authority: string,
  now = Date.now(),
): ReservationClass {
  if (view.live.has(row.id)) return "live";
  if (view.released.has(row.id))
    return view.released.get(row.id) === authority ? "released-locally" : "foreign";
  if (host !== undefined && row.host === host) return "own-orphan";
  // Owner-scoped by the authority already; a missing or unparseable expiry never qualifies.
  if (
    typeof row.expires === "number" &&
    Number.isFinite(row.expires) &&
    row.expires < now - EXPIRED_GRACE_MS
  )
    return "expired-foreign";
  return "foreign";
}

export interface ReconcileReport {
  event: "reservations.reconcile";
  authority: string;
  host?: string;
  release: boolean;
  /** Whether `expired-foreign` rows were eligible for release (`--expired`). */
  expired: boolean;
  reservations: (ListedReservation & { class: ReservationClass })[];
  released: { id: string; removed: boolean }[];
  failures: { id: string; error: string }[];
  /** Ids still reserved at the authority after this run. */
  present: string[];
}

/**
 * Compare this owner's installation reservations with the journals on this
 * machine. With `release`, release only `released-locally` and `own-orphan` rows.
 */
export async function reconcileReservations(
  release: boolean,
  options: { expired?: boolean } = {},
): Promise<ReconcileReport> {
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
    throw new Error("Reconcile reservations on the owning host, not inside a hosted container.");
  const { authority } = await readEnvironmentLimits();
  if (!authority)
    throw new Error(
      "No installation quota authority is configured: gm settings environments set --local --authority https://YOUR-GITMATRIX.",
    );
  const host = await hostId();
  // List before reading journals: every lifecycle writes its journal before it
  // reserves, so each listed row's journal is already on disk.
  const rows = await listReservations(authority);
  const view = await readJournals();
  const reservations = rows.map((row) => ({
    ...row,
    class: classifyReservation(row, view, host, authority),
  }));
  const present = new Set(rows.map((row) => row.id));
  const released: ReconcileReport["released"] = [];
  const failures: ReconcileReport["failures"] = [];
  if (release)
    for (const row of reservations) {
      if (
        row.class !== "released-locally" &&
        row.class !== "own-orphan" &&
        !(options.expired && row.class === "expired-foreign")
      )
        continue;
      try {
        released.push({ id: row.id, removed: await releaseListedReservation(authority, row.id) });
        present.delete(row.id);
      } catch (error) {
        failures.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  return {
    event: "reservations.reconcile",
    authority,
    ...(host ? { host } : {}),
    release,
    expired: release && !!options.expired,
    reservations,
    released,
    failures,
    present: [...present],
  };
}

/** What a sweep's reconcile proved: the authority it listed and the ids still reserved there. */
export interface ReservationListing {
  /** Undefined when nothing could have been reserved (no authority, or hosted). */
  authority?: string;
  present: Set<string>;
}

/**
 * The hourly sweeps' best-effort reconcile: it never fails the sweep, and never
 * releases `expired-foreign` rows. Returns undefined when the listing failed.
 */
export async function sweepReservations(): Promise<ReservationListing | undefined> {
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1") return { present: new Set() };
  try {
    const { authority } = await readEnvironmentLimits();
    if (!authority) return { present: new Set() };
    const report = await reconcileReservations(true);
    if (report.released.length || report.failures.length)
      console.log(
        JSON.stringify({
          event: "reservations.reconciled",
          released: report.released,
          failures: report.failures,
        }),
      );
    return { authority: report.authority, present: new Set(report.present) };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "reservations.reconcile_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

/**
 * Whether a deleted journal may be pruned: only once the listing proved its
 * reservation, if it ever had one, is gone from the very authority that pinned it.
 */
export function prunable(
  quota: QuotaReservation | undefined,
  id: string,
  listing: ReservationListing | undefined,
): boolean {
  if (!quota) return true;
  return !!listing && quota.authority === listing.authority && !listing.present.has(id);
}

/** `maintenance reservations [--release [--expired]]` arguments, shared by both backends. */
export function parseReservationArgs(args: string[]): { release: boolean; expired: boolean } {
  const release = args.includes("--release");
  const expired = args.includes("--expired");
  if (args.some((arg) => arg !== "--release" && arg !== "--expired") || (expired && !release))
    throw new Error("Use maintenance reservations [--release [--expired]].");
  return { release, expired };
}
