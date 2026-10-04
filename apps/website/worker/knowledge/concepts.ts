// Concept alignment and trimming. File analyses name concepts independently,
// so one idea shows up under many names ("D1 Database", "Cloudflare D1") and
// most names are details of a single file. clef cleans that up, following the
// entity-alignment recipe (block candidates cheaply, ask one typed question
// per pair, route by the nearest level, no fitted thresholds):
//
//   pairs    candidate pairs come from shared uncommon words (each concept's
//            closest few) and mutual nearest neighbours by name embedding;
//            clef places each pair on 0 different / 1 related but separate /
//            2 the same, plus which one is a part or kind of the other
//   merge    pairs at level 2 merge into groups under a stable canonical key,
//            never chaining into a group that holds a concept judged different
//   link     level-1 pairs with a clear direction become narrower → broader
//   trim     each group is asked whether a newcomer would look it up in the
//            glossary; groups mentioned by 3+ files always stay. Trimmed
//            names live on as file topics instead of graph nodes.
//   review   once kept concepts have definitions, related pairs of them are
//            asked again with the definitions, which settles many that names
//            alone left in between; a "same" there merges them too.
//
// Every decision is stored, so after the first build a push only asks about
// the concepts it introduced.
//
// Question wording was chosen on hand-labelled samples from this repository:
// the glossary framing with file paths (no summaries) ranked pairs best, and
// merges at level 2 were all correct; see the README.

import type { InferResult } from "kysely";
import type { AiModels } from "../../shared/ai.ts";
import { batch, db } from "../schema.ts";
import type { FileAnalysis } from "./analyze.ts";
import type { BuiltGraph, SnapshotFile } from "./graph.ts";
import { decide, embed, type ClefQuestion } from "./models.ts";
import { pool, runBatched, sha256, slug, type Statement } from "./util.ts";

export const ALIGNER = "a1";

/** Nearest level 2 (score ≥ 1.5): the same concept. */
const SAME = 1.5;
/** Nearest level 0 (score ≤ 0.5): different concepts. */
const DIFFERENT = 0.5;
/** A clear direction for a related pair: likely one way, unlikely the other. */
const DIRECTION_YES = 0.75;
const DIRECTION_NO = 0.25;
/** Concepts mentioned by this many files are glossary-worthy without asking. */
const WELL_USED = 3;
/** Above this many concepts, skip the O(n²) embedding comparison. */
const MAX_EMBEDDED = 1200;
const NEIGHBOURS = 3;
/** Shared-word candidates kept per concept, closest first. */
const PAIRS_PER_CONCEPT = 4;
const CLEF_CONCURRENCY = 6;

export interface ConceptModel {
  /** Concept key -> canonical key, for keys that merged into another. */
  canonical: Map<string, string>;
  /** Canonical keys clef judged glossary-worthy. */
  salient: Set<string>;
  /** Canonical keys judged not to be; they become file topics. */
  trimmed: Set<string>;
  /** [narrower, broader] canonical keys. */
  partOf: [string, string][];
}

export const EMPTY_CONCEPT_MODEL: ConceptModel = {
  canonical: new Map(),
  salient: new Set(),
  trimmed: new Set(),
  partOf: [],
};

export interface Decision {
  score: number;
  aInB: number;
  bInA: number;
}

export interface ConceptGroup {
  /** Every spelling seen, with how many files used it. */
  names: Map<string, number>;
  files: string[];
}

