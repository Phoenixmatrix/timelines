import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type {
  Agent,
  AgentCapabilities,
  CreatedAccessToken,
  SessionResponse,
} from "../shared/api.ts";
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
    if (
      credential.kind === "token" &&
      credential.scope === "read" &&
      c.req.method !== "GET" &&
      c.req.method !== "HEAD"
    )
      return c.json({ error: "This token is read-only." }, 403);
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
  return { env, call, sqlite };
}

const profile: AgentCapabilities = {
  version: 1,
  harness: "omp",
  model: "example-model",
  environment: { os: "linux", arch: "x64", runtime: "wsl", cpuCount: 8, memoryBytes: 8589934592 },
  tags: ["typescript", "backend"],
  skills: [{ name: "cloudflare", description: "Worker development", source: "detected" }],
};

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

  test("capabilities persist across owner and self requests while legacy agents remain unset", async () => {
    const { env, call, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO agents (id, name, accountable_id) VALUES ('agt_old', 'old', 'acc_ann')",
    );
    const person = (await issueToken(env.DB, "acc_ann", "laptop", "write")).secret;
    const created = await call(person, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "builder", capabilities: profile }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: Agent };
    const token = (await issueToken(env.DB, "acc_ann", "worker", "write", undefined, agent.id))
      .secret;
    const self = (await (await call(token, "/api/agents/self")).json()) as { agent: Agent };
    expect(self.agent).toMatchObject({
      name: "builder",
      capabilities: { ...profile, tags: ["backend", "typescript"] },
    });
    expect(self.agent.capabilitiesUpdatedAt).toEqual(expect.any(String));
    const changed = {
      ...profile,
      model: null,
      tags: ["gpu", "gpu"],
      skills: [...profile.skills, ...profile.skills],
    };
    expect(
      (
        await call(token, "/api/agents/self/capabilities", {
          method: "PUT",
          body: JSON.stringify(changed),
        })
      ).status,
    ).toBe(200);
    const fetched = (await (await call(person, `/api/agents/${agent.id}`)).json()) as {
      agent: Agent;
    };
    expect(fetched.agent.capabilities).toEqual({
      ...changed,
      tags: ["gpu"],
      skills: profile.skills,
    });
    const listed = (await (await call(person, "/api/agents")).json()) as { agents: Agent[] };
    expect(listed.agents.find((row) => row.id === agent.id)).toEqual(fetched.agent);
    expect(listed.agents.find((row) => row.id === "agt_old")).toMatchObject({
      capabilities: null,
      capabilitiesUpdatedAt: null,
    });
    expect(
      (
        await call(person, `/api/agents/${agent.id}/capabilities`, {
          method: "PUT",
          body: JSON.stringify(profile),
        })
      ).status,
    ).toBe(200);
    expect((await call(person, `/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    const revoked = (await (await call(person, `/api/agents/${agent.id}`)).json()) as {
      agent: Agent;
    };
    expect(revoked.agent).toMatchObject({
      name: "builder",
      capabilities: { model: profile.model },
    });
    expect(revoked.agent.revokedAt).toEqual(expect.any(String));
    expect((await call(token, "/api/agents/self")).status).toBe(401);
    expect(
      (
        await call(person, `/api/agents/${agent.id}/capabilities`, {
          method: "PUT",
          body: JSON.stringify(profile),
        })
      ).status,
    ).toBe(409);
  });

  test("self-reporting grants no access to other identities or credential management", async () => {
    const { env, call, sqlite } = setup();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_bob', 'user', 'bob', 'Bob');
      INSERT INTO agents (id, name, accountable_id) VALUES
        ('agt_bot', 'bot', 'acc_ann'), ('agt_other', 'other', 'acc_ann'),
        ('agt_bob', 'bob-bot', 'acc_bob');
    `);
    const person = (await issueToken(env.DB, "acc_ann", "owner", "write")).secret;
    const token = (await issueToken(env.DB, "acc_ann", "worker", "write", undefined, "agt_bot"))
      .secret;
    for (const id of ["agt_other", "agt_bob"]) {
      expect((await call(token, `/api/agents/${id}`)).status).toBe(403);
      expect(
        (
          await call(token, `/api/agents/${id}/capabilities`, {
            method: "PUT",
            body: JSON.stringify(profile),
          })
        ).status,
      ).toBe(403);
    }
    expect((await call(person, "/api/agents/agt_bob")).status).toBe(404);
    expect(
      (
        await call(person, "/api/agents/agt_bob/capabilities", {
          method: "PUT",
          body: JSON.stringify(profile),
        })
      ).status,
    ).toBe(404);
    expect((await call(person, "/api/agents/self")).status).toBe(403);
    expect(
      (
        await call(person, "/api/agents/self/capabilities", {
          method: "PUT",
          body: JSON.stringify(profile),
        })
      ).status,
    ).toBe(403);
    expect((await call(token, "/api/agents")).status).toBe(403);
    expect((await call(token, "/api/agents/agt_bot")).status).toBe(200);
    expect(
      (
        await call(token, "/api/agents/agt_bot/tokens", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await call(token, "/api/agents/agt_bot", { method: "DELETE" })).status).toBe(403);
    for (const agentId of [undefined, "agt_bot"]) {
      const read = (await issueToken(env.DB, "acc_ann", "reader", "read", undefined, agentId))
        .secret;
      expect((await call(read, "/api/agents/agt_bot")).status).toBe(200);
      expect(
        (
          await call(read, "/api/agents/agt_bot/capabilities", {
            method: "PUT",
            body: JSON.stringify(profile),
          })
        ).status,
      ).toBe(403);
    }
    const unchanged = (await (await call(person, "/api/agents/agt_bot")).json()) as {
      agent: Agent;
    };
    expect(unchanged.agent.capabilities).toBeNull();
  });

  test("rejects malformed, oversized and out-of-contract profiles without replacing stored data", async () => {
    const { env, call, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'acc_ann')",
    );
    const person = (await issueToken(env.DB, "acc_ann", "owner", "write")).secret;
    const path = "/api/agents/agt_bot/capabilities";
    expect(
      (await call(person, path, { method: "PUT", body: JSON.stringify(profile) })).status,
    ).toBe(200);
    const invalid = [
      null,
      [],
      {},
      { ...profile, version: 2 },
      { ...profile, secret: "not allowed" },
      { ...profile, harness: "x".repeat(121) },
      { ...profile, model: 42 },
      { ...profile, tags: [""] },
      { ...profile, tags: ["x".repeat(65)] },
      { ...profile, tags: Array(65).fill("tag") },
      { ...profile, skills: Array(257).fill(profile.skills[0]) },
      ...[
        { name: "", description: "", source: "detected" },
        { name: "x".repeat(129), description: "", source: "detected" },
        { name: "skill", description: "x".repeat(513), source: "detected" },
        { name: "skill", description: "", source: "external" },
        { name: "skill", description: "", source: "detected", prompt: "private" },
      ].map((skill) => ({ ...profile, skills: [skill] })),
      ...[
        { os: "" },
        { arch: "x".repeat(65) },
        { runtime: "docker" },
        { cpuCount: 0 },
        { cpuCount: 65537 },
        { cpuCount: 1.5 },
        { memoryBytes: 0 },
        { memoryBytes: Number.MAX_SAFE_INTEGER + 1 },
        { hostname: "private" },
      ].map((environment) => ({
        ...profile,
        environment: { ...profile.environment, ...environment },
      })),
    ];
    for (const value of invalid) {
      expect(
        (await call(person, path, { method: "PUT", body: JSON.stringify(value) })).status,
      ).toBe(400);
    }
    expect((await call(person, path, { method: "PUT", body: "{" })).status).toBe(400);
    expect(
      (
        await call(person, path, {
          method: "PUT",
          body: JSON.stringify({ ...profile, harness: "x".repeat(256 * 1024) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(person, "/api/agents", {
          method: "POST",
          body: JSON.stringify({ name: "invalid", capabilities: { ...profile, version: 2 } }),
        })
      ).status,
    ).toBe(400);
    const stored = (await (await call(person, "/api/agents/agt_bot")).json()) as { agent: Agent };
    expect(stored.agent.capabilities).toEqual({ ...profile, tags: ["backend", "typescript"] });
    const boundary = {
      ...profile,
      harness: "h".repeat(120),
      model: "m".repeat(120),
      environment: {
        os: "o".repeat(64),
        arch: "a".repeat(64),
        runtime: "unknown",
        cpuCount: 65536,
        memoryBytes: Number.MAX_SAFE_INTEGER,
      },
      tags: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(64, "t")),
      skills: Array.from({ length: 256 }, (_, i) => ({
        name: `${i}`.padEnd(128, "s"),
        description: "d".repeat(512),
        source: "declared",
      })),
    };
    expect(
      (await call(person, path, { method: "PUT", body: JSON.stringify(boundary) })).status,
    ).toBe(200);
    const accepted = (await (await call(person, path.replace("/capabilities", ""))).json()) as {
      agent: Agent;
    };
    expect(accepted.agent.capabilities?.environment).toEqual(boundary.environment);
    expect(accepted.agent.capabilities?.skills).toEqual(
      boundary.skills.sort((a, b) => a.name.localeCompare(b.name)),
    );
  });
});
