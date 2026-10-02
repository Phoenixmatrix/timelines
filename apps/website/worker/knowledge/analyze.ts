// What each file says: exact structure from the extractor plus a semantic
// card from the fast model. Results are keyed by blob id, so a file is
// analyzed once per distinct content, ever, across commits and repositories.

import { structuredPatch } from "diff";
import type { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import { extract, languageOf, skipReason, type Language } from "./extract.ts";
import { chatJson, choice, decide, yes, type ClefQuestion } from "./models.ts";
import { chunk, pool } from "./util.ts";

/** Bump to re-analyze every file (prompt or schema changes). */
export const ANALYZER = "v1";

export type FileRole =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "migration"
  | "script"
  | "asset"
  | "generated";

export interface FileSymbol {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  description?: string;
}

export interface FileAnalysis {
  language: Language;
  role: FileRole;
  lines: number;
  /** Why the file got no semantic card, when it didn't. */
  skipped?: string;
  summary: string;
  responsibilities: string[];
  symbols: FileSymbol[];
  concepts: string[];
  imports: string[];
  /** Set when an edit was judged cosmetic and the previous card was kept. */
  reusedFrom?: string;
}

export interface FileToAnalyze {
  path: string;
  blob: string;
  /** The blob this path had at the last indexed commit, if it changed. */
  previousBlob?: string;
}

const ROLE_CRITERIA: Record<FileRole, string> = {
  source: "application or library code that implements behavior",
  test: "tests, fixtures or test helpers",
  config: "build, tooling, runtime or package configuration",
  docs: "documentation meant for people",
  migration: "database migration or schema definition",
  script: "a developer or CI script",
  asset: "styles, images, fonts or other static assets",
  generated: "generated, vendored or copied-in code nobody edits by hand",
};

/** Roles that are certain from the path alone; everything else asks clef. */
function obviousRole(path: string, language: Language): FileRole | null {
  if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/.test(path)) return "test";
  if (/(^|\/)migrations\/.*\.sql$/.test(path)) return "migration";
  if (language === "markdown") return "docs";
  if (language === "css" || language === "binary") return "asset";
  if (
    /(^|\/)(package\.json|tsconfig[^/]*\.json|Cargo\.toml|pnpm-workspace\.yaml|[^/]*\.config\.[cm]?[jt]s|\.gitignore|\.editorconfig)$/.test(
      path,
    ) ||
    language === "toml" ||
    language === "yaml"
  ) {
    return "config";
  }
  return null;
}

const CARD_SYSTEM = `You build a knowledge graph of a software repository, one file at a time.
Read the file and return a JSON object:
{
  "summary": "2-3 sentences: what this file does and why it exists, in plain words",
  "responsibilities": ["up to 5 short phrases"],
  "symbols": [{"name": "exact identifier from the file", "description": "one sentence"}],
  "concepts": ["up to 6 domain concepts the file deals with, as short Title Case noun phrases"]
}
Describe only the important symbols (at most 12). Concepts are ideas a reader would
look up (e.g. "Git Smart HTTP", "Personal Access Tokens"), not language features
or file names. Be specific to this codebase. Reply with JSON only.`;

interface Card {
  summary?: string;
  responsibilities?: string[];
  symbols?: { name?: string; description?: string }[];
  concepts?: string[];
}

const MAX_CARD_INPUT = 24_000;

async function card(
  env: Env,
  path: string,
  role: FileRole,
  content: string,
  symbols: FileSymbol[],
  previousConcepts: string[],
) {
  const body =
    content.length > MAX_CARD_INPUT
      ? `${content.slice(0, MAX_CARD_INPUT)}\n… (truncated)`
      : content;
  const known = symbols.length
    ? `Symbols found by the parser: ${symbols.map((s) => s.name).join(", ")}\n`
    : "";
  // Left to itself the model rewords a file's concepts on every edit, and each
  // new wording is a new concept to align against the rest of the repository.
  const before = previousConcepts.length
    ? `Concepts of this file before its latest edit: ${previousConcepts.join("; ")}\n` +
      "Keep each of those names exactly as written while the file still deals with it; " +
      "change the list only for what the edit added or removed.\n"
    : "";
  return chatJson<Card>(
    env,
    "fast",
    CARD_SYSTEM,
    `File: ${path}\nRole: ${role}\n${known}${before}\n${body}`,
    {
      maxTokens: 1600,
    },
  );
}

