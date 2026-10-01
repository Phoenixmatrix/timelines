import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { accounts } from "./api/accounts.ts";
import { sessionActor, type AppEnv } from "./auth.ts";
import { authenticate } from "../registry/core/auth/authenticate.ts";

describe("production persona boundary", () => {
  for (const devMode of [undefined, "false"]) {
    test(`rejects persona impersonation with DEV_MODE ${devMode}`, async () => {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", await sessionActor(c));
        await next();
      });
      app.route("/api", accounts);
      // These rejected requests must never reach storage; deliberately supply no DB.
      const env = { DEV_MODE: devMode } as Env;
      const headers = { cookie: "gm_persona=site-admin", "content-type": "application/json" };
      const session = await app.request("/api/session", { headers }, env);
      expect(session.status).toBe(200);
      expect(await session.json()).toEqual({ viewer: null });
      const login = await app.request(
        "/api/session",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ accountId: "site-admin" }),
        },
        env,
      );
      expect(login.status).toBe(404);
      expect(login.headers.get("set-cookie")).toBeNull();
      expect((await app.request("/api/personas", { headers }, env)).status).toBe(404);
      const registryActor = await authenticate(env, new Headers(headers));
      expect(registryActor.kind).toBe("anonymous");
    });
  }
});
