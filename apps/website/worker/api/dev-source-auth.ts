import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { findSpaceBySlug } from "../spaces/access.ts";
import { db } from "../schema.ts";
import { fail, readJson } from "./http.ts";

/** Identity-only fault fixture; does not transfer Tracker authority or provider resources. */
export async function sourceAuthFixture(c: Context<AppEnv>) {
  const agentId = Reflect.get(c.env, "AGENT_ID");
  if (Reflect.get(c.env, "DEV_MODE") !== "true" || typeof agentId !== "string" || !agentId.trim())
    return fail(c, 404, "Not found.");
  const body = await readJson<{ repo: string; space: string; name: string }>(c);
  const fixtureName = /^source-auth-[a-f0-9]{8}-(?:private|public)(?:-renamed)?$/;
  if (
    typeof body.repo !== "string" ||
    typeof body.name !== "string" ||
    typeof body.space !== "string"
  )
    return fail(c, 400, "An isolated source-auth identity is required.");
  const parts = body.repo.split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !["sam", "marco"].includes(owner ?? "") ||
    !["sam", "marco"].includes(body.space) ||
    !fixtureName.test(name ?? "") ||
    !fixtureName.test(body.name) ||
    name?.replace(/-renamed$/, "") !== body.name.replace(/-renamed$/, "")
  )
    return fail(c, 400, "Only the same isolated source-auth fixture may change identity.");
  const from = await findSpaceBySlug(c.env.DB, owner!);
  const to = await findSpaceBySlug(c.env.DB, body.space);
  if (!from || !to) return fail(c, 404, "No fixture Space.");
  const store = db(c.env.DB);
  const repo = await store
    .selectFrom("repos")
    .select("id")
    .where("space_id", "=", from.id)
    .where("name", "=", name!)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) return fail(c, 404, "No live fixture repository.");
  const updated = await store
    .updateTable("repos")
    .set({ space_id: to.id, name: body.name })
    .where("id", "=", repo.id)
    .where("space_id", "=", from.id)
    .where("name", "=", name!)
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!updated) return fail(c, 409, "Fixture identity changed concurrently.");
  return c.json({ repoId: updated.id, space: body.space, name: body.name });
}
