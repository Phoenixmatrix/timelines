import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { tokenCredential } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { issueToken } from "./tokens.ts";
import { environmentSettings, environments } from "./environments.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('quota-owner', 'user', 'quota-owner', 'Owner'),
      ('quota-other', 'user', 'quota-other', 'Other'),
      ('quota-admin', 'user', 'quota-admin', 'Admin');
    UPDATE accounts SET is_site_admin = 1 WHERE id = 'quota-admin';
    INSERT INTO agents (id, name, accountable_id) VALUES ('quota-agent', 'quota-builder', 'quota-owner');
  `);
  const env = { DB: d1(sqlite) } as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    if (credential.kind === "token" && credential.scope === "read" && c.req.method !== "GET")
      return c.json({ error: "Read-only token." }, 403);
    return next();
  });
  app.route("/environments", environments);
  app.route("/admin/environments", environmentSettings);
  const tokens = {
    owner: (await issueToken(env.DB, "quota-owner", "owner", "write")).secret,
    other: (await issueToken(env.DB, "quota-other", "other", "write")).secret,
    admin: (await issueToken(env.DB, "quota-admin", "admin", "write")).secret,
    agent: (await issueToken(env.DB, "quota-owner", "agent", "write", undefined, "quota-agent"))
      .secret,
    read: (await issueToken(env.DB, "quota-owner", "read", "read")).secret,
  };
  const call = async (token: string | null, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  return { sqlite, tokens, call };
}

function reservation(index: number, backend = "local") {
  return {
    id:
      backend === "remote"
        ? `gmr-${index.toString(16).padStart(24, "0")}`
        : `gma-mga00000-${index.toString(16).padStart(12, "0")}`,
    account: "a".repeat(32),
    backend,
    expires: Date.now() + 60_000,
  };
}

describe("installation environment quota", () => {
  test("defaults to four; only a human site admin can change it; lowering never evicts", async () => {
    const { tokens, call } = await setup();
    expect((await call(null, "GET", "/environments")).status).toBe(401);
    expect(await (await call(tokens.owner, "GET", "/environments")).json()).toMatchObject({
      maximum: 4,
      used: 0,
    });
    for (const token of [tokens.owner, tokens.agent, tokens.read])
      expect((await call(token, "PATCH", "/admin/environments", { maximum: 9 })).status).toBe(403);
    const body = reservation(1);
    expect((await call(tokens.agent, "POST", "/environments/reservations", body)).status).toBe(200);
    expect((await call(tokens.admin, "PATCH", "/admin/environments", { maximum: 0 })).status).toBe(
      200,
    );
    expect(await (await call(tokens.owner, "GET", "/environments")).json()).toMatchObject({
      maximum: 0,
      used: 1,
    });
    expect((await call(tokens.owner, "POST", "/environments/reservations", body)).status).toBe(200);
    expect(
      (await call(tokens.other, "POST", "/environments/reservations", reservation(2))).status,
    ).toBe(409);
    expect(
      (await call(tokens.other, "DELETE", `/environments/reservations/${body.id}`)).status,
    ).toBe(403);
    expect(
      (await call(tokens.owner, "DELETE", `/environments/reservations/${body.id}`)).status,
    ).toBe(200);
    expect(
      (await call(tokens.owner, "DELETE", `/environments/reservations/${body.id}`)).status,
    ).toBe(200);
  });

  test("two machines/users and both backends contend atomically for the last slot", async () => {
    const { tokens, call } = await setup();
    await call(tokens.admin, "PATCH", "/admin/environments", { maximum: 1 });
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call(
          i % 2 ? tokens.owner : tokens.other,
          "POST",
          "/environments/reservations",
          reservation(i, i % 2 ? "local" : "remote"),
        ),
      ),
    );
    expect(attempts.filter((response) => response.status === 200)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(11);
    expect(await (await call(tokens.owner, "GET", "/environments")).json()).toMatchObject({
      maximum: 1,
      used: 1,
    });
  });

  test("remote session IDs share admission, owner authorization and exact idempotency", async () => {
    const { tokens, call } = await setup();
    await call(tokens.admin, "PATCH", "/admin/environments", { maximum: 1 });
    const remote = reservation(9, "remote");
    expect(
      await (await call(tokens.agent, "POST", "/environments/reservations", remote)).json(),
    ).toEqual({ id: remote.id, reserved: true });
    expect((await call(tokens.owner, "POST", "/environments/reservations", remote)).status).toBe(
      200,
    );
    expect((await call(tokens.other, "POST", "/environments/reservations", remote)).status).toBe(
      409,
    );
    expect(
      (await call(tokens.owner, "POST", "/environments/reservations", reservation(10))).status,
    ).toBe(409);
    expect(
      (await call(tokens.other, "DELETE", `/environments/reservations/${remote.id}`)).status,
    ).toBe(403);
    expect(
      await (await call(tokens.owner, "DELETE", `/environments/reservations/${remote.id}`)).json(),
    ).toEqual({ id: remote.id, released: true });
    expect(
      (await call(tokens.owner, "POST", "/environments/reservations", reservation(10))).status,
    ).toBe(200);
    for (const id of ["gmr-" + "a".repeat(23), "gmr-" + "a".repeat(25), "gmr-" + "A".repeat(24)])
      expect(
        (await call(tokens.owner, "POST", "/environments/reservations", { ...remote, id })).status,
      ).toBe(400);
    expect(
      (
        await call(tokens.owner, "POST", "/environments/reservations", {
          ...remote,
          backend: "local",
        })
      ).status,
    ).toBe(400);
  });

  test("expired and failed-provisioning reservations hold capacity until explicit cleanup", async () => {
    const { tokens, call } = await setup();
    await call(tokens.admin, "PATCH", "/admin/environments", { maximum: 1 });
    const expired = { ...reservation(1), expires: Date.now() - 60_000 };
    expect((await call(tokens.owner, "POST", "/environments/reservations", expired)).status).toBe(
      200,
    );
    expect(
      (await call(tokens.owner, "POST", "/environments/reservations", reservation(2))).status,
    ).toBe(409);
    await call(tokens.owner, "DELETE", `/environments/reservations/${expired.id}`);
    expect(
      (await call(tokens.owner, "POST", "/environments/reservations", reservation(2))).status,
    ).toBe(200);
  });

  test("conflicting idempotency keys and invalid configuration never admit or fail open", async () => {
    const { tokens, call, sqlite } = await setup();
    const body = reservation(1);
    await call(tokens.owner, "POST", "/environments/reservations", body);
    for (const changed of [
      { ...body, account: "b".repeat(32) },
      { ...body, backend: "remote" },
    ])
      expect((await call(tokens.owner, "POST", "/environments/reservations", changed)).status).toBe(
        409,
      );
    expect((await call(tokens.other, "POST", "/environments/reservations", body)).status).toBe(409);
    for (const maximum of [-1, 1.5, "4", null, 2147483648])
      expect((await call(tokens.admin, "PATCH", "/admin/environments", { maximum })).status).toBe(
        400,
      );
    expect(
      (await call(tokens.read, "POST", "/environments/reservations", reservation(3))).status,
    ).toBe(403);
    sqlite.exec("DELETE FROM environment_limits");
    expect(
      (await call(tokens.owner, "POST", "/environments/reservations", reservation(4))).status,
    ).toBe(500);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM environment_reservations").get(),
    ).toMatchObject({ n: 1 });
  });
});
