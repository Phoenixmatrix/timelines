// Incremental Atlas projection (CORE-166): a snapshot built from the change
// feed must publish exactly what a full pass over the same graph and history
// publishes, and never ask the model again for inputs it has seen.

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
import {
  atlasPass,
  changeFiles,
  countingInfer,
  renameConcept,
  storeGraph,
  syntheticRepo,
  type PassOptions,
  type SyntheticRepo,
} from "../testing/atlas-repo.ts";
import { FEED_LIMIT } from "./feed.ts";
import { ENTITY_BATCH, repoScope } from "./projection.ts";

const scope = repoScope("r1");

async function database() {
  const { sqlite, close } = await createFreshSpaceTestEnvironment();
  onTestFinished(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id)
      VALUES ('org-ann', 'personal-ann', 'ann', 'personal', 'ann', 'ann');
    INSERT INTO spaces (id, organization_id, slug, display_name)
      VALUES ('ann', 'org-ann', 'ann', 'ann');
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by)
      VALUES ('org-ann', 'ann', 'owner', 'test-fixture', 'ann');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
      VALUES ('ann', 'org-ann', 'ann', 'admin', 'write', 'write', 'test-fixture', 'ann');
    INSERT INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail)
      VALUES ('audit-ann', 'org-ann', 'ann', 'ann', 'space.grant', 'ann', '{"origin":"test-fixture"}');
    COMMIT;
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'big', 'private', 'art-r1', '');
  `);
  return { sqlite, db: d1(sqlite) };
}

/** What a published snapshot shows: every visible entity and edge, and its totals. */
function published(sqlite: DatabaseSync) {
  const { seq } = sqlite.prepare("SELECT seq FROM atlas_current WHERE scope = ?").get(scope) as {
    seq: number;
  };
  const visible = "scope = ? AND from_seq <= ? AND (to_seq IS NULL OR to_seq > ?)";
  return {
    seq,
    snapshot: sqlite
      .prepare(
        `SELECT status, partial, entities, edges, bytes, grouping_version FROM atlas_snapshots WHERE scope = ? AND seq = ?`,
      )
      .get(scope, seq),
    entities: sqlite
      .prepare(
        `SELECT entity_id, kind, parent_id, sort_key, name, path, summary, data, content_hash
         FROM atlas_entities WHERE ${visible} ORDER BY entity_id`,
      )
      .all(scope, seq, seq),
    edges: sqlite
      .prepare(
        `SELECT src, dst, kind, weight FROM atlas_edges WHERE ${visible} ORDER BY src, dst, kind`,
      )
      .all(scope, seq, seq),
    lineage: sqlite.prepare(`SELECT * FROM atlas_lineage ORDER BY entity_id, retired_seq`).all(),
  };
}

/** Inputs hashes the description cache already holds. */
const cachedInputs = (sqlite: DatabaseSync) =>
  new Set(
    (sqlite.prepare("SELECT key FROM kg_synthesis").all() as { key: string }[]).map((r) => r.key),
  );

/** The inputs hash behind each current capability description. */
function inputsHashes(sqlite: DatabaseSync): string[] {
  const { seq } = sqlite.prepare("SELECT seq FROM atlas_current WHERE scope = ?").get(scope) as {
    seq: number;
  };
  return (
    sqlite
      .prepare(
        `SELECT json_extract(data, '$.provenance.inferred.inputsHash') AS h FROM atlas_entities
         WHERE scope = ? AND kind = 'capability' AND from_seq <= ? AND (to_seq IS NULL OR to_seq > ?)`,
      )
      .all(scope, seq, seq) as { h: string }[]
  ).map((r) => r.h);
}

/** Two copies of one repository history: `inc` projects from the feed, `full` reads everything. */
async function twins(files: number) {
  const inc = {
    ...(await database()),
    repo: syntheticRepo(files, 7),
    calls: { n: 0, hashes: [] as string[] },
  };
  const full = {
    ...(await database()),
    repo: syntheticRepo(files, 7),
    calls: { n: 0, hashes: [] as string[] },
  };
  const batches = { entityBatch: 40, edgeBatch: 150 };
  return {
    inc,
    full,
    /** The same push to both: change their repositories alike, then store the graph. */
    async push(buildId: string, change: (repo: SyntheticRepo) => void) {
      for (const side of [inc, full]) {
        change(side.repo);
        await storeGraph(side.sqlite, side.db, side.repo, "r1", buildId);
      }
    },
    async project(buildId: string, options: PassOptions = {}) {
      const a = await atlasPass(inc.db, "r1", buildId, {
        ...batches,
        infer: countingInfer(inc.calls),
        ...options,
      });
      const b = await atlasPass(full.db, "r1", buildId, {
        ...batches,
        infer: countingInfer(full.calls),
        ...options,
        full: true,
      });
      return { inc: a, full: b };
    },
  };
}

// Each test runs two whole projection histories: allow slow CI sandboxes time.
describe("incremental projection", { timeout: 60_000 }, () => {
  test("publishes exactly what a full pass publishes, push after push", async () => {
    const t = await twins(320);
    await t.push("b1", () => {});
    const first = await t.project("b1");
    // Nothing published yet: the first projection reads everything.
    expect(first.inc.start.incremental).toBe(false);
    expect(published(t.inc.sqlite)).toEqual(published(t.full.sqlite));
    expect(t.inc.calls.n).toBeGreaterThan(0);

    const pushes: [string, (repo: SyntheticRepo) => void, { regrouped: boolean }][] = [
      // An edit that leaves imports and concepts alone keeps the groups.
      ["edit", (repo) => changeFiles(repo, 1), { regrouped: false }],
      // Ten files: edits, rewired imports, one added and one removed.
      ["ten", (repo) => changeFiles(repo, 10), { regrouped: true }],
      // A file whose analysis hasn't landed leaves its capability.
      ["pending", (repo) => repo.pending.add([...repo.files.keys()][5]!), { regrouped: true }],
      ["analyzed", (repo) => repo.pending.clear(), { regrouped: true }],
      // A concept renamed: same concept, same mentions, new names.
      ["rename", (repo) => renameConcept(repo, "m0 topic 1", "M0 Topic 1"), { regrouped: true }],
    ];
    let pushed = 0;
    let kept = 0;
    for (const [name, change, expected] of pushes) {
      await t.push(name, change);
      const before = { inc: t.inc.calls.n, full: t.full.calls.n };
      const seen = cachedInputs(t.inc.sqlite);
      const result = await t.project(name);
      expect(result.inc.start.incremental, name).toBe(true);
      expect(result.full.start.incremental, name).toBe(false);
      expect(result.inc.grouping.regrouped, name).toBe(expected.regrouped);
      expect(published(t.inc.sqlite), name).toEqual(published(t.full.sqlite));
      // Both asked the model about the same new inputs, and only those.
      expect(t.inc.calls.n - before.inc, name).toBe(t.full.calls.n - before.full);
      expect(result.inc.described?.inferred, name).toBe(t.inc.calls.n - before.inc);
      // One call per capability whose inputs hash is new; a seen hash never calls again.
      const hashes = inputsHashes(t.inc.sqlite);
      expect(t.inc.calls.n - before.inc, name).toBe(hashes.filter((h) => !seen.has(h)).length);
      pushed += t.inc.calls.n - before.inc;
      kept += hashes.filter((h) => seen.has(h)).length;
    }
    // The pushes both reused and renewed prose.
    expect(pushed).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);

    // The feed up to the published snapshot is consumed.
    expect(t.inc.sqlite.prepare("SELECT count(*) AS n FROM atlas_feed").get()).toEqual({ n: 0 });
  });

  test("an unchanged rebuild writes nothing and asks the model nothing", async () => {
    const t = await twins(200);
    await t.push("b1", () => {});
    await t.project("b1");
    const before = published(t.inc.sqlite);
    const rows = t.inc.sqlite.prepare("SELECT count(*) AS n FROM atlas_entities").get();
    const calls = t.inc.calls.n;
    const again = await t.project("b2");
    expect(again.inc.start.incremental).toBe(true);
    expect(again.inc.grouping.regrouped).toBe(false);
    expect(t.inc.calls.n).toBe(calls);
    expect(again.inc.described).toMatchObject({
      inferred: 0,
      cached: again.inc.described?.capabilities,
    });
    expect(t.inc.sqlite.prepare("SELECT count(*) AS n FROM atlas_entities").get()).toEqual(rows);
    const after = published(t.inc.sqlite);
    expect({ ...after, seq: 0, snapshot: null }).toEqual({ ...before, seq: 0, snapshot: null });
    expect(after.seq).toBe(before.seq + 1);
  });

  test("a failed projection's changes carry into the next increment", async () => {
    const t = await twins(240);
    await t.push("b1", () => {});
    await t.project("b1");
    await t.push("b2", (repo) => changeFiles(repo, 10));
    await t.project("b2", { fail: true });
    // The feed survives the failure and the published snapshot stays current.
    expect(
      (t.inc.sqlite.prepare("SELECT count(*) AS n FROM atlas_feed").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    await t.push("b3", (repo) => changeFiles(repo, 4));
    const result = await t.project("b3");
    expect(result.inc.start.incremental).toBe(true);
    expect(published(t.inc.sqlite)).toEqual(published(t.full.sqlite));
  });

  test("an incremental batch stays within the step bound and resumes by cursor", async () => {
    const t = await twins(200);
    await t.push("b1", () => {});
    await t.project("b1");
    await t.push("b2", (repo) => changeFiles(repo, 10));
    // One entity at a time: every batch is a resumable step.
    const result = await t.project("b2", { entityBatch: 1, edgeBatch: 1 });
    expect(result.inc.start.incremental).toBe(true);
    expect(published(t.inc.sqlite)).toEqual(published(t.full.sqlite));
    expect(ENTITY_BATCH).toBeLessThanOrEqual(10_000);
  });

  test("too much change, or a projection version without the feed, reads the whole graph", async () => {
    const t = await twins(120);
    await t.push("b1", () => {});
    await t.project("b1");
    // A push too big to list collapses the feed into one `full` row.
    t.inc.sqlite.exec(`DELETE FROM atlas_feed`);
    t.inc.sqlite.exec(`INSERT INTO atlas_feed (repo_id, kind) VALUES ('r1', 'full')`);
    await t.push("b2", (repo) => changeFiles(repo, 3));
    expect(t.inc.sqlite.prepare("SELECT kind FROM atlas_feed").all()).toEqual([{ kind: "full" }]);
    const big = await t.project("b2");
    expect(big.inc.start.incremental).toBe(false);
    expect(published(t.inc.sqlite)).toEqual(published(t.full.sqlite));

    // A snapshot published before the feed existed has no mark: the next is full.
    t.inc.sqlite.exec(`UPDATE atlas_snapshots SET feed_mark = NULL`);
    await t.push("b3", (repo) => changeFiles(repo, 3));
    expect((await t.project("b3")).inc.start.incremental).toBe(false);
    await t.push("b4", (repo) => changeFiles(repo, 3));
    expect((await t.project("b4")).inc.start.incremental).toBe(true);
    expect(published(t.inc.sqlite)).toEqual(published(t.full.sqlite));
  });

  test("the feed holds at most FEED_LIMIT listed changes, then one full row", async () => {
    const { sqlite, db } = await database();
    const repo = syntheticRepo(150, 3);
    await storeGraph(sqlite, db, repo, "r1", "b1");
    const listed = (sqlite.prepare("SELECT count(*) AS n FROM atlas_feed").get() as { n: number })
      .n;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThanOrEqual(FEED_LIMIT);
    sqlite
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO atlas_feed (repo_id, kind, src) SELECT 'r1', 'node', 'x' || i FROM n`,
      )
      .run(FEED_LIMIT - listed);
    changeFiles(repo, 3);
    await storeGraph(sqlite, db, repo, "r1", "b2");
    expect(
      sqlite.prepare("SELECT kind, count(*) AS n FROM atlas_feed GROUP BY kind").all(),
    ).toEqual([{ kind: "full", n: 1 }]);
  });
});
