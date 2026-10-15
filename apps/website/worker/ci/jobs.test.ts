import { afterEach, expect, test, vi } from "vite-plus/test";
import { issueToken } from "../api/tokens.ts";
import { d1 } from "../testing/d1.ts";
import { freshInstallationDatabases, seedSpaceFixture } from "../testing/spaces.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { claim, jobPayload, loadJob, report } from "./jobs.ts";
import { mintJobToken } from "./registry.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

async function fixture() {
  const fresh = await freshInstallationDatabases();
  const { sqlite, registry } = fresh;
  const sendEvent = vi.fn(async () => {});
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    CI_RUN: { get: async () => ({ sendEvent }) },
  } as unknown as Env;
  const admission = installCutoverTestControl(env, fresh.control);
  dispose.push(
    () => sqlite.close(),
    () => registry.close(),
    admission.close,
  );
  await initializeFreshSpaceInstallation(env);
  sqlite.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person');
    INSERT INTO agents(id,name,accountable_id) VALUES('agent','agent','person');`);
  await seedSpaceFixture(env.DB, {
    organization: { id: "organization", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "space", slug: "general", displayName: "General" },
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "member", repositoryRole: "write", packageRole: "none" },
      },
    ],
    actorId: "person",
  });
  const token = await issueToken(env.DB, "person", "initiator", "write", undefined, "agent");
  const epoch = admission.control.admission(4).epoch;
  const authority = {
    spaceId: "space",
    migrationEpoch: epoch,
    personId: "person",
    agentId: "agent",
    credential: { kind: "token", id: token.id },
  };
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
    VALUES('repo','space','app','private','opaque-root','https://artifacts.test/root');
    INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status,actor_id,agent_id)
    VALUES('run','repo',1,'head','main','manual','running','person','agent');
    INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner)
    VALUES('job','run','repo','build','{"secrets":["SECRET"],"env":{},"needs":[],"steps":[],"timeoutMinutes":5}','queued','local');
    INSERT INTO ci_secrets(repo_id,name,value) VALUES('repo','SECRET','private-secret');`);
  sqlite
    .prepare("UPDATE ci_runs SET space_id=?,migration_epoch=?,authority=? WHERE id='run'")
    .run("space", epoch, JSON.stringify(authority));
  return { sqlite, env, token, sendEvent };
}

test.each(["grant", "membership", "credential", "agent", "epoch"])(
  "%s revocation denies consumption, secrets, tokens and publication but settles stopped work",
  async (kind) => {
    const t = await fixture();
    expect(await claim(t.env, "job", "person/runner")).toBe(true);
    await mintJobToken(t.env, "job", 5);
    const job = (await loadJob(t.env.DB, "job"))!;
    expect(
      (await jobPayload(t.env, job, { origin: "https://gm.test", token: "gmj_test" })).env.SECRET,
    ).toBe("private-secret");
    if (kind === "grant") t.sqlite.exec("DELETE FROM space_grants");
    if (kind === "membership") t.sqlite.exec("DELETE FROM organization_members");
    if (kind === "credential")
      t.sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(t.token.id);
    if (kind === "agent") t.sqlite.exec("UPDATE agents SET revoked_at='2026-01-01'");
    if (kind === "epoch") t.sqlite.exec("UPDATE ci_runs SET migration_epoch=migration_epoch+1");
    await expect(claim(t.env, "job", "person/runner")).rejects.toThrow();
    await expect(mintJobToken(t.env, "job", 5)).rejects.toThrow();
    await expect(
      jobPayload(t.env, job, { origin: "https://gm.test", token: "gmj_test" }),
    ).rejects.toThrow();
    await expect(
      report(t.env, "job", { logs: [{ step: 0, text: "forbidden output" }] }),
    ).resolves.toEqual({ cancelled: true });
    expect(
      t.sqlite.prepare("SELECT status,source_completion_pending FROM ci_jobs WHERE id='job'").get(),
    ).toEqual({ status: "running", source_completion_pending: 1 });
    await expect(report(t.env, "job", { done: { status: "succeeded" } })).resolves.toEqual({
      cancelled: true,
    });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_logs").get()).toEqual({ n: 0 });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_job_tokens").get()).toEqual({ n: 0 });
    expect(
      t.sqlite.prepare("SELECT status,source_completion_pending FROM ci_jobs WHERE id='job'").get(),
    ).toEqual({ status: "cancelled", source_completion_pending: 0 });
    expect(t.sendEvent).toHaveBeenCalledWith({
      type: "job-done-build",
      payload: { status: "cancelled" },
    });
  },
);
