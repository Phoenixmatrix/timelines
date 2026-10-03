import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AvatarOptions, SessionResponse } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { avatarPrompts, avatars, imageType, MAX_AVATAR_BYTES } from "./api.ts";

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const annsAgent: Actor = { ...ann, agent: { id: "agt", name: "bot" } };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);

afterEach(() => vi.restoreAllMocks());

/** R2 enough for avatars: put, get, delete, kept in a Map. */
function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    objects,
    put: async (
      key: string,
      value: Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      objects.set(key, { bytes: value, type: options?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const object = objects.get(key);
      return object
        ? { body: new Blob([object.bytes]).stream(), httpMetadata: { contentType: object.type } }
        : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
}

function setup({ ai = "ok" as "ok" | "none" | "fail" | ((n: number) => boolean) } = {}) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
  `);
  const store = bucket();
  let calls = 0;
  const run = vi.fn(async () => {
    const n = calls++;
    if (ai === "fail" || (typeof ai === "function" && !ai(n))) throw new Error("model down");
    return { image: btoa(String.fromCharCode(...JPEG)) };
  });
  const env = {
    DB: d1(sqlite),
    AVATARS: store,
    AI: ai === "none" ? undefined : { run },
  } as unknown as Env;
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api", avatars);
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, init, env, ctx as unknown as ExecutionContext);
  return {
    sqlite,
    store,
    run,
    waits,
    as: (next: Actor | null) => {
      actor = next;
    },
    call,
    upload: (bytes: Uint8Array) => call("/account/avatar", { method: "PUT", body: bytes }),
  };
}

describe("avatar pictures", () => {
  test("accepts PNG, JPEG and WebP by their bytes, stores by content, and replaces the old one", async () => {
    expect([imageType(PNG), imageType(JPEG), imageType(WEBP)]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    const s = setup();
    const first = await s.upload(PNG);
    expect(first.status).toBe(200);
    const url = ((await first.json()) as SessionResponse).viewer!.avatarUrl!;
    expect(url).toMatch(/^\/api\/avatars\/ann\/[0-9a-f]{32}\.png$/);

    const served = await s.call(url.slice(4));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    await s.upload(WEBP);
    await Promise.all(s.waits);
    expect([...s.store.objects.keys()]).toEqual([
      expect.stringMatching(/^avatars\/ann\/[0-9a-f]{32}\.webp$/),
    ]);
  });

  test("rejects anything else, oversized pictures, agents and signed-out requests", async () => {
    const s = setup();
    expect((await s.upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(415);
    const huge = new Uint8Array(MAX_AVATAR_BYTES + 1);
    huge.set(PNG);
    expect((await s.upload(huge)).status).toBe(413);
    s.as(annsAgent);
    expect((await s.upload(PNG)).status).toBe(403);
    s.as(null);
    expect((await s.upload(PNG)).status).toBe(401);
    expect(s.store.objects.size).toBe(0);
  });

  test("removing goes back to initials and deletes the picture", async () => {
    const s = setup();
    await s.upload(PNG);
    const removed = await s.call("/account/avatar", { method: "DELETE" });
    expect(((await removed.json()) as SessionResponse).viewer!.avatarUrl).toBeNull();
    await Promise.all(s.waits);
    expect(s.store.objects.size).toBe(0);
  });

  test("serves only well-formed picture keys", async () => {
    const s = setup();
    for (const path of [
      "/avatars/ann/../secret",
      "/avatars/ann/abc.svg",
      "/avatars/ann/" + "0".repeat(32) + ".png",
    ])
      expect((await s.call(path)).status).toBe(404);
  });
});

describe("generated options", () => {
  const options = async (response: Response) => (await response.json()) as AvatarOptions;

  test("are made once, four of them, from fixed prompts", async () => {
    const s = setup();
    expect(await options(await s.call("/account/avatar/options"))).toEqual({
      status: "none",
      options: [],
    });
    const made = await s.call("/account/avatar/options", { method: "POST" });
    expect(made.status).toBe(201);
    expect(await options(made)).toEqual({
      status: "ready",
      options: [0, 1, 2, 3].map((n) => `/api/account/avatar/options/${n}`),
    });
    expect(s.run.mock.calls.map((call) => (call as unknown[])[1])).toEqual(
      avatarPrompts("ann").map((prompt) => ({ prompt, steps: 4 })),
    );
    // No rerolls: asking again changes nothing and runs no model.
    const again = await s.call("/account/avatar/options", { method: "POST" });
    expect(again.status).toBe(409);
    expect(s.run).toHaveBeenCalledTimes(4);
    const image = await s.call("/account/avatar/options/2");
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toMatch(/^private/);
  });

  test("a double click pays once", async () => {
    const s = setup();
    const [a, b] = await Promise.all([
      s.call("/account/avatar/options", { method: "POST" }),
      s.call("/account/avatar/options", { method: "POST" }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    expect(s.run).toHaveBeenCalledTimes(4);
  });

  test("nothing made can be retried; anything made is final", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = setup({ ai: "fail" });
    expect((await failed.call("/account/avatar/options", { method: "POST" })).status).toBe(502);
    expect(await options(await failed.call("/account/avatar/options"))).toEqual({
      status: "failed",
      options: [],
    });

    const partial = setup({ ai: (n) => n % 2 === 0 });
    const made = await partial.call("/account/avatar/options", { method: "POST" });
    expect((await options(made)).options).toHaveLength(2);
    expect((await partial.call("/account/avatar/options", { method: "POST" })).status).toBe(409);
    expect(partial.run).toHaveBeenCalledTimes(4);
  });

  test("are their owner's alone, and off without AI", async () => {
    const s = setup();
    await s.call("/account/avatar/options", { method: "POST" });
    s.as(ben);
    expect((await s.call("/account/avatar/options/0")).status).toBe(404);
    s.as(annsAgent);
    expect((await s.call("/account/avatar/options", { method: "POST" })).status).toBe(403);
    expect(
      (await setup({ ai: "none" }).call("/account/avatar/options", { method: "POST" })).status,
    ).toBe(503);
  });
});
