// The Atlas's scale gates that are deterministic enough for every `vp test`
// (CORE-177; PRD CORE-155 gate 18). Timings aren't: they live in the on-demand
// benchmark (scale.bench.test.ts, `vp run website#atlas-bench`) with recorded
// results. What holds here, on repositories built by the real graph writer
// and projection:
// - Each read route makes the same number of D1 round trips whatever the
//   repository's size, and a workspace's grow only with the repositories it
//   selects: no route's work fans out with the graph.
// - Every statement a read route sends to D1 finds its rows through an index:
//   no full scan of an Atlas table, whatever the scope.
// - Pages hold at most 100 records, the overview at most 12 regions and under
//   256 KiB compressed, and nothing reads the whole graph.

import { gzipSync } from "node:zlib";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { onTestFinished, describe, expect, test, vi } from "vite-plus/test";
import {
  ATLAS_OVERVIEW_MAX_BYTES,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_PAGE_MAX,
  type AtlasOverview,
  type AtlasPage,
  type AtlasWorkspaceOverview,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { atlasPass, storeGraph, syntheticRepo } from "../testing/atlas-repo.ts";
import { atlas } from "./api.ts";
import { clearCompositionCache } from "./compose.ts";
import { repoScope } from "./projection.ts";
import { workspaceAtlas } from "./workspace.ts";

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

/** D1 that records every statement it runs (a batch is one round trip). */
function recording(sqlite: DatabaseSync) {
  const inner = d1(sqlite);
  const log = { trips: 0, statements: [] as { sql: string; params: SQLInputValue[] }[] };
  const statement = (sql: string, params: SQLInputValue[]): D1PreparedStatement => {
    const real = inner.prepare(sql).bind(...params);
    const run =
      (method: "all" | "first" | "run" | "raw") =>
      (...args: unknown[]) => {
        log.trips++;
        log.statements.push({ sql, params });
        return (real[method] as (...a: unknown[]) => unknown)(...args);
      };
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      all: run("all"),
      first: run("first"),
      run: run("run"),
      raw: run("raw"),
    } as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => statement(sql, []),
    batch: (statements: D1PreparedStatement[]) => {
      log.trips++;
      return Promise.all(statements.map((s) => s.all())).finally(() => {
        log.trips -= statements.length;
      });
    },
    exec: (sql: string) => inner.exec(sql),
  } as unknown as D1Database;
  return { db, log };
}

