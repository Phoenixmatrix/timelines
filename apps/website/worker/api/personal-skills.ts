import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import {
  personalSkill,
  personalSkills,
  validatePersonalSkill,
} from "../assistant/personal-skills.ts";
import { BUILTIN } from "../assistant/skills.ts";
import { db, nowIso } from "../schema.ts";
import { fail, requirePerson } from "./http.ts";

export const personalSkillsApi = new Hono<AppEnv>();

personalSkillsApi.get("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  return c.json({ skills: await personalSkills(c.env.DB, actor.id) });
});

personalSkillsApi.on(["POST", "PUT"], ["/", "/:id"], async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const updating = c.req.method === "PUT";
  const id = c.req.param("id");
  if (updating !== Boolean(id)) return fail(c, 404, "No such skill.");
  const database = db(c.env.DB);
  if (updating) {
    const existing = await database
      .selectFrom("assistant_personal_skills")
      .select("id")
      .where("id", "=", id!)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (!existing) return fail(c, 404, "No such skill.");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Skill must be valid JSON.");
  }
  const input = validatePersonalSkill(body);
  if (typeof input === "string") return fail(c, 400, input);
  if (BUILTIN.some((skill) => skill.name === input.name))
    return fail(c, 409, "That name is reserved for a built-in skill.");
  const values = {
    name: input.name,
    description: input.description,
    body: input.body,
    enabled: Number(input.enabled),
    updated_at: nowIso(),
  };
  try {
    const row = updating
      ? await database
          .updateTable("assistant_personal_skills")
          .set(values)
          .where("id", "=", id!)
          .where("user_id", "=", actor.id)
          .returningAll()
          .executeTakeFirst()
      : await database
          .insertInto("assistant_personal_skills")
          .values({ ...values, id: crypto.randomUUID(), user_id: actor.id })
          .returningAll()
          .executeTakeFirst();
    if (!row) return fail(c, 404, "No such skill.");
    return c.json({ skill: personalSkill(row) }, updating ? 200 : 201);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: assistant_personal_skills\.user_id, assistant_personal_skills\.name/.test(
        error.message,
      )
    )
      return fail(c, 409, "You already have a skill with that name.");
    throw error;
  }
});

personalSkillsApi.delete("/:id", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const row = await db(c.env.DB)
    .deleteFrom("assistant_personal_skills")
    .where("id", "=", c.req.param("id"))
    .where("user_id", "=", actor.id)
    .returning("id")
    .executeTakeFirst();
  if (!row) return fail(c, 404, "No such skill.");
  return c.body(null, 204);
});
