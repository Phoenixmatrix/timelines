import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { wrapCutoverBackground, wrapCutoverFetch } from "./cutover-admission.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";

vi.mock("cloudflare:workers", async () => import("../testing/runtime.ts"));

const disposers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of disposers.splice(0)) close();
});

async function fixture() {
  const installation = await createFreshSpaceTestEnvironment();
  disposers.push(installation.close);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
      void work.catch(() => undefined);
    },
  } as ExecutionContext;
  return { ...installation, ctx, pending };
}

const request = () => new Request("https://isolated.test/api/content");

describe("independent content admission lifetime", () => {
  test("stream EOF and transitive after-response writes must both finish before release", async () => {
    const t = await fixture();
    const flush = Promise.withResolvers<void>();
    const finalWrite = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const writes: string[] = [];
    const response = await wrapCutoverFetch(request(), t.env, t.ctx, async (_, __, ctx) => {
      ctx.waitUntil(
        flush.promise.then(() => {
          writes.push("first");
          ctx.waitUntil(
            finalWrite.promise.then(() => {
              writes.push("final");
            }),
          );
          queued.resolve();
        }),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("data"));
          },
        }),
      );
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data");
    stream.close();
    expect((await reader.read()).done).toBe(true);
    flush.resolve();
    await queued.promise;
    expect(writes).toEqual(["first"]);
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["http-git-registry"]);
    finalWrite.resolve();
    await Promise.all(t.pending);
    expect(writes).toEqual(["first", "final"]);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("cancelling a response waits for the producer cancellation acknowledgement", async () => {
    const t = await fixture();
    const cancellation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let cancelled = false;
    const response = await wrapCutoverFetch(
      request(),
      t.env,
      t.ctx,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              entered.resolve();
              await cancellation.promise;
              cancelled = true;
            },
          }),
        ),
    );
    expect(response.status).toBe(200);
    const cancel = response.body!.cancel("client disconnected");
    await entered.promise;
    expect(cancelled).toBe(false);
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["http-git-registry"]);
    cancellation.resolve();
    await cancel;
    await Promise.all(t.pending);
    expect(cancelled).toBe(true);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("an HTTP fence rejects the mutation without acquiring a ticket", async () => {
    const env = {} as Env;
    const t = installCutoverTestControl(env);
    disposers.push(t.close);
    await t.fence();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const records: string[] = [];
    const response = await wrapCutoverFetch(request(), env, {} as ExecutionContext, async () => {
      records.push("forbidden");
      return new Response("written");
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(records).toEqual([]);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("background failure still waits for recursively registered writes before release", async () => {
    const t = await fixture();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("scheduled work failed");
    const records: string[] = [];
    const execution = wrapCutoverBackground(t.env, "scheduled", t.ctx, async (ctx) => {
      ctx.waitUntil(
        first.promise.then(() => {
          ctx.waitUntil(
            second.promise.then(() => {
              records.push("late write");
            }),
          );
          registered.resolve();
        }),
      );
      entered.resolve();
      throw failure;
    });
    const outcome = execution.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.race([entered.promise, execution]);
    first.resolve();
    await registered.promise;
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["scheduled"]);
    expect(records).toEqual([]);
    second.resolve();
    expect(await outcome).toBe(failure);
    await Promise.all(t.pending);
    expect(records).toEqual(["late write"]);
    expect(t.control.activeTickets()).toEqual([]);
  });
});
