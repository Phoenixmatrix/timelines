import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command, validateEnvironment, redact } from "./environment.ts";
import type { Environment } from "./environment.ts";
import { developmentEnvironment } from "../../apps/website/vite/environment.ts";

function owned(root = "/tmp/agent-worktree"): Environment {
  const created = Date.now();
  return {
    version: 1,
    id: "gma-mga00000-012345abcdef",
    root,
    dir: `${root}/.gitmatrix-agent`,
    origin: "http://127.0.0.1:19231",
    port: 19231,
    account: "a".repeat(32),
    created,
    expires: created + 86_400_000,
    secret: "b".repeat(64),
    dispatchSecret: "c".repeat(64),
    resources: { artifacts: "created", vectors: "created", search: "created" },
    status: "ready",
  };
}

function runtime(env: Environment): Record<string, string> {
  return {
    GITMATRIX_AGENT_ID: env.id,
    GITMATRIX_PORT: String(env.port),
    GITMATRIX_PUBLIC_URL: env.origin,
    GITMATRIX_STATE_DIR: `${env.dir}/state`,
    GITMATRIX_GM: `${env.root}/apps/cli/target/debug/gm`,
    GITMATRIX_ARTIFACTS_NAMESPACE: env.id,
    GITMATRIX_VECTORIZE_INDEX: env.id,
    GITMATRIX_SEARCH_NAMESPACE: env.id,
    GITMATRIX_AGENT_SECRET: env.secret,
    GITMATRIX_CI_DISPATCH_SECRET: env.dispatchSecret,
    GITMATRIX_CI_RUNNER: "local",
    TMPDIR: `/tmp/gitmatrix-agent/workspaces/${env.id}/tmp`,
    XDG_CONFIG_HOME: `${env.dir}/config`,
    XDG_CACHE_HOME: `${env.dir}/cache`,
    XDG_DATA_HOME: `${env.dir}/data`,
  };
}

await test("ownership rejects canonical, foreign and non-expiring environments", () => {
  const env = owned();
  assert.throws(() => validateEnvironment({ ...env, id: "gitmatrix-dev" }), /ownership/);
  assert.throws(
    () => validateEnvironment({ ...env, dir: "/tmp/other/.gitmatrix-agent" }),
    /outside/,
  );
  assert.throws(
    () => validateEnvironment({ ...env, port: 5180, origin: "http://127.0.0.1:5180" }),
    /canonical/,
  );
  assert.throws(
    () => validateEnvironment({ ...env, expires: env.created + 86_400_001 }),
    /lifetime/,
  );
});

await test("runtime rejects cross-environment stores and credentials while accepting an owned ephemeral run", () => {
  const env = owned();
  env.dir = `${env.dir}/runs/${env.id}`;
  validateEnvironment(env);
  assert.equal(developmentEnvironment(runtime(env)).stateDir, `${env.dir}/state`);
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(env),
        GITMATRIX_ARTIFACTS_NAMESPACE: "gma-mga00000-111111abcdef",
      }),
    /namespace|resource/i,
  );
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(env),
        XDG_CONFIG_HOME: `${env.root}/.gitmatrix-agent/config`,
      }),
    /XDG_CONFIG_HOME/,
  );
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(env),
        GITMATRIX_STATE_DIR: `${env.root}/.gitmatrix-agent/../state`,
      }),
    /state/i,
  );
  assert.throws(() => developmentEnvironment({ ...runtime(env), TMPDIR: "/tmp" }), /TMPDIR/);
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(env),
        TMPDIR: "/tmp/gitmatrix-agent/workspaces/gma-mga00000-111111abcdef/tmp",
      }),
    /TMPDIR/,
  );
});

await test("nonzero subprocess is rejected even with valid success-shaped JSON", async () => {
  await assert.rejects(
    command(process.execPath, ["-e", "console.log(JSON.stringify({jobs:[]})); process.exit(7)"]),
    /failed \(7\)/,
  );
});

