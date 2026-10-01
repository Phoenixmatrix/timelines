// The two retrieval layers on top of the graph:
//   * Vectorize: one embedding per graph node (file, symbol, component,
//     concept, repository) so semantic queries land on entities, which are
//     the entry points for graph traversal.
//   * AI Search: the raw source files and wiki pages, chunked and indexed for
//     hybrid (keyword + semantic) passage retrieval with reranking.
// Both sync incrementally from the graph diff and blob versions.

import type { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import type { FileAnalysis } from "./analyze.ts";
import type { GraphDiff, GraphNode, SnapshotFile } from "./graph.ts";
import { embed } from "./models.ts";
import { chunk, pool, sha256 } from "./util.ts";

export const SEARCH_INSTANCE = "knowledge";
const EMBEDDED_KINDS = new Set(["repository", "file", "symbol", "component", "concept"]);
const MAX_SEARCH_FILE_BYTES = 200_000;

export async function vectorId(repoId: string, nodeId: string): Promise<string> {
  return sha256(`${repoId}\u0000${nodeId}`);
}

function embeddingText(node: GraphNode): string {
  const responsibilities = Array.isArray(node.data.responsibilities)
    ? (node.data.responsibilities as string[]).join("; ")
    : "";
  const aliases = Array.isArray(node.data.aliases) ? (node.data.aliases as string[]) : [];
  return [
    `${node.kind}: ${node.name}${node.path ? ` (${node.path})` : ""}`,
    aliases.length ? `Also called: ${aliases.join(", ")}` : "",
    node.summary,
    responsibilities,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function syncVectors(
  env: Env,
  repoId: string,
  nodes: GraphNode[],
  diff: GraphDiff,
): Promise<{ upserted: number; deleted: number }> {
  const touched = new Set([...diff.added, ...diff.changed]);
  const targets = nodes.filter((n) => touched.has(n.id) && EMBEDDED_KINDS.has(n.kind) && n.summary);
  let upserted = 0;
  for (const group of chunk(targets, 64)) {
    const vectors = await embed(env, group.map(embeddingText));
    const records = await Promise.all(
      group.map(async (node, i) => ({
        id: await vectorId(repoId, node.id),
        values: vectors[i] as number[],
        metadata: { repo: repoId, kind: node.kind, node: node.id, path: node.path ?? "" },
      })),
    );
    await env.VECTORS.upsert(records);
    upserted += records.length;
  }
  const removed = await Promise.all(diff.removed.map((id) => vectorId(repoId, id)));
  for (const group of chunk(removed, 100)) await env.VECTORS.deleteByIds(group);
  return { upserted, deleted: removed.length };
}

// ---- AI Search ------------------------------------------------------------------

function itemName(repoId: string, key: string): string {
  const name = `${repoId}/${key}`;
  return name.length <= 120 ? `${name}.md` : `${repoId}/${key.slice(0, 40)}-${name.length}.md`;
}

interface SearchItemRow {
  key: string;
  item_id: string;
  version: string;
}

async function existingItems(d1: D1Database, repoId: string, prefix: string) {
  const results = await db(d1)
    .selectFrom("kg_search_items")
    .select(["key", "item_id", "version"])
    .where("repo_id", "=", repoId)
    .where("key", "like", `${prefix}%`)
    .execute();
  return new Map(results.map((r) => [r.key, r]));
}

async function upload(
  env: Env,
  repoId: string,
  key: string,
  version: string,
  body: string,
  metadata: Record<string, string>,
  previous: SearchItemRow | undefined,
) {
  const items = env.SEARCH.get(SEARCH_INSTANCE).items;
  if (previous) await items.delete(previous.item_id).catch(() => undefined);
  const info = await items.upload(itemName(repoId, key), body, {
    metadata: { repo: repoId, ...metadata },
  });
  await db(env.DB)
    .insertInto("kg_search_items")
    .values({ repo_id: repoId, key, item_id: info.id, version })
    .onConflict((oc) =>
      oc.columns(["repo_id", "key"]).doUpdateSet((eb) => ({
        item_id: eb.ref("excluded.item_id"),
        version: eb.ref("excluded.version"),
      })),
    )
    .execute();
}

async function forget(env: Env, repoId: string, row: SearchItemRow) {
  await env.SEARCH.get(SEARCH_INSTANCE)
    .items.delete(row.item_id)
    .catch(() => undefined);
  await db(env.DB)
    .deleteFrom("kg_search_items")
    .where("repo_id", "=", repoId)
    .where("key", "=", row.key)
    .execute();
}

/** Keep AI Search's copy of the repository's text files in step with the commit. */
export async function syncSearchFiles(
  env: Env,
  reader: RepoReader,
  repoId: string,
  commit: string,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
): Promise<{ uploaded: number; deleted: number }> {
  const existing = await existingItems(env.DB, repoId, "file:");
  const wanted = files.filter((f) => {
    const a = analyses.get(f.blob);
    return a && !a.skipped;
  });
  const wantedKeys = new Set(wanted.map((f) => `file:${f.path}`));
  const changed = wanted.filter((f) => existing.get(`file:${f.path}`)?.version !== f.blob);
  const decoder = new TextDecoder();
  await pool(changed, 6, async (file) => {
    const blob = await reader.blob(file.blob);
    if (!blob || blob.size > MAX_SEARCH_FILE_BYTES) return;
    const language = analyses.get(file.blob)?.language ?? "text";
    const body = `# ${file.path}\n\n\`\`\`${language}\n${decoder.decode(blob.bytes)}\n\`\`\`\n`;
    await upload(
      env,
      repoId,
      `file:${file.path}`,
      file.blob,
      body,
      { kind: "code", path: file.path, commit, lang: language },
      existing.get(`file:${file.path}`),
    );
  });
  const stale = [...existing.values()].filter((row) => !wantedKeys.has(row.key));
  await pool(stale, 6, (row) => forget(env, repoId, row));
  return { uploaded: changed.length, deleted: stale.length };
}

/** Keep AI Search's copy of the wiki in step with the pages table. */
export async function syncSearchPages(
  env: Env,
  repoId: string,
  commit: string,
  pages: { slug: string; title: string; body: string; inputs_hash: string }[],
): Promise<{ uploaded: number; deleted: number }> {
  const existing = await existingItems(env.DB, repoId, "page:");
  const wantedKeys = new Set(pages.map((p) => `page:${p.slug}`));
  const changed = pages.filter((p) => existing.get(`page:${p.slug}`)?.version !== p.inputs_hash);
  await pool(changed, 6, (page) =>
    upload(
      env,
      repoId,
      `page:${page.slug}`,
      page.inputs_hash,
      `# ${page.title}\n\n${page.body}`,
      { kind: "wiki", path: page.slug, commit, lang: "markdown" },
      existing.get(`page:${page.slug}`),
    ),
  );
  const stale = [...existing.values()].filter((row) => !wantedKeys.has(row.key));
  await pool(stale, 6, (row) => forget(env, repoId, row));
  return { uploaded: changed.length, deleted: stale.length };
}
