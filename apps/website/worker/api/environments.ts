import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { fail, requireActor, requirePerson } from "./http.ts";

const MAXIMUM = 2147483647;
const TTL = 24 * 60 * 60 * 1000;
const ID = /^(?:gma-[a-z0-9]{8,10}-[a-f0-9]{12}|gmr-[a-f0-9]{24})$/;

export const environments = new Hono<AppEnv>();
export const environmentSettings = new Hono<AppEnv>();

async function limits(database: D1Database) {
  const row = await database
    .prepare(
      "SELECT maximum, updated_at AS updatedAt, updated_by AS updatedBy, (SELECT count(*) FROM environment_reservations) AS used FROM environment_limits WHERE id = 1",
    )
    .first<{ maximum: number; used: number; updatedAt: string | null; updatedBy: string | null }>();
  if (!row) throw new Error("Environment quota schema is unavailable; refusing admission.");
  return row;
}

environmentSettings.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin)
    return fail(c, 403, "Only site administrators manage environment limits.");
  return c.json({ ...(await limits(c.env.DB)), scope: "installation", canManage: !actor.agent });
});

environmentSettings.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin)
    return fail(c, 403, "Only site administrators manage environment limits.");
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "maximum") ||
    !("maximum" in body) ||
    typeof body.maximum !== "number" ||
    !Number.isInteger(body.maximum) ||
    body.maximum < 0 ||
    body.maximum > MAXIMUM
  )
    return fail(c, 400, `maximum must be an integer from 0 to ${MAXIMUM}.`);
  await c.env.DB.prepare(
    "UPDATE environment_limits SET maximum = ?, updated_at = ?, updated_by = ? WHERE id = 1",
  )
    .bind(body.maximum, new Date().toISOString(), actor.id)
    .run();
  // Lowering a limit never destroys someone else's running environment.
  return c.json({ ...(await limits(c.env.DB)), scope: "installation", canManage: true });
});

environments.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const reservations = await c.env.DB.prepare(
    "SELECT id, cloud_account AS account, backend, expires, created_at AS createdAt FROM environment_reservations WHERE owner_id = ? ORDER BY created_at",
  )
    .bind(actor.id)
    .all();
  return c.json({
    ...(await limits(c.env.DB)),
    scope: "installation",
    reservations: reservations.results,
  });
});

environments.post("/reservations", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["id", "account", "backend", "expires"].includes(key)) ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    !ID.test(body.id) ||
    !("account" in body) ||
    typeof body.account !== "string" ||
    !/^[a-f0-9]{32}$/.test(body.account) ||
    !("backend" in body) ||
    typeof body.backend !== "string" ||
    !["local", "remote"].includes(body.backend) ||
    (body.id.startsWith("gmr-") && body.backend !== "remote") ||
    !("expires" in body) ||
    typeof body.expires !== "number" ||
    !Number.isSafeInteger(body.expires) ||
    body.expires > Date.now() + TTL ||
    body.expires <= 0
  )
    return fail(
      c,
      400,
      "Provide an owned environment id, Cloudflare account, local/remote backend and expiry (maximum 24 hours).",
    );
  // One SQLite write statement is the admission decision. Never count then insert
  // in separate requests: concurrent hosts must compete for the very same slots.
  await c.env.DB.prepare(`
    INSERT INTO environment_reservations (id, owner_id, cloud_account, backend, expires)
    SELECT ?, ?, ?, ?, ? FROM environment_limits
    WHERE id = 1 AND (SELECT count(*) FROM environment_reservations) < maximum
    ON CONFLICT(id) DO NOTHING
  `)
    .bind(body.id, actor.id, body.account, body.backend, body.expires)
    .run();
  const reservation = await c.env.DB.prepare(
    "SELECT owner_id, cloud_account, backend, expires FROM environment_reservations WHERE id = ?",
  )
    .bind(body.id)
    .first<{ owner_id: string; cloud_account: string; backend: string; expires: number }>();
  if (reservation) {
    if (
      reservation.owner_id !== actor.id ||
      reservation.cloud_account !== body.account ||
      reservation.backend !== body.backend ||
      reservation.expires !== body.expires
    )
      return fail(c, 409, "Environment reservation belongs to a different owner or configuration.");
    return c.json({ reserved: true, id: body.id });
  }
  const current = await limits(c.env.DB);
  return fail(
    c,
    409,
    `Installation environment limit reached (${current.used}/${current.maximum}). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.`,
  );
});

environments.delete("/reservations/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  if (!ID.test(id)) return fail(c, 400, "Invalid environment id.");
  const reservation = await c.env.DB.prepare(
    "SELECT owner_id FROM environment_reservations WHERE id = ?",
  )
    .bind(id)
    .first<{ owner_id: string }>();
  if (reservation && reservation.owner_id !== actor.id)
    return fail(
      c,
      403,
      "Only the environment's owning person or their agents can release its reservation.",
    );
  // Called only after the owning lifecycle has removed its active resources.
  // No clock-based deletion: an unreachable host must not free live cloud capacity.
  await c.env.DB.prepare("DELETE FROM environment_reservations WHERE id = ? AND owner_id = ?")
    .bind(id, actor.id)
    .run();
  return c.json({ released: true, id });
});
