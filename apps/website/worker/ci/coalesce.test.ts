import { afterEach, describe, expect, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "./admission.ts";
import { activeRun, inFlight, lastPassed, releaseHeld, UNCHANGED } from "./coalesce.ts";
import { ConfigError, parsePipeline } from "./config.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  cleanups.push(close);
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "org", slug: "org", displayName: "Org", kind: "company" },
    space: { id: "space", slug: "space", displayName: "Space" },
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "person",
  });
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
    VALUES('repo','space','app','private','a','https://a');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
    VALUES('credential','person','Fixture','write','fixture-hash','test');`);
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential: { kind: "token", id: "credential" },
  });
  const run = (
    number: number,
    status: string,
    options: { held?: boolean; created?: string; ref?: string } = {},
  ) =>
    sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, space_id, migration_epoch, authority, actor_id, agent_id, number, commit_oid, ref, trigger, status, held_at, created_at)
        VALUES ('run-${number}', 'repo', 'space', ${authority.migrationEpoch}, '${JSON.stringify(authority)}', 'person', NULL, ${number}, 'c${number}', '${options.ref ?? "main"}', 'push',
                '${status}', ${options.held ? `'${new Date().toISOString()}'` : "NULL"},
                '${options.created ?? new Date().toISOString()}');
    `);
  const job = (number: number, name: string, status: string, spec = "{}", error?: string) =>
    sqlite.exec(`
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, error)
        VALUES ('${name}-${number}', 'run-${number}', 'repo', '${name}', '${spec}', '${status}',
                'sandbox', ${error ? `'${error}'` : "NULL"});
    `);
  const runRow = (number: number) =>
    sqlite.prepare("SELECT status, held_at, covered_by FROM ci_runs WHERE number = ?").get(number);
  return { sqlite, db: env.DB, run, job, runRow };
}

test("identical branch and commit in different sources never share gates or held coverage", async () => {
  const c = await setup();
  c.run(1, "running");
  c.run(2, "queued", { held: true });
  c.run(3, "queued", { held: true });
  c.sqlite.exec("UPDATE ci_runs SET source_id='work_a', commit_oid='c1' WHERE number IN (2,3)");
  expect(await activeRun(c.db, "repo", "main", "c1", null, "work_b")).toBeNull();
  expect(await activeRun(c.db, "repo", "main", "c1", null, "work_a")).toMatchObject({ number: 3 });
  expect(await inFlight(c.db, "repo", "main", "none", "work_a")).toBe(0);
  expect(await releaseHeld(c.db, "repo", "main", async () => {})).toBeNull();
  const started: string[] = [];
  expect(
    await releaseHeld(
      c.db,
      "repo",
      "main",
      async (id) => {
        started.push(id);
      },
      "work_a",
    ),
  ).toBe(3);
  expect(started).toEqual(["run-3"]);
  expect(c.runRow(2)).toMatchObject({ covered_by: 3 });
  expect(c.runRow(1)).toMatchObject({ status: "running", covered_by: null });
});

describe("dedupe and load", () => {
  test("a commit in flight on its branch is found; finished runs and other branches aren't", async () => {
    const c = await setup();
    c.run(1, "running");
    c.run(2, "succeeded");
    expect(await activeRun(c.db, "repo", "main", "c1")).toMatchObject({ number: 1 });
    expect(await activeRun(c.db, "repo", "main", "c2")).toBeNull();
    expect(await activeRun(c.db, "repo", "release", "c1")).toBeNull();
  });

  test("held runs and runs stuck for hours don't count as in flight", async () => {
    const c = await setup();
    c.run(1, "running");
    c.run(2, "queued");
    c.run(3, "queued", { held: true });
    c.run(4, "running", { created: "2026-01-01T00:00:00.000Z" });
    expect(await inFlight(c.db, "repo", "main", "none")).toBe(2);
    expect(await inFlight(c.db, "repo", "main", "run-1")).toBe(1);
  });
});

