// The wiki: one consumer of the graph. The catalog comes straight from the
// graph (overview, architecture, one page per component, glossary); pages are
// written by the reasoning model from graph data plus a little source, and
// diagrams are drawn from the graph in code, so they're always valid Mermaid.
//
// A page is rewritten only when the hash of its inputs changes, and then only
// if clef agrees the change makes the page out of date.

import type { RepoReader } from "../objects.ts";
import { db, nowIso } from "../schema.ts";
import type { FileAnalysis } from "./analyze.ts";
import type { BuiltGraph, ComponentPlan, SnapshotFile, Syntheses } from "./graph.ts";
import { chatText, decide, yes } from "./models.ts";
import { pool, runBatched, sha256, slug, type Statement } from "./util.ts";

const WRITER = "w1";

export interface PlannedPage {
  slug: string;
  title: string;
  section: string;
  position: number;
  nodeId: string | null;
  kind: "overview" | "architecture" | "component" | "glossary";
  component?: ComponentPlan;
}

function sectionFor(dir: string): string {
  const parts = dir.split("/");
  if (parts[0]?.startsWith(".")) return "Tooling";
  if ((parts[0] === "apps" || parts[0] === "packages") && parts[1])
    return `${parts[0]}/${parts[1]}`;
  return parts[0] || "Repository";
}

export function componentSlug(plan: ComponentPlan): string {
  return `components/${slug(plan.dir || "root")}${plan.loose ? "-files" : ""}`;
}

export function planPages(graph: BuiltGraph, syntheses: Syntheses): PlannedPage[] {
  const pages: PlannedPage[] = [
    {
      slug: "overview",
      title: "Overview",
      section: "Overview",
      position: 0,
      nodeId: "repo",
      kind: "overview",
    },
    {
      slug: "architecture",
      title: "Architecture",
      section: "Overview",
      position: 1,
      nodeId: "repo",
      kind: "architecture",
    },
  ];
  graph.components.forEach((plan, i) => {
    pages.push({
      slug: componentSlug(plan),
      title: syntheses.components.get(plan.id)?.title || plan.dir || "Root files",
      section: sectionFor(plan.dir),
      position: 10 + i,
      nodeId: plan.id,
      kind: "component",
      component: plan,
    });
  });
  pages.push({
    slug: "glossary",
    title: "Glossary",
    section: "Reference",
    position: 10_000,
    nodeId: null,
    kind: "glossary",
  });
  return pages;
}

// ---- diagrams, drawn from the graph -----------------------------------------------

function label(text: string): string {
  return `"${text.replace(/"/g, "'").replace(/[[\]{}<>]/g, " ")}"`;
}

function componentDiagram(graph: BuiltGraph, syntheses: Syntheses): string {
  const ids = new Map(graph.components.map((c, i) => [c.id, `c${i}`]));
  // Only components that take part in a dependency; isolated ones (editor
  // settings, hooks) would just stack up as noise.
  const connected = new Set<string>();
  for (const [from, deps] of graph.componentDeps) {
    for (const to of deps.keys()) connected.add(from).add(to);
  }
  const lines = ["flowchart LR"];
  for (const c of graph.components.filter((c) => connected.has(c.id))) {
    lines.push(
      `  ${ids.get(c.id)}[${label(syntheses.components.get(c.id)?.title || c.dir || "root")}]`,
    );
  }
  for (const [from, deps] of graph.componentDeps) {
    for (const to of deps.keys()) lines.push(`  ${ids.get(from)} --> ${ids.get(to)}`);
  }
  return lines.length > 1 ? `\`\`\`mermaid\n${lines.join("\n")}\n\`\`\`` : "";
}

