import { expect, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { ciSource } from "../ci/source.ts";

async function fixture() {
  const { sqlite: sql, env, close } = await createFreshSpaceTestEnvironment();
  sql.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "org", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "space", slug: "owner", displayName: "Owner" },
    actorId: "person",
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sql.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','space','app','private','canonical','https://canonical')`);
  const token = await issueToken(env.DB, "person", "work", "write");
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential: { kind: "token", id: token.id },
  });
  sql.exec(`
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,
      artifacts_name,artifacts_remote,state,initial_token_revoked,allocation_operation_id,
      fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES('work','repo','timeline','test','space','owned','https://owned','archived',1,'allocation',
      'canonical','head','tree','refs/heads/main','canonical','head','tree','refs/heads/main','now','now');
    INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status,space_id,migration_epoch,actor_id,authority)
      VALUES('create','repo','work',1,'head','work','manual','running','space',${authority.migrationEpoch},'person','${JSON.stringify(authority)}');
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
      .prepare(`INSERT INTO deployments(id,repo_id,source_id,environment,timeline_slug,commit_oid,status,run_id,job_id,url,authority)
      VALUES(?,'repo','work','timeline/test',?,?,'active','create',?,'https://preview',?)`)
      .run(id, timeline, commit, job, JSON.stringify(authority));
  const teardown = (id: string, parent: number, commit = "head") =>
    sql
      .prepare(`INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status,preview_action,timeline_slug,preview_teardown_of,space_id,migration_epoch,actor_id,authority)
      VALUES(?,'repo','work',(SELECT MAX(number)+1 FROM ci_runs),?,'work','manual','queued','teardown','test',?,'space',?,'person',?)`)
      .run(id, commit, parent, authority.migrationEpoch, JSON.stringify(authority));
  const roots = () =>
    sql
      .prepare(
        "SELECT consumer_kind,consumer_id FROM timeline_source_roots ORDER BY consumer_kind,consumer_id",
      )
      .all();
  return { sql, deploy, teardown, roots, env, close };
}

test("an admitted CI output hands off only its exact source and commit, then successful teardown releases bytes not history", async () => {
  const t = await fixture();
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
    t.close();
  }
});

test("tombstoned work sources admit and authorize only their existing preview cleanup", async () => {
  const t = await fixture();
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
    t.close();
  }
});

test("published nonpreview output retains metadata without source bytes and unmanaged teardown is not completion", async () => {
  const t = await fixture();
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
    t.close();
  }
});