await test("a timeout stays a failure when the subprocess handles termination with exit zero", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-deadline-"));
  const watcher = watch(home);
  try {
    const ready = once(watcher, "change");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = command(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => process.exit(0)); console.log("ready"); require("node:net").createServer().listen(0, "127.0.0.1", () => require("node:fs").writeFileSync(${JSON.stringify(join(home, "ready"))}, "ready"));`,
      ],
      { timeout: 1000 },
    );
    const rejected = assert.rejects(pending, /failed \(-1\):\nready/);
    await ready;
    t.mock.timers.tick(1000);
    await rejected;
  } finally {
    t.mock.timers.reset();
    watcher.close();
    await rm(home, { recursive: true, force: true });
  }
});

await test("diagnostic redaction removes personal and CI bearer credentials", () => {
  const message = redact("gmx_ABC123 gmj_987zyx Authorization: Bearer capability-secret");
  assert.equal(message, "[REDACTED] [REDACTED] Authorization: Bearer [REDACTED]");
});

await test("cleanup retries incomplete deletions before expiry without repeating completed providers", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-cleanup-"));
  try {
    const root = join(home, "worktree");
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const bin = join(home, "bin");
    await mkdir(directory, { recursive: true });
    await mkdir(root, { recursive: true });
    await mkdir(bin);
    const env = owned(root);
    env.created -= 172_800_000;
    env.expires -= 172_800_000;
    const journal = join(directory, `${env.id}.json`);
    await writeFile(journal, JSON.stringify(env));
    const calls = join(home, "calls");
    const failure = join(home, "provider-unavailable");
    await writeFile(failure, "yes");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); if(args[0]==='vectorize' && fs.existsSync(${JSON.stringify(failure)})){console.error('provider unavailable');process.exit(1)} console.log('[]');\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const invocation = [
      "--input-type=module",
      "-e",
      `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
    ];
    const childEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    await assert.rejects(
      command(process.execPath, invocation, { env: childEnv }),
      /Cleanup incomplete/,
    );
    const partial = JSON.parse(await readFile(journal, "utf8")) as Environment;
    assert.equal(partial.status, "deleting");
    assert.deepEqual(partial.resources, {
      artifacts: "deleted",
      search: "deleted",
      vectors: "created",
    });
    partial.created = Date.now();
    partial.expires = partial.created + 86_400_000;
    await writeFile(journal, JSON.stringify(partial));
    await rm(failure);
    await writeFile(calls, "");
    await command(process.execPath, invocation, { env: childEnv });
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleted");
    const retried = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(retried, [["vectorize", "delete", env.id, "--force"]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("a crashed lock owner does not prevent the next cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-lock-"));
  const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
  const env = { ...process.env, HOME: home };
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {registryLock} from ${JSON.stringify(module)}; await registryLock(async () => { console.log("locked"); await Promise.withResolvers().promise; });`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  try {
    const ready = Promise.withResolvers<void>();
    child.once("error", ready.reject);
    child.once("exit", () => ready.reject(new Error("Lock holder exited before acquiring")));
    child.stdout.once("data", () => ready.resolve());
    await ready.promise;
    child.kill("SIGKILL");
    await closed.promise;
    const result = await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {registryLock} from ${JSON.stringify(module)}; await registryLock(async () => console.log("reacquired"));`,
      ],
      { env, timeout: 5000 },
    );
    assert.equal(result.trim(), "reacquired");
  } finally {
    child.kill("SIGKILL");
    await closed.promise;
    await rm(home, { recursive: true, force: true });
  }
});

await test("redirected worktree state cannot block remote cleanup or delete foreign files", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-redirected-"));
  try {
    const root = join(home, "worktree");
    const foreign = join(home, "foreign");
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const bin = join(home, "bin");
    await Promise.all(
      [root, foreign, directory, bin].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(join(foreign, "keep"), "foreign state");
    await symlink(foreign, join(root, ".gitmatrix-agent"));
    const env = owned(root);
    env.created -= 172_800_000;
    env.expires -= 172_800_000;
    const journal = join(directory, `${env.id}.json`);
    await writeFile(journal, JSON.stringify(env));
    const calls = join(home, "calls");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('[]');\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
      ],
      { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } },
    );
    const deleted = JSON.parse(await readFile(journal, "utf8")) as Environment;
    assert.equal(deleted.status, "deleted");
    assert.deepEqual(deleted.resources, {
      artifacts: "deleted",
      vectors: "deleted",
      search: "deleted",
    });
    assert.equal(await readFile(join(foreign, "keep"), "utf8"), "foreign state");
    const operations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert(operations.some((args) => args.includes("delete") && args.includes("artifacts")));
    assert(operations.some((args) => args.includes("delete") && args.includes("vectorize")));
    assert(operations.some((args) => args.includes("delete") && args.includes("ai-search")));
    assert(operations.every((args) => args.includes(env.id)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("failed local cleanup stays retryable after remote resources have been deleted", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-local-cleanup-"));
  try {
    const env = owned(join(home, "worktree"));
    env.status = "deleting";
    env.resources = { artifacts: "deleted", vectors: "deleted", search: "deleted" };
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    await mkdir(directory, { recursive: true });
    await mkdir(env.dir, { recursive: true });
    const journal = join(directory, `${env.id}.json`);
    const local = join(env.dir, "environment.json");
    const credential = join(env.dir, "credential");
    await writeFile(journal, JSON.stringify(env));
    await writeFile(local, "{");
    await writeFile(credential, "owned credential");
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const invocation = [
      "--input-type=module",
      "-e",
      `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
    ];
    const childEnv = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };
    await assert.rejects(command(process.execPath, invocation, { env: childEnv }), /JSON/);
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleting");
    assert.equal(await readFile(credential, "utf8"), "owned credential");
    await writeFile(local, JSON.stringify(env));
    await command(process.execPath, invocation, { env: childEnv });
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleted");
    await assert.rejects(readFile(credential), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