function mergeSymbols(found: FileSymbol[], described: Card["symbols"]): FileSymbol[] {
  const descriptions = new Map(
    (described ?? [])
      .filter((s) => s.name && s.description)
      .map((s) => [s.name as string, s.description as string]),
  );
  return found.map((s) =>
    descriptions.has(s.name) ? { ...s, description: descriptions.get(s.name) } : s,
  );
}

export async function loadAnalyses(
  d1: D1Database,
  blobs: string[],
): Promise<Map<string, FileAnalysis>> {
  const out = new Map<string, FileAnalysis>();
  for (const group of chunk([...new Set(blobs)], 90)) {
    const results = await db(d1)
      .selectFrom("kg_blob_analysis")
      .select(["blob_oid", "data"])
      .where("analyzer", "=", ANALYZER)
      .where("blob_oid", "in", group)
      .execute();
    for (const row of results) out.set(row.blob_oid, JSON.parse(row.data) as FileAnalysis);
  }
  return out;
}

async function store(
  d1: D1Database,
  blob: string,
  analysis: FileAnalysis,
  model: string | null,
  tokens: number,
) {
  await db(d1)
    .insertInto("kg_blob_analysis")
    .values({
      blob_oid: blob,
      analyzer: ANALYZER,
      language: analysis.language,
      data: JSON.stringify(analysis),
      model,
      tokens,
    })
    .onConflict((oc) =>
      oc.columns(["blob_oid", "analyzer"]).doUpdateSet((eb) => ({
        data: eb.ref("excluded.data"),
        model: eb.ref("excluded.model"),
        tokens: eb.ref("excluded.tokens"),
      })),
    )
    .execute();
}

export interface AnalyzeStats {
  analyzed: number;
  reused: number;
  skipped: number;
  failed: number;
  tokens: number;
  lastError?: string;
}

/**
 * Analyze files that have no analysis for their current content yet.
 * Edits that clef judges cosmetic keep the previous card (seconds instead of
 * a model call), which is what keeps busy repositories close to real time.
 */
