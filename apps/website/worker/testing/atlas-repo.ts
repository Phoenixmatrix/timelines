// A synthetic repository for Atlas tests and measurements (CORE-166): files
// with analyses (symbols, concepts, imports between files and packages),
// turned into a knowledge graph by the real buildGraph/applyGraph, so the
// projection reads exactly what a build would store. Deterministic per seed.

import type { DatabaseSync } from "node:sqlite";
import { ANALYZER, type FileAnalysis } from "../knowledge/analyze.ts";
import { applyGraph, buildGraph, type GraphDiff, type SnapshotFile } from "../knowledge/graph.ts";
import {
  describeRepoCapabilities,
  type AtlasInfer,
  type DescribeStats,
} from "../atlas/describe.ts";
import {
  beginRepoProjection,
  failProjection,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
  type GroupStats,
  type ProjectionStart,
} from "../atlas/projection.ts";
import { admitProjection, enforceRetention } from "../atlas/retention.ts";

/** mulberry32: small, fast and deterministic. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticRepo {
  files: Map<string, FileAnalysis>;
  /** Content version per path: a changed file gets a new blob. */
  versions: Map<string, number>;
  /** Paths whose analysis hasn't landed yet. */
  pending: Set<string>;
  next: () => number;
}

const FILES_PER_DIR = 24;
const DIRS_PER_MODULE = 16;
const MODULE_CONCEPTS = 14;
const GLOBAL_CONCEPTS = 40;
const PACKAGES = 30;

const pathOf = (i: number) => {
  const dir = Math.floor(i / FILES_PER_DIR);
  const module = Math.floor(dir / DIRS_PER_MODULE);
  return `src/m${module}/d${dir % DIRS_PER_MODULE}/f${i % FILES_PER_DIR}.ts`;
};

/** A file's analysis: symbols, two or three concepts and a few imports, mostly nearby. */
function analysisFor(path: string, count: number, next: () => number, version = 0): FileAnalysis {
  const [, m, d] = /^src\/m(\d+)\/d(\d+)\//.exec(path) ?? [];
  const module = Number(m ?? 0);
  const dir = Number(d ?? 0);
  const pick = (n: number) => Math.floor(next() * n);
  const local = (k: number) => `m${module} topic ${(dir + k) % MODULE_CONCEPTS}`;
  const concepts = [local(0), local(pick(3) + 1)];
  if (next() < 0.5) concepts.push(`shared topic ${pick(GLOBAL_CONCEPTS)}`);
  const modules = Math.max(1, Math.ceil(count / (FILES_PER_DIR * DIRS_PER_MODULE)));
  const imports: string[] = [];
  for (let k = 0; k < 3; k++) {
    const r = next();
    let target: number;
    const base = (module * DIRS_PER_MODULE + dir) * FILES_PER_DIR;
    if (r < 0.6) target = base + pick(FILES_PER_DIR);
    else if (r < 0.9)
      target = module * DIRS_PER_MODULE * FILES_PER_DIR + pick(FILES_PER_DIR * DIRS_PER_MODULE);
    else
      target =
        pick(modules) * DIRS_PER_MODULE * FILES_PER_DIR + pick(FILES_PER_DIR * DIRS_PER_MODULE);
    if (target < count) imports.push(`/${pathOf(target)}`);
  }
  imports.push(`pkg-${pick(PACKAGES)}`);
  return {
    language: "typescript",
    role: "source",
    lines: 40 + pick(400),
    summary: `Implements part of module ${module}, directory ${dir}: ${path} (revision ${version}).`,
    responsibilities: [`Handles ${concepts[0]}`, `Coordinates ${concepts[1]}`],
    symbols: Array.from({ length: 4 }, (_, k) => ({
      name: `symbol${k}`,
      kind: "function",
      line: 1 + k * 10,
      exported: true,
    })),
    concepts,
    imports,
  };
}

export function syntheticRepo(count: number, seed = 1): SyntheticRepo {
  const next = random(seed);
  const files = new Map<string, FileAnalysis>();
  for (let i = 0; i < count; i++) files.set(pathOf(i), analysisFor(pathOf(i), count, next));
  return { files, versions: new Map(), pending: new Set(), next };
}

/**
 * A push touching `n` files: rewrites (new summary, symbol and import), one
 * new file and one deletion when n >= 3. Returns the touched paths.
 */
export function changeFiles(repo: SyntheticRepo, n: number): string[] {
  const paths = [...repo.files.keys()];
  const touched: string[] = [];
  const edits = n >= 3 ? n - 2 : n;
  for (let k = 0; k < edits; k++) {
    const path = paths[Math.floor(repo.next() * paths.length)]!;
    const version = (repo.versions.get(path) ?? 0) + 1;
    repo.versions.set(path, version);
    const before = repo.files.get(path)!;
    const fresh = analysisFor(path, paths.length, repo.next, version);
    repo.files.set(path, {
      ...before,
      summary: fresh.summary,
      symbols: [
        ...before.symbols,
        { name: `added${version}`, kind: "function", line: 99, exported: true },
      ],
      // Every other edit also rewires an import.
      imports: k % 2 ? fresh.imports : before.imports,
    });
    touched.push(path);
  }
  if (n >= 3) {
    const added = `src/new/f${repo.files.size}.ts`;
    repo.files.set(added, analysisFor(paths[0]!, paths.length, repo.next, 1));
    touched.push(added);
    const removed = paths[Math.floor(repo.next() * paths.length)]!;
    repo.files.delete(removed);
    touched.push(removed);
  }
  return touched;
}

