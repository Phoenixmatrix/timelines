import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { fail, readJson } from "./http.ts";
import {
  SOURCE_PUSH_FIXTURE_POINTS,
  sourcePushFixtureEnabled,
} from "../git/source-push-fixture.ts";

/** Mounted only behind /api/dev's named-agent secret allowlist. */
export async function sourcePushFixtures(c: Context<AppEnv>) {
  if (!sourcePushFixtureEnabled(c.env)) return fail(c, 404, "Not found.");
  const input = await readJson<{
    sourceId: string;
    action: "arm" | "inspect" | "release" | "delete";
    point?: string;
    mode?: "hold" | "fail";
  }>(c);
  if (
    !input ||
    typeof input.sourceId !== "string" ||
    !/^work_[a-f0-9-]{36}$/.test(input.sourceId) ||
    typeof input.action !== "string" ||
    !["arm", "inspect", "release", "delete"].includes(input.action)
  )
    return fail(c, 400, "Invalid source push fixture.");
  const source = await c.env.DB.prepare(
    "SELECT s.repo_id,s.timeline_slug,s.state,r.name FROM timeline_work_sources s JOIN repos r ON r.id=s.repo_id WHERE s.source_id=? AND r.space_id='acc_orbit' AND r.deleted_at IS NULL",
  )
    .bind(input.sourceId)
    .first<{ repo_id: string; timeline_slug: string; state: string; name: string }>();
  if (!source) return fail(c, 404, "Fixture source not found.");
  if (
    !/^queue-[a-f0-9]{8}$/.test(source.name) ||
    !/^source-recovery-[a-f0-9]{8}-[a-z-]{1,32}$/.test(source.timeline_slug)
  )
    return fail(c, 400, "Only disposable source recovery fixtures are allowed.");
  await c.env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS dev_source_push_barriers (source_id TEXT PRIMARY KEY,repo_id TEXT NOT NULL,point TEXT NOT NULL,mode TEXT NOT NULL,nonce TEXT NOT NULL,hit INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0,operation_id TEXT)",
  ).run();
  if (input.action === "arm") {
    if (
      source.state !== "ready" ||
      !SOURCE_PUSH_FIXTURE_POINTS.some((point) => point === input.point) ||
      (input.mode !== "hold" && input.mode !== "fail")
    )
      return fail(c, 400, "Invalid source push boundary or mode.");
    await c.env.DB.prepare(
      "INSERT INTO dev_source_push_barriers(source_id,repo_id,point,mode,nonce) VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET repo_id=excluded.repo_id,point=excluded.point,mode=excluded.mode,nonce=excluded.nonce,hit=0,released=0,operation_id=NULL",
    )
      .bind(input.sourceId, source.repo_id, input.point!, input.mode, crypto.randomUUID())
      .run();
  } else if (input.action === "release") {
    await c.env.DB.prepare("UPDATE dev_source_push_barriers SET released=1 WHERE source_id=?")
      .bind(input.sourceId)
      .run();
  } else if (input.action === "delete") {
    await c.env.DB.prepare("DELETE FROM dev_source_push_barriers WHERE source_id=?")
      .bind(input.sourceId)
      .run();
  }
  const barrier = await c.env.DB.prepare(
    "SELECT point,mode,hit,released,operation_id AS operationId FROM dev_source_push_barriers WHERE source_id=?",
  )
    .bind(input.sourceId)
    .first();
  return c.json({ barrier });
}
