import { afterEach, describe, expect, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "./admission.ts";
import { concurrencyGate } from "./concurrency.ts";

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
    VALUES('repo','space','app','private','a','https://a'),
          ('other','space','site','private','b','https://b');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
    VALUES('credential','person','Fixture','write','fixture-hash','test');`);
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential: { kind: "token", id: "credential" },
  });
  /** A run with a deploy job in the "production" group, in the given state. */
  const run = (number: number, status: string, repo = "repo", ref = "main") => {
    sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, space_id, migration_epoch, authority, actor_id, agent_id, number, commit_oid, ref, trigger, status)
        VALUES ('run-${repo}-${number}', '${repo}', 'space', ${authority.migrationEpoch}, '${JSON.stringify(authority)}', 'person', NULL, ${number}, 'c${number}', '${ref}', 'push', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner)
        VALUES ('deploy-${repo}-${number}', 'run-${repo}-${number}', '${repo}', 'deploy',
                '{"concurrency":"production"}', '${status}', 'sandbox');
    `);
  };
  const gate = (number: number, repo = "repo") =>
    concurrencyGate(env.DB, `run-${repo}-${number}`, `deploy-${repo}-${number}`, "production");
  const finish = (number: number, repo = "repo") =>
    sqlite.exec(`UPDATE ci_jobs SET status = 'succeeded' WHERE id = 'deploy-${repo}-${number}'`);
  return { sqlite, run, gate, finish };
}

describe("concurrency groups", () => {
  test("one job of a group runs at a time per repository; others wait for the slot", async () => {
    const c = await setup();
    c.run(1, "queued");
    c.run(1, "queued", "other");
    expect(await c.gate(1)).toEqual({ kind: "go" });
    // Another repository's group is its own.
    expect(await c.gate(1, "other")).toEqual({ kind: "go" });
    c.run(2, "queued", "repo", "release");
    expect(await c.gate(2)).toEqual({ kind: "wait" });
    c.finish(1);
    expect(await c.gate(2)).toEqual({ kind: "go" });
  });

  test("a newer run on the branch supersedes a waiting one, even before it's queued", async () => {
    const c = await setup();
    c.run(1, "queued");
    c.run(2, "pending");
    expect(await c.gate(1)).toEqual({ kind: "superseded", by: 2 });
    // A newer run whose deploy was skipped (its tests failed) supersedes nothing.
    const d = await setup();
    d.run(1, "queued");
    d.run(2, "skipped");
    expect(await d.gate(1)).toEqual({ kind: "go" });
  });

  test("a cancelled run gives up its turn", async () => {
    const c = await setup();
    c.run(1, "queued");
    c.sqlite.exec("UPDATE ci_runs SET status = 'cancelled' WHERE id = 'run-repo-1'");
    expect(await c.gate(1)).toEqual({ kind: "cancelled" });
  });
});
