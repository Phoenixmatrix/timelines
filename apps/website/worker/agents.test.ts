import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { Agent, CreatedAccessToken, SessionResponse } from "../shared/api.ts";
import { accounts } from "./api/accounts.ts";
import { agents } from "./api/agents.ts";
import { issueToken, tokens } from "./api/tokens.ts";
import { tokenCredential, type AppEnv } from "./auth.ts";
import { d1, migratedDatabase } from "./testing/d1.ts";

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(
    "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann Lee')",
  );
  const env = { DB: d1(sqlite) } as unknown as Env;
  // The API's token middleware, without the session and bookkeeping parts.
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    if (credential.kind === "invalid") return c.json({ error: "Invalid access token." }, 401);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api", accounts);
  app.route("/api/agents", agents);
  app.route("/api/tokens", tokens);
  const call = (token: string, path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      env,
    );
  return { env, call };
}

describe("agents", () => {
  test("an agent's token acts as the agent, with its person's identity alongside", async () => {
    const { env, call } = setup();
    const person = (await issueToken(env.DB, "acc_ann", "laptop", "write")).secret;
    const created = await call(person, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "builder", description: "Works the CORE graph" }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: Agent };
    expect(agent).toMatchObject({ name: "builder", accountable: { slug: "ann" }, revokedAt: null });

    const minted = await call(person, `/api/agents/${agent.id}/tokens`, {
      method: "POST",
      body: "{}",
    });
    const token = (await minted.json()) as CreatedAccessToken;
    const session = (await (await call(token.secret, "/api/session")).json()) as SessionResponse;
    expect(session.viewer).toMatchObject({
      slug: "ann",
      agent: { id: agent.id, name: "builder" },
    });

    // The person's token list leaves agents' tokens to the agents page.
    const listed = (await (await call(person, "/api/tokens")).json()) as { tokens: unknown[] };
    expect(listed.tokens).toHaveLength(1);
    const own = (await (await call(person, "/api/agents")).json()) as { agents: Agent[] };
    expect(own.agents[0]!.tokens.map((t) => t.lastFour)).toEqual([token.lastFour]);
  });

  test("agents can't manage agents or credentials, and revoking one ends its tokens at once", async () => {
    const { env, call } = setup();
    const person = (await issueToken(env.DB, "acc_ann", "laptop", "write")).secret;
    const { agent } = (await (
      await call(person, "/api/agents", { method: "POST", body: JSON.stringify({ name: "bot" }) })
    ).json()) as { agent: Agent };
    const token = (
      (await (
        await call(person, `/api/agents/${agent.id}/tokens`, { method: "POST", body: "{}" })
      ).json()) as CreatedAccessToken
    ).secret;

    for (const [path, body] of [
      ["/api/agents", { name: "spawn" }],
      ["/api/tokens", { name: "escape", scope: "write" }],
    ] as const) {
      const response = await call(token, path, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(403);
    }
    expect(
      (await call(person, "/api/agents", { method: "POST", body: JSON.stringify({ name: "bot" }) }))
        .status,
    ).toBe(409);

    expect((await call(person, `/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(token, "/api/session")).status).toBe(401);
    const after = (await (await call(person, "/api/agents")).json()) as { agents: Agent[] };
    expect(after.agents[0]).toMatchObject({ name: "bot", tokens: [] });
    expect(after.agents[0]!.revokedAt).not.toBeNull();
  });
});
