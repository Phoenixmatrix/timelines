import { Hono } from "hono";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { TimelineGraphData } from "../../shared/timeline-graph.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { durableStorage } from "../testing/durable.ts";
import { fakeDurableObjectId } from "../testing/durable-state.ts";
import { accessFor } from "../tracker/access.ts";
import { findSpaceById } from "../spaces/access.ts";
import { Tracker } from "../tracker/object.ts";
import { SUBSCRIBED_PROJECTS_BATCH } from "../tracker/stub.ts";
import { timelineGraph } from "./graph.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('dan', 'user', 'dan', 'Dan');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ann');
  `);
  await seedSpaceFixture(fresh.env.DB, {
    organization: { id: "org_orbit", slug: "orbit", displayName: "Orbit", kind: "company" },
    space: { id: "orbit", slug: "orbit", displayName: "Orbit" },
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "ann",
  });
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
    VALUES('app','orbit','app','private','app','https://app')`);
  const { sql, transactionSync } = durableStorage();
  const ctx = {
    id: fakeDurableObjectId("orbit"),
    storage: { sql, transactionSync },
  } as unknown as DurableObjectState;
  const env = {
    ...fresh.env,
    TRACKER: { idFromName: fakeDurableObjectId, getByName: () => tracker },
  } as unknown as Env;
  const tracker = new Tracker(ctx, env);
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  server.route("/api/tracker/:space/timeline-graph", timelineGraph);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "read")).secret,
    dan: (await issueToken(env.DB, "dan", "t", "read")).secret,
  };
  const get = async (who: keyof typeof tokens) => {
    const response = await server.request(
      "/api/tracker/orbit/timeline-graph",
      { headers: { authorization: `Bearer ${tokens[who]}`, "X-Gitmatrix-Content-Version": "4" } },
      env,
    );
    return { status: response.status, body: (await response.json()) as TimelineGraphData };
  };
  const bot = await issueToken(env.DB, "ann", "bot", "write", undefined, "agt_bot");
  const space = await findSpaceById(env.DB, "orbit");
  if (!space) throw new Error("Missing fixture Space");
  const access = await accessFor(env, space, "ann", "agt_bot", true, { kind: "token", id: bot.id });
  const fork = async (slug: string, parent: string | null = null) => {
    const reply = await tracker.createTimeline(access, {
      slug,
      parent,
      repos: [{ id: "app", space: "orbit", name: "app" }],
      commits: { app: oid(1) },
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  return { tracker, get, fork, access };
}

describe("the timeline graph's data", () => {
  test("every timeline and every event once, oldest first, with the names it groups by", async () => {
    const t = await setup();
    await t.fork("search");
    await t.fork("ui");
    await t.fork("ui-dark", "ui");
    await t.tracker.recordTimelinePush({
      repo: { id: "app", spaceId: "orbit", space: "orbit", name: "app" },
      actorId: "agt_bot",
      accountableId: "ann",
      pushed: ["ui"],
      merges: [
        // search into ui, then ui into main: listed by both sides, returned once.
        { into: "ui", from: "search", commit: oid(5), parent: oid(4), refUpdateId: 1 },
        { into: null, from: "ui", commit: oid(6), parent: oid(5), refUpdateId: 2 },
      ],
    });
    const { status, body } = await t.get("ann");
    expect(status).toBe(200);
    expect(body.space).toMatchObject({ slug: "orbit" });
    expect(body.timelines.map((tl) => tl.slug).sort()).toEqual(["search", "ui", "ui-dark"]);
    expect(body.events.map((e) => e.kind)).toEqual(["fork", "fork", "fork", "merge", "merge"]);
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(body.truncated).toBe(false);
    expect(body.actors).toEqual({
      ann: { name: "Ann", accountableId: null, slug: "ann" },
      agt_bot: { name: "bot", accountableId: "ann" },
    });
    expect(body.projects).toEqual({ app: [] });
    expect(body.trackers.map((tracker) => tracker.slug)).toContain("orbit");
  });

  test("only the newest events when there are too many", async () => {
    const t = await setup();
    for (const slug of ["a", "b", "c"]) await t.fork(slug);
    const reply = await t.tracker.timelineGraph(t.access, 2);
    expect(reply.ok && reply.value.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(reply.ok && reply.value.truncated).toBe(true);
  });

  test("one authorized Tracker call answers for a batch of repositories", async () => {
    const t = await setup();
    const reply = await t.tracker.subscribedProjectsFor(t.access, ["app", "other"]);
    expect(reply).toEqual({ ok: true, value: { app: [], other: [] } });
    const ids = Array.from({ length: SUBSCRIBED_PROJECTS_BATCH + 1 }, (_, n) => `repo-${n}`);
    const tooMany = await t.tracker.subscribedProjectsFor(t.access, ids);
    expect(tooMany).toMatchObject({ ok: false, status: 400, code: "invalid_input" });
  });

  test("people outside the tracker are refused", async () => {
    const t = await setup();
    expect((await t.get("dan")).status).toBe(403);
  });
});
