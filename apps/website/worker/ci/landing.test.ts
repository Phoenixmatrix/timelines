import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "./admission.ts";
import { landingJob } from "./landing.ts";
import { COMPACT_SCRIPT } from "./compact-script.ts";
import { mintJobToken } from "./registry.ts";
import { issueToken } from "../api/tokens.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const close of cleanups.splice(0)) close();
});
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: identity, encoding: "utf8" }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compact-landing-"));
  dirs.push(root);
  const canonical = join(root, "repo.git");
  const source = join(root, "repo@search.git");
  const local = join(root, "local");
  git(root, "init", "--quiet", "--bare", "-b", "main", canonical);
  git(root, "clone", "--quiet", canonical, local);
  writeFileSync(join(local, "base"), "baseline\n");
  git(local, "add", ".");
  git(local, "commit", "--quiet", "-m", "baseline");
  const base = git(local, "rev-parse", "HEAD");
  git(local, "push", "--quiet", "origin", "HEAD:main");
  git(root, "clone", "--quiet", "--bare", canonical, source);
  const commit = (file: string, value: string) => {
    writeFileSync(join(local, file), value);
    git(local, "add", ".");
    git(local, "commit", "--quiet", "-m", file);
    return git(local, "rev-parse", "HEAD");
  };
  const prepare = (snapshot: string, logical: string, main: string) => {
    git(local, "push", "--quiet", "--force", source, `${snapshot}:refs/heads/work`);
    const current = spawnSync("git", ["rev-parse", "refs/heads/gitmatrix/landing/test"], {
      cwd: canonical,
      encoding: "utf8",
    });
    return spawnSync("bash", ["-c", COMPACT_SCRIPT], {
      cwd: local,
      encoding: "utf8",
      env: {
        ...identity,
        GITMATRIX_URL: `file://${root}`,
        GITMATRIX_REPOSITORY: "repo",
        GITMATRIX_TOKEN: "local-test",
        GITMATRIX_COMMIT: snapshot,
        GITMATRIX_LANDING_SOURCE: "work_test",
        GITMATRIX_LANDING_TIMELINE: "search",
        GITMATRIX_LANDING_SOURCE_TREE: git(local, "rev-parse", `${snapshot}^{tree}`),
        GITMATRIX_LANDING_LOGICAL_COMMIT: logical,
        GITMATRIX_LANDING_LOGICAL_TREE: git(local, "rev-parse", `${logical}^{tree}`),
        GITMATRIX_LANDING_BASE: main,
        GITMATRIX_LANDING_BRANCH: "gitmatrix/landing/test",
        GITMATRIX_LANDING_OLD: current.status === 0 ? current.stdout.trim() : "",
        GITMATRIX_LANDING_NAME: "Gitmatrix",
        GITMATRIX_LANDING_EMAIL: "landing@gitmatrix.invalid",
        GITMATRIX_LANDING_DATE: "2000-01-01T00:00:00Z",
        GITMATRIX_LANDING_MESSAGE: "Compact checkpoint",
      },
    });
  };
  return { root, canonical, source, local, base, commit, prepare };
}

describe("compact publication", () => {
  test("publishes one canonical-only parent and never uploads WIP objects, including staging", () => {
    const f = fixture();
    const w1 = f.commit("work", "one\n"),
      w2 = f.commit("work", "two\n"),
      w3 = f.commit("work", "three\n");
    git(f.local, "checkout", "--quiet", "--detach", f.base);
    const main = f.commit("independent", "canonical\n");
    git(f.local, "push", "--quiet", "origin", "HEAD:main");
    const result = f.prepare(w3, f.base, main);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const candidate = git(f.canonical, "rev-parse", "refs/heads/gitmatrix/landing/test");
    expect(git(f.canonical, "rev-list", "--parents", "-n", "1", candidate)).toBe(
      `${candidate} ${main}`,
    );
    expect(git(f.canonical, "rev-list", "--count", `${main}..${candidate}`)).toBe("1");
    expect(git(f.canonical, "show", `${candidate}:work`)).toBe("three");
    expect(git(f.canonical, "show", `${candidate}:independent`)).toBe("canonical");
    for (const oid of [w1, w2, w3])
      expect(spawnSync("git", ["cat-file", "-e", oid], { cwd: f.canonical }).status).not.toBe(0);
    expect(git(f.canonical, "rev-parse", "main")).toBe(main);
  });
  test("uses P0 rather than compact parent's tree and preserves a canonical parent revert", () => {
    const f = fixture();
    const p0 = f.commit("parent", "parent contribution\n");
    const child = f.commit("child", "child contribution\n");
    git(f.local, "checkout", "--quiet", "--detach", f.base);
    const main = f.commit("unrelated", "main kept this\n");
    git(f.local, "push", "--quiet", "origin", "HEAD:main");
    const result = f.prepare(child, p0, main);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const candidate = git(f.canonical, "rev-parse", "refs/heads/gitmatrix/landing/test");
    expect(git(f.canonical, "ls-tree", "--name-only", candidate).split("\n")).toEqual([
      "base",
      "child",
      "unrelated",
    ]);
    expect(git(f.canonical, "show", `${candidate}:child`)).toBe("child contribution");
  });
  test("no-op publishes the pinned canonical commit, not an empty commit", () => {
    const f = fixture();
    const result = f.prepare(f.base, f.base, f.base);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(git(f.canonical, "rev-parse", "refs/heads/gitmatrix/landing/test")).toBe(f.base);
  });
  test("honest content conflicts publish nothing", () => {
    const f = fixture();
    const work = f.commit("base", "work\n");
    git(f.local, "checkout", "--quiet", "--detach", f.base);
    const main = f.commit("base", "main\n");
    git(f.local, "push", "--quiet", "origin", "HEAD:main");
    expect(f.prepare(work, f.base, main).status).toBe(42);
    expect(
      spawnSync("git", ["rev-parse", "--verify", "refs/heads/gitmatrix/landing/test"], {
        cwd: f.canonical,
      }).status,
    ).not.toBe(0);
  });
});

