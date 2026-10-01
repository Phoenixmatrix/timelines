// Meaning above the file level: what each component is for, what the
// repository is, and what its recurring concepts mean. Every synthesis is
// cached under a hash of exactly what it was written from, so a push only
// re-synthesizes the components whose files actually changed meaning.

import { db } from "../schema.ts";
import type { FileAnalysis } from "./analyze.ts";
import { ANALYZER } from "./analyze.ts";
import type {
  BuiltGraph,
  ComponentSynthesis,
  RepoSynthesis,
  SnapshotFile,
  Syntheses,
} from "./graph.ts";
import { chatJson } from "./models.ts";
import { chunk, pool, sha256 } from "./util.ts";

async function cached<T>(d1: D1Database, key: string): Promise<T | null> {
  const row = await db(d1)
    .selectFrom("kg_synthesis")
    .select("data")
    .where("key", "=", key)
    .executeTakeFirst();
  return row ? (JSON.parse(row.data) as T) : null;
}

async function remember(
  d1: D1Database,
  key: string,
  value: unknown,
  model: string,
  tokens: number,
) {
  await db(d1)
    .insertInto("kg_synthesis")
    .values({ key, data: JSON.stringify(value), model, tokens })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet((eb) => ({
        data: eb.ref("excluded.data"),
        model: eb.ref("excluded.model"),
        tokens: eb.ref("excluded.tokens"),
      })),
    )
    .execute();
}

function fileBrief(path: string, a: FileAnalysis | undefined) {
  return {
    path,
    role: a?.role,
    summary: a?.summary ?? "",
    responsibilities: a?.responsibilities ?? [],
    symbols: (a?.symbols ?? [])
      .filter((s) => s.exported || s.description)
      .slice(0, 8)
      .map((s) => s.name),
  };
}

const COMPONENT_SYSTEM = `You document one component (a group of related files) of a software repository.
From the file summaries, return JSON:
{
  "title": "2-5 word name for the component, Title Case, specific (not 'Utilities')",
  "summary": "3-5 sentences: what the component does, how it works, and how it fits the system",
  "responsibilities": ["up to 6 short phrases"],
  "key_files": [{"path": "exact path from the input", "why": "one short sentence"}]
}
Pick at most 5 key files. Reply with JSON only.`;

const REPO_SYSTEM = `You write the overview of a software repository for its knowledge base.
From its components and README, return JSON:
{
  "title": "the project's name",
  "summary": "one paragraph (4-6 sentences): what the project is, who it's for, and how it is put together",
  "tech_stack": ["up to 10 main languages, frameworks and platforms"]
}
Reply with JSON only.`;

const CONCEPT_SYSTEM = `You write a glossary for a software repository. For each concept, using how the
listed files use it, write a 1-2 sentence definition specific to this codebase. A concept may list
other names it goes by (also_called); define the idea once, under its given name.
Return JSON: {"definitions": [{"name": "the concept exactly as given", "definition": "..."}]}
Reply with JSON only.`;

export interface SynthesisStats {
  components: number;
  concepts: number;
  repo: boolean;
  tokens: number;
}

