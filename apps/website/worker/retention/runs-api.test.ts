// Manual cleanup runs over the API (CORE-198): dry run, then run, then the
// history; validation and authorization.

import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { RetentionRun, RetentionRunPage, RetentionSettings } from "../../shared/retention.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { seedPrice } from "../usage/seed.ts";
import { spaceRetentionApi, spaceRunsApi, personRunsApi, instanceRetentionApi } from "./api.ts";
import { CATEGORIES } from "./categories.ts";
import { runNotes } from "./runs.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  cleanups.push(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_ann', 'user', 'ann', 'Ann'), ('acc_bob', 'user', 'bob', 'Bob'),
      ('acc_cat', 'user', 'cat', 'Cat');
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin)
      VALUES ('acc_sue', 'user', 'sue', 'Sue', 1);
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
  `);
  for (const [id, slug, person] of [
    ["acc_org", "orbit", "acc_ann"],
    ["acc_bob", "bob", "acc_bob"],
  ] as const) {
    await seedSpaceFixture(d1(sqlite), {
      organization: { id: `org_${id}`, slug: `org-${slug}`, displayName: slug, kind: "company" },
      space: { id, slug, displayName: slug },
      actorId: person,
      members: [
        {
          accountId: person,
          role: "owner",
          grant: { role: "admin", repositoryRole: "read", packageRole: "read" },
        },
        ...(id === "acc_org"
          ? [
              {
                accountId: "acc_cat",
                role: "member" as const,
                grant: {
                  role: "member" as const,
                  repositoryRole: "read" as const,
                  packageRole: "read" as const,
                },
              },
              { accountId: "acc_sue", role: "owner" as const },
            ]
          : []),
      ],
    });
  }
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'acc_org', 'app', 'private', 'a', 'https://a'),
      ('bobs', 'acc_bob', 'b', 'private', 'b', 'https://b');
  `);
  const insert = sqlite.prepare(`
    INSERT INTO deployments (repo_id, environment, commit_oid, status, expires_at, torn_down_at)
    VALUES (?, 'timeline/t', 'abc', ?, ?, ?)`);
  for (let i = 0; i < 7; i++) insert.run("repo", "expired", ago(40.5 + i), ago(40.5 + i));
  insert.run("repo", "expired", ago(10), ago(10));
  insert.run("repo", "active", ago(-3), null);
  insert.run("bobs", "expired", ago(90), ago(90));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/spaces/:space/retention", spaceRetentionApi);
  app.route("/api/spaces/:space/retention/runs", spaceRunsApi);
  app.route("/api/admin/retention", instanceRetentionApi);
  app.route("/api/accounts/:person/retention/runs", personRunsApi);
  const token = async (user: string, agent?: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, "write", undefined, agent)).secret;
  const tokens = {
    ann: await token("acc_ann"),
    agent: await token("acc_ann", "agt_builder"),
    bob: await token("acc_bob"),
    cat: await token("acc_cat"),
    sue: await token("acc_sue"),
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => void pending.push(work),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
      ctx,
    );
    // The run's first slice runs after the response.
    await Promise.all(pending.splice(0));
    return { status: response.status, json: (await response.json()) as never };
  };
  const deployments = () =>
    (sqlite.prepare("SELECT count(*) AS n FROM deployments").get() as { n: number }).n;
  return { call, tokens, sqlite, deployments };
}

const RUNS = "/api/spaces/orbit/retention/runs";

