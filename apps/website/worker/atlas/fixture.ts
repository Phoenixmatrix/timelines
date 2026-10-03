// DEVELOPMENT AND TESTS ONLY: write a repository's knowledge graph from the
// Atlas fixture (shared/atlasFixture.ts) and project it the way the
// Knowledge build does (group, describe without a model, project, publish,
// retain), so the Atlas UI can be exercised end to end where no Knowledge
// build or model runs: unit tests and the non-AI live E2E (POST /api/dev/atlas).
// Nothing in production reaches this module.

import {
  atlasFixtureFiles,
  atlasFixtureSource,
  type AtlasFixtureVariant,
} from "../../shared/atlasFixture.ts";
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
  env: Pick<Env, "DB">,
  repoId: string,
  commit: string,
  { unavailable = "disabled" as AtlasUnavailableReason } = {},
): Promise<{ snapshotId: string; seq: number }> {
  const d1 = env.DB;
  const buildId = `fixture-${commit.slice(0, 12)}`;
  const { snapshotId, seq } = await beginRepoProjection(d1, repoId, [{ repoId, commit, buildId }]);
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
