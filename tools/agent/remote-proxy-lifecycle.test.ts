import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";
import { test } from "node:test";

// Resolve through the website's actual installed toolchain, including its pnpm
// patch. No global installation, credentials, build, or Cloudflare API is used.
const websiteRequire = createRequire(new URL("../../apps/website/package.json", import.meta.url));
const toolchainRequire = createRequire(websiteRequire.resolve("wrangler/package.json"));
const miniflarePath = toolchainRequire.resolve("miniflare");
const { Miniflare } = toolchainRequire("miniflare");
const { WebSocket, WebSocketServer } = createRequire(miniflarePath)("ws");
const clientSource = await readFile(
  join(dirname(miniflarePath), "workers/shared/remote-proxy-client.worker.js"),
  "utf8",
);
const providerSource = await readFile(
  new URL("fixtures/remote-proxy-provider.js", import.meta.url),
  "utf8",
);
const driverSource = await readFile(
  new URL("fixtures/remote-proxy-driver.js", import.meta.url),
  "utf8",
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  // Workerd is a separate process: real time is only a failure deadline here.
  // Successful waits use transport/control events, never synchronization sleeps.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
interface RelaySocket extends EventEmitter {
  readyState: number;
  send(data: Buffer, options: { binary: boolean }): void;
  close(code: number, reason: Buffer): void;
  terminate(): void;
}
interface LocalRuntime {
  ready: Promise<URL>;
  dispose(): Promise<void>;
  dispatchFetch(url: string, init: RequestInit): Promise<Response>;
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

type Plan = { drop?: string; error?: string; reconcile?: boolean };
type Checkpoint = { phase: string; result: Record<string, unknown>; release: () => void };

async function fixture(plan: Plan = {}) {
  const sockets = new Set<Socket>();
  const pairs = new Map<string, { downstream: RelaySocket; upstream: RelaySocket }>();
  const counts = new Map<string, number>();
  const checkpoints: Checkpoint[] = [];
  const releases = new Set<() => void>();
  const transportErrors: Error[] = [];
  const changed = new EventEmitter();
  const until = (predicate: () => boolean, label: string) =>
    bounded(
      (async () => {
        while (!predicate()) await once(changed, "change");
      })(),
      label,
    );
  let nextSession = 0;
  let dropped = false;
  let closing = false;
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      changed.emit("change");
    });
  });
  const webSockets = new WebSocketServer({ noServer: true });
  let provider: LocalRuntime | undefined;
  let client: LocalRuntime | undefined;
  let providerUrl: URL;
  const close = async () => {
    closing = true;
    for (const release of releases) release();
    for (const { downstream, upstream } of pairs.values()) {
      downstream.terminate();
      upstream.terminate();
    }
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([client?.dispose(), provider?.dispose()]);
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  };
  try {
    server.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (downstream: RelaySocket) => {
        const session = String(++nextSession);
        const url = new URL(providerUrl);
        url.protocol = "ws:";
        url.searchParams.set("session", session);
        const upstream: RelaySocket = new WebSocket(url);
        pairs.set(session, { downstream, upstream });
        const queued: { data: Buffer; binary: boolean }[] = [];
        downstream.on("message", (data: Buffer, binary: boolean) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else queued.push({ data, binary });
        });
        upstream.on("open", () => {
          for (const { data, binary } of queued) upstream.send(data, { binary });
          queued.length = 0;
        });
        upstream.on("message", (data: Buffer, binary: boolean) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        const ended = () => {
          if (
            downstream.readyState === WebSocket.CLOSED &&
            upstream.readyState === WebSocket.CLOSED
          ) {
            pairs.delete(session);
            changed.emit("change");
          }
        };
        const forwardClose = (peer: RelaySocket, code: number, reason: Buffer) => {
          if (peer.readyState === WebSocket.OPEN && code !== 1006)
            peer.close(code === 1005 ? 1000 : code, reason);
          else if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
        };
        downstream.on("close", (code: number, reason: Buffer) => {
          forwardClose(upstream, code, reason);
          ended();
        });
        upstream.on("close", (code: number, reason: Buffer) => {
          forwardClose(downstream, code, reason);
          ended();
        });
        const failed = (error: Error) => {
          if (!closing) transportErrors.push(error);
          downstream.terminate();
          upstream.terminate();
        };
        downstream.on("error", failed);
        upstream.on("error", failed);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const control = async (request: Request) => {
      if (closing) return Response.json({});
      const event = object(await request.json());
      if (new URL(request.url).pathname === "/checkpoint") {
        const gate = deferred<void>();
        const release = () => gate.resolve();
        releases.add(release);
        assert.equal(typeof event.phase, "string");
        checkpoints.push({
          phase: String(event.phase),
          result: event.result === null ? {} : object(event.result),
          release,
        });
        changed.emit("change");
        await gate.promise;
        releases.delete(release);
        return Response.json({});
      }
      assert.equal(typeof event.method, "string");
      assert.equal(typeof event.session, "string");
      const method = String(event.method);
      const count = (counts.get(method) ?? 0) + 1;
      counts.set(method, count);
      if (event.method === plan.drop && !dropped) {
        dropped = true;
        const pair = pairs.get(String(event.session));
        assert(pair, "drop must target a live transport session");
        pair.downstream.terminate();
        pair.upstream.terminate();
      }
      const error =
        event.method === plan.error
          ? "fixture acquisition/operation failed"
          : plan.reconcile && event.method === "create" && count > 1
            ? "repo already exists"
            : undefined;
      return Response.json({ error });
    };
    provider = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      workers: [
        {
          config: {
            name: "provider",
            compatibilityDate: "2026-09-30",
            manifest: {
              mainModule: "provider.js",
              modules: {
                "provider.js": { type: "esm", contents: providerSource },
                // Only the provider exposes the installed library entrypoint.
                "capnweb.js": {
                  type: "esm",
                  contents: `${clientSource}\nexport { newWebSocketRpcSession };\n`,
                },
              },
            },
            env: { CONTROL: { type: "fetcher", handler: control } },
          },
          dev: { unsafeRegisterWorker: false },
        },
      ],
    });
    assert(provider);
    providerUrl = await provider.ready;
    client = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      workers: [
        {
          config: {
            name: "driver",
            compatibilityDate: "2026-09-30",
            manifest: {
              mainModule: "driver.js",
              modules: { "driver.js": { type: "esm", contents: driverSource } },
            },
            env: {
              CONTROL: { type: "fetcher", handler: control },
              ARTIFACTS: {
                type: "worker",
                worker: "actual-client",
                props: {
                  binding: "ARTIFACTS",
                  remoteProxyConnectionString: `http://127.0.0.1:${address.port}/`,
                },
              },
            },
          },
          dev: { unsafeRegisterWorker: false },
        },
        {
          config: {
            name: "actual-client",
            compatibilityDate: "2026-09-30",
            manifest: {
              mainModule: "client.js",
              modules: { "client.js": { type: "esm", contents: clientSource } },
            },
          },
          dev: { unsafeRegisterWorker: false },
        },
      ],
    });
    assert(client);
    await client.ready;
    const checkpoint = async (phase: string) => {
      await until(
        () => checkpoints.some((item) => item.phase === phase),
        `driver reaches ${phase}`,
      );
      return checkpoints.splice(
        checkpoints.findIndex((item) => item.phase === phase),
        1,
      )[0]!;
    };
    const invoke = (method: string) => {
      assert(client);
      const request = client
        .dispatchFetch("http://driver/", {
          method: "POST",
          body: JSON.stringify({ method }),
        })
        .then((response: Response) => response.json());
      // Cleanup may abort an outstanding invocation after a failed assertion.
      request.catch(() => {});
      return request;
    };
    const empty = async () => {
      await until(
        () => pairs.size === 0 && sockets.size === 0,
        `completed operation releases both WebSockets/TCP sockets (sessions=${pairs.size}, sockets=${sockets.size})`,
      );
      assert.deepEqual(transportErrors, [], "relay has no unexpected transport errors");
    };
    return { close, invoke, checkpoint, empty, counts, pairs };
  } catch (error) {
    await close();
    throw error;
  }
}

