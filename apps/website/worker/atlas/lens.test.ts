import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { onTestFinished, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { atlas } from "./api.ts";
import { workspaceAtlas } from "./workspace.ts";
import {
  beginRepoProjection,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  writeCapabilityEdges,
  type EdgeCursor,
} from "./projection.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const scope = repoScope("r1");

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
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
      VALUES ('r1', 'ann', 'shop', 'private', 'art-r1', '');
  `);
  const env = {
    ...fresh.env,
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/repos/:space/:name/atlas", atlas);
  app.route("/api/spaces/:space/atlas", workspaceAtlas);
  return {
    sqlite,
    db: env.DB,
    call: (path: string) => app.request(`/api/repos/ann/shop/atlas/${path}`, {}, env),
    /** The same, across a workspace of this one repository (ids namespaced `r1/`). */
    across: (path: string) =>
      app.request(
        `/api/spaces/ann/atlas/${path}${path.includes("?") ? "&" : "?"}repos=shop`,
        {},
        env,
      ),
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

describe("the relationship lens", () => {
  test("capabilities relate through the imports that cross them, with the links behind each", async () => {
    const { sqlite, call, across } = await setup();
    // A published snapshot with two capabilities and one import crossing them.
    const data = (capability: string) => JSON.stringify({ membership: { capability } });
    sqlite.exec(`
      INSERT INTO atlas_scopes (scope, kind, repo_id) VALUES ('repo:r1', 'repo', 'r1');
      INSERT INTO atlas_snapshots (id, scope, seq, status, projection_version, vector, published_at)
        VALUES ('s1', 'repo:r1', 1, 'published', 3, '[{"repoId":"r1","commit":"c1","buildId":"b1"}]', '2026-10-03T00:00:00Z');
      INSERT INTO atlas_current (scope, snapshot_id, seq, published_at) VALUES ('repo:r1', 's1', 1, '2026-10-03T00:00:00Z');
    `);
    const entity = sqlite.prepare(
      `INSERT INTO atlas_entities (scope, entity_id, from_seq, kind, parent_id, sort_key, name, path, data, content_hash)
       VALUES ('repo:r1', ?, 1, ?, ?, ?, ?, ?, ?, 'h')`,
    );
    entity.run("repo", "repository", null, "shop", "shop", null, "{}");
    entity.run("cap:billing", "capability", "repo", "billing", "Billing", null, "{}");
    entity.run("cap:deploy", "capability", "repo", "deploy", "Deploy", null, "{}");
    entity.run(
      "file:src/charge.ts",
      "file",
      "cap:billing",
      "charge.ts",
      "charge.ts",
      "src/charge.ts",
      data("cap:billing"),
    );
    entity.run(
      "file:src/cart.ts",
      "file",
      "cap:billing",
      "cart.ts",
      "cart.ts",
      "src/cart.ts",
      data("cap:billing"),
    );
    entity.run(
      "file:ops/deploy.ts",
      "file",
      "cap:deploy",
      "deploy.ts",
      "deploy.ts",
      "ops/deploy.ts",
      data("cap:deploy"),
    );
    const link = sqlite.prepare(
      `INSERT INTO atlas_edges (scope, src, dst, kind, from_seq, weight) VALUES ('repo:r1', ?, ?, ?, 1, ?)`,
    );
    link.run("file:src/charge.ts", "ops/deploy.ts".replace(/^/, "file:"), "imports", 1);
    link.run("file:src/cart.ts", "file:src/charge.ts", "imports", 1);
    link.run("cap:billing", "cap:deploy", "depends_on", 1);

    const out = (await (await call("relations?id=cap%3Abilling&direction=out")).json()) as {
      items: { dst: string; kind: string; weight: number; neighbor: { name: string } }[];
    };
    expect(out.items).toEqual([
      expect.objectContaining({
        dst: "cap:deploy",
        kind: "depends_on",
        weight: 1,
        neighbor: expect.objectContaining({ name: "Deploy" }),
      }),
    ]);
    const into = (await (await call("relations?id=cap%3Adeploy&direction=in")).json()) as {
      items: { src: string }[];
    };
    expect(into.items.map((r) => r.src)).toEqual(["cap:billing"]);

    // The links behind it: only the import that crosses, not billing's own.
    const links = (await (
      await call("contributing?id=cap%3Abilling&other=cap%3Adeploy&direction=out")
    ).json()) as {
      items: { src: string; dst: string; srcPath: string; dstPath: string }[];
      counts: { knownTotal: number };
    };
    expect(links.items).toEqual([
      {
        src: "file:src/charge.ts",
        dst: "file:ops/deploy.ts",
        srcPath: "src/charge.ts",
        dstPath: "ops/deploy.ts",
      },
    ]);
    expect(links.counts.knownTotal).toBe(1);
    const back = (await (
      await call("contributing?id=cap%3Adeploy&other=cap%3Abilling&direction=in")
    ).json()) as { items: unknown[] };
    expect(back.items).toHaveLength(1);
    expect((await call("contributing?id=cap%3Abilling&direction=out")).status).toBe(400);

    // Across a workspace: the same links, by namespaced id, at the same snapshot.
    const ws = (await (
      await across("contributing?id=r1%2Fcap%3Abilling&other=r1%2Fcap%3Adeploy&direction=out")
    ).json()) as {
      items: { src: string; dst: string; srcPath: string }[];
      counts: { knownTotal: number };
      snapshot: { repos: { id: string; snapshot: { vector: { commit: string }[] } }[] };
    };
    expect(ws.items).toEqual([
      {
        src: "r1/file:src/charge.ts",
        dst: "r1/file:ops/deploy.ts",
        srcPath: "src/charge.ts",
        dstPath: "ops/deploy.ts",
      },
    ]);
    expect(ws.counts.knownTotal).toBe(1);
    expect(ws.snapshot.repos.map((r) => [r.id, r.snapshot.vector[0]!.commit])).toEqual([
      ["r1", "c1"],
    ]);
    // The other end must be in the same repository, named the same way.
    expect(
      (await across("contributing?id=r1%2Fcap%3Abilling&other=cap%3Adeploy&direction=out")).status,
    ).toBe(400);
    expect(
      (await across("contributing?id=r9%2Fcap%3Abilling&other=r9%2Fcap%3Adeploy")).status,
    ).toBe(404);
  });

  test("capability edges are versioned like graph edges", async () => {
    const { sqlite, db } = await setup();
    sqlite.exec(
      `INSERT INTO atlas_scopes (scope, kind, repo_id) VALUES ('repo:r1', 'repo', 'r1');`,
    );
    const rows = () =>
      sqlite
        .prepare(
          "SELECT src, dst, from_seq, to_seq, weight FROM atlas_edges ORDER BY src, dst, from_seq",
        )
        .all();
    await writeCapabilityEdges(db, "repo:r1", 1, [
      { src: "cap:a", dst: "cap:b", kind: "depends_on", weight: 2 },
      { src: "cap:b", dst: "cap:c", kind: "depends_on", weight: 1 },
    ]);
    // Unchanged a->b stays one row; b->c goes; c->a arrives.
    await writeCapabilityEdges(db, "repo:r1", 2, [
      { src: "cap:a", dst: "cap:b", kind: "depends_on", weight: 2 },
      { src: "cap:c", dst: "cap:a", kind: "depends_on", weight: 1 },
    ]);
    expect(rows()).toEqual([
      { src: "cap:a", dst: "cap:b", from_seq: 1, to_seq: null, weight: 2 },
      { src: "cap:b", dst: "cap:c", from_seq: 1, to_seq: 2, weight: 1 },
      { src: "cap:c", dst: "cap:a", from_seq: 2, to_seq: null, weight: 1 },
    ]);
    // A retried step converges on the same rows.
    await writeCapabilityEdges(db, "repo:r1", 2, [
      { src: "cap:a", dst: "cap:b", kind: "depends_on", weight: 2 },
      { src: "cap:c", dst: "cap:a", kind: "depends_on", weight: 1 },
    ]);
    expect(rows()).toHaveLength(3);
  });

  test("high fan-out pages honestly: loaded, known total and more", async () => {
    const { sqlite, db, call } = await setup();
    seed(sqlite);
    for (let i = 0; i < 150; i++) {
      node(sqlite, `file:users/u${String(i).padStart(3, "0")}.ts`, "file");
      edge(sqlite, `file:users/u${String(i).padStart(3, "0")}.ts`, "file:src/charge.ts", "imports");
    }
    await build(db, "c1");
    const first = (await (
      await call("relations?id=file%3Asrc%2Fcharge.ts&direction=in&kind=imports&limit=100")
    ).json()) as { items: unknown[]; counts: { loaded: number; knownTotal: number }; next: string };
    expect(first.items).toHaveLength(100);
    expect(first.counts).toMatchObject({ loaded: 100, knownTotal: 151 });
    expect(first.next).toBeTruthy();
    const second = (await (
      await call(
        `relations?id=file%3Asrc%2Fcharge.ts&direction=in&kind=imports&limit=100&cursor=${encodeURIComponent(first.next)}`,
      )
    ).json()) as { items: unknown[]; counts: { loaded: number }; next: string | null };
    expect(second.items).toHaveLength(51);
    expect(second.counts.loaded).toBe(151);
    expect(second.next).toBeNull();
  });
});