describe("unchanged jobs", () => {
  test("the base is the last run where the job passed with the same spec, unchanged skips included", async () => {
    const c = await setup();
    c.run(1, "succeeded");
    c.job(1, "cli", "succeeded", '{"v":1}');
    c.run(2, "failed");
    c.job(2, "cli", "failed", '{"v":1}');
    expect(await lastPassed(c.db, "repo", "main", "cli", '{"v":1}')).toEqual({
      number: 1,
      commit: "c1",
    });
    c.run(3, "succeeded");
    c.job(3, "cli", "skipped", '{"v":1}', `${UNCHANGED}1: apps/cli matches.`);
    expect(await lastPassed(c.db, "repo", "main", "cli", '{"v":1}')).toMatchObject({ number: 3 });
    // A different spec (the job itself changed) has no base: it runs.
    expect(await lastPassed(c.db, "repo", "main", "cli", '{"v":2}')).toBeNull();
    // Skipped for another reason (an if:, a failed dependency) isn't a pass.
    c.run(4, "succeeded");
    c.job(4, "cli", "skipped", '{"v":1}', "Skipped because check did not succeed.");
    expect(await lastPassed(c.db, "repo", "main", "cli", '{"v":1}')).toMatchObject({ number: 3 });
  });
});

describe("releasing held runs", () => {
  test("the newest held run starts and covers the older ones", async () => {
    const c = await setup();
    c.run(1, "running");
    for (const n of [2, 3, 4]) {
      c.run(n, "queued", { held: true });
      c.job(n, "check", "pending");
    }
    const started: string[] = [];
    expect(
      await releaseHeld(c.db, "repo", "main", async (id) => {
        started.push(id);
      }),
    ).toBe(4);
    expect(started).toEqual(["run-4"]);
    expect(c.runRow(4)).toMatchObject({ status: "queued", held_at: null, covered_by: null });
    expect(c.runRow(2)).toMatchObject({ status: "cancelled", covered_by: 4 });
    expect(c.runRow(3)).toMatchObject({ status: "cancelled", covered_by: 4 });
    expect(c.sqlite.prepare("SELECT status FROM ci_jobs WHERE id = 'check-2'").get()).toEqual({
      status: "cancelled",
    });
    // Nothing left to release.
    expect(await releaseHeld(c.db, "repo", "main", async () => {})).toBeNull();
  });

  test("a start that fails puts the run back on hold and covers nothing", async () => {
    const c = await setup();
    c.run(1, "queued", { held: true });
    c.run(2, "queued", { held: true });
    await expect(
      releaseHeld(c.db, "repo", "main", async () => {
        throw new Error("no workflow");
      }),
    ).rejects.toThrow("no workflow");
    expect(c.runRow(2)).toMatchObject({ status: "queued", covered_by: null });
    expect((c.runRow(2) as { held_at: string | null }).held_at).not.toBeNull();
    expect(c.runRow(1)).toMatchObject({ status: "queued", covered_by: null });
  });
});

describe("config", () => {
  test("paths are files or directories, and coalesce_after a sensible count", () => {
    const parse = (extra: string, push = "{}") =>
      parsePipeline(`on:\n  push: ${push}\njobs:\n  a:\n    steps: [echo]\n${extra}`);
    expect(parse("    paths: [apps/cli/, README.md]\n").jobs[0]!.paths).toEqual([
      "apps/cli",
      "README.md",
    ]);
    expect(() => parse("    paths: ['apps/*']\n")).toThrow(ConfigError);
    expect(() => parse("    paths: [../escape]\n")).toThrow(ConfigError);
    expect(parse("", "{ coalesce_after: 3 }").coalesceAfter).toBe(3);
    expect(parse("").coalesceAfter).toBeNull();
    expect(() => parse("", "{ coalesce_after: 0 }")).toThrow(/coalesce_after/);
  });
});
