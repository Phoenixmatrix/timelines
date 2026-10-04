// Assistant chat expiration through the engine (CORE-204), over D1 and the
// Durable Object registry (worker/durable/registry.ts `purgeIdleChat`, which
// records each purge in do_instances). The Agents SDK needs workerd, so each
// chat's object is a stand-in with the same purgeIfIdle contract: it holds a
// transcript, refuses while a turn is in progress, and is empty once purged.
// The real class is purged by the E2E scenario assistant-chats-expire.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { AssistantChat } from "../../../shared/assistant.ts";
import { assistant } from "../../api/assistant.ts";
import { issueToken } from "../../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../../auth.ts";
import { d1, migratedDatabase } from "../../testing/d1.ts";
import { forgetRecorded } from "../../durable/registry.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";

interface Chat {
  messages: number;
  busy: boolean;
  fail?: boolean;
  /** destroy() aborted the instance before the reply (the Agents SDK's next tick). */
  reset?: boolean;
}
const objects = new Map<string, Chat>();

vi.mock("agents", () => ({
  getAgentByName: async (_namespace: unknown, name: string) => ({
    async purgeIfIdle(reason: string) {
      const chat = objects.get(name) ?? { messages: 0, busy: false };
      if (chat.fail) throw new Error("object unavailable");
      if (chat.busy) return null;
      objects.set(name, { messages: 0, busy: false });
      if (chat.reset) throw Object.assign(new Error("destroyed"), { durableObjectReset: true });
      return {
        reason,
        purgedAt: new Date().toISOString(),
        bytes: 0,
        tables: [],
        keys: 0,
        alarm: null,
      };
    },
  }),
}));

