import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  aiEnabled,
  command,
  validateEnvironment,
  redact,
  context,
  loadEnvironment,
  terminateProcessGroup,
  unitTestEnvironment,
} from "./environment.ts";
import type { Environment } from "./environment.ts";
import { parseEnvironmentLimits } from "./quota.ts";
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
    GITMATRIX_AI_GATEWAY: env.id,
    GITMATRIX_AGENT_AI: "enabled",
    GITMATRIX_AGENT_SECRET: env.secret,
    GITMATRIX_CI_DISPATCH_SECRET: env.dispatchSecret,
    GITMATRIX_CI_RUNNER: "local",
    TMPDIR: `/tmp/gitmatrix-agent/workspaces/${env.id}/tmp`,
    XDG_CONFIG_HOME: `${env.dir}/config`,
    XDG_CACHE_HOME: `${env.dir}/cache`,
    XDG_DATA_HOME: `${env.dir}/data`,
  };
}

// Unit transport fixture only; integration checks use the real gm and quota API.
async function quotaFixture(home: string, maximum = 4): Promise<void> {
  const directory = join(home, ".local/state/gitmatrix-agent");
  await mkdir(directory, { recursive: true });
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(
    join(directory, "limits.json"),
    JSON.stringify({
      maximum: 4,
      authority: "https://quota.example",
    }),
  );
  await writeFile(
    join(home, "bin", "gm"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = ${JSON.stringify(join(home, "quota.json"))};
const rows = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
if (process.env.GM_SERVER !== 'https://quota.example') throw new Error('wrong quota authority');
if (process.env.GM_TOKEN || process.env.GITMATRIX_TOKEN) throw new Error('product credential reached quota transport');
const failurePath = ${JSON.stringify(join(home, "quota-error.json"))};
if (fs.existsSync(failurePath)) {
  process.stderr.write(fs.readFileSync(failurePath, 'utf8')); process.exit(1);
}
let acknowledgement;
if (args[3] === 'POST') {
  const body = JSON.parse(args[args.indexOf('--data') + 1]);
  if (!rows[body.id] && Object.keys(rows).length >= ${maximum}) {
    console.error(JSON.stringify({ error: { code: 'conflict', message: 'Installation environment limit reached (' + Object.keys(rows).length + '/${maximum}). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.' } })); process.exit(1);
  }
  rows[body.id] = body;
  acknowledgement = { reserved: true, id: body.id };
} else if (args[3] === 'DELETE') {
  const id = args[4].split('/').at(-1);
  delete rows[id];
  acknowledgement = { released: true, id };
} else throw new Error('unexpected quota method');
fs.writeFileSync(path, JSON.stringify(rows));
const overridePath = ${JSON.stringify(join(home, "quota-response.json"))};
const overrides = fs.existsSync(overridePath) ? JSON.parse(fs.readFileSync(overridePath, 'utf8')) : {};
process.stdout.write(Object.hasOwn(overrides, args[3])
  ? overrides[args[3]].replaceAll('$ID', acknowledgement.id) : JSON.stringify(acknowledgement));
`,
    { mode: 0o700 },
  );
}

await test("gm quota admission reports safe capacity, conflict and authorization diagnostics", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-quota-diagnostic-"));
  try {
    await quotaFixture(home, 1);
    const output = await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import assert from 'node:assert/strict';
        import { writeFile } from 'node:fs/promises';
        import { reserveQuota } from ${JSON.stringify(new URL("./quota.ts", import.meta.url).href)};
        const first = ${JSON.stringify(owned(home))};
        const persist = async () => {};
        await reserveQuota(first, 'local', persist);
        const rejected = { ...first, id: 'gma-mga00000-111111abcdef', quota: undefined };
        await assert.rejects(reserveQuota(rejected, 'local', persist), error => {
          assert.match(error.message, /Installation environment limit reached \\(1\\/1\\)/);
          assert.match(error.message, /owning machines/);
          assert.match(error.message, /site administrator/);
          assert.match(error.message, /Expired reservations still require cleanup/);
          assert.doesNotMatch(error.message, /transport or credentials|Deploy/);
          return true;
        });
        assert.equal(rejected.quota.state, 'pending');
        const capacity = 'Installation environment limit reached (1/1). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.';
        for (const [diagnostic, expected] of [
          [JSON.stringify({ error: { code: 'conflict', message: 'Environment reservation belongs to a different owner or configuration.' } }), /different owner or configuration/],
          [JSON.stringify({ error: { code: 'conflict', message: capacity + ' secret-payload' } }), /no recognized capacity diagnostic/],
          [JSON.stringify({ error: { code: 'conflict', message: capacity.replace('(1/1)', '(2147483648/1)') } }), /no recognized capacity diagnostic/],
          [JSON.stringify({ error: { code: 'conflict', message: capacity.replace('(1/1)', '(-1/1)') } }), /no recognized capacity diagnostic/],
          [JSON.stringify({ error: { code: 'unauthenticated', message: 'secret-payload' } }), /authorization failed \\(401\\)/],
          [JSON.stringify({ error: { code: 'forbidden', message: capacity } }), /authorization failed \\(403\\)/],
          [JSON.stringify({ error: { code: 'unknown', message: capacity, hint: 'secret-payload' } }), /transport or credentials/],
          ['secret-payload ' + capacity, /transport or credentials/],
          [JSON.stringify({ error: ['secret-payload'] }), /transport or credentials/],
        ]) {
          await writeFile(${JSON.stringify(join(home, "quota-error.json"))}, diagnostic);
          await assert.rejects(reserveQuota(rejected, 'local', persist), error => {
            assert.match(error.message, expected);
            assert.doesNotMatch(error.message, /secret-payload|Installation environment limit reached/);
            return true;
          });
          assert.equal(rejected.quota.state, 'pending');
        }
        console.log('quota diagnostics checked');
        `,
      ],
      {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${join(home, "bin")}:${process.env.PATH}`,
        },
      },
    );
    assert.match(output, /quota diagnostics checked/);
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      1,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("machine limits require whole bounded values and an explicit credential-free authority", () => {
  assert.deepEqual(parseEnvironmentLimits({ maximum: 4 }), { maximum: 4, authority: undefined });
  assert.equal(
    parseEnvironmentLimits({ maximum: 0, authority: "https://quota.example" }).maximum,
    0,
  );
  for (const maximum of [-1, 1.2, "4", null, 2147483648])
    assert.throws(() => parseEnvironmentLimits({ maximum }), /maximum/);
  for (const authority of [
    "relative",
    "https://token@quota.example",
    "https://quota.example/path",
    "https://quota.example/",
  ])
    assert.throws(() => parseEnvironmentLimits({ maximum: 4, authority }));
});
await test(
  "shutdown waits for TERM-ignoring descendants after the launcher exits",
  { timeout: 35_000 },
  async (t) => {
    // Real POSIX signals and /proc identity fencing require the real shutdown grace;
    // advancing a JS clock cannot advance the independently scheduled child processes.
    const processStart = async (pid: number) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
    };
    const descendantProgram =
      'process.on("SIGTERM", () => {}); require("node:net").createServer().listen(0, "127.0.0.1", () => process.send("ready"));';
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], {
         stdio: ["ignore", "ignore", "ignore", "ipc"],
       });
       child.once("message", () => process.send(child.pid));
       process.on("SIGTERM", () => process.exit(0));`,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const pid = launcher.pid!;
    const birth = await processStart(pid);
    let descendant: number | undefined;
    let descendantBirth: string | undefined;
    t.after(async () => {
      for (const [child, start] of [
        [pid, birth],
        [descendant, descendantBirth],
      ] as const) {
        if (!child || !start || (await processStart(child)) !== start) continue;
        try {
          process.kill(child, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    });
    [descendant] = await once(launcher, "message", { signal: AbortSignal.timeout(5_000) });
    assert.equal(typeof descendant, "number");
    descendantBirth = await processStart(descendant!);
    assert.ok(birth);
    assert.ok(descendantBirth);
    await terminateProcessGroup(pid, birth);
    assert.equal(launcher.exitCode, 0);
    const stat = await readFile(`/proc/${descendant}/stat`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      },
    );
    assert.ok(
      (await processStart(descendant!)) !== descendantBirth ||
        stat.split(") ")[1]?.startsWith("Z "),
      "the owned descendant must be dead before shutdown completes",
    );
  },
);

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
  for (const gateway of [null, undefined, "gitmatrix", "unknown"])
    assert.throws(
      () =>
        validateEnvironment({ ...env, resources: { ...env.resources, gateway } } as Environment),
      /journal/,
    );
});

await test("runtime rejects cross-environment stores and credentials while accepting an owned ephemeral run", () => {
  const env = owned();
  env.dir = `${env.dir}/runs/${env.id}`;
  validateEnvironment(env);
  assert.equal(developmentEnvironment(runtime(env)).stateDir, `${env.dir}/state`);
  for (const gateway of ["gitmatrix", "gitmatrix-dev", "gma-mga00000-111111abcdef", undefined])
    assert.throws(
      () => developmentEnvironment({ ...runtime(env), GITMATRIX_AI_GATEWAY: gateway }),
      /gateway/i,
    );
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

await test("agent mode binds AI only when its environment provisioned it", () => {
  const env = owned();
  assert.equal(developmentEnvironment(runtime(env)).ai, true);
  const off = { ...runtime(env), GITMATRIX_AGENT_AI: "disabled", GITMATRIX_AI_GATEWAY: undefined };
  assert.equal(developmentEnvironment(off).ai, false);
  for (const value of [undefined, "", "yes"])
    assert.throws(
      () => developmentEnvironment({ ...runtime(env), GITMATRIX_AGENT_AI: value }),
      /GITMATRIX_AGENT_AI/,
    );
  // The canonical server: off unless GITMATRIX_DEV_AI=enabled.
  assert.equal(developmentEnvironment({}).ai, false);
  assert.equal(developmentEnvironment({ GITMATRIX_DEV_AI: "1" }).ai, false);
  assert.equal(developmentEnvironment({ GITMATRIX_DEV_AI: "enabled" }).ai, true);
});

await test("setup provisions no AI resources unless --ai", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-setup-ai-"));
  try {
    const bin = join(home, "bin");
    await mkdir(bin);
    const calls = join(home, "calls");
    await writeFile(calls, "");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='auth'){console.log(JSON.stringify({authenticated:true,tokenValid:true,accounts:[{id:'${"a".repeat(32)}'}]}));process.exit(0)} require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); console.log('{}');\n`,
      { mode: 0o700 },
    );
    await quotaFixture(home);
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const provision = async (root: string, ai: boolean | undefined) => {
      await mkdir(root, { recursive: true });
      await writeFile(calls, "");
      const output = await command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {context, createEnvironment, listEnvironments} from ${JSON.stringify(module)}; const env = await createEnvironment(${JSON.stringify(root)}, false${ai === undefined ? "" : `, ${ai}`}); console.log(JSON.stringify({env, listed: await listEnvironments(), vars: (await context(env)).env}));`,
        ],
        {
          env: {
            ...unitTestEnvironment(process.env),
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
          },
        },
      );
      const { env, listed, vars } = JSON.parse(output.trim().split("\n").at(-1)!) as {
        env: Environment;
        listed: { id: string; ai: boolean }[];
        vars: Record<string, string>;
      };
      const operations = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      return { env, listed, vars, operations };
    };
    // The default: Artifacts only, and the environment says AI is off.
    const plain = await provision(join(home, "plain"), undefined);
    assert.deepEqual(
      plain.operations.map((args) => args.slice(0, 3).join(" ")),
      ["artifacts namespaces create"],
    );
    assert.deepEqual(plain.env.resources, {
      artifacts: "created",
      vectors: "deleted",
      search: "deleted",
      gateway: "deleted",
    });
    assert.equal(plain.env.ai, false);
    assert.equal(aiEnabled(plain.env), false);
    assert.equal(plain.listed.find((e) => e.id === plain.env.id)?.ai, false);
    // The server it starts binds no AI.
    assert.equal(plain.vars.GITMATRIX_AGENT_AI, "disabled");
    assert.equal(developmentEnvironment(plain.vars).ai, false);
    // Asking for AI on that environment refuses rather than silently staying off.
    await assert.rejects(provision(join(home, "plain"), true), /setup --ai/);
    // --ai: the Gateway, Vectorize and AI Search too.
    const paid = await provision(join(home, "paid"), true);
    assert.deepEqual(
      paid.operations.map((args) => args.slice(0, 2).join(" ")),
      [
        "artifacts namespaces",
        "ai-gateway gateways",
        "vectorize create",
        "vectorize metadata-index",
        "vectorize metadata-index",
        "vectorize metadata-index",
        "ai-search namespace",
        "ai-search create",
      ],
    );
    assert.equal(paid.env.ai, true);
    assert.equal(paid.listed.find((e) => e.id === paid.env.id)?.ai, true);
    assert.equal(paid.vars.GITMATRIX_AGENT_AI, "enabled");
    assert.equal(developmentEnvironment(paid.vars).ai, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

await test("a stuck expired environment doesn't block creating another (CORE-292)", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-sweep-"));
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
    // Cloudflare refuses to delete the namespace, as with a stuck Artifacts one.
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nconsole.error('409 [10202] Namespace is not empty'); process.exit(1);\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const childEnv = {
      ...unitTestEnvironment(process.env),
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    };
    // cleanupExpired itself still reports the failure...
    await assert.rejects(
      command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
        ],
        { env: childEnv },
      ),
      /Cleanup incomplete/,
    );
    // ...but the sweep before a create warns and lets it go on.
    const output = await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {sweepBeforeCreate} from ${JSON.stringify(module)}; const errors = []; console.error = (...parts) => errors.push(parts.join(" ")); await sweepBeforeCreate(); console.log(JSON.stringify({ continued: true, errors }));`,
      ],
      { env: childEnv },
    );
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      continued: boolean;
      errors: string[];
    };
    assert.equal(result.continued, true);
    const deferred = result.errors.find((line) => line.includes("environment.cleanup_deferred"));
    assert.ok(deferred, "the deferred cleanup is reported");
    assert.match(deferred, new RegExp(env.id));
    // The journal stays for the next sweep.
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleting");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const gateway of [undefined, "pending", "created"] as const)
  await test(`cleanup retries incomplete ${gateway ? `${gateway} Gateway` : "legacy vector"} deletions without repeating completed providers`, async () => {
    const home = await mkdtemp(join(tmpdir(), "gitmatrix-cleanup-"));
    try {
      const root = join(home, "worktree");
      const directory = join(home, ".local/state/gitmatrix-agent/environments");
      const bin = join(home, "bin");
      await mkdir(directory, { recursive: true });
      await mkdir(root, { recursive: true });
      await mkdir(bin);
      const env = owned(root);
      if (gateway) env.resources.gateway = gateway;
      env.created -= 172_800_000;
      env.expires -= 172_800_000;
      const journal = join(directory, `${env.id}.json`);
      await writeFile(journal, JSON.stringify(env));
      const calls = join(home, "calls");
      const failure = join(home, "provider-unavailable");
      await writeFile(failure, "yes");
      await writeFile(
        join(bin, "cf"),
        `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); if(args[0]===${JSON.stringify(gateway ? "ai-gateway" : "vectorize")} && fs.existsSync(${JSON.stringify(failure)})){console.error('provider unavailable');process.exit(1)} console.log('[]');\n`,
        { mode: 0o700 },
      );
      const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
      const invocation = [
        "--input-type=module",
        "-e",
        `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
      ];
      const childEnv = {
        ...unitTestEnvironment(process.env),
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      };
      await assert.rejects(
        command(process.execPath, invocation, { env: childEnv }),
        /Cleanup incomplete/,
      );
      const partial = JSON.parse(await readFile(journal, "utf8")) as Environment;
      assert.equal(partial.status, "deleting");
      assert.deepEqual(partial.resources, {
        artifacts: "deleted",
        search: "deleted",
        vectors: gateway ? "deleted" : "created",
        ...(gateway ? { gateway } : {}),
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
      assert.deepEqual(
        retried,
        gateway
          ? [["ai-gateway", "gateways", "delete", env.id, "--force"]]
          : [["vectorize", "delete", env.id, "--force"]],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

await test("a crashed lock owner does not prevent the next cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-lock-"));
  const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
  const env = { ...unitTestEnvironment(process.env), HOME: home };
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
      {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
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
    const childEnv = { ...unitTestEnvironment(process.env), HOME: home, PATH: "/usr/bin:/bin" };
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

await test("legacy AI journals require recreation for use but remain valid for cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitmatrix-legacy-ai-"));
  try {
    const env = owned(root);
    await mkdir(env.dir);
    await writeFile(join(env.dir, "environment.json"), JSON.stringify(env));
    await assert.rejects(loadEnvironment(root), /destroy then setup/);
    await assert.rejects(context(env), /destroy then setup/);
    env.resources.vectors = "deleted";
    env.resources.search = "deleted";
    await writeFile(join(env.dir, "environment.json"), JSON.stringify(env));
    assert.deepEqual(await loadEnvironment(root), env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("retired namespace orphans release quota without losing cleanup or being readopted", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-orphan-"));
  try {
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const bin = join(home, "bin");
    await Promise.all([directory, bin].map((path) => mkdir(path, { recursive: true })));
    const calls = join(home, "calls");
    const refuse = join(home, "refuse");
    await writeFile(refuse, "");
    // Lists nothing, but refuses the namespace while `refuse` exists.
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='auth'){console.log(JSON.stringify({authenticated:true,tokenValid:true,accounts:[{id:'${"a".repeat(32)}'}]}));process.exit(0)} fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); if(args[0]==='artifacts'&&args[2]==='delete'&&fs.existsSync(${JSON.stringify(refuse)})){console.error('Namespace is not empty');process.exit(1)} console.log(args.includes('list')?'[]':'{}');\n`,
      { mode: 0o700 },
    );
    await quotaFixture(home);
    // Every slot taken by an expired environment whose namespace won't go.
    const journals: string[] = [];
    const reservations: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) {
      const env = owned(join(home, `worktree-${i}`));
      env.id = `gma-mga0000${i}-${String(i).repeat(12)}`;
      env.dir = join(env.root, ".gitmatrix-agent");
      env.created -= 172_800_000;
      env.expires -= 172_800_000;
      env.resources = { artifacts: "created", vectors: "deleted", search: "deleted" };
      env.quota = { authority: "https://quota.example", state: "reserved" };
      reservations[env.id] = {
        id: env.id,
        account: env.account,
        backend: "local",
        expires: env.expires,
      };
      await mkdir(env.dir, { recursive: true });
      await writeFile(join(env.dir, "environment.json"), JSON.stringify(env));
      journals.push(join(directory, `${env.id}.json`));
      await writeFile(journals[i]!, JSON.stringify(env));
    }
    await writeFile(join(home, "quota.json"), JSON.stringify(reservations));
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (code: string) =>
      command(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    for (const journal of journals) {
      const env = JSON.parse(await readFile(journal, "utf8")) as Environment;
      assert.equal(env.status, "orphaned");
      assert.equal(env.resources.artifacts, "orphaned");
      assert.equal(env.orphan?.namespace, env.id);
      assert.match(env.orphan?.reason ?? "", /not empty/);
      assert.equal(env.quota?.state, "released");
    }
    assert.deepEqual(JSON.parse(await readFile(join(home, "quota.json"), "utf8")), {});
    // New admission must not reclaim capacity for retired journals, including
    // legacy orphans that never had an installation reservation.
    const legacy = JSON.parse(await readFile(journals[0]!, "utf8")) as Environment;
    delete legacy.quota;
    await writeFile(journals[0]!, JSON.stringify(legacy));
    await run(
      `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(join(home, "worktree-0"))});`,
    );
    const active = JSON.parse(
      await readFile(join(home, "worktree-0/.gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))), [
      active.id,
    ]);
    // Once Cloudflare lets go, the next sweep finishes the deletion; journals stay.
    await rm(refuse);
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    for (const journal of journals) {
      const done = JSON.parse(await readFile(journal, "utf8")) as Environment;
      assert.equal(done.status, "deleted");
      assert.equal(done.resources.artifacts, "deleted");
      assert.equal(done.orphan, undefined);
    }
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))), [
      active.id,
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("released orphan journals stay retired while released live journals cannot be reused", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-released-orphan-"));
  try {
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const bin = join(home, "bin");
    const old = owned(join(home, "retired"));
    old.status = "orphaned";
    old.resources = { artifacts: "orphaned", vectors: "deleted", search: "deleted" };
    old.quota = { authority: "https://quota.example", state: "released" };
    await Promise.all([directory, bin, old.dir].map((path) => mkdir(path, { recursive: true })));
    const journal = join(directory, `${old.id}.json`);
    await writeFile(journal, JSON.stringify(old));
    await writeFile(join(old.dir, "environment.json"), JSON.stringify(old));
    await quotaFixture(home, 1);
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='auth'){console.log(JSON.stringify({authenticated:true,tokenValid:true,accounts:[{id:'${"a".repeat(32)}'}]}));process.exit(0)} if(args[0]==='artifacts'&&args[2]==='delete'&&args.includes('${old.id}')){console.error('Namespace is not empty');process.exit(1)} console.log(args.includes('list')?'[]':'{}');\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (root: string) =>
      command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`,
        ],
        {
          env: {
            ...unitTestEnvironment(process.env),
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
          },
        },
      );
    const root = join(home, "new-worktree");
    await mkdir(root);
    await run(root);
    const created = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    assert.notEqual(created.id, old.id);
    assert.equal(created.quota?.state, "reserved");
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))),
      [created.id],
      "only the new environment consumes the one available slot",
    );
    const retired = JSON.parse(await readFile(journal, "utf8")) as Environment;
    assert.equal(retired.status, "orphaned");
    assert.equal(retired.quota?.state, "released");
    // An inconsistent live journal still fails closed rather than borrowing that exception.
    old.status = "ready";
    old.resources.artifacts = "created";
    await writeFile(journal, JSON.stringify(old));
    await writeFile(join(old.dir, "environment.json"), JSON.stringify(old));
    await assert.rejects(run(old.root), /released environment reservation cannot be reused/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const login of ["valid", "logged out"] as const)
  await test(`cleanup ${login === "valid" ? "retries" : "doesn't retry"} a 401 when the login is ${login} (CORE-316)`, async () => {
    const home = await mkdtemp(join(tmpdir(), "gitmatrix-auth-"));
    try {
      const root = join(home, "worktree");
      const directory = join(home, ".local/state/gitmatrix-agent/environments");
      const bin = join(home, "bin");
      await mkdir(directory, { recursive: true });
      await mkdir(root, { recursive: true });
      await mkdir(bin);
      const env = owned(root);
      env.resources = { artifacts: "created", vectors: "deleted", search: "deleted" };
      env.status = "deleting";
      const journal = join(directory, `${env.id}.json`);
      await writeFile(journal, JSON.stringify(env));
      const calls = join(home, "calls");
      const refuse = join(home, "refuse");
      await writeFile(refuse, "once");
      // Cloudflare refuses the first listing as unauthenticated, as it did briefly in two sweeps.
      await writeFile(
        join(bin, "cf"),
        `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='auth'){console.log(JSON.stringify({authenticated:${login === "valid"},tokenValid:${login === "valid"}}));process.exit(0)}
if(args.includes('repos') && fs.existsSync(${JSON.stringify(refuse)})){fs.rmSync(${JSON.stringify(refuse)});console.error('[10000] Authentication error\\n401 Unauthorized');process.exit(1)}
console.log('[]');\n`,
        { mode: 0o700 },
      );
      const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
      const run = command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`,
        ],
        {
          env: {
            ...unitTestEnvironment(process.env),
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
          },
        },
      );
      const listed = async () =>
        (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args.includes("repos")).length;
      if (login === "valid") {
        await run;
        assert.equal(
          (JSON.parse(await readFile(journal, "utf8")) as Environment).status,
          "deleted",
        );
        assert.equal(await listed(), 2, "the refused listing is retried once");
      } else {
        await assert.rejects(run, /Authentication error/);
        assert.equal(
          (JSON.parse(await readFile(journal, "utf8")) as Environment).status,
          "deleting",
        );
        assert.equal(await listed(), 1, "a real logout is not retried");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

await test("machine admission, failed provisioning and failed release retain honest accounting", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-quota-"));
  try {
    await quotaFixture(home, 1);
    const bin = join(home, "bin");
    const calls = join(home, "calls");
    const failCreate = join(home, "fail-create");
    const failCleanup = join(home, "fail-cleanup");
    await writeFile(calls, "");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'auth') {
  console.log(JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] }));
} else if ((args.includes('create') && fs.existsSync(${JSON.stringify(failCreate)})) ||
           (args.includes('delete') && fs.existsSync(${JSON.stringify(failCleanup)}))) {
  console.error('provider unavailable'); process.exit(1);
} else console.log(args.includes('list') ? '[]' : '{}');
`,
      { mode: 0o700 },
    );
    const root = join(home, "worktree");
    await mkdir(root);
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (code: string) =>
      command(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          GM_SERVER: "https://product.example",
          GM_TOKEN: "fixture-product-token",
          GITMATRIX_TOKEN: "fixture-second-product-token",
        },
      });
    const create = `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`;
    const settings = join(home, ".local/state/gitmatrix-agent/limits.json");
    await writeFile(settings, JSON.stringify({ maximum: 0, authority: "https://quota.example" }));
    await assert.rejects(run(create), /Machine environment limit reached/);
    assert.equal(await readFile(calls, "utf8"), "", "local denial precedes provider access");
    await writeFile(settings, JSON.stringify({ maximum: 4 }));
    await assert.rejects(run(create), /explicit shared quota authority/);
    assert.equal(await readFile(calls, "utf8"), "", "missing authority cannot fail open");
    await writeFile(settings, JSON.stringify({ maximum: 4, authority: "https://quota.example" }));
    await writeFile(failCreate, "");
    await writeFile(failCleanup, "");
    await assert.rejects(run(create), /cleanup remains pending/);
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      1,
    );
    await rm(failCleanup);
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      0,
    );
    await rm(failCreate);
    await run(create);
    const journal = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    const gm = join(bin, "gm");
    const transport = await readFile(gm, "utf8");
    await writeFile(
      gm,
      `#!${process.execPath}\nconsole.error('authority unavailable'); process.exit(1);\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      run(
        `import {destroyEnvironment, registryLock} from ${JSON.stringify(module)}; await registryLock(() => destroyEnvironment(${JSON.stringify(journal)}));`,
      ),
      /quota authority .* refused DELETE/,
    );
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      1,
    );
    const pending = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    assert.equal(pending.status, "deleting");
    assert.equal(pending.resources.artifacts, "deleted");
    await writeFile(gm, transport, { mode: 0o700 });
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      0,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("concurrent worktrees share one per-machine admission lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-quota-concurrent-"));
  try {
    await quotaFixture(home);
    await writeFile(
      join(home, ".local/state/gitmatrix-agent/limits.json"),
      JSON.stringify({
        maximum: 1,
        authority: "https://quota.example",
      }),
    );
    await writeFile(
      join(home, "bin/cf"),
      `#!${process.execPath}
console.log(process.argv[2] === 'auth'
  ? JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] })
  : '{}');
