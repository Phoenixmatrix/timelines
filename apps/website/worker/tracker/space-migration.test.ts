import { describe, expect, test } from "vite-plus/test";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore } from "./store.ts";
import { initializeLegacyTrackerForMigration } from "./legacy-initializer.ts";
import { freshTrackerStorage } from "../testing/tracker.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import {
  TrackerSpaceMigration,
  assertTrackerLegacyOpen,
  assertTrackerSpaceOpen,
  initializeFreshTrackerSpace,
  convertTrackerSpaceJson,
} from "./space-migration.ts";
import type { SpaceMigrationContext } from "../../shared/space-cutover.ts";
import type { SqlDatabase } from "./sql.ts";
import { removeActivity, removeClosedIssues, selectActivity } from "./retention.ts";

const context: SpaceMigrationContext = {
  runId: "run",
  migrationEpoch: 1,
  manifestDigest: "approved-digest",
  legacyOwnerId: "org",
  spaceId: "org",
  organizationId: "company",
  spaceSlug: "org",
  contractVersion: 4,
};
function fixture() {
  const storage = durableStorage();
  storage.sql.exec("CREATE TABLE __miniflare_do_name(name TEXT PRIMARY KEY)");
  storage.sql.exec("INSERT INTO __miniflare_do_name VALUES('org')");
  initializeLegacyTrackerForMigration(storage.sql, storage.transactionSync);
  const insert = (table: string, id: string, data: unknown) =>
    storage.sql.exec(`INSERT INTO ${table}(id,data) VALUES(?,?)`, id, JSON.stringify(data));
  const team = { id: "team", key: "ENG", name: "Engineering", version: 1 };
  const workspace = { id: "workspace", slug: "group", name: "Group", version: 1 };
  const issue = {
    id: "issue",
    key: "ENG-1",
    teamId: "team",
    title: "Original",
    workspaceIds: ["workspace"],
    version: 1,
  };
  insert("teams", team.id, team);
  insert("workspaces", workspace.id, workspace);
  insert("issues", issue.id, issue);
  storage.sql.exec("INSERT INTO team_numbers VALUES('team',1)");
  storage.sql.exec(
    "INSERT INTO events(data) VALUES(?)",
    JSON.stringify({
      entityType: "workspace",
      entityId: workspace.id,
      entity: workspace,
      actorId: "ann",
      operationId: "setup",
    }),
  );
  // Legacy receipts used recursively sorted request keys; preserve those exact bytes.
  const request = {
    mutations: [
      { data: { name: "Group", slug: "group" }, id: workspace.id, kind: "workspace.create" },
    ],
    operationId: "setup",
  };
  storage.sql.exec(
    "INSERT INTO receipts VALUES(?,?,?,?)",
    "setup",
    "ann",
    JSON.stringify(request),
    JSON.stringify({ cursor: 1, events: [], results: [{ id: workspace.id }] }),
  );
  const timeline = {
    id: "branch",
    slug: "branch",
    repos: [{ id: "repo", owner: "org", name: "repo", bookmark: "timeline/branch" }],
  };
  insert("timelines", timeline.id, timeline);
  storage.sql.exec(
    "INSERT INTO timeline_events(id,data) VALUES(?,?)",
    "overlay",
    JSON.stringify({
      timelineId: timeline.id,
      entityType: "issue",
      entityId: issue.id,
      entity: { ...issue, title: "Branch" },
    }),
  );
  // Include independent checkpoint/lease bytes and subscription links, not just the current snapshot.
  storage.sql.exec("INSERT INTO leases(issue_id,token) VALUES('issue','secret-token')");
  storage.sql.exec(
    "INSERT INTO subscriptions(id,data) VALUES('subscription',?)",
    JSON.stringify({
      id: "subscription",
      repoId: "repo",
      workspaceId: "workspace",
      owner: "org",
      createdBy: { personId: "ann", agentId: "agent" },
    }),
  );
  storage.sql.exec(
    "INSERT INTO timeline_checkpoints(id,timeline_id,number,data) VALUES('checkpoint',?,1,?)",
    timeline.id,
    JSON.stringify({
      id: "checkpoint",
      timelineId: timeline.id,
      workspaceIds: ["workspace"],
      actor: { personId: "ann", agentId: "agent" },
      evidence: "workspaceIds is prose, not schema",
    }),
  );
  const migration = new TrackerSpaceMigration(storage.sql, storage.transactionSync, "org", [
    "repo",
  ]);
  const snapshot = () =>
    ["teams", "workspaces", "issues", "events", "timelines", "timeline_events", "receipts"].map(
      (table) => storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
    );
  return { ...storage, snapshot, migration };
}

