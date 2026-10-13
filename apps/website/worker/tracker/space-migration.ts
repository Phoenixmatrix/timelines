import { createHash } from "node:crypto";
import type { SpaceMigrationContext, SpaceCheckpointPage } from "../../shared/space-cutover.ts";
import type { SqlDatabase } from "./sql.ts";
import type { TrackerScope } from "../../shared/tracker.ts";
import { cutoverControl, withCutoverAdmission } from "../durable/cutover-admission.ts";

/** Local scope is evidence, not authorization: callers must also hold current control admission. */
export function assertTrackerSpaceOpen(sql: SqlDatabase): Readonly<TrackerScope> {
  const tables = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .toArray()
      .map((row) => row.name),
  );
  check(
    !tables.has("workspaces"),
    "Legacy Tracker is closed to Project clients; use independently fenced recovery.",
  );
  if (tables.has("space_migration_run")) {
    const run = sql
      .exec<{ context: string; state: string; migration_epoch: number }>(
        "SELECT context,state,migration_epoch FROM space_migration_run ORDER BY migration_epoch DESC LIMIT 1",
      )
      .toArray()[0];
    if (run) {
      check(run.state === "converted", "Tracker is closed for coordinated Space migration.");
      const context: SpaceMigrationContext = JSON.parse(run.context);
      check(
        context.contractVersion === 4 &&
          typeof context.spaceId === "string" &&
          !!context.spaceId &&
          context.spaceId === context.legacyOwnerId &&
          Number.isSafeInteger(context.migrationEpoch) &&
          context.migrationEpoch > 0 &&
          context.migrationEpoch === run.migration_epoch,
        "Invalid converted Tracker scope.",
      );
      check(tables.has("projects"), "Converted Tracker Project schema is missing.");
      return Object.freeze({
        contractVersion: 4,
        spaceId: context.spaceId,
        migrationEpoch: context.migrationEpoch,
      });
    }
  }
  check(
    tables.has("space_migration_scope"),
    "Tracker is closed until independent fresh Space admission.",
  );
  const scope = sql
    .exec(
      "SELECT contract_version,space_id,migration_epoch FROM space_migration_scope WHERE singleton=1",
    )
    .one();
  check(
    scope.contract_version === 4 &&
      typeof scope.space_id === "string" &&
      !!scope.space_id &&
      Number.isSafeInteger(scope.migration_epoch) &&
      Number(scope.migration_epoch) >= 0,
    "Invalid fresh Tracker scope.",
  );
  return Object.freeze({
    contractVersion: 4,
    spaceId: String(scope.space_id),
    migrationEpoch: Number(scope.migration_epoch),
  });
}

/** Requires real controller authority, a real Space, and the exact physical named DO. */
export async function initializeFreshTrackerSpace(
  env: Env,
  state: { id: DurableObjectId; storage: { sql: SqlDatabase; transactionSync<T>(fn: () => T): T } },
  spaceId: string,
): Promise<Readonly<TrackerScope>> {
  return withCutoverAdmission(env, "tracker", async () => {
    const admission = await cutoverControl(env).admission(4);
    check(
      admission.allowed && Number.isSafeInteger(admission.epoch) && admission.epoch >= 0,
      "Independent controller denies fresh Tracker admission.",
    );
    check(
      !!spaceId && env.TRACKER.idFromName(spaceId).equals(state.id),
      "Fresh Tracker physical Space identity mismatch.",
    );
    const space = await env.DB.prepare("SELECT id FROM spaces WHERE id=? AND archived_at IS NULL")
      .bind(spaceId)
      .first<{ id: string }>();
    check(space?.id === spaceId, "Fresh Tracker requires an active real Space.");
    return state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      const tables = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB '__miniflare_*' AND name <> 'sqlite_sequence'",
        )
        .toArray();
      if (tables.length) {
        const scope = assertTrackerSpaceOpen(sql);
        check(
          scope.spaceId === spaceId && scope.migrationEpoch === admission.epoch,
          "Tracker Space/epoch differs from current controller admission.",
        );
        return scope;
      }
      sql.exec(
        "CREATE TABLE space_migration_scope(singleton INTEGER PRIMARY KEY CHECK(singleton=1),contract_version INTEGER NOT NULL CHECK(contract_version=4),space_id TEXT NOT NULL,migration_epoch INTEGER NOT NULL CHECK(migration_epoch>=0))",
      );
      sql.exec("INSERT INTO space_migration_scope VALUES(1,4,?,?)", spaceId, admission.epoch);
      return assertTrackerSpaceOpen(sql);
    });
  });
}