test("a source merge never introduces either WIP parent into canonical objects", () => {
  const f = fixture(),
    left = f.commit("left", "left\n");
  git(f.local, "checkout", "--quiet", "--detach", f.base);
  const right = f.commit("right", "right\n");
  git(f.local, "merge", "--quiet", "--no-ff", "-m", "source merge", left);
  const merged = git(f.local, "rev-parse", "HEAD");
  const result = f.prepare(merged, f.base, f.base);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const candidate = git(f.canonical, "rev-parse", "refs/heads/gitmatrix/landing/test");
  expect(git(f.canonical, "rev-list", "--parents", "-n", "1", candidate)).toBe(
    `${candidate} ${f.base}`,
  );
  expect(git(f.canonical, "ls-tree", "--name-only", candidate).split("\n")).toEqual([
    "base",
    "left",
    "right",
  ]);
  for (const oid of [left, right, merged])
    expect(spawnSync("git", ["cat-file", "-e", oid], { cwd: f.canonical }).status).not.toBe(0);
});

test("only the running trusted job owns its source and canonical landing authority", async () => {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  cleanups.push(close);
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      kind: "company",
    },
    space: { id: "space", slug: "owner", displayName: "Space" },
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
    VALUES('r','space','repo','private','r','https://r');`);
  const credential = await issueToken(env.DB, "person", "Fixture", "write");
  const authority = await captureWorkAuthority(env, "r", {
    id: "person",
    credential: { kind: "token", id: credential.id },
  });
  sqlite.exec(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,
       allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
       initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES ('work_test','r','timeline','test','space','${JSON.stringify(authority)}','work-r','https://work-r','ready',
       'allocation','canonical','${"a".repeat(40)}','${"b".repeat(40)}','refs/heads/main',
       'canonical','${"a".repeat(40)}','${"b".repeat(40)}','refs/heads/main',datetime('now'),datetime('now'));
    INSERT INTO ci_runs(id,repo_id,space_id,migration_epoch,authority,actor_id,agent_id,number,commit_oid,ref,trigger,status,source_id) VALUES('run','r','space',${authority.migrationEpoch},'${JSON.stringify(authority)}','person',NULL,1,'${"a".repeat(40)}','gitmatrix/landing/test','manual','running','work_test');
    INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner,source_id) VALUES('job','run','r','land','{"landing":{"slug":"test","sourceId":"work_test"},"steps":[]}','running','local','work_test');`);
  const token = await mintJobToken(env, "job", 30);
  expect(await landingJob(env, token, "owner", "repo")).toMatchObject({
    ok: true,
    sourceId: "work_test",
    slug: "test",
  });
  expect(await landingJob(env, token, "owner", "other")).toMatchObject({ ok: false });
  sqlite.exec(
    'UPDATE ci_jobs SET spec=\'{"landing":{"slug":"test","sourceId":"work_other"}}\' WHERE id=\'job\'',
  );
  expect(await landingJob(env, token, "owner", "repo")).toMatchObject({ ok: false });
  sqlite.exec(
    'UPDATE ci_jobs SET spec=\'{"landing":{"slug":"test","sourceId":"work_test"}}\' WHERE id=\'job\'',
  );
  sqlite.exec("UPDATE ci_runs SET ref='gitmatrix/landing/other' WHERE id='run'");
  expect(await landingJob(env, token, "owner", "repo")).toMatchObject({ ok: false });
  sqlite.exec("UPDATE ci_runs SET ref='gitmatrix/landing/test',status='succeeded' WHERE id='run'");
  expect(await landingJob(env, token, "owner", "repo")).toMatchObject({ ok: false });
  sqlite.exec("UPDATE ci_runs SET status='running' WHERE id='run'");
  sqlite.exec("UPDATE ci_jobs SET status='succeeded' WHERE id='job'");
  expect(await landingJob(env, token, "owner", "repo")).toMatchObject({ ok: false });
});