export function singular(word: string): string {
  if (word.length <= 3 || word.endsWith("ss") || word.endsWith("us") || word.endsWith("is"))
    return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/** Normalized concept key: case, punctuation and simple plurals don't split concepts. */
export function conceptKey(name: string): string {
  return slug(name.toLowerCase().split(/\s+/).map(singular).join(" "));
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const splitPair = (key: string) => key.split("\u0000") as [string, string];

/**
 * The most used spelling; on a tie, one that spells the group's own key
 * (so a merged concept is named after its canonical key), then alphabetical.
 */
export function displayName(names: Map<string, number>, key?: string): string {
  const own = (name: string) => (key !== undefined && conceptKey(name) === key ? 1 : 0);
  return (
    [...names].sort(
      (a, b) => b[1] - a[1] || own(b[0]) - own(a[0]) || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? ""
  );
}

/** Concept key -> its spellings and the files that mention it. */
export function collectConcepts(
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
): Map<string, ConceptGroup> {
  const out = new Map<string, ConceptGroup>();
  for (const file of files) {
    const analysis = analyses.get(file.blob);
    if (!analysis || analysis.skipped) continue;
    for (const name of analysis.concepts) {
      const key = conceptKey(name);
      if (!key) continue;
      const group: ConceptGroup = out.get(key) ?? { names: new Map(), files: [] };
      group.names.set(name, (group.names.get(name) ?? 0) + 1);
      if (!group.files.includes(file.path)) group.files.push(file.path);
      out.set(key, group);
    }
  }
  return out;
}

// ---- candidate pairs ----------------------------------------------------------

const STOP = new Set([
  "the",
  "and",
  "of",
  "a",
  "an",
  "to",
  "for",
  "in",
  "with",
  "as",
  "on",
  "by",
  "vs",
  "via",
]);

function tokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOP.has(t))
      .map(singular),
  );
}

/**
 * Pairs sharing an uncommon word with enough overlap, or where one name's
 * words are a subset of the other's; each concept keeps only its `perConcept`
 * closest (nesting first, then the share of rare words in common). A new name
 * that shares a word with dozens of concepts would otherwise cost a clef call
 * for each, nearly all "different": on this repository's decisions, four per
 * concept kept 91% of the merges for half the calls.
 *
 * With `newcomers`, only their own closest count: a newcomer that happens to
 * rank among an established concept's closest is not asked about for that.
 */
export function tokenCandidates(
  names: Map<string, string>,
  perConcept = PAIRS_PER_CONCEPT,
  newcomers?: ReadonlySet<string>,
): [string, string][] {
  const tok = new Map([...names].map(([key, name]) => [key, tokens(name)]));
  const index = new Map<string, string[]>();
  for (const [key, set] of tok) for (const t of set) index.set(t, [...(index.get(t) ?? []), key]);
  const rare = Math.max(8, Math.round(names.size * 0.03));
  // A word's weight falls with the number of concepts that use it.
  const weight = (t: string) => Math.log(names.size / (index.get(t)?.length ?? 1));
  const seen = new Set<string>();
  const ranked: { pair: [string, string]; rank: number }[] = [];
  for (const keys of index.values()) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] as string;
        const b = keys[j] as string;
        const pk = pairKey(a, b);
        if (seen.has(pk)) continue;
        seen.add(pk);
        const ta = tok.get(a) as Set<string>;
        const tb = tok.get(b) as Set<string>;
        const shared = [...ta].filter((t) => tb.has(t));
        const union = new Set([...ta, ...tb]);
        const jaccard = shared.length / union.size;
        const rareShared = shared.some((t) => (index.get(t)?.length ?? 0) <= rare);
        const subset = [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t));
        if (!((rareShared && jaccard >= 0.25) || subset)) continue;
        const sum = (ts: Iterable<string>) => [...ts].reduce((n, t) => n + weight(t), 0);
        // Nesting outranks any overlap (weighted overlap is below 1).
        const rank = (subset ? 1 : 0) + sum(shared) / (sum(union) || 1);
        ranked.push({ pair: splitPair(pk), rank });
      }
    }
  }
  // Keep a pair when it is among the closest for either of its concepts (or,
  // given newcomers, for a newcomer). Ranks depend only on names, so pairs
  // already decided keep their places.
  const closest = new Map<string, { pair: [string, string]; rank: number }[]>();
  for (const entry of ranked) {
    for (const key of entry.pair) {
      if (newcomers && !newcomers.has(key)) continue;
      closest.set(key, [...(closest.get(key) ?? []), entry]);
    }
  }
  const kept = new Set<{ pair: [string, string]; rank: number }>();
  for (const entries of closest.values()) {
    entries.sort((x, y) => y.rank - x.rank || pairKey(...x.pair).localeCompare(pairKey(...y.pair)));
    for (const entry of entries.slice(0, perConcept)) kept.add(entry);
  }
  return ranked.filter((e) => kept.has(e)).map((e) => e.pair);
}

