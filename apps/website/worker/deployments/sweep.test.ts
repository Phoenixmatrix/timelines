// Preview expiry (CORE-79): the account's retention, the sweep that tears
// timeline previews down, and records that stay.

import { describe, expect, test, vi } from "vite-plus/test";
import { previewExpiry } from "../../shared/deployments.ts";
import type { Timeline } from "../../shared/timelines.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { sweepPreviews } from "./sweep.ts";

// Teardown runs go through CI's startRun: recorded here, never run.
const startRun = vi.hoisted(() => vi.fn());
vi.mock(import("../ci/trigger.ts"), async (original) => ({ ...(await original()), startRun }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const oid = (n: number) => n.toString(16).padStart(40, "0");

function timeline(
  id: string,
  status: Timeline["status"],
  pushedDaysAgo: number,
  updatedDaysAgo = pushedDaysAgo,
): Timeline {
  return {
    id,
    slug: id,
    status,
    createdAt: ago(30),
    pushedAt: ago(pushedDaysAgo),
    updatedAt: ago(updatedDaysAgo),
  } as Timeline;
}

describe("previewExpiry", () => {
  const settings = { endedDays: 2, idleDays: 7 };
  const at = (t: Timeline | null, created = ago(5), revived = false) =>
    previewExpiry({ timeline: t, createdAt: created, revived }, settings);

  test("idle days after the last push, or ended days after landing or abandoning", () => {
    expect(at(timeline("a", "active", 3))).toBe(ago(-4));
    expect(at(timeline("a", "waiting", 10))).toBe(ago(3));
    expect(at(timeline("a", "landed", 3, 1))).toBe(ago(-1));
    expect(at(timeline("a", "abandoned", 3, 1))).toBe(ago(-1));
    // Whichever comes first: idle long before it landed.
    expect(at(timeline("a", "landed", 9, 0))).toBe(ago(2));
    expect(at(null, ago(5))).toBe(ago(-2));
  });

  test("an ended timeline counts from when it ended, not its later changes", () => {
    // Landed 3 days ago, renamed yesterday: two days after landing has passed.
    const landed = { ...timeline("a", "landed", 5, 1), endedAt: ago(3) };
    expect(at(landed)).toBe(ago(1));
    const abandoned = { ...timeline("a", "abandoned", 5, 0), endedAt: ago(1) };
    expect(at(abandoned)).toBe(ago(-1));
    // A record from before endedAt ended at its last change.
    expect(at({ ...timeline("a", "landed", 5, 1), endedAt: null })).toBe(ago(-1));
  });

  test("a revived preview counts from its revival", () => {
    expect(at(timeline("a", "landed", 20, 10), ago(1), true)).toBe(ago(-1));
    expect(at(timeline("a", "active", 20), ago(1), true)).toBe(ago(-6));
    // Reviving changes nothing for a preview the rules keep longer anyway.
    expect(at(timeline("a", "active", 0), ago(3), true)).toBe(ago(-7));
  });
});

function setup(timelines: Record<string, Timeline[]>) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('orbit', 'org', 'orbit', 'Orbit'), ('nova', 'org', 'nova', 'Nova');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'a', 'https://a'),
      ('lib', 'orbit', 'lib', 'private', 'l', 'https://l'),
      ('site', 'nova', 'site', 'private', 's', 'https://s');
    -- Orbit keeps previews 1 day after landing and 3 idle days; Nova the defaults.
    INSERT INTO account_settings (account_id, preview_ended_days, preview_idle_days)
      VALUES ('orbit', 1, 3);
  `);
  let runs = 0;
  startRun.mockReset();
  startRun.mockImplementation(async (_env, repo: { id: string }, options) => {
    if (repo.id === "lib") return { skipped: "doesn't opt in", teardownUnmanaged: true };
    runs++;
    sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, preview_action)
        VALUES ('teardown-${runs}', '${repo.id}', ${100 + runs}, '${options.commit}', '${options.branch}',
                'manual', 'queued', 'teardown');
    `);
    return { runId: `teardown-${runs}`, number: 100 + runs };
  });
  const env = {
    DB: d1(sqlite),
    TRACKER: {
      getByName: (owner: string) => ({
        listTimelines: async () =>
          owner === "broken"
            ? { ok: false, status: 500, code: "x", error: "down" }
            : { ok: true, value: timelines[owner] ?? [] },
      }),
    },
  } as unknown as Env;
  let next = 1;
  const record = (
    repo: string,
    slug: string,
    options: {
      checkpoint?: string;
      created?: number;
      revived?: boolean;
      pinned?: string | null;
      status?: string;
    } = {},
  ) => {
    const id = next++;
    sqlite.exec(`
      INSERT INTO deployments (id, repo_id, environment, timeline_slug, timeline_id, checkpoint_id,
                               commit_oid, url, status, revived, expiry_pinned, expires_at, created_at)
        VALUES (${id}, '${repo}', 'timeline/${slug}', '${slug}', '${slug}',
                ${options.checkpoint ? `'${options.checkpoint}'` : "NULL"}, '${oid(id)}',
                'https://${slug}-${id}.example', '${options.status ?? "active"}',
                ${options.revived ? 1 : 0}, ${options.pinned !== undefined ? 1 : 0},
                ${options.pinned ? `'${options.pinned}'` : "NULL"}, '${ago(options.created ?? 5)}');
    `);
    return id;
  };
  const row = (id: number) =>
    sqlite
      .prepare(
        "SELECT status, expires_at, torn_down_at, teardown_run_id FROM deployments WHERE id = ?",
      )
      .get(id) as {
      status: string;
      expires_at: string | null;
      torn_down_at: string | null;
      teardown_run_id: string | null;
    };
  const sweep = () => sweepPreviews(env, { now: NOW, waitUntil: () => {} });
  return { sqlite, record, row, sweep };
}

