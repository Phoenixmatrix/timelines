// Capability names, summaries and membership rationale (CORE-164).
//
// Grouping (grouping.ts) decides membership from structural evidence alone;
// this pass only puts words on what it decided. Nothing here moves a member,
// so a change in model wording can never change membership, and a capability's
// id never depends on its name.
//
// Each capability is described from source-backed inputs: its member files'
// analysis cards, the directory components' syntheses they fall in, the
// concepts they share, and the structural evidence that grouped them; never
// from other capabilities' prose. The result is cached in kg_synthesis under a
// hash of exactly those inputs (and the repository, so provenance never
// crosses repositories), so identical inputs are never inferred twice.
//
// A cache miss is a paid call, made only through `infer` (the build passes the
// Atlas budget's runner, CORE-162): once, never retried, and not at all once a
// cap is reached, the model is unpriced or the provider failed. Then the
// capability keeps its interim concept name and its prose is "unavailable",
// or, when the previous snapshot had prose for it, that prose "stale" with the
// source version it was written from. Nothing is invented as a fallback.
//
// What a capability's `data` gains (types in shared/atlas.ts):
//   description  {status, reason?, exhausted?, name, summary, rationale}
//   provenance   {structural, inferred, curated}: grouping facts, the model
//                inference with what it was derived from and its immutable
//                sources (repo, commit, path, blob, ranges), and curated
//                assertions (none yet)
//   interimName  the concept-derived name grouping gave it

import type {
  AtlasDerivation,
  AtlasDescription,
  AtlasInference,
  AtlasProvenance,
  AtlasSourceRef,
  AtlasUnavailableReason,
} from "../../shared/atlas.ts";
import { ANALYZER, type FileAnalysis } from "../knowledge/analyze.ts";
import { chatJson, MODELS } from "../knowledge/models.ts";
import { cached, remember } from "../knowledge/synthesize.ts";
import { pool, sha256 } from "../knowledge/util.ts";
import { GROUPING_VERSION } from "./grouping.ts";
import {
  buildingMemberships,
  currentSnapshot,
  entityAt,
  repoScope,
  reviseEntities,
  type AtlasEntity,
} from "./projection.ts";

/** Bump when the prompt, inputs or output shape change: cached prose is then rewritten. */
export const DESCRIBE_VERSION = 1;
/** What Atlas spend records these calls as. */
export const DESCRIBE_PURPOSE = "capability_summary";
/** Output per call: 20 calls fit the build's 10,000 output tokens. */
export const DESCRIBE_MAX_OUTPUT_TOKENS = 500;
const MAX_FILES = 16;
const MAX_COMPONENTS = 4;
const MAX_CONCEPTS = 6;
const MAX_SOURCES = 6;
const MAX_SYMBOLS = 5;
const CARD_CHARS = 300;
const COMPONENT_CHARS = 400;
const CONCEPT_CHARS = 200;
const CONCURRENCY = 4;

// ---- the budget seam ------------------------------------------------------------

export interface AtlasInferRequest {
  purpose: string;
  model: string;
  /** Every text sent (system and user), for the input-token reservation. */
  prompt: string[];
  maxOutputTokens: number;
}

export type AtlasInferOutcome<T> =
  | { status: "done"; value: T }
  | { status: "exhausted"; cap: string; resetsAt: string | null }
  | { status: "disabled"; reason: string; model: string };

/**
 * Runs one paid call under the Atlas budget: reserve, call once, reconcile.
 * The build passes `atlasInfer` (knowledge/budget.ts); only build code may.
 */
export type AtlasInfer = <T>(
  request: AtlasInferRequest,
  call: () => Promise<{
    value: T;
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  }>,
) => Promise<AtlasInferOutcome<T>>;

export interface DescribeContext {
  repoId: string;
  buildId: string;
  snapshotId: string;
  seq: number;
  /** The commit the snapshot indexes. */
  commit: string;
}

export interface DescribeOptions {
  /** Null: make no model calls (cached prose is still used). */
  infer: AtlasInfer | null;
  /** Why prose is unavailable when `infer` is null. */
  unavailable?: AtlasUnavailableReason;
  now?: () => Date;
}

export interface DescribeStats {
  capabilities: number;
  /** Prose written from this snapshot's inputs: from the cache, or inferred now. */
  current: number;
  cached: number;
  inferred: number;
  stale: number;
  unavailable: number;
  reasons: Partial<Record<AtlasUnavailableReason, number>>;
}

