// The knowledge graph. Built in full from (files, analyses, syntheses) on
// every build, which is cheap because the expensive parts are cached, then
// diffed against what is stored. That keeps ids stable and gives an exact
// change feed: which nodes were added, changed or removed by each push.
//
// Node ids:
//   repo                      the repository
//   dir:<path>                a directory
//   file:<path>               a file
//   sym:<path>#<name>         a symbol a file defines (exported or described)
//   pkg:<ecosystem>:<name>    an external package
//   concept:<slug>            a domain concept files talk about (aligned and
//                             trimmed by clef, see concepts.ts)
//   component:<path>          a cluster of related files (a directory, sized)
// Edge kinds: contains, defines, imports, depends_on, mentions, part_of
// (narrower concept -> broader concept).

import type { FileAnalysis } from "./analyze.ts";
import {
  collectConcepts,
  displayName,
  EMPTY_CONCEPT_MODEL,
  type ConceptGroup,
  type ConceptModel,
} from "./concepts.ts";
import { resolveImport } from "./extract.ts";
import { chunk, runBatched, sha256 } from "./util.ts";

export { conceptKey } from "./concepts.ts";

export interface SnapshotFile {
  path: string;
  blob: string;
  mode: string;
}

export interface GraphNode {
  id: string;
  kind: "repository" | "directory" | "file" | "symbol" | "package" | "concept" | "component";
  name: string;
  path: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: "contains" | "defines" | "imports" | "depends_on" | "mentions" | "part_of";
  weight: number;
}

export interface ComponentPlan {
  id: string;
  /** Directory the component covers. */
  dir: string;
  /** Files in the component (the directory's own files when `loose`). */
  files: string[];
  /** Only the files directly in `dir`, because its subdirectories are their own components. */
  loose: boolean;
}

export interface ComponentSynthesis {
  title: string;
  summary: string;
  responsibilities: string[];
  keyFiles: { path: string; why: string }[];
}

export interface RepoSynthesis {
  title: string;
  summary: string;
  techStack: string[];
}

export interface Syntheses {
  repo?: RepoSynthesis;
  components: Map<string, ComponentSynthesis>;
  concepts: Map<string, string>;
}

const MAX_COMPONENT_FILES = 18;

/**
 * Cluster files into components by directory: a directory with few enough
 * files is one component; a bigger one splits into its subdirectories, and its
 * own loose files become a component of their own. Deterministic, so ids
 * survive between builds.
 */
export function planComponents(paths: string[]): ComponentPlan[] {
  const plans: ComponentPlan[] = [];
  const walk = (dir: string, files: string[]) => {
    if (files.length <= MAX_COMPONENT_FILES) {
      plans.push({ id: `component:${dir || "."}`, dir, files, loose: false });
      return;
    }
    const prefix = dir ? `${dir}/` : "";
    const loose: string[] = [];
    const groups = new Map<string, string[]>();
    for (const file of files) {
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) loose.push(file);
      else {
        const sub = `${prefix}${rest.slice(0, slash)}`;
        groups.set(sub, [...(groups.get(sub) ?? []), file]);
      }
    }
    // Unsplittable (all files in one directory): keep it whole.
    if (groups.size === 0) {
      plans.push({ id: `component:${dir || "."}`, dir, files, loose: false });
      return;
    }
    if (loose.length)
      plans.push({ id: `component:${dir || "."}/*`, dir, files: loose, loose: true });
    for (const [sub, subFiles] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
      walk(sub, subFiles);
  };
  walk("", [...paths].sort());
  return plans;
}

export interface BuiltGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  components: ComponentPlan[];
  /** component id -> component ids it imports from, with counts. */
  componentDeps: Map<string, Map<string, number>>;
  /** concept key (canonical) -> files that mention it. */
  conceptFiles: Map<string, string[]>;
}

