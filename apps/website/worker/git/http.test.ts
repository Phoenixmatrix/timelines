// The git proxy with a CI job's credential (CORE-157): only a landing's merge
// job gets through, it reads its repository, and it pushes to nothing but its
// own landing branch. Real git against `git http-backend` standing in for
// Artifacts, and hand-made receive-pack requests for the exact refusals.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { hashToken, type AppEnv } from "../auth.ts";
import { mintJobToken } from "../ci/registry.ts";
import { queueMergeJob } from "../ci/queue-auth.ts";
import { queueCandidateBranch } from "../../shared/merge-queue.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { gitBackend, run, serve } from "../testing/git-http.ts";
import { gitHttp, landingPushRefusal, queuePushRefusal } from "./http.ts";
import { FLUSH, pkt } from "./pktline.ts";
import { afterPush } from "./effects.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("./effects.ts", () => ({ afterPush: vi.fn() }));

const ZERO = "0".repeat(40);
const LANDING = "refs/heads/gitmatrix/landing/search";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

async function setup(queue = false) {
  const root = mkdtempSync(join(tmpdir(), "git-proxy-"));
  dirs.push(root);
  // Artifacts: a bare repository with main, the landing branch and a tag.
  const remote = join(root, "app.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "init", "--quiet", "-b", "main", work);
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "file"), "one\n");
  git(work, "add", "file");
  git(work, "commit", "--quiet", "-m", "start");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main", `HEAD:${LANDING}`);
  git(work, "push", "--quiet", "origin", "HEAD:refs/tags/v1");
  const main = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "file"), "merged\n");
  git(work, "commit", "--quiet", "-am", "the merge");
  const merge = git(work, "rev-parse", "HEAD");

  const sqlite = migratedDatabase();
  const landing = JSON.stringify({ steps: [], landing: { slug: "search" } });
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('orbit', 'org', 'orbit', 'Orbit');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-app', 'https://artifacts.test/app.git'),
      ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://artifacts.test/lib.git');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('merge', 'app', 1, '${main}', 'gitmatrix/landing/search', 'manual', 'running'),
      ('push', 'app', 2, '${main}', 'main', 'push', 'running'),
      ('old', 'app', 3, '${main}', 'gitmatrix/landing/search', 'manual', 'succeeded');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
      ('land', 'merge', 'app', 'land', '${landing}', 'running', 'sandbox'),
      ('mimic', 'push', 'app', 'land', '{"steps":[]}', 'running', 'sandbox'),
      ('build', 'push', 'app', 'build', '${landing}', 'running', 'sandbox'),
      ('done', 'old', 'app', 'land', '${landing}', 'succeeded', 'sandbox');
  `);
  const candidate = queueCandidateBranch(main, 1);
  if (queue) {
    git(remote, "update-ref", `refs/heads/${candidate}`, main);
    sqlite
      .prepare(`INSERT INTO merge_queue
      (repo_id,id,status,attempts,merge_run_id,base,data,created_at,updated_at)
      VALUES ('app',?,'merging',1,'merge',?,'{}',datetime('now'),datetime('now'))`)
      .run(main, main);
    sqlite
      .prepare(`UPDATE ci_runs SET queue_id=?, ref=?, trigger='manual' WHERE id='merge'`)
      .run(main, candidate);
    sqlite
      .prepare(`UPDATE ci_jobs SET spec=? WHERE id='land'`)
      .run(JSON.stringify({ steps: [], queue: { id: main, attempt: 1 } }));
  }
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
  const backend = gitBackend(root);
  vi.stubGlobal("fetch", backend.fetch);
  const app = new Hono<AppEnv>().route("/", gitHttp);
  const server = await serve(app, env);
  closers.push(server.close);
  const token = (job = "land") => mintJobToken(env.DB, job, 30);
  const ref = (name: string) => git(remote, "rev-parse", name);

  /** Real git in `work`, through the proxy, with a job credential. */
  const gitWith = (secret: string, ...args: string[]) =>
    run("git", args, {
      cwd: work,
      env: {
        ...process.env,
        ...GIT_ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`,
      },
    });
  const proxyUrl = `${server.url}/orbit/app.git`;

  /** A hand-made receive-pack request with these commands and an empty pack. */
  const receivePack = async (
    secret: string,
    commands: string[],
    options: { gzip?: boolean; repo?: string } = {},
  ) => {
    let text = "";
    commands.forEach((command, i) => {
      text += pkt(i === 0 ? `${command}\0report-status\n` : `${command}\n`);
    });
    let body: Uint8Array = new TextEncoder().encode(text + FLUSH);
    if (options.gzip) body = new Uint8Array(gzipSync(body));
    const before = backend.requests.length;
    const response = await app.request(
      `/orbit/${options.repo ?? "app"}.git/git-receive-pack`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/x-git-receive-pack-request",
          ...(options.gzip ? { "content-encoding": "gzip" } : {}),
        },
        body,
      },
      env,
    );
    return {
      status: response.status,
      text: await response.text(),
      forwarded: backend.requests.slice(before),
    };
  };
  const infoRefs = async (secret: string, service: string, repo = "app") =>
    app.request(
      `/orbit/${repo}.git/info/refs?service=${service}`,
      { headers: { authorization: `Bearer ${secret}` } },
      env,
    );

  return {
    env,
    sqlite,
    backend,
    main,
    candidate,
    merge,
    token,
    ref,
    gitWith,
    proxyUrl,
    receivePack,
    infoRefs,
  };
}

