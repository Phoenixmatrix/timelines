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

import { db, nowIso } from "../schema.ts";
import type { FileAnalysis } from "./analyze.ts";
import {
  collectConcepts,
  displayName,
  EMPTY_CONCEPT_MODEL,
  type ConceptGroup,
  type ConceptModel,
} from "./concepts.ts";
import { feedStatements, type FeedEdge } from "../atlas/feed.ts";
import { resolveImport } from "./extract.ts";
import { runBatched, sha256, type Statement } from "./util.ts";

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
    nodes: Array.from(nodes.values(), (node) => {
      // Topic membership is unordered; another file must not change its serialized order.
      if (node.kind === "file" && Array.isArray(node.data.topics))
        node.data.topics.sort((a: string, b: string) => a.localeCompare(b));
      return node;
    }),
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

export async function nodeHash(node: GraphNode): Promise<string> {
  return sha256(JSON.stringify([node.kind, node.name, node.path, node.summary, node.data]));
}

/**
 * Make the stored graph match `graph`: write only nodes whose content hash
 * changed, add and drop edges, and record the change feed for the build.
 */
export async function applyGraph(
  d1: D1Database,
  repoId: string,
  buildId: string,
  commit: string,
  graph: BuiltGraph,
): Promise<GraphDiff> {
  const existing = new Map<string, { hash: string; kind: string }>();
  const results = await db(d1)
    .selectFrom("kg_nodes")
    .select(["id", "kind", "content_hash"])
    .where("repo_id", "=", repoId)
    .execute();
  for (const row of results) existing.set(row.id, { hash: row.content_hash, kind: row.kind });

  const diff: GraphDiff = { added: [], changed: [], removed: [] };
  const statements: Statement[] = [];
  const change = (id: string, kind: string, what: "added" | "changed" | "removed") =>
    db(d1)
      .insertInto("kg_changes")
      .values({ repo_id: repoId, build_id: buildId, node_id: id, kind, change: what })
      .onConflict((oc) =>
        oc
          .columns(["repo_id", "build_id", "node_id"])
          .doUpdateSet((eb) => ({ change: eb.ref("excluded.change") })),
      );

  const wanted = new Set<string>();
  for (const node of graph.nodes) {
    wanted.add(node.id);
    const hash = await nodeHash(node);
    const before = existing.get(node.id);
    if (before?.hash === hash) continue;
    statements.push(
      db(d1)
        .insertInto("kg_nodes")
        .values({
          repo_id: repoId,
          id: node.id,
          kind: node.kind,
          name: node.name,
          path: node.path,
          summary: node.summary,
          data: JSON.stringify(node.data),
          content_hash: hash,
          changed_in: commit,
          updated_at: nowIso(),
        })
        .onConflict((oc) =>
          oc.columns(["repo_id", "id"]).doUpdateSet((eb) => ({
            kind: eb.ref("excluded.kind"),
            name: eb.ref("excluded.name"),
            path: eb.ref("excluded.path"),
            summary: eb.ref("excluded.summary"),
            data: eb.ref("excluded.data"),
            content_hash: eb.ref("excluded.content_hash"),
            changed_in: eb.ref("excluded.changed_in"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
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
      db(d1).deleteFrom("kg_nodes").where("repo_id", "=", repoId).where("id", "=", id),
    );
    statements.push(change(id, kind, "removed"));
  }

  // Edges: compare by (src, dst, kind) and weight.
  const oldEdges = await db(d1)
    .selectFrom("kg_edges")
    .select(["src", "dst", "kind", "weight"])
    .where("repo_id", "=", repoId)
    .execute();
  const key = (e: { src: string; dst: string; kind: string }) =>
    `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const oldByKey = new Map(oldEdges.map((e) => [key(e), e]));
  const newKeys = new Set<string>();
  const changedEdges: FeedEdge[] = [];
  for (const edge of graph.edges) {
    newKeys.add(key(edge));
    if (oldByKey.get(key(edge))?.weight === edge.weight) continue;
    changedEdges.push(edge);
    statements.push(
      db(d1)
        .insertInto("kg_edges")
        .values({
          repo_id: repoId,
          src: edge.src,
          dst: edge.dst,
          kind: edge.kind,
          weight: edge.weight,
        })
        .onConflict((oc) =>
          oc
            .columns(["repo_id", "src", "dst", "kind"])
            .doUpdateSet((eb) => ({ weight: eb.ref("excluded.weight") })),
        ),
    );
  }
  for (const [k, edge] of oldByKey) {
    if (newKeys.has(k)) continue;
    changedEdges.push(edge);
    statements.push(
      db(d1)
        .deleteFrom("kg_edges")
        .where("repo_id", "=", repoId)
        .where("src", "=", edge.src)
        .where("dst", "=", edge.dst)
        .where("kind", "=", edge.kind),
    );
  }
  // The Atlas feed first, so no graph change lands without it (CORE-166).
  statements.unshift(
    ...(await feedStatements(
      d1,
      repoId,
      [...diff.added, ...diff.changed, ...diff.removed],
      changedEdges.map(({ src, dst, kind }) => ({ src, dst, kind })),
    )),
  );
  // Last, so the version moves only once the writes before it have landed.
  if (statements.length) {
    statements.push(
      db(d1)
        .insertInto("kg_state")
        .values({ repo_id: repoId, graph_at: nowIso() })
        .onConflict((oc) =>
          oc.column("repo_id").doUpdateSet((eb) => ({ graph_at: eb.ref("excluded.graph_at") })),
        ),
    );
  }
  await runBatched(d1, statements);
  return diff;
}

/** Load the current snapshot's file list for a build or for the indexed commit. */
export async function loadSnapshot(
  d1: D1Database,
  repoId: string,
  snapshot: string,
): Promise<SnapshotFile[]> {
  return db(d1)
    .selectFrom("kg_files")
    .select(["path", "blob_oid as blob", "mode"])
    .where("repo_id", "=", repoId)
    .where("snapshot", "=", snapshot)
    .orderBy("path")
    .execute();
}

export async function saveSnapshot(
  d1: D1Database,
  repoId: string,
  snapshot: string,
  files: SnapshotFile[],
) {
  await db(d1)
    .deleteFrom("kg_files")
    .where("repo_id", "=", repoId)
    .where("snapshot", "=", snapshot)
    .execute();
  await runBatched(
    d1,
    files.map((f) =>
      db(d1)
        .insertInto("kg_files")
        .values({ repo_id: repoId, snapshot, path: f.path, blob_oid: f.blob, mode: f.mode }),
    ),
  );
}

/** Fallback meaning from the stored graph, used until new syntheses land. */
export async function storedSyntheses(d1: D1Database, repoId: string): Promise<Syntheses> {
  const results = await db(d1)
    .selectFrom("kg_nodes")
    .select(["id", "kind", "name", "summary", "data"])
    .where("repo_id", "=", repoId)
    .where("kind", "in", ["repository", "component", "concept"])
    .execute();
  const out: Syntheses = { components: new Map(), concepts: new Map() };
  for (const row of results) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (row.kind === "repository" && row.summary) {
      out.repo = {
        title: row.name,
        summary: row.summary,
        techStack: (data.techStack as string[]) ?? [],
      };
    } else if (row.kind === "component" && row.summary) {
      out.components.set(row.id, {
        title: row.name,
        summary: row.summary,
        responsibilities: (data.responsibilities as string[]) ?? [],
        keyFiles: (data.keyFiles as ComponentSynthesis["keyFiles"]) ?? [],
      });
    } else if (row.kind === "concept" && row.summary) {
      out.concepts.set(row.id.slice(8), row.summary);
    }
  }
  return out;
}