export function buildGraph(
  repoName: string,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
  syntheses: Syntheses,
  concepts: ConceptModel = EMPTY_CONCEPT_MODEL,
): BuiltGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (src: string, dst: string, kind: GraphEdge["kind"], weight = 1) => {
    const key = `${src}\u0000${dst}\u0000${kind}`;
    const existing = edges.get(key);
    if (existing) existing.weight += weight;
    else edges.set(key, { src, dst, kind, weight });
  };
  const paths = new Set(files.map((f) => f.path));

  nodes.set("repo", {
    id: "repo",
    kind: "repository",
    name: syntheses.repo?.title || repoName,
    path: null,
    summary: syntheses.repo?.summary ?? "",
    data: { fullName: repoName, techStack: syntheses.repo?.techStack ?? [], files: files.length },
  });

  // Directories and files.
  const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const ensureDir = (dir: string): string => {
    if (!dir) return "repo";
    const id = `dir:${dir}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "directory",
        name: dir.split("/").pop() ?? dir,
        path: dir,
        summary: "",
        data: {},
      });
      addEdge(ensureDir(dirOf(dir)), id, "contains");
    }
    return id;
  };

  for (const file of files) {
    const analysis = analyses.get(file.blob);
    const id = `file:${file.path}`;
    nodes.set(id, {
      id,
      kind: "file",
      name: file.path.split("/").pop() ?? file.path,
      path: file.path,
      summary: analysis?.summary ?? "",
      data: {
        blob: file.blob,
        language: analysis?.language ?? null,
        role: analysis?.role ?? null,
        lines: analysis?.lines ?? null,
        responsibilities: analysis?.responsibilities ?? [],
        skipped: analysis?.skipped ?? null,
        pending: analysis ? undefined : true,
      },
    });
    addEdge(ensureDir(dirOf(file.path)), id, "contains");
    if (!analysis || analysis.skipped) continue;

    for (const symbol of analysis.symbols) {
      if (!symbol.exported && !symbol.description) continue;
      const symId = `sym:${file.path}#${symbol.name}`;
      nodes.set(symId, {
        id: symId,
        kind: "symbol",
        name: symbol.name,
        path: file.path,
        summary: symbol.description ?? "",
        data: { kind: symbol.kind, line: symbol.line, exported: symbol.exported },
      });
      addEdge(id, symId, "defines");
    }

    for (const spec of analysis.imports) {
      const target = resolveImport(file.path, spec, analysis.language, paths);
      if (!target) continue;
      if (target.type === "file") {
        if (target.path !== file.path) addEdge(id, `file:${target.path}`, "imports");
      } else {
        const pkgId = `pkg:${target.ecosystem}:${target.name}`;
        if (!nodes.has(pkgId)) {
          nodes.set(pkgId, {
            id: pkgId,
            kind: "package",
            name: target.name,
            path: null,
            summary: "",
            data: { ecosystem: target.ecosystem },
          });
        }
        addEdge(id, pkgId, "imports");
      }
    }
  }

  // Concepts, merged under their canonical keys. Groups clef judged not
  // glossary-worthy stay as topics on the files that mention them.
  const groups = new Map<string, ConceptGroup>();
  for (const [key, group] of collectConcepts(files, analyses)) {
    const lead = concepts.canonical.get(key) ?? key;
    const target = groups.get(lead) ?? { names: new Map<string, number>(), files: [] };
    for (const [name, n] of group.names) target.names.set(name, (target.names.get(name) ?? 0) + n);
    for (const path of group.files) if (!target.files.includes(path)) target.files.push(path);
    groups.set(lead, target);
  }
  const conceptFiles = new Map<string, string[]>();
  for (const [key, group] of groups) {
    const name = displayName(group.names, key);
    if (concepts.trimmed.has(key)) {
      for (const path of group.files) {
        const node = nodes.get(`file:${path}`);
        if (node) node.data.topics = [...((node.data.topics as string[] | undefined) ?? []), name];
      }
      continue;
    }
    const mentions = [...group.files].sort();
    conceptFiles.set(key, mentions);
    nodes.set(`concept:${key}`, {
      id: `concept:${key}`,
      kind: "concept",
      name,
      path: null,
      summary: syntheses.concepts.get(key) ?? "",
      data: {
        files: mentions.length,
        aliases: [...group.names.keys()].filter((n) => n !== name).sort(),
        // null until clef has judged it.
        salient: concepts.salient.has(key) ? true : null,
      },
    });
    for (const path of mentions) addEdge(`file:${path}`, `concept:${key}`, "mentions");
  }
  for (const [narrower, broader] of concepts.partOf) {
    if (nodes.has(`concept:${narrower}`) && nodes.has(`concept:${broader}`)) {
      addEdge(`concept:${narrower}`, `concept:${broader}`, "part_of");
    }
  }

  // Components over the files that carry meaning.
  const meaningful = files.filter((f) => {
    const a = analyses.get(f.blob);
    return a && !a.skipped;
  });
  const components = planComponents(meaningful.map((f) => f.path));
  const componentOf = new Map<string, string>();
  for (const plan of components) {
    const synthesis = syntheses.components.get(plan.id);
    nodes.set(plan.id, {
      id: plan.id,
      kind: "component",
      name: synthesis?.title || plan.dir || repoName,
      path: plan.dir,
      summary: synthesis?.summary ?? "",
      data: {
        dir: plan.dir,
        loose: plan.loose,
        files: plan.files.length,
        responsibilities: synthesis?.responsibilities ?? [],
        keyFiles: synthesis?.keyFiles ?? [],
      },
    });
    addEdge("repo", plan.id, "contains");
    for (const path of plan.files) {
      componentOf.set(path, plan.id);
      addEdge(plan.id, `file:${path}`, "contains");
    }
  }

  // Component dependencies, aggregated from file imports.
  const componentDeps = new Map<string, Map<string, number>>();
  for (const edge of edges.values()) {
    if (edge.kind !== "imports" || !edge.dst.startsWith("file:")) continue;
    const from = componentOf.get(edge.src.slice(5));
    const to = componentOf.get(edge.dst.slice(5));
    if (!from || !to || from === to) continue;
    const deps = componentDeps.get(from) ?? new Map<string, number>();
    deps.set(to, (deps.get(to) ?? 0) + edge.weight);
    componentDeps.set(from, deps);
  }
  for (const [from, deps] of componentDeps) {
    for (const [to, weight] of deps) addEdge(from, to, "depends_on", weight);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    components,
    componentDeps,
    conceptFiles,
  };
}

