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
import type { AppEnv } from "../auth.ts";
import { issueToken } from "../api/tokens.ts";
import { mintJobToken } from "../ci/registry.ts";
import { queueMergeJob } from "../ci/queue-auth.ts";
import { queueCandidateBranch } from "../../shared/merge-queue.ts";
import { gitBackend, run, serve } from "../testing/git-http.ts";
import { gitHttp, landingPushRefusal, queuePushRefusal, scrubbedError } from "./http.ts";
import { FLUSH, pkt } from "./pktline.ts";
import { afterPush } from "./effects.ts";
import { recordPush } from "../ref-log/record.ts";
import { steps } from "../steps/api.ts";
import { encodeCommit, hashObject, PackWriter } from "@gitmatrix/formats/git";
import { writeRefs } from "../timelines/bookmarks.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { invalidateRefs, RepoReader } from "../objects.ts";
import { Timing } from "../timing.ts";
import { captureWorkAuthority } from "../ci/admission.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
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

async function setup(queue = false, changeId?: string) {
  const root = mkdtempSync(join(tmpdir(), "git-proxy-"));
  dirs.push(root);
  // Artifacts: a bare repository with main, the landing branch and a tag.
  const remote = join(root, "app.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "--git-dir", remote, "config", "uploadpack.allowFilter", "true");
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
  if (changeId) {
    const body = git(work, "cat-file", "commit", "HEAD").replace(
      "\n\n",
      `\nchange-id ${changeId}\n\n`,
    );
    const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: work,
      encoding: "utf8",
      input: `${body}\n`,
      env: { ...process.env, ...GIT_ENV },
    }).trim();
    git(work, "update-ref", "HEAD", commit);
  }
  const merge = git(work, "rev-parse", "HEAD");

  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  closers.push(async () => fresh.close());
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES ('orbit','user','orbit-person','Orbit')",
  );
  await seedSpaceFixture(fresh.env.DB, {
    organization: {
      id: "organization-orbit",
      slug: "orbit-company",
      displayName: "Orbit",
      kind: "company",
    },
    space: { id: "orbit", slug: "orbit", displayName: "General" },
    actorId: "orbit",
    members: [
      {
        accountId: "orbit",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  const landing = JSON.stringify({ steps: [], landing: { slug: "search", sourceId: "work_test" } });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-app', 'https://artifacts.test/app.git'),
      ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://artifacts.test/lib.git');
    INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,
       allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
       initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES ('work_test','app','timeline','search','orbit','work-app','https://artifacts.test/work-app.git','ready',
       'allocation','canonical','${main}','${git(work, "rev-parse", `${main}^{tree}`)}','refs/heads/main',
       'canonical','${main}','${git(work, "rev-parse", `${main}^{tree}`)}','refs/heads/main',datetime('now'),datetime('now'));
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, source_id) VALUES
      ('merge', 'app', 1, '${main}', 'gitmatrix/landing/search', 'manual', 'running', '${queue ? "canonical" : "work_test"}'),
      ('push', 'app', 2, '${main}', 'main', 'push', 'running', 'canonical'),
      ('old', 'app', 3, '${main}', 'gitmatrix/landing/search', 'manual', 'succeeded', 'work_test');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, source_id) VALUES
      ('land', 'merge', 'app', 'land', '${landing}', 'running', 'sandbox', '${queue ? "canonical" : "work_test"}'),
      ('mimic', 'push', 'app', 'land', '{"steps":[]}', 'running', 'sandbox', 'canonical'),
      ('build', 'push', 'app', 'build', '${landing}', 'running', 'sandbox', 'canonical'),
      ('done', 'old', 'app', 'land', '${landing}', 'succeeded', 'sandbox', 'work_test');
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
    ...fresh.env,
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
  const initiator = await issueToken(env.DB, "orbit", "initiator", "write");
  const authority = await captureWorkAuthority(env, "app", {
    id: "orbit",
    credential: { kind: "token", id: initiator.id },
  });
  sqlite
    .prepare("UPDATE ci_runs SET actor_id=?,space_id=?,migration_epoch=?,authority=?")
    .run("orbit", authority.spaceId, authority.migrationEpoch, JSON.stringify(authority));
  const backend = gitBackend(root);
  vi.stubGlobal("fetch", backend.fetch);
  const app = new Hono<AppEnv>().route("/", gitHttp);
  const server = await serve(app, env);
  closers.push(server.close);
  const token = (job = "land") => mintJobToken(env, job, 30);
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
    root,
    work,
    authority,
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

test.each([
  { repo: "app", source: "missing", state: "ready", status: 404 },
  { repo: "lib", source: "search", state: "ready", status: 404 },
  { repo: "app", source: "search", state: "purged", status: 410 },
])("native source admission preserves lifecycle status: $repo/$source/$state", async (input) => {
  const t = await setup();
  t.sqlite.exec("UPDATE repos SET visibility='public'");
  t.sqlite.prepare("UPDATE timeline_work_sources SET state=?").run(input.state);
  const response = await new Hono<AppEnv>()
    .route("/", gitHttp)
    .request(
      `/orbit/${input.repo}@${input.source}.git/info/refs?service=git-upload-pack`,
      {},
      t.env,
    );
  expect(response.status).toBe(input.status);
  expect(t.backend.requests).toEqual([]);
});

test("native Git denies revoked Space grants without treating Organization ownership as access", async () => {
  const t = await setup();
  const { secret } = await issueToken(t.env.DB, "orbit", "native", "write");
  const app = new Hono<AppEnv>().route("/", gitHttp);
  const request = async () => {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      "/orbit/app.git/info/refs?service=git-upload-pack",
      { headers: { authorization: `Bearer ${secret}` } },
      t.env,
      {
        waitUntil: (work: Promise<unknown>) => {
          pending.push(work);
        },
        passThroughOnException() {},
        props: {},
      } as ExecutionContext,
    );
    await Promise.all(pending);
    return response;
  };
  expect((await request()).status).toBe(200);
  const forwarded = t.backend.requests.length;
  t.sqlite.exec("DELETE FROM space_grants WHERE space_id='orbit' AND account_id='orbit'");
  expect((await request()).status).toBe(404);
  expect(t.backend.requests).toHaveLength(forwarded);
  expect(
    t.sqlite.prepare("SELECT role FROM organization_members WHERE account_id='orbit'").get(),
  ).toEqual({ role: "owner" });
});

test("job Git credentials are capped by the initiating credential on every request", async () => {
  const t = await setup();
  const secret = await t.token();
  expect((await t.infoRefs(secret, "git-upload-pack")).status).toBe(200);
  const forwarded = t.backend.requests.length;
  t.sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(t.authority.credential.id);
  expect((await t.infoRefs(secret, "git-upload-pack")).status).toBe(401);
  expect(t.backend.requests).toHaveLength(forwarded);
});

test("job credentials cannot cross source identities or write work refs", async () => {
  const t = await setup();
  t.sqlite.exec(
    "UPDATE ci_runs SET source_id='work_test' WHERE id='push'; UPDATE ci_jobs SET source_id='work_test' WHERE run_id='push'",
  );
  const secret = await t.token("build");
  const app = new Hono<AppEnv>().route("/", gitHttp);
  for (const [source, service] of [
    ["other", "git-upload-pack"],
    ["search", "git-receive-pack"],
  ]) {
    const result = await app.request(
      `/orbit/app@${source}.git/info/refs?service=${service}`,
      {
        headers: { authorization: `Bearer ${secret}` },
      },
      t.env,
    );
    expect(result.status).toBe(403);
  }
  expect(t.backend.requests).toEqual([]);
});

test("unmigrated canonical timeline pushes fail with the native timeline address", async () => {
  const t = await setup();
  const { secret } = await issueToken(t.env.DB, "orbit", "test", "write");
  const pushed = await t.receivePack(secret, [
    `${"0".repeat(40)} ${t.merge} refs/heads/timeline/unmigrated`,
  ]);
  expect(pushed.status).toBe(409);
  expect(pushed.text).toContain("/orbit/app@unmigrated.git");
  expect(pushed.forwarded).toEqual([]);
  expect(t.ref("refs/heads/main")).toBe(t.main);
});

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
    expect(await queueMergeJob(t.env, secret, "orbit", "app", t.main)).toMatchObject({
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
    ["UPDATE repos SET deleted_at=CURRENT_TIMESTAMP", 403],
    ["UPDATE merge_queue SET status='cancelled'", 403],
    ["UPDATE merge_queue SET attempts=2", 403],
    ["UPDATE merge_queue SET merge_run_id='replacement'", 403],
    ["UPDATE ci_runs SET status='cancelled' WHERE id='merge'", 401],
    ["UPDATE ci_jobs SET status='queued' WHERE id='land'", 403],
    [
      "UPDATE ci_runs SET commit_oid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id='merge'",
      403,
    ],
    ["UPDATE ci_runs SET ref='main' WHERE id='merge'", 403],
    [
      'UPDATE ci_jobs SET spec=\'{"steps":[],"queue":{"id":"wrong","attempt":1}}\' WHERE id=\'land\'',
      403,
    ],
  ] as const)(
    "revokes reads, writes and resolution for stale authority: %s",
    async (mutation, status) => {
      const t = await setup(true);
      const secret = await t.token();
      t.sqlite.exec(mutation);
      expect((await t.infoRefs(secret, "git-upload-pack")).status).toBe(status);
      const push = await t.receivePack(secret, [`${t.main} ${t.merge} refs/heads/${t.candidate}`]);
      expect(push.status).toBe(status);
      expect(await queueMergeJob(t.env, secret, "orbit", "app", t.main)).toMatchObject({
        ok: false,
        status,
      });
      expect(t.backend.requests).toEqual([]);
    },
  );

  test("pins a combined source and keeps replacement attempts on separate refs", async () => {
    const t = await setup(true);
    const oldSecret = await t.token();
    t.sqlite.prepare("UPDATE merge_queue SET data=?").run(JSON.stringify({ mergeSource: t.merge }));
    expect(await queueMergeJob(t.env, oldSecret, "orbit", "app")).toMatchObject({ ok: false });
    t.sqlite.prepare("UPDATE ci_runs SET commit_oid=? WHERE id='merge'").run(t.merge);
    expect(await queueMergeJob(t.env, oldSecret, "orbit", "app")).toMatchObject({ ok: true });
    const nextBranch = queueCandidateBranch(t.main, 2);
    t.sqlite
      .prepare(`INSERT INTO ci_runs
      (id,repo_id,number,commit_oid,ref,trigger,status,queue_id)
      VALUES ('replacement','app',4,?,?,'manual','running',?)`)
      .run(t.merge, nextBranch, t.main);
    t.sqlite
      .prepare(
        "UPDATE ci_runs SET actor_id=?,space_id=?,migration_epoch=?,authority=? WHERE id='replacement'",
      )
      .run("orbit", t.authority.spaceId, t.authority.migrationEpoch, JSON.stringify(t.authority));
    t.sqlite
      .prepare(`INSERT INTO ci_jobs
      (id,run_id,repo_id,name,spec,status,runner)
      VALUES ('replacement-job','replacement','app','land',?,'running','sandbox')`)
      .run(JSON.stringify({ steps: [], queue: { id: t.main, attempt: 2 } }));
    t.sqlite.exec("UPDATE merge_queue SET attempts=2,merge_run_id='replacement'");
    const nextSecret = await t.token("replacement-job");
    expect(await queueMergeJob(t.env, oldSecret, "orbit", "app")).toMatchObject({ ok: false });
    expect(await queueMergeJob(t.env, nextSecret, "orbit", "app")).toMatchObject({
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
      await queueMergeJob(t.env, await t.token(), "orbit", "app", "a".repeat(40)),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("ordinary queue source staging", () => {
  test("records source provenance before context upload and preserves ordinary pushes", async () => {
    const changeId = "queuestep01";
    const t = await setup(false, changeId);
    const { secret, id: tokenId } = await issueToken(t.env.DB, "orbit", "test", "write");
    const source = `refs/heads/gitmatrix/queue/${t.merge}`;
    const staged = await t.gitWith(secret, "push", t.proxyUrl, `HEAD:${source}`);
    expect(staged.status, staged.stderr).toBe(0);
    expect(t.ref(source)).toBe(t.merge);
    expect(t.ref("refs/heads/main")).toBe(t.main);
    expect(
      t.sqlite
        .prepare(
          "SELECT change_id, first_commit_oid, last_commit_oid FROM change_refs WHERE repo_id = 'app' AND ref = ?",
        )
        .all(source),
    ).toEqual([{ change_id: changeId, first_commit_oid: t.merge, last_commit_oid: t.merge }]);
    const context = new Hono<AppEnv>();
    context.use("*", async (c, next) => {
      c.set("actor", {
        id: "orbit",
        slug: "orbit-person",
        displayName: "Orbit",
        isSiteAdmin: false,
        credential: { kind: "token", id: tokenId },
      });
      await next();
    });
    context.route("/api/repos/:space/:name/steps", steps);
    const uploaded = await context.request(
      "/api/repos/orbit/app/steps",
      {
        method: "POST",
        body: JSON.stringify({
          changeId,
          commitOid: t.merge,
          summary: "Queued source context",
          committedAt: "2026-10-04T00:00:00.000Z",
          why: "Keep provenance while expensive staging effects remain disabled.",
        }),
      },
      t.env,
    );
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      commitOid: t.merge,
      verified: true,
      context: { why: "Keep provenance while expensive staging effects remain disabled." },
    });
    const direct = await t.gitWith(secret, "push", t.proxyUrl, "HEAD:refs/heads/main");
    expect(direct.status, direct.stderr).toBe(0);
    expect(t.ref("refs/heads/main")).toBe(t.merge);
    const mixed = await t.gitWith(
      secret,
      "push",
      t.proxyUrl,
      `HEAD:refs/heads/gitmatrix/queue/${t.main}`,
      "HEAD:refs/heads/feature",
    );
    expect(mixed.status, mixed.stderr).toBe(0);
    expect(t.ref("refs/heads/feature")).toBe(t.merge);
  });
});

test.each(["canonical", "staging"] as const)(
  "records %s push history after the provider finishes its streamed response",
  async (kind) => {
    const t = await setup();
    const { secret } = await issueToken(t.env.DB, "orbit", "test", "write");
    const pending: Promise<unknown>[] = [];
    vi.mocked(afterPush).mockImplementation((env, repo, actor, waitUntil) => {
      const recorded = recordPush(env, repo, actor);
      pending.push(recorded);
      waitUntil(recorded);
    });
    const upstream = t.backend.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/git-receive-pack")) {
        // Headers precede Git's ref transaction. Finish any already-started
        // observer before letting the real provider consume and accept the push.
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  await Promise.all(pending);
                  const response = await upstream(input, init);
                  controller.enqueue(new Uint8Array(await response.arrayBuffer()));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "application/x-git-receive-pack-result" } },
          ),
        );
      }
      return upstream(input, init);
    });
    try {
      const ref =
        kind === "staging" ? `refs/heads/gitmatrix/queue/${t.merge}` : "refs/heads/streamed";
      const pushed = await t.gitWith(secret, "push", t.proxyUrl, `HEAD:${ref}`);
      expect(pushed.status, pushed.stderr).toBe(0);
      await Promise.all(pending);
      expect(t.ref(ref)).toBe(t.merge);
      expect(
        t.sqlite
          .prepare("SELECT old_oid, new_oid FROM ref_updates WHERE repo_id='app' AND ref=?")
          .all(ref),
      ).toEqual([{ old_oid: null, new_oid: t.merge }]);
    } finally {
      await Promise.allSettled(pending);
      vi.mocked(afterPush).mockReset();
    }
  },
);