export async function analyzeFiles(
  env: Env,
  reader: RepoReader,
  files: FileToAnalyze[],
): Promise<AnalyzeStats> {
  const stats: AnalyzeStats = { analyzed: 0, reused: 0, skipped: 0, failed: 0, tokens: 0 };
  const decoder = new TextDecoder();
  const loaded = await pool(files, 8, async (file) => {
    const blob = await reader.blob(file.blob);
    return { ...file, size: blob?.size ?? 0, content: blob ? decoder.decode(blob.bytes) : "" };
  });

  const previous = await loadAnalyses(
    env.DB,
    loaded.flatMap((f) => (f.previousBlob ? [f.previousBlob] : [])),
  );
  const needsCard: (typeof loaded)[number][] = [];

  // 1. Skips, and cosmetic edits that can keep their previous card.
  await pool(loaded, 6, async (file) => {
    const language = languageOf(file.path);
    const skipped = skipReason(file.path, file.size);
    const extracted = extract(file.path, skipped ? "" : file.content);
    if (skipped) {
      stats.skipped++;
      await store(
        env.DB,
        file.blob,
        {
          language,
          role: language === "binary" ? "asset" : "generated",
          lines: extracted.lines,
          skipped,
          summary: "",
          responsibilities: [],
          symbols: [],
          concepts: [],
          imports: [],
        },
        null,
        0,
      );
      return;
    }
    const before = file.previousBlob ? previous.get(file.previousBlob) : undefined;
    if (before && !before.skipped && file.previousBlob) {
      const old = await reader.blob(file.previousBlob);
      const patch = structuredPatch(
        file.path,
        file.path,
        old ? decoder.decode(old.bytes) : "",
        file.content,
        "",
        "",
        {
          context: 2,
        },
      );
      const changed = patch.hunks.reduce(
        (n, h) => n + h.lines.filter((l) => /^[+-]/.test(l)).length,
        0,
      );
      if (changed > 0 && changed <= 80) {
        const diff = patch.hunks
          .flatMap((h) => [`@@ -${h.oldStart} +${h.newStart} @@`, ...h.lines])
          .join("\n");
        const answers = await decide(
          env,
          { path: file.path, diff },
          {
            meaningful: {
              type: "noul",
              instructions:
                "Does this diff change what the code does, its API, or what it means to a reader? Comments, formatting, renames of local variables and typo fixes are not meaningful.",
            },
          },
        );
        if (yes(answers.meaningful) < 0.2) {
          stats.reused++;
          await store(
            env.DB,
            file.blob,
            {
              ...before,
              lines: extracted.lines,
              imports: extracted.imports,
              symbols: mergeSymbols(
                extracted.symbols,
                before.symbols.map((s) => ({ name: s.name, description: s.description })),
              ),
              reusedFrom: file.previousBlob,
            },
            null,
            0,
          );
          return;
        }
      }
    }
    needsCard.push(file);
  });

  // 2. Roles: certain ones from the path, the rest from clef in batches.
  const roles = new Map<string, FileRole>();
  const unsure = needsCard.filter((f) => {
    const role = obviousRole(f.path, languageOf(f.path));
    if (role) roles.set(f.path, role);
    return !role;
  });
  for (const group of chunk(unsure, 32)) {
    const questions: Record<string, ClefQuestion> = {};
    group.forEach((f, i) => {
      questions[`f${i}`] = {
        type: "choice",
        instructions: {
          question: "What is this file's role in the repository?",
          path: f.path,
          start: f.content.slice(0, 1500),
        },
        criteria: ROLE_CRITERIA,
      };
    });
    const answers = await decide(
      env,
      "Files from one software repository, to be classified by role.",
      questions,
    );
    group.forEach((f, i) =>
      roles.set(f.path, (choice(answers[`f${i}`]) as FileRole | null) ?? "source"),
    );
  }

  // 3. Semantic cards from the fast model.
  await pool(needsCard, 8, async (file) => {
    const language = languageOf(file.path);
    const role = roles.get(file.path) ?? "source";
    const extracted = extract(file.path, file.content);
    const symbols: FileSymbol[] = extracted.symbols;
    const base = { language, role, lines: extracted.lines, imports: extracted.imports };
    if (role === "generated" || role === "asset") {
      stats.skipped++;
      await store(
        env.DB,
        file.blob,
        { ...base, skipped: role, summary: "", responsibilities: [], symbols, concepts: [] },
        null,
        0,
      );
      return;
    }
    let result;
    try {
      const before = file.previousBlob ? previous.get(file.previousBlob) : undefined;
      result = await card(env, file.path, role, file.content, symbols, before?.concepts ?? []);
    } catch (error) {
      // Left without an analysis: the graph shows it as pending and the next
      // build tries again. Only a failure of every file fails the step.
      stats.failed++;
      stats.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    const { value, usage } = result;
    stats.analyzed++;
    stats.tokens += usage.tokens;
    await store(
      env.DB,
      file.blob,
      {
        ...base,
        summary: (value.summary ?? "").trim(),
        responsibilities: (value.responsibilities ?? []).filter(Boolean).slice(0, 5),
        symbols: mergeSymbols(symbols, value.symbols),
        concepts: [...new Set((value.concepts ?? []).map((c) => c.trim()).filter(Boolean))].slice(
          0,
          6,
        ),
      },
      usage.model,
      usage.tokens,
    );
  });
  if (stats.failed > 0 && stats.analyzed === 0 && needsCard.length > 0) {
    throw new Error(`Every file in the batch failed: ${stats.lastError}`);
  }
  return stats;
}
