// A landing's merge job (CORE-77): who gets the landing credential, and the
// merge step itself, run with real git against a local remote.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { jobRoute } from "../deployments/job.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { CONFLICT_EXIT, landingCredential, MERGE_SCRIPT } from "./landing.ts";
import { mintJobToken } from "./registry.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

describe("the landing credential", () => {
  async function setup() {
    const sqlite = migratedDatabase();
    const landing = JSON.stringify({ steps: [], landing: { slug: "search" } });
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('orbit', 'org', 'orbit', 'Orbit');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
        ('app', 'orbit', 'app', 'private', 'r-app', 'https://app'),
        ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://lib');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
        ('merge', 'app', 1, '${oid(1)}', 'gitmatrix/landing/search', 'manual', 'running'),
        ('push', 'app', 2, '${oid(2)}', 'gitmatrix/landing/search', 'manual', 'running'),
        ('old', 'app', 3, '${oid(3)}', 'gitmatrix/landing/search', 'manual', 'succeeded');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
        ('land', 'merge', 'app', 'land', '${landing}', 'running', 'sandbox'),
        ('mimic', 'push', 'app', 'land', '{"steps":[]}', 'running', 'sandbox'),
        ('done', 'old', 'app', 'land', '${landing}', 'succeeded', 'sandbox');
    `);
    const env = {
      DB: d1(sqlite),
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
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      if (!jobRoute(c)) return c.json({ error: "not a job route" }, 401);
      return next();
    });
    app.route("/api/repos/:owner/:name/landing", landingCredential);
    const ask = async (job: string, repo = "app") => {
      const token = await mintJobToken(env.DB, job, 30);
      const response = await app.request(
        `/api/repos/orbit/${repo}/landing/credential`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
        env,
      );
      return { status: response.status, text: await response.text() };
    };
    return { ask };
  }

  test("only a landing's running merge job gets it, for its own repository", async () => {
    const t = await setup();
    expect(await t.ask("land")).toEqual({ status: 200, text: "https://app\nwrite-r-app\n" });
    // A repository's own job named like it, another repository, a finished job: no.
    expect((await t.ask("mimic")).status).toBe(403);
    expect((await t.ask("land", "lib")).status).toBe(403);
    expect((await t.ask("done")).status).toBe(401);
  });
});

describe("the merge step", () => {
  const dirs: string[] = [];
  afterEach(() => {
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
   * Then a checkout as CI makes one, and the step to run in it.
   */
  function setup(clash = false) {
    const root = mkdtempSync(join(tmpdir(), "landing-"));
    dirs.push(root);
    const remote = join(root, "remote.git");
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
    // curl answers with the landing credential: the remote, and a token.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf 'file://${remote}\\ntoken\\n'\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const run = () =>
      spawnSync("bash", ["-eo", "pipefail", "-c", MERGE_SCRIPT], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITMATRIX_TOKEN: "gmj_x",
          GITMATRIX_URL: "https://gitmatrix.test",
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
    return { remote, base, commit, run };
  }

  test("merges the checkpoint into main's pinned commit and pushes it to the landing branch", () => {
    const t = setup();
    const result = t.run();
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
  });

  test("a conflict exits with its own code, listing the files, and pushes nothing", () => {
    const t = setup(true);
    const result = t.run();
    expect(result.status, result.stdout + result.stderr).toBe(CONFLICT_EXIT);
    expect(result.stdout).toMatch(/conflicts in:\n {2}new/);
    expect(git(t.remote, "rev-parse", "refs/heads/gitmatrix/landing/search")).toBe(t.commit);
  });
});