test("a canonical push forgets cached refs before its response ends", async () => {
  // Push effects (afterPush, mocked here) reach their own invalidation only after
  // several round trips, long after the client saw the push succeed.
  const t = await setup();
  const { secret } = await issueToken(t.env.DB, "orbit", "test", "write");
  const refs = () =>
    new RepoReader(t.env, "r-app", "https://artifacts.test/app.git", new Timing(), () => {}).refs();
  invalidateRefs("r-app");
  expect((await refs()).branches.map((branch) => branch.shortName)).not.toContain("pushed");
  const pushed = await t.gitWith(secret, "push", t.proxyUrl, "HEAD:refs/heads/pushed");
  expect(pushed.status, pushed.stderr).toBe(0);
  expect(afterPush).toHaveBeenCalled();
  expect((await refs()).branches).toContainEqual(
    expect.objectContaining({ shortName: "pushed", oid: t.merge }),
  );
});

test("native clones select current work HEAD and hide inherited canonical branches", async () => {
  const t = await setup();
  git(t.work, "push", "--quiet", "origin", "HEAD:refs/heads/work");
  t.sqlite.exec(`
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,created_at,updated_at)
    VALUES('work_a','app','native-timeline','native','orbit','r-work','https://artifacts.test/app.git','ready','allocate','canonical','${t.main}','tree','refs/heads/main','canonical','${t.main}','tree','refs/heads/main',1,'2026-01-01','2026-01-01');
    UPDATE ci_runs SET source_id='work_a' WHERE id='push';
    UPDATE ci_jobs SET source_id='work_a' WHERE run_id='push';
  `);
  const token = await t.token("build");
  const url = t.proxyUrl.replace("/app.git", "/app@native.git");
  for (const version of ["0", "2"]) {
    const destination = join(t.root, `native-${version}`);
    const clone = await t.gitWith(
      token,
      "-c",
      `protocol.version=${version}`,
      "clone",
      "--quiet",
      url,
      destination,
    );
    expect(clone.status, clone.stderr).toBe(0);
    expect(git(destination, "branch", "--show-current")).toBe("work");
    expect(git(destination, "rev-parse", "HEAD")).toBe(t.merge);
    expect(git(destination, "branch", "-r")).not.toContain("origin/main");
  }
  writeFileSync(join(t.work, "file"), "later work\n");
  git(t.work, "commit", "--quiet", "-am", "later");
  git(t.work, "push", "--quiet", "origin", "HEAD:refs/heads/work");
  const latest = git(t.work, "rev-parse", "HEAD");
  const destination = join(t.root, "native-latest");
  const clone = await t.gitWith(token, "clone", "--quiet", url, destination);
  expect(clone.status, clone.stderr).toBe(0);
  expect(git(destination, "rev-parse", "HEAD")).toBe(latest);
  expect(t.ref("refs/heads/main")).toBe(t.main);
});

