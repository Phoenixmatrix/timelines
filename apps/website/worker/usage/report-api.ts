// The usage and cost report's API (CORE-209):
//
//   GET /api/accounts/:slug/usage   the account's report (its administrators:
//                                   org owners, the user themselves, site
//                                   administrators); `?format=csv` for CSV
//   GET /api/admin/usage            the site's report with every account's
//                                   total (site administrators); `?format=csv`
//
// Members who aren't administrators get 403, everyone else 404 (an account's
// existence isn't confirmed to outsiders).

import { Hono, type Context } from "hono";
import type { UsageReport } from "../../shared/usage.ts";
import { fail, requireActor } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { load } from "../deployments/settings.ts";
import { accountUsageReport, reportCsv, siteUsageReport } from "./report.ts";

function respond(c: Context<AppEnv>, report: UsageReport, name: string) {
  if (c.req.query("format") !== "csv") return c.json<UsageReport>(report);
  return c.body(reportCsv(report), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}-usage-${report.asOf ?? "none"}.csv"`,
  });
}

export const accountUsageApi = new Hono<AppEnv>();

accountUsageApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(c, 403, "Only the account's administrators see its usage and costs.");
  const report = await accountUsageReport(c.env.DB, found.account);
  return respond(c, report, found.account.slug);
});

export const siteUsageApi = new Hono<AppEnv>();

siteUsageApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators see the site's usage.");
  return respond(c, await siteUsageReport(c.env.DB), "site");
});
