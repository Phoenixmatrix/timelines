import { timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { bootstrapSource, runtimeSource } from "./runtime.mjs";
// remote-build.ts packages this one protocol import; keep it the only one.
import { REMOTE_ROOT, mergeOwnershipQuota } from "../agent/remote-protocol.ts";

const COOKIE = "__Host-gmr-preview";
const PREFIX = "/__remote";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status: number) => json({ error: message }, status);
async function equal(left: string, right: string): Promise<boolean> {
  if (!right) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
async function capability(secret: string, purpose: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(purpose)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function smallJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Request exceeds 1 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class RemoteWorkspace extends DurableObject<Env> {
  #starting: Promise<Response> | undefined;
  #stopping: Promise<void> | undefined;
  #generation = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Native inactivity configuration belongs to a DO incarnation, not the disk.
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        if (Date.now() >= this.#expiresAt() || (await ctx.storage.get<boolean>("deleted"))) {
          await Promise.all([this.#stop(), ctx.storage.put("deleted", true)]);
          return;
        }
        await this.#renewLifetime();
      });
    }
  }
  async #renewLifetime(): Promise<void> {
    const remaining = this.#expiresAt() - Date.now();
    if (remaining <= 0) {
      await Promise.all([this.#stop(), this.ctx.storage.put("deleted", true)]);
      return;
    }
    // Six hours is the native maximum. Renew before it elapses, never beyond
    // the immutable session deadline; the final alarm destroys the container.
    await this.#container().setInactivityTimeout(Math.min(remaining, 6 * 60 * 60 * 1000));
    await this.ctx.storage.setAlarm(Math.min(this.#expiresAt(), Date.now() + 5 * 60 * 60 * 1000));
  }
  #expiresAt(): number {
    return Number(this.env.EXPIRES_AT);
  }
  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("Remote container binding is missing");
    return container;
  }
  async #runtime(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = path;
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    // Native port fetchers already secure their transport and reject TLS URLs.
    url.protocol = "http:";
    headers.set("authorization", "Bearer " + (await capability(this.env.CONTROL_TOKEN, "runtime")));
    headers.delete("cookie");
    return this.#container()
      .getTcpPort(8787)
      .fetch(
        new Request(url, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
  }
  async #start(origin: string): Promise<Response> {
    const generation = this.#generation;
    const expiresAt = this.#expiresAt();
    const deadline = Math.min(Date.now() + 180000, expiresAt);
    let phase = "provisioning";
    let lastError = "Container is not ready";
    const secrets = [this.env.CONTROL_TOKEN, this.env.PREVIEW_TOKEN];
    const diagnostic = (cause: unknown): string => {
      let message = String(cause);
      for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
      return message.slice(0, 6144);
    };
    const interrupted = (): Response | undefined => {
      if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)
        return error("Workspace expired", 410);
      if (generation !== this.#generation || this.#stopping)
        return error("Workspace startup was stopped", 409);
      if (Date.now() >= deadline)
        return error(`Remote startup timed out during ${phase}: ${lastError}`, 503);
      return undefined;
    };
    if (await this.ctx.storage.get<boolean>("deleted"))
      return error("Workspace was destroyed", 410);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      return error("Workspace expired", 410);
    const created = await this.ctx.storage.get<number>("createdAt");
    if (expiresAt > (created ?? Date.now()) + 86400000)
      return error("Workspace lifetime exceeds 24 hours", 400);
    if (!created) await this.ctx.storage.put("createdAt", Date.now());
    await this.ctx.storage.setAlarm(expiresAt);
    const container = this.#container();
    let started = false;
    let ready = false;
    let monitorFailure: Error | undefined;
    let stopped: Promise<Error> | undefined;
    const monitor = () => {
      try {
        stopped = container.monitor().then(
          () => {
            monitorFailure = new Error("Container exited before runtime readiness");
            return monitorFailure;
          },
          (cause: unknown) => {
            const exitCode =
              object(cause) && typeof cause.exitCode === "number"
                ? ` (exit ${cause.exitCode})`
                : "";
            monitorFailure = new Error(
              `Native container startup failed${exitCode}: ${String(cause)}`,
            );
            return monitorFailure;
          },
        );
      } catch (cause) {
        monitorFailure = new Error(`Native monitor setup failed: ${String(cause)}`);
        stopped = Promise.resolve(monitorFailure);
      }
    };
    const awaitRuntimeToken = await capability(this.env.CONTROL_TOKEN, "runtime");
    const awaitOwnershipToken = await capability(this.env.CONTROL_TOKEN, "ownership");
    secrets.push(awaitRuntimeToken, awaitOwnershipToken);
    const start = (): Response | undefined => {
      const failure = interrupted();
      if (failure) return failure;
      phase = "native-start";
      try {
        container.start({
          image: container.images.default!,
          instance: "standard-4",
          enableInternet: true,
          entrypoint: ["/usr/bin/sleep", "infinity"],
        });
      } catch (cause) {
        throw new Error(`Native start invocation failed: ${String(cause)}`);
      }
      started = true;
      monitor();
      return undefined;
    };
    const initialize = async (): Promise<Response> => {
      try {
        const failure = interrupted();
        if (failure) return failure;
        if (!container.running) {
          const failure = start();
          if (failure) return failure;
        } else {
          monitor();
        }
        let restartAt = Date.now() + 10000;
        let bootstrapped = false;
        for (;;) {
          const failure = interrupted();
          if (failure) return failure;
          try {
            phase = "native-exec-readiness";
            const probe = await Promise.race([
              container.exec(["true"], { stdout: "ignore", stderr: "ignore" }),
              stopped!,
            ]);
            if (probe instanceof Error) throw probe;
            if ((await probe.exitCode) !== 0)
              return error("Native readiness command true exited nonzero", 503);
            const failure = interrupted();
            if (failure) return failure;
            if (!bootstrapped) {
              phase = "controller-bootstrap-launch";
              // flock serializes bootstrap across disconnected requests and DO
              // incarnations. The controller is detached and its source uses stdin,
              // not the platform's bounded per-variable environment transport.
              const bootstrap = await container.exec(
                [
                  "/usr/bin/flock",
                  "-w",
                  "20",
                  "/workspace/.remote-bootstrap.lock",
                  "node",
                  "--input-type=module",
                  "-",
                ],
                {
                  stdin: new Blob([
                    `const runtimeSource = ${JSON.stringify(runtimeSource)};\n`,
                    bootstrapSource,
                  ]).stream(),
                  stdout: "pipe",
                  stderr: "pipe",
                  env: {
                    RUNTIME_TOKEN: awaitRuntimeToken,
                    OWNERSHIP_TOKEN: awaitOwnershipToken,
                    EXPIRES_AT: String(expiresAt),
                    REMOTE_ORIGIN: origin,
                    PATH: "/usr/local/pnpm/bin:/usr/local/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                  },
                },
              );
              phase = "controller-bootstrap-output";
              const bootOutput = await Promise.race([bootstrap.output(), stopped!]);
              if (bootOutput instanceof Error) throw bootOutput;
              if (bootOutput.exitCode !== 0) {
                lastError = diagnostic(
                  `Controller bootstrap failed (exit ${bootOutput.exitCode}): ${new TextDecoder().decode(bootOutput.stderr)}`,
                );
                return error(lastError, 503);
              }
              bootstrapped = true;
            }
            const afterBootstrap = interrupted();
            if (afterBootstrap) return afterBootstrap;
            phase = "controller-http-readiness";
            const response = await this.#runtime(new Request(origin + "/status"), "/status");
            const afterProbe = interrupted();
            if (afterProbe) return afterProbe;
            if (response.ok) {
              try {
                phase = "native-inactivity-lifetime";
                await this.#renewLifetime();
              } catch (cause) {
                throw new Error(`Native inactivity lifetime setup failed: ${String(cause)}`);
              }
              const afterLifetime = interrupted();
              if (afterLifetime) return afterLifetime;
              ready = true;
              return json({ running: true, expiresAt, root: REMOTE_ROOT });
            }
            lastError = "Runtime readiness returned " + response.status;
            if (response.status >= 400 && response.status < 500) return error(lastError, 503);
          } catch (cause) {
            lastError = diagnostic(cause);
            if (phase !== "native-exec-readiness" && phase !== "controller-http-readiness")
              return error(`Remote startup failed during ${phase}: ${lastError}`, 503);
          }
          const failureAfterProbe = interrupted();
          if (failureAfterProbe) return failureAfterProbe;
          if (monitorFailure) return error(diagnostic(monitorFailure.message), 503);
          if (!container.running && Date.now() >= restartAt) {
            const failure = start();
            if (failure) return failure;
            restartAt = Date.now() + 10000;
          }
          if (Date.now() + 500 >= deadline)
            return error(`Remote startup timed out during ${phase}: ${lastError}`, 503);
          const delay = Promise.withResolvers<void>();
          setTimeout(delay.resolve, 500);
          await delay.promise;
        }
      } catch (cause) {
        lastError = diagnostic(cause);
        return error(
          `Remote startup failed during ${phase}: ${diagnostic(monitorFailure?.message ?? lastError)}`,
          503,
        );
      }
    };
    const result = await initialize();
    if (started && !ready && generation === this.#generation) {
      // Resolve the primary outcome before cleanup, so a teardown exception
      // cannot discard the native failure or cancellation we already observed.
      const startupFailure = `during ${phase}: ${diagnostic(monitorFailure?.message ?? lastError)}`;
      try {
        await this.#stop();
      } catch (cause) {
        return error(
          `Remote startup failed ${startupFailure}; native startup cleanup failed: ${diagnostic(cause)}`,
          503,
        );
      }
    }
    return result;
  }
  #stop(): Promise<void> {
    // Invalidate first: neither storage nor destroy awaits may allow an old
    // readiness continuation to restart the container.
    this.#generation++;
    this.#stopping ??= this.#destroy().finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }
  async #destroy(): Promise<void> {
    await this.#container().destroy();
    // A successful destroy request can precede the platform's stopped state.
    for (const deadline = Date.now() + 60000; this.#container().running;) {
      if (Date.now() >= deadline) throw new Error("Container did not stop before timeout");
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 250);
      await delay.promise;
    }
  }
  override async alarm(): Promise<void> {
    if (Date.now() >= this.#expiresAt() || (await this.ctx.storage.get<boolean>("deleted"))) {
      await Promise.all([this.#stop(), this.ctx.storage.put("deleted", true)]);
    } else if (this.#container().running) {
      await this.#renewLifetime();
    } else {
      await this.ctx.storage.setAlarm(this.#expiresAt());
    }
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const control = await equal(bearer, this.env.CONTROL_TOKEN);
      const ownership =
        path === PREFIX + "/ownership" &&
        request.method === "POST" &&
        (await equal(bearer, await capability(this.env.CONTROL_TOKEN, "ownership")));
      if (path === PREFIX || path.startsWith(PREFIX + "/")) {
        if (!control && !ownership) return error("Control authentication required", 401);
        const route = path.slice(PREFIX.length) || "/";
        // Ownership survives disk destruction and expiry so cleanup remains possible.
        if (route === "/ownership") {
          if (request.method === "GET") {
            const records = await this.ctx.storage.list({ prefix: "ownership:" });
            return json({ environments: Array.from(records.values()) });
          }
          if (request.method === "POST") {
            const value = await smallJson(request);
            if (!object(value) || !object(value.environment))
              return error("Invalid ownership record", 400);
            const environment = value.environment;
            if (
              typeof environment.id !== "string" ||
              !/^[a-z0-9-]{1,80}$/.test(environment.id) ||
              typeof environment.account !== "string" ||
              !object(environment.resources)
            )
              return error("Invalid ownership record", 400);
            if (
              !/^[a-f0-9]{32}$/.test(environment.account) ||
              typeof environment.created !== "number" ||
              typeof environment.expires !== "number" ||
              typeof environment.ai !== "boolean" ||
              typeof environment.status !== "string" ||
              !["provisioning", "ready", "deleting", "deleted", "orphaned"].includes(
                environment.status,
              )
            )
              return error("Invalid ownership metadata", 400);
            if (environment.account !== this.env.ACCOUNT_ID)
              return error("Ownership account does not match this remote workspace", 403);
            // Persist only known secret-free metadata, never arbitrary command environment.
            const allowedResources = ["artifacts", "vectors", "search", "gateway"];
            const resources: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(environment.resources)) {
              if (
                !allowedResources.includes(key) ||
                typeof value !== "string" ||
                !["pending", "created", "deleted", "orphaned"].includes(value)
              )
                return error("Invalid owned resource", 400);
              resources[key] = value;
            }
            let quota: { authority: string; state: string } | undefined;
            if (environment.quota !== undefined) {
              const value = environment.quota;
              if (
                !object(value) ||
                typeof value.authority !== "string" ||
                typeof value.state !== "string" ||
                !["pending", "reserved", "released"].includes(value.state)
              )
                return error("Invalid quota ownership metadata", 400);
              let origin: URL;
              try {
                origin = new URL(value.authority);
              } catch {
                return error("Invalid quota authority", 400);
              }
              if (
                origin.protocol !== "https:" ||
                origin.origin !== value.authority ||
                origin.username ||
                origin.password
              )
                return error("Invalid quota authority", 400);
              quota = { authority: value.authority, state: value.state };
            }
            // Reservations only move forward and never change authority (CORE-368).
            const stored = await this.ctx.storage.get<{
              quota?: Parameters<typeof mergeOwnershipQuota>[0];
            }>("ownership:" + environment.id);
            const merged = mergeOwnershipQuota(stored?.quota, quota);
            quota = merged.quota;
            await this.ctx.storage.put("ownership:" + environment.id, {
              id: environment.id,
              account: environment.account,
              created: environment.created,
              expires: environment.expires,
              resources,
              status: environment.status,
              ai: environment.ai,
              ...(quota ? { quota } : {}),
            });
            // Resource states are still recorded, since cleanup depends on them,
            // but a different authority is refused loudly, never adopted.
            if (merged.conflict)
              return error("Quota authority differs from the recorded reservation", 409);
            return json({ ok: true });
          }
          return error("Method not allowed", 405);
        }
        if (
          (route === "/stop" && request.method === "POST") ||
          (route === "/" && request.method === "DELETE")
        ) {
          const stopping = this.#stop();
          if (request.method === "DELETE")
            await Promise.all([stopping, this.ctx.storage.put("deleted", true)]);
          else await stopping;
          return json({ running: false });
        }
        const deleted = await this.ctx.storage.get<boolean>("deleted");
        const expired = Date.now() >= this.#expiresAt();
        if (
          route === "/status" &&
          request.method === "GET" &&
          (expired || deleted || this.#stopping || !this.#container().running)
        )
          return json({
            running: false,
            expiresAt: this.#expiresAt(),
            processes: [],
            sourceRevision: null,
          });
        if (expired || deleted) return error("Workspace expired or destroyed", 410);
        if (route === "/start" && request.method === "POST") {
          const generation = this.#generation;
          const body = await smallJson(request);
          if (this.#stopping || generation !== this.#generation)
            return error("Workspace is stopping", 409);
          if (
            !object(body) ||
            (body.expiresAt !== undefined && body.expiresAt !== this.#expiresAt())
          )
            return error("Expiry is fixed at provisioning", 400);
          this.#starting ??= this.#start(url.origin).finally(() => {
            this.#starting = undefined;
          });
          return await this.#starting;
        }
        if (route === "/preview-ticket" && request.method === "POST") {
          const ticket = crypto.randomUUID();
          const expiresAt = Math.min(Date.now() + 60000, this.#expiresAt());
          // One outstanding launch ticket; replacing it also bounds durable storage.
          await this.ctx.storage.put("ticket", { ticket, expiresAt });
          return json({ ticket, expiresAt, url: url.origin + "/__preview?ticket=" + ticket });
        }
        if (!this.#container().running)
          return error("Workspace is stopped; start and synchronize it first", 409);
        if (route.startsWith("/ports/9229/"))
          return await this.#proxy(request, 9229, route.slice("/ports/9229".length), true);
        return await this.#runtime(request, route);
      }
      if (Date.now() >= this.#expiresAt() || (await this.ctx.storage.get<boolean>("deleted")))
        return error("Workspace expired or destroyed", 410);
      if (path === "/__preview") {
        if (request.method !== "GET") return error("Method not allowed", 405);
        const ticket = url.searchParams.get("ticket") ?? "";
        const accepted = await this.ctx.storage.transaction(async (storage) => {
          const stored = await storage.get<{ ticket: string; expiresAt: number }>("ticket");
          if (!stored || stored.expiresAt <= Date.now() || !(await equal(ticket, stored.ticket)))
            return false;
          await storage.delete("ticket");
          return true;
        });
        if (!accepted) return error("Preview ticket is invalid or expired", 401);
        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "set-cookie":
              COOKIE +
              "=" +
              this.env.PREVIEW_TOKEN +
              "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" +
              Math.max(0, Math.floor((this.#expiresAt() - Date.now()) / 1000)),
          },
        });
      }
      const cookie =
        request.headers
          .get("cookie")
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(COOKIE + "="))
          ?.slice(COOKIE.length + 1) ?? "";
      if (!(await equal(cookie, this.env.PREVIEW_TOKEN)))
        return error("Open a one-time preview launch URL from the local agent", 401);
      // A cross-origin WebSocket must not borrow the browser's preview cookie.
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return error("Cross-origin preview request rejected", 403);
      if (!this.#container().running) return error("Workspace is stopped", 503);
      return await this.#proxy(request, 5270, path, control);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : "Remote operation failed", 500);
    }
  }
  async #proxy(
    request: Request,
    port: number,
    path: string,
    stripControl: boolean,
  ): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = path;
    const headers = new Headers(request.headers);
    if (stripControl) headers.delete("authorization");
    const cookies = (headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith(COOKIE + "="));
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    else headers.delete("cookie");
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    url.protocol = "http:";
    if (port === 9229) {
      url.hostname = "127.0.0.1";
      url.port = "9229";
      headers.set("host", "127.0.0.1:9229");
    }
    const response = await this.#container()
      .getTcpPort(port === 9229 ? 9230 : port)
      .fetch(
        new Request(url, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
    if (
      port === 9229 &&
      request.method === "GET" &&
      path.startsWith("/json") &&
      response.ok &&
      response.status !== 101
    ) {
      const data = await smallJson(
        new Request(request.url, { method: "POST", body: response.body }),
      );
      const rewrite = (record: unknown) => {
        if (!object(record) || typeof record.webSocketDebuggerUrl !== "string") return record;
        const socket = new URL(record.webSocketDebuggerUrl);
        const publicSocket = new URL(request.url);
        publicSocket.protocol = "wss:";
        publicSocket.pathname = PREFIX + "/ports/9229" + socket.pathname;
        publicSocket.search = socket.search;
        return { ...record, webSocketDebuggerUrl: publicSocket.href };
      };
      return json(Array.isArray(data) ? data.map(rewrite) : rewrite(data));
    }
    return response;
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // A session owns exactly one container; untrusted URL components never select an ID.
    return env.WORKSPACE.getByName("workspace").fetch(request);
  },
} satisfies ExportedHandler<Env>;
