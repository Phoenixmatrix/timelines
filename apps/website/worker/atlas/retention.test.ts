import { describe, expect, test } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  beginRepoProjection,
  currentSnapshot,
  EDGE_BYTES_SQL,
  ENTITY_BYTES_SQL,
  entityAt,
  edgesAt,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";
import {
  admitProjection,
  ATLAS_RETENTION,
  capacityFailure,
  CURSOR_TTL_MS,
  cursorExpiresAt,
  enforceRetention,
  pinnedSnapshot,
  storedBytes,
  sweepAtlasRetention,
} from "./retention.ts";

const scope = repoScope("r1");
const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms);

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'engine', 'private', 'art-r1', ''),
             ('r2', 'ann', 'tools', 'private', 'art-r2', '');
  `);
  const db = d1(sqlite);
  for (const repo of ["r1", "r2"]) {
    node(sqlite, repo, "repo", "repository", "engine", null, "The engine");
    node(sqlite, repo, "file:a.ts", "file", "a.ts", "a.ts", "v0");
    node(sqlite, repo, "file:b.ts", "file", "b.ts", "b.ts", "v0");
    node(sqlite, repo, "file:c.ts", "file", "c.ts", "c.ts", "stable");
    edge(sqlite, repo, "file:a.ts", "file:c.ts", "imports");
  }
  return { sqlite, db };
}

function node(
  sqlite: DatabaseSync,
  repo: string,
  id: string,
  kind: string,
  name: string,
  path: string | null,
  summary: string,
) {
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 'h', 'c')
       ON CONFLICT (repo_id, id) DO UPDATE SET summary = excluded.summary`,
    )
    .run(repo, id, kind, name, path, summary);
}
function edge(sqlite: DatabaseSync, repo: string, src: string, dst: string, kind: string) {
  sqlite
    .prepare(`INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1)`)
    .run(repo, src, dst, kind);
}
const summarize = (sqlite: DatabaseSync, repo: string, id: string, summary: string) =>
  sqlite
    .prepare("UPDATE kg_nodes SET summary = ? WHERE repo_id = ? AND id = ?")
    .run(summary, repo, id);

/** Build (and by default publish) a snapshot of `repo`'s graph, the way the Workflow does. */
async function project(db: D1Database, repo: string, commit: string, publish = true) {
  const { snapshotId, seq } = await beginRepoProjection(db, repo, [
    { repoId: repo, commit, buildId: `b-${commit}` },
  ]);
  let after: string | null = null;
  do {
    ({ next: after } = await projectEntities(db, repo, snapshotId, seq, after, 2));
  } while (after);
  let cursor: EdgeCursor = null;
  do {
    ({ next: cursor } = await projectEdges(db, repo, snapshotId, seq, cursor, 2));
  } while (cursor);
  if (publish) await publishProjection(db, repoScope(repo), snapshotId, seq);
  return { snapshotId, seq };
}

/** Push n changes to file:a.ts, publishing (and running retention) after each. */
async function pushes(
  sqlite: DatabaseSync,
  db: D1Database,
  n: number,
  options: { repo?: string; size?: number; retain?: Parameters<typeof enforceRetention>[2] } = {},
) {
  const repo = options.repo ?? "r1";
  const published: { snapshotId: string; seq: number }[] = [];
  for (let i = 0; i < n; i++) {
    const tag = `${repo}-${published.length}-${Math.random()}`;
    summarize(sqlite, repo, "file:a.ts", tag.padEnd(options.size ?? 0, "x"));
    published.push(await project(db, repo, tag));
    if (options.retain) await enforceRetention(db, [repoScope(repo)], options.retain);
  }
  return published;
}

const snapshots = (sqlite: DatabaseSync, repo = "r1") =>
  sqlite
    .prepare(
      "SELECT seq, status, expired_reason AS reason, bytes FROM atlas_snapshots WHERE scope = ? ORDER BY seq",
    )
    .all(repoScope(repo)) as {
    seq: number;
    status: string;
    reason: string | null;
    bytes: number;
  }[];

