import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ensureRemoteDeployment,
  teardownRemote,
  validateRemoteEnvironment,
} from "./remote-environment.ts";
import type { RemoteEnvironment } from "./remote-environment.ts";
import {
  authenticate,
  nextCredentialRefresh,
  cfApiNotFound,
  deleteRemoteApplication,
  ownedContainerApplication,
  remoteRequest,
  waitForRemoteDeployment,
} from "./remote.ts";

const exec = promisify(execFile);

await it("loads a dependency-free checkout config through cf's native loader and schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-config-fixture-"));
  try {
    const config = join(directory, "cloudflare.config.ts");
    await copyFile(new URL("../remote/cloudflare.config.ts", import.meta.url), config);
    // Resolve the installed CLI's actual consumer, not a duplicate local schema.
    const cli = await realpath(
      new URL("../../apps/website/node_modules/cf/dist/config.mjs", import.meta.url),
    );
    const manifest = findPackageJSON("@cloudflare/config", pathToFileURL(cli));
    assert.ok(manifest);
    const consumer = pathToFileURL(join(dirname(manifest), "dist/index.mjs")).href;
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      const { loadAndParseConfig } = await import(${JSON.stringify(consumer)});
      const { result } = await loadAndParseConfig(${JSON.stringify(config)}, { isPreview: false, mode: undefined });
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(result.data.worker.name, 'gmr-0123456789abcdef01234567');
      assert.equal(result.data.worker.env.CONTROL_TOKEN.type, 'secret');
      assert.equal(result.data.worker.env.WORKSPACE.exportName, 'RemoteWorkspace');
      assert.equal(result.data.worker.env.ACCOUNT_ID.value, process.env.CLOUDFLARE_ACCOUNT_ID);
      assert.equal(result.data.containers.length, 1);
      assert.equal(result.data.containers[0].images.default.reference, process.env.GITMATRIX_CI_IMAGE);
    `,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          GITMATRIX_REMOTE_TYPEGEN: "0",
          CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
          GITMATRIX_REMOTE_SESSION_ID: "0123456789abcdef01234567",
          GITMATRIX_REMOTE_EXPIRES_AT: "1800000000000",
          GITMATRIX_CI_IMAGE: `registry.cloudflare.com/ci@sha256:${"a".repeat(64)}`,
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await it("packages without node_modules and passes cf's real prebuilt upload consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-prebuilt-fixture-"));
  try {
    for (const path of [
      "tools/agent/remote-build.ts",
      "tools/agent/remote-protocol.ts",
      "tools/remote/cloudflare.config.ts",
      "tools/remote/worker.ts",
      "tools/remote/runtime.mjs",
    ]) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(new URL(`../../${path}`, import.meta.url), target);
    }
    const cli = await realpath(
      new URL("../../apps/website/node_modules/cf/dist/config.mjs", import.meta.url),
    );
    const manifest = findPackageJSON("@cloudflare/build-output-utils", pathToFileURL(cli));
    assert.ok(manifest);
    const consumer = pathToFileURL(join(dirname(manifest), "dist/index.mjs")).href;
    const record = fixture().read();
    await exec(
      process.execPath,
      [
        "--experimental-vm-modules",
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      import { readdir, stat } from 'node:fs/promises';
      import { SourceTextModule } from 'node:vm';
      import { pathToFileURL } from 'node:url';
      import { join, posix } from 'node:path';
      // Module URLs are selected at runtime to isolate source from installed dependencies.
      const { writeRemoteBuild } = await import(${JSON.stringify(pathToFileURL(join(directory, "tools/agent/remote-build.ts")).href)});
      const record = ${JSON.stringify(record)};
      const image = 'registry.cloudflare.com/ci@sha256:' + 'a'.repeat(64);
      await writeRemoteBuild(process.cwd(), process.cwd(), record, image);
      const { readBuildOutput } = await import(${JSON.stringify(consumer)});
      const output = await readBuildOutput(process.cwd());
      const files = await readdir(${JSON.stringify(dirname(cli))});
      const importer = async (prefix) => {
        const name = files.find(name => name.startsWith(prefix) && name.endsWith('.mjs'));
        assert.ok(name);
        return import(pathToFileURL(join(${JSON.stringify(dirname(cli))}, name)).href);
      };
      const { i: prepareWorker } = await importer('build-');
      const { t: loadBundle } = await importer('deploy-input-');
      const worker = output.workers.default;
      const prepared = prepareWorker(worker, output.rootConfig);
      const bundle = loadBundle(worker, prepared.builtConfig);
      assert.equal(output.rootConfig.accountId, record.account);
      assert.equal(prepared.wranglerConfig.vars.ACCOUNT_ID, record.account);
      assert.equal(output.rootConfig.buildContext.isPreview, false);
      assert.equal(output.containers.length, 1);
      assert.equal(output.containers[0].config.images.default.reference, image);
      assert.equal(prepared.wranglerConfig.exports.RemoteWorkspace.container, record.id);
      assert.equal(prepared.wranglerConfig.name, record.id);
      const localBinding = prepared.wranglerConfig.unsafe.bindings.find(binding => binding.name === 'WORKSPACE');
      assert.deepEqual(localBinding, {
        name: 'WORKSPACE', type: 'durable_object_namespace', class_name: 'RemoteWorkspace',
      });
      assert.equal(Object.hasOwn(localBinding, 'script_name'), false);
      assert.ok(!prepared.wranglerConfig.durable_objects.bindings.some(binding => binding.name === 'WORKSPACE'));
      assert.equal(prepared.wranglerConfig.exports.RemoteWorkspace.storage, 'sqlite');
      assert.equal(bundle.bundleType, 'esm');
      const sources = new Map([['worker.ts', bundle.content], ...bundle.modules.map(m => [m.name.replace(/^\\.\\//, ''), m.content])]);
      assert.equal(sources.size, 3);
      for (const [name, source] of sources) {
        const module = new SourceTextModule(source);
        for (const specifier of module.dependencySpecifiers) {
          if (specifier.startsWith('node:') || specifier === 'cloudflare:workers') continue;
          assert.ok(sources.has(posix.normalize(posix.join(posix.dirname(name), specifier))), name + ': ' + specifier);
        }
        const mode = (await stat(join(worker.bundleDir, name))).mode;
        assert.equal(mode & 0o077, 0);
      }
    `,
      ],
      { cwd: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await it("retries only its own pending deployment without reallocating or extending expiry", async () => {
  const record = fixture().read();
  delete record.origin;
  record.status = "provisioning";
  record.installed = false;
  record.resources = [];
  const before = structuredClone(record);
  await assert.rejects(
    ensureRemoteDeployment(
      record,
      async () => {
        throw new Error("deploy interrupted");
      },
      2000,
    ),
  );
  assert.deepEqual(record, before);
  let deployments = 0;
  const deploy = async (owned: RemoteEnvironment) => {
    assert.equal(owned, record);
    deployments++;
    owned.origin = `https://${owned.id}.example.workers.dev`;
  };
  await ensureRemoteDeployment(record, deploy, 2000);
  await ensureRemoteDeployment(record, deploy, 2000);
  assert.equal(deployments, 1);
  assert.equal(record.expires, before.expires);
  assert.equal(record.token, before.token);
  assert.equal(record.id, before.id);
  await assert.rejects(
    ensureRemoteDeployment({ ...before, expires: 2000 }, deploy, 2000),
    /expired/,
  );
  await assert.rejects(
    ensureRemoteDeployment({ ...before, status: "ready" }, deploy, 2000),
    /unknown state/,
  );
});

function fixture() {
  let disk: RemoteEnvironment = {
    version: 1,
    id: `gmr-${"a".repeat(24)}`,
    root: "/work/tree",
    account: "b".repeat(32),
    token: "c".repeat(64),
    previewToken: "d".repeat(64),
    created: 1000,
    expires: 86_401_000,
    status: "ready",
    installed: true,
    origin: `https://gmr-${"a".repeat(24)}.example.workers.dev`,
    resources: [
      { id: "gma-abc-0123456789ab", account: "b".repeat(32), resources: { vectors: "created" } },
    ],
  };
  let workerExists = true;
  let applicationExists = true;
  let interrupt:
    | "ownership"
    | "stop"
    | "resources"
    | "phase"
    | "delete"
    | "deleted-journal"
    | "application"
    | "application-response"
    | "complete-journal"
    | undefined;
  const events: string[] = [];
  return {
    events,
    read: () => structuredClone(disk),
    interruptAt(value: typeof interrupt) {
      interrupt = value;
    },
    async run() {
      const record = structuredClone(disk);
      await teardownRemote(record, {
        async persist(value) {
          validateRemoteEnvironment(value);
          if (interrupt === "phase" && value.teardownPhase)
            throw new Error("phase write interrupted");
          if (interrupt === "deleted-journal" && value.workerDeleted)
            throw new Error("journal interrupted");
          if (interrupt === "complete-journal" && value.status === "deleted")
            throw new Error("completion journal interrupted");
          disk = structuredClone(value);
        },
        async collectOwnership() {
          events.push("ownership");
          if (!workerExists || interrupt === "ownership") throw new Error("ownership unavailable");
        },
        async stop() {
          events.push("stop");
          if (interrupt === "stop") throw new Error("stop unavailable");
        },
        async removeResources() {
          events.push("resources");
          if (interrupt === "resources") throw new Error("resource cleanup unavailable");
          record.resources[0]!.resources.vectors = "deleted";
        },
        async deleteWorker() {
          events.push(workerExists ? "delete" : "already-absent");
          workerExists = false;
          if (interrupt === "delete") throw new Error("delete response interrupted");
        },
        async deleteApplication() {
          events.push(applicationExists ? "delete-application" : "application-absent");
          if (interrupt === "application") throw new Error("application deletion interrupted");
          applicationExists = false;
          if (interrupt === "application-response")
            throw new Error("application response interrupted");
        },
      });
    },
  };
}

await describe("durable remote teardown", async () => {
  for (const interruption of [
    "delete",
    "deleted-journal",
    "application",
    "application-response",
    "complete-journal",
  ] as const) {
    await it(`resumes after ${interruption} without the deleted runtime`, async () => {
      const state = fixture();
      state.interruptAt(interruption);
      await assert.rejects(state.run(), /interrupted/);
      assert.equal(state.read().teardownPhase, "worker-delete");
      assert.equal(state.read().status, "deleting");
      const before = state.events.length;
      state.interruptAt(undefined);
      await state.run();
      assert.deepEqual(
        state.events.slice(before),
        interruption === "delete" || interruption === "deleted-journal"
          ? ["already-absent", "delete-application"]
          : interruption === "application"
            ? ["delete-application"]
            : ["application-absent"],
      );
      assert.equal(state.read().status, "deleted");
    });
  }
  for (const interruption of ["ownership", "stop", "resources", "phase"] as const) {
    await it(`preserves quota and the Worker after ${interruption} failure`, async () => {
      const state = fixture();
      state.interruptAt(interruption);
      await assert.rejects(state.run());
      assert.equal(state.read().status, "deleting");
      assert.equal(state.read().teardownPhase, undefined);
      assert.ok(!state.events.includes("delete"));
      state.interruptAt(undefined);
      await state.run();
      assert.equal(state.read().status, "deleted");
    });
  }
  await it("rejects an unknown or prematurely advanced deletion journal", () => {
    const record = fixture().read();
    assert.throws(() =>
      validateRemoteEnvironment({ ...record, status: "deleting", teardownPhase: "worker-delete" }),
    );
    assert.throws(() =>
      validateRemoteEnvironment(
        JSON.parse(JSON.stringify({ ...record, teardownPhase: "unknown" })),
      ),
    );
  });
  await it("accepts only cf's explicit API 404, not transport/auth/unrelated not-found errors", () => {
    assert.equal(cfApiNotFound("APIError\nWorker does not exist\n404 Not Found"), true);
    for (const diagnostic of [
      "DNS not found",
      "connection reset",
      "404",
      "APIError 403 Forbidden",
      "APIError 500 Internal Server Error",
      "config file not found",
    ]) {
      assert.equal(cfApiNotFound(diagnostic), false);
    }
  });
});

await describe("owned Container application cleanup", async () => {
  await it("cleans an interrupted no-origin deployment and recovers a lost delete response", async () => {
    const record = fixture().read();
    delete record.origin;
    record.status = "provisioning";
    record.installed = false;
    record.resources = [];
    const application = {
      id: "e".repeat(32),
      name: record.id,
      account_id: record.account,
      scheduling_policy: "durable_object",
    };
    let exists = true;
    let saved: RemoteEnvironment | undefined;
    const commands: string[][] = [];
    const run: Parameters<typeof deleteRemoteApplication>[1] = async (args, options) => {
      commands.push(args);
      assert.equal(options?.env?.CLOUDFLARE_ACCOUNT_ID, record.account);
      assert.equal(options?.profile, record.profile);
      if (args[2] === "list") {
        assert.deepEqual(args, ["containers", "applications", "list", "--name", record.id]);
        return JSON.stringify(exists ? [application] : []);
      }
      assert.deepEqual(args, ["containers", "applications", "delete", application.id, "--force"]);
      assert.equal(saved?.containerApplicationId, application.id);
      exists = false;
      throw new Error("delete response interrupted");
    };
    const persist = async (value: RemoteEnvironment) => {
      saved = structuredClone(value);
    };
    await assert.rejects(deleteRemoteApplication(record, run, persist), /interrupted/);
    assert.ok(saved);
    await deleteRemoteApplication(saved, run, persist);
    assert.equal(commands.filter((args) => args[2] === "delete").length, 1);
    assert.equal(commands.at(-1)?.[2], "list");
  });
  await it("refuses ambiguous, foreign-account, renamed, replaced or malformed applications", () => {
    const record = fixture().read();
    const application = {
      id: "e".repeat(32),
      name: record.id,
      account_id: record.account,
      scheduling_policy: "durable_object",
    };
    assert.equal(ownedContainerApplication(record, [application]), application.id);
    assert.equal(ownedContainerApplication(record, []), undefined);
    for (const value of [
      {},
      [application, application],
      [{ ...application, name: "gitmatrix" }],
      [{ ...application, account_id: "f".repeat(32) }],
      [{ ...application, id: "../other" }],
      [{ ...application, scheduling_policy: "default" }],
    ]) {
      assert.throws(() => ownedContainerApplication(record, value), /ownership/);
    }
    assert.throws(
      () =>
        ownedContainerApplication({ ...record, containerApplicationId: "f".repeat(32) }, [
          application,
        ]),
      /ownership/,
    );
  });
  await it("does not complete cleanup while an acknowledged deletion still appears in the account", async () => {
    const record = fixture().read();
    const application = {
      id: "e".repeat(32),
      name: record.id,
      account_id: record.account,
      scheduling_policy: "durable_object",
    };
    const run: Parameters<typeof deleteRemoteApplication>[1] = async (args) =>
      args[2] === "list" ? JSON.stringify([application]) : "{}";
    await assert.rejects(
      deleteRemoteApplication(record, run, async () => {}),
      /not yet confirmed/,
    );
    assert.equal(record.containerApplicationId, application.id);
  });
});

await describe("fresh deployment readiness", async () => {
  await it("recovers only edge route propagation before accepting authenticated ownership", async (t) => {
    const record = fixture().read();
    const before = structuredClone(record);
    let requests = 0;
    let now = record.created;
    const pauses: number[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(url, `${record.origin}/__remote/status`);
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${record.token}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      requests++;
      return requests === 1
        ? new Response("edge route not ready", {
            status: 404,
            headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "fixture-EWR" },
          })
        : Response.json({ running: false, expiresAt: record.expires });
    });
    await waitForRemoteDeployment(
      record,
      remoteRequest(record, {
        now: () => now,
        pause: async (milliseconds) => {
          pauses.push(milliseconds);
          now += milliseconds;
        },
      }),
    );
    assert.equal(requests, 2);
    assert.deepEqual(pauses, [250]);
    assert.deepEqual(record, before);
  });
  await it("waits for route and Worker attachment propagation before accepting authenticated ownership", async (t) => {
    const record = fixture().read();
    const before = structuredClone(record);
    let requests = 0;
    const pauses: number[] = [];
    const transientStatuses = [404, 500, 502, 503, 504];
    let deadline: AbortSignal | null | undefined;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(url, `${record.origin}/__remote/status`);
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${record.token}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      if (!deadline) deadline = init.signal;
      assert.equal(init.signal, deadline);
      requests++;
      const status = transientStatuses[requests - 1];
      return status !== undefined
        ? Response.json({ error: "attachment not ready" }, { status })
        : Response.json({ running: false, expiresAt: record.expires });
    });
    await waitForRemoteDeployment(record, remoteRequest(record), async (milliseconds, signal) => {
      assert.equal(signal, deadline);
      pauses.push(milliseconds);
    });
    assert.equal(requests, transientStatuses.length + 1);
    assert.deepEqual(
      pauses,
      transientStatuses.map(() => 2000),
    );
    assert.deepEqual(record, before);
  });
  await it("bounds unsuccessful readiness polling and retains origin for a later setup attempt", async (t) => {
    const record = fixture().read();
    const before = structuredClone(record);
    let requests = 0;
    let pauses = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response(null, { status: requests % 2 ? 404 : 500 });
    });
    await assert.rejects(
      waitForRemoteDeployment(record, remoteRequest(record), async () => {
        pauses++;
      }),
      /origin retained/,
    );
    assert.equal(requests, 30);
    assert.equal(pauses, 29);
    assert.deepEqual(record, before);
  });
  await it("shares a cancellable deadline across edge recovery and attachment polling", async (t) => {
    const record = fixture().read();
    const deadline = new AbortController();
    const reason = new DOMException("readiness deadline", "TimeoutError");
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.ok(milliseconds <= 30_000);
      return deadline.signal;
    });
    let requests = 0;
    let edgePauses = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      assert.equal(init.signal?.aborted, false);
      requests++;
      return requests === 1
        ? new Response(null, {
            status: 404,
            headers: { "content-type": "text/html", "cf-ray": "fixture-EWR" },
          })
        : Response.json({ error: "attachment not ready" }, { status: 500 });
    });
    const request = remoteRequest(record, {
      now: () => record.created,
      pause: async () => {
        edgePauses++;
      },
    });
    await assert.rejects(
      waitForRemoteDeployment(record, request, async (_milliseconds, signal) => {
        deadline.abort(reason);
        assert.equal(signal?.aborted, true);
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(edgePauses, 1);
    assert.equal(requests, 2);
  });
  for (const failure of ["auth", "other-client", "transport", "expiry", "malformed"] as const) {
    await it(`fails closed without retry for ${failure}`, async (t) => {
      const record = fixture().read();
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () => {
        requests++;
        if (failure === "transport") throw new Error("connection reset");
        if (failure === "auth") return new Response(null, { status: 403 });
        if (failure === "other-client") return new Response(null, { status: 409 });
        return Response.json(
          failure === "expiry"
            ? { running: false, expiresAt: record.expires + 1 }
            : { expiresAt: record.expires },
        );
      });
      await assert.rejects(waitForRemoteDeployment(record, remoteRequest(record)));
      assert.equal(requests, 1);
    });
  }
});

