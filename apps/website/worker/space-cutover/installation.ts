import { spaceDigest } from "../../shared/space-cutover.ts";
import {
  discoveryFor,
  discoverSchemaStep,
  type SchemaDiscovery,
  type D1CheckpointSchema,
} from "../../registry/core/space-migration.ts";
import {
  buildCanonicalD1Schema,
  initializeCanonicalEmptyStoreStep,
  type CanonicalEmptyStoreState,
} from "./canonical-schema.ts";
import { fenceBusinessDatabase, migrationDatabase, type D1FenceContext } from "./storage-fence.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { readWorkState, writeWorkState } from "./work-state.ts";

type Phase =
  | "preflight"
  | "fencing"
  | "rediscover"
  | "recheck"
  | "initialize"
  | "opening"
  | "active"
  | "refusing";
interface Store {
  discovery: SchemaDiscovery;
  target: D1CheckpointSchema | null;
  cursor: CanonicalEmptyStoreState | null;
  recheck?: SchemaDiscovery;
}
interface Installation {
  id: string;
  nonce: string;
  revision: number;
  phase: Phase;
  store: number;
  digest: string;
  contractVersion: 4;
  epoch: 0;
  stores: Store[];
  refusal?: string;
}
export type FreshInstallationStatus = {
  id: string;
  revision: number;
  phase: Phase;
  contractVersion: 4;
  epoch: 0;
};