// ---- inputs ------------------------------------------------------------------------

interface MemberFile {
  id: string;
  path: string;
  blob: string | null;
  lines: number | null;
  card: FileAnalysis | null;
  cardModel: string | null;
  /** Summed weight of the links that placed it (ranking only). */
  support: number;
}

interface Member {
  id: string;
  area: string | null;
  /** Summed weight of the links that placed it (ranking only). */
  support: number;
}

/**
 * Members in rank order, taking turns between areas (in the order their best
 * member ranks), so a bounded prompt shows every area, not just the largest.
 */
function interleave(ranked: Member[]): Member[] {
  const byArea = new Map<string | null, Member[]>();
  for (const m of ranked) byArea.set(m.area, [...(byArea.get(m.area) ?? []), m]);
  const queues = [...byArea.values()];
  const out: Member[] = [];
  for (let i = 0; out.length < ranked.length; i++)
    for (const queue of queues) if (queue[i]) out.push(queue[i]!);
  return out;
}

interface Prepared {
  entity: AtlasEntity;
  interimName: string;
  files: MemberFile[];
  components: { id: string; title: string; summary: string; paths: string[] }[];
  concepts: { id: string; name: string; definition: string; files: number }[];
  membership: { files: number; importLinks: number };
  input: unknown;
  inputsHash: string;
}

interface Reply {
  name?: unknown;
  summary?: unknown;
  rationale?: unknown;
  sources?: unknown;
}

/** What is cached per inputs hash: the prose and where it came from. */
interface CachedDescription {
  name: string;
  summary: string;
  rationale: string;
  inference: AtlasInference;
}

