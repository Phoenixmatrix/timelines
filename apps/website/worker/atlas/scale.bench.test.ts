// The Atlas scale benchmark (CORE-177; PRD CORE-155 gate 18). On-demand, never
// in `vp test`: it builds the PRD's workloads with the real graph builder and
// Atlas projection (worker/testing/atlas-repo.ts: the first graph written row
// by row, pushes through applyGraph), then measures.
//
//   vp run website#atlas-bench           (server: projection and API, ~10 min)
//   vp run website#atlas-bench-browser   (server and Chromium; needs `vp run website#build`)
//
// Knobs (environment): ATLAS_SCALE_FILES (20000) and ATLAS_SCALE_IMPORTS (60)
// size the single repository; ATLAS_SCALE_REPOS (50) splits the same files
// across that many repositories for the workspace aggregate;
// ATLAS_SCALE_SAMPLES (30); ATLAS_SCALE_OUT, where the JSON results go
// (default: the system temp directory); ATLAS_SCALE_BROWSER=1 adds the client.
//
// What it measures, and the boundaries:
// - Projection: a full pass and incremental pushes of 1 and 10 files, per
//   phase, with D1 round trips.
// - API: each Atlas route through the real application (worker/app.ts: token
//   authentication, routing, the handlers) over local node:sqlite D1, in this
//   process. Time is the handler's, request to body; it has no network and no
//   D1 latency, so production adds round trips x D1 latency, which is why every
//   result records its round trips. Payloads: raw and gzip bytes.
// - Client: the production client build served from this process (gzip, like
//   the edge), in headless Chromium with CDP throttling (50 ms latency, 20 Mbps
//   down/up, CPU slowed ATLAS_SCALE_CPU times, default 4): the overview from a
//   cold navigation (shell included) and from a reload (shell cached), a child
//   page and an entity's detail from a key press until drawn, and frames per
//   second while panning and zooming the map. The host's real cores and
//   memory are recorded with the results; a throttled fast host approximates,
//   and does not reproduce, the PRD's 4-core / 8 GiB client.

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  ATLAS_OVERVIEW_MAX_BYTES,
  ATLAS_OVERVIEW_REGIONS,
  ATLAS_PAGE_MAX,
  type AtlasOverview,
  type AtlasPage,
  type AtlasWorkspaceOverview,
} from "../../shared/atlas.ts";
import { app as server } from "../app.ts";
import { issueToken } from "../api/tokens.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import { d1 as wrap, migratedDatabase } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import {
  atlasPass,
  changeFiles,
  storeGraph,
  storeGraphRows,
  syntheticRepo,
  type SyntheticRepo,
} from "../testing/atlas-repo.ts";
import { repoScope } from "./projection.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));
vi.mock("agents", () => ({
  getAgentByName: () => {
    throw new Error("The Atlas never reaches the assistant");
  },
}));

const RUN = process.env.ATLAS_SCALE === "1";
const FILES = Number(process.env.ATLAS_SCALE_FILES ?? 20_000);
const IMPORTS = Number(process.env.ATLAS_SCALE_IMPORTS ?? 60);
const REPOS = Number(process.env.ATLAS_SCALE_REPOS ?? 50);
const SAMPLES = Number(process.env.ATLAS_SCALE_SAMPLES ?? 30);
const BROWSER = process.env.ATLAS_SCALE_BROWSER === "1";
const CPU = Number(process.env.ATLAS_SCALE_CPU ?? 4);
const OUT = process.env.ATLAS_SCALE_OUT ?? join(tmpdir(), "atlas-scale.json");

// ---- measuring -------------------------------------------------------------------

/** D1 with a count of round trips (a batch is one). */
function counted(d1: D1Database) {
  const counter = { trips: 0 };
  const statement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (prop === "all" || prop === "first" || prop === "run" || prop === "raw")
          return (...args: unknown[]) => {
            counter.trips++;
            return (target[prop] as (...a: unknown[]) => unknown)(...args);
          };
        return target[prop as keyof D1PreparedStatement];
      },
    });
  const db = {
    prepare: (sql: string) => statement(d1.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      counter.trips += 1 - statements.length;
      return d1.batch(statements);
    },
    exec: (sql: string) => d1.exec(sql),
  } as unknown as D1Database;
  return { db, counter };
}

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

const round = (n: number) => Math.round(n * 10) / 10;

function stats(values: number[]) {
  return {
    samples: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(Math.max(...values)),
  };
}

// ---- the workloads ---------------------------------------------------------------