/** Pairs that are each other's nearest neighbours by embedding (no threshold to tune). */
export function mutualNeighbours(
  keys: string[],
  vectors: number[][],
  k = NEIGHBOURS,
): [string, string][] {
  const dims = vectors[0]?.length ?? 0;
  const unit = vectors.map((v) => {
    const norm = Math.hypot(...v) || 1;
    return Float32Array.from(v, (x) => x / norm);
  });
  const top: number[][] = unit.map((a, i) => {
    const best: [number, number][] = [];
    for (let j = 0; j < unit.length; j++) {
      if (j === i) continue;
      const b = unit[j] as Float32Array;
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += (a[d] as number) * (b[d] as number);
      if (best.length < k || dot > (best[best.length - 1] as [number, number])[1]) {
        best.push([j, dot]);
        best.sort((x, y) => y[1] - x[1]);
        if (best.length > k) best.pop();
      }
    }
    return best.map(([j]) => j);
  });
  const out: [string, string][] = [];
  top.forEach((neighbours, i) => {
    for (const j of neighbours) {
      if (j > i && top[j]?.includes(i)) out.push([keys[i] as string, keys[j] as string]);
    }
  });
  return out;
}

// ---- grouping -----------------------------------------------------------------

/**
 * Merge keys that clef judged the same into groups and pick each group's
 * canonical key. A group never absorbs another if any pair across them was
 * judged different, so A≡B and B≡C can't drag in a C that differs from A.
 * The canonical key stays put across builds: the key most of the group already
 * pointed to, then the most mentioned, then the shortest.
 */
export function cluster(
  keys: string[],
  fileCounts: Map<string, number>,
  decisions: Map<string, Decision>,
  previous: Map<string, string>,
): Map<string, string> {
  const rootOf = new Map(keys.map((k) => [k, k]));
  const members = new Map(keys.map((k) => [k, [k]]));
  const same = [...decisions]
    .filter(([, d]) => d.score >= SAME)
    .sort((x, y) => y[1].score - x[1].score);
  for (const [pk] of same) {
    const [a, b] = splitPair(pk);
    const ra = rootOf.get(a);
    const rb = rootOf.get(b);
    if (!ra || !rb || ra === rb) continue;
    const groupA = members.get(ra) as string[];
    const groupB = members.get(rb) as string[];
    const conflict = groupA.some((x) =>
      groupB.some((y) => (decisions.get(pairKey(x, y))?.score ?? SAME) <= DIFFERENT),
    );
    if (conflict) continue;
    for (const y of groupB) rootOf.set(y, ra);
    groupA.push(...groupB);
    members.delete(rb);
  }

  const canonical = new Map<string, string>();
  for (const group of members.values()) {
    const votes = new Map<string, number>();
    for (const k of group) {
      const before = previous.get(k);
      if (before && group.includes(before)) votes.set(before, (votes.get(before) ?? 0) + 1);
    }
    const lead = [...group].sort(
      (x, y) =>
        (votes.get(y) ?? 0) - (votes.get(x) ?? 0) ||
        (fileCounts.get(y) ?? 0) - (fileCounts.get(x) ?? 0) ||
        x.length - y.length ||
        x.localeCompare(y),
    )[0] as string;
    for (const k of group) canonical.set(k, lead);
  }
  return canonical;
}

/** Narrower → broader links from related pairs with a clear direction. */
export function partOfLinks(
  decisions: Map<string, Decision>,
  canonical: Map<string, string>,
): [string, string][] {
  const out = new Map<string, [string, string]>();
  for (const [pk, d] of decisions) {
    if (d.score >= SAME || d.score <= DIFFERENT) continue;
    const [a, b] = splitPair(pk);
    let link: [string, string] | null = null;
    if (d.aInB >= DIRECTION_YES && d.bInA < DIRECTION_NO) link = [a, b];
    else if (d.bInA >= DIRECTION_YES && d.aInB < DIRECTION_NO) link = [b, a];
    if (!link) continue;
    const narrower = canonical.get(link[0]);
    const broader = canonical.get(link[1]);
    if (!narrower || !broader || narrower === broader) continue;
    out.set(`${narrower}\u0000${broader}`, [narrower, broader]);
  }
  // A pair of groups linked both ways is a tie, not a hierarchy.
  return [...out.values()].filter(([n, b]) => !out.has(`${b}\u0000${n}`));
}

