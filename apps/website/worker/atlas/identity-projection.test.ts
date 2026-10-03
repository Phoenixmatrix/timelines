import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { atlas } from "./api.ts";
import { lineageOf } from "./identity.ts";
import {
  beginRepoProjection,
  entityAt,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const scope = repoScope("r1");

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'shop', 'private', 'art-r1', '');
  `);
  const env = {
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/repos/:owner/:name/atlas", atlas);
  return {
    sqlite,
    db: env.DB,
    call: (path: string) => app.request(`/api/repos/ann/shop/atlas/${path}`, {}, env),
  };
}

function node(sqlite: DatabaseSync, id: string, kind: string, summary = "") {
  const path = id.startsWith("file:") ? id.slice(5) : null;
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES ('r1', ?, ?, ?, ?, ?, ?, 'h', 'c')
       ON CONFLICT (repo_id, id) DO UPDATE SET summary = excluded.summary`,
    )
    .run(id, kind, id.split("/").pop() ?? id, path, summary, JSON.stringify({ blob: id }));
}
const edge = (sqlite: DatabaseSync, src: string, dst: string, kind: string) =>
  sqlite
    .prepare(`INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES ('r1', ?, ?, ?, 1)`)
    .run(src, dst, kind);

/** Billing (4 files) and deployment (3 files), each tied by imports and a concept. */
function seed(sqlite: DatabaseSync) {
  node(sqlite, "repo", "repository");
  node(sqlite, "concept:payments", "concept");
  node(sqlite, "concept:deployment", "concept");
  const billing = ["src/charge.ts", "src/invoice.ts", "web/checkout.ts", "web/cart.ts"];
  const deploy = ["ops/deploy.ts", "ops/rollback.ts", "scripts/canary.ts"];
  for (const path of [...billing, ...deploy]) node(sqlite, `file:${path}`, "file");
  for (let i = 1; i < billing.length; i++)
    edge(sqlite, `file:${billing[i]}`, `file:${billing[i - 1]}`, "imports");
  for (let i = 1; i < deploy.length; i++)
    edge(sqlite, `file:${deploy[i]}`, `file:${deploy[i - 1]}`, "imports");
  for (const path of billing) edge(sqlite, `file:${path}`, "concept:payments", "mentions");
  for (const path of deploy) edge(sqlite, `file:${path}`, "concept:deployment", "mentions");
  return { billing, deploy };
}

async function build(db: D1Database, commit: string) {
  const { snapshotId, seq } = await beginRepoProjection(db, "r1", [
    { repoId: "r1", commit, buildId: commit },
  ]);
  await groupRepoCapabilities(db, "r1", snapshotId, seq);
  let after: string | null = null;
  do ({ next: after } = await projectEntities(db, "r1", snapshotId, seq, after));
  while (after);
  let cursor: EdgeCursor = null;
  do ({ next: cursor } = await projectEdges(db, "r1", snapshotId, seq, cursor));
  while (cursor);
  await publishProjection(db, scope, snapshotId, seq);
  return { snapshotId, seq };
}

const capabilityOf = async (db: D1Database, seq: number, path: string) => {
  const file = await entityAt(db, scope, seq, `file:${path}`);
  return (file!.data.membership as { capability: string | null }).capability!;
};

describe("capability identity across builds", () => {
  test("unrelated edits keep ids and slots and rewrite no capability", async () => {
    const { sqlite, db } = setup();
    const { billing, deploy } = seed(sqlite);
    const first = await build(db, "c1");
    const billingId = await capabilityOf(db, first.seq, billing[0]!);
    const deployId = await capabilityOf(db, first.seq, deploy[0]!);
    expect(billingId).not.toBe(deployId);
    const slot = async (seq: number, id: string) =>
      ((await entityAt(db, scope, seq, id))!.data.layout as { slot: number }).slot;
    const slots = [await slot(first.seq, billingId), await slot(first.seq, deployId)];
    const capabilityRows = () =>
      (
        sqlite
          .prepare("SELECT count(*) AS n FROM atlas_entities WHERE kind = 'capability'")
          .get() as { n: number }
      ).n;
    const rowsBefore = capabilityRows();

    // An unrelated edit: a file's summary changes.
    node(sqlite, `file:${billing[1]}`, "file", "Now with a summary");
    const second = await build(db, "c2");
    expect(await capabilityOf(db, second.seq, billing[0]!)).toBe(billingId);
    expect(await capabilityOf(db, second.seq, deploy[0]!)).toBe(deployId);
    expect([await slot(second.seq, billingId), await slot(second.seq, deployId)]).toEqual(slots);
    expect(capabilityRows()).toBe(rowsBefore);
  });

  test("a removed capability is retired with its lineage, and old links explain it", async () => {
    const { sqlite, db, call } = setup();
    const { billing, deploy } = seed(sqlite);
    const first = await build(db, "c1");
    const billingId = await capabilityOf(db, first.seq, billing[0]!);
    const deployId = await capabilityOf(db, first.seq, deploy[0]!);
    const billingSlot = (await entityAt(db, scope, first.seq, billingId))?.data.layout;

    // Deployment goes away entirely.
    sqlite.exec(
      `DELETE FROM kg_edges WHERE src LIKE 'file:ops/%' OR src LIKE 'file:scripts/%';
       DELETE FROM kg_nodes WHERE id LIKE 'file:ops/%' OR id LIKE 'file:scripts/%';`,
    );
    const second = await build(db, "c2");
    expect(await capabilityOf(db, second.seq, billing[0]!)).toBe(billingId);
    expect((await entityAt(db, scope, second.seq, billingId))?.data.layout).toEqual(billingSlot);
    expect(await entityAt(db, scope, second.seq, deployId)).toBeNull();
    expect(await lineageOf(db, scope, deployId, second.seq)).toMatchObject({
      id: deployId,
      kind: "capability",
      retiredSeq: second.seq,
      change: "removed",
      successors: [],
    });

    // A current link to it explains the change instead of resolving elsewhere.
    const current = await call(`detail?id=${encodeURIComponent(deployId)}`);
    expect(current.status).toBe(404);
    expect(await current.json()).toMatchObject({
      code: "entity_unknown",
      lineage: { id: deployId, change: "removed", successors: [] },
    });
    // A link pinned to the original snapshot still shows it as it was.
    const pinned = await call(
      `detail?id=${encodeURIComponent(deployId)}&snapshot=${first.snapshotId}`,
    );
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ entity: { id: deployId, kind: "capability" } });
  });
});
