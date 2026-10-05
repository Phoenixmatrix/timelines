import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { PersonalAssistantSkill } from "../../shared/assistant-skills.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import {
  buildSkillRegistry,
  parseSkill,
  resolveSkillInvocation,
  skillReceipt,
  type Skill,
} from "../assistant/skills.ts";
import type { CallApi } from "../assistant/internal.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { issueToken } from "./tokens.ts";
import { personalSkillsApi } from "./personal-skills.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name) VALUES
    ('owner', 'user', 'ann', 'Ann'), ('other', 'user', 'bob', 'Bob');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'builder', 'owner');`);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/account/skills", personalSkillsApi);
  const owner = (await issueToken(env.DB, "owner", "owner", "write")).secret;
  const other = (await issueToken(env.DB, "other", "other", "write")).secret;
  const agent = (await issueToken(env.DB, "owner", "agent", "write", undefined, "agent")).secret;
  const call = (token: string | null, method = "GET", body?: unknown, id = "") =>
    app.request(
      `/api/account/skills${id ? `/${id}` : ""}`,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { sqlite, env, owner, other, agent, call };
}

const input = { name: "review", description: "", body: "Review carefully.", enabled: true };
const deniedApi: CallApi = async () => ({ ok: false, status: 403, body: {} });

// This emulates only repository transport; catalog parsing/merging/storage are real.
const repositoryApi: CallApi = async (_method, path) =>
  path.includes("/tree?")
    ? {
        ok: true,
        status: 200,
        body: {
          entries: ["review", "tracker", "repo-only"].map((name) => ({
            path: `.agents/skills/${name}`,
            type: "tree",
          })),
        },
      }
    : {
        ok: true,
        status: 200,
        body: {
          text: `---\nname: ${decodeURIComponent(path).split("/skills/")[1]!.split("/")[0]}\n---\nRepository instructions`,
        },
      };

describe("personal assistant skills", () => {
  test("persists CRUD, isolates owners, forbids agent mutations, and cascades with the owner", async () => {
    const t = await setup();
    expect((await t.call(null)).status).toBe(401);
    const created = await t.call(t.owner, "POST", input);
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: PersonalAssistantSkill };
    expect(skill).toMatchObject(input);
    expect(skill.id).toMatch(/^[\da-f-]{36}$/);
    expect(skill.createdAt).toBeTruthy();
    expect(await (await t.call(t.other)).json()).toEqual({ skills: [] });
    for (const method of ["PUT", "DELETE"])
      expect(
        (await t.call(t.other, method, method === "PUT" ? input : undefined, skill.id)).status,
      ).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"])
      expect(
        (
          await t.call(
            t.agent,
            method,
            method === "DELETE" ? undefined : input,
            method === "POST" ? "" : skill.id,
          )
        ).status,
      ).toBe(403);
    const updated = await t.call(
      t.owner,
      "PUT",
      { ...input, body: "Changed", enabled: false },
      skill.id,
    );
    expect(await updated.json()).toMatchObject({
      skill: { id: skill.id, body: "Changed", enabled: false },
    });
    expect((await t.call(t.owner, "DELETE", undefined, skill.id)).status).toBe(204);
    expect((await t.call(t.owner, "DELETE", undefined, skill.id)).status).toBe(404);
    await t.call(t.owner, "POST", input);
    t.sqlite.exec("DELETE FROM accounts WHERE id = 'owner'");
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM assistant_personal_skills").get(),
    ).toMatchObject({ n: 0 });
  });

  test("validates complete inputs, duplicates and builtin reservations, including renames", async () => {
    const t = await setup();
    for (const body of [
      null,
      [],
      { ...input, name: "Upper" },
      { ...input, name: "a/b" },
      { ...input, name: "a".repeat(65) },
      { ...input, body: "  " },
      { ...input, body: "a".repeat(20001) },
      { ...input, description: "a".repeat(501) },
      { ...input, enabled: "yes" },
      { ...input, user_id: "other" },
    ])
      expect((await t.call(t.owner, "POST", body)).status).toBe(400);
    expect((await t.call(t.owner, "POST", { ...input, name: "tracker" })).status).toBe(409);
    const { skill } = (await (
      await t.call(t.owner, "POST", { name: "review", body: "Instructions" })
    ).json()) as { skill: PersonalAssistantSkill };
    expect(skill).toMatchObject({ description: "", enabled: true });
    expect((await t.call(t.owner, "POST", input)).status).toBe(409);
    expect((await t.call(t.other, "POST", input)).status).toBe(201);
    const second = (await (await t.call(t.owner, "POST", { ...input, name: "second" })).json()) as {
      skill: PersonalAssistantSkill;
    };
    expect((await t.call(t.owner, "PUT", input, second.skill.id)).status).toBe(409);
    expect((await t.call(t.owner, "PUT", { ...input, name: "tracker" }, skill.id)).status).toBe(
      409,
    );
  });

  test("merges builtin then enabled owner then readable repo without bodies in summaries", async () => {
    const t = await setup();
    await t.call(t.owner, "POST", input);
    await t.call(t.owner, "POST", { ...input, name: "disabled", enabled: false });
    const registry = await buildSkillRegistry(t.env.DB, "owner", repositoryApi, "ann/app");
    expect(registry.get("tracker")?.source).toBe("builtin");
    expect(registry.get("review")?.source).toBe("personal");
    expect(registry.get("repo-only")).toMatchObject({
      source: "repository",
      description: "",
      repo: "ann/app",
    });
    expect(registry.get("disabled")).toBeNull();
    expect(registry.summaries().every((skill) => !("body" in skill))).toBe(true);
    const other = await buildSkillRegistry(t.env.DB, "other", deniedApi, "ann/private");
    expect(other.get("review")).toBeNull();
    expect(other.get("repo-only")).toBeNull();
    expect(parseSkill("---\nname: empty\ndescription:\nother: field\n---\nBody")).toEqual({
      name: "empty",
      description: "",
      body: "Body",
    });
  });

  test("resolves only exact leading commands; continuations restore identity and new turns do not inherit", async () => {
    const t = await setup();
    const { skill } = (await (await t.call(t.owner, "POST", input)).json()) as {
      skill: PersonalAssistantSkill;
    };
    const registry = await buildSkillRegistry(t.env.DB, "owner", repositoryApi, "ann/app");
    for (const text of ["/review", "/review arguments", "/review\narguments"])
      expect(resolveSkillInvocation(registry, text, false, null)?.id).toBe(skill.id);
    for (const text of [
      "/review-more",
      "/review!",
      "/Review",
      " /review",
      "hello /review",
      "/unknown",
    ])
      expect(resolveSkillInvocation(registry, text, false, null)).toBeNull();
    const invocation = registry.get("review")!;
    const receipt = skillReceipt({
      id: "reply",
      role: "assistant",
      parts: [
        {
          type: "data-skill",
          data: {
            id: invocation.id,
            name: invocation.name,
            description: invocation.description,
            source: invocation.source,
          },
        },
      ],
    });
    expect(resolveSkillInvocation(registry, "/review", true, receipt)?.id).toBe(skill.id);
    expect(resolveSkillInvocation(registry, "next question", false, receipt)).toBeNull();
    expect(resolveSkillInvocation(registry, "/review", true, null)).toBeNull();
    await t.call(t.owner, "PUT", { ...input, enabled: false }, skill.id);
    const disabled = await buildSkillRegistry(t.env.DB, "owner", repositoryApi, "ann/app");
    expect(resolveSkillInvocation(disabled, "/review", true, receipt)).toBeNull();
    const oldRepo = registry.get("repo-only") as Skill;
    const moved = await buildSkillRegistry(t.env.DB, "owner", repositoryApi, "ann/elsewhere");
    expect(resolveSkillInvocation(moved, "/repo-only", true, oldRepo)).toBeNull();
  });
});
