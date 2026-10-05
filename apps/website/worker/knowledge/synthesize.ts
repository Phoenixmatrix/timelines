// Meaning above the file level: what each component is for, what the
// repository is, and what its recurring concepts mean. Every synthesis is
// cached under a hash of what it was written from, so a push only
// re-synthesizes the components whose files actually changed meaning.
//
// A concept's definition is cached under the concept itself (CORE-286): its
// name, the names it also goes by and the files it is defined from, in its
// repository. Their summaries are what it is written from, but not what it
// is cached by: a summary is model output that changes wording on every edit
// of the file, and rewriting the definition each time made every review of
// the concept ask again. Lookups are batched, a few queries per pass.

import type { AiModels } from "../../shared/ai.ts";
import { db, nowIso } from "../schema.ts";
import { useIsStale } from "./cache-use.ts";
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

/** Concept definition cache keys (CORE-286); bump to rewrite every definition. */
export const DEFINER = "d2";

/** A synthesis cached under `key` (a hash of exactly what it was written from). */
export async function cached<T>(d1: D1Database, key: string): Promise<T | null> {
  const row = await db(d1)
    .selectFrom("kg_synthesis")
    .select(["data", "used_at"])
    .where("key", "=", key)
    .executeTakeFirst();
  if (!row) return null;
  // Record the use for retention (cache-use.ts): at most daily per entry.
  const now = new Date();
  if (useIsStale(row.used_at, now))
    await db(d1)
      .updateTable("kg_synthesis")
      .set({ used_at: now.toISOString() })
      .where("key", "=", key)
      .execute();
  return JSON.parse(row.data) as T;
}

/** Many cached syntheses at once: a query per 90 keys, uses recorded as `cached` does. */
export async function cachedMany<T>(d1: D1Database, keys: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const now = new Date();
  const stale: string[] = [];
  for (const group of chunk([...new Set(keys)], 90)) {
    const rows = await db(d1)
      .selectFrom("kg_synthesis")
      .select(["key", "data", "used_at"])
      .where("key", "in", group)
      .execute();
    for (const row of rows) {
      out.set(row.key, JSON.parse(row.data) as T);
      if (useIsStale(row.used_at, now)) stale.push(row.key);
    }
  }
  for (const group of chunk(stale, 90))
    await db(d1)
      .updateTable("kg_synthesis")
      .set({ used_at: now.toISOString() })
      .where("key", "in", group)
      .execute();
  return out;
}

/** Cache a synthesis under the hash of its inputs, with the model that wrote it. */
export async function remember(
  d1: D1Database,
  key: string,
  value: unknown,
  model: string,
  tokens: number,
) {
  await db(d1)
    .insertInto("kg_synthesis")
    .values({ key, data: JSON.stringify(value), model, tokens, used_at: nowIso() })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet((eb) => ({
        data: eb.ref("excluded.data"),
        model: eb.ref("excluded.model"),
        tokens: eb.ref("excluded.tokens"),
        used_at: eb.ref("excluded.used_at"),
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
  models: AiModels,
  repo: { id: string; fullName: string },
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
  graph: BuiltGraph,
  readme: string,
  /** Only use what's already cached: no model calls (for the fast first pass). */
  onlyCached = false,
): Promise<{ syntheses: Syntheses; stats: SynthesisStats }> {
  const repoName = repo.fullName;
  const stats: SynthesisStats = { components: 0, concepts: 0, repo: false, tokens: 0 };
  const blobOf = new Map(files.map((f) => [f.path, f.blob]));
  const titleOf = (id: string) => id.replace(/^component:/, "");

  // Components, each cached by its inputs; looked up together, written in parallel.
  const components = new Map<string, ComponentSynthesis>();
  const planned = await Promise.all(
    graph.components.map(async (plan) => {
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
      return { plan, input, key: await sha256(`component:${ANALYZER}:${JSON.stringify(input)}`) };
    }),
  );
  const componentHits = await cachedMany<ComponentSynthesis>(
    env.DB,
    planned.map((p) => p.key),
  );
  const componentMisses = planned.filter(({ plan, key }) => {
    const hit = componentHits.get(key);
    if (hit) components.set(plan.id, hit);
    return !hit;
  });
  if (!onlyCached)
    await pool(componentMisses, 4, async ({ plan, input, key }) => {
      const { value, usage } = await chatJson<{
        title?: string;
        summary?: string;
        responsibilities?: string[];
        key_files?: { path?: string; why?: string }[];
      }>(env, "reason", COMPONENT_SYSTEM, JSON.stringify(input), {
        maxTokens: 1500,
        model: models.task,
      });
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
  const wanted: {
    key: string;
    name: string;
    cacheKey: string;
    legacyKey: string;
    input: unknown;
  }[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "concept") continue;
    const key = node.id.slice(8);
    const paths = graph.conceptFiles.get(key) ?? [];
    if (node.data.salient !== true && paths.length < 2) continue;
    const aliases = (node.data.aliases as string[] | undefined) ?? [];
    const sources = paths.slice(0, 6);
    const named = {
      name: node.name,
      ...(aliases.length ? { also_called: aliases.slice(0, 6) } : {}),
    };
    // What the definition is written from: the concept and how its files use it.
    const input = {
      ...named,
      files: sources.map((p) => ({
        path: p,
        summary: analyses.get(blobOf.get(p) ?? "")?.summary ?? "",
      })),
    };
    wanted.push({
      key,
      name: node.name,
      // What it is cached by: the concept and where it is defined from (see the top).
      cacheKey: await sha256(
        `concept-definition:${DEFINER}:${repo.id}:${JSON.stringify({ ...named, files: sources })}`,
      ),
      // Before CORE-286 a definition was cached by everything it was written from.
      legacyKey: await sha256(`concept:${ANALYZER}:${JSON.stringify(input)}`),
      input,
    });
  }
  const definitions = await cachedMany<string>(
    env.DB,
    wanted.map((w) => w.cacheKey),
  );
  // A definition written before CORE-286 from exactly these inputs is adopted, not rewritten.
  const missing = wanted.filter((w) => !definitions.has(w.cacheKey));
  const legacy = missing.length
    ? await cachedMany<string>(
        env.DB,
        missing.map((w) => w.legacyKey),
      )
    : new Map<string, string>();
  const pending: typeof wanted = [];
  for (const item of wanted) {
    const hit = definitions.get(item.cacheKey);
    if (hit) concepts.set(item.key, hit);
    else if (legacy.has(item.legacyKey)) {
      const adopted = legacy.get(item.legacyKey) as string;
      await remember(env.DB, item.cacheKey, adopted, models.task, 0);
      concepts.set(item.key, adopted);
    } else if (!onlyCached) pending.push(item);
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
      { maxTokens: 2500, model: models.task },
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
  let overview = await cached<RepoSynthesis>(env.DB, repoKey);
  if (!overview && !onlyCached) {
    const { value, usage } = await chatJson<{
      title?: string;
      summary?: string;
      tech_stack?: string[];
    }>(env, "reason", REPO_SYSTEM, JSON.stringify(repoInput), {
      maxTokens: 1200,
      model: models.task,
    });
    overview = {
      title: (value.title ?? "").trim() || repoName,
      summary: (value.summary ?? "").trim(),
      techStack: (value.tech_stack ?? []).slice(0, 10),
    };
    await remember(env.DB, repoKey, overview, usage.model, usage.tokens);
    stats.repo = true;
    stats.tokens += usage.tokens;
  }

  return { syntheses: { repo: overview ?? undefined, components, concepts }, stats };
}