/** Storage accounting matches what is actually stored, row by row. */
function expectAccounted(sqlite: DatabaseSync) {
  const { accounted, actual } = sqlite
    .prepare(
      `SELECT (SELECT coalesce(sum(bytes), 0) FROM atlas_snapshots) AS accounted,
              (SELECT coalesce(sum(${ENTITY_BYTES_SQL}), 0) FROM atlas_entities)
              + (SELECT coalesce(sum(${EDGE_BYTES_SQL}), 0) FROM atlas_edges) AS actual`,
    )
    .get() as { accounted: number; actual: number };
  expect(accounted).toBe(actual);
  expect(accounted).toBeGreaterThan(0);
}

describe("Atlas retention", () => {
  test("keep current plus 20 priors; older ones expire and their rows are reclaimed", async () => {
    const { sqlite, db } = setup();
    const published = await pushes(sqlite, db, 24, { retain: {} });

    const states = snapshots(sqlite);
    expect(states.filter((s) => s.status === "published")).toHaveLength(21);
    expect(states.filter((s) => s.status === "expired").map((s) => [s.seq, s.reason])).toEqual([
      [1, "count"],
      [2, "count"],
      [3, "count"],
    ]);
    expect((await currentSnapshot(db, scope))?.seq).toBe(24);
    // a.ts's versions only expired snapshots saw are gone; unchanged rows the
    // first snapshot opened stay, since every retained snapshot sees them.
    const versions = sqlite
      .prepare(
        "SELECT from_seq, to_seq FROM atlas_entities WHERE scope = ? AND entity_id = 'file:a.ts' ORDER BY from_seq",
      )
      .all(scope) as { from_seq: number; to_seq: number | null }[];
    expect(versions[0]).toEqual({ from_seq: 4, to_seq: 5 });
    expect(versions).toHaveLength(21);
    expect(
      sqlite
        .prepare("SELECT from_seq FROM atlas_entities WHERE scope = ? AND entity_id = 'file:c.ts'")
        .all(scope),
    ).toEqual([{ from_seq: 1 }]);
    expect((await entityAt(db, scope, 4, "file:c.ts"))?.summary).toBe("stable");
    expect((await entityAt(db, scope, 4, "file:a.ts"))?.summary).toMatch(/^r1-3-/);
    expectAccounted(sqlite);

    expect(await pinnedSnapshot(db, scope, published[0]!.snapshotId)).toMatchObject({
      state: "expired",
      snapshotId: published[0]!.snapshotId,
      seq: 1,
      reason: "count",
      current: { id: published[23]!.snapshotId, seq: 24 },
    });
    expect(await pinnedSnapshot(db, scope, published[3]!.snapshotId)).toMatchObject({
      state: "ok",
      snapshot: { seq: 4, status: "published" },
    });
  });

  test("priors expire 7 days after they were superseded", async () => {
    const { sqlite, db } = setup();
    const [first, second, third] = await pushes(sqlite, db, 3);
    await enforceRetention(db, [scope]);

    const prior = await pinnedSnapshot(db, scope, first!.snapshotId);
    const next = await pinnedSnapshot(db, scope, second!.snapshotId);
    if (prior.state !== "ok" || next.state !== "ok") throw new Error("expected both readable");
    expect(Date.parse(prior.snapshot.expiresAt ?? "")).toBe(
      Date.parse(next.snapshot.publishedAt ?? "") + 7 * DAY,
    );
    expect((await currentSnapshot(db, scope))?.expiresAt).toBeNull();

    // Six days on, nothing has expired.
    expect((await enforceRetention(db, [scope], { now: later(6 * DAY) })).expired).toEqual([]);
    // Past seven days a pinned read answers expiry even before the sweep marks it…
    expect(await pinnedSnapshot(db, scope, first!.snapshotId, later(8 * DAY))).toMatchObject({
      state: "expired",
      reason: "age",
      expiredAt: prior.snapshot.expiresAt,
      current: { id: third!.snapshotId },
    });
    // …then the sweep expires both priors and keeps current.
    const swept = await sweepAtlasRetention(db, { now: later(8 * DAY) });
    expect(swept).toMatchObject({ scopes: 1, expired: 2, more: false });
    expect(snapshots(sqlite).map((s) => s.status)).toEqual(["expired", "expired", "published"]);
    expect(await pinnedSnapshot(db, scope, third!.snapshotId, later(8 * DAY))).toMatchObject({
      state: "ok",
    });
    expectAccounted(sqlite);

    // Records outlive their rows by 30 days: the second opened only a.ts's
    // version, now reclaimed, so it is forgotten; the first still owns rows
    // current sees, so its expiry stays answerable.
    await sweepAtlasRetention(db, { now: later(40 * DAY) });
    expect(snapshots(sqlite).map((s) => s.seq)).toEqual([1, 3]);
    expect(await pinnedSnapshot(db, scope, second!.snapshotId)).toEqual({ state: "unknown" });
    expect((await pinnedSnapshot(db, scope, first!.snapshotId)).state).toBe("expired");
  });

  test("an account's tighter policy (CORE-201): fewer priors, a shorter period", async () => {
    const { sqlite, db } = setup();
    await pushes(sqlite, db, 6, { retain: {} });
    expect(snapshots(sqlite).filter((s) => s.status === "published")).toHaveLength(6);
    // Another account's choice changes nothing here.
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('bob', 'user', 'bob', 'Bob');
      INSERT INTO retention_policies (account_id, category, thresholds)
        VALUES ('bob', 'atlas-snapshots', '{"maxPrior": 0}');
    `);
    expect((await enforceRetention(db, [scope])).expired).toEqual([]);

    // Ann keeps 3 priors for 2 days, and a value over the bounds is ignored.
    sqlite.exec(`
      INSERT INTO retention_policies (account_id, category, thresholds)
        VALUES ('ann', 'atlas-snapshots', '{"maxPrior": 3, "priorDays": 2, "capGib": 9}');
    `);
    const result = await enforceRetention(db, [scope]);
    expect(result.expired.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(new Set(result.expired.map((e) => e.reason))).toEqual(new Set(["count"]));
    expect(result.capBytes).toBe(ATLAS_RETENTION.repoCapBytes);
    // Priors stamped with 7 days are brought forward to 2.
    const due = sqlite
      .prepare(
        `SELECT s.seq, s.expires_at, n.published_at FROM atlas_snapshots s
         JOIN atlas_snapshots n ON n.scope = s.scope AND n.seq = s.seq + 1
         WHERE s.scope = ? AND s.status = 'published' ORDER BY s.seq`,
      )
      .all(scope) as { seq: number; expires_at: string; published_at: string }[];
    expect(due.map((d) => d.seq)).toEqual([3, 4, 5]);
    for (const d of due)
      expect(Date.parse(d.expires_at)).toBe(Date.parse(d.published_at) + 2 * DAY);
    // The hourly sweep expires them after 2 days, not 7; current stays.
    expect(await sweepAtlasRetention(db, { now: later(3 * DAY) })).toMatchObject({ expired: 3 });
    expect(snapshots(sqlite).map((s) => s.status)).toEqual([
      ...Array(5).fill("expired"),
      "published",
    ]);
    expectAccounted(sqlite);
  });

  test("storage pressure evicts the oldest priors first and never current", async () => {
    const { sqlite, db } = setup();
    await pushes(sqlite, db, 6, { size: 10_000 });
    await enforceRetention(db, [scope]);
    const before = await storedBytes(db, [scope]);
    // Room for current and about two 10 kB priors.
    const capBytes = before - 30_000;
    const result = await enforceRetention(db, [scope], { policy: { capBytes } });

    expect(result.expired.map((e) => [e.seq, e.reason])).toEqual([
      [1, "storage"],
      [2, "storage"],
      [3, "storage"],
    ]);
    expect(result.storedBytes).toBeLessThanOrEqual(capBytes);
    expect(result.more).toBe(false);
    expect(snapshots(sqlite).map((s) => s.status)).toEqual([
      "expired",
      "expired",
      "expired",
      "published",
      "published",
      "published",
    ]);
    expectAccounted(sqlite);

    // A cap even current alone exceeds evicts every prior, but not current.
    const tiny = await enforceRetention(db, [scope], { policy: { capBytes: 1 } });
    expect(tiny.expired.map((e) => e.seq)).toEqual([4, 5]);
    expect((await currentSnapshot(db, scope))?.seq).toBe(6);
    expect(await entityAt(db, scope, 6, "file:c.ts")).not.toBeNull();
  });

  test("a replacement that doesn't fit fails for capacity and current stays, stale", async () => {
    const { sqlite, db } = setup();
    const old = await pushes(sqlite, db, 3);
    const current = old[2]!;
    const capBytes = (await storedBytes(db, [scope])) + 5_000;

    summarize(sqlite, "r1", "file:b.ts", "y".repeat(50_000));
    const big = await project(db, "r1", "big", false);
    const retained = await enforceRetention(db, [scope], { policy: { capBytes } });
    // Priors went under pressure; it still doesn't fit.
    expect(retained.expired.map((e) => e.reason)).toEqual(["storage", "storage"]);
    const admission = await admitProjection(db, scope, big.snapshotId, { policy: { capBytes } });
    expect(admission).toMatchObject({ admitted: false, capBytes });
    if (admission.admitted) throw new Error("expected a capacity failure");
    expect(admission.error).toMatch(
      /^Capacity: .* over the .* cap\. The previous snapshot stays current \(stale\)\.$/,
    );

    expect((await currentSnapshot(db, scope))?.id).toBe(current.snapshotId);
    expect((await entityAt(db, scope, current.seq, "file:b.ts"))?.summary).toBe("v0");
    expect(await capacityFailure(db, scope)).toMatchObject({
      snapshotId: big.snapshotId,
      seq: big.seq,
      error: admission.error,
    });
    expect(
      sqlite
        .prepare("SELECT status, failure, bytes FROM atlas_snapshots WHERE id = ?")
        .get(big.snapshotId),
    ).toEqual({ status: "failed", failure: "capacity", bytes: 0 });
    expect(await pinnedSnapshot(db, scope, big.snapshotId)).toEqual({ state: "unknown" });
    expect(await storedBytes(db, [scope])).toBeLessThanOrEqual(capBytes);
    expectAccounted(sqlite);
    // Asking again doesn't admit it.
    expect(
      (await admitProjection(db, scope, big.snapshotId, { policy: { capBytes } })).admitted,
    ).toBe(false);

    // A snapshot that fits publishes and clears the stale state.
    summarize(sqlite, "r1", "file:b.ts", "small");
    const next = await project(db, "r1", "small", false);
    expect(
      await admitProjection(db, scope, next.snapshotId, { policy: { capBytes } }),
    ).toMatchObject({ admitted: true });
    await publishProjection(db, scope, next.snapshotId, next.seq);
    expect(await capacityFailure(db, scope)).toBeNull();
  });

  test("reclaim deletes only rows no retained snapshot sees", async () => {
    const { sqlite, db } = setup();
    // 1: a v1, b v1, a→c. 2: a v2. 3: a v3, b v2, a→c gone, b→c.
    summarize(sqlite, "r1", "file:a.ts", "a1 — naïve 😀");
    summarize(sqlite, "r1", "file:b.ts", "b1");
    const s1 = await project(db, "r1", "c1");
    summarize(sqlite, "r1", "file:a.ts", "a2");
    const s2 = await project(db, "r1", "c2");
    summarize(sqlite, "r1", "file:a.ts", "a3");
    summarize(sqlite, "r1", "file:b.ts", "b2");
    sqlite.exec("DELETE FROM kg_edges WHERE repo_id = 'r1'");
    edge(sqlite, "r1", "file:b.ts", "file:c.ts", "imports");
    const s3 = await project(db, "r1", "c3");

    const summaries = () =>
      sqlite
        .prepare(
          "SELECT summary FROM atlas_entities WHERE scope = ? AND entity_id IN ('file:a.ts', 'file:b.ts') ORDER BY summary",
        )
        .all(scope)
        .map((r) => (r as { summary: string }).summary);
    const edgeRows = () => sqlite.prepare("SELECT src, from_seq, to_seq FROM atlas_edges").all();

    // Expire 1: a1 goes (only 1 saw it); b1 stays (2 sees it); a→c stays (2 sees it).
    await enforceRetention(db, [scope], { policy: { maxPrior: 1 } });
    expect(snapshots(sqlite).map((s) => s.status)).toEqual(["expired", "published", "published"]);
    expect(summaries()).toEqual(["a2", "a3", "b1", "b2"]);
    expect((await entityAt(db, scope, s2.seq, "file:b.ts"))?.summary).toBe("b1");
    expect(await edgesAt(db, scope, s2.seq, "file:a.ts", false)).toHaveLength(1);
    expectAccounted(sqlite);

    // Expire 2 as well: only what current sees is left.
    await enforceRetention(db, [scope], { policy: { maxPrior: 0 } });
    expect(summaries()).toEqual(["a3", "b2"]);
    expect(edgeRows()).toEqual([{ src: "file:b.ts", from_seq: 3, to_seq: null }]);
    expect((await entityAt(db, scope, s3.seq, "file:c.ts"))?.summary).toBe("stable");
    expectAccounted(sqlite);
    // Idempotent: nothing more to do.
    expect(await enforceRetention(db, [scope], { policy: { maxPrior: 0 } })).toMatchObject({
      expired: [],
      reclaimed: { entities: 0, edges: 0 },
      more: false,
    });
    expect((await pinnedSnapshot(db, scope, s1.snapshotId)).state).toBe("expired");
  });

  test("reclaiming is bounded per call and the sweep resumes it", async () => {
    const { sqlite, db } = setup();
    await pushes(sqlite, db, 6);
    const policy = { maxPrior: 0, reclaimBatch: 1, maxRounds: 2 };
    const first = await enforceRetention(db, [scope], { policy });
    expect(first.expired).toHaveLength(5);
    expect(first.reclaimed).toEqual({ entities: 2, edges: 0 });
    expect(first.more).toBe(true);
    expect(
      sqlite.prepare("SELECT retention_pending AS p FROM atlas_scopes WHERE scope = ?").get(scope),
    ).toEqual({ p: 1 });

    let sweeps = 0;
    while ((await sweepAtlasRetention(db, { policy })).more) sweeps++;
    expect(sweeps).toBeGreaterThan(0);
    expect(
      sqlite.prepare("SELECT retention_pending AS p FROM atlas_scopes WHERE scope = ?").get(scope),
    ).toEqual({ p: 0 });
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM atlas_entities WHERE scope = ? AND to_seq IS NOT NULL")
        .get(scope),
    ).toEqual({ n: 0 });
    expectAccounted(sqlite);
    // Nothing due: the sweep leaves the scope alone.
    expect(await sweepAtlasRetention(db, { policy })).toMatchObject({ scopes: 0, more: false });
  });

  test("an account pool shares one cap and evicts its oldest prior across scopes", async () => {
    const { sqlite, db } = setup();
    const pool = [repoScope("r1"), repoScope("r2")];
    await pushes(sqlite, db, 2, { repo: "r1", size: 10_000 }); // r1's prior is oldest
    await pushes(sqlite, db, 2, { repo: "r2", size: 10_000 });
    const capBytes = (await storedBytes(db, pool)) - 5_000;
    const result = await enforceRetention(db, pool, { policy: { capBytes } });
    expect(result.expired.map((e) => [e.scope, e.seq, e.reason])).toEqual([
      [repoScope("r1"), 1, "storage"],
    ]);
    expect(snapshots(sqlite, "r2").map((s) => s.status)).toEqual(["published", "published"]);
    expect(result.storedBytes).toBeLessThanOrEqual(capBytes);
  });

  test("unknown snapshots, and cursor expiry", async () => {
    const { sqlite, db } = setup();
    const [one] = await pushes(sqlite, db, 1);
    expect(await pinnedSnapshot(db, scope, "nope")).toEqual({ state: "unknown" });
    expect(await pinnedSnapshot(db, repoScope("r2"), one!.snapshotId)).toEqual({
      state: "unknown",
    });
    const building = await project(db, "r1", "wip", false);
    expect(await pinnedSnapshot(db, scope, building.snapshotId)).toEqual({ state: "unknown" });

    const issued = Date.parse("2026-10-03T00:00:00.000Z");
    expect(CURSOR_TTL_MS).toBe(30 * 60 * 1000);
    expect(cursorExpiresAt(issued, null)).toBe(issued + CURSOR_TTL_MS);
    expect(cursorExpiresAt(issued, "2026-10-03T00:10:00.000Z")).toBe(issued + 10 * 60 * 1000);
    expect(cursorExpiresAt(new Date(issued), "2026-10-04T00:00:00.000Z")).toBe(
      issued + CURSOR_TTL_MS,
    );
    expect(ATLAS_RETENTION).toMatchObject({
      maxPrior: 20,
      priorTtlMs: 7 * DAY,
      repoCapBytes: 2 * 1024 ** 3,
      accountCompositionCapBytes: 2 * 1024 ** 3,
    });
  });
});
