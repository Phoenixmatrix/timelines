import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { PreviewSettings } from "../../shared/deployments.ts";
import type { RetentionPolicy, RetentionSettings } from "../../shared/retention.ts";
import { issueToken } from "../api/tokens.ts";
import { scopePolicy } from "../atlas/retention.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { previewSettingsApi } from "../deployments/settings.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { accountRetentionApi, siteRetentionApi } from "./api.ts";
import { CATEGORIES } from "./categories.ts";
import { cleanupFor } from "./cleanups/index.ts";
import { enabledTargets } from "./policies.ts";

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_ann', 'user', 'ann', 'Ann'), ('acc_bob', 'user', 'bob', 'Bob'),
      ('acc_cat', 'user', 'cat', 'Cat');
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin)
      VALUES ('acc_sue', 'user', 'sue', 'Sue', 1);
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role)
      VALUES ('acc_org', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('acc_org', 'acc_ann', 'owner'), ('acc_org', 'acc_cat', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_ops', 'ops', 'acc_sue');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/previews", previewSettingsApi);
  app.route("/api/accounts/:slug/settings/retention", accountRetentionApi);
  app.route("/api/admin/retention", siteRetentionApi);
  const token = async (user: string, agent?: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, "write", undefined, agent)).secret;
  const tokens = {
    ann: await token("acc_ann"),
    agent: await token("acc_ann", "agt_builder"),
    bob: await token("acc_bob"),
    cat: await token("acc_cat"),
    sue: await token("acc_sue"),
    sueAgent: await token("acc_sue", "agt_ops"),
  };
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body:
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
    return { status: response.status, json: (await response.json()) as never };
  };
  return { call, tokens, sqlite, env };
}

const ORG = "/api/accounts/orbit/settings/retention";
const SITE = "/api/admin/retention";
const policy = (settings: RetentionSettings, id: string) =>
  settings.categories.find((c) => c.id === id) as RetentionPolicy;
const count = (sqlite: ReturnType<typeof migratedDatabase>, table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the category registry", () => {
  test("has every PRD category once, with sane thresholds and plain-language limits", () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "ci-logs",
      "ci-runs",
      "preview-records",
      "knowledge-builds",
      "ended-timeline-data",
      "push-log",
      "unreachable-git",
      "closed-issues",
      "tracker-activity",
      "assistant-chats",
      "release-notes",
      "previews",
      "atlas-snapshots",
      "analysis-caches",
      "registry-proxy-cache",
      "registry-audit",
      "auth-hygiene",
      "ai-spend",
      "usage-history",
      "ai-usage",
      "durable-registry",
    ]);
    for (const c of CATEGORIES) {
      expect(c.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(c.never.length).toBeGreaterThan(0);
      expect(c.thresholds.length).toBeGreaterThan(0);
      for (const t of c.thresholds) {
        expect(Number.isInteger(t.default)).toBe(true);
        expect(t.min).toBeLessThanOrEqual(t.default);
        expect(t.default).toBeLessThanOrEqual(t.max);
      }
    }
  });
});