function fileDiagram(graph: BuiltGraph, plan: ComponentPlan): string {
  const inside = new Set(plan.files.map((p) => `file:${p}`));
  const edges = graph.edges.filter(
    (e) => e.kind === "imports" && inside.has(e.src) && inside.has(e.dst),
  );
  if (edges.length < 2 || plan.files.length > 25) return "";
  const ids = new Map(plan.files.map((p, i) => [`file:${p}`, `f${i}`]));
  const used = new Set(edges.flatMap((e) => [e.src, e.dst]));
  const lines = ["flowchart LR"];
  for (const id of used)
    lines.push(`  ${ids.get(id)}[${label(id.slice(5).split("/").pop() ?? id)}]`);
  for (const e of edges) lines.push(`  ${ids.get(e.src)} --> ${ids.get(e.dst)}`);
  return `\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``;
}

// ---- writing --------------------------------------------------------------------------

const PAGE_SYSTEM = `You write one page of a repository's internal wiki for engineers new to the codebase.
Write GitHub-flavored Markdown. Start directly with content (no top-level # title; the page has one).
Use ## sections. Be concrete and specific to this code; never invent files, functions or behavior
that isn't in the material. Refer to files as Markdown links whose target is the repository path,
e.g. [worker/auth.ts](apps/website/worker/auth.ts). Refer to other wiki pages as links with a
wiki: target, e.g. [Git Proxy](wiki:components/apps-website-worker-git). Use only page slugs you
were given. Do not include Mermaid diagrams; they are added separately. Keep it under 900 words.`;

interface PageInputs {
  writer: string;
  kind: PlannedPage["kind"];
  [key: string]: unknown;
}

function pageLinks(pages: PlannedPage[]) {
  return pages.filter((p) => p.kind === "component").map((p) => ({ slug: p.slug, title: p.title }));
}

async function inputsFor(
  page: PlannedPage,
  pages: PlannedPage[],
  graph: BuiltGraph,
  syntheses: Syntheses,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
  reader: RepoReader,
  readme: string,
): Promise<PageInputs> {
  const blobOf = new Map(files.map((f) => [f.path, f.blob]));
  const titled = (id: string) =>
    syntheses.components.get(id)?.title ?? id.replace(/^component:/, "");
  switch (page.kind) {
    case "overview":
      return {
        writer: WRITER,
        kind: page.kind,
        repository: syntheses.repo,
        readme: readme.slice(0, 4000),
        components: graph.components.map((c) => ({
          slug: componentSlug(c),
          title: titled(c.id),
          summary: syntheses.components.get(c.id)?.summary ?? "",
        })),
      };
    case "architecture":
      return {
        writer: WRITER,
        kind: page.kind,
        repository: syntheses.repo,
        components: graph.components.map((c) => ({
          slug: componentSlug(c),
          title: titled(c.id),
          dir: c.dir,
          summary: syntheses.components.get(c.id)?.summary ?? "",
          depends_on: [...(graph.componentDeps.get(c.id)?.keys() ?? [])].map(titled),
        })),
      };
    case "glossary": {
      const defined = graph.nodes.filter((n) => n.kind === "concept" && n.summary);
      const nameOf = new Map(defined.map((n) => [n.id, n.name]));
      const related = (from: "src" | "dst", to: "src" | "dst") => {
        const out = new Map<string, string[]>();
        for (const edge of graph.edges) {
          const name = nameOf.get(edge[to]);
          if (edge.kind !== "part_of" || !name || !nameOf.has(edge[from])) continue;
          out.set(edge[from], [...(out.get(edge[from]) ?? []), name]);
        }
        return out;
      };
      const partOf = related("src", "dst");
      const includes = related("dst", "src");
      return {
        writer: WRITER,
        kind: page.kind,
        concepts: defined
          .map((n) => ({
            name: n.name,
            definition: n.summary,
            aliases: (n.data.aliases as string[] | undefined) ?? [],
            partOf: (partOf.get(n.id) ?? []).sort(),
            includes: (includes.get(n.id) ?? []).sort(),
            files: graph.conceptFiles.get(n.id.slice(8)) ?? [],
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    case "component": {
      const plan = page.component as ComponentPlan;
      const synthesis = syntheses.components.get(plan.id);
      // A little real source makes pages concrete: the component's key files.
      const keyPaths = (synthesis?.keyFiles ?? []).map((k) => k.path).slice(0, 3);
      const decoder = new TextDecoder();
      const excerpts = await Promise.all(
        keyPaths.map(async (path) => {
          const blob = await reader.blob(blobOf.get(path) ?? "");
          return { path, source: blob ? decoder.decode(blob.bytes).slice(0, 3500) : "" };
        }),
      );
      return {
        writer: WRITER,
        kind: page.kind,
        component: { dir: plan.dir, ...synthesis },
        files: plan.files.map((p) => {
          const a = analyses.get(blobOf.get(p) ?? "");
          return {
            path: p,
            role: a?.role,
            summary: a?.summary,
            responsibilities: a?.responsibilities,
            symbols: (a?.symbols ?? [])
              .filter((s) => s.description)
              .map((s) => `${s.name}: ${s.description}`),
          };
        }),
        depends_on: [...(graph.componentDeps.get(plan.id)?.keys() ?? [])].map((id) => ({
          title: titled(id),
        })),
        used_by: [...graph.componentDeps]
          .filter(([, d]) => d.has(plan.id))
          .map(([id]) => ({ title: titled(id) })),
        excerpts,
        pages: pageLinks(pages),
      };
    }
  }
}

interface GlossaryEntry {
  name: string;
  definition: string;
  aliases: string[];
  partOf: string[];
  includes: string[];
  files: string[];
}

function glossaryBody(inputs: PageInputs): string {
  const concepts = inputs.concepts as GlossaryEntry[];
  if (!concepts.length) return "No recurring concepts yet.";
  return concepts
    .map((c) => {
      const lines = [`### ${c.name}`];
      if (c.aliases.length) lines.push(`_Also called ${c.aliases.join(", ")}._`);
      lines.push(c.definition);
      const related = [
        c.partOf.length ? `**Part of:** ${c.partOf.join(", ")}.` : "",
        c.includes.length ? `**Includes:** ${c.includes.join(", ")}.` : "",
      ].filter(Boolean);
      if (related.length) lines.push(related.join(" "));
      const files = c.files
        .slice(0, 6)
        .map((p) => `[${p}](${p})`)
        .join(", ");
      lines.push(`Used in ${files}${c.files.length > 6 ? ` and ${c.files.length - 6} more` : ""}.`);
      return lines.join("\n\n");
    })
    .join("\n\n");
}