const TABLES: Record<string, true> = Object.fromEntries(
  "teams workspaces issues tracker_labels links comments requests subscriptions team_numbers leases offers receipts approval_automation events issue_events tracker_migrations timelines timeline_events timeline_event_index timeline_checkpoints timeline_heads timeline_landings timeline_reservations timeline_creation_cancellations timeline_source_operations timeline_source_allocations retention_removed retention_state sqlite_sequence space_migration_receipt_proof"
    .split(" ")
    .map((name) => [name, true]),
);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`space_migration_fenced: ${message}`);
}
export function trackerMigrationClosed(sql: SqlDatabase): boolean {
  return (
    !!sql
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='space_migration_run'")
      .toArray().length &&
    !!sql.exec("SELECT run_id FROM space_migration_run WHERE state <> 'legacy-active'").toArray()
      .length
  );
}
export function assertTrackerLegacyOpen(sql: SqlDatabase) {
  check(
    !trackerMigrationClosed(sql),
    "Tracker is closed for the coordinated Space cutover; recovery RPCs remain available.",
  );
}
/** Additive, retention-independent original operation evidence. Never interpreted as proof of noncommit. */
export function initializeTrackerMigrationProof(sql: SqlDatabase) {
  sql.exec(`CREATE TABLE IF NOT EXISTS space_migration_run(run_id TEXT PRIMARY KEY,migration_epoch INTEGER NOT NULL UNIQUE,context TEXT NOT NULL,state TEXT NOT NULL,checkpoint_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS space_migration_receipt_proof (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, source_epoch INTEGER NOT NULL DEFAULT 0, request_digest TEXT, result_digest TEXT);
    DROP TRIGGER IF EXISTS space_migration_receipt_capture;
    CREATE TRIGGER space_migration_receipt_capture AFTER INSERT ON receipts BEGIN
      INSERT INTO space_migration_receipt_proof(id,actor_id,request,result,source_epoch) VALUES(NEW.id,NEW.actor_id,NEW.request,NEW.result,COALESCE(json_extract(NEW.request,'$.migrationEpoch'),(SELECT max(migration_epoch) FROM space_migration_run),0));
    END;
    INSERT OR IGNORE INTO space_migration_receipt_proof(id,actor_id,request,result,source_epoch) SELECT id,actor_id,request,result,COALESCE(json_extract(request,'$.migrationEpoch'),0) FROM receipts;`);
}
type Schema = { type: string; name: string; tbl_name: string; sql: string | null };
type RecordEntry = { table: string; row: Record<string, SqlStorageValue> };
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v instanceof ArrayBuffer
      ? { $sqlBlob: Array.from(new Uint8Array(v)) }
      : ArrayBuffer.isView(v)
        ? { $sqlBlob: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
        : v,
  );
const decode = (value: string) =>
  JSON.parse(value, (_key, v) =>
    v && typeof v === "object" && Object.keys(v).length === 1 && Array.isArray(v.$sqlBlob)
      ? new Uint8Array(v.$sqlBlob).buffer
      : v,
  );

