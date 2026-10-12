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
  retireStaleChildren,
  teardownRemote,
  validateRemoteEnvironment,
} from "./remote-environment.ts";
import type { OwnedResources, RemoteEnvironment } from "./remote-environment.ts";
import type { QuotaOwner } from "./quota.ts";
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

await it("retains quota admission across interrupted deployment and rejects a released reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-admission-fixture-"));
  try {
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { ensureRemoteDeployment } from ${JSON.stringify(new URL("./remote-environment.ts", import.meta.url).href)};
      const record = ${JSON.stringify(fixture().read())};
      delete record.origin;
      record.status = "provisioning";
      record.installed = false;
      record.resources = [];
      record.quota = { authority: "https://quota.example", state: "pending" };
      let admissions = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://quota.example/api/environments/reservations");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer quota-fixture");
        admissions++;
        return Response.json({ id: record.id, reserved: true });
      };
      await assert.rejects(ensureRemoteDeployment(record, async () => {
        throw new Error("deploy interrupted");
      }, 2000), /deploy interrupted/);
      assert.equal(record.quota.state, "reserved");
      let deployments = 0;
      const deploy = async (owned) => {
        deployments++;
        owned.origin = "https://" + owned.id + ".example.workers.dev";
      };
      await ensureRemoteDeployment(record, deploy, 2000);
      await ensureRemoteDeployment(record, deploy, 2000);
      assert.equal(deployments, 1);
      assert.equal(admissions, 3);
      assert.equal(record.expires, 86401000);
      await assert.rejects(ensureRemoteDeployment({ ...record, expires: 2000 }, deploy, 2000), /expired/);
      record.quota.state = "released";
      await assert.rejects(ensureRemoteDeployment(record, deploy, 2000), /released/);
      assert.equal(deployments, 1);
    `,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          GITMATRIX_REMOTE_HOSTED: "1",
          GITMATRIX_REMOTE_CREDENTIALS_FILE: "",
          GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: "https://quota.example",
          GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: "quota-fixture",
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await it("requires legacy drainage, enforces global admission, and releases only after physical deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-quota-fixture-"));
  try {
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { mkdir } from "node:fs/promises";
      import { join } from "node:path";
      import { allocateRemote, ensureRemoteAdmission, persistRemote, teardownRemote, inventory, remoteOutstanding, remoteQuotaAuthority } from ${JSON.stringify(new URL("./remote-environment.ts", import.meta.url).href)};
      const root = process.env.HOME;
      const legacy = ${JSON.stringify(fixture().read())};
      legacy.root = join(root, "legacy");
      legacy.created = Date.now();
      legacy.expires = legacy.created + 60000;
      legacy.resources = [];
      await mkdir(legacy.root);
      await persistRemote(legacy);
      const slots = new Set();
      let maximum = 1;
      let physicalDeleted = false;
      let ambiguous = true;
      globalThis.fetch = async (url, init) => {
        if (init.method === "POST") {
          const { id, backend } = JSON.parse(init.body);
          assert.equal(backend, "remote");
          if (!slots.has(id) && slots.size >= maximum) return new Response(null, { status: 409 });
          slots.add(id);
          return Response.json({ id, reserved: true });
        }
        assert.equal(physicalDeleted, true, "quota cannot release before application deletion");
        const id = url.split("/").at(-1);
        slots.delete(id);
        if (ambiguous) { ambiguous = false; throw new Error("release response lost"); }
        return Response.json({ id, released: true });
      };
      await assert.rejects(allocateRemote(root, legacy.account), /Legacy remote resources/);
      await assert.rejects(ensureRemoteAdmission(legacy), /Legacy remote resources/);
      assert.equal(slots.size, 0, "migration never rewrites another root or re-admits its children");
      assert.equal((await inventory())[0].quota, undefined);
      await teardownRemote(legacy, {
        persist: persistRemote, collectOwnership: async () => {}, stop: async () => {},
        removeResources: async () => {}, deleteWorker: async () => {},
        deleteApplication: async () => {},
      });
      maximum = 0;
      await assert.rejects(allocateRemote(root, legacy.account), /refused POST/);
      const denied = (await inventory()).find((item) => item.root === root);
      assert.equal(denied.quota.state, "pending");
      assert.equal(slots.size, 0);
      maximum = 8;
      await ensureRemoteAdmission(denied);
      const staleChild = "gma-child-1123456789ab";
      denied.resources.push({ id: staleChild, account: denied.account, expires: denied.expires,
        quota: { authority: "https://quota.example", state: "reserved" }, resources: {} });
      await persistRemote(denied);
      await ensureRemoteAdmission(denied);
      assert.equal(slots.has(staleChild), false, "a cached child reservation must not be recreated");
      denied.resources[0].quota.state = "released";
      await persistRemote(denied);
      for (let i = 0; i < 5; i++) {
        const path = join(root, "extra-" + i); await mkdir(path);
        await allocateRemote(path, legacy.account);
      }
      assert.equal(slots.size, 6, "there is no unrelated fixed four remote ceiling");
      const childId = "gma-child-0123456789ab";
      slots.add(childId);
      denied.resources.push({ id: childId, account: denied.account, expires: denied.expires,
        quota: { authority: "https://quota.example", state: "reserved" }, resources: {} });
      const actions = {
        persist: persistRemote,
        collectOwnership: async () => {},
        stop: async () => {},
        removeResources: async () => {},
        deleteWorker: async () => {},
        deleteApplication: async () => { physicalDeleted = true; },
      };
      await assert.rejects(teardownRemote(denied, actions), /refused DELETE/);
      assert.equal(denied.status, "deleting");
      assert.equal(remoteOutstanding(denied), true);
      await teardownRemote(denied, actions);
      assert.equal(denied.status, "deleted");
      assert.equal(denied.quota.state, "released");
      assert.equal(denied.resources[1].quota.state, "released");
      assert.equal(slots.has(childId), false);
      assert.equal(remoteOutstanding(denied), false);
      await assert.rejects(remoteQuotaAuthority({ ...legacy, quota: { authority: "https://127.0.0.1", state: "reserved" } }), /loopback/);
    `,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          GITMATRIX_REMOTE_HOSTED: "1",
          GITMATRIX_REMOTE_CREDENTIALS_FILE: "",
          GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: "https://quota.example",
          GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: "quota-fixture",
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