const MARCO = { scope: "account", accountId: "acc_marco" } as const;
const DAY = 86_400_000;
const NOW = new Date("2026-10-04T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let env: Env;
beforeEach(() => {
  objects.clear();
  forgetRecorded();
  const sqlite = migratedDatabase();
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  env = { DB: d1(sqlite) } as unknown as Env;
});

async function chat(user: string, id: string, daysAgo: number, busy = false) {
  await env.DB.prepare(
    "INSERT INTO assistant_chats (id, user_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, ?)",
  )
    .bind(id, user, `Chat ${id}`, ago(daysAgo + 1), ago(daysAgo))
    .run();
  await env.DB.prepare(
    "INSERT INTO do_instances (class, name, account_id, created_at, last_active_at, storage_bytes) VALUES ('Assistant', ?, ?, ?, ?, 4096)",
  )
    .bind(`${user}:${id}`, user, ago(daysAgo + 1), ago(daysAgo))
    .run();
  objects.set(`${user}:${id}`, { messages: 12, busy });
}

async function chats(user = "acc_marco") {
  const { results } = await env.DB.prepare(
    "SELECT id, title, created_at FROM assistant_chats WHERE user_id = ? ORDER BY id",
  )
    .bind(user)
    .all<{ id: string; title: string; created_at: string }>();
  return results;
}

async function run(dryRun: boolean, thresholds = { days: 90, maxPerUser: 0 }) {
  const id = await createRun(env.DB, {
    target: MARCO,
    trigger: "manual",
    actorId: "acc_marco",
    dryRun,
    categories: [{ id: "assistant-chats", thresholds }],
    now: NOW,
  });
  const seen: string[] = [];
  let state;
  do
    state = await advanceRun(env, id, {
      now: NOW,
      limit: 2,
      afterBatch: async (_category, items) =>
        void seen.push(...(items as { id: string }[]).map((item) => item.id)),
    });
  while (state === "more");
  return { seen, run: (await getRun(env.DB, MARCO, id))! };
}

describe("assistant chat expiration", () => {
  test("purges inactive chats through the registry, dry run = run, then nothing", async () => {
    await chat("acc_marco", "chat-old-1", 200);
    await chat("acc_marco", "chat-old-2", 91);
    await chat("acc_marco", "chat-old-3", 120);
    await chat("acc_marco", "chat-recent", 89);
    await chat("acc_marco", "chat-today", 0);
    // Someone else's old chat: another account's policy.
    await chat("acc_jun", "chat-jun-old", 300);

    const dry = await run(true);
    expect(dry.seen).toEqual(["chat-old-1", "chat-old-2", "chat-old-3"]);
    expect(dry.run).toMatchObject({ status: "succeeded", items: 3 });
    expect(dry.run.bytes).toBeGreaterThan(3 * 4096);
    expect(objects.get("acc_marco:chat-old-1")?.messages).toBe(12);

    const real = await run(false);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ status: "succeeded", items: 3, bytes: dry.run.bytes });
    expect((await chats()).map((c) => c.id)).toEqual(["chat-recent", "chat-today"]);
    for (const id of dry.seen) expect(objects.get(`acc_marco:${id}`)?.messages).toBe(0);
    expect(objects.get("acc_marco:chat-recent")?.messages).toBe(12);
    expect(objects.get("acc_jun:chat-jun-old")?.messages).toBe(12);
    expect((await chats("acc_jun")).map((c) => c.id)).toEqual(["chat-jun-old"]);
    // The registry records each purge.
    const { results } = await env.DB.prepare(
      "SELECT name, purge_reason FROM do_instances WHERE class = 'Assistant' AND purged_at IS NOT NULL ORDER BY name",
    ).all<{ name: string; purge_reason: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "acc_marco:chat-old-1",
      "acc_marco:chat-old-2",
      "acc_marco:chat-old-3",
    ]);
    expect(results[0]!.purge_reason).toMatch(/^retention: /);

    expect((await run(false)).run).toMatchObject({ items: 0, bytes: 0 });
  });

  test("a chat being written to is never deleted, and its row stays as it was", async () => {
    await chat("acc_marco", "chat-busy", 200, true);
    await chat("acc_marco", "chat-idle", 200);
    const before = (await chats()).find((c) => c.id === "chat-busy");
    const real = await run(false);
    expect(real.seen).toEqual(["chat-busy", "chat-idle"]);
    expect(real.run).toMatchObject({ status: "succeeded", items: 1 });
    expect(await chats()).toEqual([before]);
    expect(objects.get("acc_marco:chat-busy")?.messages).toBe(12);
    // Once the turn is over, the next run takes it.
    objects.get("acc_marco:chat-busy")!.busy = false;
    expect((await run(false)).run).toMatchObject({ items: 1 });
    expect(await chats()).toEqual([]);
  });

  test("a chat used again after selection stays", async () => {
    await chat("acc_marco", "chat-back", 200);
    const dry = await run(true);
    expect(dry.seen).toEqual(["chat-back"]);
    // A turn touches the row (and the object) before the run reaches it.
    await env.DB.prepare("UPDATE assistant_chats SET updated_at = ? WHERE id = 'chat-back'")
      .bind(NOW.toISOString())
      .run();
    expect((await run(false)).run).toMatchObject({ items: 0 });
    expect((await chats()).map((c) => c.id)).toEqual(["chat-back"]);
    expect(objects.get("acc_marco:chat-back")?.messages).toBe(12);
  });

  test("the per-person cap keeps the newest chats", async () => {
    for (const [id, days] of [
      ["chat-a", 1],
      ["chat-b", 2],
      ["chat-c", 3],
      ["chat-d", 4],
      ["chat-e", 100],
    ] as const)
      await chat("acc_marco", id, days);
    const thresholds = { days: 90, maxPerUser: 2 };
    const dry = await run(true, thresholds);
    expect(dry.seen).toEqual(["chat-c", "chat-d", "chat-e"]);
    const real = await run(false, thresholds);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ items: 3 });
    expect((await chats()).map((c) => c.id)).toEqual(["chat-a", "chat-b"]);
    expect((await run(false, thresholds)).run).toMatchObject({ items: 0 });
  });

  test("an unreachable object fails the run and keeps the chats it didn't purge", async () => {
    await chat("acc_marco", "chat-1", 200);
    objects.get("acc_marco:chat-1")!.fail = true;
    await chat("acc_marco", "chat-2", 200);
    const failed = await run(false);
    expect(failed.run.status).toBe("failed");
    expect((await chats()).map((c) => c.id)).toEqual(["chat-1", "chat-2"]);
    objects.get("acc_marco:chat-1")!.fail = false;
    expect((await run(false)).run).toMatchObject({ status: "succeeded", items: 2 });
    expect(await chats()).toEqual([]);
  });

  test("the chat list says when each chat expires once the policy is on", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      const credential = await tokenCredential(c);
      c.set("actor", credential.kind === "token" ? credential.actor : null);
      return next();
    });
    app.route("/api/assistant", assistant);
    const { secret } = await issueToken(env.DB, "acc_marco", "t", "read");
    const list = async () => {
      const response = await app.request(
        "/api/assistant/chats",
        { headers: { authorization: `Bearer ${secret}` } },
        env,
      );
      return ((await response.json()) as { chats: AssistantChat[] }).chats;
    };
    const updated = new Date(Date.now() - 10 * DAY).toISOString();
    for (const [id, at] of [
      ["chat-new", new Date().toISOString()],
      ["chat-older", updated],
    ])
      await env.DB.prepare(
        "INSERT INTO assistant_chats (id, user_id, title, updated_at) VALUES (?, 'acc_marco', ?, ?)",
      )
        .bind(id, id, at)
        .run();
    expect((await list()).map((c) => c.expiresAt)).toEqual([null, null]);
    await env.DB.prepare(
      `INSERT INTO retention_policies (account_id, category, enabled, thresholds)
       VALUES ('acc_marco', 'assistant-chats', 1, '{"days": 30, "maxPerUser": 1}')`,
    ).run();
    const [fresh, older] = await list();
    expect(fresh!.expiresAt).toBe(new Date(Date.parse(fresh!.updatedAt) + 30 * DAY).toISOString());
    // Over the cap: the next cleanup.
    expect(Date.parse(older!.expiresAt!)).toBeLessThanOrEqual(Date.now());
  });

  test("an instance aborted by its own destroy() counts as purged", async () => {
    await chat("acc_marco", "chat-reset", 200);
    objects.get("acc_marco:chat-reset")!.reset = true;
    expect((await run(false)).run).toMatchObject({ status: "succeeded", items: 1 });
    expect(await chats()).toEqual([]);
    expect(objects.get("acc_marco:chat-reset")?.messages).toBe(0);
  });
});