const blobOf = (repo: SyntheticRepo, path: string) => `${path}@${repo.versions.get(path) ?? 0}`;

/**
 * Store the repository's current state as a build would: cards in
 * kg_blob_analysis, then the graph through applyGraph.
 */
export async function storeGraph(
  sqlite: DatabaseSync,
  d1: D1Database,
  repo: SyntheticRepo,
  repoId: string,
  buildId: string,
): Promise<GraphDiff> {
  const files: SnapshotFile[] = [];
  const analyses = new Map<string, FileAnalysis>();
  const insert = sqlite.prepare(
    `INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data, model) VALUES (?, ?, 'typescript', ?, 'fast')
     ON CONFLICT DO NOTHING`,
  );
  sqlite.exec("BEGIN");
  for (const [path, analysis] of repo.files) {
    const blob = blobOf(repo, path);
    files.push({ path, blob, mode: "100644" });
    if (repo.pending.has(path)) continue;
    analyses.set(blob, analysis);
    insert.run(blob, ANALYZER, JSON.stringify(analysis));
  }
  sqlite.exec("COMMIT");
  const graph = buildGraph("synthetic", files, analyses, {
    components: new Map(),
    concepts: new Map(),
  });
  return applyGraph(d1, repoId, buildId, `commit-${buildId}`, graph);
}

/** Every file that mentions `from` now says `to`: the same concept, under a new name. */
export function renameConcept(repo: SyntheticRepo, from: string, to: string) {
  for (const [path, analysis] of repo.files)
    if (analysis.concepts.includes(from)) {
      repo.versions.set(path, (repo.versions.get(path) ?? 0) + 1);
      repo.files.set(path, {
        ...analysis,
        concepts: analysis.concepts.map((c) => (c === from ? to : c)),
      });
    }
}

/** A provider stand-in that counts calls and names what it is shown. */
export function countingInfer(calls: { n: number; hashes: string[] }): AtlasInfer {
  return (async (request: { prompt: string[] }) => {
    calls.n++;
    const user = JSON.parse(request.prompt[1] ?? "{}") as { files?: { path: string }[] };
    return {
      status: "done",
      value: {
        reply: {
          name: `Capability of ${user.files?.[0]?.path ?? "nothing"}`,
          summary: `These files share the work of ${user.files?.length ?? 0} cards.`,
          rationale: "They import each other.",
          sources: [user.files?.[0]?.path],
        },
        model: "fake",
        tokens: 10,
      },
    };
  }) as AtlasInfer;
}

export interface PassOptions {
  full?: boolean;
  entityBatch?: number;
  edgeBatch?: number;
  infer?: AtlasInfer;
  /** Stop after grouping and fail, as a crashed build would. */
  fail?: boolean;
  /** Called around each phase (measurements). */
  phase?: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}

/** One Atlas pass the way the build runs it: start, group, describe, batches, retention, publish. */
export async function atlasPass(
  d1: D1Database,
  repoId: string,
  buildId: string,
  options: PassOptions = {},
): Promise<{ start: ProjectionStart; grouping: GroupStats; described: DescribeStats | null }> {
  const phase = options.phase ?? ((_name, work) => work());
  const scope = repoScope(repoId);
  const start = await phase("start", () =>
    beginRepoProjection(d1, repoId, [{ repoId, commit: `commit-${buildId}`, buildId }], {
      full: options.full,
    }),
  );
  const grouping = await phase("group", () =>
    groupRepoCapabilities(d1, repoId, start.snapshotId, start.seq),
  );
  if (options.fail) {
    await failProjection(d1, scope, start.snapshotId, "crashed");
    return { start, grouping, described: null };
  }
  const described = await phase("describe", () =>
    describeRepoCapabilities(
      { DB: d1 } as unknown as Env,
      {
        repoId,
        buildId,
        snapshotId: start.snapshotId,
        seq: start.seq,
        commit: `commit-${buildId}`,
      },
      { infer: options.infer ?? null, now: () => new Date(0) },
    ),
  );
  let after: string | null = null;
  do
    ({ next: after } = await phase("entities", () =>
      projectEntities(d1, repoId, start.snapshotId, start.seq, after, options.entityBatch),
    ));
  while (after);
  let cursor: EdgeCursor = null;
  do
    ({ next: cursor } = await phase("edges", () =>
      projectEdges(d1, repoId, start.snapshotId, start.seq, cursor, options.edgeBatch),
    ));
  while (cursor);
  await phase("retain+admit", async () => {
    await enforceRetention(d1, [scope]);
    return admitProjection(d1, scope, start.snapshotId);
  });
  await phase("publish", () => publishProjection(d1, scope, start.snapshotId, start.seq));
  return { start, grouping, described };
}
