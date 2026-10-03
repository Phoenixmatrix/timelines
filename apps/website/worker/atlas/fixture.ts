// DEVELOPMENT AND TESTS ONLY: write a repository's knowledge graph from the
// Atlas fixture (shared/atlasFixture.ts) and project it the way the
// Knowledge build does (group, describe without a model, project, publish,
// retain), so the Atlas UI can be exercised end to end where no Knowledge
// build or model runs: unit tests and the non-AI live E2E (POST /api/dev/atlas).
// Nothing in production reaches this module.

import {
  atlasFixtureFiles,
  atlasFixtureSource,
  atlasFixtureTimelineFiles,
  type AtlasFixtureFile,
  type AtlasFixtureVariant,
} from "../../shared/atlasFixture.ts";
import type { KnowledgeOverlayEndReason } from "../../shared/api.ts";
import type { BuiltGraph, GraphEdge, GraphNode } from "../knowledge/graph.ts";
import { diffGraphs, endOverlays, storeOverlay, type FileChange } from "../knowledge/overlay.ts";
import type { AtlasUnavailableReason } from "../../shared/atlas.ts";
import { describeRepoCapabilities } from "./describe.ts";
import {
  beginRepoProjection,
  groupRepoCapabilities,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "./projection.ts";
import { recordPublishedPackages } from "./publishers.ts";
import { enforceRetention } from "./retention.ts";

const title = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1);

