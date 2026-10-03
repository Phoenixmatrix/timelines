// A preview's access gate (CORE-80): nothing in a preview answers without its
// key, and outside a preview there is no gate.

import { describe, expect, test, vi } from "vite-plus/test";
import { workerFirst } from "../shared/worker-first.ts";
import { previewFetch, previewGate, sameKey, type TokenCheck } from "./preview-gate.ts";

const KEY = "a1".repeat(32);
const preview = { PREVIEW_MODE: "true", PREVIEW_KEY: KEY };
const noTokens: TokenCheck = async () => false;

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://timeline-x-gitmatrix.example.workers.dev${path}`, { method, headers });

describe("previewGate", () => {
  test("no key: 401 with the access-link page", async () => {
    const response = await previewGate(get("/"), preview, noTokens);
    expect(response?.status).toBe(401);
    expect(await response?.text()).toContain(
      "This preview needs its access link; open it from the deployment in Gitmatrix.",
    );
    // The API, persona sign-in and the seed's identity route are all behind it.
    for (const path of ["/api/session", "/api/dev/environment", "/orbit/engine.git/info/refs"])
      expect((await previewGate(get(path), preview, noTokens))?.status).toBe(401);
  });

  test("the cookie passes", async () => {
    expect(
      await previewGate(
        get("/api/session", { cookie: `x=1; gm_preview=${KEY}` }),
        preview,
        noTokens,
      ),
    ).toBeNull();
  });

  test("the key in the URL sets the cookie and redirects without it", async () => {
    const response = await previewGate(
      get(`/orbit/engine?tab=code&preview_key=${KEY}`),
      preview,
      noTokens,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/orbit/engine?tab=code");
    const cookie = response?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`gm_preview=${KEY}`);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      expect(cookie).toContain(attribute);
    // Host-only: no Domain attribute.
    expect(cookie).not.toMatch(/domain=/i);
  });

  test("the x-preview-key header passes", async () => {
    expect(
      await previewGate(get("/api/dev/environment", { "x-preview-key": KEY }), preview, noTokens),
    ).toBeNull();
  });

  test("a wrong key gets the 401, wherever it is", async () => {
    const wrong = "b2".repeat(32);
    for (const request of [
      get(`/?preview_key=${wrong}`),
      get("/", { cookie: `gm_preview=${wrong}` }),
      get("/", { "x-preview-key": wrong }),
      get("/", { "x-preview-key": KEY.slice(0, 10) }),
      // A key in the URL only works for a page visit.
      get(`/api/session?preview_key=${KEY}`, {}, "POST"),
    ])
      expect((await previewGate(request, preview, noTokens))?.status).toBe(401);
  });

  test("a live access token passes (they're only minted behind the gate); a dead one doesn't", async () => {
    const check = vi.fn<TokenCheck>(async (header) => header === "Bearer gmx_live");
    expect(
      await previewGate(get("/api/session", { authorization: "Bearer gmx_live" }), preview, check),
    ).toBeNull();
    expect(
      (await previewGate(get("/api/session", { authorization: "Bearer gmx_dead" }), preview, check))
        ?.status,
    ).toBe(401);
  });

  test("a preview without a key lets nothing through", async () => {
    const keyless = { PREVIEW_MODE: "true" };
    const live: TokenCheck = async () => true;
    expect((await previewGate(get("/?preview_key="), keyless, live))?.status).toBe(401);
    expect(
      (await previewGate(get("/", { authorization: "Bearer gmx_x" }), keyless, live))?.status,
    ).toBe(401);
  });

  test("outside a preview there is no gate", async () => {
    expect(await previewGate(get("/api/session"), {}, noTokens)).toBeNull();
    expect(
      await previewGate(get("/"), { PREVIEW_MODE: "false", PREVIEW_KEY: KEY }, noTokens),
    ).toBeNull();
  });

  test("keys compare by value", () => {
    expect(sameKey(KEY, KEY)).toBe(true);
    expect(sameKey(`${KEY}0`, KEY)).toBe(false);
    expect(sameKey("", KEY)).toBe(false);
    expect(sameKey(KEY, "")).toBe(false);
  });
});

describe("previewFetch", () => {
  const app = { fetch: vi.fn(async () => new Response("app")) };
  const assets = { fetch: vi.fn(async () => new Response("asset")) };
  const env = { ...preview, ASSETS: assets } as unknown as Env;
  const ctx = {} as ExecutionContext;
  const key = { cookie: `gm_preview=${KEY}` };

  test("past the gate, the app answers its paths and the assets the rest", async () => {
    expect(
      await (await previewFetch(get("/api/session", key), env, ctx, app, noTokens)).text(),
    ).toBe("app");
    expect(
      await (
        await previewFetch(get("/orbit/engine.git/info/refs", key), env, ctx, app, noTokens)
      ).text(),
    ).toBe("app");
    expect(
      await (await previewFetch(get("/orbit/engine", key), env, ctx, app, noTokens)).text(),
    ).toBe("asset");
    expect(
      await (await previewFetch(get("/assets/index.js", key), env, ctx, app, noTokens)).text(),
    ).toBe("asset");
  });

  test("short of it, neither does", async () => {
    app.fetch.mockClear();
    assets.fetch.mockClear();
    expect((await previewFetch(get("/assets/index.js"), env, ctx, app, noTokens)).status).toBe(401);
    expect(app.fetch).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

test("workerFirst matches the routes the Worker answers", () => {
  expect(workerFirst("/api/session")).toBe(true);
  expect(workerFirst("/orbit/engine.git/info/refs")).toBe(true);
  expect(workerFirst("/v2/orbit/engine/manifests/latest")).toBe(true);
  expect(workerFirst("/")).toBe(false);
  expect(workerFirst("/orbit/engine")).toBe(false);
  expect(workerFirst("/api")).toBe(false);
});
