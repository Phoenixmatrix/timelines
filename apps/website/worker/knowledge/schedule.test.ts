// Batched Knowledge updates (CORE-286): pushes to main mark Knowledge
// pending, and one update runs at the latest head once pushes pause for the
// quiet period, or at the longest wait after the first pending push. An
// admin's "update now", an explicit rebuild and a repository's first build
// don't wait. The status says what is pending and when it will be built.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
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
const MIN = 60_000;
const T0 = Date.parse("2026-10-05T12:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function objectState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarm: () => alarm,
    state: {
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => void (alarm = at),
        deleteAlarm: async () => void (alarm = null),
      },
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    } as unknown as DurableObjectState,
  };
}

let names = 0;

function setup(options: { indexed?: boolean; settings?: [number, number] } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const sqlite = migratedDatabase();
  const artifacts = `kg-schedule-${++names}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'ann', 'app', 'private', '${artifacts}', 'https://app');
  `);
  if (options.indexed !== false)
    sqlite.exec(`INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('repo', '${oid(1)}')`);
  if (options.settings)
    sqlite.exec(`INSERT INTO account_settings (account_id, knowledge_quiet_minutes, knowledge_max_wait_minutes)
      VALUES ('ann', ${options.settings[0]}, ${options.settings[1]})`);
  const git = fakeRemotes();
  const remote = git.add("https://app", { "refs/heads/main": oid(1) });
  vi.stubGlobal("fetch", git.fetch);
  const builds: { id: string; params: Record<string, unknown> }[] = [];
  const running = new Set<string>();
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    TIMELINE_QUIET_SECONDS: "0",
    KNOWLEDGE_BUILD: {
      create: async (b: { id: string; params: Record<string, unknown> }) => {
        // Main's builds only; timeline overlays have their own tests.
        if (!b.params.overlay) builds.push(b);
        running.add(b.id);
      },
      get: async (id: string) => ({
        status: async () => ({ status: running.has(id) ? "running" : "complete" }),
        terminate: async () => {},
      }),
    },
  } as unknown as Env;
  const object = objectState();
  const coordinator = new KnowledgeCoordinator(object.state, env);
  /** The alarm fires: like a Durable Object's, it is unset while its handler runs. */
  const fire = async () => {
    await object.state.storage.deleteAlarm();
    await coordinator.alarm();
  };
  let head = 1;
  return {
    sqlite,
    coordinator,
    builds,
    /** Advance the clock to `minutes` after T0 and run the alarm if it is due. */
    async at(minutes: number) {
      vi.setSystemTime(T0 + minutes * MIN);
      const alarm = object.alarm();
      if (alarm !== null && alarm <= Date.now()) await fire();
    },
    /** A push to main at `minutes` after T0; the coordinator looks after its debounce. */
    async push(minutes: number, options: { main?: boolean } = {}) {
      vi.setSystemTime(T0 + minutes * MIN);
      if (options.main !== false) remote.refs.set("refs/heads/main", oid(++head));
      else remote.refs.set("refs/heads/timeline/side", oid(100 + minutes));
      await coordinator.notify("repo");
      vi.setSystemTime(T0 + minutes * MIN + 2_000);
      await fire();
      return oid(head);
    },
    /** The running build ends, having indexed its commit. */
    async finish(minutes: number) {
      vi.setSystemTime(T0 + minutes * MIN);
      const build = builds.at(-1)!;
      running.delete(build.id);
      sqlite.exec(
        `INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('repo', '${String(build.params.commit)}')
         ON CONFLICT (repo_id) DO UPDATE SET indexed_commit = excluded.indexed_commit`,
      );
      await coordinator.finished(build.id, true, null);
      vi.setSystemTime(T0 + minutes * MIN + 1_000);
      await fire();
    },
    alarm: () => object.alarm(),
  };
}

describe("batched Knowledge updates", () => {
  test("pushes wait for the quiet period, then one update builds the latest head", async () => {
    const t = setup();
    await t.push(0);
    await t.push(4);
    const last = await t.push(7);
    expect(t.builds).toEqual([]);
    const status = await t.coordinator.status();
    expect(status.pending).toBe(true);
    expect(status.update).toMatchObject({ head: last, pushes: 3, now: false });
    // Ten minutes after the last push (its debounce included).
    expect(status.update!.dueAt).toBe(T0 + 7 * MIN + 2_000 + 10 * MIN);
    expect(t.alarm()).toBe(status.update!.dueAt);
    await t.at(16);
    expect(t.builds).toEqual([]);
    await t.at(17.1);
    expect(t.builds).toHaveLength(1);
    expect(t.builds[0]!.params).toMatchObject({ commit: last, pushes: 3, force: false });
    expect((await t.coordinator.status()).update).toBeNull();
  });

  test("steady pushes never wait longer than the longest wait after the first", async () => {
    const t = setup();
    for (let minute = 0; minute <= 32; minute += 4) {
      await t.at(minute);
      if (t.builds.length) break;
      await t.push(minute);
    }
    // Pushes every four minutes never go quiet for ten: the build starts at
    // the thirty-minute cap, at the head it saw last.
    expect(t.builds).toHaveLength(1);
    expect(t.builds[0]!.params).toMatchObject({ pushes: 8 });
  });

  test("pushes during an update wait for their own window, not for the build to end", async () => {
    const t = setup();
    await t.push(0);
    await t.at(10.1);
    expect(t.builds).toHaveLength(1);
    const during = await t.push(12);
    await t.finish(14);
    // Not right away: the push at 12 waits for its quiet period.
    expect(t.builds).toHaveLength(1);
    expect((await t.coordinator.status()).update).toMatchObject({ head: during, pushes: 1 });
    await t.at(22.1);
    expect(t.builds).toHaveLength(2);
    expect(t.builds[1]!.params).toMatchObject({ commit: during, pushes: 1 });
  });

  test("an admin's update now, an explicit rebuild and a first build don't wait", async () => {
    const t = setup();
    const head = await t.push(0);
    await t.coordinator.notify("repo", { now: true });
    await t.at(0.1);
    expect(t.builds).toHaveLength(1);
    expect(t.builds[0]!.params).toMatchObject({ commit: head, force: false });
    await t.finish(1);

    await t.coordinator.notify("repo", { force: true });
    await t.at(1.2);
    expect(t.builds).toHaveLength(2);
    expect(t.builds[1]!.params).toMatchObject({ force: true });

    const first = setup({ indexed: false });
    await first.push(0);
    expect(first.builds).toHaveLength(1);
  });

  test("a push that moves only a timeline leaves nothing pending", async () => {
    const t = setup();
    await t.push(0, { main: false });
    const status = await t.coordinator.status();
    expect(status.pending).toBe(false);
    expect(status.update).toBeNull();
    // Update now with nothing pending has nothing to build.
    await t.coordinator.notify("repo", { now: true });
    await t.at(0.2);
    expect(t.builds).toEqual([]);
  });

  test("an account's own windows", async () => {
    const t = setup({ settings: [2, 5] });
    await t.push(0);
    await t.push(1.5);
    await t.push(3);
    await t.at(4.9);
    expect(t.builds).toEqual([]);
    // Five minutes after the first push, though the last was two minutes ago.
    await t.at(5.1);
    expect(t.builds).toHaveLength(1);
  });
});