/** Git's blob id for `text`, so evidence names the blob the push really stored. */
async function gitBlob(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Replace a repository's stored graph with the fixture's. */
export async function writeAtlasFixtureGraph(
  d1: D1Database,
  repoId: string,
  repoName: string,
  commit: string,
  variant: AtlasFixtureVariant = "base",
): Promise<void> {
  const files = atlasFixtureFiles(variant);
  const nodes: [string, string, string, string | null, string][] = [
    ["repo", "repository", repoName, null, "{}"],
  ];
  const edges: [string, string, string][] = [];
  const concepts = new Set<string>();
  const packages = new Set<string>();
  for (const file of files) {
    const id = `file:${file.path}`;
    const source = atlasFixtureSource(file);
    const lineCount = source.text.split("\n").length - 1;
    nodes.push([
      id,
      "file",
      file.path.split("/").pop()!,
      file.path,
      JSON.stringify({
        blob: await gitBlob(source.text),
        lines: lineCount,
        language: "typescript",
      }),
    ]);
    for (const target of file.imports) edges.push([id, `file:${target}`, "imports"]);
    for (const concept of file.concepts) {
      concepts.add(concept);
      edges.push([id, `concept:${concept}`, "mentions"]);
    }
    for (const pkg of file.packages ?? []) {
      packages.add(pkg);
      edges.push([id, `pkg:npm:${pkg}`, "imports"]);
    }
    for (const name of file.symbols ?? []) {
      const symbol = `sym:${file.path}#${name}`;
      nodes.push([symbol, "symbol", name, file.path, JSON.stringify({ line: source.lines[name] })]);
      edges.push([id, symbol, "defines"]);
    }
  }
  for (const concept of concepts)
    nodes.push([`concept:${concept}`, "concept", title(concept), null, "{}"]);
  for (const pkg of packages) nodes.push([`pkg:npm:${pkg}`, "package", pkg, null, "{}"]);

  const statements = [
    d1.prepare(`DELETE FROM kg_edges WHERE repo_id = ?`).bind(repoId),
    d1.prepare(`DELETE FROM kg_nodes WHERE repo_id = ?`).bind(repoId),
    ...nodes.map(([id, kind, name, path, data]) =>
      d1
        .prepare(
          `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
           VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
        )
        .bind(repoId, id, kind, name, path, data, `${id}:${data}`, commit),
    ),
    ...edges.map(([src, dst, kind]) =>
      d1
        .prepare(
          `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT DO NOTHING`,
        )
        .bind(repoId, src, dst, kind),
    ),
  ];
  for (let i = 0; i < statements.length; i += 50) await d1.batch(statements.slice(i, i + 50));
}

/**
 * Project and publish the repository's stored graph as the build does, with
 * capability prose unavailable for `unavailable` (no model runs), then stamp
 * the superseded snapshot's retention.
 */
export async function publishAtlasFixture(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "REGISTRY_DB">>,
  repoId: string,
  commit: string,
  {
    unavailable = "disabled" as AtlasUnavailableReason,
    /** Record what the registry says the repository publishes, as the build's `atlas-packages` step. */
    packages = false,
  } = {},
): Promise<{ snapshotId: string; seq: number }> {
  const d1 = env.DB;
  const buildId = `fixture-${commit.slice(0, 12)}`;
  const { snapshotId, seq } = await beginRepoProjection(d1, repoId, [{ repoId, commit, buildId }]);
  if (packages && env.REGISTRY_DB)
    await recordPublishedPackages(env as Pick<Env, "DB" | "REGISTRY_DB">, repoId, snapshotId);
  await groupRepoCapabilities(d1, repoId, snapshotId, seq);
  await describeRepoCapabilities(
    env as Env,
    { repoId, buildId, snapshotId, seq, commit },
    { infer: null, unavailable },
  );
  let after: string | null = null;
  do ({ next: after } = await projectEntities(d1, repoId, snapshotId, seq, after));
  while (after);
  let edges: EdgeCursor = null;
  do ({ next: edges } = await projectEdges(d1, repoId, snapshotId, seq, edges));
  while (edges);
  await publishProjection(d1, repoScope(repoId), snapshotId, seq);
  await enforceRetention(d1, [repoScope(repoId)]);
  return { snapshotId, seq };
}

/** Expire every prior snapshot of the repository now, as retention does when over its count. */
export async function expireAtlasPriors(d1: D1Database, repoId: string) {
  return enforceRetention(d1, [repoScope(repoId)], { policy: { maxPrior: 0 } });
}

/**
 * Say in the registry that `repoId` publishes the npm package `name`, as its
 * first CI publish would: a package in the owner's npm feed (created public
 * if the owner has none) with the repository as a source. Idempotent.
 */
export async function registerFixturePackage(
  registry: D1Database,
  owner: { id: string; slug: string },
  repoId: string,
  name: string,
): Promise<void> {
  const now = new Date().toISOString();
  const feedId = `atlas-fixture-npm-${owner.id}`;
  await registry
    .prepare(
      `INSERT INTO repositories (id, key, format, owner_id, kind, visibility, created_at, updated_at)
       VALUES (?, ?, 'npm', ?, 'local', 'public', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(feedId, owner.slug, owner.id, now, now)
    .run();
  const feed = await registry
    .prepare(`SELECT id FROM repositories WHERE format = 'npm' AND key = ?`)
    .bind(owner.slug)
    .first<{ id: string }>();
  if (!feed) throw new Error("The fixture feed couldn't be created.");
  const normalized = name.toLowerCase();
  await registry
    .prepare(
      `INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(`atlas-fixture-${feed.id}-${normalized}`, feed.id, name, normalized, now, now)
    .run();
  const pkg = await registry
    .prepare(`SELECT id FROM packages WHERE repo_id = ? AND normalized_name = ?`)
    .bind(feed.id, normalized)
    .first<{ id: string }>();
  if (!pkg) throw new Error("The fixture package couldn't be created.");
  await registry
    .prepare(
      `INSERT INTO package_sources (package_id, git_repo_id, granted_by, granted_at)
       VALUES (?, ?, 'atlas-fixture', ?) ON CONFLICT DO NOTHING`,
    )
    .bind(pkg.id, repoId, now)
    .run();
}

/** The fixture's files as a knowledge graph: files, their symbols and concepts, imports and mentions. */
async function fixtureGraph(files: AtlasFixtureFile[]): Promise<BuiltGraph> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const concepts = new Set<string>();
  for (const file of files) {
    const id = `file:${file.path}`;
    const source = atlasFixtureSource(file);
    nodes.push({
      id,
      kind: "file",
      name: file.path.split("/").pop()!,
      path: file.path,
      summary: "",
      data: {
        blob: await gitBlob(source.text),
        lines: source.text.split("\n").length - 1,
        language: "typescript",
      },
    });
    for (const target of file.imports)
      edges.push({ src: id, dst: `file:${target}`, kind: "imports", weight: 1 });
    for (const concept of file.concepts) {
      concepts.add(concept);
      edges.push({ src: id, dst: `concept:${concept}`, kind: "mentions", weight: 1 });
    }
    for (const name of file.symbols ?? []) {
      const symbol = `sym:${file.path}#${name}`;
      nodes.push({ id: symbol, kind: "symbol", name, path: file.path, summary: "", data: {} });
      edges.push({ src: id, dst: symbol, kind: "defines", weight: 1 });
    }
  }
  for (const concept of concepts)
    nodes.push({
      id: `concept:${concept}`,
      kind: "concept",
      name: title(concept),
      path: null,
      summary: "",
      data: {},
    });
  return { nodes, edges, components: [], componentDeps: new Map(), conceptFiles: new Map() };
}

/**
 * A timeline's knowledge overlay as the overlay step would store it, without
 * a build: the fixture timeline's graph diffed against the base fixture's
 * (diffGraphs) and stored as the bookmark's current overlay (storeOverlay),
 * measured against main's `base` commit, which becomes main's indexed commit.
 * `commit` is the timeline commit its files were pushed at.
 */
export async function writeAtlasFixtureOverlay(
  d1: D1Database,
  repoId: string,
  ref: string,
  commit: string,
  base: string,
): Promise<{ overlayId: string; stored: number }> {
  const before = atlasFixtureFiles("base");
  const after = atlasFixtureTimelineFiles();
  const [main, timeline] = await Promise.all([fixtureGraph(before), fixtureGraph(after)]);
  const changes = diffGraphs(main, timeline);
  const blobs = (graph: BuiltGraph) =>
    new Map(
      graph.nodes.filter((n) => n.kind === "file").map((n) => [n.path!, String(n.data.blob)]),
    );
  const [old, now] = [blobs(main), blobs(timeline)];
  const files: FileChange[] = [...new Set([...old.keys(), ...now.keys()])]
    .filter((path) => old.get(path) !== now.get(path))
    .sort()
    .map((path) => ({
      path,
      blob: now.get(path) ?? null,
      before: old.get(path) ?? null,
      mode: "100644",
    }));
  await d1
    .prepare(
      `INSERT INTO kg_state (repo_id, indexed_commit) VALUES (?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET indexed_commit = excluded.indexed_commit`,
    )
    .bind(repoId, base)
    .run();
  const overlayId = `fixture-overlay-${crypto.randomUUID()}`;
  const full = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
  const { stored } = await storeOverlay(
    d1,
    repoId,
    full,
    overlayId,
    commit,
    base,
    { mergeBase: base, historyTruncated: false, changes: files },
    changes,
    { fixture: true },
  );
  return { overlayId, stored };
}

/** The bookmark is gone: keep its overlay read-only, as the coordinator does (CORE-139). */
export async function endAtlasFixtureOverlay(
  d1: D1Database,
  repoId: string,
  ref: string,
  reason: KnowledgeOverlayEndReason,
) {
  const full = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
  await endOverlays(d1, repoId, new Map([[full, reason]]));
}

/**
 * The repository's Knowledge build finished at `commit`: the indexed commit
 * and the graph version move, as a real build's last write does, so the
 * status an open page polls says it landed (CORE-187).
 */
export async function landAtlasFixtureBuild(d1: D1Database, repoId: string, commit: string) {
  const now = new Date().toISOString();
  await d1
    .prepare(
      `INSERT INTO kg_state (repo_id, indexed_commit, indexed_at, graph_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET indexed_commit = excluded.indexed_commit,
         indexed_at = excluded.indexed_at, graph_at = excluded.graph_at`,
    )
    .bind(repoId, commit, now, now)
    .run();
}

/** A build is pending again: nothing indexed at the branch's head. */
export async function queueAtlasFixtureBuild(d1: D1Database, repoId: string) {
  await d1.prepare(`DELETE FROM kg_state WHERE repo_id = ?`).bind(repoId).run();
}
