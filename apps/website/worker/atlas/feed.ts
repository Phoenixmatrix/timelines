// The Atlas change feed (CORE-166): which graph nodes and edges changed since
// a repository's Atlas last published, so the next projection reads only
// those instead of the whole graph.
//
// applyGraph appends to it in the same statement list as its graph writes,
// ahead of them, so no graph change can land without its feed row (a retried
// step recomputes the diff and appends again; duplicates are harmless). A
// snapshot records the highest id it reflects (`feed_mark`) and deletes rows
// up to it when it publishes; a projection that fails leaves them, so the next
// one covers both pushes. Past FEED_LIMIT rows a single `full` row replaces
// the list: listing more costs more than reading everything.

import type { Statement } from "../knowledge/util.ts";

/** Listed changes a repository's feed holds before it collapses into `full`. */
export const FEED_LIMIT = 20_000;
/** Rows per insert statement: one JSON parameter each, well inside D1's limits. */
const ROWS_PER_STATEMENT = 400;

const raw = (sql: string, ...parameters: unknown[]): Statement => ({
  compile: () => ({ sql, parameters }),
});

export interface FeedEdge {
  src: string;
  dst: string;
  kind: string;
}

/** Statements that record a graph change in the feed; run them before the graph writes. */
export async function feedStatements(
  d1: D1Database,
  repoId: string,
  nodes: string[],
  edges: FeedEdge[],
): Promise<Statement[]> {
  if (!nodes.length && !edges.length) return [];
  const state = await d1
    .prepare(
      `SELECT count(*) AS n, coalesce(max(kind = 'full'), 0) AS full FROM atlas_feed WHERE repo_id = ?`,
    )
    .bind(repoId)
    .first<{ n: number; full: number }>();
  // Everything already counts as changed.
  if (Number(state?.full ?? 0)) return [];
  if (Number(state?.n ?? 0) + nodes.length + edges.length > FEED_LIMIT)
    return [
      raw("DELETE FROM atlas_feed WHERE repo_id = ?", repoId),
      raw("INSERT INTO atlas_feed (repo_id, kind) VALUES (?, 'full')", repoId),
    ];
  const statements: Statement[] = [];
  for (let i = 0; i < nodes.length; i += ROWS_PER_STATEMENT)
    statements.push(
      raw(
        `INSERT INTO atlas_feed (repo_id, kind, src) SELECT ?, 'node', value FROM json_each(?)`,
        repoId,
        JSON.stringify(nodes.slice(i, i + ROWS_PER_STATEMENT)),
      ),
    );
  for (let i = 0; i < edges.length; i += ROWS_PER_STATEMENT)
    statements.push(
      raw(
        `INSERT INTO atlas_feed (repo_id, kind, src, dst, edge_kind)
         SELECT ?, 'edge', json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
         FROM json_each(?)`,
        repoId,
        JSON.stringify(edges.slice(i, i + ROWS_PER_STATEMENT).map((e) => [e.src, e.dst, e.kind])),
      ),
    );
  return statements;
}