/** Independent native authority, deliberately not a migration run or release approval. */
export class FreshInstallation {
  private readonly sql: SqlStorage;
  private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">;
  private readonly env: Env;
  private readonly eligible: () => boolean;
  constructor(
    storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    env: Env,
    eligible: () => boolean,
  ) {
    this.storage = storage;
    this.env = env;
    this.eligible = eligible;
    this.sql = storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS fresh_installation(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
    );
  }
  private load(): Installation | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM fresh_installation WHERE id=1")
      .toArray()[0];
    if (!row) return null;
    const stores = readWorkState(this.storage, "native-installation", "stores");
    if (stores === null) throw new Error("fresh_install_schema_journal_missing");
    return {
      ...(JSON.parse(row.value) as Omit<Installation, "stores">),
      stores: JSON.parse(stores) as Store[],
    };
  }
  status(): FreshInstallationStatus | null {
    return (
      this.sql
        .exec<FreshInstallationStatus>(
          "SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.revision') AS revision,json_extract(value,'$.phase') AS phase,json_extract(value,'$.contractVersion') AS contractVersion,json_extract(value,'$.epoch') AS epoch FROM fresh_installation WHERE id=1",
        )
        .toArray()[0] ?? null
    );
  }
  async verifyActive(): Promise<void> {
    const state = this.sql
      .exec<FreshInstallationStatus & { nonce: string; digest: string }>(
        "SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.revision') AS revision,json_extract(value,'$.phase') AS phase,json_extract(value,'$.contractVersion') AS contractVersion,json_extract(value,'$.epoch') AS epoch,json_extract(value,'$.nonce') AS nonce,json_extract(value,'$.digest') AS digest FROM fresh_installation WHERE id=1",
      )
      .toArray()[0];
    if (
      !state ||
      state.phase !== "active" ||
      state.contractVersion !== 4 ||
      state.epoch !== 0 ||
      !state.digest
    )
      throw new Error("fresh_install_authority_absent");
    for (const db of [this.env.DB, this.env.REGISTRY_DB]) {
      const row = await db
        .prepare(
          "SELECT 1 AS valid FROM _space_cutover_fence WHERE id=1 AND run_id=? AND migration_epoch=0 AND manifest_digest=? AND authority_token=? AND fenced=0 AND bypass=0",
        )
        .bind(state.id, state.digest, state.nonce)
        .first();
      if (!row) throw new Error("fresh_install_authority_mismatch");
    }
  }
  private save(state: Installation): void {
    state.revision++;
    const { stores, ...metadata } = state;
    writeWorkState(this.storage, "native-installation", "stores", JSON.stringify(stores), () => {
      this.sql.exec(
        "INSERT INTO fresh_installation VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        JSON.stringify(metadata),
      );
    });
  }
  private context(state: Installation): D1FenceContext {
    return { runId: state.id, migrationEpoch: 0, manifestDigest: state.digest };
  }
  private assert(state: Installation): void {
    const current = this.sql
      .exec<{ id: string; nonce: string; revision: number }>(
        "SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.nonce') AS nonce,json_extract(value,'$.revision') AS revision FROM fresh_installation WHERE id=1",
      )
      .toArray()[0];
    if (
      !this.eligible() ||
      !current ||
      current.id !== state.id ||
      current.nonce !== state.nonce ||
      current.revision !== state.revision
    )
      throw new Error("fresh_install_stale_advance");
  }
  private async open(state: Installation, db: D1Database): Promise<void> {
    this.assert(state);
    const query =
      state.phase === "refusing"
        ? "UPDATE _space_cutover_fence SET run_id=NULL,migration_epoch=NULL,manifest_digest=NULL,authority_token='',fenced=0,bypass=0 WHERE id=1 AND bypass=0 AND ((run_id=? AND migration_epoch=0 AND manifest_digest=? AND authority_token=?) OR (run_id IS NULL AND migration_epoch IS NULL AND manifest_digest IS NULL AND authority_token='' AND fenced=0))"
        : "UPDATE _space_cutover_fence SET fenced=0,bypass=0 WHERE id=1 AND run_id=? AND migration_epoch=0 AND manifest_digest=? AND authority_token=? AND bypass=0";
    const result = await db.prepare(query).bind(state.id, state.digest, state.nonce).run();
    if (result.meta.changes !== 1) throw new Error("fresh_install_fence_changed");
  }
  async advance(expected: FreshInstallationStatus | null): Promise<FreshInstallationStatus> {
    if (!this.eligible()) throw new Error("fresh_install_requires_no_migration_or_active_tickets");
    let state = this.load();
    if (
      (state?.id ?? null) !== (expected?.id ?? null) ||
      (state?.revision ?? null) !== (expected?.revision ?? null)
    )
      throw new Error("fresh_install_stale_advance");
    if (!state) {
      for (const db of [this.env.DB, this.env.REGISTRY_DB]) {
        const pristine = await db
          .prepare(
            "SELECT 1 AS valid FROM _space_cutover_fence WHERE id=1 AND run_id IS NULL AND migration_epoch IS NULL AND manifest_digest IS NULL AND authority_token='' AND fenced=0 AND bypass=0",
          )
          .first();
        if (!pristine) throw new Error("fresh_install_foreign_storage_authority");
      }
      if (!this.eligible() || this.load()) throw new Error("fresh_install_stale_advance");
      state = {
        id: `fresh:${crypto.randomUUID()}`,
        nonce: crypto.randomUUID(),
        revision: 0,
        phase: "preflight",
        store: 0,
        digest: "",
        contractVersion: 4,
        epoch: 0,
        stores: ["application", "registry"].map((id) => ({
          discovery: discoveryFor(id),
          target: null,
          cursor: null,
        })),
      };
      this.save(state);
    }
    const databases = [this.env.DB, this.env.REGISTRY_DB];
    try {
      for (let budget = 0; budget < 8 && state.phase !== "active"; budget++) {
        const phase = state.phase;
        const storeIndex = state.store;
        this.assert(state);
        const store = state.stores[state.store]!;
        const db = databases[state.store]!;
        if (state.phase === "preflight") {
          if (store.discovery.phase !== "done")
            store.discovery = await discoverSchemaStep(db, store.discovery);
          else {
            store.target ??= buildCanonicalD1Schema(
              store.discovery.schema,
              state.store === 0 ? "application" : "registry",
            );
            store.cursor = (
              await initializeCanonicalEmptyStoreStep(
                db,
                store.discovery.schema,
                store.target,
                store.cursor,
              )
            ).state;
            if (store.cursor.phase === "drop") {
              if (state.store === 0) state.store = 1;
              else {
                state.digest = await spaceDigest(
                  JSON.stringify(state.stores.map((entry) => entry.target)),
                );
                state.phase = "fencing";
                state.store = 0;
              }
            }
          }
        } else if (state.phase === "fencing") {
          await fenceBusinessDatabase(db, this.context(state), state.nonce);
          if (state.store === 0) state.store = 1;
          else {
            state.phase = "rediscover";
            state.store = 0;
            for (const entry of state.stores) entry.cursor = null;
          }
        } else if (state.phase === "rediscover") {
          store.recheck = await discoverSchemaStep(
            db,
            store.recheck ?? discoveryFor(store.discovery.schema.storeId),
          );
          if (store.recheck.phase === "done") {
            if (JSON.stringify(store.recheck.schema) !== JSON.stringify(store.discovery.schema))
              throw new Error("fresh_install_schema_changed");
            if (state.store === 0) state.store = 1;
            else {
              state.phase = "recheck";
              state.store = 0;
            }
          }
        } else if (state.phase === "recheck" || state.phase === "initialize") {
          const fenced = migrationDatabase(
            db,
            this.context(state),
            "migrate",
            async () => this.assert(state!),
            state.nonce,
          );
          const next = await initializeCanonicalEmptyStoreStep(
            fenced,
            store.discovery.schema,
            store.target!,
            store.cursor,
          );
          store.cursor = next.state;
          if (state.phase === "recheck" && next.state.phase === "drop") {
            if (state.store === 0) state.store = 1;
            else {
              state.phase = "initialize";
              state.store = 0;
            }
          } else if (state.phase === "initialize" && next.done) {
            if (state.store === 0) state.store = 1;
            else {
              state.phase = "opening";
              state.store = 0;
            }
          }
        } else if (state.phase === "opening" || state.phase === "refusing") {
          await this.open(state, db);
          if (state.store === 0) state.store = 1;
          else if (state.phase === "refusing") {
            this.sql.exec("DELETE FROM fresh_installation WHERE id=1");
            throw new Error(state.refusal);
          } else state.phase = "active";
        }
        this.assert(state);
        // Every within-phase step is replay-safe. Persist each bounded batch,
        // and every phase/store transition before its next side effect, rather
        // than rewriting both complete schemas after each table or PRAGMA.
        if (state.phase !== phase || state.store !== storeIndex || budget === 7) this.save(state);
      }
    } catch (error) {
      if (state.phase === "preflight") this.sql.exec("DELETE FROM fresh_installation WHERE id=1");
      else if (
        (state.phase === "recheck" && String(error).includes("fresh_install_nonempty:")) ||
        (state.phase === "rediscover" && String(error).includes("fresh_install_schema_changed"))
      ) {
        state.phase = "refusing";
        state.refusal = String(error);
        state.store = 0;
        this.save(state);
        // Only read-only validation has occurred. Undo both owned fences before refusal.
        for (const database of databases) await this.open(state, database);
        this.sql.exec("DELETE FROM fresh_installation WHERE id=1");
      }
      throw error;
    }
    return this.status()!;
  }
}

/** Called after ordinary migrations and before any fixture/business seed. */
export async function initializeFreshSpaceInstallation(env: Env): Promise<void> {
  const control = cutoverControl(env);
  if (await control.status()) {
    if (!(await control.admission()).allowed)
      throw new Error("space_cutover_requires_reviewed_migration");
    return;
  }
  for (let call = 0; call < 4096; call++) {
    const status = await control.freshStatus();
    if (status?.phase === "active") {
      await control.verifyFreshInstallation();
      return;
    }
    try {
      await control.advanceFreshInstallation(status);
    } catch (error) {
      if (!/fresh_install_(?:busy|stale_advance)/.test(String(error))) throw error;
    }
  }
  throw new Error("fresh_install_progress_limit: retry initialization to resume durable progress");
}