interface Phase {
  ms: number;
  trips: number;
  steps: number;
}

async function pass(
  db: D1Database,
  counter: { trips: number },
  repoId: string,
  buildId: string,
): Promise<{
  incremental: boolean;
  totalMs: number;
  trips: number;
  phases: Record<string, Phase>;
}> {
  const phases: Record<string, Phase> = {};
  const { start } = await atlasPass(db, repoId, buildId, {
    phase: async (name, work) => {
      const start = performance.now();
      const trips = counter.trips;
      const out = await work();
      const p = (phases[name] ??= { ms: 0, trips: 0, steps: 0 });
      p.ms = round(p.ms + performance.now() - start);
      p.trips += counter.trips - trips;
      p.steps++;
      return out;
    },
  });
  const all = Object.values(phases);
  return {
    incremental: start.incremental,
    totalMs: round(all.reduce((n, p) => n + p.ms, 0)),
    trips: all.reduce((n, p) => n + p.trips, 0),
    phases,
  };
}

function sizeOf(sqlite: ReturnType<typeof migratedDatabase>, repoIds: string[]) {
  const scopes = JSON.stringify(repoIds.map(repoScope));
  const one = (sql: string) => Number((sqlite.prepare(sql).get(scopes) as { n: number }).n);
  return {
    repositories: repoIds.length,
    atlasEntities: one(
      `SELECT count(*) AS n FROM atlas_entities WHERE scope IN (SELECT value FROM json_each(?)) AND to_seq IS NULL`,
    ),
    atlasEdges: one(
      `SELECT count(*) AS n FROM atlas_edges WHERE scope IN (SELECT value FROM json_each(?)) AND to_seq IS NULL`,
    ),
    graphNodes: Number(
      (
        sqlite
          .prepare(
            `SELECT count(*) AS n FROM kg_nodes WHERE repo_id IN (SELECT value FROM json_each(?))`,
          )
          .get(JSON.stringify(repoIds)) as { n: number }
      ).n,
    ),
    graphEdges: Number(
      (
        sqlite
          .prepare(
            `SELECT count(*) AS n FROM kg_edges WHERE repo_id IN (SELECT value FROM json_each(?))`,
          )
          .get(JSON.stringify(repoIds)) as { n: number }
      ).n,
    ),
  };
}

function objectState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

const workspaceNames = Array.from({ length: REPOS }, (_, i) => `w${String(i).padStart(2, "0")}`);

const memory = () => {
  const m = process.memoryUsage();
  return `rss ${Math.round(m.rss / 2 ** 20)} MiB, heap ${Math.round(m.heapUsed / 2 ** 20)} MiB`;
};

async function buildWorld(log: (line: string) => void) {
  const sqlite = migratedDatabase();
  sqlite.exec(
    `INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann')`,
  );
  const git = fakeRemotes();
  const insert = sqlite.prepare(
    `INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
     VALUES (?, 'ann', ?, 'private', ?, ?)`,
  );
  for (const [id, name] of [
    ["r_big", "big"],
    ...workspaceNames.map((n) => [`r_${n}`, n]),
  ] as const) {
    insert.run(id, name, `scale-${id}`, `https://${id}`);
    git.add(`https://${id}`, { "refs/heads/main": "0".repeat(39) + "1" }, undefined, `scale-${id}`);
    sqlite
      .prepare(`INSERT INTO kg_state (repo_id, indexed_commit) VALUES (?, ?)`)
      .run(id, "0".repeat(39) + "1");
  }
  const { db, counter } = counted(wrap(sqlite));

  // One repository with the whole workload.
  const big: SyntheticRepo = syntheticRepo(FILES, 1, { imports: IMPORTS });
  log(`single: ${FILES} files generated (${memory()})`);
  let start = performance.now();
  await storeGraphRows(sqlite, big, "r_big", "full");
  const graphMs = round(performance.now() - start);
  log(`single: graph stored in ${graphMs} ms (${memory()})`);
  const full = await pass(db, counter, "r_big", "full");
  log(`single: full projection ${full.totalMs} ms, ${full.trips} trips (${memory()})`);
  const pushes: Record<string, unknown> = {};
  for (const n of [1, 10]) {
    changeFiles(big, n);
    start = performance.now();
    await storeGraph(sqlite, db, big, "r_big", `push-${n}`);
    const graph = round(performance.now() - start);
    const projection = await pass(db, counter, "r_big", `push-${n}`);
    pushes[`push-${n}`] = { graphMs: graph, projection };
    log(`single: push of ${n} file(s) projected in ${projection.totalMs} ms`);
  }
  const single = { workload: sizeOf(sqlite, ["r_big"]), graphMs, full, ...pushes };

  // The same files spread across REPOS repositories.
  start = performance.now();
  const perRepo: number[] = [];
  for (const [i, name] of workspaceNames.entries()) {
    const repo = syntheticRepo(Math.ceil(FILES / REPOS), 100 + i, { imports: IMPORTS });
    await storeGraphRows(sqlite, repo, `r_${name}`, "full");
    perRepo.push((await pass(db, counter, `r_${name}`, "full")).totalMs);
  }
  const aggregate = {
    workload: sizeOf(
      sqlite,
      workspaceNames.map((n) => `r_${n}`),
    ),
    buildMs: round(performance.now() - start),
    projectionPerRepository: stats(perRepo),
  };
  log(`aggregate: ${REPOS} repositories built in ${aggregate.buildMs} ms`);

  const token = (await issueToken(db, "ann", "bench", "read")).secret;
  const coordinators = new Map<string, KnowledgeCoordinator>();
  const env = {
    DB: db,
    BETTER_AUTH_SECRET: "bench-secret-bench-secret-bench-secret",
    ARTIFACTS: git.artifacts,
    KNOWLEDGE_COORDINATOR: {
      getByName: (id: string) => {
        let found = coordinators.get(id);
        if (!found) coordinators.set(id, (found = new KnowledgeCoordinator(objectState(), env)));
        return found;
      },
    },
  } as unknown as Env;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    return href.startsWith("https://r_") ? git.fetch(input, init) : realFetch(input, init);
  });
  const executionCtx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return server.request(path, { ...init, headers }, env, executionCtx);
  };
  return { sqlite, counter, single, aggregate, request };
}

