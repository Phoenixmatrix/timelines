// A landing's merge job (CORE-77): which job credential is a landing's, and
// the merge step itself, run with real git through Gitmatrix's git proxy
// (CORE-157), in front of `git http-backend` standing in for Artifacts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { gitHttp } from "../git/http.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { gitBackend, run, serve } from "../testing/git-http.ts";
import { CONFLICT_EXIT, landingJob, MERGE_SCRIPT } from "./landing.ts";
import { mintJobToken } from "./registry.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

/** Repositories app and lib, and landing-shaped jobs in app. */
function database(commit = oid(1)) {
  const sqlite = migratedDatabase();
  const landing = JSON.stringify({ steps: [], landing: { slug: "search" } });
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('orbit', 'org', 'orbit', 'Orbit');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-app', 'https://artifacts.test/app.git'),
      ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://artifacts.test/lib.git');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('merge', 'app', 1, '${commit}', 'gitmatrix/landing/search', 'manual', 'running'),
      ('push', 'app', 2, '${commit}', 'gitmatrix/landing/search', 'manual', 'running'),
      ('other', 'app', 4, '${commit}', 'gitmatrix/landing/search', 'manual', 'running'),
      ('old', 'app', 3, '${commit}', 'gitmatrix/landing/search', 'manual', 'succeeded');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
      ('land', 'merge', 'app', 'land', '${landing}', 'running', 'sandbox'),
      ('mimic', 'push', 'app', 'land', '{"steps":[]}', 'running', 'sandbox'),
      ('odd', 'other', 'app', 'land', '{"steps":[],"landing":{"slug":"../main"}}', 'running', 'sandbox'),
      ('done', 'old', 'app', 'land', '${landing}', 'succeeded', 'sandbox');
  `);
  return sqlite;
}

describe("a landing's merge job", () => {
  test("is a landing's running merge job, in its own repository", async () => {
    const db = d1(database());
    const check = async (job: string, repo = "app") =>
      landingJob(db, await mintJobToken(db, job, 30), "orbit", repo);
    expect(await check("land")).toEqual({
      ok: true,
      slug: "search",
      repo: {
        id: "app",
        artifacts_name: "r-app",
        artifacts_remote: "https://artifacts.test/app.git",
      },
    });
    // A repository's own job named like it, a slug that isn't one, another
    // repository: forbidden. A finished job's credential is no credential.
    expect(await check("mimic")).toMatchObject({ ok: false, status: 403 });
    expect(await check("odd")).toMatchObject({ ok: false, status: 403 });
    expect(await check("land", "lib")).toMatchObject({ ok: false, status: 403 });
    expect(await check("done")).toMatchObject({ ok: false, status: 401 });
    expect(await landingJob(db, "gmj_nope", "orbit", "app")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  test("gets no Artifacts credential: it uses the git proxy with its own", () => {
    expect(MERGE_SCRIPT).not.toMatch(/curl|landing\/credential/);
    expect(MERGE_SCRIPT).toContain('remote="$GITMATRIX_URL/$GITMATRIX_REPOSITORY.git"');
    expect(MERGE_SCRIPT).toContain('"Authorization: Bearer $GITMATRIX_TOKEN"');
  });
});

describe("the merge step", () => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const close of closers.splice(0)) await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  }

  /**
   * A remote where the timeline and main each changed `file` (different
   * lines); with `clash`, main also added the `new` file the timeline adds.
   * Then a checkout as CI makes one, Gitmatrix's git proxy in front of the
   * remote (as Artifacts), and the step to run in the checkout with the merge
   * job's credential.
   */
  async function setup(clash = false) {
    const root = mkdtempSync(join(tmpdir(), "landing-"));
    dirs.push(root);
    const remote = join(root, "app.git");
    const work = join(root, "work");
    git(root, "init", "--quiet", "--bare", "-b", "main", remote);
    git(root, "clone", "--quiet", remote, work);
    writeFileSync(join(work, "file"), "one\ntwo\nthree\n");
    git(work, "add", "file");
    git(work, "commit", "--quiet", "-m", "start");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    git(work, "checkout", "--quiet", "-b", "timeline");
    writeFileSync(join(work, "file"), "ONE\ntwo\nthree\n");
    writeFileSync(join(work, "new"), "timeline\n");
    git(work, "add", "file", "new");
    git(work, "commit", "--quiet", "-m", "timeline work");
    const commit = git(work, "rev-parse", "HEAD");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/gitmatrix/landing/search");
    git(work, "checkout", "--quiet", "main");
    writeFileSync(join(work, "file"), "one\ntwo\nTHREE\n");
    if (clash) writeFileSync(join(work, "new"), "main's own\n");
    git(work, "add", "file", ...(clash ? ["new"] : []));
    git(work, "commit", "--quiet", "-m", "main moved");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const base = git(work, "rev-parse", "HEAD");
    // CI's checkout: the landing branch, shallow.
    const checkout = join(root, "ci");
    git(
      root,
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      "gitmatrix/landing/search",
      `file://${remote}`,
      checkout,
    );
    // The proxy, with the landing's merge job in the database.
    const env = {
      DB: d1(database(commit)),
      ARTIFACTS: {
        get: async (name: string) => ({
          createToken: async (scope: string) => ({
            id: "t",
            plaintext: `${scope}-${name}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          [Symbol.dispose]() {},
        }),
      },
    } as unknown as Env;
    const backend = gitBackend(root);
    vi.stubGlobal("fetch", backend.fetch);
    const server = await serve(new Hono<AppEnv>().route("/", gitHttp), env);
    closers.push(server.close);
    const token = await mintJobToken(env.DB, "land", 30);
    const step = () =>
      run("bash", ["-eo", "pipefail", "-c", MERGE_SCRIPT], {
        cwd: checkout,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GITMATRIX_TOKEN: token,
          GITMATRIX_URL: server.url,
          GITMATRIX_REPOSITORY: "orbit/app",
          GITMATRIX_COMMIT: commit,
          GITMATRIX_LANDING_BRANCH: "gitmatrix/landing/search",
          GITMATRIX_LANDING_MAIN: "main",
          GITMATRIX_LANDING_BASE: base,
          GITMATRIX_LANDING_MESSAGE: "Land timeline search (checkpoint #1)",
          GITMATRIX_LANDING_NAME: "Gitmatrix",
          GITMATRIX_LANDING_EMAIL: "landing@gitmatrix.invalid",
        },
      });
    return { remote, base, commit, step, backend };
  }

  test("merges the checkpoint into main's pinned commit and pushes it to the landing branch", async () => {
    const t = await setup();
    const result = await t.step();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const merge = git(t.remote, "rev-parse", "refs/heads/gitmatrix/landing/search");
    expect(git(t.remote, "rev-parse", `${merge}^1`)).toBe(t.base);
    expect(git(t.remote, "rev-parse", `${merge}^2`)).toBe(t.commit);
    expect(git(t.remote, "show", `${merge}:file`)).toBe("ONE\ntwo\nTHREE");
    expect(git(t.remote, "log", "-1", "--format=%s %an", merge)).toBe(
      "Land timeline search (checkpoint #1) Gitmatrix",
    );
    // Main itself is the Worker's to move.
    expect(git(t.remote, "rev-parse", "refs/heads/main")).toBe(t.base);
    // All of it through the proxy, which used its own tokens for Artifacts.
    expect(t.backend.requests.map((r) => [new URL(r.url).pathname, r.authorization])).toEqual(
      expect.arrayContaining([
        ["/app.git/git-upload-pack", "Bearer read-r-app"],
        ["/app.git/git-receive-pack", "Bearer write-r-app"],
      ]),
    );
  });

  test("a conflict exits with its own code, listing the files, and pushes nothing", async () => {
    const t = await setup(true);
    const result = await t.step();
    expect(result.status, result.stdout + result.stderr).toBe(CONFLICT_EXIT);
    expect(result.stdout).toMatch(/conflicts in:\n {2}new/);
    expect(git(t.remote, "rev-parse", "refs/heads/gitmatrix/landing/search")).toBe(t.commit);
  });
});