// ---- clef -----------------------------------------------------------------------

const PAIR_QUESTIONS: Record<string, ClefQuestion> = {
  link: {
    type: "score",
    instructions: "In a glossary for this repository, should these two concepts be one entry?",
    criteria: [
      "Different ideas: each needs its own entry.",
      "Related ideas that need separate entries: one is a part, a kind or an aspect of the other.",
      "One idea: the names are different wordings, abbreviations, or more or less specific phrasings of the same thing.",
    ],
  },
  a_in_b: {
    type: "noul",
    instructions: "Is entity_a a more specific kind, part or aspect of entity_b?",
  },
  b_in_a: {
    type: "noul",
    instructions: "Is entity_b a more specific kind, part or aspect of entity_a?",
  },
};

const SALIENCE_QUESTION: Record<string, ClefQuestion> = {
  glossary: {
    type: "noul",
    instructions:
      "Would a newcomer to this repository look this concept up in its glossary? Yes for ideas specific to how this project works, and for the platforms, services and tools it is built on; no for generic programming terms and details of a single file.",
  },
};

async function repoSummary(d1: D1Database, repoId: string): Promise<string> {
  const row = await db(d1)
    .selectFrom("kg_nodes")
    .select("summary")
    .where("repo_id", "=", repoId)
    .where("id", "=", "repo")
    .executeTakeFirst();
  return (row?.summary ?? "").slice(0, 400);
}

/** First-pass decisions, with review scores overriding theirs. */
async function loadDecisions(d1: D1Database, repoId: string): Promise<Map<string, Decision>> {
  const pairsQuery = db(d1)
    .selectFrom("kg_concept_pairs")
    .select(["a", "b", "score", "a_in_b", "b_in_a"])
    .where("repo_id", "=", repoId)
    .where("version", "=", ALIGNER);
  const reviewsQuery = db(d1)
    .selectFrom("kg_concept_reviews")
    .select(["a", "b", "score"])
    .where("repo_id", "=", repoId);
  const [pairs, reviews] = await batch(d1, [pairsQuery, reviewsQuery]);
  const out = new Map<string, Decision>();
  for (const r of (pairs?.results ?? []) as InferResult<typeof pairsQuery>) {
    out.set(pairKey(r.a, r.b), { score: r.score, aInB: r.a_in_b, bInA: r.b_in_a });
  }
  for (const r of (reviews?.results ?? []) as InferResult<typeof reviewsQuery>) {
    const first = out.get(pairKey(r.a, r.b));
    out.set(pairKey(r.a, r.b), { score: r.score, aInB: first?.aInB ?? 0, bInA: first?.bInA ?? 0 });
  }
  return out;
}

export interface AlignStats {
  concepts: number;
  candidates: number;
  asked: number;
  /** First-pass pair decisions stored once this call is done. */
  decided: number;
  remaining: number;
}

/**
 * Ask clef about candidate pairs that have no stored decision, up to `budget`
 * per call (one Workflow step); call again while `remaining` > 0. Decisions
 * are saved as they arrive, so a retried step resumes where it stopped.
 */
