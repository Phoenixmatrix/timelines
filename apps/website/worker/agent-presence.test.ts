import type { DatabaseSync } from "node:sqlite";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AgentPresenceTarget } from "../shared/agent-presence.ts";
import { noteAgentPresence, readAgentPresence } from "./agent-presence.ts";
import type { AppEnv } from "./auth.ts";
import type { Actor } from "./db.ts";
import { db } from "./schema.ts";
import { d1, migratedDatabase } from "./testing/d1.ts";

const target: AgentPresenceTarget = {
  kind: "commit",
  scopeId: "repo_one",
  resourceId: "a".repeat(40),
  sourceId: "canonical",
};
const instant = new Date("2026-10-09T12:00:00.000Z");
const person: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const agent: Actor = { ...person, agent: { id: "agent_one", name: "Builder" } };
const databases: DatabaseSync[] = [];

function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(
    "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann')",
  );
  sqlite.exec(
    "INSERT INTO agents (id, name, accountable_id) VALUES ('agent_one', 'Builder', 'ann')",
  );
  const binding = d1(sqlite);
  const pending: Promise<unknown>[] = [];
  const context = new Context<AppEnv>(new Request("https://example.invalid/resource"), {
    env: { DB: binding } as Env,
    executionCtx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
  });
  async function observe(actor: Actor | null = agent, resource = target) {
    context.set("actor", actor);
    noteAgentPresence(context, resource);
    await Promise.all(pending.splice(0));
  }
  return { sqlite, binding, context, pending, observe };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("recent agent presence", () => {
  test("uses background work, exposes only identity and timing, and expires at exactly ten minutes", async () => {
    const { binding, context, pending } = setup();
    context.set("actor", agent);
    noteAgentPresence(context, target);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await readAgentPresence(binding, target, instant)).toEqual({
      agents: [
        {
          id: "agent_one",
          name: "Builder",
          accountable: { slug: "ann", displayName: "Ann" },
          lastSeenAt: instant.toISOString(),
          expiresAt: "2026-10-09T12:10:00.000Z",
        },
      ],
      asOf: instant.toISOString(),
      windowSeconds: 600,
      truncated: false,
    });
    expect(
      (await readAgentPresence(binding, target, new Date(instant.getTime() + 599999))).agents,
    ).toHaveLength(1);
    expect(
      (await readAgentPresence(binding, target, new Date(instant.getTime() + 600000))).agents,
    ).toEqual([]);
    // Presence reads neither renew nor delete observations.
    expect(await db(binding).selectFrom("agent_presence").select("last_seen_at").execute()).toEqual(
      [{ last_seen_at: instant.toISOString() }],
    );
  });

  test("coalesces observations and an older finishing write cannot regress lastSeenAt", async () => {
    const { binding, observe } = setup();
    await observe();
    const newer = new Date(instant.getTime() + 5000);
    vi.setSystemTime(newer);
    await observe();
    vi.setSystemTime(new Date(instant.getTime() + 1000));
    await observe();
    const rows = await db(binding).selectFrom("agent_presence").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_seen_at).toBe(newer.toISOString());
    expect((await readAgentPresence(binding, target, newer)).agents[0]!.lastSeenAt).toBe(
      newer.toISOString(),
    );
  });

  test("never infers agents from a human or anonymous/job-only context", async () => {
    const { binding, observe, pending } = setup();
    await observe(person);
    await observe(null);
    expect(pending).toHaveLength(0);
    expect(await db(binding).selectFrom("agent_presence").selectAll().execute()).toEqual([]);
  });

  test("omits revoked identities immediately and refuses late writes for them", async () => {
    const { binding, observe } = setup();
    await observe();
    await db(binding)
      .updateTable("agents")
      .set({ revoked_at: instant.toISOString() })
      .where("id", "=", "agent_one")
      .execute();
    expect((await readAgentPresence(binding, target, instant)).agents).toEqual([]);
    vi.setSystemTime(new Date(instant.getTime() + 5000));
    await observe();
    await observe(agent, { ...target, resourceId: "another" });
    expect(await db(binding).selectFrom("agent_presence").select("last_seen_at").execute()).toEqual(
      [{ last_seen_at: instant.toISOString() }],
    );
  });

  test("isolates every target dimension including actual source and owner/repository scope", async () => {
    const { binding, observe } = setup();
    await observe();
    const others: AgentPresenceTarget[] = [
      { ...target, sourceId: "work_source" },
      { ...target, scopeId: "repo_two" },
      { ...target, resourceId: "b".repeat(40) },
      { ...target, kind: "timeline" },
    ];
    for (const other of others) {
      expect((await readAgentPresence(binding, other, instant)).agents).toEqual([]);
      await observe(agent, other);
      expect((await readAgentPresence(binding, other, instant)).agents).toHaveLength(1);
    }
    expect(await db(binding).selectFrom("agent_presence").select("id").execute()).toHaveLength(5);
    expect((await readAgentPresence(binding, target, instant)).agents).toHaveLength(1);
  });

  test("sorts newest then agent ID and caps results with accurate truncation", async () => {
    const { binding, observe } = setup();
    for (let i = 0; i < 31; i++) {
      const id = `agent_${String(i).padStart(2, "0")}`;
      await db(binding)
        .insertInto("agents")
        .values({ id, name: id, accountable_id: "ann", revoked_at: null })
        .execute();
      await observe({ ...person, agent: { id, name: id } });
    }
    vi.setSystemTime(new Date(instant.getTime() + 1000));
    await observe();
    const result = await readAgentPresence(binding, target);
    expect(result.agents).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(result.agents.map((a) => a.id)).toEqual([
      "agent_one",
      ...Array.from({ length: 29 }, (_, i) => `agent_${String(i).padStart(2, "0")}`),
    ]);
    await db(binding)
      .updateTable("agents")
      .set({ revoked_at: instant.toISOString() })
      .where("id", "in", ["agent_29", "agent_30"])
      .execute();
    const exact = await readAgentPresence(binding, target);
    expect(exact.agents).toHaveLength(30);
    expect(exact.truncated).toBe(false);
  });

  test("reclaims at most one hundred expired rows per observation without removing recent rows", async () => {
    const { binding, observe } = setup();
    for (let i = 0; i < 205; i++) {
      await db(binding)
        .insertInto("agent_presence")
        .values({
          target_kind: "commit",
          scope_id: "old_repo",
          resource_id: `old_${i}`,
          source_id: "old_source",
          agent_id: "agent_one",
          last_seen_at: new Date(instant.getTime() - 600000).toISOString(),
        })
        .execute();
    }
    await observe();
    expect(await db(binding).selectFrom("agent_presence").select("id").execute()).toHaveLength(106);
    expect((await readAgentPresence(binding, target, instant)).agents).toHaveLength(1);
    await observe();
    expect(await db(binding).selectFrom("agent_presence").select("id").execute()).toHaveLength(6);
    await observe();
    expect(await db(binding).selectFrom("agent_presence").select("id").execute()).toHaveLength(1);
  });

  test("contains auxiliary database failures and never logs exception contents", async () => {
    const { sqlite, observe } = setup();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    sqlite.exec("DROP TABLE agent_presence");
    await expect(observe()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledExactlyOnceWith("Recent agent presence could not be recorded.");
  });

  test("does not throw when background scheduling is unavailable", () => {
    const { binding } = setup();
    const context = new Context<AppEnv>(new Request("https://example.invalid/resource"), {
      env: { DB: binding } as Env,
    });
    context.set("actor", agent);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => noteAgentPresence(context, target)).not.toThrow();
    expect(warning).toHaveBeenCalledExactlyOnceWith("Recent agent presence could not be recorded.");
  });
});