describe("manual cleanup runs", () => {
  test("dry run, run, and history, for a disabled category at its shown thresholds", async () => {
    const t = await setup();
    const started = await t.call(t.tokens.ann, "POST", RUNS, {
      dryRun: true,
      categories: ["preview-records"],
    });
    expect(started.status).toBe(202);
    const dry = started.json as RetentionRun;
    expect(dry).toMatchObject({
      target: { kind: "space", id: "acc_org" },
      actor: "ann",
      dryRun: true,
    });
    const finished = (await t.call(t.tokens.ann, "GET", `${RUNS}/${dry.id}`)).json as RetentionRun;
    expect(finished).toMatchObject({
      status: "succeeded",
      items: 7,
      categories: [{ category: "preview-records", thresholds: { days: 30 }, items: 7 }],
    });
    expect(t.deployments()).toBe(10);
    // Its estimated cost: the bytes at D1's storage list price (the seeded catalog).
    const d1Storage = seedPrice("d1", "storage");
    expect(finished.categories[0]!.cost).toMatchObject({
      product: "d1",
      metric: "storage",
      unit: d1Storage.unit,
      quantity: finished.bytes / 1e9,
      monthlyUsd: (finished.bytes / 1e9) * (d1Storage.unitPriceUsd / d1Storage.unitQuantity),
      startsOn: null,
      estimated: true,
    });
    expect(finished.notes).toEqual([]);

    // Thresholds can be overridden for one run, within bounds.
    const narrower = await t.call(t.tokens.ann, "POST", RUNS, {
      dryRun: true,
      categories: ["preview-records"],
      thresholds: { "preview-records": { days: 44 } },
    });
    expect(
      (
        (await t.call(t.tokens.ann, "GET", `${RUNS}/${(narrower.json as RetentionRun).id}`))
          .json as RetentionRun
      ).items,
    ).toBe(3);

    const real = await t.call(t.tokens.ann, "POST", RUNS, {
      dryRun: false,
      categories: ["preview-records"],
    });
    const done = (await t.call(t.tokens.ann, "GET", `${RUNS}/${(real.json as RetentionRun).id}`))
      .json as RetentionRun;
    expect(done).toMatchObject({
      dryRun: false,
      status: "succeeded",
      items: 7,
      bytes: finished.bytes,
    });
    expect(t.deployments()).toBe(3);

    const history = (await t.call(t.tokens.ann, "GET", RUNS)).json as RetentionRunPage;
    expect(history.runs.map((r) => [r.dryRun, r.items])).toEqual([
      [false, 7],
      [true, 3],
      [true, 7],
    ]);
    const page = (await t.call(t.tokens.ann, "GET", `${RUNS}?limit=2`)).json as RetentionRunPage;
    expect(page.runs).toHaveLength(2);
    const rest = (await t.call(t.tokens.ann, "GET", `${RUNS}?before=${page.next}`))
      .json as RetentionRunPage;
    expect(rest).toMatchObject({ runs: [{ id: dry.id }], next: null });

    // Settings show the category as runnable, still disabled, with its last run.
    const settings = (await t.call(t.tokens.ann, "GET", "/api/spaces/orbit/retention"))
      .json as RetentionSettings;
    expect(settings.categories.find((c) => c.id === "preview-records")).toMatchObject({
      enabled: false,
      runnable: true,
      lastRun: { runId: done.id, dryRun: false, trigger: "manual", items: 7, status: "succeeded" },
    });
  });

  test("validates what to run", async () => {
    const t = await setup();
    const bad = async (body: unknown, message: RegExp) => {
      const response = await t.call(t.tokens.ann, "POST", RUNS, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((response.json as { error: string }).error).toMatch(message);
    };
    await bad({ categories: ["preview-records"] }, /dryRun/);
    await bad({ dryRun: true, categories: [] }, /categories/);
    await bad({ dryRun: true, categories: ["preview-records", "preview-records"] }, /each once/);
    await bad({ dryRun: true, categories: ["nope"] }, /Unknown category/);
    await bad({ dryRun: true, categories: ["auth-hygiene"] }, /isn't a category of this level/);
    await bad({ dryRun: true, categories: ["previews"] }, /has no cleanup yet/);
    await bad(
      {
        dryRun: true,
        categories: ["preview-records"],
        thresholds: { "preview-records": { days: 0 } },
      },
      /whole number/,
    );
    await bad(
      { dryRun: true, categories: ["preview-records"], thresholds: { "ci-logs": { days: 3 } } },
      /isn't in categories/,
    );
    await bad({ dryRun: true, categories: ["preview-records"], force: true }, /Unknown field/);
    expect(
      (t.sqlite.prepare("SELECT count(*) AS n FROM cleanup_runs").get() as { n: number }).n,
    ).toBe(0);
  });

  test("owners run and read, members are refused, others see nothing; site runs are site admins'", async () => {
    const t = await setup();
    const body = { dryRun: true, categories: ["preview-records"] };
    expect((await t.call(t.tokens.cat, "POST", RUNS, body)).status).toBe(403);
    expect((await t.call(t.tokens.agent, "POST", RUNS, body)).status).toBe(403);
    expect((await t.call(t.tokens.bob, "POST", RUNS, body)).status).toBe(404);
    expect((await t.call(t.tokens.bob, "GET", RUNS)).status).toBe(404);
    expect((await t.call(t.tokens.sue, "POST", RUNS, body)).status).toBe(404);
    const run = (await t.call(t.tokens.ann, "POST", RUNS, body)).json as RetentionRun;
    expect(run.actor).toBe("ann");
    expect((await t.call(t.tokens.ann, "GET", `${RUNS}/${run.id}`)).status).toBe(200);
    expect((await t.call(t.tokens.agent, "GET", `${RUNS}/${run.id}`)).status).toBe(200);
    // Members see neither the history nor a run.
    expect((await t.call(t.tokens.cat, "GET", RUNS)).status).toBe(403);
    expect((await t.call(t.tokens.cat, "GET", `${RUNS}/${run.id}`)).status).toBe(403);
    // Another account's run isn't found through this one.
    expect(
      (await t.call(t.tokens.bob, "GET", `/api/spaces/bob/retention/runs/${run.id}`)).status,
    ).toBe(404);
    expect((await t.call(t.tokens.ann, "GET", `${RUNS}/nope`)).status).toBe(404);

    expect((await t.call(t.tokens.ann, "GET", "/api/admin/retention/runs")).status).toBe(403);
    expect(
      (
        await t.call(t.tokens.ann, "POST", "/api/admin/retention/runs", {
          dryRun: true,
          categories: [],
        })
      ).status,
    ).toBe(403);
    // No site category has a cleanup yet, and account categories aren't the site's.
    const site = await t.call(t.tokens.sue, "POST", "/api/admin/retention/runs", body);
    expect(site.status).toBe(400);
    expect((await t.call(t.tokens.sue, "GET", "/api/admin/retention/runs")).json).toEqual({
      runs: [],
      next: null,
    });
    expect((await t.call(t.tokens.sue, "GET", `/api/admin/retention/runs/${run.id}`)).status).toBe(
      404,
    );
  });
});

describe("preview figures", () => {
  test("a dry run of overlapping categories says it counts some records twice", () => {
    expect(runNotes(true, ["ci-logs", "preview-records"])).toEqual([]);
    expect(runNotes(false, ["ci-logs", "ci-runs"])).toEqual([]);
    const notes = runNotes(true, ["tracker-activity", "ci-runs", "closed-issues", "ci-logs"]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^CI logs and CI run history can select the same records/);
    expect(notes[1]).toMatch(/^Closed and canceled issues and Tracker activity/);
    // The overlap is symmetric in the registry.
    for (const c of CATEGORIES)
      for (const other of ("overlaps" in c ? c.overlaps : []) as readonly string[])
        expect(
          (CATEGORIES.find((x) => x.id === other) as { overlaps?: readonly string[] }).overlaps,
        ).toContain(c.id);
  });
});

test("personal run metadata cannot be requested by company or Instance administrators", async () => {
  const t = await setup();
  const path = "/api/accounts/ann/retention/runs";
  expect((await t.call(t.tokens.ann, "GET", path)).status).toBe(200);
  expect((await t.call(t.tokens.sue, "GET", path)).status).toBe(404);
  expect((await t.call(t.tokens.bob, "GET", path)).status).toBe(404);
  expect(
    (
      await t.call(t.tokens.ann, "POST", path, {
        dryRun: true,
        categories: ["preview-records"],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await t.call(t.tokens.ann, "POST", RUNS, {
        dryRun: true,
        categories: ["assistant-chats"],
      })
    ).status,
  ).toBe(400);
});
