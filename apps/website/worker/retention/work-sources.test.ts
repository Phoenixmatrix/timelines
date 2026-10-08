import { describe, expect, test, vi } from "vite-plus/test";
import { migratedDatabase, d1 } from "../testing/d1.ts";
import {
  drainDeletedRepoSources,
  expireArchivedSources,
  pinSourceRoot,
  releaseSourceRoots,
} from "./work-sources.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore } from "../tracker/store.ts";
import { initializeWorkSource, resolveSource } from "../timelines/sources.ts";
import { selectRepos } from "../db.ts";
import { timelineWorkSources } from "./cleanups/work-sources.ts";
import { removeActivity } from "../tracker/retention.ts";

const tracker = vi.hoisted(() => ({
  transitionWorkSource: vi.fn(),
  getWorkSource: vi.fn(),
  reconcileDeletedSource: vi.fn(),
  sourcePushes: vi.fn(),
  sourcePush: vi.fn(),
  reserveWorkSource: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => tracker }));

function fixture() {
  const sql = migratedDatabase();
  const durable = durableStorage();
  const store = new TrackerStore(durable.sql, durable.transactionSync);
  tracker.reconcileDeletedSource.mockResolvedValue({
    ok: false,
    error: "provider outcome unknown",
  });
  tracker.sourcePushes.mockResolvedValue({ ok: true, value: [] });
  tracker.sourcePush.mockImplementation((operationId: string, repoId: string, sourceId: string) => {
    try {
      return { ok: true, value: store.timelines.sourcePush(operationId, repoId, sourceId) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  tracker.transitionWorkSource.mockImplementation(
    (
      sourceId: string,
      version: number,
      state: Parameters<typeof store.timelines.transitionWorkSource>[2],
    ) => {
      try {
        return { ok: true, value: store.timelines.transitionWorkSource(sourceId, version, state) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  );
  tracker.getWorkSource.mockImplementation((sourceId: string) => ({
    ok: true,
    value: store.timelines.getWorkSource(sourceId),
  }));
  sql.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES ('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote,default_branch)
      VALUES ('repo','owner','repo','private','canonical','https://example/canonical','main'),
             ('foreign','owner','foreign','private','foreign','https://example/foreign','main');`);
  const names = new Set(["canonical", "owned", "foreign-owned"]);
  let crash = false;
  const env = {
    DB: d1(sql),
    ARTIFACTS: {
      delete: async (name: string) => {
        const deleted = names.delete(name);
        if (crash) {
          crash = false;
          throw new Error("crash after provider deletion");
        }
        if (!deleted) throw Object.assign(new Error("Already absent"), { code: "NOT_FOUND" });
        return deleted;
      },
    },
  } as Env;
  const add = (source = "work_owned", repo = "repo", state = "archived", name = "owned") => {
    sql
      .prepare(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,state,allocation_operation_id,
       fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,archived_at,archive_disposition)
      VALUES (?,?,?,'timeline','owner',?,?,?,'canonical','head','tree','refs/heads/main','canonical','head','tree','refs/heads/main',?,?,?,'abandoned')`)
      .run(
        source,
        repo,
        `timeline-${source}`,
        name,
        state,
        `allocation-${source}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const row = sql.prepare("SELECT * FROM timeline_work_sources WHERE source_id=?").get(source);
    durable.db
      .prepare(
        "INSERT INTO timeline_source_allocations(source_id,timeline_id,repo_id,data) VALUES (?,?,?,?)",
      )
      .run(source, `timeline-${source}`, repo, JSON.stringify(row));
  };
  add();
  add("work_foreign", "foreign", "archived", "foreign-owned");
  const state = () =>
    sql.prepare("SELECT state FROM timeline_work_sources WHERE source_id='work_owned'").get()
      ?.state;
  return {
    sql,
    durable,
    env,
    names,
    add,
    state,
    crashNext: () => {
      crash = true;
    },
  };
}

describe("owned source retention", () => {
  test("landed and abandoned byte deadlines are strict and independent of Tracker detail", async () => {
    const f = fixture();
    f.sql.exec(
      "UPDATE timeline_work_sources SET archive_disposition='landed' WHERE source_id='work_owned'",
    );
    const ctx = {
      env: f.env,
      target: { scope: "account" as const, accountId: "owner" },
      thresholds: { landedDays: 30, abandonedDays: 90 },
      now: new Date("2026-01-31T00:00:00.000Z"),
      limit: 100,
    };
    expect((await timelineWorkSources.select(ctx, null)).items).toEqual([]);
    ctx.now = new Date("2026-01-31T00:00:00.001Z");
    const landed = await timelineWorkSources.select(ctx, null);
    expect(landed.items).toEqual(["timeline-work_owned"]);
    expect(await timelineWorkSources.remove(ctx, landed.items)).toEqual({ count: 1, bytes: 0 });
    expect(f.names.has("owned")).toBe(false);
    expect(f.names.has("foreign-owned")).toBe(true);
    ctx.now = new Date("2026-04-01T00:00:00.000Z");
    expect((await timelineWorkSources.select(ctx, null)).items).toEqual([]);
    ctx.now = new Date("2026-04-01T00:00:00.001Z");
    const abandoned = await timelineWorkSources.select(ctx, null);
    expect(abandoned.items).toEqual(["timeline-work_foreign"]);
    await timelineWorkSources.remove(ctx, abandoned.items);
    expect(f.names.has("foreign-owned")).toBe(false);
    expect(f.names.has("canonical")).toBe(true);
    f.sql.close();
    f.durable.db.close();
  });

  test("missing end evidence never permits source deletion", async () => {
    const f = fixture();
    f.sql.exec("UPDATE timeline_work_sources SET archive_disposition=NULL");
    f.durable.db.exec(
      "UPDATE timeline_source_allocations SET data=json_remove(data,'$.archive_disposition')",
    );
    await expireArchivedSources(
      f.env,
      "owner",
      {
        landed: "2027-01-01T00:00:00.000Z",
        abandoned: "2027-01-01T00:00:00.000Z",
      },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("archived");
    expect(f.names.has("owned")).toBe(true);
    f.sql.close();
    f.durable.db.close();
  });

  test("legacy end evidence survives detail removal before independent Git expiry", async () => {
    const f = fixture();
    // Its commits' mentions go with the source; main's stay (CORE-296).
    f.sql
      .exec(`INSERT INTO commit_issue_mentions (repo_id, commit_oid, issue_key, resolution, source_id)
      VALUES ('repo', 'w1', 'CORE-9', 'linked', 'work_owned'),
             ('repo', 'c1', 'CORE-9', 'linked', 'canonical')`);
    f.sql.exec(
      "UPDATE timeline_work_sources SET archive_disposition=NULL WHERE source_id='work_owned'",
    );
    f.durable.db.exec(
      "UPDATE timeline_source_allocations SET data=json_remove(data,'$.archive_disposition')",
    );
    f.durable.db.prepare("INSERT INTO timelines(id,data) VALUES (?,?)").run(
      "timeline-work_owned",
      JSON.stringify({
        id: "timeline-work_owned",
        slug: "timeline",
        status: "abandoned",
        repos: [],
        endedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    removeActivity(
      f.durable.sql,
      { eventDays: 365, endedTimelineDays: 1 },
      "2026-01-03T00:00:00.000Z",
      ["t:timeline-work_owned"],
      "2026-01-03T00:00:00.000Z",
    );
    expect(f.durable.db.prepare("SELECT id FROM timelines").all()).toEqual([]);
    await expireArchivedSources(
      f.env,
      "owner",
      {
        landed: "2026-03-02T00:00:00.000Z",
        abandoned: "2026-01-01T00:00:00.000Z",
      },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("archived");
    expect(f.names.has("owned")).toBe(true);
    await expireArchivedSources(
      f.env,
      "owner",
      {
        landed: "2026-03-02T00:00:00.001Z",
        abandoned: "2026-01-01T00:00:00.001Z",
      },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("purged");
    expect(f.names.has("owned")).toBe(false);
    expect(f.sql.prepare("SELECT commit_oid, source_id FROM commit_issue_mentions").all()).toEqual([
      { commit_oid: "c1", source_id: "canonical" },
    ]);
    f.sql.close();
    f.durable.db.close();
  });

  test("expiry fences new claims while an admitted job keeps reading and retrying", async () => {
    const f = fixture();
    f.sql.exec(`UPDATE timeline_work_sources SET artifacts_remote='https://example/owned',
      initial_token_revoked=1 WHERE source_id='work_owned'`);
    const root = {
      repoId: "repo",
      sourceId: "work_owned",
      consumerKind: "knowledge-build",
      consumerId: "pending-build",
      commit: "head",
    };
    await pinSourceRoot(f.env, root);
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("archived");
    expect(f.names.has("owned")).toBe(true);
    const fence = f.sql
      .prepare("SELECT expiry_requested_at FROM timeline_work_sources WHERE source_id=?")
      .get(root.sourceId)?.expiry_requested_at;
    expect(fence).toEqual(expect.any(String));
    await pinSourceRoot(f.env, root);
    await expect(pinSourceRoot(f.env, { ...root, consumerId: "new-build" })).rejects.toThrow(
      "expired",
    );
    await expect(pinSourceRoot(f.env, { ...root, commit: "different" })).rejects.toThrow("expired");
    expect(() =>
      f.sql
        .prepare(`INSERT INTO timeline_source_roots
      (repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
      VALUES ('repo','work_owned','knowledge-build','sql-build','head','now')`)
        .run(),
    ).toThrow("expired");
    expect(() =>
      f.sql
        .prepare(`UPDATE timeline_source_roots SET commit_oid='different'
      WHERE consumer_id='pending-build'`)
        .run(),
    ).toThrow("expired");
    const repo = await selectRepos(f.env.DB, "owner")
      .where("r.id", "=", "repo")
      .executeTakeFirstOrThrow();
    expect((await resolveSource(f.env, repo, root.sourceId)).repo.artifacts_name).toBe("owned");

    // Replaying the actual Tracker projection must retain the D1-only fence.
    const row = f.sql
      .prepare("SELECT * FROM timeline_work_sources WHERE source_id=?")
      .get(root.sourceId)!;
    tracker.reserveWorkSource.mockResolvedValue({
      ok: true,
      value: { ...row, expiry_requested_at: null },
    });
    await initializeWorkSource(f.env, repo, {
      timelineId: "timeline-work_owned",
      timelineSlug: "timeline",
      base: {
        sourceId: "canonical",
        repoId: "repo",
        timelineId: null,
        kind: "canonical",
        ref: "refs/heads/main",
        commit: "head",
        tree: "tree",
      },
    });
    expect(
      f.sql
        .prepare("SELECT expiry_requested_at FROM timeline_work_sources WHERE source_id=?")
        .get(root.sourceId)?.expiry_requested_at,
    ).toBe(fence);
    expect(() =>
      f.sql
        .prepare("UPDATE timeline_work_sources SET expiry_requested_at=NULL WHERE source_id=?")
        .run(root.sourceId),
    ).toThrow("cannot be cleared");
    await releaseSourceRoots(f.env, root.consumerKind, root.consumerId);
    await expect(pinSourceRoot(f.env, root)).rejects.toThrow("expired");
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("purged");
    expect(f.names.has("owned")).toBe(false);
    f.sql.close();
    f.durable.db.close();
  });

  test("an unresolved operation is fenced before reconciliation fails", async () => {
    const f = fixture();
    f.sql.exec(`INSERT INTO source_operations
      (id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
      VALUES ('push','owner','timeline-work_owned','repo','work_owned','push','ambiguous','{}','now','now')`);
    await expect(
      expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        ["timeline-work_owned"],
      ),
    ).rejects.toThrow();
    expect(f.state()).toBe("archived");
    expect(f.names.has("owned")).toBe(true);
    await expect(
      pinSourceRoot(f.env, {
        repoId: "repo",
        sourceId: "work_owned",
        consumerKind: "knowledge-build",
        consumerId: "new-build",
        commit: "head",
      }),
    ).rejects.toThrow("expired");
    f.sql.close();
    f.durable.db.close();
  });
  test.each(["ready", "archived"])(
    "policy expiry leaves %s nonexpired sources open",
    async (state) => {
      const f = fixture();
      f.sql
        .prepare(
          "UPDATE timeline_work_sources SET state=?,archived_at=? WHERE source_id='work_owned'",
        )
        .run(state, state === "ready" ? null : "2026-08-01T00:00:00.000Z");
      await expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        ["timeline-work_owned"],
      );
      expect(
        f.sql
          .prepare(
            "SELECT expiry_requested_at FROM timeline_work_sources WHERE source_id='work_owned'",
          )
          .get()?.expiry_requested_at,
      ).toBeNull();
      await pinSourceRoot(f.env, {
        repoId: "repo",
        sourceId: "work_owned",
        consumerKind: "knowledge-build",
        consumerId: "new-build",
        commit: "head",
      });
      expect(f.state()).toBe(state);
      expect(f.names.has("owned")).toBe(true);
      f.sql.close();
      f.durable.db.close();
    },
  );

  test("archive cutoff and consumer roots protect Git, then expiry retries an ambiguous delete", async () => {
    const f = fixture();
    const root = {
      repoId: "repo",
      sourceId: "work_owned",
      consumerKind: "dependency",
      consumerId: "child",
      commit: "head",
    };
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2025-12-31T00:00:00.000Z", abandoned: "2025-12-31T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("archived");
    await pinSourceRoot(f.env, root);
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.names.has("owned")).toBe(true);
    await releaseSourceRoots(f.env, "dependency", "child");
    f.crashNext();
    await expect(
      expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        ["timeline-work_owned"],
      ),
    ).rejects.toThrow("crash after provider deletion");
    expect(f.state()).toBe("purging");
    await expect(pinSourceRoot(f.env, root)).rejects.toThrow("expired");
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("purged");
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned"]);
    f.sql.close();
    f.durable.db.close();
  });

  test("canonical tombstone waits for CI source claims before physical deletion", async () => {
    const f = fixture();
    f.sql.exec(`INSERT INTO ci_runs
      (id,repo_id,number,commit_oid,ref,trigger,status,source_id)
      VALUES ('run','repo',1,'head','work','push','running','work_owned');
      UPDATE repos SET deleted_at='2026-10-04' WHERE id='repo';`);
    await expect(drainDeletedRepoSources(f.env, "repo")).rejects.toThrow();
    expect(f.state()).toBe("archived");
    expect(f.names.has("owned")).toBe(true);
    // No child was dispatched; cancellation closes this admitted run's claim.
    f.sql.exec("UPDATE ci_runs SET status='cancelled' WHERE id='run'");
    await drainDeletedRepoSources(f.env, "repo");
    expect(f.state()).toBe("purged");
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned"]);
    f.sql.close();
    f.durable.db.close();
  });

  test("canonical tombstone drains ambiguous operations and fork creation before deleting only owned forks", async () => {
    const f = fixture();
    await expect(drainDeletedRepoSources(f.env, "repo")).rejects.toThrow("live repository");
    f.sql.exec(`UPDATE repos SET deleted_at='2026-10-04' WHERE id='repo';
      INSERT INTO source_operations(id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
      VALUES ('push','owner','timeline-work_owned','repo','work_owned','push','ambiguous','{}','now','now');`);
    await expect(drainDeletedRepoSources(f.env, "repo")).rejects.toThrow();
    expect(f.names.has("owned")).toBe(true);
    f.sql.exec(
      "UPDATE source_operations SET state='accepted'; UPDATE timeline_work_sources SET state='creating' WHERE repo_id='repo'",
    );
    await expect(drainDeletedRepoSources(f.env, "repo")).rejects.toThrow(
      "creation is still draining",
    );
    f.sql.exec("UPDATE timeline_work_sources SET state='reserved' WHERE repo_id='repo'");
    f.crashNext();
    await expect(drainDeletedRepoSources(f.env, "repo")).rejects.toThrow(
      "crash after provider deletion",
    );
    await drainDeletedRepoSources(f.env, "repo");
    expect(f.state()).toBe("purged");
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned"]);
    f.sql.close();
    f.durable.db.close();
  });

  test("a crash after the authoritative purge converges without another provider deletion", async () => {
    const f = fixture();
    f.sql.exec(`CREATE TRIGGER fail_projection BEFORE UPDATE ON timeline_work_sources
      WHEN NEW.state='purged' BEGIN SELECT RAISE(ABORT,'projection interrupted'); END;`);
    await expect(
      expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        ["timeline-work_owned"],
      ),
    ).rejects.toThrow("projection interrupted");
    expect(f.state()).toBe("purging");
    f.sql.exec("DROP TRIGGER fail_projection");
    // Would throw if recovery unnecessarily called the provider again.
    f.crashNext();
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      ["timeline-work_owned"],
    );
    expect(f.state()).toBe("purged");
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned"]);
    f.sql.close();
    f.durable.db.close();
  });

  test("inventory drift cannot delete a foreign provider repository", async () => {
    const f = fixture();
    f.sql.exec(
      "UPDATE timeline_work_sources SET artifacts_name='unowned-name' WHERE source_id='work_owned'",
    );
    f.names.add("unowned-name");
    await expect(
      expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        ["timeline-work_owned"],
      ),
    ).rejects.toThrow("ownership mismatch");
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned", "owned", "unowned-name"]);
    f.sql.close();
    f.durable.db.close();
  });

  test.each(["dependency", "knowledge-build"])(
    "expired dependency cycles remain protected by an external %s root, then drain together",
    async (consumerKind) => {
      const f = fixture();
      const owned = { repoId: "repo", sourceId: "work_owned", commit: "head" };
      const foreign = { repoId: "foreign", sourceId: "work_foreign", commit: "head" };
      await pinSourceRoot(f.env, {
        ...owned,
        consumerKind: "dependency",
        consumerId: "timeline-work_foreign",
      });
      await pinSourceRoot(f.env, {
        ...foreign,
        consumerKind: "dependency",
        consumerId: "timeline-work_owned",
      });
      await pinSourceRoot(f.env, { ...owned, consumerKind, consumerId: "live-consumer" });
      const timelines = ["timeline-work_owned", "timeline-work_foreign"];
      await expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        timelines,
      );
      expect([...f.names].sort()).toEqual(["canonical", "foreign-owned", "owned"]);
      expect(f.state()).toBe("archived");
      await releaseSourceRoots(f.env, consumerKind, "live-consumer");
      const remove = f.env.ARTIFACTS.delete.bind(f.env.ARTIFACTS);
      f.env.ARTIFACTS.delete = async (name: string) => {
        await expect(
          pinSourceRoot(f.env, {
            ...foreign,
            consumerKind: "knowledge-build",
            consumerId: "too-late",
          }),
        ).rejects.toThrow();
        return remove(name);
      };
      await expireArchivedSources(
        f.env,
        "owner",
        { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
        timelines,
      );
      expect([...f.names]).toEqual(["canonical"]);
      expect(
        f.sql.prepare("SELECT source_id,state FROM timeline_work_sources ORDER BY source_id").all(),
      ).toEqual([
        { source_id: "work_foreign", state: "purged" },
        { source_id: "work_owned", state: "purged" },
      ]);
      expect(f.sql.prepare("SELECT * FROM timeline_source_roots").all()).toEqual([]);
      f.sql.close();
      f.durable.db.close();
    },
  );

  test("an unexpired member protects the whole dependency cycle", async () => {
    const f = fixture();
    await pinSourceRoot(f.env, {
      repoId: "repo",
      sourceId: "work_owned",
      commit: "head",
      consumerKind: "dependency",
      consumerId: "timeline-work_foreign",
    });
    await pinSourceRoot(f.env, {
      repoId: "foreign",
      sourceId: "work_foreign",
      commit: "head",
      consumerKind: "dependency",
      consumerId: "timeline-work_owned",
    });
    f.sql.exec(
      "UPDATE timeline_work_sources SET archived_at='2026-08-01T00:00:00.000Z' WHERE source_id='work_foreign'",
    );
    const timelines = ["timeline-work_owned", "timeline-work_foreign"];
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-07-01T00:00:00.000Z", abandoned: "2026-07-01T00:00:00.000Z" },
      timelines,
    );
    expect([...f.names].sort()).toEqual(["canonical", "foreign-owned", "owned"]);
    expect(
      f.sql.prepare("SELECT consumer_id FROM timeline_source_roots ORDER BY consumer_id").all(),
    ).toEqual([{ consumer_id: "timeline-work_foreign" }, { consumer_id: "timeline-work_owned" }]);
    await expireArchivedSources(
      f.env,
      "owner",
      { landed: "2026-09-01T00:00:00.000Z", abandoned: "2026-09-01T00:00:00.000Z" },
      timelines,
    );
    expect([...f.names]).toEqual(["canonical"]);
    f.sql.close();
    f.durable.db.close();
  });
});