export async function alignPairs(
  env: Env,
  models: AiModels,
  repoId: string,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
  budget = 600,
): Promise<AlignStats> {
  const groups = collectConcepts(files, analyses);
  const names = new Map([...groups].map(([key, g]) => [key, displayName(g.names, key)]));
  const decided = await loadDecisions(env.DB, repoId);
  const knownRows = await db(env.DB)
    .selectFrom("kg_concepts")
    .select("key")
    .where("repo_id", "=", repoId)
    .execute();
  const known = new Set(knownRows.map((r) => r.key));
  const fresh = [...names.keys()].filter((k) => !known.has(k));

  const candidates = new Map<string, [string, string]>();
  // Only concepts new to the repository bring pairs (on its first build, all are).
  for (const [a, b] of tokenCandidates(names, PAIRS_PER_CONCEPT, new Set(fresh)))
    candidates.set(pairKey(a, b), [a, b]);
  // Embeddings find synonyms with no word in common; they are only worth
  // computing when there are new concepts to place.
  if (fresh.length && names.size <= MAX_EMBEDDED) {
    const keys = [...names.keys()];
    const vectors = await embed(
      env,
      keys.map((k) => names.get(k) as string),
    );
    const freshSet = new Set(fresh);
    for (const [a, b] of mutualNeighbours(keys, vectors)) {
      if (freshSet.has(a) || freshSet.has(b)) candidates.set(pairKey(a, b), [a, b]);
    }
  }

  const pending = [...candidates].filter(([pk]) => !decided.has(pk));
  const batch = pending.slice(0, budget);
  const context = await repoSummary(env.DB, repoId);
  const entity = (key: string) => ({
    name: names.get(key),
    mentioned_in: [...(groups.get(key)?.files ?? [])].sort().slice(0, 4),
  });
  let unsaved: Statement[] = [];
  const save = async () => {
    const statements = unsaved;
    unsaved = [];
    await runBatched(env.DB, statements);
  };
  await pool(batch, CLEF_CONCURRENCY, async ([, [x, y]]) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const answers = await decide(
      env,
      { repository: context, entity_a: entity(a), entity_b: entity(b) },
      PAIR_QUESTIONS,
      { model: models.classification },
    );
    const link = answers.link;
    const score = link?.type === "score" ? link.score : 0;
    const p = (name: string) => {
      const answer = answers[name];
      return answer?.type === "noul" ? answer.noul : 0;
    };
    unsaved.push(
      db(env.DB)
        .insertInto("kg_concept_pairs")
        .values({
          repo_id: repoId,
          a,
          b,
          version: ALIGNER,
          score,
          a_in_b: p("a_in_b"),
          b_in_a: p("b_in_a"),
        })
        .onConflict((oc) =>
          oc.columns(["repo_id", "a", "b"]).doUpdateSet((eb) => ({
            version: eb.ref("excluded.version"),
            score: eb.ref("excluded.score"),
            a_in_b: eb.ref("excluded.a_in_b"),
            b_in_a: eb.ref("excluded.b_in_a"),
          })),
        ),
    );
    if (unsaved.length >= 40) await save();
  });
  await save();
  // Count stored first-pass decisions, as the build's baseline does: `decided`
  // above also holds review-only pairs, which would read as pairs asked.
  const stored = await db(env.DB)
    .selectFrom("kg_concept_pairs")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  return {
    concepts: names.size,
    candidates: candidates.size,
    asked: batch.length,
    decided: stored?.n ?? 0,
    remaining: pending.length - batch.length,
  };
}

export interface SettleStats {
  concepts: number;
  groups: number;
  merged: number;
  salient: number;
  trimmed: number;
  links: number;
  askedSalience: number;
}

/**
 * Turn the stored pair decisions into the concept model: groups, canonical
 * keys, narrower/broader links, and which groups are glossary-worthy.
 */