describe("Tracker full-store Space migration", () => {
  test("fresh initialization binds real admission to exact Space and physical identity without migration receipts", async () => {
    const f = await freshTrackerStorage();
    const other = fakeDurableState({ name: "another-space" });
    const runtime = fakeDurableState({ name: "org" });
    runtime.db.exec(
      "CREATE TABLE __miniflare_do_name(name TEXT PRIMARY KEY); INSERT INTO __miniflare_do_name VALUES('org')",
    );
    try {
      expect(f.scope).toEqual({ contractVersion: 4, spaceId: "org", migrationEpoch: 0 });
      expect(Object.isFrozen(f.scope)).toBe(true);
      expect(await initializeFreshTrackerSpace(f.env, f.ctx, "org")).toEqual(f.scope);
      expect(await initializeFreshTrackerSpace(f.env, runtime.ctx, "org")).toEqual(f.scope);
      expect(runtime.db.prepare("SELECT name FROM __miniflare_do_name").get()).toEqual({
        name: "org",
      });
      expect(
        f.sql.exec("SELECT name FROM sqlite_master WHERE name='space_migration_run'").toArray(),
      ).toEqual([]);
      await expect(initializeFreshTrackerSpace(f.env, other.ctx, "org")).rejects.toThrow(
        "physical Space identity",
      );
      await expect(initializeFreshTrackerSpace(f.env, other.ctx, "another-space")).rejects.toThrow(
        "active real Space",
      );
      new TrackerStore(f.sql, f.transactionSync);
      expect(
        f.sql.exec("SELECT name FROM sqlite_master WHERE name='workspaces'").toArray(),
      ).toEqual([]);
      expect(assertTrackerSpaceOpen(f.sql)).toEqual(f.scope);
      f.sql.exec(
        "INSERT INTO receipts VALUES(?,?,?,?)",
        "fresh-operation",
        "ann",
        JSON.stringify({
          contractVersion: 4,
          spaceId: "org",
          migrationEpoch: 0,
          operationId: "fresh-operation",
          mutations: [],
        }),
        "{}",
      );
      expect(
        f.sql
          .exec("SELECT source_epoch FROM space_migration_receipt_proof WHERE id='fresh-operation'")
          .one().source_epoch,
      ).toBe(0);
    } finally {
      other.db.close();
      runtime.db.close();
      f.close();
    }
  });
  test("empty and legacy SQLite are never evidence of fresh v4 admission", () => {
    const storage = durableStorage();
    expect(() => assertTrackerSpaceOpen(storage.sql)).toThrow("independent fresh Space admission");
    expect(() => new TrackerStore(storage.sql, storage.transactionSync)).toThrow(
      "independent fresh Space admission",
    );
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray()).toEqual(
      [],
    );
    initializeLegacyTrackerForMigration(storage.sql, storage.transactionSync);
    expect(() => new TrackerStore(storage.sql, storage.transactionSync)).toThrow("Legacy Tracker");
    expect(() => initializeLegacyTrackerForMigration(storage.sql, storage.transactionSync)).toThrow(
      "untouched",
    );
    storage.db.close();
  });

  test("subscription current/history/result views convert scope but retain attribution and original proof", () => {
    const legacy = {
      id: "subscription",
      repoId: "repo",
      workspaceId: "workspace",
      owner: "org",
      createdBy: { personId: "ann", owner: "person-attribution" },
    };
    const converted = {
      id: "subscription",
      repoId: "repo",
      projectId: "workspace",
      space: "org",
      spaceId: "org",
      createdBy: legacy.createdBy,
    };
    expect(convertTrackerSpaceJson(legacy, "org")).toEqual(converted);
    expect(
      convertTrackerSpaceJson(
        { entityType: "subscription", entity: legacy, view: { entity: legacy } },
        "org",
      ),
    ).toEqual({
      entityType: "subscription",
      entity: converted,
      view: { entity: converted },
    });
    expect(convertTrackerSpaceJson({ results: [{ entity: legacy }] }, "org")).toEqual({
      results: [{ entity: converted }],
    });
    expect(() => convertTrackerSpaceJson(legacy)).toThrow("approved Space scope");
    expect(() => convertTrackerSpaceJson({ ...legacy, spaceId: "other" }, "org")).toThrow(
      "Space mismatch",
    );
    expect(convertTrackerSpaceJson({ owner: "ann", text: "workspaceIds" }, "org")).toEqual({
      owner: "ann",
      text: "workspaceIds",
    });
    const f = fixture();
    f.sql.exec(
      "INSERT INTO receipts VALUES(?,?,?,?)",
      "subscription-receipt",
      "ann",
      JSON.stringify({ mutations: [], operationId: "subscription-receipt" }),
      JSON.stringify({ results: [{ entity: legacy }] }),
    );
    const proof = f.sql
      .exec<{ actor_id: string; request: string; result: string }>(
        "SELECT actor_id,request,result FROM space_migration_receipt_proof WHERE id='subscription-receipt'",
      )
      .one();
    f.migration.inventory(context);
    f.migration.migrate(context);
    const retained = f.sql
      .exec<{ actor_id: string; request: string; result: string }>(
        "SELECT actor_id,request,result FROM space_migration_receipt_proof WHERE id='subscription-receipt'",
      )
      .one();
    expect(retained.actor_id).toBe(proof.actor_id);
    expect(retained.request).toBe(proof.request);
    expect(retained.result).toBe(proof.result);
    expect(
      JSON.parse(f.sql.exec<{ data: string }>("SELECT data FROM subscriptions").one().data),
    ).toMatchObject({ space: "org", spaceId: "org", projectId: "workspace" });
    expect(
      f.migration.reconcileOperation(context, {
        operationId: "subscription-receipt",
        actorId: "ann",
        originalRequest: JSON.parse(proof.request),
      }),
    ).toMatchObject({
      state: "committed",
      actorId: "ann",
      sourceEpoch: 0,
      originalRequest: proof.request,
      originalResult: proof.result,
      result: { results: [{ entity: converted }] },
    });
    f.db.close();
  });
  test("exports bounded recoverable pages, converts all views and restores exact original history/counters", () => {
    const f = fixture();
    const before = f.snapshot();
    const inventory = f.migration.inventory(context);
    expect(inventory.preserved).toBe(true);
    let cursor: string | null = null;
    let serialized = "";
    do {
      const page = f.migration.export(context, cursor);
      expect(new TextEncoder().encode(page.payload).byteLength).toBeLessThanOrEqual(131072);
      serialized += JSON.parse(page.payload).text;
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(serialized).toContain("secret-token");
    expect(serialized).toContain("timeline_checkpoints");
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(f.migration.migrate(context).preserved).toBe(true);
    expect(f.migration.migrate(context).preserved).toBe(true);
    expect(f.sql.exec("SELECT name FROM sqlite_master WHERE name='workspaces'").toArray()).toEqual(
      [],
    );
    expect(
      JSON.parse(
        f.sql.exec<{ data: string }>("SELECT data FROM issues WHERE id='issue'").one().data,
      ).projectIds,
    ).toEqual(["workspace"]);
    expect(
      f.sql.exec<{ data: string }>("SELECT data FROM timeline_checkpoints").one().data,
    ).toContain('"projectIds"');
    expect(
      f.sql.exec<{ data: string }>("SELECT data FROM timeline_checkpoints").one().data,
    ).toContain("workspaceIds is prose");
    expect(assertTrackerSpaceOpen(f.sql)).toEqual({
      contractVersion: 4,
      spaceId: "org",
      migrationEpoch: 1,
    });
    expect(Object.isFrozen(assertTrackerSpaceOpen(f.sql))).toBe(true);
    const woke = new TrackerSpaceMigration(f.sql, f.transactionSync, "org", ["repo"]);
    expect(woke.restore(context).preserved).toBe(true);
    // Migration fence intentionally remains closed after business restoration.
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(f.snapshot()).toEqual(before);
    expect(() => new TrackerStore(f.sql, f.transactionSync)).toThrow("Legacy Tracker");
    expect(f.sql.exec("SELECT number FROM team_numbers WHERE id='team'").one().number).toBe(1);
    expect(f.sql.exec("SELECT token FROM leases").one().token).toBe("secret-token");
    expect(f.sql.exec("SELECT name FROM __miniflare_do_name").one()).toEqual({ name: "org" });
    expect(() => f.sql.exec("DELETE FROM space_migration_ledger")).toThrow("Immutable");
    f.db.close();
  });

  test("rolls back a fault after DDL and resumes on a cold participant", () => {
    const f = fixture();
    f.migration.inventory(context);
    const failing: SqlDatabase = {
      exec(query, ...bindings) {
        if (query.startsWith('UPDATE "events"')) throw new Error("injected interruption");
        return f.sql.exec(query, ...bindings);
      },
    };
    expect(() =>
      new TrackerSpaceMigration(failing, f.transactionSync, "org", ["repo"]).migrate(context),
    ).toThrow("injected interruption");
    expect(
      f.sql.exec("SELECT name FROM sqlite_master WHERE name='workspaces'").toArray(),
    ).toHaveLength(1);
    expect(
      new TrackerSpaceMigration(f.sql, f.transactionSync, "org", ["repo"]).migrate(context)
        .preserved,
    ).toBe(true);
    expect(f.migration.restore(context).preserved).toBe(true);
    f.db.close();
  });

  test("an interrupted restoration remains closed and can restore again without losing the ledger", () => {
    const f = fixture();
    f.migration.inventory(context);
    f.migration.migrate(context);
    const failing: SqlDatabase = {
      exec(query, ...bindings) {
        if (query.startsWith("CREATE TABLE") && query.includes("workspaces"))
          throw new Error("restore interruption");
        return f.sql.exec(query, ...bindings);
      },
    };
    expect(() =>
      new TrackerSpaceMigration(failing, f.transactionSync, "org", ["repo"]).restore(context),
    ).toThrow("restore interruption");
    expect(f.migration.reconcile(context).preserved).toBe(true);
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(f.migration.restore(context).preserved).toBe(true);
    expect(
      f.sql
        .exec("SELECT phase FROM space_migration_ledger ORDER BY seq")
        .toArray()
        .map((row) => row.phase),
    ).toEqual(["prepared", "converted", "restored"]);
    f.db.close();
  });

  test("keeps committed-but-unacknowledged operation proof after receipt expiry and issue pruning", () => {
    const f = fixture();
    f.sql.exec(
      "INSERT INTO issues VALUES('prunable',?)",
      JSON.stringify({
        id: "prunable",
        key: "ENG-2",
        teamId: "team",
        status: "canceled",
        closeReason: "obsolete",
        closedAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
    );
    f.sql.exec("UPDATE team_numbers SET number=2 WHERE id='team'");
    // Match the legacy Store's canonical request encoding, without invoking v4 APIs.
    const request = {
      mutations: [
        {
          data: { closeReason: "obsolete", status: "canceled" },
          expectedVersion: 1,
          id: "prunable",
          kind: "issue.update" as const,
        },
      ],
      operationId: "unacknowledged",
    };
    f.sql.exec(
      "INSERT INTO receipts VALUES(?,?,?,?)",
      "unacknowledged",
      "ann",
      JSON.stringify(request),
      JSON.stringify({
        cursor: 1,
        results: [{ id: "prunable" }],
        events: [],
        serverTime: "2025-01-01T00:00:00Z",
      }),
    );
    const receipt = f.sql
      .exec<{ request: string; result: string }>(
        "SELECT request,result FROM receipts WHERE id='unacknowledged'",
      )
      .one();
    const expiry = { eventDays: 1, endedTimelineDays: 1 };
    expect(selectActivity(f.sql, expiry, "2026-01-01T00:00:00Z", "r:", 10).items).toContain(
      "r:unacknowledged",
    );
    expect(
      removeActivity(
        f.sql,
        expiry,
        "2026-01-01T00:00:00Z",
        ["r:unacknowledged"],
        "2026-01-01T00:00:00Z",
      ).count,
    ).toBe(1);
    expect(f.sql.exec("SELECT id FROM receipts WHERE id='unacknowledged'").toArray()).toEqual([]);
    removeClosedIssues(
      f.sql,
      { days: 1 },
      "2026-01-01T00:00:00Z",
      ["prunable"],
      "2026-01-01T00:00:00Z",
    );
    expect(f.sql.exec("SELECT id FROM issues WHERE id='prunable'").toArray()).toEqual([]);
    expect(
      f.sql.exec("SELECT id,kind,ref FROM retention_removed WHERE id='prunable'").one(),
    ).toEqual({ id: "prunable", kind: "issue", ref: "ENG-2" });
    f.migration.inventory(context);
    f.migration.migrate(context);
    const proof = f.migration.reconcileOperation(context, {
      operationId: "unacknowledged",
      actorId: "ann",
      originalRequest: JSON.parse(receipt.request),
    });
    expect(proof).toMatchObject({
      state: "committed",
      actorId: "ann",
      sourceEpoch: 0,
      originalRequest: receipt.request,
      originalResult: receipt.result,
      result: JSON.parse(receipt.result),
    });
    expect(f.sql.exec("SELECT number FROM team_numbers WHERE id='team'").one().number).toBe(2);
    expect(f.sql.exec("SELECT ref FROM retention_removed WHERE id='prunable'").one().ref).toBe(
      "ENG-2",
    );
    expect(
      f.sql.exec<{ data: string }>("SELECT data FROM issues WHERE id='issue'").one().data,
    ).toContain('"ENG-1"');
    expect(
      f.migration.reconcileOperation(context, {
        operationId: "absent-legacy-proof",
        actorId: "ann",
        originalRequest: {},
      }).state,
    ).toBe("export_required");
    expect(() =>
      f.migration.reconcileOperation(context, {
        operationId: "unacknowledged",
        actorId: "another-person",
        originalRequest: request,
      }),
    ).toThrow("actor/request");
    expect(() =>
      f.migration.reconcileOperation(context, {
        operationId: "unacknowledged",
        actorId: "ann",
        originalRequest: { ...request, mutations: [] },
      }),
    ).toThrow("actor/request");
    f.db.close();
  });

  test("only releases reconciled restoration and retains an idempotent release receipt after new legacy writes", () => {
    const f = fixture();
    f.migration.inventory(context);
    expect(() => f.migration.releaseLegacy(context)).toThrow("restored evidence");
    f.migration.migrate(context);
    expect(() => f.migration.releaseLegacy(context)).toThrow("restored evidence");
    f.migration.restore(context);
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(() => f.migration.migrate(context)).toThrow("Restored runs");
    const receipt = f.migration.releaseLegacy(context);
    expect(receipt.released).toBe(true);
    expect(() => assertTrackerLegacyOpen(f.sql)).not.toThrow();
    expect(() => new TrackerStore(f.sql, f.transactionSync)).toThrow("Legacy Tracker");
    // Only the independently approved legacy runtime can write after recovery.
    f.sql.exec(
      "INSERT INTO receipts VALUES(?,?,?,?)",
      "after-recovery",
      "ann",
      JSON.stringify({ operationId: "after-recovery", mutations: [] }),
      JSON.stringify({ cursor: 1, events: [], results: [] }),
    );
    expect(
      f.sql
        .exec("SELECT source_epoch FROM space_migration_receipt_proof WHERE id='after-recovery'")
        .one().source_epoch,
    ).toBe(1);
    expect(f.migration.releaseLegacy(context)).toEqual(receipt);
    expect(() => f.migration.restore(context)).toThrow("released");
    expect(() => f.migration.migrate(context)).toThrow("released");
    expect(() => f.migration.inventory(context)).toThrow("released");
    f.db.close();
  });

  test("a subsequent approved epoch retains every earlier checkpoint and rejects delayed prior-run calls", () => {
    const f = fixture();
    const next = { ...context, runId: "second-run", migrationEpoch: 2 };
    f.migration.inventory(context);
    const originalPages = f.sql
      .exec("SELECT * FROM space_migration_checkpoint WHERE run_id='run' ORDER BY page")
      .toArray();
    const originalRecords = f.sql
      .exec("SELECT * FROM space_migration_records WHERE run_id='run' ORDER BY id")
      .toArray();
    f.migration.restore(context);
    expect(() => f.migration.inventory(next)).toThrow("Previous run");
    f.migration.releaseLegacy(context);
    expect(() => f.migration.inventory({ ...next, migrationEpoch: 1 })).toThrow(
      "epoch must increase",
    );
    f.migration.inventory(next);
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(() => f.migration.migrate(context)).toThrow("mapping mismatch");
    expect(() => f.migration.restore(context)).toThrow("mapping mismatch");
    expect(() => f.migration.releaseLegacy(context)).toThrow("mapping mismatch");
    expect(f.migration.migrate(next).preserved).toBe(true);
    expect(f.migration.restore(next).preserved).toBe(true);
    f.migration.releaseLegacy(next);
    expect(
      f.sql
        .exec("SELECT * FROM space_migration_checkpoint WHERE run_id='run' ORDER BY page")
        .toArray(),
    ).toEqual(originalPages);
    expect(
      f.sql.exec("SELECT * FROM space_migration_records WHERE run_id='run' ORDER BY id").toArray(),
    ).toEqual(originalRecords);
    expect(
      f.sql
        .exec("SELECT migration_epoch FROM space_migration_run ORDER BY migration_epoch")
        .toArray(),
    ).toEqual([{ migration_epoch: 1 }, { migration_epoch: 2 }]);
    f.db.close();
  });

  test("recovers an untouched participant before inventory or export without rewriting business state", () => {
    const f = fixture();
    const before = f.snapshot();
    const noDestructiveSql: SqlDatabase = {
      exec(query, ...bindings) {
        if (query.startsWith("DROP TABLE") || query.startsWith("DELETE FROM"))
          throw new Error("Unexpected destructive restore");
        return f.sql.exec(query, ...bindings);
      },
    };
    const migration = new TrackerSpaceMigration(noDestructiveSql, f.transactionSync, "org", [
      "repo",
    ]);
    expect(migration.restore(context)).toMatchObject({ preserved: true, unchanged: true });
    expect(migration.restore(context)).toMatchObject({ preserved: true, unchanged: true });
    expect(f.snapshot()).toEqual(before);
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    expect(() => migration.migrate(context)).toThrow("Restored runs");
    expect(migration.releaseLegacy(context).released).toBe(true);
    expect(() => assertTrackerLegacyOpen(f.sql)).not.toThrow();
    const next = { ...context, runId: "untouched-next", migrationEpoch: 2 };
    expect(migration.restore(next)).toMatchObject({ preserved: true, unchanged: true });
    expect(migration.releaseLegacy(next).released).toBe(true);
    expect(
      f.sql.exec("SELECT run_id FROM space_migration_run ORDER BY migration_epoch").toArray(),
    ).toEqual([{ run_id: "run" }, { run_id: "untouched-next" }]);
    f.db.close();
  });

  test("modified restored evidence never releases the participant", () => {
    const f = fixture();
    f.migration.inventory(context);
    f.migration.restore(context);
    f.sql.exec("UPDATE team_numbers SET number=number+1");
    expect(() => f.migration.releaseLegacy(context)).toThrow("Restored state changed");
    expect(() => assertTrackerLegacyOpen(f.sql)).toThrow("closed");
    f.db.close();
  });

  test("carries approve-when-green, completion credit and superseded receipts exactly; legacy consent stays inert", () => {
    const f = fixture();
    // State main's legacy Tracker writes (CORE-378, CORE-220): a person's setting,
    // its event, a skipped-approval note, a stamped completion and a superseded receipt.
    f.sql.exec("INSERT INTO approval_automation VALUES('ann','2026-10-11T00:00:00.000Z')");
    const completion = { at: "2026-10-11T01:00:00.000Z", by: { id: "ann" }, agents: [] };
    f.sql.exec(
      "UPDATE issues SET data=json_set(data,'$.completion',json(?)) WHERE id='issue'",
      JSON.stringify(completion),
    );
    f.sql.exec(
      "INSERT INTO events(data) VALUES(?),(?)",
      JSON.stringify({
        entityType: "automation",
        entityId: "ann",
        kind: "automation.approveWhenGreen",
        entity: { id: "ann", approveWhenGreen: true, enabledAt: "2026-10-11T00:00:00.000Z" },
        actorId: "ann",
        operationId: "@approval-automation:ann",
      }),
      JSON.stringify({
        entityType: "request",
        entityId: "request",
        kind: "request.autoApproveSkipped",
        source: "automation",
        actorId: "ann",
        operationId: "@auto-approve-skipped:request",
      }),
    );
    f.sql.exec(
      "INSERT INTO receipts VALUES(?,?,?,?)",
      "@superseded:request",
      "ann",
      JSON.stringify({
        mutations: [{ id: "request", kind: "request.cancel" }],
        operationId: "@superseded:request",
      }),
      JSON.stringify({ cursor: 4, events: [], results: [] }),
    );
    expect(f.migration.inventory(context).preserved).toBe(true);
    expect(f.migration.migrate(context).preserved).toBe(true);
    expect(f.sql.exec("SELECT * FROM approval_automation").toArray()).toEqual([
      { person_id: "ann", enabled_at: "2026-10-11T00:00:00.000Z" },
    ]);
    expect(
      JSON.parse(
        f.sql.exec<{ data: string }>("SELECT data FROM issues WHERE id='issue'").one().data,
      ).completion,
    ).toEqual(completion);
    const kinds = f.sql
      .exec<{ data: string }>("SELECT data FROM events ORDER BY cursor")
      .toArray()
      .map((row) => JSON.parse(row.data) as { entityType: string; kind?: string });
    expect(kinds.slice(-2).map((event) => [event.entityType, event.kind])).toEqual([
      ["automation", "automation.approveWhenGreen"],
      ["request", "request.autoApproveSkipped"],
    ]);
    expect(
      f.sql.exec("SELECT actor_id FROM receipts WHERE id='@superseded:request'").one().actor_id,
    ).toBe("ann");
    // A setting saved before Spaces carries no consent authority: it acts for nobody.
    expect(new TrackerStore(f.sql, f.transactionSync).approvingWhenGreen()).toEqual([]);
    expect(f.sql.exec("SELECT count(*) AS n FROM approval_automation").one().n).toBe(1);
    f.db.close();
  });

  test("rejects identity mismatches, target collisions, unknown stores and ambiguous JSON", () => {
    const f = fixture();
    expect(() => f.migration.inventory({ ...context, spaceId: "different" })).toThrow("identity");
    f.sql.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT)");
    expect(() => f.migration.inventory(context)).toThrow("collision");
    f.sql.exec("DROP TABLE projects; CREATE TABLE unknown_scope(id TEXT)");
    expect(() => f.migration.inventory(context)).toThrow("Unrecognized table");
    expect(() => convertTrackerSpaceJson({ workspaceIds: [], projectIds: [] })).toThrow(
      "Conflicting",
    );
    expect(() => convertTrackerSpaceJson({ workspaceScope: "unknown" })).toThrow("Unknown scope");
    expect(() => convertTrackerSpaceJson({ entityType: "unknown" })).toThrow(
      "Unknown scope-bearing event",
    );
    expect(convertTrackerSpaceJson({ entityType: "automation", entityId: "ann" })).toEqual({
      entityType: "automation",
      entityId: "ann",
    });
    f.db.close();
  });
});