describe("account retention settings", () => {
  test("with nothing stored, every policy category is disabled at its PRD default", async () => {
    const t = await setup();
    const { status, json } = await t.call(t.tokens.ann, "GET", ORG);
    expect(status).toBe(200);
    const settings = json as RetentionSettings;
    expect(settings).toMatchObject({ level: "account", account: "orbit", canEdit: true });
    expect(settings.categories.map((c) => c.id)).toEqual(
      CATEGORIES.filter((c) => c.scope === "account").map((c) => c.id),
    );
    for (const c of settings.categories.filter((c) => c.control === "policy"))
      expect(c).toMatchObject({
        enabled: false,
        enabledFrom: "default",
        runnable: cleanupFor(c.id) !== undefined,
        lastRun: null,
      });
    expect(policy(settings, "ci-logs").values).toEqual({ days: 30 });
    expect(policy(settings, "ci-runs").values).toEqual({ days: 180, keepLatest: 20 });
    expect(policy(settings, "tracker-activity").values).toEqual({
      eventDays: 365,
      endedTimelineDays: 180,
    });
    // Existing cleanup keeps running as it did.
    expect(policy(settings, "previews")).toMatchObject({
      control: "active",
      enabled: true,
      values: { endedDays: 2, idleDays: 7 },
    });
    expect(policy(settings, "atlas-snapshots")).toMatchObject({
      control: "active",
      enabled: true,
      values: { maxPrior: 20, priorDays: 7, capGib: 2 },
    });
    expect(settings.changes).toEqual([]);
    expect(await enabledTargets(t.env.DB)).toEqual([]);
  });

  test("enabling without values applies the defaults; values and resets are recorded", async () => {
    const t = await setup();
    const enabled = await t.call(t.tokens.ann, "PATCH", ORG, {
      categories: { "ci-logs": { enabled: true }, "release-notes": { thresholds: { days: 400 } } },
    });
    expect(enabled.status).toBe(200);
    let settings = enabled.json as RetentionSettings;
    expect(policy(settings, "ci-logs")).toMatchObject({
      enabled: true,
      enabledFrom: "account",
      values: { days: 30 },
      valuesFrom: { days: "default" },
      updatedBy: "ann",
    });
    expect(policy(settings, "release-notes")).toMatchObject({
      enabled: false,
      values: { days: 400 },
      valuesFrom: { days: "account" },
    });
    expect(settings.changes.map((c) => [c.category, c.actor, c.before, c.after])).toEqual(
      expect.arrayContaining([
        ["ci-logs", "ann", {}, { enabled: true }],
        ["release-notes", "ann", {}, { thresholds: { days: 400 } }],
      ]),
    );
    const targets = await enabledTargets(t.env.DB);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target).toEqual({ scope: "account", accountId: "acc_org" });
    expect(targets[0]!.policies.map((p) => p.id)).toEqual(["ci-logs"]);

    // The same values again change nothing and record nothing.
    await t.call(t.tokens.ann, "PATCH", ORG, { categories: { "ci-logs": { enabled: true } } });
    expect(count(t.sqlite, "retention_policy_changes")).toBe(2);

    // null resets to inherit; an empty policy leaves no row behind.
    settings = (
      await t.call(t.tokens.ann, "PATCH", ORG, {
        categories: {
          "ci-logs": { enabled: null },
          "release-notes": { thresholds: { days: null } },
        },
      })
    ).json;
    expect(policy(settings, "ci-logs")).toMatchObject({ enabled: false, enabledFrom: "default" });
    expect(policy(settings, "release-notes").values).toEqual({ days: 730 });
    expect(count(t.sqlite, "retention_policies")).toBe(0);
    expect(count(t.sqlite, "retention_policy_changes")).toBe(4);
    expect(settings.changes[0]).toMatchObject({ before: { thresholds: { days: 400 } }, after: {} });
  });

  test("rejects what the registry doesn't allow", async () => {
    const t = await setup();
    const bad = async (body: unknown) => {
      const response = await t.call(t.tokens.ann, "PATCH", ORG, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      return (response.json as { error: string }).error;
    };
    expect(await bad({ categories: { "no-such": { enabled: true } } })).toMatch(/Unknown category/);
    expect(await bad({ categories: { "ci-logs": { thresholds: { weeks: 2 } } } })).toMatch(
      /Unknown threshold/,
    );
    expect(await bad({ categories: { "ci-logs": { thresholds: { days: 1.5 } } } })).toMatch(
      /whole number from 1 to 3650/,
    );
    await bad({ categories: { "ci-logs": { thresholds: { days: 0 } } } });
    await bad({ categories: { "ci-logs": { thresholds: { days: 3651 } } } });
    await bad({ categories: { "ci-logs": { thresholds: { days: "30" } } } });
    await bad({ categories: { "ci-logs": { enabled: "yes" } } });
    await bad({ categories: { "ci-logs": { enable: true } } });
    expect(await bad({ categories: { "auth-hygiene": { enabled: true } } })).toMatch(
      /site category/,
    );
    // Atlas snapshots: an account can keep less, never more.
    expect(
      await bad({ categories: { "atlas-snapshots": { thresholds: { maxPrior: 21 } } } }),
    ).toMatch(/whole number from 0 to 20/);
    await bad({ categories: { "atlas-snapshots": { thresholds: { priorDays: 8 } } } });
    await bad({ categories: { "atlas-snapshots": { thresholds: { capGib: 3 } } } });
    expect(await bad({ categories: { "atlas-snapshots": { enabled: false } } })).toMatch(
      /always runs/,
    );
    expect(await bad({ categories: { previews: { enabled: false } } })).toMatch(/always runs/);
    await bad({ categories: { previews: { thresholds: { idleDays: 0 } } } });
    await bad({ categories: [] });
    await bad({ categories: { "ci-logs": { enabled: true } }, extra: 1 });
    await bad("not json");
    // Nothing partial was stored.
    expect(count(t.sqlite, "retention_policies")).toBe(0);
    expect(count(t.sqlite, "retention_policy_changes")).toBe(0);
  });

  test("owners read and change, members are refused, others don't see it", async () => {
    const t = await setup();
    const enable = { categories: { "ci-logs": { enabled: true } } };
    expect((await t.call(t.tokens.cat, "GET", ORG)).status).toBe(403);
    expect(((await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings).canEdit).toBe(true);
    expect(((await t.call(t.tokens.sue, "GET", ORG)).json as RetentionSettings).canEdit).toBe(true);
    expect((await t.call(t.tokens.bob, "GET", ORG)).status).toBe(404);
    expect((await t.call(t.tokens.bob, "PATCH", ORG, enable)).status).toBe(404);
    expect((await t.call(t.tokens.cat, "PATCH", ORG, enable)).status).toBe(403);
    expect((await t.call(t.tokens.agent, "PATCH", ORG, enable)).status).toBe(403);
    expect(((await t.call(t.tokens.agent, "GET", ORG)).json as RetentionSettings).canEdit).toBe(
      false,
    );
    expect((await t.call(t.tokens.sue, "PATCH", ORG, enable)).status).toBe(200);
    // A user's own account is theirs.
    const bob = "/api/accounts/bob/settings/retention";
    expect((await t.call(t.tokens.bob, "PATCH", bob, enable)).status).toBe(200);
    expect((await t.call(t.tokens.ann, "GET", bob)).status).toBe(404);
    expect(
      (await t.call(t.tokens.ann, "GET", "/api/accounts/nobody/settings/retention")).status,
    ).toBe(404);
  });

  test("preview settings are the previews category, both ways", async () => {
    const t = await setup();
    const changed = await t.call(t.tokens.ann, "PATCH", ORG, {
      categories: { previews: { thresholds: { idleDays: 3 } } },
    });
    expect(policy(changed.json, "previews")).toMatchObject({
      values: { endedDays: 2, idleDays: 3 },
      valuesFrom: { endedDays: "account", idleDays: "account" },
    });
    expect(
      (await t.call(t.tokens.ann, "GET", "/api/accounts/orbit/settings/previews")).json,
    ).toMatchObject({
      endedDays: 2,
      idleDays: 3,
      updatedBy: "ann",
    } satisfies Partial<PreviewSettings>);
    await t.call(t.tokens.ann, "PATCH", "/api/accounts/orbit/settings/previews", { endedDays: 0 });
    const read = (await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings;
    expect(policy(read, "previews").values).toEqual({ endedDays: 0, idleDays: 3 });
    expect(read.changes).toHaveLength(1);
    expect(read.changes[0]).toMatchObject({
      category: "previews",
      before: {},
      after: { thresholds: { endedDays: 2, idleDays: 3 } },
    });
  });

  test("a settings row the AI settings made stores nothing for previews", async () => {
    const t = await setup();
    t.sqlite.exec(`INSERT INTO account_settings (account_id, ai_wiki) VALUES ('acc_org', 0)`);
    const settings = (await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings;
    expect(policy(settings, "previews")).toMatchObject({
      values: { endedDays: 2, idleDays: 7 },
      valuesFrom: { endedDays: "default", idleDays: "default" },
      updatedAt: null,
    });
  });

  test("a stored value outside today's bounds is ignored", async () => {
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO retention_policies (account_id, category, enabled, thresholds)
        VALUES ('acc_org', 'ci-logs', 1, '{"days": 0}'),
               ('acc_org', 'push-log', NULL, 'not json');
    `);
    const settings = (await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings;
    expect(policy(settings, "ci-logs")).toMatchObject({ enabled: true, values: { days: 30 } });
    expect(policy(settings, "push-log")).toMatchObject({ enabled: false, values: { days: 365 } });
  });

  test("Atlas snapshots: an account keeps less, which every Atlas retention pass reads", async () => {
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
        ('r_org', 'acc_org', 'engine', 'private', 'a', ''),
        ('r_ann', 'acc_ann', 'notes', 'private', 'b', '');
      INSERT INTO atlas_scopes (scope, kind, repo_id) VALUES
        ('repo:r_org', 'repo', 'r_org'), ('repo:r_ann', 'repo', 'r_ann');
    `);
    expect(await scopePolicy(t.env.DB, ["repo:r_org"])).toEqual({});
    const patched = await t.call(t.tokens.ann, "PATCH", ORG, {
      categories: { "atlas-snapshots": { thresholds: { maxPrior: 3, priorDays: 2 } } },
    });
    expect(patched.status).toBe(200);
    expect(policy(patched.json as RetentionSettings, "atlas-snapshots")).toMatchObject({
      control: "active",
      enabled: true,
      values: { maxPrior: 3, priorDays: 2, capGib: 2 },
      valuesFrom: { maxPrior: "account", priorDays: "account", capGib: "default" },
      updatedBy: "ann",
    });
    expect(
      t.sqlite
        .prepare("SELECT enabled, thresholds FROM retention_policies WHERE category = ?")
        .all("atlas-snapshots"),
    ).toEqual([{ enabled: null, thresholds: '{"maxPrior":3,"priorDays":2}' }]);
    // The hourly sweep applies it to the account's repositories, not others'.
    expect(
      t.sqlite.prepare("SELECT scope, retention_pending FROM atlas_scopes ORDER BY scope").all(),
    ).toEqual([
      { scope: "repo:r_ann", retention_pending: 0 },
      { scope: "repo:r_org", retention_pending: 1 },
    ]);
    expect(await scopePolicy(t.env.DB, ["repo:r_org"])).toEqual({
      maxPrior: 3,
      priorTtlMs: 2 * 86_400_000,
    });
    expect(await scopePolicy(t.env.DB, ["repo:r_ann"])).toEqual({});
    // Reset: back to ATLAS_RETENTION.
    await t.call(t.tokens.ann, "PATCH", ORG, {
      categories: { "atlas-snapshots": { thresholds: { maxPrior: null, priorDays: null } } },
    });
    expect(count(t.sqlite, "retention_policies")).toBe(0);
    expect(await scopePolicy(t.env.DB, ["repo:r_org"])).toEqual({});
  });
});

describe("site retention settings", () => {
  test("site administrators only; agents read", async () => {
    const t = await setup();
    expect((await t.call(t.tokens.ann, "GET", SITE)).status).toBe(403);
    expect(
      (
        await t.call(t.tokens.ann, "PATCH", SITE, {
          categories: { "auth-hygiene": { enabled: true } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.call(t.tokens.sueAgent, "PATCH", SITE, {
          categories: { "auth-hygiene": { enabled: true } },
        })
      ).status,
    ).toBe(403);
    const read = await t.call(t.tokens.sueAgent, "GET", SITE);
    expect(read.status).toBe(200);
    expect((read.json as RetentionSettings).canEdit).toBe(false);
  });

  test("site categories and site-wide defaults, which accounts inherit and override", async () => {
    const t = await setup();
    let site = (await t.call(t.tokens.sue, "GET", SITE)).json as RetentionSettings;
    expect(site).toMatchObject({ level: "site", account: null, canEdit: true });
    expect(site.categories.filter((c) => c.scope === "site").map((c) => c.id)).toEqual([
      "analysis-caches",
      "registry-proxy-cache",
      "registry-audit",
      "auth-hygiene",
      "ai-spend",
      "usage-history",
      "ai-usage",
      "durable-registry",
    ]);
    // Only categories that take a policy have site-wide defaults.
    expect(site.categories.some((c) => c.control !== "policy")).toBe(false);
    for (const c of site.categories) expect(c.enabled).toBe(false);

    const bad = async (body: unknown) =>
      expect((await t.call(t.tokens.sue, "PATCH", SITE, body)).status).toBe(400);
    await bad({ categories: { previews: { thresholds: { idleDays: 3 } } } });
    await bad({ categories: { "atlas-snapshots": { thresholds: { maxPrior: 20 } } } });
    await bad({ categories: { "auth-hygiene": { thresholds: { days: -1 } } } });

    site = (
      await t.call(t.tokens.sue, "PATCH", SITE, {
        categories: {
          "auth-hygiene": { enabled: true, thresholds: { days: 14 } },
          "ci-logs": { thresholds: { days: 60 } },
        },
      })
    ).json;
    expect(policy(site, "auth-hygiene")).toMatchObject({
      enabled: true,
      enabledFrom: "site",
      values: { days: 14 },
    });
    expect(site.changes.map((c) => [c.category, c.actor])).toEqual(
      expect.arrayContaining([
        ["auth-hygiene", "sue"],
        ["ci-logs", "sue"],
      ]),
    );
    // Account changes aren't the site's, and the other way round.
    expect(((await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings).changes).toEqual(
      [],
    );

    let org = (await t.call(t.tokens.ann, "GET", ORG)).json as RetentionSettings;
    expect(policy(org, "ci-logs")).toMatchObject({
      enabled: false,
      values: { days: 60 },
      valuesFrom: { days: "site" },
    });
    expect((await enabledTargets(t.env.DB)).map((x) => x.target)).toEqual([{ scope: "site" }]);

    // A site-wide default that enables an account category covers every
    // account that didn't decide otherwise.
    await t.call(t.tokens.sue, "PATCH", SITE, { categories: { "ci-logs": { enabled: true } } });
    await t.call(t.tokens.bob, "PATCH", "/api/accounts/bob/settings/retention", {
      categories: { "ci-logs": { enabled: false } },
    });
    org = (await t.call(t.tokens.ann, "GET", ORG)).json;
    expect(policy(org, "ci-logs")).toMatchObject({ enabled: true, enabledFrom: "site" });
    const targets = await enabledTargets(t.env.DB);
    const accounts = targets.flatMap((x) =>
      x.target.scope === "account" ? [x.target.accountId] : [],
    );
    expect(accounts).toContain("acc_org");
    expect(accounts).toContain("acc_ann");
    expect(accounts).not.toContain("acc_bob");
  });
});
