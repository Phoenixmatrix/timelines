import { expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { ciSource } from "../ci/source.ts";

function fixture() {
  const sql = migratedDatabase();
  sql.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','owner','app','private','canonical','https://canonical');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,
      artifacts_name,artifacts_remote,state,initial_token_revoked,allocation_operation_id,
      fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES('work','repo','timeline','test','owner','owned','https://owned','archived',1,'allocation',
      'canonical','head','tree','refs/heads/main','canonical','head','tree','refs/heads/main','now','now');
    INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status)
      VALUES('create','repo','work',1,'head','work','manual','running');
    INSERT INTO ci_jobs(id,run_id,repo_id,source_id,name,spec,status,runner)
      VALUES('create-job','create','repo','work','create','{}','running','sandbox');
    UPDATE timeline_work_sources SET expiry_requested_at='2026-10-04';`);
  const deploy = (
    id: number,
    commit = "head",
    job: string | null = "create-job",
    timeline: string | null = "test",
  ) =>
    sql
      .prepare(`INSERT INTO deployments(id,repo_id,source_id,environment,timeline_slug,commit_oid,status,run_id,job_id,url)
      VALUES(?,'repo','work','timeline/test',?,?,'active','create',?,'https://preview')`)
      .run(id, timeline, commit, job);
  const teardown = (id: string, parent: number, commit = "head") =>
    sql
      .prepare(`INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status,preview_action,timeline_slug,preview_teardown_of)
      VALUES(?,'repo','work',(SELECT MAX(number)+1 FROM ci_runs),?,'work','manual','queued','teardown','test',?)`)
      .run(id, commit, parent);
  const roots = () =>
    sql
      .prepare(
        "SELECT consumer_kind,consumer_id FROM timeline_source_roots ORDER BY consumer_kind,consumer_id",
      )
      .all();
  return { sql, deploy, teardown, roots, env: { DB: d1(sql) } as Env };
}

test("an admitted CI output hands off only its exact source and commit, then successful teardown releases bytes not history", () => {
  const t = fixture();
  try {
    expect(() => t.deploy(1, "other")).toThrow();
    expect(() => t.deploy(1, "head", null)).toThrow();
    t.deploy(1);
    t.sql.exec(
      "UPDATE ci_jobs SET status='succeeded' WHERE id='create-job'; UPDATE ci_runs SET status='succeeded' WHERE id='create'",
    );
    expect(t.roots()).toEqual([{ consumer_kind: "deployment", consumer_id: "1" }]);
    expect(() => t.deploy(2)).toThrow();
    t.sql.exec("UPDATE deployments SET status='expired',torn_down_at='now' WHERE id=1");
    expect(() => t.teardown("wrong", 1, "other")).toThrow();
    t.teardown("cleanup", 1);
    expect(() => t.teardown("duplicate", 1)).toThrow();
    t.sql.exec(`INSERT INTO ci_jobs(id,run_id,repo_id,source_id,name,spec,status,runner)
      VALUES('cleanup-job','cleanup','repo','work','cleanup','{}','running','sandbox');
      UPDATE ci_runs SET status='succeeded',finished_at='done' WHERE id='cleanup'`);
    expect(t.roots()).toEqual([
      { consumer_kind: "ci", consumer_id: "cleanup" },
      { consumer_kind: "deployment", consumer_id: "1" },
    ]);
    t.sql.exec("UPDATE ci_jobs SET status='succeeded' WHERE id='cleanup-job'");
    expect(t.roots()).toEqual([]);
    expect(
      t.sql.prepare("SELECT status,teardown_completed_at FROM deployments WHERE id=1").get(),
    ).toEqual({ status: "expired", teardown_completed_at: "done" });
    expect(t.sql.prepare("SELECT status FROM ci_runs WHERE id='create'").get()).toEqual({
      status: "succeeded",
    });
    expect(() => t.sql.exec("UPDATE deployments SET status='active' WHERE id=1")).toThrow();
  } finally {
    t.sql.close();
  }
});

test("tombstoned work sources admit and authorize only their existing preview cleanup", async () => {
  const t = fixture();
  try {
    t.deploy(1);
    t.sql.exec(
      "UPDATE deployments SET status='expired' WHERE id=1; UPDATE repos SET deleted_at='now'",
    );
    await expect(ciSource(t.env, "repo", "work")).rejects.toThrow();
    await expect(
      ciSource(t.env, "repo", "work", { deploymentId: 1, commit: "other" }),
    ).rejects.toThrow();
    expect(
      (await ciSource(t.env, "repo", "work", { deploymentId: 1, commit: "head" })).artifacts_name,
    ).toBe("owned");
    t.teardown("cleanup", 1);
    expect((await ciSource(t.env, "repo", "work", { runId: "cleanup" })).artifacts_name).toBe(
      "owned",
    );
    await expect(ciSource(t.env, "repo", "work", { runId: "create" })).rejects.toThrow();
    expect(() => t.deploy(2)).toThrow();
    t.sql.exec("UPDATE ci_runs SET status='failed' WHERE id='cleanup'");
    await expect(ciSource(t.env, "repo", "work", { runId: "cleanup" })).rejects.toThrow();
    expect(t.roots()).toContainEqual({ consumer_kind: "deployment", consumer_id: "1" });
  } finally {
    t.sql.close();
  }
});

test("published nonpreview output retains metadata without source bytes and unmanaged teardown is not completion", () => {
  const t = fixture();
  try {
    t.deploy(1, "head", "create-job", null);
    t.deploy(2);
    t.sql.exec(
      "UPDATE deployments SET status='expired',teardown_unmanaged_at='now' WHERE id=2; UPDATE ci_jobs SET status='succeeded'; UPDATE ci_runs SET status='succeeded'",
    );
    expect(t.roots()).toEqual([]);
    expect(
      t.sql
        .prepare("SELECT teardown_completed_at,teardown_unmanaged_at FROM deployments WHERE id=2")
        .get(),
    ).toEqual({ teardown_completed_at: null, teardown_unmanaged_at: "now" });
    expect(t.sql.prepare("SELECT status FROM deployments WHERE id=1").get()).toEqual({
      status: "active",
    });
  } finally {
    t.sql.close();
  }
});