/** Convert schema fields only: descriptions, evidence, IDs and arbitrary user strings are never rewritten. */
export function convertTrackerSpaceJson(value: unknown, spaceId?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => convertTrackerSpaceJson(entry, spaceId));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const subscription =
    typeof object.id === "string" &&
    typeof object.repoId === "string" &&
    ("workspaceId" in object || "projectId" in object);
  const repoLocator =
    typeof object.id === "string" &&
    typeof object.name === "string" &&
    typeof object.owner === "string" &&
    ("bookmark" in object || "commit" in object);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next =
      (
        { workspaceIds: "projectIds", workspaceId: "projectId", workspaces: "projects" } as Record<
          string,
          string
        >
      )[key] ?? key;
    check(!(next !== key && Object.hasOwn(value, next)), `Conflicting ${key}/${next}`);
    if ((subscription || repoLocator) && key === "owner") {
      check(
        typeof entry === "string" && !Object.hasOwn(object, "space"),
        "Conflicting repository owner/Space locator",
      );
      result.space = entry;
      continue;
    }
    check(!key.toLowerCase().includes("workspace") || next !== key, `Unknown scope field ${key}`);
    if (key === "entityType")
      check(
        typeof entry === "string" &&
          [
            "team",
            "workspace",
            "issue",
            "link",
            "comment",
            "request",
            "subscription",
            "timeline",
            "timelineEvent",
            // A person's approve-when-green setting (CORE-378): person identity, no scope.
            "automation",
          ].includes(entry),
        "Unknown scope-bearing event",
      );
    let converted = convertTrackerSpaceJson(entry, spaceId);
    if (
      (key === "kind" || key === "mutationKind") &&
      typeof entry === "string" &&
      entry.startsWith("workspace.")
    ) {
      check(
        entry === "workspace.create" || entry === "workspace.update",
        `Unknown workspace operation ${entry}`,
      );
      converted = entry.replace("workspace.", "project.");
    }
    if (key === "entityType" && entry === "workspace") converted = "project";
    result[next] = converted;
  }
  if (subscription) {
    check(!!spaceId, "Subscription conversion requires approved Space scope");
    check(
      object.spaceId === undefined || object.spaceId === spaceId,
      "Subscription Space mismatch",
    );
    result.spaceId = spaceId;
  }
  return result;
}