await describe("stale hosted child retirement (CORE-374)", async () => {
  const authority = "https://quota.example";
  const child = (n: number, quota: "reserved" | "released", artifacts: "created" | "deleted") => ({
    id: `gma-mga0000${n}-${String(n).repeat(12)}`,
    account: "b".repeat(32),
    expires: 86_401_000,
    quota: { authority, state: quota },
    resources: { artifacts, vectors: "deleted" },
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
      quota: { authority, state: "reserved" },
      resources: [
        child(1, "reserved", "created"),
        child(2, "reserved", "created"),
        child(3, "released", "deleted"),
        child(4, "reserved", "created"),
      ] as OwnedResources[],
    };
    const events: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const refuse = new Set<string>();
    const failRelease = new Set<string>();
    return {
      events,
      logs,
      refuse,
      failRelease,
      read: () => structuredClone(disk),
      async run(live: string[]) {
        const record = structuredClone(disk);
        return retireStaleChildren(record, new Set(live), {
          async persist(value) {
            validateRemoteEnvironment(value);
            disk = structuredClone(value);
          },
          async removeChild(owned) {
            events.push(`remove ${owned.id}`);
            if (refuse.has(owned.id)) throw new Error("namespace is not empty");
            owned.resources.artifacts = "deleted";
            disk = structuredClone(record);
          },
          log: (event) => logs.push(event),
          async release<T extends QuotaOwner>(owner: T, persist: (value: T) => Promise<void>) {
            events.push(`release ${owner.id}`);
            if (failRelease.has(owner.id)) throw new Error("release interrupted");
            owner.quota!.state = "released";
            await persist(owner);
          },
        });
      },
    };
  }
  const id = (n: number) => child(n, "reserved", "created").id;
  const states = (record: RemoteEnvironment) =>
    Object.fromEntries(
      record.resources.map((owned) => [owned.id, [owned.resources.artifacts, owned.quota?.state]]),
    );

  await it("deletes before releasing, and only children absent from the disk", async () => {
    const state = fixture();
    const result = await state.run([id(2)]);
    assert.deepEqual(result, { retired: [id(1), id(4)], failed: [] });
    assert.deepEqual(state.events, [
      `remove ${id(1)}`,
      `release ${id(1)}`,
      `remove ${id(4)}`,
      `release ${id(4)}`,
    ]);
    assert.deepEqual(states(state.read()), {
      [id(1)]: ["deleted", "released"],
      [id(2)]: ["created", "reserved"],
      [id(3)]: ["deleted", "released"],
      [id(4)]: ["deleted", "released"],
    });
    assert.deepEqual(
      state.logs.map((event) => [event.event, event.id]),
      [
        ["remote.child_stale", id(1)],
        ["remote.child_released", id(1)],
        ["remote.child_stale", id(4)],
        ["remote.child_released", id(4)],
      ],
    );
  });

  await it("keeps a refused child's resources and slot, and still retires the others", async () => {
    const state = fixture();
    state.refuse.add(id(1));
    const result = await state.run([id(2)]);
    assert.deepEqual(result, { retired: [id(4)], failed: [id(1)] });
    assert.ok(!state.events.includes(`release ${id(1)}`));
    assert.deepEqual(states(state.read())[id(1)], ["created", "reserved"]);
    assert.deepEqual(states(state.read())[id(4)], ["deleted", "released"]);
    const failure = state.logs.find((event) => event.event === "remote.child_retire_failed");
    assert.equal(failure?.id, id(1));
    assert.match(String(failure?.message), /namespace is not empty/);
  });

  await it("leaves a child its container already orphaned, unless it still holds a slot", async () => {
    const orphan = (n: number, quota: "reserved" | "released") => ({
      ...child(n, quota, "deleted"),
      resources: { artifacts: "orphaned" as const, vectors: "deleted" as const },
    });
    const record: RemoteEnvironment = {
      ...fixture().read(),
      // CORE-302 inside the container: slot released, only a refused namespace left.
      resources: [orphan(5, "released"), orphan(6, "reserved")],
    };
    const removed: string[] = [];
    const result = await retireStaleChildren(record, new Set(), {
      persist: async () => {},
      async removeChild(owned) {
        removed.push(owned.id);
        throw new Error("namespace is not empty");
      },
      log: () => {},
      release: async () => assert.fail("released a child whose namespace remains"),
    });
    // The orphan holds no slot: its namespace is orphan handling's, not setup's.
    assert.deepEqual(removed, [orphan(6, "reserved").id]);
    assert.deepEqual(result, { retired: [], failed: [orphan(6, "reserved").id] });
  });

  await it("never releases a child whose cleanup left a resource behind", async () => {
    const state = fixture();
    const result = await retireStaleChildren(state.read(), new Set([id(2), id(4)]), {
      persist: async () => {},
      removeChild: async () => {},
      log: () => {},
      release: async () => assert.fail("released with resources left"),
    });
    assert.deepEqual(result, { retired: [], failed: [id(1)] });
  });

  await it("resumes an interrupted release, and a retired child is never touched again", async () => {
    const state = fixture();
    state.failRelease.add(id(1));
    assert.deepEqual(await state.run([id(2), id(4)]), { retired: [], failed: [id(1)] });
    assert.deepEqual(states(state.read())[id(1)], ["deleted", "reserved"]);
    state.failRelease.clear();
    state.events.length = 0;
    assert.deepEqual(await state.run([id(2), id(4)]), { retired: [id(1)], failed: [] });
    assert.deepEqual(state.events, [`remove ${id(1)}`, `release ${id(1)}`]);
    assert.deepEqual(states(state.read())[id(1)], ["deleted", "released"]);
    state.events.length = 0;
    assert.deepEqual(await state.run([id(2), id(4)]), { retired: [], failed: [] });
    assert.deepEqual(state.events, []);
  });
});