export async function settleConcepts(
  env: Env,
  models: AiModels,
  repoId: string,
  files: SnapshotFile[],
  analyses: Map<string, FileAnalysis>,
): Promise<SettleStats> {
  const d1 = env.DB;
  const groups = collectConcepts(files, analyses);
  const keys = [...groups.keys()];
  const present = new Set(keys);
  const decisions = new Map(
    [...(await loadDecisions(d1, repoId))].filter(([pk]) =>
      splitPair(pk).every((k) => present.has(k)),
    ),
  );
  const rows = await db(d1)
    .selectFrom("kg_concepts")
    .select(["key", "canonical", "recurring", "salient", "salience_hash"])
    .where("repo_id", "=", repoId)
    .execute();
  const previous = new Map(rows.map((r) => [r.key, r]));
  const canonical = cluster(
    keys,
    new Map([...groups].map(([k, g]) => [k, g.files.length])),
    decisions,
    new Map(rows.map((r) => [r.key, r.canonical])),
  );
  const links = partOfLinks(decisions, canonical);

  // Merge each group's spellings and files under its canonical key.
  const merged = new Map<string, ConceptGroup>();
  for (const [key, group] of groups) {
    const lead = canonical.get(key) as string;
    const target = merged.get(lead) ?? { names: new Map<string, number>(), files: [] };
    for (const [name, n] of group.names) target.names.set(name, (target.names.get(name) ?? 0) + n);
    for (const path of group.files) if (!target.files.includes(path)) target.files.push(path);
    merged.set(lead, target);
  }

  // Salience: well-used groups stay; the rest ask clef, again only when the
  // group's names or files change.
  const context = await repoSummary(d1, repoId);
  const verdicts = new Map<string, { recurring: number | null; salient: boolean; hash: string }>();
  let asked = 0;
  await pool([...merged], CLEF_CONCURRENCY, async ([lead, group]) => {
    if (group.files.length >= WELL_USED) {
      verdicts.set(lead, { recurring: null, salient: true, hash: "" });
      return;
    }
    const name = displayName(group.names, lead);
    const aliases = [...group.names.keys()].filter((n) => n !== name).sort();
    const paths = [...group.files].sort();
    const hash = await sha256(
      `${ALIGNER}\u0000${name}\u0000${aliases.join("|")}\u0000${paths.join("|")}`,
    );
    const before = previous.get(lead);
    if (before?.salience_hash === hash && before.recurring !== null) {
      verdicts.set(lead, { recurring: before.recurring, salient: before.recurring >= 0.5, hash });
      return;
    }
    const answers = await decide(
      env,
      {
        repository: context,
        concept: {
          name,
          ...(aliases.length ? { also_called: aliases.slice(0, 6) } : {}),
          mentioned_in: paths.slice(0, 6),
        },
      },
      SALIENCE_QUESTION,
      { model: models.classification },
    );
    const answer = answers.glossary;
    const recurring = answer?.type === "noul" ? answer.noul : 0;
    asked++;
    verdicts.set(lead, { recurring, salient: recurring >= 0.5, hash });
  });

  const statements: Statement[] = [
    db(d1).deleteFrom("kg_concepts").where("repo_id", "=", repoId),
    db(d1).deleteFrom("kg_concept_links").where("repo_id", "=", repoId),
  ];
  for (const key of keys) {
    const lead = canonical.get(key) as string;
    const verdict = key === lead ? verdicts.get(lead) : undefined;
    statements.push(
      db(d1)
        .insertInto("kg_concepts")
        .values({
          repo_id: repoId,
          key,
          canonical: lead,
          recurring: verdict?.recurring ?? null,
          salient: verdict ? (verdict.salient ? 1 : 0) : null,
          salience_hash: verdict?.hash ?? null,
        }),
    );
  }
  for (const [narrower, broader] of links) {
    statements.push(
      db(d1).insertInto("kg_concept_links").values({ repo_id: repoId, narrower, broader }),
    );
  }
  // One transaction when it fits, so readers never see a half-written model.
  if (statements.length <= 1000) await batch(d1, statements);
  else await runBatched(d1, statements);

  const salient = [...verdicts.values()].filter((v) => v.salient).length;
  return {
    concepts: keys.length,
    groups: merged.size,
    merged: keys.length - merged.size,
    salient,
    trimmed: merged.size - salient,
    links: links.length,
    askedSalience: asked,
  };
}

const REVIEW_QUESTION: Record<string, ClefQuestion> = {
  link: {
    type: "score",
    instructions: "In a glossary for this repository, should these two entries be one entry?",
    criteria: [
      "Different ideas: each needs its own entry.",
      "Related ideas that need separate entries: one is a part, a kind or an aspect of the other.",
      "One idea: the definitions describe the same thing, even if worded differently or more or less specifically.",
    ],
  },
};

export interface ReviewStats {
  candidates: number;
  asked: number;
  /** Reviewed pairs judged the same that are still separate groups. */
  newMerges: number;
}

/**
 * Second opinion on related pairs of kept concepts, now that they have
 * definitions. Reads the graph built with the current model and syntheses.
 */