await describe("cf-managed OAuth renewal", async () => {
  for (const mode of ["near-expiry", "expiry-race", "unrenewed"] as const) {
    await it(`honors cf refresh semantics for ${mode}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "remote-oauth-fixture-"));
      try {
        const path = join(directory, "current.json");
        const record = fixture().read();
        record.profile = "development";
        let calls = 0;
        const expires = Date.now() + 15_000;
        const currentToken = "current-access-only";
        const renewedToken = "renewed-access-only";
        const run: NonNullable<Parameters<typeof authenticate>[1]> = async (args, options) => {
          calls++;
          assert.deepEqual(args, ["auth", "whoami"]);
          assert.equal(options?.profile, record.profile);
          // Model cf's persisted file, not an application-owned OAuth refresh exchange.
          await writeFile(
            path,
            JSON.stringify({
              oauth_token: calls === 1 ? currentToken : renewedToken,
              expiration_time: new Date(
                mode === "near-expiry" || (mode === "expiry-race" && calls === 2)
                  ? expires
                  : Date.now() - 1000,
              ).toISOString(),
              refresh_token: "must-never-leave-this-file",
            }),
            { mode: 0o600 },
          );
          return JSON.stringify({
            authenticated: true,
            tokenValid: true,
            authSource: `OAuth token from ${path}`,
            accounts: [{ id: record.account }],
          });
        };
        if (mode === "unrenewed") {
          await assert.rejects(authenticate(record, run), /did not renew/);
          assert.equal(calls, 2);
        } else {
          const credentials = await authenticate(record, run);
          assert.deepEqual(credentials, {
            token: mode === "near-expiry" ? currentToken : renewedToken,
            account: record.account,
            expires,
          });
          assert.equal(calls, mode === "near-expiry" ? 1 : 2);
          assert.equal(nextCredentialRefresh(credentials, expires - 5000), expires);
          assert.ok(!JSON.stringify(credentials).includes("must-never-leave"));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  await it("caps normal polling without anticipating cf's actual expiry boundary", () => {
    assert.equal(nextCredentialRefresh({ token: "access", account: "account" }, 1000), 31_000);
    assert.equal(
      nextCredentialRefresh({ token: "access", account: "account", expires: 100_000 }, 1000),
      31_000,
    );
    assert.equal(
      nextCredentialRefresh({ token: "access", account: "account", expires: 1000 }, 1000),
      1000,
    );
  });
});
