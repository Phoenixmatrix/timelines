// Current gateway logging policy keeps person and content overrides separate.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AI_LOG_COMPONENTS, aiLogComponentScope, type AiLogComponent } from "../shared/ai.ts";
import { aiGatewayOptions, componentOf, type GatewayComponent } from "./ai-gateway.ts";
import { decide } from "./knowledge/models.ts";
import { d1 } from "./testing/d1.ts";
import { installCutoverTestControl } from "./testing/space-cutover.ts";
import { initializeFreshSpaceInstallation } from "./space-cutover/installation.ts";
import { freshInstallationDatabases, seedSpaceFixture } from "./testing/spaces.ts";
import { aiWork } from "./usage/ai.ts";
import { issueToken } from "./api/tokens.ts";
import type { Actor } from "./db.ts";

const databases: DatabaseSync[] = [];
const controls: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of controls.splice(0)) close();
  for (const sqlite of databases.splice(0)) sqlite.close();
});
const HEADER = { "cf-aig-collect-log-payload": "false" };
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

async function setup(environment?: "on" | "off") {
  const fresh = await freshInstallationDatabases();
  const { sqlite, registry } = fresh;
  databases.push(sqlite, registry);
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    AI_GATEWAY: "gw",
    ...(environment ? { AI_LOG_BODIES: environment } : {}),
  } as unknown as Env;
  controls.push(installCutoverTestControl(env, fresh.control).close);
  await initializeFreshSpaceInstallation(env);
  sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name) VALUES
    ('same', 'user', 'ann', 'Ann'), ('other', 'user', 'bob', 'Bob');`);
  for (const id of ["same", "other"]) {
    await seedSpaceFixture(env.DB, {
      organization: { id: `org-${id}`, slug: `company-${id}`, displayName: id, kind: "company" },
      space: { id, slug: `space-${id}`, displayName: id },
      actorId: "same",
      members: [
        {
          accountId: "same",
          role: "owner",
          grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
        },
      ],
    });
  }
  sqlite.exec(`INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
    VALUES ('repo', 'same', 'app', 'private', 'n', 'https://app');`);
  const choose = (
    kind: "space" | "person" | "instance",
    id: string,
    component: string,
    keep: boolean | null,
  ) => {
    const table =
      kind === "space"
        ? "space_ai_log_bodies"
        : kind === "person"
          ? "account_ai_log_bodies"
          : "site_ai_log_bodies";
    const column = kind === "space" ? "space_id" : "account_id";
    const where = kind === "instance" ? "component = ?" : `${column} = ? AND component = ?`;
    const params = kind === "instance" ? [component] : [id, component];
    sqlite.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
    if (keep !== null) {
      const columns = kind === "instance" ? "component, keep" : `${column}, component, keep`;
      sqlite
        .prepare(
          `INSERT INTO ${table} (${columns}) VALUES (${[...params, keep].map(() => "?").join(", ")})`,
        )
        .run(...params, Number(keep));
    }
  };
  return { sqlite, env, choose };
}

describe("AI Gateway body logging", () => {
  test.each(["off", "on", undefined] as const)(
    "every component follows only its matching scope override with environment %s",
    async (environment) => {
      const { env, choose } = await setup(environment);
      for (const [label, setting] of COMPONENTS) {
        const kind = aiLogComponentScope(setting);
        for (const site of [null, true, false]) {
          for (const override of [null, true, false]) {
            choose("instance", "", setting, site);
            choose(kind, "same", setting, override);
            choose(kind, "other", setting, !(override ?? site ?? environment === "on"));
            const other = AI_LOG_COMPONENTS.find(
              (c) => c.id !== setting && aiLogComponentScope(c.id) === kind,
            )!.id;
            choose(kind, "same", other, !(override ?? site ?? environment === "on"));
            const fallback = site ?? environment === "on";
            for (const [id, keep] of [
              ["same", override ?? fallback],
              ["", fallback],
              [undefined, fallback],
            ] as const) {
              const scope = { kind: id ? kind : ("instance" as const), id: id ?? "" };
              const options = await aiGatewayOptions(
                env,
                label,
                id === undefined ? undefined : { scope, feature: "test" },
              );
              expect(options.gateway).toEqual({
                id: "gw",
                metadata:
                  id === undefined
                    ? { component: label }
                    : {
                        component: label,
                        scopeKind: scope.kind,
                        scopeId: scope.id,
                        feature: "test",
                      },
              });
              if (keep) expect(options).not.toHaveProperty("extraHeaders");
              else expect(options.extraHeaders).toEqual(HEADER);
            }
          }
        }
      }
    },
  );

  test("equal person and Space IDs cannot cross logging policies", async () => {
    const { env, choose } = await setup("off");
    choose("person", "same", "assistant", true);
    choose("space", "same", "knowledge", true);
    expect(
      await aiGatewayOptions(env, "assistant", { personId: "same", feature: "assistant" }),
    ).not.toHaveProperty("extraHeaders");
    expect(
      (await aiGatewayOptions(env, "assistant", { spaceId: "same", feature: "assistant" }))
        .extraHeaders,
    ).toEqual(HEADER);
    expect(
      await aiGatewayOptions(env, "knowledge", { spaceId: "same", feature: "knowledge" }),
    ).not.toHaveProperty("extraHeaders");
    expect(
      (await aiGatewayOptions(env, "knowledge", { personId: "same", feature: "knowledge" }))
        .extraHeaders,
    ).toEqual(HEADER);
  });

  test("Instance defaults work without D1 and failed policy reads drop bodies", async () => {
    expect((await aiGatewayOptions({ AI_GATEWAY: "gw" }, "assistant")).extraHeaders).toEqual(
      HEADER,
    );
    expect(
      await aiGatewayOptions({ AI_GATEWAY: "gw", AI_LOG_BODIES: "on" } as Env, "assistant"),
    ).not.toHaveProperty("extraHeaders");
    const { env, sqlite } = await setup("on");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sqlite.exec("DROP TABLE site_ai_log_bodies");
    expect((await aiGatewayOptions(env, "knowledge")).extraHeaders).toEqual(HEADER);
  });

  test("another isolate's disabled logging takes effect on the next warm call", async () => {
    const { env, sqlite, choose } = await setup("off");
    choose("space", "same", "knowledge", true);
    expect(
      await aiGatewayOptions(env, "knowledge", { spaceId: "same", feature: "x" }),
    ).not.toHaveProperty("extraHeaders");
    sqlite.exec(
      "UPDATE space_ai_log_bodies SET keep = 0 WHERE space_id = 'same' AND component = 'knowledge'",
    );
    expect(
      (await aiGatewayOptions(env, "knowledge", { spaceId: "same", feature: "x" })).extraHeaders,
    ).toEqual(HEADER);
  });

  test("personal aggregate usage follows its live explicit Space logging policy", async () => {
    const { env, sqlite, choose } = await setup("off");
    const token = await issueToken(env.DB, "same", "aggregate", "read");
    const actor: Actor = {
      id: "same",
      slug: "ann",
      displayName: "Ann",
      isSiteAdmin: false,
      credential: { kind: "token", id: token.id },
    };
    const work = {
      personId: "same",
      feature: "release_notes",
      providerAuthority: { spaceId: "other", actor },
    };
    choose("space", "other", "release-notes", true);
    const allowed = await aiGatewayOptions(env, "release-notes", work);
    expect(allowed).not.toHaveProperty("extraHeaders");
    expect(allowed.gateway.metadata).toEqual({
      component: "release-notes",
      scopeKind: "person",
      scopeId: "same",
      feature: "release_notes",
    });
    sqlite.exec("DELETE FROM space_grants WHERE space_id = 'other'");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await aiGatewayOptions(env, "release-notes", work)).extraHeaders).toEqual(HEADER);
    choose("person", "same", "assistant", true);
    expect(await aiGatewayOptions(env, "assistant", work)).not.toHaveProperty("extraHeaders");
  });

  test("model gateway metadata reconciles exact usage scope", async () => {
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
    const { env, choose } = await setup("off");
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
    choose("space", "same", "release-notes", true);
    await aiWork({ feature: "release_notes", repo: "repo" }, () => decide(env, {}, question));
    await aiWork({ feature: "knowledge", repo: "repo" }, () => decide(env, {}, question));
    choose("person", "same", "assistant", true);
    await aiWork({ feature: "assistant", personId: "same" }, () => decide(env, {}, question));
    // Each model call also carries its own attempt id (CORE-347).
    for (const call of calls)
      expect(((call.gateway?.metadata ?? {}) as { attempt?: unknown }).attempt).toEqual(
        expect.any(String),
      );
    expect(
      calls.map((c) => {
        const { attempt: _attempt, ...metadata } = (c.gateway?.metadata ?? {}) as Record<
          string,
          unknown
        >;
        return [metadata, c.extraHeaders ?? null];
      }),
    ).toEqual([
      [
        {
          component: "release-notes",
          scopeKind: "space",
          scopeId: "same",
          feature: "release_notes",
        },
        null,
      ],
      [
        { component: "knowledge", scopeKind: "space", scopeId: "same", feature: "knowledge" },
        HEADER,
      ],
      [
        { component: "assistant", scopeKind: "person", scopeId: "same", feature: "assistant" },
        null,
      ],
    ]);
  });
});
