// Push log retention (CORE-202) over D1 through the engine: exactly the old
// entries and stale change refs, never a live ref's latest entry or a kept
// change ref (nor, through the cascade, its first entry); dry run = run;
// idempotent; resumable.

import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment } from "../../testing/spaces.ts";
import { advanceRun, createRun, getRun, SimulatedCrash } from "../runs.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const oid = (n: number) => n.toString(16).padStart(40, "0");
const ORBIT = { kind: "space", id: "orbit" } as const;

/**
 * Orbit's repository `app` has branches main and live (existing) and a
 * deleted timeline bookmark; Sam's repository is another account's. Every
 * entry and change ref is named for what the policy (365 days) must do.
 */
async function seeded() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`BEGIN; 
    INSERT INTO organizations (id,slug,display_name,kind,default_space_id) VALUES
      ('org_orbit','orbit-company','Orbit','company','orbit'),
      ('org_sam','sam-company','Sam','company','sam');
    INSERT INTO spaces (id,organization_id,slug,display_name) VALUES
      ('orbit','org_orbit','orbit','Orbit'), ('sam','org_sam','sam','Sam');
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'a', 'https://a'),
      ('lib', 'orbit', 'lib', 'private', 'b', 'https://b'),
      ('mine', 'sam', 'mine', 'private', 'c', 'https://c');
    INSERT INTO repo_refs (repo_id, ref, oid) VALUES
      ('app', 'refs/heads/main', '${oid(3)}'),
      ('app', 'refs/heads/live', '${oid(20)}'),
      ('mine', 'refs/heads/main', '${oid(31)}');
   COMMIT;`);
  const update = sqlite.prepare(
    "INSERT INTO ref_updates (id, repo_id, ref, old_oid, new_oid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const changeRef = sqlite.prepare(
    `INSERT INTO change_refs (repo_id, change_id, ref, first_commit_oid, first_update_id, first_seen_at, last_commit_oid, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // main: three old entries; the newest (3) is main's latest, kept.
  update.run(1, "app", "refs/heads/main", null, oid(1), ago(900)); // old: selected
  update.run(2, "app", "refs/heads/main", oid(1), oid(2), ago(800)); // old, but a kept change ref's first entry
  update.run(3, "app", "refs/heads/main", oid(2), oid(3), ago(700)); // main's latest: kept
  // live: one old entry, its latest: kept.
  update.run(20, "app", "refs/heads/live", null, oid(20), ago(600));
  // A timeline bookmark created, pushed and deleted long ago: all selected.
  update.run(10, "app", "refs/heads/timeline/old", null, oid(10), ago(500));
  update.run(11, "app", "refs/heads/timeline/old", oid(10), null, ago(499));
  // Recent entries: kept.
  update.run(12, "app", "refs/heads/timeline/new", null, oid(12), ago(10));
  update.run(13, "app", "refs/heads/timeline/new", oid(12), null, ago(9));
  update.run(14, "lib", "refs/heads/gone", null, oid(14), ago(400)); // old, gone ref: selected
  // Another account's old entries: never.
  update.run(30, "mine", "refs/heads/old", null, oid(30), ago(900));
  update.run(31, "mine", "refs/heads/main", null, oid(31), ago(900));
  // Change refs: on main (exists, kept whatever its age), on the deleted
  // bookmark (stale: selected), on the recent bookmark (gone but recent:
  // kept), another account's.
  changeRef.run("app", "ch_main", "refs/heads/main", oid(2), 2, ago(800), oid(2), ago(800));
  changeRef.run(
    "app",
    "ch_old",
    "refs/heads/timeline/old",
    oid(10),
    10,
    ago(500),
    oid(10),
    ago(500),
  );
  changeRef.run(
    "app",
    "ch_main",
    "refs/heads/timeline/old",
    oid(10),
    10,
    ago(500),
    oid(10),
    ago(500),
  );
  changeRef.run("app", "ch_new", "refs/heads/timeline/new", oid(12), 12, ago(10), oid(12), ago(10));
  changeRef.run("mine", "ch_sam", "refs/heads/old", oid(30), 30, ago(900), oid(30), ago(900));
  // A stale change ref whose entry is too recent to go: the ref stays gone,
  // the change ref goes, the entry stays.
  update.run(15, "app", "refs/heads/timeline/brief", null, oid(15), ago(100));
  changeRef.run(
    "app",
    "ch_brief",
    "refs/heads/timeline/brief",
    oid(15),
    15,
    ago(400),
    oid(15),
    ago(400),
  );
  const env = { ...fresh.env, JOBS: { send: async () => undefined } } as unknown as Env;
  const updates = () =>
    (sqlite.prepare("SELECT id FROM ref_updates ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
  const changeRefs = () =>
    (
      sqlite.prepare("SELECT change_id || ' ' || ref AS k FROM change_refs ORDER BY k").all() as {
        k: string;
      }[]
    ).map((r) => r.k);
  return { sqlite, env, updates, changeRefs };
}

const UPDATES_GONE = [1, 10, 11, 14];
const CHANGE_REFS_GONE = [
  "ch_brief refs/heads/timeline/brief",
  "ch_main refs/heads/timeline/old",
  "ch_old refs/heads/timeline/old",
];

async function run(
  env: Env,
  dryRun: boolean,
  options: Parameters<typeof advanceRun>[2] = {},
  days = 365,
) {
  const id = await createRun(env.DB, {
    target: ORBIT,
    trigger: "schedule",
    actorId: null,
    dryRun,
    categories: [{ id: "push-log", thresholds: { days } }],
    now: NOW,
  });
  const seen: string[] = [];
  let state;
  do {
    state = await advanceRun(env, id, {
      now: NOW,
      limit: 2,
      ...options,
      afterBatch: async (category, items) => {
        seen.push(...(items as { kind: string; id: number }[]).map((i) => `${i.kind}${i.id}`));
        await options.afterBatch?.(category, items);
      },
    });
  } while (state === "more");
  return { id, seen, run: (await getRun(env.DB, ORBIT, id))! };
}

describe("push log retention", () => {
  test("selects exactly the old entries and stale change refs; the run removes what the dry run listed", async () => {
    const t = await seeded();
    const updates = t.updates();
    const changeRefs = t.changeRefs();
    const dry = await run(t.env, true);
    expect(t.updates()).toEqual(updates);
    expect(t.changeRefs()).toEqual(changeRefs);
    // Three stale change refs, then four entries.
    expect(dry.seen.filter((s) => s.startsWith("u"))).toEqual(UPDATES_GONE.map((id) => `u${id}`));
    expect(dry.seen.filter((s) => s.startsWith("c"))).toHaveLength(3);
    expect(dry.run).toMatchObject({ status: "succeeded", items: 7 });

    const real = await run(t.env, false);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ status: "succeeded", items: 7, bytes: dry.run.bytes });
    expect(t.updates()).toEqual(updates.filter((id) => !UPDATES_GONE.includes(id)));
    expect(t.changeRefs()).toEqual(changeRefs.filter((k) => !CHANGE_REFS_GONE.includes(k)));

    const again = await run(t.env, false);
    expect(again.seen).toEqual([]);
    expect(again.run).toMatchObject({ status: "succeeded", items: 0, bytes: 0 });
  });

  test("the threshold decides the cutoff", async () => {
    const t = await seeded();
    expect((await run(t.env, true, {}, 850)).seen.filter((s) => s.startsWith("u"))).toEqual(["u1"]);
    const short = await run(t.env, true, {}, 1);
    // Every old entry but the live refs' latest and the kept change ref's first.
    expect(short.seen.filter((s) => s.startsWith("u"))).toEqual(
      [1, 10, 11, 12, 13, 14, 15].map((id) => `u${id}`),
    );
  });

  test("an entry whose change ref becomes current again is kept", async () => {
    const t = await seeded();
    // The old bookmark comes back: its change refs are current again.
    t.sqlite.exec(
      `INSERT INTO repo_refs (repo_id, ref, oid) VALUES ('app', 'refs/heads/timeline/old', '${oid(10)}')`,
    );
    const dry = await run(t.env, true);
    expect(dry.seen.filter((s) => s.startsWith("u"))).toEqual(["u1", "u14"]);
    expect(dry.seen.filter((s) => s.startsWith("c"))).toHaveLength(1);
  });

  test("a run interrupted after a delete resumes to the same end", async () => {
    const t = await seeded();
    const id = await createRun(t.env.DB, {
      target: ORBIT,
      trigger: "schedule",
      actorId: null,
      dryRun: false,
      categories: [{ id: "push-log", thresholds: { days: 365 } }],
      now: NOW,
    });
    let batches = 0;
    await expect(
      advanceRun(t.env, id, {
        now: NOW,
        limit: 2,
        afterBatch: () => {
          if (++batches === 3) throw new SimulatedCrash("killed");
        },
      }),
    ).rejects.toThrow("killed");
    // A later worker (the lease lapsed) finishes it.
    const later = new Date(NOW.getTime() + 15 * 60_000);
    while ((await advanceRun(t.env, id, { now: later, limit: 2 })) === "more");
    expect((await getRun(t.env.DB, ORBIT, id))!.status).toBe("succeeded");
    expect(t.updates()).toEqual([2, 3, 12, 13, 15, 20, 30, 31].sort((a, b) => a - b));
    expect(t.changeRefs()).toEqual([
      "ch_main refs/heads/main",
      "ch_new refs/heads/timeline/new",
      "ch_sam refs/heads/old",
    ]);
  });
});