describe("scrubbedError (CORE-308)", () => {
  test("keeps what failed and drops remotes and credentials", () => {
    expect(
      scrubbedError(
        new Error(
          "Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
        ),
      ),
    ).toBe(
      "Error: Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
    );
    const leaked = scrubbedError(
      new TypeError(
        "fetch https://u:secret@acct.artifacts.cloudflare.net/ns/repo.git failed with Bearer art_v1_0123456789abcdefABCDEF0123",
      ),
    );
    expect(leaked).toBe("TypeError: fetch [url] failed with Bearer [redacted]");
    expect(scrubbedError("word ".repeat(200))).toHaveLength(300);
  });
});

test("one-object recovery pack preserves the tree and permanently defeats a late old-to-new CAS", async () => {
  const t = await setup();
  const tree = git(t.work, "rev-parse", `${t.main}^{tree}`);
  const identity = { name: "Recovery", email: "recovery@example.test", time: 1700000000 };
  const content = encodeCommit({
    tree,
    parents: [t.main],
    author: identity,
    committer: identity,
    message: "Unique recovery marker\n",
  });
  const marker = hashObject("commit", content);
  const writer = new PackWriter();
  writer.header(1);
  writer.add("commit", content);
  const chunks = writer.finish();
  const pack = Buffer.concat(chunks);
  const repo = { artifacts_name: "r-app", artifacts_remote: "https://artifacts.test/app.git" };
  // Upload the original target without advancing the work ref, just as a
  // receive-pack can have its objects before attempting its ref transaction.
  git(t.work, "push", "--quiet", "origin", "HEAD:refs/gitmatrix/progress/original");
  expect(
    await writeRefs(t.env, repo, [{ ref: "refs/heads/work", old: null, new: t.main }]),
  ).toMatchObject([{ ok: true }]);
  expect(
    await writeRefs(t.env, repo, [{ ref: "refs/heads/work", old: t.main, new: marker }], pack),
  ).toMatchObject([{ ok: true }]);
  const remote = join(t.root, "app.git");
  expect(git(remote, "rev-parse", `${marker}^{tree}`)).toBe(tree);
  expect(git(remote, "rev-parse", `${marker}^`)).toBe(t.main);
  expect(
    await writeRefs(t.env, repo, [{ ref: "refs/heads/work", old: t.main, new: t.merge }]),
  ).toMatchObject([{ ok: false }]);
  expect(t.ref("refs/heads/work")).toBe(marker);
  expect(t.ref("refs/heads/main")).toBe(t.main);
  t.sqlite.close();
});