type World = Awaited<ReturnType<typeof buildWorld>>;

/** One route, SAMPLES times after a first request: latency, payload and round trips. */
async function route(w: World, label: string, path: string) {
  const times: number[] = [];
  let first = 0;
  let body = "";
  let trips = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const before = w.counter.trips;
    const start = performance.now();
    const response = await w.request(path);
    body = await response.text();
    const ms = performance.now() - start;
    if (response.status !== 200) throw new Error(`${label}: ${response.status} ${body}`);
    trips = w.counter.trips - before;
    if (i === 0) first = round(ms);
    else times.push(ms);
  }
  const json = JSON.parse(body) as { items?: unknown[]; regions?: unknown[] };
  return {
    scenario: label,
    path: path.replace(/cursor=[^&]+/, "cursor=…").slice(0, 160),
    firstMs: first,
    ...stats(times),
    d1RoundTrips: trips,
    records: json.items?.length ?? json.regions?.length ?? null,
    bytes: new TextEncoder().encode(body).length,
    gzipBytes: gzipSync(body).length,
  };
}

const enc = encodeURIComponent;

async function singleRoutes(w: World) {
  const atlas = "/api/repos/ann/big/atlas";
  const get = async <T>(path: string) => (await (await w.request(path)).json()) as T;
  const overview = await get<AtlasOverview>(`${atlas}/overview`);
  const scope = repoScope("r_big");
  const one = <T>(sql: string, ...args: (string | number)[]) =>
    w.sqlite.prepare(sql).get(...args) as T;
  const biggest = overview.regions[0]!.id;
  const fanOut = one<{ id: string; n: number }>(
    `SELECT parent_id AS id, count(*) AS n FROM atlas_entities WHERE scope = ? AND to_seq IS NULL
     GROUP BY parent_id ORDER BY n DESC LIMIT 1`,
    scope,
  );
  const hub = one<{ id: string; n: number }>(
    `SELECT dst AS id, count(*) AS n FROM atlas_edges WHERE scope = ? AND to_seq IS NULL AND kind = 'imports'
     AND dst LIKE 'file:%' GROUP BY dst ORDER BY n DESC LIMIT 1`,
    scope,
  );
  const symbol = one<{ id: string }>(
    `SELECT entity_id AS id FROM atlas_entities WHERE scope = ? AND to_seq IS NULL AND kind = 'symbol'
     ORDER BY entity_id LIMIT 1 OFFSET 777`,
    scope,
  );
  const dependency = one<{ src: string; dst: string } | undefined>(
    `SELECT src, dst FROM atlas_edges WHERE scope = ? AND to_seq IS NULL AND kind = 'depends_on'
     ORDER BY weight DESC LIMIT 1`,
    scope,
  );
  const children = await get<AtlasPage<unknown>>(`${atlas}/children?id=${enc(biggest)}&limit=100`);
  // The full pass's snapshot against the current one, two pushes later (11 files).
  const snapshots = w.sqlite
    .prepare(`SELECT id FROM atlas_snapshots WHERE scope = ? AND status = 'published' ORDER BY seq`)
    .all(scope) as { id: string }[];
  const compare = `${atlas}/compare?from=${enc(snapshots[0]!.id)}&to=${enc(snapshots.at(-1)!.id)}&limit=100`;
  const results = [
    await route(w, "overview", `${atlas}/overview`),
    await route(w, "catalogue page (regions)", `${atlas}/regions?limit=100`),
    await route(
      w,
      "children, largest capability",
      `${atlas}/children?id=${enc(biggest)}&limit=100`,
    ),
    ...(children.next
      ? [
          await route(
            w,
            "children, next page (cursor)",
            `${atlas}/children?id=${enc(biggest)}&limit=100&cursor=${enc(children.next)}`,
          ),
        ]
      : []),
    await route(
      w,
      `children, highest fan-out (${fanOut.n})`,
      `${atlas}/children?id=${enc(fanOut.id)}&limit=100`,
    ),
    await route(w, "detail, capability", `${atlas}/detail?id=${enc(biggest)}`),
    await route(w, "detail, symbol", `${atlas}/detail?id=${enc(symbol.id)}`),
    await route(w, "ancestors, symbol (deep link)", `${atlas}/ancestors?id=${enc(symbol.id)}`),
    await route(
      w,
      `relations in, most imported file (${hub.n})`,
      `${atlas}/relations?id=${enc(hub.id)}&direction=in&limit=100`,
    ),
    await route(
      w,
      "relations out, capability",
      `${atlas}/relations?id=${enc(biggest)}&direction=out&limit=100`,
    ),
    await route(w, "evidence, capability", `${atlas}/evidence?id=${enc(biggest)}&limit=100`),
    ...(dependency
      ? [
          await route(
            w,
            "contributing imports, capability pair",
            `${atlas}/contributing?id=${enc(dependency.src)}&other=${enc(dependency.dst)}&direction=out&limit=100`,
          ),
        ]
      : []),
    await route(w, "catalogue lookup, common term", `${atlas}/catalogue?q=topic&limit=50`),
    await route(w, "catalogue lookup, rare term", `${atlas}/catalogue?q=f7.ts&limit=50`),
    await route(w, "snapshots", `${atlas}/snapshots`),
    await route(w, "compare, full pass to two pushes later", compare),
  ];
  return { overview, results };
}

