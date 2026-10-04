import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { workerFirst } from "../shared/worker-first.ts";
import { previewFetch, previewGate } from "./preview-gate.ts";

const issuer = "https://preview-test.cloudflareaccess.com";
const audience = "preview-application";
const preview = {
  PREVIEW_MODE: "true",
  PREVIEW_ACCESS_ISSUER: issuer,
  PREVIEW_ACCESS_AUD: audience,
};
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://timeline-x-gitmatrix.example.workers.dev${path}`, { headers });
const assertion = (token: string) => ({ "Cf-Access-Jwt-Assertion": token });
let privateKey: CryptoKey;
let forgedKey: CryptoKey;

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  privateKey = trusted.privateKey;
  forgedKey = (await generateKeyPair("RS256")).privateKey;
  const publicKey = { ...(await exportJWK(trusted.publicKey)), kid: "access-key", alg: "RS256" };
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url) !== `${issuer}/cdn-cgi/access/certs`) {
      return new Response(null, { status: 503 });
    }
    return Response.json({ keys: [publicKey] });
  });
});

afterAll(() => vi.unstubAllGlobals());

function sign(claims: JWTPayload = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: [audience], iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .sign(key);
}

describe("previewGate", () => {
  test("accepts signed human and service assertions without requiring shared identity claims", async () => {
    for (const claims of [
      { email: "person@example.com", sub: "human-id", type: "app" },
      { common_name: "agent.access", sub: "", type: "app" },
    ]) {
      expect(await previewGate(get("/", assertion(await sign(claims))), preview)).toBeNull();
    }
  });

  test("denies old preview credentials, app PATs, and unsigned Access identity headers", async () => {
    for (const request of [
      get("/"),
      get("/?preview_key=old-key"),
      get("/", { cookie: "gm_preview=old-key" }),
      get("/", { "x-preview-key": "old-key" }),
      get("/", { authorization: "Bearer gmx_live" }),
      get("/", { "Cf-Access-Authenticated-User-Email": "person@example.com" }),
      get("/", { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" }),
      get("/", assertion("forged")),
    ]) {
      const response = await previewGate(request, { ...preview, PREVIEW_KEY: "old-key" });
      expect(response?.status).toBe(401);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });

  test.each([
    ["wrong audience", { aud: ["another-application"] }],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["expired", { exp: 1 }],
    ["missing expiry", { exp: undefined }],
    ["not yet valid", { nbf: 4_000_000_000 }],
    ["missing audience", { aud: undefined }],
    ["missing issuer", { iss: undefined }],
  ] satisfies [string, JWTPayload][])(
    "rejects a signed assertion with %s",
    async (_name, claims) => {
      expect((await previewGate(get("/", assertion(await sign(claims))), preview))?.status).toBe(
        401,
      );
    },
  );

  test("rejects a forged signature even with the trusted key ID and claims", async () => {
    const token = await sign({}, forgedKey);
    expect((await previewGate(get("/", assertion(token)), preview))?.status).toBe(401);
  });

  test("rejects an attacker-selected signing algorithm", async () => {
    const token = await new SignJWT({ iss: issuer, aud: audience, exp: 4_000_000_000 })
      .setProtectedHeader({ alg: "HS256", kid: "access-key" })
      .sign(new TextEncoder().encode("attacker-secret"));
    expect((await previewGate(get("/", assertion(token)), preview))?.status).toBe(401);
  });

  test("fails closed on missing or malformed Access configuration", async () => {
    const token = await sign();
    for (const configuration of [
      { PREVIEW_ACCESS_ISSUER: undefined },
      { PREVIEW_ACCESS_ISSUER: "http://preview-test.cloudflareaccess.com" },
      { PREVIEW_ACCESS_ISSUER: `${issuer}/` },
      { PREVIEW_ACCESS_ISSUER: `${issuer}/untrusted-path` },
      { PREVIEW_ACCESS_ISSUER: "https://attacker.example.com" },
      { PREVIEW_ACCESS_AUD: undefined },
      { PREVIEW_ACCESS_AUD: "" },
      { PREVIEW_ACCESS_AUD: " " },
      { PREVIEW_ACCESS_AUD: 123 },
    ]) {
      expect(
        (await previewGate(get("/", assertion(token)), { ...preview, ...configuration }))?.status,
      ).toBe(401);
    }
  });

  test("fails closed if the signing keys cannot be retrieved", async () => {
    const unavailableIssuer = "https://unavailable.cloudflareaccess.com";
    const token = await sign({ iss: unavailableIssuer });
    expect(
      (
        await previewGate(get("/", assertion(token)), {
          ...preview,
          PREVIEW_ACCESS_ISSUER: unavailableIssuer,
        })
      )?.status,
    ).toBe(401);
  });

  test("does not gate production or local development", async () => {
    expect(await previewGate(get("/api/session"), {})).toBeNull();
    expect(
      await previewGate(get("/", assertion("invalid")), {
        ...preview,
        PREVIEW_MODE: "false",
      }),
    ).toBeNull();
  });
});

describe("previewFetch", () => {
  const ctx = {} as ExecutionContext; // The assets router does not provide ctx.access.
  const app = { fetch: vi.fn(async () => new Response("app")) };
  const assets = { fetch: vi.fn(async () => new Response("asset")) };
  const env = Object.assign({} as Env, preview, { ASSETS: assets });
  const routes: [string, string][] = [
    ["/api/session", "app"],
    ["/api/dev/environment", "app"],
    ["/orbit/engine.git/info/refs", "app"],
    ["/v2/orbit/engine/manifests/latest", "app"],
    ["/orbit/engine", "asset"],
    ["/assets/index.js", "asset"],
  ];

  test("routes signed human and service requests to the app or static assets", async () => {
    for (const claims of [{ email: "person@example.com" }, { common_name: "agent.access" }]) {
      const headers = assertion(await sign(claims));
      for (const [path, body] of routes) {
        expect(await (await previewFetch(get(path, headers), env, ctx, app)).text()).toBe(body);
      }
      expect(
        await (
          await previewFetch(
            get("/api/events", {
              ...headers,
              Upgrade: "websocket",
            }),
            env,
            ctx,
            app,
          )
        ).text(),
      ).toBe("app");
    }
  });

  test("denies API, git, registry, assets and websocket requests before either handler", async () => {
    app.fetch.mockClear();
    assets.fetch.mockClear();
    for (const headers of [{}, assertion(await sign({}, forgedKey))]) {
      for (const [path] of routes) {
        expect((await previewFetch(get(path, headers), env, ctx, app)).status).toBe(401);
      }
      expect(
        (
          await previewFetch(
            get("/api/events", {
              ...headers,
              Upgrade: "websocket",
            }),
            env,
            ctx,
            app,
          )
        ).status,
      ).toBe(401);
    }
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