describe("a landing merge job's credential in the git proxy", () => {
  test("pushes to its own landing branch, with real git", async () => {
    const t = await setup();
    const secret = await t.token();
    const push = await t.gitWith(secret, "push", "--force", t.proxyUrl, `HEAD:${LANDING}`);
    expect(push.status, push.stderr).toBe(0);
    expect(t.ref(LANDING)).toBe(t.merge);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    // Artifacts saw a write token for this repository only, never the job's credential.
    const post = t.backend.requests.find((r) => r.url.endsWith("/git-receive-pack"))!;
    expect(post.authorization).toBe("Bearer write-r-app");
    expect(t.backend.requests.every((r) => !r.authorization?.includes("gmj_"))).toBe(true);
  });

  test("reads the repository (upload-pack), with real git", async () => {
    const t = await setup();
    const secret = await t.token();
    const fetched = await t.gitWith(
      secret,
      "fetch",
      "--quiet",
      t.proxyUrl,
      "+refs/heads/main:refs/remotes/landing/main",
    );
    expect(fetched.status, fetched.stderr).toBe(0);
    const listed = await t.gitWith(secret, "ls-remote", t.proxyUrl);
    expect(listed.stdout).toContain(`${t.main}\trefs/heads/main`);
    const reads = t.backend.requests.filter((r) => r.url.includes("upload-pack"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.authorization === "Bearer read-r-app")).toBe(true);
  });

  test("can't push to main, another landing, a tag, or several refs, with real git", async () => {
    const t = await setup();
    const secret = await t.token();
    for (const refspec of [
      "HEAD:refs/heads/main",
      "HEAD:refs/heads/gitmatrix/landing/other",
      "HEAD:refs/tags/v2",
      ":refs/heads/main",
    ]) {
      const push = await t.gitWith(secret, "push", "--force", t.proxyUrl, refspec);
      expect(push.status, refspec).not.toBe(0);
      expect(push.stderr, refspec).toContain("403");
    }
    const both = await t.gitWith(
      secret,
      "push",
      "--force",
      t.proxyUrl,
      `HEAD:${LANDING}`,
      "HEAD:refs/heads/main",
    );
    expect(both.status).not.toBe(0);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    expect(t.ref(LANDING)).toBe(t.main);
    expect(t.backend.requests.some((r) => r.url.endsWith("/git-receive-pack"))).toBe(false);
  });

  test("checks every command before anything reaches Artifacts", async () => {
    const t = await setup();
    const secret = await t.token();
    const own = `${t.main} ${t.merge} ${LANDING}`;
    const refused = async (commands: string[], message: RegExp, gzip = false) => {
      const result = await t.receivePack(secret, commands, { gzip });
      expect(result.status, commands.join(", ")).toBe(403);
      expect(result.text).toMatch(message);
      expect(result.forwarded).toEqual([]);
    };
    await refused(
      [`${t.main} ${t.merge} refs/heads/main`],
      /only to .*landing\/search, not refs\/heads\/main/,
    );
    await refused([`${ZERO} ${t.merge} refs/tags/v2`], /not refs\/tags\/v2/);
    await refused(
      [`${ZERO} ${t.merge} refs/heads/gitmatrix/landing/other`],
      /not refs\/heads\/gitmatrix\/landing\/other/,
    );
    await refused([`${t.main} ${ZERO} refs/heads/main`], /not refs\/heads\/main/);
    await refused([`${t.main} ${ZERO} ${LANDING}`], /can't delete/);
    // Mixed: its own branch and another ref, in either order.
    await refused([own, `${t.main} ${t.merge} refs/heads/main`], /updates 2/);
    await refused([`${t.main} ${t.merge} refs/heads/main`, own], /updates 2/);
    // A compressed body is read the same way.
    await refused([`${t.main} ${t.merge} refs/heads/main`], /not refs\/heads\/main/, true);

    // Malformed: refused as such, and nothing forwarded.
    const bad = await t.receivePack(secret, ["not a command"]);
    expect(bad.status).toBe(400);
    expect(bad.forwarded).toEqual([]);
  });

  test("forwards its own command, compressed or not, and git's empty probe", async () => {
    const t = await setup();
    const secret = await t.token();
    // The merge commit's objects aren't in the request, so Artifacts reports the
    // unpack failing: what matters is that the request reached it, decoded.
    const own = `${t.main} ${t.merge} ${LANDING}`;
    for (const gzip of [false, true]) {
      const result = await t.receivePack(secret, [own], { gzip });
      expect(result.status).toBe(200);
      expect(result.forwarded).toHaveLength(1);
      expect(result.forwarded[0]!.contentEncoding).toBeNull();
      expect(new TextDecoder().decode(result.forwarded[0]!.body)).toContain(LANDING);
    }
    const probe = await t.receivePack(secret, []);
    expect(probe.status).toBe(200);
    expect(probe.forwarded).toHaveLength(1);
  });

  test("other job credentials get nothing", async () => {
    const t = await setup();
    // A repository's own job named like it, a landing spec on another job's name,
    // the right job in another repository: forbidden.
    for (const job of ["mimic", "build"]) {
      const secret = await t.token(job);
      expect((await t.infoRefs(secret, "git-upload-pack")).status, job).toBe(403);
      expect((await t.receivePack(secret, [`${t.main} ${t.merge} ${LANDING}`])).status).toBe(403);
    }
    const land = await t.token();
    expect((await t.infoRefs(land, "git-upload-pack", "lib")).status).toBe(403);
    expect(
      (await t.receivePack(land, [`${t.main} ${t.merge} ${LANDING}`], { repo: "lib" })).status,
    ).toBe(403);
    // A finished job, an unknown credential, an expired one: not a credential at all.
    expect((await t.infoRefs(await t.token("done"), "git-upload-pack")).status).toBe(401);
    expect((await t.infoRefs("gmj_nope", "git-upload-pack")).status).toBe(401);
    t.sqlite.exec(`UPDATE ci_job_tokens SET expires_at = '2000-01-01T00:00:00.000Z'`);
    expect((await t.infoRefs(land, "git-upload-pack")).status).toBe(401);
    expect((await t.receivePack(land, [`${t.main} ${t.merge} ${LANDING}`])).status).toBe(401);
    expect(t.backend.requests).toEqual([]);
  });
});

describe("landingPushRefusal", () => {
  const command = (ref: string, next = "1".repeat(40)) => ({ old: ZERO, new: next, ref });

  test("allows exactly its own landing branch, or nothing", () => {
    expect(landingPushRefusal({ commands: [command(LANDING)], pushCert: false }, "search")).toBe(
      null,
    );
    expect(landingPushRefusal({ commands: [], pushCert: false }, "search")).toBe(null);
  });

  test("refuses signed pushes, other refs, and lookalikes", () => {
    expect(landingPushRefusal({ commands: [], pushCert: true }, "search")).toMatch(/signed/);
    for (const ref of [
      `${LANDING}-2`,
      `${LANDING}/x`,
      "refs/heads/gitmatrix/landing/searc",
      "refs/remotes/gitmatrix/landing/search",
      "gitmatrix/landing/search",
    ])
      expect(
        landingPushRefusal({ commands: [command(ref)], pushCert: false }, "search"),
        ref,
      ).toMatch(/only to/);
  });
});

describe("a queue merge job's credential", () => {
  test("fetches and publishes only its own candidate with real git", async () => {
    const t = await setup(true);
    const secret = await t.token();
    const fetched = await t.gitWith(secret, "fetch", t.proxyUrl, "main");
    expect(fetched.status, fetched.stderr).toBe(0);
    const pushed = await t.gitWith(secret, "push", t.proxyUrl, `HEAD:refs/heads/${t.candidate}`);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(t.ref(`refs/heads/${t.candidate}`)).toBe(t.merge);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    expect(await queueMergeJob(t.env.DB, secret, "orbit", "app", t.main)).toMatchObject({
      ok: true,
      queueId: t.main,
      attempt: 1,
      runId: "merge",
      jobId: "land",
      branch: t.candidate,
    });
  });

  test("refuses other refs, deletion, mixed updates and other repositories before forwarding", async () => {
    const t = await setup(true);
    const secret = await t.token();
    const own = `${t.main} ${t.merge} refs/heads/${t.candidate}`;
    for (const commands of [
      [`${t.main} ${t.merge} refs/heads/main`],
      [`${t.main} ${t.merge} ${LANDING}`],
      [`${t.main} ${ZERO} refs/heads/${t.candidate}`],
      [own, `${t.main} ${t.merge} refs/heads/main`],
    ]) {
      const result = await t.receivePack(secret, commands);
      expect(result.status).toBe(403);
      expect(result.forwarded).toEqual([]);
    }
    expect((await t.infoRefs(secret, "git-upload-pack", "lib")).status).toBe(403);
    expect((await t.receivePack(secret, [own], { repo: "lib" })).forwarded).toEqual([]);
    expect(queuePushRefusal({ commands: [], pushCert: true }, t.candidate)).toMatch(/signed/);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    expect(t.ref(`refs/heads/${t.candidate}`)).toBe(t.main);
  });

  test.each([
    "UPDATE merge_queue SET status='cancelled'",
    "UPDATE merge_queue SET attempts=2",
    "UPDATE merge_queue SET merge_run_id='replacement'",
    "UPDATE ci_runs SET status='cancelled' WHERE id='merge'",
    "UPDATE ci_jobs SET status='queued' WHERE id='land'",
    "UPDATE ci_runs SET commit_oid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id='merge'",
    "UPDATE ci_runs SET ref='main' WHERE id='merge'",
    'UPDATE ci_jobs SET spec=\'{"steps":[],"queue":{"id":"wrong","attempt":1}}\' WHERE id=\'land\'',
  ])("revokes reads, writes and resolution for stale authority: %s", async (mutation) => {
    const t = await setup(true);
    const secret = await t.token();
    t.sqlite.exec(mutation);
    expect((await t.infoRefs(secret, "git-upload-pack")).status).toBe(403);
    const push = await t.receivePack(secret, [`${t.main} ${t.merge} refs/heads/${t.candidate}`]);
    expect(push.status).toBe(403);
    expect(await queueMergeJob(t.env.DB, secret, "orbit", "app", t.main)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(t.backend.requests).toEqual([]);
  });

  test("pins a combined source and keeps replacement attempts on separate refs", async () => {
    const t = await setup(true);
    const oldSecret = await t.token();
    t.sqlite.prepare("UPDATE merge_queue SET data=?").run(JSON.stringify({ mergeSource: t.merge }));
    expect(await queueMergeJob(t.env.DB, oldSecret, "orbit", "app")).toMatchObject({ ok: false });
    t.sqlite.prepare("UPDATE ci_runs SET commit_oid=? WHERE id='merge'").run(t.merge);
    expect(await queueMergeJob(t.env.DB, oldSecret, "orbit", "app")).toMatchObject({ ok: true });
    const nextBranch = queueCandidateBranch(t.main, 2);
    t.sqlite
      .prepare(`INSERT INTO ci_runs
      (id,repo_id,number,commit_oid,ref,trigger,status,queue_id)
      VALUES ('replacement','app',4,?,?,'manual','running',?)`)
      .run(t.merge, nextBranch, t.main);
    t.sqlite
      .prepare(`INSERT INTO ci_jobs
      (id,run_id,repo_id,name,spec,status,runner)
      VALUES ('replacement-job','replacement','app','land',?,'running','sandbox')`)
      .run(JSON.stringify({ steps: [], queue: { id: t.main, attempt: 2 } }));
    t.sqlite.exec("UPDATE merge_queue SET attempts=2,merge_run_id='replacement'");
    const nextSecret = await t.token("replacement-job");
    expect(await queueMergeJob(t.env.DB, oldSecret, "orbit", "app")).toMatchObject({ ok: false });
    expect(await queueMergeJob(t.env.DB, nextSecret, "orbit", "app")).toMatchObject({
      ok: true,
      attempt: 2,
      branch: nextBranch,
    });
    const oldBranch = await t.receivePack(nextSecret, [
      `${t.main} ${t.merge} refs/heads/${t.candidate}`,
    ]);
    expect(oldBranch.status).toBe(403);
    expect(oldBranch.forwarded).toEqual([]);
    const pushed = await t.gitWith(nextSecret, "push", t.proxyUrl, `HEAD:refs/heads/${nextBranch}`);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(t.ref(`refs/heads/${nextBranch}`)).toBe(t.merge);
    expect(t.ref(`refs/heads/${t.candidate}`)).toBe(t.main);
  });

  test("denies a different queue's resolve request", async () => {
    const t = await setup(true);
    expect(
      await queueMergeJob(t.env.DB, await t.token(), "orbit", "app", "a".repeat(40)),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("ordinary queue source staging", () => {
  test("suppresses source-only effects but keeps direct and mixed pushes", async () => {
    const t = await setup();
    const secret = "gmx_proxy_staging_test";
    t.sqlite.exec("UPDATE accounts SET kind='user' WHERE id='orbit'");
    t.sqlite
      .prepare(`INSERT INTO access_tokens
      (id,user_id,name,scope,token_hash,last_four) VALUES ('pat','orbit','test','write',?,'test')`)
      .run(await hashToken(secret));
    vi.mocked(afterPush).mockClear();
    const source = `refs/heads/gitmatrix/queue/${t.merge}`;
    const staged = await t.gitWith(secret, "push", t.proxyUrl, `HEAD:${source}`);
    expect(staged.status, staged.stderr).toBe(0);
    expect(t.ref(source)).toBe(t.merge);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    expect(afterPush).not.toHaveBeenCalled();
    const direct = await t.gitWith(secret, "push", t.proxyUrl, "HEAD:refs/heads/main");
    expect(direct.status, direct.stderr).toBe(0);
    expect(t.ref("refs/heads/main")).toBe(t.merge);
    expect(afterPush).toHaveBeenCalledTimes(1);
    vi.mocked(afterPush).mockClear();
    const mixed = await t.gitWith(
      secret,
      "push",
      t.proxyUrl,
      `HEAD:refs/heads/gitmatrix/queue/${t.main}`,
      "HEAD:refs/heads/feature",
    );
    expect(mixed.status, mixed.stderr).toBe(0);
    expect(t.ref("refs/heads/feature")).toBe(t.merge);
    expect(afterPush).toHaveBeenCalledTimes(1);
  });
});