async function workspaceRoutes(w: World) {
  const base = `/api/accounts/ann/atlas`;
  const repos = `repos=${workspaceNames.join(",")}`;
  const overview = (await (
    await w.request(`${base}/overview?${repos}`)
  ).json()) as AtlasWorkspaceOverview;
  const biggest = overview.regions[0]!.id;
  const [repoId] = biggest.split("/");
  const symbol = w.sqlite
    .prepare(
      `SELECT entity_id AS id FROM atlas_entities WHERE scope = ? AND to_seq IS NULL AND kind = 'symbol' LIMIT 1`,
    )
    .get(repoScope(repoId!)) as { id: string };
  const deep = `${repoId}/${symbol.id}`;
  const results = [
    await route(w, "overview", `${base}/overview?${repos}`),
    await route(w, "catalogue page (regions)", `${base}/regions?${repos}&limit=100`),
    await route(
      w,
      "children, largest capability",
      `${base}/children?${repos}&id=${enc(biggest)}&limit=100`,
    ),
    await route(w, "detail, capability", `${base}/detail?${repos}&id=${enc(biggest)}`),
    await route(w, "ancestors, symbol (deep link)", `${base}/ancestors?${repos}&id=${enc(deep)}`),
    await route(
      w,
      "relations out, capability",
      `${base}/relations?${repos}&id=${enc(biggest)}&direction=out&limit=100`,
    ),
    await route(
      w,
      "evidence, capability",
      `${base}/evidence?${repos}&id=${enc(biggest)}&limit=100`,
    ),
    await route(w, "catalogue lookup, common term", `${base}/catalogue?${repos}&q=topic&limit=50`),
    await route(w, "composition", `${base}/composition?${repos}&limit=100`),
  ];
  return { overview, results };
}

// ---- the client --------------------------------------------------------------------

