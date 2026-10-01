import { beforeEach, describe, expect, it } from "vite-plus/test";

import { makeHarness, type Harness } from "../../testing/harness.ts";
import { completeNpmLogin } from "./login.ts";

describe("npm login", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await h.createRepo({ key: "js", format: "npm", kind: "local", visibility: "private" });
  });

  it("accepts a token as the legacy login password", async () => {
    const token = h.token("bob");
    const res = await h.request("/npm/js/-/user/org.couchdb.user:bob", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        _id: "org.couchdb.user:bob",
        name: "bob",
        password: token,
        type: "user",
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, token });

    const who = await h.request("/npm/js/-/whoami", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await who.json()).toEqual({ username: "bob" });
  });

  it("rejects a password that is not a valid token", async () => {
    const res = await h.request("/npm/js/-/user/org.couchdb.user:bob", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob", password: "hunter2" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("runs the web login flow end to end", async () => {
    const start = await h.request("/npm/js/-/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "laptop" }),
    });
    expect(start.status).toBe(200);
    const { loginUrl, doneUrl } = (await start.json()) as { loginUrl: string; doneUrl: string };
    const login = new URL(loginUrl);
    expect(login.origin).toBe("https://pkg.test");
    expect(login.searchParams.get("registry")).toBe("js");
    const publicId = login.pathname.split("/").pop()!;
    expect(login.pathname).toBe(`/cli-auth/npm/${publicId}`);
    const done = new URL(doneUrl);
    expect(done.origin).toBe("https://pkg.test");
    expect(done.pathname.startsWith(`/npm/js/-/v1/done/${publicId}.`)).toBe(true);

    const pending = await h.request(done.pathname);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("2");

    // A wrong secret learns nothing.
    expect((await h.request(`/npm/js/-/v1/done/${publicId}.wrong`)).status).toBe(404);

    const token = h.token("bob");
    expect(await completeNpmLogin(h.env, publicId, token)).toBe(true);
    expect(await completeNpmLogin(h.env, publicId, "again")).toBe(false);

    const ready = await h.request(done.pathname);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ token });
    expect((await h.request(done.pathname)).status).toBe(410);
  });

  it("does not know unknown or malformed logins", async () => {
    expect((await h.request("/npm/js/-/v1/done/nope")).status).toBe(404);
    expect((await h.request("/npm/js/-/v1/done/AAAAAAAAAAAAAAAAAAAAAAAA.secret")).status).toBe(404);
    expect(await completeNpmLogin(h.env, "../../etc", "t")).toBe(false);
    expect(await completeNpmLogin(h.env, "AAAAAAAAAAAAAAAAAAAAAAAA", "t")).toBe(false);
  });
});
