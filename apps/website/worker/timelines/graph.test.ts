import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { TimelineGraphData } from "../../shared/timeline-graph.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { Tracker } from "../tracker/object.ts";
import type { Access } from "../tracker/store.ts";
import { timelineGraph } from "./graph.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role) VALUES
      ('ann', 'user', 'ann', 'Ann', NULL), ('dan', 'user', 'dan', 'Dan', NULL),
      ('orbit', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'owner');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ann');
  `);
  const { sql, transactionSync } = durableStorage();
  const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
  const tracker = new Tracker(ctx, {} as Env);
  const env = {
    DB: d1(sqlite),
    TRACKER: { getByName: () => tracker },
  } as unknown as Env;
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  server.route("/api/tracker/:owner/timeline-graph", timelineGraph);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "read")).secret,
    dan: (await issueToken(env.DB, "dan", "t", "read")).secret,
  };
  const get = async (who: keyof typeof tokens) => {
    const response = await server.request(
      "/api/tracker/orbit/timeline-graph",
      { headers: { authorization: `Bearer ${tokens[who]}` } },
      env,
    );
    return { status: response.status, body: (await response.json()) as TimelineGraphData };
  };
  const access: Access = {
    actorId: "agt_bot",
    principalId: "ann",
    agents: [],
    owner: { id: "orbit", slug: "orbit", displayName: "Orbit" },
    canAdmin: true,
    members: [],
    repos: [],
  };
  const fork = (slug: string, parent: string | null = null) => {
    const reply = tracker.createTimeline(access, {
      slug,
      parent,
      repos: [{ id: "app", owner: "orbit", name: "app" }],
      commits: { app: oid(1) },
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  return { tracker, get, fork };
}

describe("the timeline graph's data", () => {
  test("every timeline and every event once, oldest first, with the names it groups by", async () => {
    const t = await setup();
    t.fork("search");
    t.fork("ui");
    t.fork("ui-dark", "ui");
    t.tracker.recordTimelinePush({
      repo: { id: "app", owner: "orbit", name: "app" },
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
    expect(body.owner).toMatchObject({ slug: "orbit" });
    expect(body.timelines.map((tl) => tl.slug).sort()).toEqual(["search", "ui", "ui-dark"]);
    expect(body.events.map((e) => e.kind)).toEqual(["fork", "fork", "fork", "merge", "merge"]);
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(body.truncated).toBe(false);
    expect(body.actors).toEqual({
      ann: { name: "Ann", accountableId: null },
      agt_bot: { name: "bot", accountableId: "ann" },
    });
    expect(body.workspaces).toEqual({ app: [] });
    expect(body.trackers.map((tracker) => tracker.slug)).toContain("orbit");
  });

  test("only the newest events when there are too many", () => {
    const { sql, transactionSync } = durableStorage();
    const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
    const tracker = new Tracker(ctx, {} as Env);
    const access = {
      actorId: "ann",
      principalId: "ann",
      agents: [],
      owner: { id: "orbit", slug: "orbit", displayName: "Orbit" },
      canAdmin: true,
      members: [],
      repos: [],
    };
    for (const slug of ["a", "b", "c"])
      tracker.createTimeline(access, {
        slug,
        parent: null,
        repos: [{ id: "app", owner: "orbit", name: "app" }],
        commits: { app: oid(1) },
      });
    const reply = tracker.timelineGraph(2);
    expect(reply.ok && reply.value.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(reply.ok && reply.value.truncated).toBe(true);
  });

  test("people outside the tracker are refused", async () => {
    const t = await setup();
    expect((await t.get("dan")).status).toBe(403);
  });
});