export async function synthesize(
  env: Env,
  repoName: string,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
  graph: BuiltGraph,
  readme: string,
  /** Only use what's already cached: no model calls (for the fast first pass). */
  onlyCached = false,
): Promise<{ syntheses: Syntheses; stats: SynthesisStats }> {
  const stats: SynthesisStats = { components: 0, concepts: 0, repo: false, tokens: 0 };
  const blobOf = new Map(files.map((f) => [f.path, f.blob]));
  const titleOf = (id: string) => id.replace(/^component:/, "");

  // Components, in parallel; each cached by its inputs.
  const components = new Map<string, ComponentSynthesis>();
  await pool(graph.components, 4, async (plan) => {
    const deps = [...(graph.componentDeps.get(plan.id)?.keys() ?? [])].map(titleOf).sort();
    const usedBy = [...graph.componentDeps]
      .filter(([, d]) => d.has(plan.id))
      .map(([from]) => titleOf(from))
      .sort();
    const input = {
      dir: plan.dir || "(repository root)",
      files: plan.files.map((p) => fileBrief(p, analyses.get(blobOf.get(p) ?? ""))),
      depends_on: deps,
      used_by: usedBy,
    };
    const key = await sha256(`component:${ANALYZER}:${JSON.stringify(input)}`);
    const hit = await cached<ComponentSynthesis>(env.DB, key);
    if (hit) {
      components.set(plan.id, hit);
      return;
    }
    if (onlyCached) return;
    const { value, usage } = await chatJson<{
      title?: string;
      summary?: string;
      responsibilities?: string[];
      key_files?: { path?: string; why?: string }[];
    }>(env, "reason", COMPONENT_SYSTEM, JSON.stringify(input), { maxTokens: 1500 });
    const result: ComponentSynthesis = {
      title: (value.title ?? "").trim() || plan.dir,
      summary: (value.summary ?? "").trim(),
      responsibilities: (value.responsibilities ?? []).slice(0, 6),
      keyFiles: (value.key_files ?? [])
        .filter((k) => k.path && plan.files.includes(k.path))
        .slice(0, 5)
        .map((k) => ({ path: k.path as string, why: k.why ?? "" })),
    };
    await remember(env.DB, key, result, usage.model, usage.tokens);
    components.set(plan.id, result);
    stats.components++;
    stats.tokens += usage.tokens;
  });

  // Concepts get a definition when clef judged them glossary-worthy, or,
  // until concepts have been aligned, when at least two files mention them.
  const concepts = new Map<string, string>();
  const pending: { key: string; name: string; cacheKey: string; input: unknown }[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "concept") continue;
    const key = node.id.slice(8);
    const paths = graph.conceptFiles.get(key) ?? [];
    if (node.data.salient !== true && paths.length < 2) continue;
    const aliases = (node.data.aliases as string[] | undefined) ?? [];
    const input = {
      name: node.name,
      ...(aliases.length ? { also_called: aliases.slice(0, 6) } : {}),
      files: paths
        .slice(0, 6)
        .map((p) => ({ path: p, summary: analyses.get(blobOf.get(p) ?? "")?.summary ?? "" })),
    };
    const cacheKey = await sha256(`concept:${ANALYZER}:${JSON.stringify(input)}`);
    const hit = await cached<string>(env.DB, cacheKey);
    if (hit) concepts.set(key, hit);
    else if (!onlyCached) pending.push({ key, name: node.name, cacheKey, input });
  }
  await pool(chunk(pending, 20), 3, async (group) => {
    const { value, usage } = await chatJson<{
      definitions?: { name?: string; definition?: string }[];
    }>(
      env,
      "reason",
      CONCEPT_SYSTEM,
      JSON.stringify({
        repository: repoName,
        concepts: group.map((g) => g.input),
      }),
      { maxTokens: 2500 },
    );
    stats.tokens += usage.tokens;
    const byName = new Map(
      (value.definitions ?? []).map((d) => [d.name ?? "", d.definition ?? ""]),
    );
    for (const item of group) {
      const definition = byName.get(item.name)?.trim();
      if (!definition) continue;
      concepts.set(item.key, definition);
      await remember(env.DB, item.cacheKey, definition, usage.model, 0);
      stats.concepts++;
    }
  });

  // The repository overview, from its components and README.
  const repoInput = {
    repository: repoName,
    readme: readme.slice(0, 4000),
    components: graph.components.map((c) => ({
      dir: c.dir || "(root)",
      title: components.get(c.id)?.title,
      summary: components.get(c.id)?.summary,
    })),
  };
  const repoKey = await sha256(`repo:${ANALYZER}:${JSON.stringify(repoInput)}`);
  let repo = await cached<RepoSynthesis>(env.DB, repoKey);
  if (!repo && !onlyCached) {
    const { value, usage } = await chatJson<{
      title?: string;
      summary?: string;
      tech_stack?: string[];
    }>(env, "reason", REPO_SYSTEM, JSON.stringify(repoInput), { maxTokens: 1200 });
    repo = {
      title: (value.title ?? "").trim() || repoName,
      summary: (value.summary ?? "").trim(),
      techStack: (value.tech_stack ?? []).slice(0, 10),
    };
    await remember(env.DB, repoKey, repo, usage.model, usage.tokens);
    stats.repo = true;
    stats.tokens += usage.tokens;
  }

  return { syntheses: { repo: repo ?? undefined, components, concepts }, stats };
}
