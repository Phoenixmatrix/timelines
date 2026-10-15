import assert from "node:assert/strict";
import { withFileLock } from "./heavy.ts";
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
import { HANDOFF_ENV, awaitHandoff } from "./live-run.ts";
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
// quota.json holds the authority's rows; GET lists them as the API does.
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
  // An authority older than CORE-368 rejects unknown fields.
  if (fs.existsSync(${JSON.stringify(join(home, "quota-legacy"))}) && Object.hasOwn(body, 'host')) {
    console.error(JSON.stringify({ error: { code: 'server_error', message: 'HTTP 400: Provide an owned environment id, Cloudflare account, local/remote backend and expiry (maximum 24 hours).' } })); process.exit(1);
  }
  if (!rows[body.id] && Object.keys(rows).length >= ${maximum}) {
    console.error(JSON.stringify({ error: { code: 'conflict', message: 'Installation environment limit reached (' + Object.keys(rows).length + '/${maximum}). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.' } })); process.exit(1);
  }
  rows[body.id] = body;
  acknowledgement = { reserved: true, id: body.id };
} else if (args[3] === 'DELETE') {
  const id = args[4].split('/').at(-1);
  const removed = Object.hasOwn(rows, id);
  // A stuck authority acknowledges without removing anything.
  if (!fs.existsSync(${JSON.stringify(join(home, "quota-stuck"))})) delete rows[id];
  acknowledgement = { released: true, id, removed };
} else if (args[3] === 'GET' && args[4] === '/environments') {
  acknowledgement = { maximum: ${maximum}, used: Object.keys(rows).length,
    reservations: Object.values(rows).map(({ id, backend, expires, host }) => ({ id, backend, expires, host: host ?? null })) };
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
  { timeout: 15_000 },
  async (t) => {
    // Real POSIX signals and /proc identity fencing stay real; only the grace before
    // SIGKILL is shortened (the descendant ignores TERM, so this also proves escalation).
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
    await terminateProcessGroup(pid, birth, { termGraceMs: 300 });
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

await test("the sweep before a create leaves orphaned namespaces to the janitor", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-orphan-sweep-"));
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
    env.status = "orphaned";
    env.resources = { artifacts: "orphaned", vectors: "deleted", search: "deleted" };
    await writeFile(join(directory, `${env.id}.json`), JSON.stringify(env));
    // Every cf call is recorded; Cloudflare still refuses the namespace.
    const calls = join(home, "cf-calls");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); console.error('409 [10202] Namespace is not empty'); process.exit(1);\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (code: string) =>
      command(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    await run(
      `import {sweepBeforeCreate} from ${JSON.stringify(module)}; await sweepBeforeCreate();`,
    );
    assert.equal(await readFile(calls, "utf8").catch(() => ""), "");
    // The hourly janitor still retries it.
    await run(
      `import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired().catch(() => {});`,
    );
    assert.match(await readFile(calls, "utf8"), /artifacts/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("a sweep skips an environment another process is destroying, then finishes it", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-destroy-lock-"));
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
    env.status = "deleting";
    const journal = join(directory, `${env.id}.json`);
    await writeFile(journal, JSON.stringify(env));
    const calls = join(home, "cf-calls");
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n'); console.log(process.argv.includes('list') ? '[]' : '{}');\n`,
      { mode: 0o700 },
    );
    const module = fileURLToPath(new URL("./environment.ts", import.meta.url));
    const run = (code: string) =>
      command(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    // A background cleanup holds this environment's destroy lock.
    const output = await withFileLock(join(directory, `${env.id}.destroy.lock`), 0, () =>
      run(
        `import {cleanupExpired} from ${JSON.stringify(module)}; const errors = []; console.error = (...parts) => errors.push(parts.join(" ")); await cleanupExpired(); console.log(JSON.stringify(errors));`,
      ),
    );
    const errors = JSON.parse(output.trim().split("\n").at(-1) ?? "[]") as string[];
    assert.ok(errors.some((line) => line.includes("cleanup.in-progress") && line.includes(env.id)));
    assert.equal(await readFile(calls, "utf8").catch(() => ""), "");
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleting");
    // Once it lets go, the next sweep destroys it.
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    assert.match(await readFile(calls, "utf8"), /artifacts/);
    assert.equal((JSON.parse(await readFile(journal, "utf8")) as Environment).status, "deleted");
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

await test("retired orphans survive failed retries and release crashes without blocking admission", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-orphan-"));
  try {
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const bin = join(home, "bin");
    await Promise.all([directory, bin].map((path) => mkdir(path, { recursive: true })));
    const calls = join(home, "calls");
    const refuse = join(home, "refuse");
    const providerFailure = join(home, "provider-failure");
    await writeFile(refuse, "");
    // Lists nothing, but refuses the namespace while `refuse` exists.
    await writeFile(
      join(bin, "cf"),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log(JSON.stringify({authenticated: true, tokenValid: true, accounts: [{id: '${"a".repeat(32)}'}]}));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const failure = fs.existsSync(${JSON.stringify(providerFailure)})
  ? fs.readFileSync(${JSON.stringify(providerFailure)}, 'utf8') : null;
if (failure && args.includes(failure) && args.some(arg => arg.startsWith('gma-mga'))) {
  console.error('provider ' + failure + ' unavailable');
  process.exit(1);
}
if (args[0] === 'artifacts' && args[2] === 'delete' && fs.existsSync(${JSON.stringify(refuse)})) {
  console.error('Namespace is not empty');
  process.exit(1);
}
console.log(args.includes('list') ? '[]' : '{}');
`,
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
    // releaseQuota persists its acknowledgement before destroyEnvironment writes
    // the terminal status. Recover that on-disk crash state, not just an orphan.
    const interrupted = JSON.parse(await readFile(journals[1]!, "utf8")) as Environment;
    interrupted.status = "deleting";
    await writeFile(journals[1]!, JSON.stringify(interrupted));
    await writeFile(join(interrupted.dir, "environment.json"), JSON.stringify(interrupted));
    const activeIds: string[] = [];
    for (const [index, failure] of ["list", "delete"].entries()) {
      await writeFile(providerFailure, failure);
      await assert.rejects(
        run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`),
        new RegExp(`provider ${failure} unavailable`),
      );
      const root = join(home, `worktree-${index}`);
      await run(
        `import {createEnvironment} from ${JSON.stringify(module)}; await createEnvironment(${JSON.stringify(root)});`,
      );
      const active = JSON.parse(
        await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
      ) as Environment;
      assert.equal(active.status, "ready");
      activeIds.push(active.id);
      assert.deepEqual(
        Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))),
        activeIds,
      );
      for (const journal of journals) {
        const retry = JSON.parse(await readFile(journal, "utf8")) as Environment;
        assert.equal(retry.status, "orphaned");
        assert.equal(retry.resources.artifacts, "orphaned");
        assert.equal(retry.quota?.state, journal === journals[0] ? undefined : "released");
      }
    }
    // Once Cloudflare lets go, the next sweep finishes the deletion; journals stay.
    await rm(refuse);
    await rm(providerFailure);
    await run(`import {cleanupExpired} from ${JSON.stringify(module)}; await cleanupExpired();`);
    for (const journal of journals) {
      const done = JSON.parse(await readFile(journal, "utf8")) as Environment;
      assert.equal(done.status, "deleted");
      assert.equal(done.resources.artifacts, "deleted");
      assert.equal(done.orphan, undefined);
    }
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(join(home, "quota.json"), "utf8"))),
      activeIds,
    );
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
            GITMATRIX_TEST_AUTH_RETRY_MS: "0,0",
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
    // One case per rejection class; each spawns a fresh node importing environment.ts.
    const invalid = [
      "",
      "<html>Sign in</html>",
      "{}",
      '{"reserved":true,"released":true,"id":"wrong-environment"}',
      '{"id":"$ID","reserved":false}',
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
      "",
      "{}",
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

async function quotaHome(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await quotaFixture(home);
  await writeFile(
    join(home, "bin/cf"),
    `#!${process.execPath}
const args = process.argv.slice(2);
console.log(args[0] === 'auth'
  ? JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] })
  : args.includes('list') ? '[]' : '{}');
`,
    { mode: 0o700 },
  );
  const environment = fileURLToPath(new URL("./environment.ts", import.meta.url));
  const reservations = fileURLToPath(new URL("./reservations.ts", import.meta.url));
  const quota = fileURLToPath(new URL("./quota.ts", import.meta.url));
  // A fixture machine id: the runner may have none (containers often don't).
  await writeFile(join(home, "machine-id"), "fixture-machine\n");
  const env = {
    ...unitTestEnvironment(process.env),
    HOME: home,
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
    GITMATRIX_AGENT_MACHINE_ID_FILE: join(home, "machine-id"),
  };
  const run = (code: string) =>
    command(process.execPath, ["--input-type=module", "-e", code], { env });
  /** This fixture machine's reservation host id, minted on first use. */
  const host = async () =>
    (
      await run(`import {hostId} from ${JSON.stringify(quota)}; console.log(await hostId() ?? '');`)
    ).trim();
  const rows = async () =>
    JSON.parse(await readFile(join(home, "quota.json"), "utf8")) as Record<
      string,
      { host?: string }
    >;
  return { home, env, environment, reservations, quota, run, rows, host };
}

await test("a release is recorded only once the authority no longer lists it (CORE-368)", async () => {
  const { home, environment, run, rows } = await quotaHome("gitmatrix-quota-removed-");
  try {
    const root = join(home, "worktree");
    await mkdir(root);
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(root)});`,
    );
    const journalPath = join(root, ".gitmatrix-agent/environment.json");
    const env = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
    const host = JSON.parse(
      await readFile(join(home, ".local/state/gitmatrix-agent/host.json"), "utf8"),
    ) as { id: string };
    assert.match(host.id, /^[a-f0-9]{32}$/);
    assert.equal((await rows())[env.id]?.host, host.id, "every reservation names its host");
    const destroy = `import {destroyEnvironment, registryLock} from ${JSON.stringify(environment)}; import {readFile} from 'node:fs/promises'; const env = JSON.parse(await readFile(${JSON.stringify(journalPath)}, 'utf8')); await registryLock(() => destroyEnvironment(env));`;
    // Acknowledged, removed nothing, and the row is still there: not released.
    await writeFile(join(home, "quota-stuck"), "");
    await writeFile(
      join(home, "quota-response.json"),
      JSON.stringify({ DELETE: '{"id":"$ID","released":true,"removed":false}' }),
    );
    await assert.rejects(run(destroy), /still lists it/);
    let journal = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
    assert.equal(journal.status, "deleting");
    assert.equal(journal.quota?.state, "reserved");
    assert.ok((await rows())[env.id], "the reservation is retained for retry");
    // Removed nothing because the row is already gone: verified absent, so released.
    await rm(join(home, "quota-stuck"));
    await run(destroy);
    journal = JSON.parse(await readFile(journalPath, "utf8")) as Environment;
    assert.equal(journal.status, "deleted");
    assert.equal(journal.quota?.state, "released");
    assert.deepEqual(await rows(), {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("a stale copy never re-reserves or un-releases a released reservation (CORE-368)", async () => {
  const { home, environment, run, rows } = await quotaHome("gitmatrix-quota-forward-");
  try {
    const root = join(home, "worktree");
    await mkdir(root);
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(root)});`,
    );
    const stale = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    assert.equal(stale.quota?.state, "reserved");
    const central = join(home, ".local/state/gitmatrix-agent/environments", `${stale.id}.json`);
    // An inconsistent journal: still ready, but its release was acknowledged.
    await writeFile(
      central,
      JSON.stringify({ ...stale, quota: { ...stale.quota, state: "released" } }),
    );
    await writeFile(join(home, "quota.json"), "{}");
    const withStale = (body: string) =>
      run(
        `import {context, markServer} from ${JSON.stringify(environment)}; const env = ${JSON.stringify(stale)}; ${body}`,
      );
    await assert.rejects(withStale("await context(env);"), /already released/);
    assert.deepEqual(await rows(), {}, "context must not POST a released reservation");
    // Any other journal write merges forward: the stale reserved copy loses.
    await withStale(
      "await markServer(env, process.pid); if (env.quota.state !== 'released') throw new Error('in-memory quota regressed');",
    );
    const merged = JSON.parse(await readFile(central, "utf8")) as Environment;
    assert.equal(merged.quota?.state, "released");
    assert.equal(merged.server?.pid !== undefined, true);
    // Without a central journal, an in-memory release alone still refuses.
    await rm(central);
    await assert.rejects(
      run(
        `import {context} from ${JSON.stringify(environment)}; await context(${JSON.stringify({ ...stale, quota: { ...stale.quota, state: "released" } })});`,
      ),
      /already released/,
    );
    assert.deepEqual(await rows(), {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("the sweep releases only released-locally and own-orphan reservations (CORE-368)", async () => {
  const {
    home,
    environment,
    reservations,
    run,
    rows,
    host: hostOf,
  } = await quotaHome("gitmatrix-reconcile-");
  try {
    const state = join(home, ".local/state/gitmatrix-agent");
    const local = join(state, "environments");
    const remote = join(state, "remote/environments");
    await mkdir(local, { recursive: true });
    await mkdir(remote, { recursive: true, mode: 0o700 });
    const host = await hostOf();
    assert.match(host, /^[a-f0-9]{32}$/);
    const quota = (state: "reserved" | "released") => ({
      authority: "https://quota.example",
      state,
    });
    const journal = async (id: string, edit: (env: Environment) => void) => {
      const env = owned(join(home, id));
      env.id = id;
      env.dir = join(env.root, ".gitmatrix-agent");
      edit(env);
      await writeFile(join(local, `${id}.json`), JSON.stringify(env));
      return env;
    };
    const live = await journal("gma-mga00001-111111111111", (env) => {
      env.quota = quota("reserved");
    });
    const released = await journal("gma-mga00002-222222222222", (env) => {
      env.status = "deleted";
      env.resources = { artifacts: "deleted", vectors: "deleted", search: "deleted" };
      env.quota = quota("released");
    });
    // Deleted long ago and due for pruning, but its row was never really freed.
    const old = await journal("gma-mga00003-333333333333", (env) => {
      env.status = "deleted";
      env.resources = { artifacts: "deleted", vectors: "deleted", search: "deleted" };
      env.created -= 10 * 86_400_000;
      env.expires -= 10 * 86_400_000;
      env.quota = quota("released");
    });
    const parent = "gmr-" + "4".repeat(24);
    const child = "gma-mga00004-444444444444";
    const releasedChild = "gma-mga00007-777777777777";
    await writeFile(
      join(remote, `${parent}.json`),
      JSON.stringify({
        id: parent,
        quota: quota("reserved"),
        resources: [
          { id: child, account: "a".repeat(32), quota: quota("reserved"), resources: {} },
          { id: releasedChild, account: "a".repeat(32), quota: quota("released"), resources: {} },
        ],
      }),
      { mode: 0o600 },
    );
    const orphan = "gma-mga00005-555555555555";
    const legacy = "gma-mga00006-666666666666";
    const elsewhere = "gma-mga00008-888888888888";
    // Expired long ago, host-less and unjournaled: only `--release --expired` frees it.
    const stale = "gma-mga00009-999999999999";
    // Deleted long ago: one pinned to another authority, one never admitted.
    const moved = await journal("gma-mga0000a-aaaaaaaaaaaa", (env) => {
      env.status = "deleted";
      env.resources = { artifacts: "deleted", vectors: "deleted", search: "deleted" };
      env.created -= 10 * 86_400_000;
      env.expires -= 10 * 86_400_000;
      env.quota = { authority: "https://other.example", state: "released" };
    });
    const unadmitted = await journal("gma-mga0000b-bbbbbbbbbbbb", (env) => {
      env.status = "deleted";
      env.resources = { artifacts: "deleted", vectors: "deleted", search: "deleted" };
      env.created -= 10 * 86_400_000;
      env.expires -= 10 * 86_400_000;
    });
    const row = (id: string, rowHost?: string, expires = Date.now()) => ({
      id,
      account: "a".repeat(32),
      backend: "local",
      expires,
      ...(rowHost ? { host: rowHost } : {}),
    });
    const initial = {
      [live.id]: row(live.id, host),
      [released.id]: row(released.id, host),
      [old.id]: row(old.id),
      [parent]: row(parent, host),
      // Even tagged with this host, a child its parent still holds is live.
      [child]: row(child, host),
      [releasedChild]: row(releasedChild),
      [orphan]: row(orphan, host),
      [legacy]: row(legacy),
      [elsewhere]: row(elsewhere, "another-machine"),
      [stale]: row(stale, undefined, Date.now() - 3 * 86_400_000),
    };
    await writeFile(join(home, "quota.json"), JSON.stringify(initial));
    const report = JSON.parse(
      await run(
        `import {reconcileReservations} from ${JSON.stringify(reservations)}; console.log(JSON.stringify(await reconcileReservations(false)));`,
      ),
    ) as { host: string; reservations: { id: string; class: string }[]; released: unknown[] };
    assert.equal(report.host, host);
    assert.deepEqual(
      Object.fromEntries(report.reservations.map(({ id, class: kind }) => [id, kind])),
      {
        [live.id]: "live",
        [released.id]: "released-locally",
        [old.id]: "released-locally",
        [parent]: "live",
        [child]: "live",
        [releasedChild]: "released-locally",
        [orphan]: "own-orphan",
        [legacy]: "foreign",
        [elsewhere]: "foreign",
        [stale]: "expired-foreign",
      },
    );
    assert.deepEqual(report.released, [], "listing alone releases nothing");
    assert.deepEqual(Object.keys(await rows()).sort(), Object.keys(initial).sort());
    // An unreadable listing is not an empty one: release and prune nothing.
    await writeFile(join(home, "quota-response.json"), JSON.stringify({ GET: "<html>" }));
    const sweep = `import {cleanupExpired} from ${JSON.stringify(environment)}; await cleanupExpired();`;
    await run(sweep);
    assert.deepEqual(Object.keys(await rows()).sort(), Object.keys(initial).sort());
    await readFile(join(local, `${old.id}.json`));
    await rm(join(home, "quota-response.json"));
    // A background cleanup's lock file goes with its pruned journal.
    await writeFile(join(local, `${old.id}.destroy.lock`), "");
    await run(sweep);
    assert.deepEqual(
      Object.keys(await rows()).sort(),
      [live.id, child, legacy, elsewhere, parent, stale].sort(),
      "the sweep never releases expired-foreign rows",
    );
    await assert.rejects(readFile(join(local, `${old.id}.json`)), { code: "ENOENT" });
    await assert.rejects(readFile(join(local, `${old.id}.destroy.lock`)), { code: "ENOENT" });
    await assert.rejects(readFile(join(local, `${unadmitted.id}.json`)), { code: "ENOENT" });
    // Its authority was not listed, so nothing proves that reservation is gone.
    await readFile(join(local, `${moved.id}.json`));
    const kept = JSON.parse(
      await readFile(join(local, `${released.id}.json`), "utf8"),
    ) as Environment;
    assert.equal(kept.quota?.state, "released");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("an authority without host support still admits, recording no host (CORE-368)", async () => {
  const { home, environment, run, rows } = await quotaHome("gitmatrix-quota-legacy-");
  try {
    await writeFile(join(home, "quota-legacy"), "");
    const root = join(home, "worktree");
    await mkdir(root);
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(root)});`,
    );
    const env = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    assert.equal(env.quota?.state, "reserved");
    assert.equal(Object.hasOwn((await rows())[env.id]!, "host"), false);
    // Other refusals are never retried as a different request.
    await writeFile(
      join(home, "quota-error.json"),
      JSON.stringify({ error: { code: "server_error", message: "HTTP 500: unavailable" } }),
    );
    const other = join(home, "other");
    await mkdir(other);
    await assert.rejects(
      run(
        `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(other)});`,
      ),
      /refused POST/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("maintenance reservations --release --expired frees only expired unjournaled rows (CORE-368)", async () => {
  const { home, env, rows } = await quotaHome("gitmatrix-reservations-expired-");
  try {
    const state = join(home, ".local/state/gitmatrix-agent");
    await mkdir(join(state, "environments"), { recursive: true });
    const live = owned(join(home, "live"));
    live.quota = { authority: "https://quota.example", state: "reserved" };
    await writeFile(join(state, "environments", `${live.id}.json`), JSON.stringify(live));
    const longAgo = Date.now() - 3 * 86_400_000;
    const legacy = "gma-mga00009-999999999999";
    const recent = "gma-mga00008-888888888888";
    const row = (id: string, expires: number) => ({
      id,
      account: "a".repeat(32),
      backend: "local",
      expires,
    });
    // The live row expired long ago too: its journal, not its clock, decides.
    await writeFile(
      join(home, "quota.json"),
      JSON.stringify({
        [live.id]: row(live.id, longAgo),
        [legacy]: row(legacy, longAgo),
        [recent]: row(recent, Date.now() - 3_600_000),
      }),
    );
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const maintenance = async (...flags: string[]) =>
      JSON.parse(
        await command(process.execPath, [main, "maintenance", "reservations", ...flags], { env }),
      ) as { reservations: { id: string; class: string }[]; released: { id: string }[] };
    const listing = await maintenance();
    assert.deepEqual(
      Object.fromEntries(listing.reservations.map(({ id, class: kind }) => [id, kind])),
      { [live.id]: "live", [legacy]: "expired-foreign", [recent]: "foreign" },
    );
    assert.deepEqual((await maintenance("--release")).released, []);
    assert.equal(Object.keys(await rows()).length, 3, "--release alone keeps expired-foreign rows");
    assert.deepEqual(
      (await maintenance("--release", "--expired")).released.map(({ id }) => id),
      [legacy],
    );
    assert.deepEqual(Object.keys(await rows()).sort(), [live.id, recent].sort());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("the reservation host id belongs to one machine and is published atomically (CORE-368)", async () => {
  const { home, env, quota, host } = await quotaHome("gitmatrix-host-id-");
  try {
    const path = join(home, ".local/state/gitmatrix-agent/host.json");
    const stored = async () => JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    // Concurrent first use: every process ends up with the one published id.
    const ids = await Promise.all(Array.from({ length: 8 }, () => host()));
    assert.equal(new Set(ids).size, 1);
    const [id] = ids;
    assert.match(id!, /^[a-f0-9]{32}$/);
    assert.equal((await stored()).id, id);
    assert.match((await stored()).machine!, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(await stored()).includes("fixture-machine"), "only a digest is kept");
    assert.equal(await host(), id, "stable across calls");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(
      (await readdir(join(home, ".local/state/gitmatrix-agent"))).filter((name) =>
        name.startsWith("host.json"),
      ),
      ["host.json"],
      "no temporary files are left behind",
    );
    // A home copied from another machine never reuses that machine's id.
    await writeFile(path, JSON.stringify({ id: "copied-id", machine: "f".repeat(64) }));
    const fresh = await host();
    assert.notEqual(fresh, "copied-id");
    assert.match(fresh, /^[a-f0-9]{32}$/);
    assert.equal((await stored()).id, fresh);
    // Nor does one minted before fingerprints existed.
    await writeFile(path, JSON.stringify({ id: fresh }));
    assert.notEqual(await host(), fresh);
    // Concurrent replacement of a foreign file still converges on one id.
    await writeFile(path, JSON.stringify({ id: "copied-id", machine: "f".repeat(64) }));
    await Promise.all(Array.from({ length: 6 }, () => host()));
    const settled = (await stored()).id;
    assert.notEqual(settled, "copied-id");
    assert.equal(await host(), settled);
    // A provably empty file is absent; a garbled one is an error naming it.
    await writeFile(path, "");
    assert.match(await host(), /^[a-f0-9]{32}$/);
    await writeFile(path, "{");
    await assert.rejects(host(), (error: Error) => error.message.includes(path));
    await writeFile(path, JSON.stringify({ id: "has space" }));
    await assert.rejects(host(), /Unreadable reservation host id/);
    // Without a machine id there is no host at all, and nothing is written.
    await rm(path);
    const none = await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {hostId} from ${JSON.stringify(quota)}; console.log(JSON.stringify(await hostId() ?? null));`,
      ],
      { env: { ...env, GITMATRIX_AGENT_MACHINE_ID_FILE: join(home, "missing-machine-id") } },
    );
    assert.equal(none.trim(), "null");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("setup never adopts a journal a background cleanup is destroying (CORE-368)", async () => {
  const { home, env, environment, run, rows } = await quotaHome("gitmatrix-adopt-destroying-");
  try {
    const calls = join(home, "cf-calls");
    await writeFile(
      join(home, "bin/cf"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'auth') require('node:fs').appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
console.log(args[0] === 'auth'
  ? JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] })
  : args.includes('list') ? '[]' : '{}');
`,
      { mode: 0o700 },
    );
    const first = join(home, "first");
    await mkdir(first);
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(first)});`,
    );
    const created = JSON.parse(
      await readFile(join(first, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const journal = join(directory, `${created.id}.json`);
    // Mid-destroy: marked deleting, and its release has reached the authority but not yet
    // the journal. Adopting it now would reserve the row again.
    const text = JSON.stringify({ ...created, status: "deleting" });
    await writeFile(journal, text);
    await writeFile(join(home, "quota.json"), "{}");
    await writeFile(calls, "");
    const second = join(home, "second");
    await mkdir(second);
    const create = `import {createEnvironment} from ${JSON.stringify(environment)}; const errors = []; console.error = (...parts) => errors.push(parts.join(" ")); const env = await createEnvironment(${JSON.stringify(second)}, true); console.log(JSON.stringify({id: env.id, errors}));`;
    const output = await withFileLock(join(directory, `${created.id}.destroy.lock`), 0, () =>
      command(process.execPath, ["--input-type=module", "-e", create], { env }),
    );
    const { id, errors } = JSON.parse(output.trim().split("\n").at(-1)!) as {
      id: string;
      errors: string[];
    };
    assert.ok(
      errors.some((line) => line.includes("adoption-skipped") && line.includes(created.id)),
    );
    assert.equal(await readFile(journal, "utf8"), text, "the journal being destroyed is untouched");
    assert.deepEqual(Object.keys(await rows()), [id], "no reservation is resurrected");
    assert.ok(!(await readFile(calls, "utf8")).includes(created.id), "nor is it destroyed twice");
    // Once that destroy lets go, the next sweep finishes it and nothing re-reserves it.
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(second)}, true);`,
    );
    const finished = JSON.parse(await readFile(journal, "utf8")) as Environment;
    assert.equal(finished.status, "deleted");
    assert.equal(finished.quota?.state, "released");
    assert.ok(!(created.id in (await rows())));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("the detached cleanup marks the journal deleting under its lock, then announces", async () => {
  const { home, env, environment, run, rows } = await quotaHome("gitmatrix-cleanup-handoff-");
  try {
    const root = join(home, "worktree");
    await mkdir(root);
    await run(
      `import {createEnvironment} from ${JSON.stringify(environment)}; await createEnvironment(${JSON.stringify(root)});`,
    );
    const created = JSON.parse(
      await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8"),
    ) as Environment;
    const directory = join(home, ".local/state/gitmatrix-agent/environments");
    const journal = join(directory, `${created.id}.json`);
    // Remote deletions wait for this file, so the destroy is observed in flight.
    const release = join(home, "release");
    await writeFile(
      join(home, "bin/cf"),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'auth') while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
console.log(args[0] === 'auth'
  ? JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: '${"a".repeat(32)}' }] })
  : args.includes('list') ? '[]' : '{}');
`,
      { mode: 0o700 },
    );
    const liveRun = fileURLToPath(new URL("./live-run.ts", import.meta.url));
    const announced = join(home, "journal-at-announcement.json");
    // As main.ts's destroy-environment does it, with the pipe and variable ready sets.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        // Records the journal as it stands when the child announces, before destroyEnvironment's
        // own writes, in a file written before the announcement (two pipes have no common order).
        `import {copyFileSync} from "node:fs"; import {destroyExclusively} from ${JSON.stringify(environment)}; import {announceHandoff} from ${JSON.stringify(liveRun)}; await destroyExclusively(${JSON.stringify(created)}, () => { copyFileSync(${JSON.stringify(journal)}, ${JSON.stringify(announced)}); announceHandoff(); });`,
      ],
      { env: { ...env, [HANDOFF_ENV]: "1" }, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = once(child, "exit");
    try {
      assert.equal(
        await awaitHandoff({ channel: child.stdio[3]!, child, timeoutMs: 60_000 }),
        "locked",
        output,
      );
      const marked = JSON.parse(await readFile(announced, "utf8")) as Environment;
      assert.equal(marked.status, "deleting");
      assert.equal(marked.quota?.state, "reserved");
      // The child still holds the destroy lock: a sweep would skip this journal.
      let busy = false;
      await assert.rejects(
        withFileLock(
          join(directory, `${created.id}.destroy.lock`),
          0,
          async () => {},
          () => {
            busy = true;
            throw new Error("busy");
          },
        ),
        /busy/,
      );
      assert.ok(busy);
    } finally {
      await writeFile(release, "");
    }
    const [code] = await exited;
    assert.equal(code, 0, output);
    const finished = JSON.parse(await readFile(journal, "utf8")) as Environment;
    assert.equal(finished.status, "deleted");
    assert.deepEqual(await rows(), {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test("an invalid GITMATRIX_E2E_WORKERS warns once in context() instead of failing", async () => {
  const { home, env, environment } = await quotaHome("gitmatrix-context-workers-");
  try {
    const root = join(home, "worktree");
    await mkdir(root);
    const output = await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {context, createEnvironment} from ${JSON.stringify(environment)}; const warnings = []; console.warn = (...parts) => warnings.push(parts.join(" ")); const env = await createEnvironment(${JSON.stringify(root)}); const runners = [(await context(env)).env.GITMATRIX_CI_RUNNERS, (await context(env)).env.GITMATRIX_CI_RUNNERS]; console.log(JSON.stringify({runners, warnings}));`,
      ],
      { env: { ...env, GITMATRIX_E2E_WORKERS: "two" } },
    );
    const { runners, warnings } = JSON.parse(output.trim().split("\n").at(-1)!) as {
      runners: string[];
      warnings: string[];
    };
    assert.deepEqual(runners, ["2", "2"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /GITMATRIX_E2E_WORKERS must be a positive integer, not two/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
