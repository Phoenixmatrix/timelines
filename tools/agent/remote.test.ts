import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  selectExecution,
  validateOwnedResources,
  validateRemoteEnvironment,
} from "./remote-environment.ts";
import type { RemoteEnvironment } from "./remote-environment.ts";
import { commandExit, credentialFile, remoteRequest } from "./remote.ts";
import { unitTestEnvironment } from "./environment.ts";

function environment(): RemoteEnvironment {
  return {
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
    resources: [],
    origin: `https://gmr-${"a".repeat(24)}.example.workers.dev`,
  };
}
await describe("execution mode boundary", async () => {
  await it("keeps local as the default and applies CLI, environment, then project precedence", () => {
    assert.equal(selectExecution(undefined, undefined, undefined), "local");
    assert.equal(selectExecution(undefined, undefined, "cloudflare"), "cloudflare");
    assert.equal(selectExecution(undefined, "local", "cloudflare"), "local");
    assert.equal(selectExecution("cloudflare", "local", "local"), "cloudflare");
  });
  await it("pins existing ownership, rejecting implicit or explicit cross-mode reuse", () => {
    assert.equal(selectExecution(undefined, undefined, undefined, "cloudflare"), "cloudflare");
    assert.throws(() => selectExecution("local", undefined, undefined, "cloudflare"), /destroy/);
    assert.throws(() => selectExecution(undefined, "cloudflare", undefined, "local"), /destroy/);
    assert.throws(() => selectExecution(undefined, undefined, "local", "cloudflare"), /destroy/);
    assert.throws(() => selectExecution("automatic", undefined, undefined), /local or cloudflare/);
  });
  await it("rejects malformed environment and project options even when CLI takes precedence", () => {
    assert.throws(() => selectExecution("local", "automatic", undefined), /local or cloudflare/);
    for (const value of ["automatic", "", null, false, 0, {}, []]) {
      assert.throws(() => selectExecution(undefined, undefined, value), /local or cloudflare/);
      assert.throws(() => selectExecution("local", undefined, value), /local or cloudflare/);
    }
  });
});
await describe("ownership and credential boundaries", async () => {
  await it("accepts only its own isolated origin and bounded lifetime", () => {
    assert.doesNotThrow(() => validateRemoteEnvironment(environment()));
    assert.throws(() =>
      validateRemoteEnvironment({ ...environment(), origin: "https://gitmatrix.com" }),
    );
    assert.throws(() =>
      validateRemoteEnvironment({
        ...environment(),
        origin: "https://gmr-other.example.workers.dev",
      }),
    );
    assert.throws(() => validateRemoteEnvironment({ ...environment(), expires: 86_401_001 }));
    assert.throws(() => validateRemoteEnvironment({ ...environment(), root: "../other" }));
    assert.throws(() => validateRemoteEnvironment({ ...environment(), token: "short" }));
  });
  await it("never accepts production names, unknown resources, or another account for cleanup", () => {
    const owned = {
      id: "gma-abc-0123456789ab",
      account: "b".repeat(32),
      resources: { artifacts: "created" as const },
    };
    assert.doesNotThrow(() => validateOwnedResources(owned, owned.account));
    assert.throws(() => validateOwnedResources({ ...owned, id: "gitmatrix" }, owned.account));
    assert.throws(() => validateOwnedResources(owned, "e".repeat(32)));
    assert.throws(() =>
      validateOwnedResources({ ...owned, resources: { production: "created" } }, owned.account),
    );
  });
  await it("uses the cf-reported current credential file without guessing credential paths", () => {
    assert.equal(
      credentialFile("OAuth token from /home/me/.config/cloudflare/config/default.json"),
      "/home/me/.config/cloudflare/config/default.json",
    );
    assert.equal(credentialFile("CLOUDFLARE_API_TOKEN environment variable"), undefined);
    assert.throws(() => credentialFile("OAuth token from relative/file.json"));
  });
});
await describe("remote command error boundary", async () => {
  await it("propagates exact exit status and never treats disconnect or missing status as success", () => {
    assert.equal(commandExit({ text: "", nextOffset: 0, done: true, exitCode: 17 }), 17);
    assert.equal(commandExit({ text: "", nextOffset: 0, done: true, exitCode: 0 }), 0);
    assert.throws(() => commandExit({ text: "", nextOffset: 0, done: true }));
    assert.throws(() => commandExit({ text: "", nextOffset: 0, done: false, exitCode: 0 }));
    assert.throws(() => commandExit({ text: "", nextOffset: 0, done: true, exitCode: -1 }));
  });
  await it("never follows control redirects or echoes server error bodies containing credentials", async (t) => {
    const record = environment();
    const path = `/files?path=${encodeURIComponent("apps/site/src/pages/docs/[...slug].astro")}`;
    const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response("secret token in upstream failure", { status: 403 });
      },
    );
    await assert.rejects(
      remoteRequest(record)(path, { method: "PUT", body: "export const prerender = true;" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed \(403\)/);
        assert.doesNotMatch(error.message, /secret token in upstream failure/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.input, `${record.origin}/__remote${path}`);
    assert.equal(calls[0]!.init?.redirect, "error");
    assert.equal(
      new Headers(calls[0]!.init?.headers).get("authorization"),
      `Bearer ${record.token}`,
    );
  });
  await it("rejects escaping control paths without making a request", async (t) => {
    const fetcher = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Unexpected remote request");
    });
    await assert.rejects(
      remoteRequest(environment())("//elsewhere"),
      /Invalid remote control path/,
    );
    await assert.rejects(
      remoteRequest(environment())("/../outside"),
      /Invalid remote control path/,
    );
    assert.equal(fetcher.mock.callCount(), 0);
  });
});

