// What AI Gateway logs keep (CORE-290): the payload header goes with a call
// exactly when "Keep AI request and response bodies in gateway logs" is off
// for its component and account (the account's override, else the site
// default, else the environment's default), and the settings are read at
// most once a minute, not per call.

import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AI_LOG_COMPONENTS, type AiLogComponent } from "../shared/ai.ts";
import {
  aiGatewayOptions,
  componentOf,
  forgetLogBodySettings,
  type GatewayComponent,
} from "./ai-gateway.ts";
import { decide } from "./knowledge/models.ts";
import { d1, migratedDatabase } from "./testing/d1.ts";
import { aiWork } from "./usage/ai.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

const HEADER = { "cf-aig-collect-log-payload": "false" };

/** Each label calls carry, and the setting it follows. */
const COMPONENTS: [GatewayComponent, AiLogComponent][] = [
  ["knowledge", "knowledge"],
  ["assistant", "assistant"],
  ["assistant-title", "assistant-titles"],
  ["assistant-status", "assistant-titles"],
  ["avatars", "avatars"],
  ["release-notes", "release-notes"],
  ["release-highlights", "release-notes"],
  ["release-notes-compose", "release-notes"],
  ["merge-queue", "merge-queue"],
];

function setup(environment?: "on" | "off") {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_a', 'user', 'ann', 'Ann'), ('acc_o', 'org', 'orbit', 'Orbit');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc_o', 'app', 'private', 'n', 'https://app');
  `);
  const env = {
    DB: d1(sqlite),
    AI_GATEWAY: "gw",
    ...(environment ? { AI_LOG_BODIES: environment } : {}),
  } as unknown as Env;
  const choose = (account: string | null, component: string, keep: boolean | null) => {
    if (account === null) {
      sqlite.prepare("DELETE FROM site_ai_log_bodies WHERE component = ?").run(component);
      if (keep !== null)
        sqlite
          .prepare("INSERT INTO site_ai_log_bodies (component, keep) VALUES (?, ?)")
          .run(component, Number(keep));
    } else {
      sqlite
        .prepare("DELETE FROM account_ai_log_bodies WHERE account_id = ? AND component = ?")
        .run(account, component);
      if (keep !== null)
        sqlite
          .prepare(
            "INSERT INTO account_ai_log_bodies (account_id, component, keep) VALUES (?, ?, ?)",
          )
          .run(account, component, Number(keep));
    }
    forgetLogBodySettings(env.DB);
  };
  return { sqlite, env, choose };
}

describe("AI Gateway body logging", () => {
  test("the header is sent exactly when the effective setting is off, for every component and level", async () => {
    let cases = 0;
    for (const environment of ["off", "on", undefined] as const) {
      const { env, choose } = setup(environment);
      for (const [label, setting] of COMPONENTS) {
        for (const site of [null, true, false]) {
          for (const override of [null, true, false]) {
            choose(null, setting, site);
            choose("acc_o", setting, override);
            // Another account's and another component's choices never leak in.
            choose("acc_a", setting, !(override ?? site ?? environment === "on"));
            const other = AI_LOG_COMPONENTS.find((c) => c.id !== setting)!.id;
            choose("acc_o", other, !(override ?? site ?? environment === "on"));
            const fallback = site ?? environment === "on";
            for (const [account, keep] of [
              ["acc_o", override ?? fallback],
              ["", fallback],
              [undefined, fallback],
            ] as const) {
              const options = await aiGatewayOptions(
                env,
                label,
                account === undefined ? undefined : { account, feature: "test" },
              );
              const why = `${label} env=${environment} site=${site} override=${override} account=${account}`;
              expect(options.gateway, why).toEqual({
                id: "gw",
                metadata:
                  account === undefined
                    ? { component: label }
                    : { component: label, account, feature: "test" },
              });
              if (keep) expect(options, why).not.toHaveProperty("extraHeaders");
              else expect(options.extraHeaders, why).toEqual(HEADER);
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(3 * COMPONENTS.length * 9 * 3);
  });

  test("production's default is off, development's on; no database or a failed read means off", async () => {
    expect((await aiGatewayOptions({ AI_GATEWAY: "gw" } as Env, "assistant")).extraHeaders).toEqual(
      HEADER,
    );
    expect(
      await aiGatewayOptions(
        { AI_GATEWAY: "gw", AI_LOG_BODIES: "on" } as unknown as Env,
        "assistant",
      ),
    ).not.toHaveProperty("extraHeaders");
    const { env, sqlite } = setup("on");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sqlite.exec("DROP TABLE site_ai_log_bodies");
    forgetLogBodySettings(env.DB);
    expect((await aiGatewayOptions(env, "knowledge")).extraHeaders).toEqual(HEADER);
  });

  test("settings are read once a minute per isolate, and at once after a change here", async () => {
    const { env, sqlite } = setup("off");
    const reads = vi.spyOn(env.DB, "prepare");
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 5; i++)
      await aiGatewayOptions(env, "knowledge", { account: "acc_o", feature: "x" });
    // One read of both tables, for every component and account.
    expect(reads).toHaveBeenCalledTimes(2);
    // A change made elsewhere (another isolate) is seen within the minute.
    sqlite.exec("INSERT INTO site_ai_log_bodies (component, keep) VALUES ('knowledge', 1)");
    now += 30_000;
    expect((await aiGatewayOptions(env, "knowledge")).extraHeaders).toEqual(HEADER);
    now += 30_000;
    expect(await aiGatewayOptions(env, "knowledge")).not.toHaveProperty("extraHeaders");
    expect(reads).toHaveBeenCalledTimes(4);
  });

  test("a model call's component and account come from the work it belongs to", async () => {
    expect(
      [
        "knowledge",
        "wiki",
        "knowledge_overlay",
        "search",
        "unattributed",
        "assistant",
        "release_notes",
        "release_highlights",
        "release_notes_compose",
        "merge_queue",
        "avatars",
      ].map(componentOf),
    ).toEqual([
      "knowledge",
      "knowledge",
      "knowledge",
      "knowledge",
      "knowledge",
      "assistant",
      "release-notes",
      "release-highlights",
      "release-notes-compose",
      "merge-queue",
      "avatars",
    ]);
    const { env, choose } = setup("off");
    const calls: AiOptions[] = [];
    Object.assign(env, {
      AI: {
        run: async (_model: string, _inputs: unknown, options: AiOptions) => {
          calls.push(options);
          return { answers: { same: { type: "noul", noul: 0.9 } } };
        },
      },
    });
    const question = { same: { type: "noul" as const, instructions: "Same?" } };
    // The repository's owner keeps release-note bodies; the site keeps none.
    choose("acc_o", "release-notes", true);
    await aiWork({ feature: "release_notes", repo: "repo" }, () => decide(env, {}, question));
    await aiWork({ feature: "knowledge", repo: "repo" }, () => decide(env, {}, question));
    // The site keeps Knowledge bodies; Orbit turns that off for its own.
    choose(null, "knowledge", true);
    await aiWork({ feature: "wiki", repo: "repo" }, () => decide(env, {}, question));
    await aiWork({ feature: "wiki", account: "acc_a" }, () => decide(env, {}, question));
    choose("acc_o", "knowledge", false);
    await aiWork({ feature: "wiki", repo: "repo" }, () => decide(env, {}, question));
    expect(calls.map((c) => [c.gateway?.metadata, c.extraHeaders ?? null] as const)).toMatchObject([
      [{ component: "release-notes", account: "acc_o", feature: "release_notes" }, null],
      [{ component: "knowledge", account: "acc_o", feature: "knowledge" }, HEADER],
      [{ component: "knowledge", account: "acc_o", feature: "wiki" }, null],
      [{ component: "knowledge", account: "acc_a", feature: "wiki" }, null],
      [{ component: "knowledge", account: "acc_o", feature: "wiki" }, HEADER],
    ]);
  });
});