`,
      { mode: 0o700 },
    );
    const roots = [join(home, "a"), join(home, "b")];
    await Promise.all(roots.map((root) => mkdir(root)));
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const attempts = await Promise.allSettled(
      roots.map((root) =>
        command(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`,
          ],
          {
            env: {
              ...unitTestEnvironment(process.env),
              HOME: home,
              PATH: `${join(home, "bin")}:${process.env.PATH}`,
            },
          },
        ),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const refused = attempts.find((result) => result.status === "rejected");
    assert(refused?.status === "rejected");
    assert.match(String(refused.reason), /Machine environment limit reached/);
    assert.equal(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))).length,
      1,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("false-success quota responses cannot authorize provisioning or discard retryable cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-quota-ack-"));
  try {
    await quotaFixture(home);
    const calls = join(home, "provider-calls");
    await writeFile(calls, "");
    await writeFile(
      join(home, "bin/cf"),
      `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
console.log(args[0] === 'auth'
  ? JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] })
  : args.includes('list') ? '[]' : '{}');
`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (code: string) =>
      command(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${join(home, "bin")}:${process.env.PATH}`,
        },
      });
    const overrides = join(home, "quota-response.json");
    const invalid = [
      "",
      "<html>Sign in</html>",
      "{}",
      "null",
      "[]",
      '{"reserved":true,"released":true,"id":"wrong-environment"}',
      '{"id":"$ID","reserved":false}',
      '{"id":"$ID","reserved":"true"}',
      '{"id":"$ID","unrelated":true}',
      '{"reserved":true}',
      '{"released":true}',
    ];
    for (let index = 0; index < invalid.length; index++) {
      const root = join(home, `refused-${index}`);
      await mkdir(root);
      await writeFile(overrides, JSON.stringify({ POST: invalid[index] }));
      await assert.rejects(
        run(
          `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`,
        ),
        /acknowledge/,
      );
    }
    const operations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      operations.filter((args) => args.includes("create")).length,
      0,
      "exit-zero HTML, empty or unrelated JSON must never authorize provider creation",
    );
    await rm(overrides);
    const root = join(home, "valid");
    await mkdir(root);
    await run(
      `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`,
    );
    const journalPath = join(root, ".gitmatrix-agent/environment.json");
    const admitted = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
    assert.equal(
      admitted.quota?.state,
      "reserved",
      "matching reserved:true acknowledgement admits",
    );
    for (const response of [
      ...invalid,
      JSON.stringify({ id: admitted.id, released: false }),
      JSON.stringify({ id: admitted.id, reserved: true }),
    ]) {
      await writeFile(overrides, JSON.stringify({ DELETE: response }));
      await assert.rejects(
        run(
          `import {destroyEnvironment, registryLock} from ${JSON.stringify(module)}; import {readFile} from 'node:fs/promises'; const env = JSON.parse(await readFile(${JSON.stringify(journalPath)}, 'utf8')); await registryLock(() => destroyEnvironment(env));`,
        ),
        /acknowledge/,
      );
      const pending = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
      assert.equal(pending.status, "deleting", "false success must preserve a retryable journal");
      assert.equal(
        pending.quota?.state,
        "reserved",
        "release requires its own matching acknowledgement",
      );
    }
    await rm(overrides);
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    const released = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
    assert.equal(released.status, "deleted");
    assert.equal(
      released.quota?.state,
      "released",
      "matching released:true acknowledgement completes cleanup",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