await it("serializes log follower credentials with concurrent source mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-follow-lock-fixture-"));
  const identity = {
    authenticated: true,
    tokenValid: true,
    authSource: "CLOUDFLARE_API_TOKEN environment variable",
    accounts: [{ id: environment().account }],
  };
  try {
    // Exercise the real cf subprocess boundary without accessing a host identity.
    await writeFile(
      join(directory, "cf"),
      `#!/bin/sh\n[ "$1 $2" = "auth whoami" ] || exit 1\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(directory, "gm"),
      '#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] || exit 1\n[ -z "$GM_TOKEN$GITMATRIX_TOKEN" ] || exit 2\n[ "$GM_SERVER" = "https://quota.example" ] || exit 3\ncat >/dev/null\nprintf \'password=quota-fixture\\n\'\n',
      { mode: 0o700 },
    );
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { execFile } from "node:child_process";
        import { createHash } from "node:crypto";
        import { join } from "node:path";
        import { promisify } from "node:util";
        import { remoteMain, remoteRequest } from ${JSON.stringify(new URL("./remote.ts", import.meta.url).href)};
        import { persistRemote, remoteLock, remoteRegistry } from ${JSON.stringify(new URL("./remote-environment.ts", import.meta.url).href)};
        const record = ${JSON.stringify(environment())};
        record.root = process.env.HOME;
        record.created = Date.now();
        record.expires = record.created + 60_000;
        record.quota = { authority: "https://quota.example", state: "reserved" };
        await persistRemote(record);
        const lockPath = join(remoteRegistry, createHash("sha256").update(record.root).digest("hex") + ".lock");
        const request = remoteRequest(record);
        const events = [];
        const sourceErrors = [];
        let busy = false;
        let polls = 0;
        let revision;
        let source;
        globalThis.fetch = async (input, init = {}) => {
          const route = new URL(input).pathname.replace("/__remote", "");
          if (route.endsWith("/logs")) {
            if (++polls > 1) await source;
            return Response.json({ text: "", nextOffset: 0, done: polls > 1, exitCode: 0 });
          }
          if (route === "/ownership") return Response.json({ environments: [] });
          assert.equal(init.method, "POST");
          // Match runtime.mjs: credentials and source mutations share one busy
          // guard; an overlap rejects the consumer rather than silently retrying.
          if (busy) return new Response(null, { status: 409 });
          busy = true;
          try {
            if (route === "/credentials") {
              events.push("credentials:start");
              // A nonblocking kernel probe chooses the barrier, not a sleep:
              // baseline has no lock, so hold publication until the competing
              // consumer encounters 409. Fixed code holds the lock, so release
              // publication before waiting for that consumer to acquire it.
              const unlocked = await promisify(execFile)("flock", ["-n", lockPath, "true"])
                .then(() => true, (error) => {
                  assert.equal(error.code, 1);
                  return false;
                });
              source = remoteLock(record.root, async () => {
                events.push("source:start");
                await request("/sync", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ revision: "next-source" }),
                });
                events.push("source:end");
              }).catch((error) => sourceErrors.push(error.message));
              if (unlocked) await source;
              events.push("credentials:end");
              return Response.json({ ok: true });
            }
            assert.equal(route, "/sync");
            revision = JSON.parse(init.body).revision;
            return Response.json({ revision });
          } finally {
            busy = false;
          }
        };
        await remoteMain(record.root, ["logs", "foreground-check"]);
        await source;
        assert.deepEqual(sourceErrors, [], "source consumer must not fail during credential publication");
        assert.equal(revision, "next-source");
        assert.deepEqual(events, ["credentials:start", "credentials:end", "source:start", "source:end"]);
        assert.equal(process.exitCode, 0);
        `,
      ],
      {
        env: {
          ...unitTestEnvironment(process.env),
          HOME: directory,
          PATH: `${directory}:${process.env.PATH}`,
          CLOUDFLARE_API_TOKEN: "fixture-access-token",
          GM_SERVER: "https://product.example",
          GM_TOKEN: "fixture-product-token",
          GITMATRIX_TOKEN: "fixture-second-product-token",
        },
        timeout: 15_000,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await it("discovers live commands independently of replaced state entries and reconnects by exact id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-process-fixture-"));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import http from "node:http";
        import net from "node:net";
        import { syncBuiltinESMExports } from "node:module";
        import { runtimeSource } from ${JSON.stringify(new URL("../remote/runtime.mjs", import.meta.url).href)};
        const directory = ${JSON.stringify(directory)};
        const state = directory + "/.remote";
        const source = runtimeSource.replaceAll("/workspace", directory);
        fs.mkdirSync(state, { recursive: true });
        fs.writeFileSync(state + "/runtime.mjs", source);
        process.env.RUNTIME_TOKEN = "fixture-runtime-token";
        process.env.EXPIRES_AT = String(Date.now() + 60_000);
        const until = async (path, condition) => {
          const done = Promise.withResolvers();
          const check = () => {
            try { if (condition()) done.resolve(); } catch (error) { done.reject(error); }
          };
          const watcher = fs.watch(path, check);
          watcher.on("error", done.reject);
          check();
          try { await done.promise; } finally { watcher.close(); }
        };
        // Reproduce the platform fault deterministically at the filesystem
        // boundary, leaving actual state reads, runners and HTTP handlers real.
        const readdir = fs.readdirSync;
        let discovery = "omit-state";
        fs.readdirSync = (path, ...args) => {
          if (path === state + "/processes") {
            if (discovery === "unavailable")
              throw Object.assign(new Error("Fixture directory enumeration unavailable"), { code: "EIO" });
            return readdir(path, ...args).filter((name) => !name.endsWith(".json"));
          }
          return readdir(path, ...args);
        };
        const createHttpServer = http.createServer;
        const createNetServer = net.createServer;
        let server;
        let bridge;
        let listening;
        http.createServer = (...args) => {
          server = createHttpServer(...args);
          const listen = server.listen;
          server.listen = () => listen.call(server, 0, "127.0.0.1", listening.resolve);
          return server;
        };
        net.createServer = (...args) => {
          bridge = createNetServer(...args);
          const listen = bridge.listen;
          bridge.listen = (_port, _host, callback) => listen.call(bridge, 0, "127.0.0.1", callback);
          return bridge;
        };
        syncBuiltinESMExports();
        let origin;
        const start = async () => {
          listening = Promise.withResolvers();
          await eval(source);
          await listening.promise;
          origin = "http://127.0.0.1:" + server.address().port;
        };
        const close = async () => {
          server.closeAllConnections();
          await Promise.all([server, bridge].map((listener) => {
            const closed = Promise.withResolvers();
            listener.close(closed.resolve);
            return closed.promise;
          }));
        };
        const request = async (path, value) => {
          const response = await fetch(origin + path, {
            method: value === undefined ? "GET" : "POST",
            headers: { authorization: "Bearer fixture-runtime-token", "content-type": "application/json" },
            ...(value === undefined ? {} : { body: JSON.stringify(value) }),
          });
          return { status: response.status, value: await response.json() };
        };
        const command = (id, code) => request("/commands", {
          id, argv: [process.execPath, "--input-type=module", "--eval", code], timeoutMs: 15_000,
        });
        const marker = (name) => directory + "/" + name;
        const waitFor = (name) => until(directory, () => fs.existsSync(marker(name)));
        const record = (id) => JSON.parse(fs.readFileSync(state + "/processes/" + id + ".json", "utf8"));
        await start();
        try {
          const code = [
            'import fs from "node:fs";',
            'console.log("launched exactly once");',
            'fs.watch(' + JSON.stringify(directory) + ', () => { if (fs.existsSync(' + JSON.stringify(marker("release")) + ')) process.exit(17); });',
            'fs.writeFileSync(' + JSON.stringify(marker("ready")) + ', "");',
          ].join("\\n");
          assert.equal((await command("first", code)).status, 200);
          await waitFor("ready");
          await until(state + "/processes", () => record("first").owned !== undefined);
          assert.equal((await request("/status")).value.processes.find((p) => p.id === "first")?.status, "running");
          assert.deepEqual(await command("first", "process.exit(99)"), { status: 200, value: { id: "first" } });
          const blocked = await command("second", "process.exit(0)");
          assert.equal(blocked.status, 409);
          const snapshot = { revision: "a".repeat(64), baseRevision: null, files: [], deleted: [] };
          const fenced = await request("/sync", snapshot);
          assert.equal(fenced.status, 409);

          discovery = "unavailable";
          assert.equal((await request("/processes/first")).value.status, "running");
          const logs = await request("/processes/first/logs");
          assert.equal(logs.status, 200);
          assert.equal(logs.value.text, "launched exactly once\\n");
          assert.equal(logs.value.done, false);
          for (const suffix of ["", "/logs", "/stop"]) {
            const missing = await request("/processes/unknown" + suffix, suffix === "/stop" ? {} : undefined);
            assert.equal(missing.status, 404);
          }
          // Restart only the controller, retaining the same runner and files.
          await close();
          await start();
          assert.equal((await request("/processes/first")).value.status, "running");
          fs.writeFileSync(marker("release"), "");
          await until(state + "/processes", () => record("first").status !== "running");
          assert.equal((await request("/processes/first")).value.exitCode, 17);
          const terminal = await request("/processes/first/logs?offset=" + logs.value.nextOffset);
          assert.deepEqual(terminal.value, { text: "", nextOffset: logs.value.nextOffset, done: true, exitCode: 17 });
          discovery = "omit-state";
          assert.equal((await request("/status")).value.processes.find((p) => p.id === "first").exitCode, 17);
          assert.equal((await request("/sync", snapshot)).status, 200);
          assert.equal((await command("pending", "process.exit(0)")).status, 409);
          assert.equal((await request("/sync/commit", { revision: snapshot.revision })).status, 200);

          const descendant = [
            'import fs from "node:fs";',
            'process.on("SIGTERM", () => fs.writeFileSync(' + JSON.stringify(marker("stopping")) + ', ""));',
            'fs.watch(' + JSON.stringify(directory) + ', () => { if (fs.existsSync(' + JSON.stringify(marker("release-stop")) + ')) process.exit(0); });',
            'fs.writeFileSync(' + JSON.stringify(marker("descendant")) + ', String(process.pid));',
          ].join("\\n");
          const tree = 'import { spawn } from "node:child_process"; spawn(process.execPath, ["--input-type=module", "--eval", ' + JSON.stringify(descendant) + '], { detached: true, stdio: "inherit" });';
          assert.equal((await command("tree", tree)).status, 200);
          await waitFor("descendant");
          discovery = "unavailable";
          let stopped = false;
          const stopping = request("/processes/tree/stop", {}).then((result) => { stopped = true; return result; });
          await waitFor("stopping");
          assert.equal(stopped, false, "stop must await the owned descendant, not an omitted state entry");
          assert.equal((await request("/processes/tree")).value.status, "running");
          fs.writeFileSync(marker("release-stop"), "");
          assert.deepEqual(await stopping, { status: 200, value: { ok: true } });
          assert.equal((await request("/processes/tree")).value.status, "stopped");
          assert.equal((await request("/processes/tree/logs")).value.exitCode, 143);
          const descendantPid = fs.readFileSync(marker("descendant"), "utf8");
          try {
            const stat = fs.readFileSync("/proc/" + descendantPid + "/stat", "utf8");
            assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0], "Z", "owned descendant must not remain live after stop");
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          assert.deepEqual(await request("/processes/tree/stop", {}), { status: 200, value: { ok: true } });
          discovery = "omit-state";
          assert.equal((await request("/status")).value.processes.some((p) => p.status === "running"), false);
          assert.equal((await command("after", "process.exit(0)")).status, 200);
          await until(state + "/processes", () => record("after").status !== "running");
          const completed = (await request("/processes/after")).value;
          assert.equal(completed.status, "succeeded");
          assert.equal(completed.exitCode, 0);
          const oldQuota = "old-quota-credential-for-log-regression";
          const newQuota = "new-quota-credential-for-log-regression";
          const credentials = (token) => request("/credentials", { env: {
            CLOUDFLARE_API_TOKEN: "cloud-credential-for-log-regression",
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
            GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: "https://quota.example",
            GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: token,
          } });
          assert.equal((await credentials(oldQuota)).status, 200);
          const disclose = [
            'import fs from "node:fs";',
            'const old = process.env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN;',
            'process.stdout.write(old.slice(0, 9));',
            'const watcher = fs.watch(' + JSON.stringify(directory) + ', () => {',
            'if (!fs.existsSync(' + JSON.stringify(marker("rotate")) + ')) return;',
            'watcher.close(); process.stdout.write(old.slice(9) + "\\\\npublic marker\\\\n");',
            'console.error(JSON.parse(fs.readFileSync(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, "utf8")).env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN); });',
            'fs.writeFileSync(' + JSON.stringify(marker("half-secret")) + ', "");',
          ].join("\\n");
          assert.equal((await command("secret-log", disclose)).status, 200);
          await waitFor("half-secret");
          assert.equal((await credentials(newQuota)).status, 200);
          fs.writeFileSync(marker("rotate"), "");
          await until(state + "/processes", () => record("secret-log").status !== "running");
          const persisted = fs.readFileSync(state + "/processes/secret-log.log", "utf8");
          assert.equal(persisted.includes(oldQuota), false);
          assert.equal(persisted.includes(newQuota), false);
          assert.match(persisted, /public marker/);
          assert.equal(persisted.split("[redacted]").length - 1, 2);
          await close();
          await start();
          assert.equal((await request("/processes/secret-log/logs")).value.text, persisted);
        } finally {
          fs.writeFileSync(marker("release"), "");
          fs.writeFileSync(marker("release-stop"), "");
          fs.writeFileSync(marker("rotate"), "");
          discovery = "omit-state";
          for (const id of ["first", "tree", "second", "after", "pending", "secret-log"]) {
            await request("/processes/" + id + "/stop", {});
          }
          await close();
        }
        `,
      ],
      { timeout: 30_000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await describe("edge route request recovery", async () => {
  function edge404(): Response {
    return new Response("upstream body must not escape", {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "fixture-EWR" },
    });
  }
  function clock() {
    let now = 1000;
    const pauses: number[] = [];
    return {
      now: () => now,
      pauses,
      pause: async (milliseconds: number) => {
        pauses.push(milliseconds);
        now += milliseconds;
      },
    };
  }
  await it("recovers after prior success and delivers a command only once", async (t) => {
    const timing = clock();
    const command = JSON.stringify({ id: "same-command", argv: ["true"] });
    let attempts = 0;
    let executed = 0;
    const failures: Response[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/status")) return Response.json({ running: true });
      assert.equal(init.body, command);
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${environment().token}`);
      assert.equal(init.redirect, "error");
      if (++attempts < 3) {
        const failure = edge404();
        failures.push(failure);
        return failure;
      }
      executed++;
      return Response.json({ id: "same-command" });
    });
    const request = remoteRequest(environment(), timing);
    await request("/status");
    const response = await request("/commands", { method: "POST", body: command });
    assert.deepEqual(await response.json(), { id: "same-command" });
    assert.equal(executed, 1);
    assert.equal(attempts, 3);
    assert.deepEqual(timing.pauses, [250, 500]);
    assert.ok(failures.every((failure) => failure.bodyUsed));
  });
  await it("bounds repeated edge failures without exposing response bodies", async (t) => {
    const timing = clock();
    const fetcher = t.mock.method(globalThis, "fetch", async () => edge404());
    await assert.rejects(remoteRequest(environment(), timing)("/status"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed \(404\)/);
      assert.doesNotMatch(error.message, /upstream body/);
      return true;
    });
    assert.equal(fetcher.mock.callCount(), 6);
    assert.deepEqual(timing.pauses, [250, 500, 1000, 2000, 4000]);
  });
  for (const boundary of ["expiry", "deadline"] as const) {
    await it(`stops before another fetch when ${boundary} is reached during backoff`, async (t) => {
      let now = 1000;
      const record = environment();
      if (boundary === "expiry") record.expires = 2000;
      const fetcher = t.mock.method(globalThis, "fetch", async () => edge404());
      await assert.rejects(
        remoteRequest(record, {
          now: () => now,
          pause: async () => {
            now = boundary === "expiry" ? 2000 : 31_000;
          },
        })("/status"),
        /failed \(404\)/,
      );
      assert.equal(fetcher.mock.callCount(), 1);
    });
  }
  await it("honors cancellation before fetch and during recovery without replaying", async (t) => {
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const fetcher = t.mock.method(globalThis, "fetch", async () => edge404());
    let replays = 0;
    await assert.rejects(
      remoteRequest(environment(), {
        now: () => 1000,
        pause: async (_milliseconds, signal) => {
          controller.abort(reason);
          assert.equal(signal?.aborted, true);
        },
      })("/files", { method: "PUT", signal: controller.signal }, () => {
        replays++;
        return {};
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(fetcher.mock.callCount(), 1);
    assert.equal(replays, 0);
    await assert.rejects(
      remoteRequest(environment(), clock())("/status", { signal: controller.signal }),
      (error: unknown) => error === reason,
    );
    assert.equal(fetcher.mock.callCount(), 1);
  });
  for (const failure of [
    "json404",
    "json500",
    "auth401",
    "auth403",
    "redirect",
    "html500",
    "no-ray",
    "transport",
  ] as const) {
    await it(`never retries ${failure}`, async (t) => {
      const timing = clock();
      const fetcher = t.mock.method(globalThis, "fetch", async () => {
        if (failure === "transport") throw new TypeError("fetch failed");
        if (failure === "json404" || failure === "json500")
          return Response.json(
            { error: "runtime" },
            { status: failure === "json404" ? 404 : 500, headers: { "cf-ray": "fixture-EWR" } },
          );
        const status =
          failure === "auth401"
            ? 401
            : failure === "auth403"
              ? 403
              : failure === "redirect"
                ? 302
                : failure === "html500"
                  ? 500
                  : 404;
        return new Response(null, {
          status,
          headers:
            failure === "no-ray"
              ? { "content-type": "text/html" }
              : { "content-type": "text/html", "cf-ray": "fixture-EWR" },
        });
      });
      await assert.rejects(
        remoteRequest(environment(), timing)("/commands", { method: "POST", body: "{}" }),
      );
      assert.equal(fetcher.mock.callCount(), 1);
      assert.deepEqual(timing.pauses, []);
    });
  }
  for (const replayable of [false, true]) {
    await it(`${replayable ? "recreates" : "refuses to reuse"} a consumed streaming body`, async (t) => {
      const bodies: ReadableStream[] = [];
      const received: string[] = [];
      let replays = 0;
      const create = (): RequestInit => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("exact source bytes"));
            controller.close();
          },
        });
        bodies.push(body);
        return { method: "PUT", body };
      };
      t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        received.push(await new Response(init.body).text());
        return received.length === 1 ? edge404() : Response.json({ ok: true });
      });
      const pending = remoteRequest(environment(), clock())(
        "/files",
        create(),
        replayable
          ? () => {
              replays++;
              return create();
            }
          : undefined,
      );
      if (replayable) {
        assert.deepEqual(await (await pending).json(), { ok: true });
        assert.deepEqual(received, ["exact source bytes", "exact source bytes"]);
        assert.notEqual(bodies[0], bodies[1]);
        assert.equal(replays, 1);
      } else {
        await assert.rejects(pending, /failed \(404\)/);
        assert.deepEqual(received, ["exact source bytes"]);
        assert.equal(replays, 0);
      }
    });
  }
});