await test(
  "remote proxy retains repo until explicit disposal and materializes Blob results",
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      for (let iteration = 0; iteration < 8; iteration++) {
        const result = f.invoke("repo");
        const held = await f.checkpoint("held");
        assert.deepEqual(held.result, { id: "fixture-id", name: "fixture" });
        assert.equal(f.pairs.size, 1, "returned repo keeps exactly its own session alive");
        held.release();
        const settled = await f.checkpoint("settled");
        assert.equal(settled.result.error, undefined);
        assert.deepEqual(
          settled.result.second,
          held.result,
          "repo remains usable after get resolves",
        );
        assert.equal(settled.result.blob, "materialized repo content");
        await f.empty();
        settled.release();
        await bounded(result, "repo invocation response");
      }
    } finally {
      await f.close();
    }
  },
);

for (const method of ["list", "create", "import", "delete", "get"]) {
  for (const failure of method === "get" ? [true] : [false, true]) {
    await test(
      `remote proxy ${method} ${failure ? "failure" : "success"} releases its root`,
      { timeout: 30_000 },
      async () => {
        const f = await fixture(failure ? { error: method } : {});
        try {
          for (let iteration = 0; iteration < 4; iteration++) {
            const result = f.invoke(method);
            const settled = await f.checkpoint("settled");
            if (failure)
              assert.match(String(settled.result.error), /fixture acquisition\/operation failed/);
            else assert.equal(settled.result?.error, undefined);
            await f.empty();
            settled.release();
            await bounded(result, `${method} response`);
          }
          assert.equal(f.counts.get(method), 4, "ordinary failures must not retry");
        } finally {
          await f.close();
        }
      },
    );
  }
}

