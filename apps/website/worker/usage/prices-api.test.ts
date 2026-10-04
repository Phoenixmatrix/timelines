// The price catalog's API (CORE-208): who may read it, refresh it, apply and
// edit it, and the whole flow through HTTP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { PriceCatalog, PriceChangeSummary } from "../../shared/usage.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { PRICING_PAGES } from "./pages.ts";
import { pricesApi } from "./prices-api.ts";

const fixture = (product: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${product}.txt`, import.meta.url).href), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin) VALUES
      ('acc_root', 'user', 'root', 'Root', 1), ('acc_ann', 'user', 'ann', 'Ann', 0);
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role)
      VALUES ('acc_org', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('acc_org', 'acc_ann', 'owner');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/admin/prices", pricesApi);
  const token = async (user: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, "write")).secret;
  const tokens = { root: await token("acc_root"), ann: await token("acc_ann") };
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const response = await app.request(
      `/api/admin/prices${path}`,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
      },
      env,
    );
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as never, text };
  };
  return { call, tokens, sqlite };
}

/** Cloudflare's pages as saved, with Queues' price raised. */
function stubCloudflare() {
  vi.stubGlobal("fetch", async (url: string) => {
    const page = PRICING_PAGES.find((p) => `${p.url}index.md` === url);
    if (!page) return new Response("", { status: 404 });
    const text = fixture(page.product);
    return new Response(
      page.product === "queues" ? text.replace("$0.40/million", "$0.44/million") : text,
    );
  });
}

describe("authorization", () => {
  test("anyone signed in reads the catalog; signed out is refused", async () => {
    const t = await setup();
    expect((await t.call(null, "GET", "")).status).toBe(401);
    const { status, json } = await t.call(t.tokens.ann, "GET", "");
    expect(status).toBe(200);
    // The seed, then Containers' prices (CORE-210).
    expect((json as PriceCatalog).version).toBe(2);
    expect((json as PriceCatalog).prices.length).toBeGreaterThan(40);
  });

  test("only site administrators refresh, see changes and history, apply and edit", async () => {
    const t = await setup();
    stubCloudflare();
    const ann = t.tokens.ann; // an org owner, not a site administrator
    const refused = [
      ["POST", "/refresh"],
      ["GET", "/changes"],
      ["GET", "/changes/1"],
      ["GET", "/history?product=d1&metric=storage"],
      ["POST", "/changes/1/apply"],
      ["POST", "/changes/1/discard"],
      ["POST", "/edits"],
    ] as const;
    for (const [method, path] of refused) {
      expect(`${method} ${path} ${(await t.call(ann, method, path, {})).status}`).toBe(
        `${method} ${path} 403`,
      );
      expect((await t.call(null, method, path, {})).status).toBe(401);
    }
    // Nothing was fetched or recorded on their behalf.
    // (The two seed changes: the catalog's, then Containers'.)
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM cloudflare_price_changes").get()).toEqual({
      n: 2,
    });
  });
});

describe("the flow", () => {
  test("refresh, review, apply; edit; history", async () => {
    const t = await setup();
    stubCloudflare();
    const root = t.tokens.root;
    const refreshed = await t.call(root, "POST", "/refresh");
    expect(refreshed.status).toBe(201);
    const change = refreshed.json as PriceChangeSummary;
    expect(change).toMatchObject({ kind: "refresh", status: "pending", createdBy: "root" });
    expect(change.diff.map((e) => `${e.product}/${e.metric}`)).toEqual(["queues/operations"]);
    expect(((await t.call(root, "GET", "")).json as PriceCatalog).pending?.id).toBe(change.id);

    const applied = await t.call(root, "POST", `/changes/${change.id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.json as PriceChangeSummary).toMatchObject({
      status: "applied",
      decidedBy: "root",
    });
    expect((await t.call(root, "POST", `/changes/${change.id}/apply`)).status).toBe(409);
    expect((await t.call(root, "POST", "/changes/999/apply")).status).toBe(404);
    expect((await t.call(root, "POST", "/changes/abc/apply")).status).toBe(404);

    const catalog = (await t.call(root, "GET", "")).json as PriceCatalog;
    const queues = catalog.prices.find((p) => p.product === "queues");
    expect(queues).toMatchObject({ unitPriceUsd: 0.44, provenance: "refresh", recordedBy: "root" });

    const bad = await t.call(root, "POST", "/edits", {
      product: "queues",
      metric: "operations",
      unitPriceUsd: 0.5,
    });
    expect(bad).toMatchObject({
      status: 400,
      json: { error: "Say why the price is being changed." },
    });
    const edited = await t.call(root, "POST", "/edits", {
      product: "queues",
      metric: "operations",
      unitPriceUsd: 0.5,
      effectiveFrom: "2030-01-01",
      note: "Announced increase",
    });
    expect(edited.status).toBe(200);
    expect(edited.json as PriceChangeSummary).toMatchObject({ kind: "manual", status: "applied" });

    const history = await t.call(root, "GET", "/history?product=queues&metric=operations");
    expect(
      (history.json as { prices: { unitPriceUsd: number; provenance: string }[] }).prices.map(
        (p) => [p.unitPriceUsd, p.provenance],
      ),
    ).toEqual([
      [0.5, "manual"],
      [0.44, "refresh"],
      [0.4, "seed"],
    ]);
    expect((await t.call(root, "GET", "/history?product=queues&metric=nope")).status).toBe(404);

    const changes = (await t.call(root, "GET", "/changes")).json as {
      changes: PriceChangeSummary[];
    };
    expect(changes.changes.map((c) => [c.kind, c.status])).toEqual([
      ["manual", "applied"],
      ["refresh", "applied"],
      ["seed", "applied"],
      ["seed", "applied"],
    ]);
    const one = await t.call(root, "GET", `/changes/${change.id}`);
    expect((one.json as PriceChangeSummary).pages).toHaveLength(PRICING_PAGES.length);
  });
});
