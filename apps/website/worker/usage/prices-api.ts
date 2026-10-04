// The price catalog's API (CORE-208), under /api/admin/prices:
//
//   GET    /                    the catalog in effect today, scheduled prices and any pending refresh
//                                (anyone signed in: these are Cloudflare's public prices)
//   GET    /history?product=&metric=   every version of one metric (site admins)
//   GET    /changes             recent refreshes, checks and edits, newest first (site admins)
//   GET    /changes/:id         one of them, with its diff (site admins)
//   POST   /refresh             fetch and parse the pricing pages; records a pending diff (site admins)
//   POST   /changes/:id/apply   apply a pending refresh (site admins)
//   POST   /changes/:id/discard (site admins)
//   POST   /edits               PriceEdit: set one metric's price by hand, with a note (site admins)

import { Hono, type Context } from "hono";
import type { PriceCatalog, PriceChangeSummary, PriceEdit } from "../../shared/usage.ts";
import { fail, readJson, requireActor } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import {
  applyChange,
  discardChange,
  editPrice,
  getChange,
  listChanges,
  loadCatalog,
  priceHistory,
  refreshCatalog,
  type ApplyResult,
} from "./prices.ts";

export const pricesApi = new Hono<AppEnv>();

function siteAdmin(c: Context<AppEnv>): Actor | Response {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  return actor.isSiteAdmin
    ? actor
    : fail(c, 403, "Only site administrators manage the price catalog.");
}

function decided(c: Context<AppEnv>, result: ApplyResult | { status: "invalid"; message: string }) {
  switch (result.status) {
    case "applied":
      return c.json<PriceChangeSummary>(result.change);
    case "not_found":
      return fail(c, 404, result.message);
    case "invalid":
      return fail(c, 400, result.message);
    default:
      return fail(c, 409, result.message);
  }
}

const changeId = (c: Context<AppEnv>) => {
  const id = Number(c.req.param("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

pricesApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  return c.json<PriceCatalog>(await loadCatalog(c.env.DB));
});

pricesApi.get("/history", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const product = c.req.query("product") ?? "";
  const metric = c.req.query("metric") ?? "";
  const prices = await priceHistory(c.env.DB, product, metric);
  if (!prices.length) return fail(c, 404, "No such price.");
  return c.json({ prices });
});

pricesApi.get("/changes", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ changes: await listChanges(c.env.DB, Number.isFinite(limit) ? limit : 50) });
});

pricesApi.get("/changes/:id", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const id = changeId(c);
  const change = id ? await getChange(c.env.DB, id) : null;
  return change ? c.json<PriceChangeSummary>(change) : fail(c, 404, "No such change.");
});

pricesApi.post("/refresh", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  return c.json<PriceChangeSummary>(
    await refreshCatalog(c.env.DB, { actorId: actor.id, kind: "refresh" }),
    201,
  );
});

pricesApi.post("/changes/:id/apply", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const id = changeId(c);
  if (!id) return fail(c, 404, "No such change.");
  return decided(c, await applyChange(c.env.DB, id, actor.id));
});

pricesApi.post("/changes/:id/discard", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const id = changeId(c);
  if (!id) return fail(c, 404, "No such change.");
  return decided(c, await discardChange(c.env.DB, id, actor.id));
});

pricesApi.post("/edits", async (c) => {
  const actor = siteAdmin(c);
  if (actor instanceof Response) return actor;
  const edit = await readJson<PriceEdit>(c);
  return decided(c, await editPrice(c.env.DB, edit, actor.id));
});