describe("the preview sweep", () => {
  test("tears down by the org's retention: after landing and after idle days", async () => {
    const t = setup({
      orbit: [
        timeline("landed", "landed", 5, 1.5),
        timeline("idle", "active", 4),
        timeline("busy", "active", 1),
      ],
      nova: [timeline("landed", "landed", 5, 1.5)],
    });
    const landed = t.record("app", "landed", { checkpoint: "cp_l" });
    const idleOld = t.record("app", "idle", { checkpoint: "cp_1", created: 6 });
    const idleNew = t.record("app", "idle", { checkpoint: "cp_2", created: 4 });
    const busy = t.record("app", "busy");
    const novaLanded = t.record("site", "landed");

    const result = await t.sweep();
    expect(result.expired.toSorted((a, b) => a - b)).toEqual([landed, idleOld, idleNew]);
    for (const id of [landed, idleOld, idleNew]) {
      expect(t.row(id)).toMatchObject({ status: "expired", torn_down_at: expect.any(String) });
      expect(t.row(id).teardown_run_id).toMatch(/^teardown-/);
    }
    expect(t.row(idleOld).teardown_run_id).toBe(t.row(idleNew).teardown_run_id);
    // Still up: pushed a day ago (expiring 3 idle days after), and Nova's 2 days after landing.
    expect(t.row(busy)).toMatchObject({ status: "active", expires_at: ago(-2) });
    expect(t.row(novaLanded)).toMatchObject({ status: "active", expires_at: ago(-0.5) });

    // Records stay, and a second sweep tears nothing down again.
    startRun.mockClear();
    expect((await t.sweep()).expired).toEqual([]);
    expect(startRun).not.toHaveBeenCalled();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM deployments").get()).toEqual({ n: 5 });
  });

  test("a timeline's previews in a repository go together, once every one is due", async () => {
    const t = setup({ orbit: [timeline("landed", "landed", 10, 5)] });
    const original = t.record("app", "landed", { checkpoint: "cp_1", created: 6 });
    // Revived half a day ago: it counts from then, and keeps its sibling up.
    const revived = t.record("app", "landed", { checkpoint: "cp_1", created: 0.5, revived: true });
    expect((await t.sweep()).expired).toEqual([]);
    expect(t.row(revived).expires_at).toBe(ago(-0.5));
    expect(t.row(original).status).toBe("active");
  });

  test("a pinned expiry wins; a repository that doesn't opt in is still marked expired", async () => {
    const t = setup({ orbit: [timeline("pinned", "active", 0), timeline("kept", "active", 10)] });
    const pinned = t.record("app", "pinned", { pinned: ago(0.1) });
    const never = t.record("app", "kept", { pinned: null });
    const lib = t.record("lib", "pinned", { pinned: ago(1) });
    const result = await t.sweep();
    expect(result.expired.toSorted((a, b) => a - b)).toEqual([pinned, lib]);
    expect(t.row(lib)).toMatchObject({ status: "expired", teardown_run_id: null });
    expect(t.row(never)).toMatchObject({ status: "active", expires_at: null });
    expect(
      t.sqlite
        .prepare("SELECT teardown_completed_at,teardown_unmanaged_at FROM deployments WHERE id=?")
        .get(lib),
    ).toEqual({ teardown_completed_at: null, teardown_unmanaged_at: expect.any(String) });
    expect((await t.sweep()).expired).toEqual([]);
  });

  test("failed scheduling remains retryable without claiming teardown completed", async () => {
    const t = setup({ orbit: [timeline("idle", "active", 30)] });
    const id = t.record("app", "idle");
    startRun.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await t.sweep();
    expect(t.row(id)).toMatchObject({ status: "expired", teardown_run_id: null });
    expect(
      t.sqlite
        .prepare("SELECT teardown_completed_at,teardown_unmanaged_at FROM deployments WHERE id=?")
        .get(id),
    ).toEqual({ teardown_completed_at: null, teardown_unmanaged_at: null });
    await t.sweep();
    expect(t.row(id).teardown_run_id).toMatch(/^teardown-/);
    t.sqlite.close();
  });

  test("leaves records alone when the account's tracker can't answer, and failed ones always", async () => {
    const t = setup({ orbit: [timeline("idle", "active", 30)] });
    t.sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('broken', 'org', 'broken', 'B');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('gone', 'broken', 'gone', 'private', 'g', 'https://g');
    `);
    const unknown = t.record("gone", "idle");
    const failed = t.record("app", "idle", { status: "failed" });
    expect((await t.sweep()).expired).toEqual([]);
    expect(t.row(unknown).status).toBe("active");
    expect(t.row(failed).status).toBe("failed");
  });
});