const SYSTEM = `You name and describe one capability of a software repository: a set of files grouped
by the imports between them and the domain concepts they share (not by folder).
When areas are given, they are its parts: name and describe the whole, covering every area, not
only the first files. From the file cards, component summaries, shared concepts, areas and grouping
evidence given, return JSON:
{
  "name": "2-5 word Title Case name for what these files do together; specific, not 'Core' or 'Utilities'",
  "summary": "2-3 sentences: the responsibility the files share, as their cards describe it",
  "rationale": "1-2 sentences: why these files belong together, naming the shared concepts or import links given",
  "sources": ["up to ${MAX_SOURCES} exact file paths from the input that best support the summary"]
}
Use only the input. Describe what the code is for; never claim it was run, tested or verified,
and give no confidence scores. Reply with JSON only.`;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function parseData(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Load every capability of snapshot `seq` with what describing it needs. */
async function prepare(env: Env, ctx: DescribeContext): Promise<Prepared[]> {
  const d1 = env.DB;
  const scope = repoScope(ctx.repoId);
  const [capRows, areaRows, assignments, imports, componentEdges] = await Promise.all([
    d1
      .prepare(
        `SELECT entity_id, kind, parent_id, name, path, summary, data FROM atlas_entities
         WHERE scope = ? AND kind = 'capability' AND from_seq <= ? AND (to_seq IS NULL OR to_seq > ?)`,
      )
      .bind(scope, ctx.seq, ctx.seq)
      .all<{
        entity_id: string;
        kind: string;
        parent_id: string | null;
        name: string;
        path: string | null;
        summary: string;
        data: string;
      }>(),
    d1
      .prepare(
        `SELECT entity_id, data FROM atlas_entities
         WHERE scope = ? AND kind = 'area' AND from_seq <= ? AND (to_seq IS NULL OR to_seq > ?)`,
      )
      .bind(scope, ctx.seq, ctx.seq)
      .all<{ entity_id: string; data: string }>(),
    buildingMemberships(d1, ctx.snapshotId),
    d1
      .prepare(
        `SELECT src, dst FROM kg_edges WHERE repo_id = ? AND kind = 'imports'
         AND src LIKE 'file:%' AND dst LIKE 'file:%'`,
      )
      .bind(ctx.repoId)
      .all<{ src: string; dst: string }>(),
    d1
      .prepare(
        `SELECT src, dst FROM kg_edges WHERE repo_id = ? AND kind = 'contains' AND src LIKE 'component:%'`,
      )
      .bind(ctx.repoId)
      .all<{ src: string; dst: string }>(),
  ]);
  if (!capRows.results.length) return [];

  // Primary members only: cross-cutting references never describe a capability.
  const members = new Map<string, Member[]>();
  const capabilityOf = new Map<string, string>();
  for (const row of assignments) {
    const data = parseData(row.data) as {
      capability?: string | null;
      area?: string | null;
      rationale?: { weight?: number }[];
    };
    if (!data.capability) continue;
    const support = (data.rationale ?? []).reduce((n, r) => n + (Number(r.weight) || 0), 0);
    const list = members.get(data.capability) ?? [];
    list.push({ id: row.entity_id, area: data.area ?? null, support });
    members.set(data.capability, list);
    capabilityOf.set(row.entity_id, data.capability);
  }

  const capabilities = capRows.results.map((row) => {
    const entity: AtlasEntity = {
      id: row.entity_id,
      kind: row.kind,
      parentId: row.parent_id,
      name: row.name,
      path: row.path,
      summary: row.summary,
      data: parseData(row.data),
    };
    const anchor = typeof entity.data.anchor === "string" ? entity.data.anchor : "";
    const ranked = interleave(
      (members.get(entity.id) ?? []).sort(
        (a, b) =>
          Number(b.id === anchor) - Number(a.id === anchor) ||
          b.support - a.support ||
          byId(a.id, b.id),
      ),
    );
    return { entity, ranked };
  });
  const areaConcepts = new Map(
    areaRows.results.map((row) => {
      const concepts = parseData(row.data).concepts;
      return [
        row.entity_id,
        (Array.isArray(concepts) ? concepts : []).slice(0, 3).flatMap((c) => {
          const name = (c as { name?: unknown }).name;
          return typeof name === "string" ? [name] : [];
        }),
      ];
    }),
  );

  // The cards of the files each description shows, by blob.
  const shown = capabilities.flatMap((c) => c.ranked.slice(0, MAX_FILES).map((m) => m.id));
  const fileNodes = new Map<string, { path: string; blob: string | null; lines: number | null }>();
  for (let i = 0; i < shown.length; i += 500) {
    const rows = await d1
      .prepare(
        `SELECT id, path, data FROM kg_nodes WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ctx.repoId, JSON.stringify(shown.slice(i, i + 500)))
      .all<{ id: string; path: string | null; data: string }>();
    for (const row of rows.results) {
      const data = parseData(row.data);
      fileNodes.set(row.id, {
        path: row.path ?? row.id.slice(5),
        blob: typeof data.blob === "string" ? data.blob : null,
        lines: typeof data.lines === "number" ? data.lines : null,
      });
    }
  }
  const blobs = [...new Set([...fileNodes.values()].flatMap((f) => (f.blob ? [f.blob] : [])))];
  const cards = new Map<string, { card: FileAnalysis; model: string | null }>();
  for (let i = 0; i < blobs.length; i += 500) {
    const rows = await d1
      .prepare(
        `SELECT blob_oid, data, model FROM kg_blob_analysis
         WHERE analyzer = ? AND blob_oid IN (SELECT value FROM json_each(?))`,
      )
      .bind(ANALYZER, JSON.stringify(blobs.slice(i, i + 500)))
      .all<{ blob_oid: string; data: string; model: string | null }>();
    for (const row of rows.results)
      cards.set(row.blob_oid, { card: JSON.parse(row.data) as FileAnalysis, model: row.model });
  }

  // Components overlapping each capability, and the concepts it shares.
  const componentFiles = new Map<string, Map<string, string[]>>();
  for (const { src, dst } of componentEdges.results) {
    const cap = capabilityOf.get(dst);
    if (!cap) continue;
    const byComponent = componentFiles.get(cap) ?? new Map<string, string[]>();
    byComponent.set(src, [...(byComponent.get(src) ?? []), dst]);
    componentFiles.set(cap, byComponent);
  }
  const importLinks = new Map<string, number>();
  for (const { src, dst } of imports.results) {
    const cap = capabilityOf.get(src);
    if (cap && cap === capabilityOf.get(dst)) importLinks.set(cap, (importLinks.get(cap) ?? 0) + 1);
  }
  const topComponents = new Map(
    capabilities.map(({ entity }) => [
      entity.id,
      [...(componentFiles.get(entity.id) ?? new Map<string, string[]>())]
        .sort((a, b) => b[1].length - a[1].length || byId(a[0], b[0]))
        .slice(0, MAX_COMPONENTS),
    ]),
  );
  const conceptsOf = (entity: AtlasEntity) =>
    (Array.isArray(entity.data.concepts) ? entity.data.concepts : [])
      .slice(0, MAX_CONCEPTS)
      .map((c) => c as { id: string; name: string; weight: number });
  const nodeIds = [
    ...new Set([
      ...[...topComponents.values()].flatMap((list) => list.map(([id]) => id)),
      ...capabilities.flatMap(({ entity }) => conceptsOf(entity).map((c) => c.id)),
    ]),
  ];
  const prose = new Map<string, { name: string; summary: string }>();
  for (let i = 0; i < nodeIds.length; i += 500) {
    const rows = await d1
      .prepare(
        `SELECT id, name, summary FROM kg_nodes WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ctx.repoId, JSON.stringify(nodeIds.slice(i, i + 500)))
      .all<{ id: string; name: string; summary: string }>();
    for (const row of rows.results) prose.set(row.id, { name: row.name, summary: row.summary });
  }

  const prepared: Prepared[] = [];
  for (const { entity, ranked } of capabilities) {
    const files: MemberFile[] = ranked.slice(0, MAX_FILES).flatMap((m) => {
      const node = fileNodes.get(m.id);
      if (!node) return [];
      const card = node.blob ? cards.get(node.blob) : undefined;
      return [
        {
          id: m.id,
          path: node.path,
          blob: node.blob,
          lines: node.lines,
          card: card?.card ?? null,
          cardModel: card?.model ?? null,
          support: m.support,
        },
      ];
    });
    const paths = new Map(files.map((f) => [f.id, f.path]));
    const components = (topComponents.get(entity.id) ?? []).flatMap(([id, fileIds]) => {
      const node = prose.get(id);
      if (!node?.summary) return [];
      return [
        {
          id,
          title: node.name,
          summary: cut(node.summary, COMPONENT_CHARS),
          paths: fileIds.flatMap((f) => (paths.has(f) ? [paths.get(f)!] : [])).sort(byId),
        },
      ];
    });
    const concepts = conceptsOf(entity).map((c) => ({
      id: c.id,
      name: c.name,
      definition: cut(prose.get(c.id)?.summary ?? "", CONCEPT_CHARS),
      files: Number(c.weight) || 0,
    }));
    const membership = {
      files: ranked.length,
      importLinks: importLinks.get(entity.id) ?? 0,
    };
    // Areas (shown when a capability has two or more): which shown files and concepts each has.
    const areaOf = new Map(ranked.map((m) => [m.id, m.area]));
    const areas = [...new Set(files.map((f) => areaOf.get(f.id) ?? null))]
      .filter((a): a is string => a !== null)
      .map((a) => ({
        concepts: areaConcepts.get(a) ?? [],
        files: files.filter((f) => areaOf.get(f.id) === a).map((f) => f.path),
      }));
    const input = {
      files: files.map((f) => ({
        path: f.path,
        role: f.card?.role ?? null,
        summary: cut(f.card?.summary ?? "", CARD_CHARS),
        responsibilities: (f.card?.responsibilities ?? []).slice(0, 3),
        symbols: exportedSymbols(f.card).map((s) => s.name),
      })),
      components: components.map((c) => ({
        title: c.title,
        summary: c.summary,
        member_files: c.paths.length,
      })),
      ...(areas.length > 1 ? { areas } : {}),
      concepts: concepts.map((c) => ({
        name: c.name,
        definition: c.definition,
        files: c.files,
      })),
      grouping: {
        member_files: membership.files,
        files_shown: files.length,
        import_links_between_members: membership.importLinks,
      },
    };
    const interimName =
      typeof entity.data.interimName === "string" ? entity.data.interimName : entity.name;
    prepared.push({
      entity,
      interimName,
      files,
      components,
      concepts,
      membership,
      input,
      inputsHash: await sha256(
        `atlas-capability:${DESCRIBE_VERSION}:${ANALYZER}:${MODELS.reason}:${ctx.repoId}:${JSON.stringify(input)}`,
      ),
    });
  }
  // Largest first: when a cap stops paid work, the biggest regions have words.
  return prepared.sort(
    (a, b) => b.membership.files - a.membership.files || byId(a.entity.id, b.entity.id),
  );
}

function exportedSymbols(card: FileAnalysis | null) {
  return (card?.symbols ?? []).filter((s) => s.exported || s.description).slice(0, MAX_SYMBOLS);
}

// ---- provenance ------------------------------------------------------------------

function sourceRef(ctx: DescribeContext, file: MemberFile): AtlasSourceRef {
  return {
    repoId: ctx.repoId,
    commit: ctx.commit,
    path: file.path,
    blob: file.blob,
    range: file.lines
      ? { startLine: 1, endLine: file.lines, status: "whole-file" }
      : { startLine: null, endLine: null, status: "unavailable" },
    symbols: exportedSymbols(file.card).map((s) => ({
      name: s.name,
      // The card knows where a symbol starts, not where it ends.
      range:
        typeof s.line === "number" && s.line > 0
          ? { startLine: s.line, endLine: null, status: "start-line" }
          : { startLine: null, endLine: null, status: "unavailable" },
    })),
  };
}

function derivations(p: Prepared): AtlasDerivation[] {
  return [
    {
      kind: "membership",
      producer: "atlas/grouping",
      version: GROUPING_VERSION,
      files: p.membership.files,
      importLinks: p.membership.importLinks,
    },
    ...p.files.flatMap((f): AtlasDerivation[] =>
      f.blob && f.card
        ? [
            {
              kind: "file-card",
              path: f.path,
              blob: f.blob,
              producer: "knowledge/analyze",
              analyzer: ANALYZER,
              model: f.cardModel,
            },
          ]
        : [],
    ),
    ...p.components.map((c): AtlasDerivation => ({
      kind: "component-synthesis",
      id: c.id,
      producer: "knowledge/synthesize",
      analyzer: ANALYZER,
      model: "unavailable",
      paths: c.paths,
    })),
    ...p.concepts.map((c): AtlasDerivation => ({
      kind: "concept",
      id: c.id,
      name: c.name,
      producer: "knowledge/concepts",
      files: c.files,
    })),
  ];
}

/** The model's reply as prose with sources, or null when it gave nothing usable. */
function accept(
  p: Prepared,
  ctx: DescribeContext,
  reply: Reply,
  model: string,
  now: Date,
): CachedDescription | null {
  const text = (v: unknown, max: number) =>
    typeof v === "string" ? cut(v.trim().replace(/\s+/g, " "), max) : "";
  const name = text(reply.name, 60);
  const summary = text(reply.summary, 700);
  if (!name || !summary) return null;
  // Sources are member files the model named, else the files it was shown:
  // prose always rests on files, never on other prose.
  const byPath = new Map(p.files.filter((f) => f.card).map((f) => [f.path, f]));
  const cited = [
    ...new Set((Array.isArray(reply.sources) ? reply.sources : []).map((s) => String(s))),
  ]
    .flatMap((path) => (byPath.has(path) ? [byPath.get(path)!] : []))
    .slice(0, MAX_SOURCES);
  const sources = (cited.length ? cited : [...byPath.values()].slice(0, MAX_SOURCES)).map((f) =>
    sourceRef(ctx, f),
  );
  if (!sources.length) return null;
  return {
    name,
    summary,
    rationale: text(reply.rationale, 400),
    inference: {
      fields: ["name", "summary", "rationale"],
      producer: "atlas/describe",
      version: DESCRIBE_VERSION,
      model,
      inputsHash: p.inputsHash,
      basis: { repoId: ctx.repoId, commit: ctx.commit, buildId: ctx.buildId },
      inferredAt: now.toISOString(),
      derivedFrom: derivations(p),
      sources,
    },
  };
}

// ---- the pass ----------------------------------------------------------------------

type Outcome =
  | { kind: "current"; value: CachedDescription; cached: boolean }
  | {
      kind: "missing";
      reason: AtlasUnavailableReason;
      exhausted?: { cap: string; resetsAt: string | null };
    };

const isReplyError = (error: unknown) =>
  error instanceof SyntaxError || /no json object|returned no content/i.test(String(error));

/**
 * Name and describe snapshot `seq`'s capabilities (after `groupRepoCapabilities`,
 * before the entity batches). Never moves a member or changes an id; never
 * throws for a model failure (prose is then unavailable or stale).
 */
export async function describeRepoCapabilities(
  env: Env,
  ctx: DescribeContext,
  options: DescribeOptions,
): Promise<DescribeStats> {
  const now = options.now ?? (() => new Date());
  const prepared = await prepare(env, ctx);
  const stats: DescribeStats = {
    capabilities: prepared.length,
    current: 0,
    cached: 0,
    inferred: 0,
    stale: 0,
    unavailable: 0,
    reasons: {},
  };
  if (!prepared.length) return stats;

  // Once paid work stops (a cap, no price, a failing provider), it stays stopped.
  let stopped: Extract<Outcome, { kind: "missing" }> | null = options.infer
    ? null
    : { kind: "missing", reason: options.unavailable ?? "disabled" };
  const outcomes = await pool(prepared, CONCURRENCY, async (p): Promise<Outcome> => {
    const hit = await cached<CachedDescription>(env.DB, p.inputsHash);
    if (hit) return { kind: "current", value: hit, cached: true };
    if (stopped || !options.infer) return stopped ?? { kind: "missing", reason: "disabled" };
    const user = JSON.stringify(p.input);
    let result: AtlasInferOutcome<{ reply: Reply; model: string; tokens: number }>;
    try {
      result = await options.infer(
        {
          purpose: DESCRIBE_PURPOSE,
          model: MODELS.reason,
          prompt: [SYSTEM, user],
          maxOutputTokens: DESCRIBE_MAX_OUTPUT_TOKENS,
        },
        async () => {
          // One attempt: Atlas budgets allow no automatic paid retries.
          const { value, usage } = await chatJson<Reply>(env, "reason", SYSTEM, user, {
            maxTokens: DESCRIBE_MAX_OUTPUT_TOKENS,
            attempts: 1,
          });
          return {
            value: { reply: value, model: usage.model, tokens: usage.tokens },
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          };
        },
      );
    } catch (error) {
      if (isReplyError(error)) return { kind: "missing", reason: "invalid_reply" };
      console.error("Atlas capability description failed", p.entity.id, error);
      stopped ??= { kind: "missing", reason: "provider_error" };
      return { kind: "missing", reason: "provider_error" };
    }
    if (result.status === "exhausted") {
      stopped ??= {
        kind: "missing",
        reason: "budget_exhausted",
        exhausted: { cap: result.cap, resetsAt: result.resetsAt },
      };
      return stopped;
    }
    if (result.status === "disabled") {
      stopped ??= { kind: "missing", reason: "disabled" };
      return stopped;
    }
    const value = accept(p, ctx, result.value.reply, result.value.model, now());
    if (!value) return { kind: "missing", reason: "invalid_reply" };
    await remember(env.DB, p.inputsHash, value, result.value.model, result.value.tokens);
    return { kind: "current", value, cached: false };
  });

  // Prose the previous snapshot had, for capabilities that get none now.
  const scope = repoScope(ctx.repoId);
  const prior = await currentSnapshot(env.DB, scope);
  const revised: AtlasEntity[] = [];
  for (const [i, p] of prepared.entries()) {
    const outcome = outcomes[i]!;
    const structural: AtlasProvenance["structural"] = {
      producer: "atlas/grouping",
      version: GROUPING_VERSION,
      evidence: ["imports", "concepts"],
    };
    let description: AtlasDescription;
    let inferred: AtlasInference | null = null;
    if (outcome.kind === "current") {
      const { value } = outcome;
      description = {
        status: "current",
        name: value.name,
        summary: value.summary,
        rationale: value.rationale || null,
      };
      inferred = value.inference;
      stats.current++;
      if (outcome.cached) stats.cached++;
      else stats.inferred++;
    } else {
      const before =
        prior && prior.seq !== ctx.seq
          ? await entityAt(env.DB, scope, prior.seq, p.entity.id)
          : null;
      const old = before?.data.description as AtlasDescription | undefined;
      const oldInference = (before?.data.provenance as AtlasProvenance | undefined)?.inferred;
      const base = {
        reason: outcome.reason,
        ...(outcome.exhausted ? { exhausted: outcome.exhausted } : {}),
      };
      if (old && old.status !== "unavailable" && old.summary && oldInference) {
        // Earlier prose, labelled stale, with the source version it was written from.
        description = {
          status: "stale",
          ...base,
          name: old.name,
          summary: old.summary,
          rationale: old.rationale,
        };
        inferred = oldInference;
        stats.stale++;
      } else {
        description = {
          status: "unavailable",
          ...base,
          name: null,
          summary: null,
          rationale: null,
        };
        stats.unavailable++;
      }
      stats.reasons[outcome.reason] = (stats.reasons[outcome.reason] ?? 0) + 1;
    }
    const current = description.status === "current";
    const provenance: AtlasProvenance = { structural, inferred, curated: [] };
    revised.push({
      ...p.entity,
      // Only current prose names a capability; otherwise the interim concept name stays.
      name: current && description.name ? description.name : p.interimName,
      summary: current ? (description.summary ?? "") : "",
      data: {
        ...p.entity.data,
        interimName: p.interimName,
        nameSource: current ? "model" : "concepts",
        description,
        provenance,
      },
    });
  }
  await reviseEntities(env.DB, scope, ctx.snapshotId, ctx.seq, revised);
  return stats;
}