for (const method of ["get", "info", "list"]) {
  await test(
    `remote proxy retries dropped ${method} on a fresh owned session`,
    { timeout: 30_000 },
    async () => {
      const f = await fixture({ drop: method });
      try {
        const result = f.invoke(method === "list" ? "list" : "repo");
        if (method !== "list") {
          const held = await f.checkpoint("held");
          assert.equal(f.pairs.size, 1, "retry leaves only the replacement session alive");
          assert.equal(f.counts.get("get"), 2);
          held.release();
        }
        const settled = await f.checkpoint("settled");
        assert.equal(settled.result?.error, undefined);
        assert.equal(f.counts.get(method), method === "info" ? 3 : 2);
        await f.empty();
        settled.release();
        await bounded(result, "retried response");
      } finally {
        await f.close();
      }
    },
  );
}

for (const method of ["import", "delete", "fork", "createToken", "revokeToken"]) {
  await test(
    `remote proxy does not replay unknown ${method} outcome`,
    { timeout: 30_000 },
    async () => {
      const f = await fixture({ drop: method });
      try {
        const result = f.invoke(method);
        const settled = await f.checkpoint("settled");
        assert.match(String(settled.result.error), /Peer closed WebSocket: 1006/);
        assert.equal(f.counts.get(method), 1, "provider observed exactly one write");
        await f.empty();
        settled.release();
        await bounded(result, "unknown-write response");
      } finally {
        await f.close();
      }
    },
  );
}

await test(
  "remote proxy create drop reconciles already-exists and releases lookup capability",
  { timeout: 30_000 },
  async () => {
    const f = await fixture({ drop: "create", reconcile: true });
    try {
      const result = f.invoke("create");
      const settled = await f.checkpoint("settled");
      assert.equal(settled.result.error, undefined);
      assert.equal(settled.result.id, "fixture-id");
      assert.equal(settled.result.token, "fixture-token");
      assert.equal(f.counts.get("create"), 2);
      assert.equal(f.counts.get("get"), 1);
      assert.equal(f.counts.get("createToken"), 1);
      await f.empty();
      settled.release();
      await bounded(result, "reconciled response");
    } finally {
      await f.close();
    }
  },
);
