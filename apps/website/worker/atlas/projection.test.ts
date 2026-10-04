import { describe, expect, test } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { GROUPING_VERSION } from "./grouping.ts";
import {
  beginRepoProjection,
  childrenAt,
  currentSnapshot,
  edgesAt,
  EDGE_BATCH,
  ENTITY_BATCH,
  entityAt,
  failProjection,
  groupRepoCapabilities,
  GROUPS,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";

const scope = repoScope("r1");

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'engine', 'private', 'art-r1', '');
  `);
  return { sqlite, db: d1(sqlite) };
}

function node(
  sqlite: DatabaseSync,
  id: string,
  kind: string,
  name: string,
  path: string | null,
  summary = "",
  data: Record<string, unknown> = {},
) {
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES ('r1', ?, ?, ?, ?, ?, ?, 'h', 'c')
       ON CONFLICT (repo_id, id) DO UPDATE SET summary = excluded.summary, data = excluded.data`,
    )
    .run(id, kind, name, path, summary, JSON.stringify(data));
}
function edge(sqlite: DatabaseSync, src: string, dst: string, kind: string, weight = 1) {
  sqlite
    .prepare(`INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES ('r1', ?, ?, ?, ?)`)
    .run(src, dst, kind, weight);
}

/** A small graph: one component with two files, a pending file, concepts, a package. */
function seedGraph(sqlite: DatabaseSync) {
  node(sqlite, "repo", "repository", "engine", null, "The engine", { files: 3 });
  node(sqlite, "dir:src", "directory", "src", "src");
  node(sqlite, "component:src", "component", "Billing core", null, "Charges customers");
  node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Charges cards", { blob: "b1" });
  node(sqlite, "file:src/b.ts", "file", "b.ts", "src/b.ts", "Refunds", { blob: "b2" });
  node(sqlite, "file:tools/new.ts", "file", "new.ts", "tools/new.ts", "", { pending: true });
  node(sqlite, "sym:src/a.ts#charge", "symbol", "charge", "src/a.ts", "Charges a card");
  node(sqlite, "pkg:npm:stripe", "package", "stripe", null);
  node(sqlite, "concept:billing", "concept", "Billing", null, "Money in");
  node(sqlite, "concept:refunds", "concept", "Refunds", null, "Money back");
  edge(sqlite, "repo", "component:src", "contains");
  edge(sqlite, "component:src", "file:src/a.ts", "contains");
  edge(sqlite, "component:src", "file:src/b.ts", "contains");
  edge(sqlite, "repo", "dir:src", "contains");
  edge(sqlite, "dir:src", "file:src/a.ts", "contains");
  edge(sqlite, "dir:src", "file:src/b.ts", "contains");
  edge(sqlite, "file:src/a.ts", "sym:src/a.ts#charge", "defines");
  edge(sqlite, "file:src/a.ts", "pkg:npm:stripe", "imports", 2);
  edge(sqlite, "file:src/b.ts", "file:src/a.ts", "imports");
  edge(sqlite, "file:src/a.ts", "concept:billing", "mentions");
  edge(sqlite, "file:src/b.ts", "concept:refunds", "mentions");
  edge(sqlite, "concept:refunds", "concept:billing", "part_of");
}

/** Run a whole projection the way the build does, in small batches. */
async function project(
  db: D1Database,
  commit: string,
  options: { entityBatch?: number; edgeBatch?: number; publish?: boolean } = {},
) {
  const { snapshotId, seq } = await beginRepoProjection(db, "r1", [
    { repoId: "r1", commit, buildId: `b-${commit}` },
  ]);
  let after: string | null = null;
  do {
    ({ next: after } = await projectEntities(
      db,
      "r1",
      snapshotId,
      seq,
      after,
      options.entityBatch ?? 3,
    ));
  } while (after);
  let cursor: EdgeCursor = null;
  do {
    ({ next: cursor } = await projectEdges(
      db,
      "r1",
      snapshotId,
      seq,
      cursor,
      options.edgeBatch ?? 4,
    ));
  } while (cursor);
  if (options.publish !== false) await publishProjection(db, scope, snapshotId, seq);
  return { snapshotId, seq };
}

const rows = (sqlite: DatabaseSync, table: string, where = "") =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;

