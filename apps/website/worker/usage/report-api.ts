// Usage and cost reports: explicit Space admin, personal self, or Instance operator.
// Every route supports ?format=csv with identical authorization.
import { Hono, type Context } from "hono";
import type { UsageReport } from "../../shared/usage.ts";
import { fail, requireActor } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { db } from "../schema.ts";
import { findSpaceBySlug, resolveSpaceAccess } from "../spaces/access.ts";
import { spaceUsageReport, personUsageReport, reportCsv, instanceUsageReport } from "./report.ts";

function respond(c: Context<AppEnv>, report: UsageReport, name: string) {
  if (c.req.query("format") !== "csv") return c.json<UsageReport>(report);
  return c.body(reportCsv(report), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}-usage-${report.asOf ?? "none"}.csv"`,
  });
}

export const spaceUsageApi = new Hono<AppEnv>();
spaceUsageApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space") ?? "");
  const access = space && (await resolveSpaceAccess(c.env.DB, actor, space.id));
  if (!access) return fail(c, 404, "Space not found.");
  if (access.grant.role !== "admin")
    return fail(c, 403, "Only Space administrators see its usage and costs.");
  return respond(c, await spaceUsageReport(c.env.DB, access.space), access.space.slug);
});

export const personUsageApi = new Hono<AppEnv>();
personUsageApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const person = await db(c.env.DB)
    .selectFrom("accounts")
    .select(["id", "slug", "display_name"])
    .where("id", "=", actor.id)
    .where("kind", "=", "user")
    .where("slug", "=", c.req.param("slug") ?? "")
    .executeTakeFirst();
  if (!person) return fail(c, 404, "Person not found.");
  return respond(
    c,
    await personUsageReport(c.env.DB, {
      id: person.id,
      slug: person.slug,
      displayName: person.display_name,
    }),
    person.slug,
  );
});

export const instanceUsageApi = new Hono<AppEnv>();
instanceUsageApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only Instance operators see Instance usage.");
  return respond(c, await instanceUsageReport(c.env.DB), "instance");
});