// ---- storing ------------------------------------------------------------------

export interface GraphDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

async function nodeHash(node: GraphNode): Promise<string> {
  return sha256(JSON.stringify([node.kind, node.name, node.path, node.summary, node.data]));
}

/**
 * Make the stored graph match `graph`: write only nodes whose content hash
 * changed, add and drop edges, and record the change feed for the build.
 */
export async function applyGraph(
  db: D1Database,
  repoId: string,
  buildId: string,
  commit: string,
  graph: BuiltGraph,
): Promise<GraphDiff> {
  const existing = new Map<string, { hash: string; kind: string }>();
  const { results } = await db
    .prepare("SELECT id, kind, content_hash FROM kg_nodes WHERE repo_id = ?")
    .bind(repoId)
    .all<{ id: string; kind: string; content_hash: string }>();
  for (const row of results) existing.set(row.id, { hash: row.content_hash, kind: row.kind });

  const diff: GraphDiff = { added: [], changed: [], removed: [] };
  const statements: D1PreparedStatement[] = [];
  const change = (id: string, kind: string, what: "added" | "changed" | "removed") =>
    db
      .prepare(
        `INSERT INTO kg_changes (repo_id, build_id, node_id, kind, change) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, build_id, node_id) DO UPDATE SET change = excluded.change`,
      )
      .bind(repoId, buildId, id, kind, what);

  const wanted = new Set<string>();
  for (const node of graph.nodes) {
    wanted.add(node.id);
    const hash = await nodeHash(node);
    const before = existing.get(node.id);
    if (before?.hash === hash) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT (repo_id, id) DO UPDATE SET kind = excluded.kind, name = excluded.name, path = excluded.path,
             summary = excluded.summary, data = excluded.data, content_hash = excluded.content_hash,
             changed_in = excluded.changed_in, updated_at = excluded.updated_at`,
        )
        .bind(
          repoId,
          node.id,
          node.kind,
          node.name,
          node.path,
          node.summary,
          JSON.stringify(node.data),
          hash,
          commit,
        ),
    );
    const what = before ? "changed" : "added";
    diff[what].push(node.id);
    statements.push(change(node.id, node.kind, what));
  }
  for (const [id, { kind }] of existing) {
    if (wanted.has(id)) continue;
    diff.removed.push(id);
    statements.push(
      db.prepare("DELETE FROM kg_nodes WHERE repo_id = ? AND id = ?").bind(repoId, id),
    );
    statements.push(change(id, kind, "removed"));
  }

  // Edges: compare by (src, dst, kind) and weight.
  const { results: oldEdges } = await db
    .prepare("SELECT src, dst, kind, weight FROM kg_edges WHERE repo_id = ?")
    .bind(repoId)
    .all<GraphEdge>();
  const key = (e: Pick<GraphEdge, "src" | "dst" | "kind">) =>
    `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const oldByKey = new Map(oldEdges.map((e) => [key(e), e]));
  const newKeys = new Set<string>();
  for (const edge of graph.edges) {
    newKeys.add(key(edge));
    if (oldByKey.get(key(edge))?.weight === edge.weight) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (repo_id, src, dst, kind) DO UPDATE SET weight = excluded.weight`,
        )
        .bind(repoId, edge.src, edge.dst, edge.kind, edge.weight),
    );
  }
  for (const [k, edge] of oldByKey) {
    if (newKeys.has(k)) continue;
    statements.push(
      db
        .prepare("DELETE FROM kg_edges WHERE repo_id = ? AND src = ? AND dst = ? AND kind = ?")
        .bind(repoId, edge.src, edge.dst, edge.kind),
    );
  }
  await runBatched(db, statements);
  return diff;
}

/** Load the current snapshot's file list for a build or for the indexed commit. */
export async function loadSnapshot(
  db: D1Database,
  repoId: string,
  snapshot: string,
): Promise<SnapshotFile[]> {
  const { results } = await db
    .prepare(
      "SELECT path, blob_oid AS blob, mode FROM kg_files WHERE repo_id = ? AND snapshot = ? ORDER BY path",
    )
    .bind(repoId, snapshot)
    .all<SnapshotFile>();
  return results;
}

export async function saveSnapshot(
  db: D1Database,
  repoId: string,
  snapshot: string,
  files: SnapshotFile[],
) {
  await db
    .prepare("DELETE FROM kg_files WHERE repo_id = ? AND snapshot = ?")
    .bind(repoId, snapshot)
    .run();
  await runBatched(
    db,
    chunk(files, 1).map(([f]) =>
      db
        .prepare(
          "INSERT INTO kg_files (repo_id, snapshot, path, blob_oid, mode) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(repoId, snapshot, f?.path, f?.blob, f?.mode),
    ),
  );
}