/** `count` repositories of `files` files each, built and projected the way a Knowledge build does. */
async function world(files: number, count = 1) {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(
    `INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
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
  `,
  );
  const build = d1(sqlite);
  const names = Array.from({ length: count }, (_, i) => `r${i}`);
  for (const [i, name] of names.entries()) {
    sqlite
      .prepare(
        `INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
         VALUES (?, 'ann', ?, 'private', ?, '')`,
      )
      .run(`id_${name}`, name, `a-${name}`);
    await storeGraph(sqlite, build, syntheticRepo(files, 11 + i), `id_${name}`, "b1");
    await atlasPass(build, `id_${name}`, "b1");
  }
  const { db, log } = recording(sqlite);
  const env = {
    ...fresh.env,
    DB: db,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/repos/:space/:name/atlas", atlas);
  app.route("/api/spaces/:space/atlas", workspaceAtlas);
  /** A request: its body, and the round trips and statements it made. */
  const call = async (path: string) => {
    // Worlds share repository ids: never one's composition in another.
    clearCompositionCache();
    const trips = log.trips;
    const from = log.statements.length;
    const response = await app.request(path, {}, env);
    const text = await response.text();
    expect(response.status, `${path}: ${text}`).toBe(200);
    return { text, trips: log.trips - trips, statements: log.statements.slice(from) };
  };
  return { sqlite, call, names };
}

const enc = encodeURIComponent;

/** Every repository read route, at ids chosen the same way whatever the size. */
async function routes(w: Awaited<ReturnType<typeof world>>) {
  const base = "/api/repos/ann/r0/atlas";
  const overview = JSON.parse((await w.call(`${base}/overview`)).text) as AtlasOverview;
  const capability = overview.regions.find((r) => r.kind === "capability")!.id;
  const scope = repoScope("id_r0");
  const one = (sql: string) => w.sqlite.prepare(sql).get(scope) as { id: string };
  const symbol = one(
    `SELECT entity_id AS id FROM atlas_entities WHERE scope = ? AND to_seq IS NULL AND kind = 'symbol' ORDER BY entity_id LIMIT 1`,
  ).id;
  const hub = one(
    `SELECT dst AS id FROM atlas_edges WHERE scope = ? AND to_seq IS NULL AND kind = 'imports' AND dst LIKE 'file:%'
     GROUP BY dst ORDER BY count(*) DESC, dst LIMIT 1`,
  ).id;
  const pair = w.sqlite
    .prepare(
      `SELECT src, dst FROM atlas_edges WHERE scope = ? AND to_seq IS NULL AND kind = 'depends_on' ORDER BY weight DESC, src, dst LIMIT 1`,
    )
    .get(scope) as { src: string; dst: string };
  const children = JSON.parse(
    (await w.call(`${base}/children?id=${enc(capability)}&limit=2`)).text,
  ) as AtlasPage<unknown>;
  return {
    overview: `${base}/overview`,
    regions: `${base}/regions?limit=100`,
    children: `${base}/children?id=${enc(capability)}&limit=100`,
    "children cursor": `${base}/children?id=${enc(capability)}&limit=2&cursor=${enc(children.next!)}`,
    detail: `${base}/detail?id=${enc(capability)}`,
    "detail symbol": `${base}/detail?id=${enc(symbol)}`,
    ancestors: `${base}/ancestors?id=${enc(symbol)}`,
    "relations in": `${base}/relations?id=${enc(hub)}&direction=in&limit=100`,
    "relations out": `${base}/relations?id=${enc(capability)}&direction=out&limit=100`,
    contributing: `${base}/contributing?id=${enc(pair.src)}&other=${enc(pair.dst)}&direction=out&limit=100`,
    evidence: `${base}/evidence?id=${enc(capability)}&limit=100`,
    catalogue: `${base}/catalogue?q=topic&limit=100`,
  };
}

const ATLAS_TABLES =
  /\b(atlas_entities|atlas_edges|atlas_snapshots|atlas_current|atlas_lineage|atlas_scopes)\b/;

describe("Atlas scale gates", () => {
  test(
    "read routes cost the same round trips at 8x the repository, and stay within their bounds",
    { timeout: 120_000 },
    async () => {
      const small = await world(120);
      const large = await world(960);
      const trips = async (w: typeof small) => {
        const out: Record<string, number> = {};
        for (const [name, path] of Object.entries(await routes(w))) {
          const r = await w.call(path);
          out[name] = r.trips;
          const body = JSON.parse(r.text) as { items?: unknown[]; regions?: unknown[] };
          expect(body.items?.length ?? 0, name).toBeLessThanOrEqual(ATLAS_PAGE_MAX);
          if (body.regions) {
            expect(body.regions.length).toBeLessThanOrEqual(ATLAS_OVERVIEW_REGIONS);
            expect(gzipSync(r.text).length).toBeLessThan(ATLAS_OVERVIEW_MAX_BYTES);
          }
        }
        return out;
      };
      const entities = (w: typeof small) =>
        (
          w.sqlite
            .prepare(`SELECT count(*) AS n FROM atlas_entities WHERE scope = ? AND to_seq IS NULL`)
            .get(repoScope("id_r0")) as { n: number }
        ).n;
      expect(entities(large)).toBeGreaterThan(6 * entities(small));
      expect(await trips(large)).toEqual(await trips(small));
    },
  );

  test(
    "a workspace's round trips grow with the repositories it selects, not their size",
    { timeout: 120_000 },
    async () => {
      const perRoute = async (files: number, count: number) => {
        const w = await world(files, count);
        const repos = `repos=${w.names.join(",")}`;
        const base = `/api/spaces/ann/atlas`;
        const overview = JSON.parse(
          (await w.call(`${base}/overview?${repos}`)).text,
        ) as AtlasWorkspaceOverview;
        expect(overview.regions.length).toBeLessThanOrEqual(ATLAS_OVERVIEW_REGIONS);
        const capability = overview.regions.find((r) => r.kind === "capability")!.id;
        const out: Record<string, number> = {};
        for (const [name, path] of Object.entries({
          overview: `${base}/overview?${repos}`,
          regions: `${base}/regions?${repos}&limit=100`,
          catalogue: `${base}/catalogue?${repos}&q=topic&limit=100`,
          children: `${base}/children?${repos}&id=${enc(capability)}&limit=100`,
          detail: `${base}/detail?${repos}&id=${enc(capability)}`,
          composition: `${base}/composition?${repos}&limit=100`,
        }))
          out[name] = (await w.call(path)).trips;
        return out;
      };
      const two = await perRoute(60, 2);
      // The same repositories, each 8x larger: the same trips.
      expect(await perRoute(480, 2)).toEqual(two);
      // Twice the repositories: entity routes read one repository; ranked ones at most one more trip per repository.
      const four = await perRoute(60, 4);
      for (const name of ["children", "detail"]) expect(four[name], name).toBe(two[name]);
      for (const name of ["overview", "regions", "catalogue", "composition"])
        expect(four[name]! - two[name]!, name).toBeLessThanOrEqual(2 * 2 * 4);
    },
  );

  test(
    "every statement a read route sends finds Atlas rows through an index",
    { timeout: 120_000 },
    async () => {
      const w = await world(240, 2);
      const paths = [
        ...Object.values(await routes(w)),
        ...["overview", "regions?limit=100", "catalogue?q=topic", "composition"].map(
          (r) => `/api/spaces/ann/atlas/${r}${r.includes("?") ? "&" : "?"}repos=r0,r1`,
        ),
      ];
      const scans = new Set<string>();
      let checked = 0;
      for (const path of paths) {
        for (const { sql, params } of (await w.call(path)).statements) {
          if (!ATLAS_TABLES.test(sql)) continue;
          checked++;
          const plan = w.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
            detail: string;
          }[];
          for (const { detail } of plan)
            if (
              /^SCAN (atlas_\w+|[a-z]\b)/.test(detail) &&
              !/USING (COVERING )?INDEX|PRIMARY KEY/.test(detail)
            )
              scans.add(`${detail} :: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
        }
      }
      expect(checked).toBeGreaterThan(40);
      expect([...scans]).toEqual([]);
    },
  );
});