describe("Atlas projections", () => {
  test("project the graph into one primary tree with deduplicated counts", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    const { seq, snapshotId } = await project(db, "c1");

    const current = await currentSnapshot(db, scope);
    expect(current).toMatchObject({ id: snapshotId, seq, status: "published", partial: true });
    expect(current?.vector).toEqual([{ repoId: "r1", commit: "c1", buildId: "b-c1" }]);
    expect(current?.entities).toBe(14); // 10 graph nodes + 4 groups
    expect(current?.edges).toBe(12);

    const parent = async (id: string) => (await entityAt(db, scope, seq, id))?.parentId;
    expect(await parent("repo")).toBeNull();
    expect(await parent("component:src")).toBe("repo");
    expect(await parent("file:src/a.ts")).toBe("component:src");
    expect(await parent("sym:src/a.ts#charge")).toBe("file:src/a.ts");
    // No component yet: a structural home, never an invented capability.
    expect(await parent("file:tools/new.ts")).toBe(GROUPS.unclassified);
    expect(await parent("concept:refunds")).toBe("concept:billing");
    expect(await parent("concept:billing")).toBe(GROUPS.concepts);
    expect(await parent("pkg:npm:stripe")).toBe(GROUPS.dependencies);
    expect(await parent("dir:src")).toBe(GROUPS.folders);

    expect((await entityAt(db, scope, seq, "component:src"))?.data.counts).toEqual({ files: 2 });
    expect((await entityAt(db, scope, seq, "file:src/a.ts"))?.data.counts).toEqual({
      symbols: 1,
    });
    expect((await entityAt(db, scope, seq, "concept:billing"))?.data.counts).toEqual({ files: 1 });
    expect((await entityAt(db, scope, seq, GROUPS.unclassified))?.data).toMatchObject({
      members: 1,
      structural: true,
    });

    const top = await childrenAt(db, scope, seq, "repo", null, 100);
    expect(top.entities.map((e) => e.id)).toEqual([
      "component:src",
      GROUPS.concepts,
      GROUPS.dependencies,
      GROUPS.folders,
      GROUPS.unclassified,
    ]);
    expect(await edgesAt(db, scope, seq, "file:src/a.ts", true)).toEqual([
      { src: "component:src", dst: "file:src/a.ts", kind: "contains", weight: 1 },
      { src: "dir:src", dst: "file:src/a.ts", kind: "contains", weight: 1 },
      { src: "file:src/b.ts", dst: "file:src/a.ts", kind: "imports", weight: 1 },
    ]);
  });

  test("a published snapshot keeps reading what it published, and unchanged rows are stored once", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    const first = await project(db, "c1");

    // The next push: a.ts changes, b.ts goes, c.ts arrives.
    node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Charges cards and wallets", {
      blob: "b3",
    });
    sqlite.exec(`DELETE FROM kg_nodes WHERE id = 'file:src/b.ts';
      DELETE FROM kg_edges WHERE src = 'file:src/b.ts' OR dst = 'file:src/b.ts';`);
    node(sqlite, "file:src/c.ts", "file", "c.ts", "src/c.ts", "Invoices", { blob: "b4" });
    edge(sqlite, "component:src", "file:src/c.ts", "contains");
    const second = await project(db, "c2");

    expect((await currentSnapshot(db, scope))?.id).toBe(second.snapshotId);
    // Pinned to the first snapshot: nothing it published moved.
    expect((await entityAt(db, scope, first.seq, "file:src/a.ts"))?.summary).toBe("Charges cards");
    expect(await entityAt(db, scope, first.seq, "file:src/b.ts")).not.toBeNull();
    expect(await entityAt(db, scope, first.seq, "file:src/c.ts")).toBeNull();
    // The second sees the push.
    expect((await entityAt(db, scope, second.seq, "file:src/a.ts"))?.summary).toBe(
      "Charges cards and wallets",
    );
    expect(await entityAt(db, scope, second.seq, "file:src/b.ts")).toBeNull();
    expect(await entityAt(db, scope, second.seq, "file:src/c.ts")).not.toBeNull();
    expect(
      (await edgesAt(db, scope, first.seq, "file:src/a.ts", true)).map((e) => e.src),
    ).toContain("file:src/b.ts");
    expect(
      (await edgesAt(db, scope, second.seq, "file:src/a.ts", true)).map((e) => e.src),
    ).not.toContain("file:src/b.ts");

    // Unchanged entities and edges are one row however many snapshots share them.
    expect(rows(sqlite, "atlas_entities", "WHERE entity_id = 'pkg:npm:stripe'")).toBe(1);
    expect(rows(sqlite, "atlas_entities", "WHERE entity_id = 'file:src/a.ts'")).toBe(2);
    expect(
      rows(sqlite, "atlas_edges", "WHERE src = 'file:src/a.ts' AND dst = 'pkg:npm:stripe'"),
    ).toBe(1);
    // The component's count moved (b.ts out, c.ts in nets out) only if it changed.
    expect((await entityAt(db, scope, second.seq, "component:src"))?.data.counts).toEqual({
      files: 2,
    });
  });

  test("an interrupted projection never becomes current and is rolled back by the next", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    const published = await project(db, "c1");

    node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Half-written", { blob: "b5" });
    const interrupted = await project(db, "c2", { publish: false });
    expect((await currentSnapshot(db, scope))?.id).toBe(published.snapshotId);
    expect((await entityAt(db, scope, published.seq, "file:src/a.ts"))?.summary).toBe(
      "Charges cards",
    );

    node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Finished", { blob: "b6" });
    const next = await project(db, "c3");
    expect(next.seq).toBeGreaterThan(interrupted.seq);
    expect((await currentSnapshot(db, scope))?.id).toBe(next.snapshotId);
    expect((await entityAt(db, scope, next.seq, "file:src/a.ts"))?.summary).toBe("Finished");
    // Nothing the interrupted snapshot wrote survives.
    expect(rows(sqlite, "atlas_entities", `WHERE from_seq = ${interrupted.seq}`)).toBe(0);
    expect(rows(sqlite, "atlas_entities", `WHERE to_seq = ${interrupted.seq}`)).toBe(0);
    expect(
      sqlite.prepare("SELECT status FROM atlas_snapshots WHERE id = ?").get(interrupted.snapshotId),
    ).toEqual({ status: "failed" });
  });

  test("a retried batch converges on the same rows", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    await project(db, "c1");
    node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Retried", { blob: "b7" });
    const { snapshotId, seq } = await beginRepoProjection(db, "r1", [
      { repoId: "r1", commit: "c2", buildId: "b2" },
    ]);
    // The same step, run twice (a Workflow retry after a partial write).
    await projectEntities(db, "r1", snapshotId, seq, null, ENTITY_BATCH);
    const before = rows(sqlite, "atlas_entities");
    await projectEntities(db, "r1", snapshotId, seq, null, ENTITY_BATCH);
    expect(rows(sqlite, "atlas_entities")).toBe(before);
    await projectEdges(db, "r1", snapshotId, seq, null, EDGE_BATCH);
    await projectEdges(db, "r1", snapshotId, seq, null, EDGE_BATCH);
    await publishProjection(db, scope, snapshotId, seq);
    expect((await entityAt(db, scope, seq, "file:src/a.ts"))?.summary).toBe("Retried");
    expect(rows(sqlite, "atlas_entities", "WHERE entity_id = 'file:src/a.ts'")).toBe(2);
  });

  test("a failed projection rolls back and leaves the published one current", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    const published = await project(db, "c1");
    node(sqlite, "file:src/a.ts", "file", "a.ts", "src/a.ts", "Doomed", { blob: "b8" });
    const doomed = await project(db, "c2", { publish: false });
    await failProjection(db, scope, doomed.snapshotId, "Projection step failed");
    expect((await currentSnapshot(db, scope))?.id).toBe(published.snapshotId);
    expect(rows(sqlite, "atlas_entities", `WHERE from_seq = ${doomed.seq}`)).toBe(0);
    expect(
      sqlite
        .prepare("SELECT status, error FROM atlas_snapshots WHERE id = ?")
        .get(doomed.snapshotId),
    ).toEqual({ status: "failed", error: "Projection step failed" });
  });

  test("large graphs project in bounded, resumable batches", async () => {
    const { sqlite, db } = setup();
    node(sqlite, "repo", "repository", "engine", null);
    node(sqlite, "component:big", "component", "Big", null);
    edge(sqlite, "repo", "component:big", "contains");
    const insertNode = sqlite.prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES ('r1', ?, 'file', ?, ?, '', '{}', 'h', 'c')`,
    );
    const insertEdge = sqlite.prepare(
      `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES ('r1', 'component:big', ?, 'contains', 1)`,
    );
    sqlite.exec("BEGIN");
    for (let i = 0; i < 25_000; i++) {
      const path = `f/${String(i).padStart(5, "0")}.ts`;
      insertNode.run(`file:${path}`, path, path);
      insertEdge.run(`file:${path}`);
    }
    sqlite.exec("COMMIT");

    const { snapshotId, seq } = await beginRepoProjection(db, "r1", [
      { repoId: "r1", commit: "c1", buildId: "b1" },
    ]);
    const batches: number[] = [];
    let after: string | null = null;
    do {
      const result = await projectEntities(db, "r1", snapshotId, seq, after);
      batches.push(result.written);
      after = result.next;
    } while (after);
    expect(Math.max(...batches)).toBeLessThanOrEqual(ENTITY_BATCH);
    expect(batches.length).toBe(3);
    let cursor: EdgeCursor = null;
    do ({ next: cursor } = await projectEdges(db, "r1", snapshotId, seq, cursor));
    while (cursor);
    await publishProjection(db, scope, snapshotId, seq);
    const current = await currentSnapshot(db, scope);
    expect(current?.entities).toBe(25_002);
    expect(current?.edges).toBe(25_001);
    expect((await entityAt(db, scope, seq, "component:big"))?.data.counts).toEqual({
      files: 25_000,
    });
    const page = await childrenAt(db, scope, seq, "component:big", null, 100);
    expect(page.entities).toHaveLength(100);
    expect(page.next).not.toBeNull();
  }, 30_000); // Thousands of rows: seconds on a loaded 4-core host (CORE-247).

  test("deleting the repository deletes its projections", async () => {
    const { sqlite, db } = setup();
    seedGraph(sqlite);
    await project(db, "c1");
    expect(rows(sqlite, "atlas_entities")).toBeGreaterThan(0);
    sqlite.exec("DELETE FROM repos WHERE id = 'r1'");
    for (const table of [
      "atlas_scopes",
      "atlas_snapshots",
      "atlas_current",
      "atlas_entities",
      "atlas_edges",
    ])
      expect(rows(sqlite, table)).toBe(0);
  });

  test("capabilities group files across directories, with their evidence", async () => {
    const { sqlite, db } = setup();
    node(sqlite, "repo", "repository", "shop", null);
    for (const dir of ["src", "src/billing", "web", "ops", "misc"])
      node(sqlite, `dir:${dir}`, "directory", dir, dir);
    node(sqlite, "component:src/billing", "component", "Billing", null, "", { dir: "src/billing" });
    node(sqlite, "component:web", "component", "Web", null, "", { dir: "web" });
    node(sqlite, "component:ops", "component", "Ops", null, "", { dir: "ops" });
    const file = (path: string) =>
      node(sqlite, `file:${path}`, "file", path.split("/").pop()!, path, "", { blob: path });
    for (const path of [
      "src/billing/charge.ts",
      "src/billing/invoice.ts",
      "web/checkout.ts",
      "web/cart.ts",
      "ops/deploy.ts",
      "ops/canary.ts",
      "ops/rollback.ts",
      "misc/notes.ts",
    ])
      file(path);
    node(sqlite, "file:web/pending.ts", "file", "pending.ts", "web/pending.ts", "", {
      pending: true,
    });
    for (const c of ["payments", "cart", "deployment", "code"])
      node(sqlite, `concept:${c}`, "concept", c[0]!.toUpperCase() + c.slice(1), null);
    edge(sqlite, "component:src/billing", "file:src/billing/charge.ts", "contains");
    edge(sqlite, "component:src/billing", "file:src/billing/invoice.ts", "contains");
    edge(sqlite, "component:web", "file:web/checkout.ts", "contains");
    edge(sqlite, "component:web", "file:web/cart.ts", "contains");
    edge(sqlite, "component:ops", "file:ops/deploy.ts", "contains");
    edge(sqlite, "component:ops", "file:ops/rollback.ts", "contains");
    edge(sqlite, "component:ops", "file:ops/canary.ts", "contains");
    edge(sqlite, "file:web/checkout.ts", "file:src/billing/charge.ts", "imports");
    edge(sqlite, "file:src/billing/invoice.ts", "file:src/billing/charge.ts", "imports");
    edge(sqlite, "file:web/cart.ts", "file:web/checkout.ts", "imports");
    edge(sqlite, "file:ops/rollback.ts", "file:ops/deploy.ts", "imports");
    edge(sqlite, "file:ops/canary.ts", "file:ops/rollback.ts", "imports");
    for (const [path, concepts] of [
      ["src/billing/charge.ts", ["payments", "code"]],
      ["src/billing/invoice.ts", ["payments", "code"]],
      ["web/checkout.ts", ["payments", "cart", "code"]],
      ["web/cart.ts", ["cart", "code"]],
      ["ops/deploy.ts", ["deployment", "code"]],
      ["ops/rollback.ts", ["deployment", "code"]],
      ["ops/canary.ts", ["deployment", "code"]],
      ["misc/notes.ts", ["code"]],
    ] as const)
      for (const c of concepts) edge(sqlite, `file:${path}`, `concept:${c}`, "mentions");

    const build = async (commit: string) => {
      const { snapshotId, seq } = await beginRepoProjection(db, "r1", [
        { repoId: "r1", commit, buildId: commit },
      ]);
      const stats = await groupRepoCapabilities(db, "r1", snapshotId, seq);
      let after: string | null = null;
      do ({ next: after } = await projectEntities(db, "r1", snapshotId, seq, after, 4));
      while (after);
      let cursor: EdgeCursor = null;
      do ({ next: cursor } = await projectEdges(db, "r1", snapshotId, seq, cursor, 5));
      while (cursor);
      await publishProjection(db, scope, snapshotId, seq);
      return { seq, stats };
    };
    const { seq, stats } = await build("c1");
    expect(stats).toMatchObject({ capabilities: 2, unclassified: 1, files: 8 });
    expect(
      sqlite.prepare("SELECT grouping_version FROM atlas_snapshots WHERE seq = ?").get(seq),
    ).toEqual({
      grouping_version: GROUPING_VERSION,
    });

    const top = await childrenAt(db, scope, seq, "repo", null, 100);
    const caps = top.entities.filter((e) => e.kind === "capability");
    expect(caps).toHaveLength(2);
    // Components are directory-shaped inputs, now under their folders.
    expect(top.entities.some((e) => e.kind === "component")).toBe(false);
    expect((await entityAt(db, scope, seq, "component:web"))?.parentId).toBe("dir:web");

    const placed = async (path: string) => (await entityAt(db, scope, seq, `file:${path}`))!;
    const charge = await placed("src/billing/charge.ts");
    const checkout = await placed("web/checkout.ts");
    const capOf = async (path: string) =>
      ((await placed(path)).data.membership as { capability: string | null }).capability;
    // Billing spans src/billing and web, apart from ops.
    const billingId = await capOf("src/billing/charge.ts");
    expect(await capOf("web/checkout.ts")).toBe(billingId);
    expect(await capOf("web/cart.ts")).toBe(billingId);
    expect(await capOf("ops/deploy.ts")).not.toBe(billingId);
    // Files sit under their area (or the capability when it has one area).
    const area = await entityAt(db, scope, seq, charge.parentId!);
    expect(area?.kind === "area" ? area.parentId : charge.parentId).toBe(billingId);
    const billing = caps.find((c) => c.id === billingId)!;
    expect(billing.name).toMatch(/Payments|Cart/);
    expect(billing.data).toMatchObject({
      counts: { files: 4 },
      nameSource: "concepts",
      grouping: { version: GROUPING_VERSION },
    });
    expect((checkout.data.membership as { rationale: unknown[] }).rationale.length).toBeGreaterThan(
      0,
    );
    // No evidence or not analyzed yet: unclassified, never a capability.
    expect((await placed("misc/notes.ts")).parentId).toBe(GROUPS.unclassified);
    expect((await placed("misc/notes.ts")).data.membership).toMatchObject({
      unclassified: "no-evidence",
    });
    expect((await placed("web/pending.ts")).parentId).toBe(GROUPS.unclassified);
    expect((await entityAt(db, scope, seq, GROUPS.unclassified))?.data).toMatchObject({
      members: 2,
    });
    expect(rows(sqlite, "atlas_assignments")).toBe(0);

    // Unchanged inputs: the same capabilities, and nothing rewritten.
    const before = rows(sqlite, "atlas_entities");
    const second = await build("c2");
    expect(rows(sqlite, "atlas_entities")).toBe(before);
    expect((await entityAt(db, scope, second.seq, billing.id))?.name).toBe(billing.name);
  });
});