/** Pages written before diagrams moved out of the body carried them at the end. */
function stripTrailingDiagram(body: string): string {
  return body.replace(
    /\n+## (Component map|How the files connect)\n+```mermaid[\s\S]*?```\s*$/,
    "",
  );
}

/** A page's diagram, drawn from the graph on every build (empty when none applies). */
function diagramFor(page: PlannedPage, graph: BuiltGraph, syntheses: Syntheses): string {
  const fenced =
    page.kind === "architecture"
      ? componentDiagram(graph, syntheses)
      : page.kind === "component"
        ? fileDiagram(graph, page.component as ComponentPlan)
        : "";
  // Stored as plain Mermaid source; the page renders it.
  return fenced.replace(/^```mermaid\n/, "").replace(/\n```$/, "");
}

/** Room for a page's text. */
const PAGE_TOKENS = 3500;
/** Thinking counts against max_tokens, so pages that think get room for both. */
const THINKING_TOKENS = 8000;

async function write(env: Env, page: PlannedPage, inputs: PageInputs) {
  if (page.kind === "glossary") return { body: glossaryBody(inputs), model: null, tokens: 0 };
  const instruction =
    page.kind === "overview"
      ? "Write the Overview page: what the project is, what problems it solves, how the repository is organized (link each component page), and how to get started if the README says."
      : page.kind === "architecture"
        ? "Write the Architecture page: the major parts, how requests and data flow between them, and the key design decisions. Link component pages."
        : `Write the page for the component "${page.title}": its purpose, how it works step by step, its key files and functions, its interfaces with the rest of the system, and anything surprising.`;
  const draft = (think: boolean) =>
    chatText(env, "reason", PAGE_SYSTEM, `${instruction}\n\nMaterial:\n${JSON.stringify(inputs)}`, {
      maxTokens: think ? THINKING_TOKENS : PAGE_TOKENS,
      think,
    });
  // The two front pages get the slower, more careful thinking mode. If the
  // thinking runs out of room or time, the page is written without it.
  const { text, usage } =
    page.kind === "component" ? await draft(false) : await draft(true).catch(() => draft(false));
  const body = stripTrailingDiagram(text.trim().replace(/^#\s+.*\n+/, ""));
  return { body, model: usage.model, tokens: usage.tokens };
}

/** Everything a wiki page is written from. */
export interface WikiSource {
  repoId: string;
  commit: string;
  reader: RepoReader;
  graph: BuiltGraph;
  syntheses: Syntheses;
  files: SnapshotFile[];
  analyses: Map<string, FileAnalysis>;
  readme: string;
}

export interface WikiPlan {
  /** Pages whose inputs changed: each needs clef, a writer, or both. */
  pending: string[];
  unchanged: number;
  removed: number;
}

export interface WikiStats {
  written: number;
  kept: number;
  unchanged: number;
  /** Pages that could not be settled; they keep their old text and inputs, so the next build tries again. */
  failed: number;
  tokens: number;
  /** The first few failures, for the build record. */
  errors: string[];
}

async function pageInputs(source: WikiSource, page: PlannedPage, pages: PlannedPage[]) {
  const { graph, syntheses, files, analyses, reader, readme } = source;
  const inputs = await inputsFor(page, pages, graph, syntheses, files, analyses, reader, readme);
  return { inputs, hash: await sha256(JSON.stringify(inputs)) };
}

async function storedPages(d1: D1Database, repoId: string) {
  const stored = await db(d1)
    .selectFrom("wiki_pages")
    .select(["slug", "title", "body", "inputs_hash"])
    .where("repo_id", "=", repoId)
    .execute();
  return new Map(stored.map((p) => [p.slug, p]));
}

// A page whose prose stays keeps its text, but its placement and diagram
// always follow the current graph.
const keep = (d1: D1Database, source: WikiSource, page: PlannedPage, hash: string, body: string) =>
  db(d1)
    .updateTable("wiki_pages")
    .set({
      inputs_hash: hash,
      title: page.title,
      section: page.section,
      position: page.position,
      node_id: page.nodeId,
      body: stripTrailingDiagram(body),
      diagram: diagramFor(page, source.graph, source.syntheses),
    })
    .where("repo_id", "=", source.repoId)
    .where("slug", "=", page.slug);

/**
 * The cheap half of a wiki update: pages whose inputs are unchanged follow the
 * graph's placement, pages the graph no longer plans are removed, and the rest
 * are returned for `updatePages`.
 */
export async function planWiki(env: Env, source: WikiSource): Promise<WikiPlan> {
  const pages = planPages(source.graph, source.syntheses);
  const existing = await storedPages(env.DB, source.repoId);
  const statements: Statement[] = [];
  const pending: string[] = [];
  await pool(pages, 8, async (page) => {
    const { hash } = await pageInputs(source, page, pages);
    const before = existing.get(page.slug);
    if (before?.inputs_hash === hash)
      statements.push(keep(env.DB, source, page, hash, before.body));
    else pending.push(page.slug);
  });
  const wanted = new Set(pages.map((p) => p.slug));
  const removed = [...existing.keys()].filter((s) => !wanted.has(s));
  for (const slugName of removed) {
    statements.push(
      db(env.DB)
        .deleteFrom("wiki_pages")
        .where("repo_id", "=", source.repoId)
        .where("slug", "=", slugName),
    );
  }
  await runBatched(env.DB, statements);
  const order = new Map(pages.map((p, i) => [p.slug, i]));
  pending.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { pending, unchanged: pages.length - pending.length, removed: removed.length };
}

/**
 * Bring the given pages up to date. A page with new inputs is rewritten only if
 * clef agrees that `changedNodes` (this build's change feed) makes it out of
 * date. Each page is saved as soon as it is settled, so a retried step only
 * redoes the pages it had not finished; a page that fails is left as it was.
 */
export async function updatePages(
  env: Env,
  source: WikiSource,
  slugs: string[],
  changedNodes: Set<string>,
): Promise<WikiStats> {
  const stats: WikiStats = { written: 0, kept: 0, unchanged: 0, failed: 0, tokens: 0, errors: [] };
  const { graph, syntheses, repoId, commit } = source;
  const pages = planPages(graph, syntheses);
  const wanted = new Set(slugs);
  const existing = await storedPages(env.DB, repoId);

  const settle = async (page: PlannedPage) => {
    const { inputs, hash } = await pageInputs(source, page, pages);
    const before = existing.get(page.slug);
    if (before?.inputs_hash === hash) {
      stats.unchanged++;
      return;
    }
    if (before && page.kind !== "glossary") {
      // Ask whether what changed makes the page wrong or incomplete.
      const relevant = [...changedNodes]
        .filter((id) =>
          page.kind === "component"
            ? (page.component?.files ?? []).some(
                (p) => id === `file:${p}` || id.startsWith(`sym:${p}#`),
              ) || id === page.nodeId
            : id.startsWith("component:") || id === "repo",
        )
        .slice(0, 40)
        .map((id) => {
          const node = graph.nodes.find((n) => n.id === id);
          return { node: id, now: node?.summary ?? "(removed)" };
        });
      let stale = false;
      if (relevant.length > 0) {
        const answers = await decide(
          env,
          { page: { title: before.title, text: before.body.slice(0, 4000) }, changes: relevant },
          {
            stale: {
              type: "noul",
              instructions:
                "Given what changed in the code (each change shows the element's current description), would this wiki page now be wrong, misleading or missing something important?",
            },
          },
        );
        stale = yes(answers.stale) >= 0.3;
      }
      if (!stale) {
        stats.kept++;
        await keep(env.DB, source, page, hash, before.body).execute();
        return;
      }
    }
    const written = await write(env, page, inputs);
    await db(env.DB)
      .insertInto("wiki_pages")
      .values({
        repo_id: repoId,
        slug: page.slug,
        title: page.title,
        section: page.section,
        position: page.position,
        node_id: page.nodeId,
        body: written.body,
        diagram: diagramFor(page, graph, syntheses),
        sources: JSON.stringify(page.component?.files ?? []),
        inputs_hash: hash,
        generated_in: commit,
        model: written.model,
        updated_at: nowIso(),
      })
      .onConflict((oc) =>
        oc.columns(["repo_id", "slug"]).doUpdateSet((eb) => ({
          title: eb.ref("excluded.title"),
          section: eb.ref("excluded.section"),
          position: eb.ref("excluded.position"),
          node_id: eb.ref("excluded.node_id"),
          body: eb.ref("excluded.body"),
          diagram: eb.ref("excluded.diagram"),
          sources: eb.ref("excluded.sources"),
          inputs_hash: eb.ref("excluded.inputs_hash"),
          generated_in: eb.ref("excluded.generated_in"),
          model: eb.ref("excluded.model"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
    stats.written++;
    stats.tokens += written.tokens;
  };

  await pool(
    pages.filter((p) => wanted.has(p.slug)),
    3,
    async (page) => {
      try {
        await settle(page);
      } catch (error) {
        stats.failed++;
        const message = error instanceof Error ? error.message : String(error);
        if (stats.errors.length < 3) stats.errors.push(`${page.slug}: ${message.slice(0, 300)}`);
      }
    },
  );
  return stats;
}
