// Ended overlays (CORE-139): a timeline's last overlay outlives its bookmark,
// read-only, as landed, abandoned or just ended; it is never computed again,
// and the overlay API shows it.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { KnowledgeOverlay, KnowledgeOverlaySummary } from "../../shared/api.ts";
import type { TimelineStatus } from "../../shared/timelines.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { endedTimelineData } from "../retention/cleanups/ended-timeline-data.ts";
import { Timing } from "../timing.ts";
import { knowledge } from "./api.ts";
import { KnowledgeCoordinator } from "./coordinator.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const oid = (n: number) => n.toString(16).padStart(40, "0");
const FAST = "refs/heads/timeline/fast";
const SIDE = "refs/heads/timeline/side";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Durable Object's state: key-value storage and an alarm, in memory. */
function objectState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

let artifactsNames = 0;

async function setup() {
  const sqlite = migratedDatabase();
  // A fresh Artifacts name each time: RepoReader caches refs by name.
  const artifacts = `kg-ended-${++artifactsNames}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'ann', 'app', 'private', '${artifacts}', 'https://app');
    INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('repo', '${oid(1)}');
  `);
  const git = fakeRemotes();
  git.add("https://app", { "refs/heads/main": oid(1) }, "refs/heads/main", artifacts);
  const fastRemote = git.add(
    "https://fast",
    { "refs/heads/work": oid(2) },
    "refs/heads/work",
    `${artifacts}-fast`,
  );
  const sideRemote = git.add(
    "https://side",
    { "refs/heads/work": oid(3) },
    "refs/heads/work",
    `${artifacts}-side`,
  );
  for (const slug of ["fast", "side"])
    sqlite
      .prepare(`
    INSERT INTO timeline_work_sources
      (source_id, repo_id, timeline_id, timeline_slug, owner_id, artifacts_name, artifacts_remote,
       state, allocation_operation_id, fork_source_id, fork_commit, fork_tree, fork_ref,
       initial_token_revoked, created_at, updated_at, initial_source_id, initial_commit, initial_tree, initial_ref)
    VALUES (?, 'repo', ?, ?, 'ann', ?, ?, 'ready', ?, 'canonical', ?, 'tree', 'refs/heads/main', 1, 'now', 'now',
      'canonical', '${oid(1)}', 'tree', 'refs/heads/main')
  `)
      .run(
        `work_${slug}`,
        slug,
        slug,
        `${artifacts}-${slug}`,
        `https://${slug}`,
        `op-${slug}`,
        oid(1),
      );
  vi.stubGlobal("fetch", git.fetch);
  // Timelines in Ann's tracker; `side` has no record (someone's own branch).
  const timelines: Record<string, TimelineStatus> = { fast: "active" };
  const builds = vi.fn(async (_options: { id: string; params: unknown }) => undefined);
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    KNOWLEDGE_BUILD: {
      create: builds,
      get: async () => ({ status: async () => ({ status: "running" }), terminate: async () => {} }),
    },
    TRACKER: {
      getByName: () => ({
        timeline: async (slug: string) =>
          timelines[slug]
            ? { ok: true, value: { timeline: { slug, status: timelines[slug] }, events: [] } }
            : { ok: false, error: { code: "not_found", message: "No timeline.", status: 404 } },
      }),
    },
  } as unknown as Env;
  const coordinator = new KnowledgeCoordinator(objectState(), env);

  /** A push: the coordinator wakes after its quiet period and scans the bookmarks. */
  const push = async () => {
    await coordinator.notify("repo");
    await coordinator.alarm();
  };
  /** The overlays the coordinator started since the last call, by bookmark. */
  const started = () => {
    const out = builds.mock.calls.map(([{ id, params }]) => {
      const { overlay } = params as { overlay: { ref: string } };
      return [overlay.ref, id] as const;
    });
    builds.mockClear();
    return new Map(out);
  };
  /** What a finished overlay run leaves: its row, one change, and the coordinator told. */
  const finish = async (ref: string, buildId: string, commit: string) => {
    sqlite.exec(`
      INSERT INTO kg_overlays (repo_id, source_id, ref, overlay_id, head_commit, base_commit, stats,
          updated_at, status, attempted_commit)
        VALUES ('repo', 'work_${ref === FAST ? "fast" : "side"}', '${ref}', '${buildId}', '${commit}', '${oid(1)}',
          '{"counts":{"file":{"added":1,"changed":0,"removed":0}},"stored":1}',
          '2026-10-01T00:00:00.000Z', 'succeeded', '${commit}')
        ON CONFLICT (repo_id, source_id, ref) DO UPDATE SET overlay_id = excluded.overlay_id,
          head_commit = excluded.head_commit;
      INSERT INTO kg_overlay_changes (repo_id, overlay_id, node_id, kind, change, name, path)
        VALUES ('repo', '${buildId}', 'file:new.ts', 'file', 'added', 'new.ts', 'new.ts');
    `);
    await coordinator.overlayFinished(ref, buildId, true, null, oid(1));
  };
  const overlays = () =>
    sqlite
      .prepare(
        "SELECT ref, head_commit, ended_reason, ended_at IS NOT NULL AS ended FROM kg_overlays ORDER BY ref",
      )
      .all();

  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  server.route("/api/repos/:owner/:name/knowledge", knowledge);
  const token = (await issueToken(env.DB, "ann", "t", "read")).secret;
  const executionCtx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const get = async <T>(path: string) => {
    const response = await server.request(
      `/api/repos/ann/app/knowledge${path}`,
      { headers: { authorization: `Bearer ${token}` } },
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  return { sqlite, fastRemote, sideRemote, timelines, push, started, finish, overlays, get };
}

describe("ended overlays", () => {
  test("outlive their bookmark, read-only, and are never computed again", async () => {
    const t = await setup();
    await t.push();
    const first = t.started();
    expect([...first.keys()].sort()).toEqual([FAST, SIDE]);
    await t.finish(FAST, first.get(FAST)!, oid(2));
    await t.finish(SIDE, first.get(SIDE)!, oid(3));

    // `fast` is abandoned (the tracker ends it, then deletes its bookmark);
    // `side`'s bookmark is deleted by hand.
    t.timelines.fast = "abandoned";
    t.fastRemote.refs.delete("refs/heads/work");
    t.sideRemote.refs.delete("refs/heads/work");
    await t.push();
    expect(t.started().size).toBe(0);
    expect(t.overlays()).toEqual([
      { ref: FAST, head_commit: oid(2), ended_reason: "abandoned", ended: 1 },
      { ref: SIDE, head_commit: oid(3), ended_reason: "ended", ended: 1 },
    ]);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM kg_overlay_changes").get()).toEqual({
      n: 2,
    });

    // The API lists both, ended, with their last diffs.
    const { overlays } = await t.get<{ overlays: KnowledgeOverlaySummary[] }>("/overlays");
    expect(overlays.map((o) => [o.ref, o.state, o.head, o.commit, o.ended?.reason])).toEqual([
      ["timeline/fast", "ended", null, oid(2), "abandoned"],
      ["timeline/side", "ended", null, oid(3), "ended"],
    ]);
    const fast = await t.get<KnowledgeOverlay>("/overlay?ref=timeline/fast");
    expect(fast).toMatchObject({
      state: "ended",
      ended: { reason: "abandoned" },
      counts: { file: { added: 1, changed: 0, removed: 0 } },
    });
    expect(fast.changes.map((c) => [c.change, c.id])).toEqual([["added", "file:new.ts"]]);

    // The bookmarks come back. The abandoned timeline's overlay stays as it
    // was; `side` never ended as far as the tracker knows, so it goes on.
    t.fastRemote.refs.set("refs/heads/work", oid(4));
    t.sideRemote.refs.set("refs/heads/work", oid(5));
    await t.push();
    expect([...t.started().keys()]).toEqual([SIDE]);
    expect(t.overlays()).toEqual([
      { ref: FAST, head_commit: oid(2), ended_reason: "abandoned", ended: 1 },
      { ref: SIDE, head_commit: oid(3), ended_reason: null, ended: 0 },
    ]);
    await t.push();
    expect(t.started().size).toBe(0);
    const again = await t.get<KnowledgeOverlay>("/overlay?ref=timeline/fast");
    expect([again.state, again.commit, again.ended?.reason]).toEqual([
      "ended",
      oid(2),
      "abandoned",
    ]);
  });

  test("learn later that a timeline landed after its bookmark went", async () => {
    const t = await setup();
    await t.push();
    const first = t.started();
    await t.finish(FAST, first.get(FAST)!, oid(2));
    await t.finish(SIDE, first.get(SIDE)!, oid(3));
    // The bookmark goes before the landing is recorded.
    t.timelines.fast = "landing";
    t.fastRemote.refs.delete("refs/heads/work");
    await t.push();
    expect(t.overlays()[0]).toMatchObject({ ref: FAST, ended_reason: "ended" });
    t.timelines.fast = "landed";
    const fast = await t.get<KnowledgeOverlay>("/overlay?ref=timeline/fast");
    expect(fast.ended?.reason).toBe("landed");
    expect(t.overlays()[0]).toMatchObject({ ref: FAST, ended_reason: "landed" });
  });

  test("say when retention removed an ended overlay; a returning bookmark computes it afresh", async () => {
    const t = await setup();
    await t.push();
    const first = t.started();
    await t.finish(FAST, first.get(FAST)!, oid(2));
    await t.finish(SIDE, first.get(SIDE)!, oid(3));
    t.sideRemote.refs.delete("refs/heads/work");
    await t.push();
    const before = await t.get<KnowledgeOverlay>("/overlay?ref=timeline/side");
    expect(before.ended).toEqual({ reason: "ended", at: expect.any(String), removedAt: null });

    // 100 days later, "ended-timeline-data" (90 days) empties it.
    const now = new Date(Date.parse(before.ended!.at) + 100 * 86_400_000);
    const ctx = {
      env: { DB: d1(t.sqlite) } as unknown as Env,
      target: { scope: "account", accountId: "ann" } as const,
      thresholds: { days: 90 },
      now,
      limit: 10,
    };
    const { items } = await endedTimelineData.select(ctx, null);
    expect(items.map((i) => i.ref)).toEqual([SIDE]);
    expect(await endedTimelineData.remove(ctx, items)).toMatchObject({ count: 1 });

    const side = await t.get<KnowledgeOverlay>("/overlay?ref=timeline/side");
    expect(side).toMatchObject({
      state: "ended",
      ended: { reason: "ended", removedAt: now.toISOString() },
      counts: {},
      changes: [],
    });
    const { overlays } = await t.get<{ overlays: KnowledgeOverlaySummary[] }>("/overlays");
    expect(overlays.map((o) => [o.ref, o.ended?.removedAt ?? null])).toEqual([
      ["timeline/fast", null],
      ["timeline/side", now.toISOString()],
    ]);

    // The bookmark comes back: the overlay is computed again from scratch.
    t.sideRemote.refs.set("refs/heads/work", oid(3));
    await t.push();
    expect([...t.started().keys()]).toEqual([SIDE]);
    expect(t.overlays()[1]).toEqual({ ref: SIDE, head_commit: null, ended_reason: null, ended: 0 });
  });
});