/** What the page's scripts below touch (the worker's types have no DOM). */
interface Page {
  document: { querySelectorAll(selector: string): { length: number } };
  requestAnimationFrame(callback: (t: number) => void): number;
  __frames: number[];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** The production client and the API from this process, gzipped like the edge does. */
async function serve(w: World, dist: string): Promise<{ origin: string; server: Server }> {
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bench");
    const gzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
    const send = (status: number, type: string, body: Uint8Array, cache: string) => {
      const compress = gzip && /json|javascript|css|html|svg/.test(type) && body.length > 512;
      res.writeHead(status, {
        "content-type": type,
        "cache-control": cache,
        ...(compress ? { "content-encoding": "gzip" } : {}),
      });
      res.end(compress ? gzipSync(body) : body);
    };
    if (url.pathname.startsWith("/api/")) {
      const response = await w.request(`${url.pathname}${url.search}`, {
        method: req.method,
      });
      return send(
        response.status,
        response.headers.get("content-type") ?? "application/json",
        new Uint8Array(await response.arrayBuffer()),
        "private, no-store",
      );
    }
    const file = normalize(join(dist, url.pathname));
    const found =
      file.startsWith(dist) && existsSync(file) && extname(file) ? file : join(dist, "index.html");
    const immutable = found.includes(`${join(dist, "assets")}`);
    send(
      200,
      TYPES[extname(found)] ?? "application/octet-stream",
      await readFile(found),
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { origin: `http://127.0.0.1:${address.port}`, server: http };
}

async function browserRuns(w: World) {
  const dist = fileURLToPath(
    new URL("../../.cloudflare/output/v0/workers/default/assets/", import.meta.url).href,
  );
  if (!existsSync(join(dist, "index.html")))
    throw new Error("Build the client first: vp run website#build");
  const { chromium } = await import("@playwright/test");
  const { origin, server: http } = await serve(w, dist);
  const browser = await chromium.launch({ headless: true });
  const timings: Record<string, number[]> = {};
  const add = (key: string, ms: number) => (timings[key] ??= []).push(ms);
  const transfers: Record<string, number> = {};
  const fullMapFetches: string[] = [];
  let childRequests = 0;
  try {
    for (let i = 0; i < SAMPLES; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 50,
        downloadThroughput: (20 * 1024 * 1024) / 8,
        uploadThroughput: (20 * 1024 * 1024) / 8,
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
      page.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        if (/\/graph(\/|$|\?)/.test(path)) fullMapFetches.push(r.url());
        if (path.endsWith("/atlas/children")) childRequests++;
      });
      page.on("requestfinished", async (r) => {
        const path = new URL(r.url()).pathname;
        if (path.endsWith("/atlas/overview") && i === 0)
          transfers.overviewTransferBytes = (await r.sizes()).responseBodySize;
      });

      // The repository's Knowledge tab, cold: shell, data, first drawing.
      const tree = page.getByRole("tree", { name: "Outline of ann/big" });
      const map = page.getByRole("img", { name: /^Capability map/ });
      let start = performance.now();
      await page.goto(`${origin}/ann/big/knowledge`);
      await tree.getByRole("treeitem").first().waitFor();
      await map.waitFor();
      add("repository overview, cold navigation", performance.now() - start);

      start = performance.now();
      await page.reload();
      await tree.getByRole("treeitem").first().waitFor();
      await map.waitFor();
      add("repository overview, reload (shell cached)", performance.now() - start);

      // A child page: open the last region in the outline, whose children
      // nothing has read yet (the request is checked, not assumed).
      const regions = tree.locator('[role="treeitem"][aria-level="1"]');
      const first = regions.last();
      await first.focus();
      const asked = childRequests;
      const level2 = '[role="tree"] [role="treeitem"][aria-level="2"]';
      const shown = await page.locator(level2).count();
      start = performance.now();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ([selector, n]) =>
          (globalThis as unknown as Page).document.querySelectorAll(selector).length > n,
        [level2, shown] as const,
      );
      add("child page (expand a region)", performance.now() - start);
      if (childRequests === asked) throw new Error("Expanding the region read no children page");

      // An entity's detail: select it.
      await first.focus();
      start = performance.now();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.searchParams.has("select"));
      await page
        .getByRole("complementary", { name: "Regions" })
        .getByRole("heading", { level: 2 })
        .first()
        .waitFor();
      add("detail (select an entity)", performance.now() - start);