export async function reviewConcepts(
  env: Env,
  models: AiModels,
  repoId: string,
  graph: Pick<BuiltGraph, "nodes" | "conceptFiles">,
): Promise<ReviewStats> {
  const d1 = env.DB;
  const kept = new Map(
    graph.nodes
      .filter((n) => n.kind === "concept" && n.summary)
      .map((n) => [n.id.slice(8), { name: n.name, definition: n.summary }]),
  );
  const rows = await db(d1)
    .selectFrom("kg_concepts")
    .select(["key", "canonical"])
    .where("repo_id", "=", repoId)
    .execute();
  const canonical = new Map(rows.map((r) => [r.key, r.canonical]));
  const first = await db(d1)
    .selectFrom("kg_concept_pairs")
    .select(["a", "b", "score"])
    .where("repo_id", "=", repoId)
    .where("version", "=", ALIGNER)
    .execute();
  // Canonical pairs of kept concepts the first pass placed in between.
  const candidates = new Set<string>();
  for (const { a, b, score } of first) {
    if (score <= DIFFERENT || score >= SAME) continue;
    const ca = canonical.get(a) ?? a;
    const cb = canonical.get(b) ?? b;
    if (ca !== cb && kept.has(ca) && kept.has(cb)) candidates.add(pairKey(ca, cb));
  }
  const stored = await db(d1)
    .selectFrom("kg_concept_reviews")
    .select(["a", "b", "score", "inputs_hash"])
    .where("repo_id", "=", repoId)
    .execute();
  const reviews = new Map(stored.map((r) => [pairKey(r.a, r.b), r]));

  const context = await repoSummary(d1, repoId);
  const entry = (key: string) => ({
    ...kept.get(key),
    mentioned_in: (graph.conceptFiles.get(key) ?? []).slice(0, 4),
  });
  let asked = 0;
  // Each answer is saved as it arrives, so a retried step doesn't ask again.
  await pool([...candidates], CLEF_CONCURRENCY, async (pk) => {
    const [a, b] = splitPair(pk);
    const hash = await sha256(`${ALIGNER}\u0000${JSON.stringify([kept.get(a), kept.get(b)])}`);
    if (reviews.get(pk)?.inputs_hash === hash) return;
    const answers = await decide(
      env,
      { repository: context, entry_a: entry(a), entry_b: entry(b) },
      REVIEW_QUESTION,
      { model: models.classification },
    );
    const link = answers.link;
    const score = link?.type === "score" ? link.score : 0;
    asked++;
    reviews.set(pk, { a, b, score, inputs_hash: hash });
    await db(d1)
      .insertInto("kg_concept_reviews")
      .values({ repo_id: repoId, a, b, score, inputs_hash: hash })
      .onConflict((oc) =>
        oc.columns(["repo_id", "a", "b"]).doUpdateSet((eb) => ({
          score: eb.ref("excluded.score"),
          inputs_hash: eb.ref("excluded.inputs_hash"),
        })),
      )
      .execute();
  });
  const newMerges = [...reviews.values()].filter(
    (r) => r.score >= SAME && (canonical.get(r.a) ?? r.a) !== (canonical.get(r.b) ?? r.b),
  ).length;
  return { candidates: candidates.size, asked, newMerges };
}

/** The stored concept model (empty until a build has aligned concepts). */
export async function loadConceptModel(d1: D1Database, repoId: string): Promise<ConceptModel> {
  const conceptsQuery = db(d1)
    .selectFrom("kg_concepts")
    .select(["key", "canonical", "salient"])
    .where("repo_id", "=", repoId);
  const linksQuery = db(d1)
    .selectFrom("kg_concept_links")
    .select(["narrower", "broader"])
    .where("repo_id", "=", repoId);
  const [concepts, links] = await batch(d1, [conceptsQuery, linksQuery]);
  const model: ConceptModel = {
    canonical: new Map(),
    salient: new Set(),
    trimmed: new Set(),
    partOf: [],
  };
  for (const row of (concepts?.results ?? []) as InferResult<typeof conceptsQuery>) {
    if (row.key !== row.canonical) model.canonical.set(row.key, row.canonical);
    else if (row.salient === 1) model.salient.add(row.key);
    else if (row.salient === 0) model.trimmed.add(row.key);
  }
  for (const row of (links?.results ?? []) as InferResult<typeof linksQuery>) {
    model.partOf.push([row.narrower, row.broader]);
  }
  return model;
}