/** All local state transitions are synchronous SQLite transactions under the independent controller fence. */
export class TrackerSpaceMigration {
  private sql: SqlDatabase;
  private transaction: <T>(fn: () => T) => T;
  private ownerId: string;
  private repositoryIds: readonly string[];
  constructor(
    sql: SqlDatabase,
    transaction: <T>(fn: () => T) => T,
    ownerId: string,
    repositoryIds: readonly string[],
  ) {
    this.sql = sql;
    this.transaction = transaction;
    this.ownerId = ownerId;
    this.repositoryIds = repositoryIds;
  }
  private schema(): Schema[] {
    return this.sql
      .exec<Schema>(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (name NOT GLOB 'space_migration_*' OR name='space_migration_receipt_proof') AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND tbl_name NOT GLOB '_cf_*' AND tbl_name NOT GLOB '__cf_*' AND tbl_name NOT GLOB '__miniflare_*' ORDER BY type,name",
      )
      .toArray();
  }
  private context(context: SpaceMigrationContext, allowReleased = false) {
    check(
      context.contractVersion === 4 &&
        context.legacyOwnerId === this.ownerId &&
        context.spaceId === this.ownerId,
      "In-place owner/Space/DO identity mismatch",
    );
    const row = this.sql
      .exec<{ run_id: string; context: string; state: string; checkpoint_digest: string }>(
        "SELECT run_id,context,state,checkpoint_digest FROM space_migration_run ORDER BY migration_epoch DESC LIMIT 1",
      )
      .toArray()[0];
    check(
      row?.run_id === context.runId && row.context === canonical(context),
      "Run, epoch or approved mapping mismatch",
    );
    check(
      allowReleased || row.state !== "legacy-active",
      "Migration run already released legacy admission",
    );
    return row;
  }
  private records(schema: Schema[], visit: (record: RecordEntry) => void) {
    for (const table of schema.filter((s) => s.type === "table")) {
      check(TABLES[table.name] || table.name === "projects", `Unrecognized table ${table.name}`);
      let after = Number.MIN_SAFE_INTEGER;
      for (;;) {
        const rows = this.sql
          .exec(
            `SELECT rowid AS __migration_rowid, * FROM ${quote(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT 64`,
            after,
          )
          .toArray();
        if (!rows.length) break;
        for (const row of rows) {
          after = Number(row.__migration_rowid);
          delete row.__migration_rowid;
          if (table.name === "sqlite_sequence") {
            check(typeof row.name === "string", "Invalid SQLite sequence name");
            if (row.name.startsWith("space_migration_")) continue;
          }
          visit({ table: table.name, row });
        }
      }
    }
  }
  inventory(context: SpaceMigrationContext) {
    check(
      context.legacyOwnerId === this.ownerId &&
        context.spaceId === this.ownerId &&
        context.contractVersion === 4,
      "In-place identity mismatch",
    );
    this.transaction(() => {
      initializeTrackerMigrationProof(this.sql);
      this.sql
        .exec(`CREATE TABLE IF NOT EXISTS space_migration_checkpoint(run_id TEXT NOT NULL,page INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(run_id,page));
        CREATE TABLE IF NOT EXISTS space_migration_ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,phase TEXT NOT NULL,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS space_migration_records(run_id TEXT NOT NULL,id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,id));`);
      const previous = this.sql
        .exec(
          "SELECT run_id,migration_epoch,state FROM space_migration_run ORDER BY migration_epoch DESC LIMIT 1",
        )
        .toArray()[0];
      if (previous?.run_id === context.runId) {
        const current = this.context(context);
        check(current.state === "prepared", "Inventory is already sealed for this run");
        return;
      }
      check(
        Number.isSafeInteger(context.migrationEpoch) &&
          context.migrationEpoch > Number(previous?.migration_epoch ?? 0),
        "Migration epoch must increase",
      );
      // A restored run this Tracker never entered (its restore only recorded
      // unchanged evidence) left nothing to release; a newer run supersedes it.
      const untouched =
        previous?.state === "restored" &&
        this.sql
          .exec(
            "SELECT seq FROM space_migration_ledger WHERE run_id=? AND phase='unchanged-restored'",
            previous.run_id as string,
          )
          .toArray().length > 0;
      check(
        !previous || previous.state === "legacy-active" || untouched,
        "Previous run has not released restored legacy admission",
      );
      check(
        !this.sql
          .exec("SELECT run_id FROM space_migration_run WHERE run_id=?", context.runId)
          .toArray().length,
        "Run identity cannot be reused",
      );
      let proofCursor = "";
      for (;;) {
        const proofs = this.sql
          .exec<{ id: string; request: string; result: string }>(
            "SELECT id,request,result FROM space_migration_receipt_proof WHERE id > ? ORDER BY id LIMIT 64",
            proofCursor,
          )
          .toArray();
        if (!proofs.length) break;
        for (const proof of proofs) {
          proofCursor = proof.id;
          this.sql.exec(
            "UPDATE space_migration_receipt_proof SET request_digest=?,result_digest=? WHERE id=?",
            digest(proof.request),
            digest(proof.result),
            proofCursor,
          );
        }
      }
      const schema = this.schema();
      check(!schema.some((s) => s.name === "projects"), "Project table collision");
      check(
        !this.sql
          .exec(
            "SELECT json_extract(data,'$.key') FROM issues GROUP BY json_extract(data,'$.key') HAVING count(*) > 1 LIMIT 1",
          )
          .toArray().length,
        "Issue key collision",
      );
      check(
        !this.sql
          .exec(
            "SELECT issues.id FROM issues LEFT JOIN teams ON teams.id=json_extract(issues.data,'$.teamId') WHERE teams.id IS NULL LIMIT 1",
          )
          .toArray().length,
        "Unknown Team reference",
      );
      check(
        !this.sql
          .exec(
            "SELECT issues.id FROM issues,json_each(issues.data,'$.workspaceIds') AS project LEFT JOIN workspaces ON workspaces.id=project.value WHERE workspaces.id IS NULL LIMIT 1",
          )
          .toArray().length,
        "Unknown Project reference",
      );
      check(
        !this.sql
          .exec(
            "SELECT subscriptions.id FROM subscriptions LEFT JOIN workspaces ON workspaces.id=json_extract(subscriptions.data,'$.workspaceId') WHERE workspaces.id IS NULL LIMIT 1",
          )
          .toArray().length,
        "Unknown subscription Project",
      );
      const hash = createHash("sha256");
      let page = 0;
      let recordId = 0;
      const save = (entry: unknown) => {
        const text = encode(entry);
        this.sql.exec(
          "INSERT INTO space_migration_records(run_id,id,payload) VALUES(?,?,?)",
          context.runId,
          ++recordId,
          text,
        );
        // Chunk the serialized bytes as JSON strings, including oversized receipt/evidence rows.
        for (let at = 0; at < text.length; at += 16000) {
          const payload = JSON.stringify({
            recordEnd: at + 16000 >= text.length,
            text: text.slice(at, at + 16000),
          });
          hash.update(payload);
          this.sql.exec(
            "INSERT INTO space_migration_checkpoint(run_id,page,payload,digest) VALUES(?,?,?,?)",
            context.runId,
            page++,
            payload,
            digest(payload),
          );
        }
      };
      save({ schema });
      this.records(schema, save);
      const checkpoint = hash.digest("hex");
      this.sql.exec(
        "INSERT INTO space_migration_run VALUES(?,?,?,?,?)",
        context.runId,
        context.migrationEpoch,
        canonical(context),
        "prepared",
        checkpoint,
      );
      for (const table of [
        "space_migration_checkpoint",
        "space_migration_records",
        "space_migration_ledger",
      ]) {
        for (const action of ["UPDATE", "DELETE"])
          this.sql.exec(
            `CREATE TRIGGER IF NOT EXISTS ${quote(`${table}_${action.toLowerCase()}`)} BEFORE ${action} ON ${quote(table)} BEGIN SELECT RAISE(ABORT,'Immutable migration evidence'); END`,
          );
      }
      this.sql.exec(
        "CREATE TRIGGER IF NOT EXISTS space_migration_identity_update BEFORE UPDATE OF run_id,migration_epoch,context,checkpoint_digest ON space_migration_run BEGIN SELECT RAISE(ABORT,'Immutable migration identity'); END",
      );
      this.sql.exec(
        "CREATE TRIGGER IF NOT EXISTS space_migration_identity_delete BEFORE DELETE ON space_migration_run BEGIN SELECT RAISE(ABORT,'Immutable migration identity'); END",
      );
      this.sql.exec(
        "INSERT INTO space_migration_ledger(run_id,phase,digest) VALUES(?,?,?)",
        context.runId,
        "prepared",
        checkpoint,
      );
    });
    return this.reconcile(context);
  }
  export(context: SpaceMigrationContext, cursor: string | null): SpaceCheckpointPage {
    this.context(context);
    const page = cursor === null ? 0 : Number(cursor);
    check(
      Number.isSafeInteger(page) && page >= 0 && (cursor === null || String(page) === cursor),
      "Invalid checkpoint cursor",
    );
    const row = this.sql
      .exec<{ payload: string; digest: string }>(
        "SELECT payload,digest FROM space_migration_checkpoint WHERE run_id=? AND page=?",
        context.runId,
        page,
      )
      .toArray()[0];
    check(row, "Unknown checkpoint page");
    const more = this.sql
      .exec(
        "SELECT page FROM space_migration_checkpoint WHERE run_id=? AND page=?",
        context.runId,
        page + 1,
      )
      .toArray().length;
    return {
      cursor,
      nextCursor: more ? String(page + 1) : null,
      payload: row.payload,
      digest: row.digest,
    };
  }
  private original(context: SpaceMigrationContext, visit: (record: RecordEntry) => void): Schema[] {
    const first = this.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM space_migration_records WHERE run_id=? ORDER BY id LIMIT 1",
        context.runId,
      )
      .one();
    const schema = decode(first.payload).schema as Schema[];
    let after = 1;
    for (;;) {
      const rows = this.sql
        .exec<{ id: number; payload: string }>(
          "SELECT id,payload FROM space_migration_records WHERE run_id=? AND id > ? ORDER BY id LIMIT 64",
          context.runId,
          after,
        )
        .toArray();
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        visit(decode(row.payload));
      }
    }
    return schema;
  }
  private converted(record: RecordEntry, context: SpaceMigrationContext): RecordEntry {
    if (record.table === "space_migration_receipt_proof") return record;
    const row = { ...record.row };
    for (const column of ["data", "request", "result", "input"]) {
      if (typeof row[column] === "string")
        row[column] = canonical(
          convertTrackerSpaceJson(JSON.parse(row[column] as string), context.spaceId),
        );
    }
    if (record.table === "sqlite_sequence" && row.name === "workspaces") row.name = "projects";
    return { table: record.table === "workspaces" ? "projects" : record.table, row };
  }
  migrate(context: SpaceMigrationContext) {
    this.transaction(() => {
      const state = this.context(context).state;
      if (state === "converted") return;
      check(state === "prepared", "Restored runs cannot be migrated again");
      check(this.reconcile(context).preserved, "Business state changed after checkpoint");
      const validateReferences = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(validateReferences);
          return;
        }
        const object = value as Record<string, unknown>;
        if (typeof object.repoId === "string")
          check(
            this.repositoryIds.includes(object.repoId),
            "Repository outside approved Space mapping",
          );
        if (Array.isArray(object.repos))
          for (const repo of object.repos) {
            if (repo && typeof repo === "object" && "id" in repo)
              check(
                this.repositoryIds.includes(String(repo.id)),
                "Timeline repository outside approved Space mapping",
              );
          }
        Object.values(object).forEach(validateReferences);
      };
      this.original(context, ({ row }) => {
        for (const column of ["data", "request", "result", "input"])
          if (typeof row[column] === "string")
            validateReferences(JSON.parse(row[column] as string));
      });
      this.sql.exec("ALTER TABLE workspaces RENAME TO projects");
      this.sql.exec("DROP INDEX workspace_slugs");
      this.sql.exec("CREATE UNIQUE INDEX project_slugs ON projects(json_extract(data,'$.slug'))");
      this.original(context, (record) => {
        const converted = this.converted(record, context);
        const changes = Object.keys(record.row).filter(
          (key) => converted.row[key] !== record.row[key],
        );
        if (!changes.length) return;
        const keys = Object.keys(record.row);
        this.sql.exec(
          `UPDATE ${quote(converted.table)} SET ${changes.map((key) => `${quote(key)}=?`).join(",")} WHERE ${keys.map((key) => `${quote(key)} IS ?`).join(" AND ")}`,
          ...changes.map((k) => converted.row[k]!),
          ...keys.map((k) => record.row[k]!),
        );
      });
      this.sql.exec("INSERT INTO tracker_migrations(name) VALUES('space-project-v4')");
      this.sql.exec(
        "UPDATE space_migration_run SET state='converted' WHERE run_id=?",
        context.runId,
      );
      const result = this.reconcile(context);
      check(result.preserved, "Post-conversion reconciliation failed");
      this.sql.exec(
        "INSERT INTO space_migration_ledger(run_id,phase,digest) VALUES(?,?,?)",
        context.runId,
        "converted",
        result.digest,
      );
    });
    return this.reconcile(context);
  }
  reconcile(context: SpaceMigrationContext) {
    const converted = this.context(context).state === "converted";
    const counts: Record<string, number> = {};
    const hash = createHash("sha256");
    let preserved = true;
    const schema = this.original(context, (original) => {
      const record = converted ? this.converted(original, context) : original;
      counts[record.table] = (counts[record.table] ?? 0) + 1;
      const keys = Object.keys(record.row);
      const found = this.sql
        .exec(
          `SELECT count(*) AS n FROM ${quote(record.table)} WHERE ${keys.map((key) => `${quote(key)} IS ?`).join(" AND ")}`,
          ...keys.map((key) => record.row[key]!),
        )
        .one();
      if (Number(found.n) !== 1) preserved = false;
      hash.update(encode(record));
    });
    for (const table of schema.filter((entry) => entry.type === "table")) {
      const name = converted && table.name === "workspaces" ? "projects" : table.name;
      counts[name] ??= 0;
    }
    for (const [table, expected] of Object.entries(counts)) {
      const actual = Number(
        this.sql
          .exec(
            `SELECT count(*) AS n FROM ${quote(table)}${table === "sqlite_sequence" ? " WHERE name NOT GLOB 'space_migration_*'" : ""}`,
          )
          .one().n,
      );
      if (actual !== expected + (converted && table === "tracker_migrations" ? 1 : 0))
        preserved = false;
    }
    return { storeId: `tracker:${this.ownerId}`, digest: hash.digest("hex"), counts, preserved };
  }
  restore(context: SpaceMigrationContext) {
    this.transaction(() => {
      const hasRunTable = this.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='space_migration_run'")
        .toArray().length;
      const existing = hasRunTable
        ? this.sql
            .exec("SELECT run_id FROM space_migration_run WHERE run_id=?", context.runId)
            .toArray()[0]
        : undefined;
      if (!existing) {
        // This participant never entered this run. Capture its unchanged state as
        // recovery evidence, not a fabricated pre-transformation backup.
        const unchanged = this.inventory(context);
        check(unchanged.preserved, "Unchanged recovery evidence mismatch");
        this.sql.exec(
          "UPDATE space_migration_run SET state='restored' WHERE run_id=?",
          context.runId,
        );
        this.sql.exec(
          "INSERT INTO space_migration_ledger(run_id,phase,digest) VALUES(?,?,?)",
          context.runId,
          "unchanged-restored",
          unchanged.digest,
        );
        return;
      }
      const state = this.context(context).state;
      check(
        state === "prepared" || state === "converted" || state === "restored",
        "Restoration is closed after legacy release",
      );
      if (state === "restored") {
        check(this.reconcile(context).preserved, "Restored state changed");
        return;
      }
      const schema = this.original(context, () => {});
      for (const object of this.schema().filter(
        (s) => s.type === "table" && s.name !== "sqlite_sequence",
      ))
        this.sql.exec(`DROP TABLE ${quote(object.name)}`);
      for (const object of schema.filter(
        (s) => s.type === "table" && s.name !== "sqlite_sequence",
      )) {
        check(object.sql, "Missing table definition");
        this.sql.exec(object.sql);
      }
      this.original(context, ({ table, row }) => {
        if (table === "sqlite_sequence") return;
        const keys = Object.keys(row);
        this.sql.exec(
          `INSERT INTO ${quote(table)}(${keys.map(quote).join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ...keys.map((key) => row[key]!),
        );
      });
      this.sql.exec("DELETE FROM sqlite_sequence WHERE name NOT GLOB 'space_migration_*'");
      this.original(context, ({ table, row }) => {
        if (table === "sqlite_sequence")
          this.sql.exec("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", row.name!, row.seq!);
      });
      for (const object of schema.filter((s) => s.type !== "table" && s.sql))
        this.sql.exec(object.sql!);
      initializeTrackerMigrationProof(this.sql);
      this.sql.exec(
        "UPDATE space_migration_run SET state='restored' WHERE run_id=?",
        context.runId,
      );
      const result = this.reconcile(context);
      check(result.preserved, "Restoration reconciliation failed");
      this.sql.exec(
        "INSERT INTO space_migration_ledger(run_id,phase,digest) VALUES(?,?,?)",
        context.runId,
        "restored",
        result.digest,
      );
    });
    const unchanged =
      this.sql
        .exec(
          "SELECT seq FROM space_migration_ledger WHERE run_id=? AND phase='unchanged-restored'",
          context.runId,
        )
        .toArray().length > 0;
    return { ...this.reconcile(context), unchanged };
  }
  /** Caller has verified opening-legacy; ordinary RPCs still require global admission. */
  releaseLegacy(context: SpaceMigrationContext) {
    return this.transaction(() => {
      const current = this.context(context, true);
      check(
        current.state === "restored" || current.state === "legacy-active",
        "Legacy release requires restored evidence",
      );
      if (current.state === "restored") {
        const restored = this.reconcile(context);
        check(restored.preserved, "Restored state changed before legacy release");
        this.sql.exec(
          "INSERT INTO space_migration_ledger(run_id,phase,digest) VALUES(?,?,?)",
          context.runId,
          "legacy-active",
          restored.digest,
        );
        this.sql.exec(
          "UPDATE space_migration_run SET state='legacy-active' WHERE run_id=?",
          context.runId,
        );
      }
      const proof = this.sql
        .exec<{ digest: string }>(
          "SELECT digest FROM space_migration_ledger WHERE run_id=? AND phase='legacy-active'",
          context.runId,
        )
        .one();
      return {
        storeId: `tracker:${this.ownerId}`,
        runId: context.runId,
        migrationEpoch: context.migrationEpoch,
        checkpointDigest: current.checkpoint_digest,
        reconciliationDigest: proof.digest,
        released: true as const,
      };
    });
  }
  reconcileOperation(
    context: SpaceMigrationContext,
    input: { operationId: string; actorId: string; originalRequest: unknown },
  ) {
    this.context(context);
    const proof = this.sql
      .exec<{
        actor_id: string;
        request: string;
        result: string;
        source_epoch: number;
        request_digest: string | null;
        result_digest: string | null;
      }>("SELECT * FROM space_migration_receipt_proof WHERE id=?", input.operationId)
      .toArray()[0];
    if (!proof) return { state: "export_required" as const, operationId: input.operationId };
    check(
      proof.actor_id === input.actorId && proof.request === canonical(input.originalRequest),
      "Original operation actor/request mismatch",
    );
    check(
      proof.request_digest === digest(proof.request) &&
        proof.result_digest === digest(proof.result),
      "Operation evidence digest mismatch",
    );
    return {
      state: "committed" as const,
      operationId: input.operationId,
      actorId: proof.actor_id,
      sourceEpoch: proof.source_epoch,
      requestDigest: proof.request_digest,
      originalRequest: proof.request,
      originalResult: proof.result,
      result: convertTrackerSpaceJson(JSON.parse(proof.result), context.spaceId),
    };
  }
}