      // Pan and zoom the map for two seconds, counting frames.
      const box = await map.boundingBox();
      if (box) {
        await page.evaluate(() => {
          const w = globalThis as unknown as Page;
          w.__frames = [];
          const tick = (t: number) => {
            w.__frames.push(t);
            if (w.__frames.length < 100_000) w.requestAnimationFrame(tick);
          };
          w.requestAnimationFrame(tick);
        });
        const still = i === 0 ? await map.screenshot() : null;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        const until = performance.now() + 2000;
        let k = 0;
        while (performance.now() < until) {
          if (k % 2 === 0) await page.mouse.wheel(0, k % 4 === 0 ? -240 : 240);
          else {
            await page.mouse.down();
            await page.mouse.move(cx + (k % 3) * 40 - 40, cy + 30, { steps: 4 });
            await page.mouse.up();
            await page.mouse.move(cx, cy);
          }
          k++;
        }
        if (still && still.equals(await map.screenshot()))
          throw new Error("Panning and zooming didn't move the map");
        const frames = await page.evaluate(() => (globalThis as unknown as Page).__frames);
        if (frames.length > 1) {
          const seconds = (frames.at(-1)! - frames[0]!) / 1000;
          add("pan/zoom frames per second", (frames.length - 1) / seconds);
          const gaps = frames.slice(1).map((t, j) => t - frames[j]!);
          add("pan/zoom longest frame (ms)", Math.max(...gaps));
        }
      }

      // The workspace's overview across every repository, cold.
      start = performance.now();
      await page.goto(`${origin}/ann/-/atlas?repos=${workspaceNames.join(",")}`);
      await page.getByRole("img", { name: /^Capability map of/ }).waitFor();
      await page.getByRole("region", { name: `Regions in ${workspaceNames[0]}` }).waitFor();
      add("workspace overview, navigation (shell cached)", performance.now() - start);
      await context.close();
    }
  } finally {
    await browser.close();
    http.close();
  }
  return {
    profile: {
      chromium: browser.version(),
      host: {
        cpu: cpus()[0]?.model ?? "unknown",
        threads: cpus().length,
        memoryGiB: round(totalmem() / 2 ** 30),
      },
      throttling: { latencyMs: 50, throughputMbps: 20, cpuSlowdown: CPU },
      viewport: "1280x900",
    },
    results: Object.entries(timings).map(([scenario, values]) => ({ scenario, ...stats(values) })),
    ...transfers,
    fullMapFetches: fullMapFetches.length,
  };
}

describe.skipIf(!RUN)("Atlas scale benchmark", () => {
  test(`${FILES} files in one repository and across ${REPOS}`, { timeout: 7_200_000 }, async () => {
    const lines: string[] = [];
    const log = (line: string) => {
      lines.push(line);
      console.log(line);
    };
    const w = await buildWorld(log);
    const single = await singleRoutes(w);
    const aggregate = await workspaceRoutes(w);
    const results = {
      measuredAt: new Date().toISOString(),
      boundary:
        "Server: the real app in-process over local node:sqlite D1 (no network, no D1 latency); request to body. Client: production build served from this process, headless Chromium with CDP throttling.",
      node: process.version,
      host: {
        cpu: cpus()[0]?.model ?? "unknown",
        threads: cpus().length,
        memoryGiB: round(totalmem() / 2 ** 30),
      },
      knobs: { files: FILES, imports: IMPORTS, repositories: REPOS, samples: SAMPLES },
      single: { ...w.single, api: single.results },
      aggregate: { ...w.aggregate, api: aggregate.results },
      client: BROWSER ? await browserRuns(w) : null,
    };
    await mkdir(join(OUT, ".."), { recursive: true });
    await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Results: ${OUT}`);
    for (const [label, api] of [
      ["single", single.results],
      ["aggregate", aggregate.results],
    ] as const) {
      console.log(`\n${label}`);
      console.table(
        api.map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "path"))),
      );
    }
    if (results.client) console.table(results.client.results);

    // The bounds hold at this scale too (the fast gates hold them in `vp test`).
    for (const overview of [single.overview, aggregate.overview]) {
      expect(overview.regions.length).toBeLessThanOrEqual(ATLAS_OVERVIEW_REGIONS);
      expect(gzipSync(JSON.stringify(overview)).length).toBeLessThanOrEqual(
        ATLAS_OVERVIEW_MAX_BYTES,
      );
    }
    for (const r of [...single.results, ...aggregate.results])
      expect(r.records ?? 0, r.scenario).toBeLessThanOrEqual(ATLAS_PAGE_MAX);
    if (results.client) expect(results.client.fullMapFetches).toBe(0);
  });
});
