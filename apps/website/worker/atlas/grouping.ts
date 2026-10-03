// Deterministic, versioned capability grouping (CORE-163).
//
// Groups source files into capabilities from non-path evidence the knowledge
// graph already holds: direct imports (either direction) and shared canonical
// concepts. Directory components are inputs to presentation only; a directory
// never establishes membership on its own.
//
// 1. Candidates. Each file keeps at most MAX_NEIGHBORS candidate neighbors,
//    ranked by evidence weight with stable id tie-breaks. Pairs come only from
//    inverted indexes (import edges, concept postings), never from comparing
//    all pairs. A concept's weight is its rarity (log N/df), so a concept every
//    file mentions is no evidence; common concepts link through a bounded ring.
// 2. Groups. Two levels of deterministic Louvain modularity optimization over
//    the candidate graph: level one gives areas, level two groups areas into
//    capabilities. Visiting order and ties are fixed by id, so identical
//    inputs give identical groups.
// 3. Membership. Every file gets exactly one primary placement, with the
//    strongest links that justify it. A file with no supporting evidence, or
//    alone in its area, goes to the unclassified structural group rather than
//    an invented capability. A file strongly tied to another capability gets a
//    cross-cutting reference, which never counts twice in rollups.
//
// This pass is pure and makes no model calls. Naming beyond the evidence
// (CORE-164) and identity across snapshots (CORE-165) build on its output.

/** Bump whenever the algorithm or its inputs change: snapshots record it. */
export const GROUPING_VERSION = 1;
export const MAX_NEIGHBORS = 32;
const IMPORT_WEIGHT = 3;
/** Cross-cutting: support for another capability relative to the primary one. */
const CROSS_RATIO = 0.5;
const MAX_CROSS = 3;
const MAX_RATIONALE = 4;
const LOUVAIN_PASSES = 12;

export interface GroupingInput {
  /** Analyzed source files (file ids), the units being grouped. */
  files: string[];
  /** Directed import edges between files. */
  imports: { src: string; dst: string }[];
  /** file id -> canonical concept ids it mentions. */
  mentions: { file: string; concept: string }[];
  /** concept id -> display name, for evidence and interim names. */
  conceptNames: Map<string, string>;
}

export interface Evidence {
  kind: "imports" | "imported-by" | "concept";
  /** The file or concept the link is to. */
  with: string;
  weight: number;
}

export interface Membership {
  file: string;
  /** Area id, or null when the file is unclassified. */
  area: string | null;
  capability: string | null;
  /** The strongest links that put the file there. */
  rationale: Evidence[];
  crossCutting: { capability: string; support: number }[];
  /** Why a file is unclassified. */
  unclassified?: "no-evidence" | "isolated";
}

export interface Area {
  id: string;
  capability: string;
  /** The member with the most support inside the area (ties by id). */
  anchor: string;
  files: string[];
  /** Concepts most shared inside the area, by weight. */
  concepts: { id: string; name: string; weight: number }[];
}

export interface Capability {
  id: string;
  anchor: string;
  areas: string[];
  files: number;
  concepts: { id: string; name: string; weight: number }[];
  /** Interim name from the strongest shared concepts; CORE-164 refines it. */
  name: string;
}

export interface Grouping {
  version: number;
  capabilities: Capability[];
  areas: Area[];
  members: Membership[];
  stats: {
    files: number;
    candidatePairs: number;
    /** The longest candidate list any file kept (at most MAX_NEIGHBORS). */
    maxCandidates: number;
    unclassified: number;
  };
}

// ---- small deterministic helpers ---------------------------------------------

/** FNV-1a, enough for short stable ids (not security). */
function hash36(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- 1. candidates -----------------------------------------------------------

interface Graph {
  /** Neighbor maps by file index: neighbor index -> weight. Symmetric. */
  adj: Map<number, number>[];
  /** Each file's concepts (sorted) and rarity weights, for rationale. */
  conceptsOf: string[][];
  idf: Map<string, number>;
  /** Directed import pairs as `i * n + j`. */
  importPairs: Set<number>;
  maxCandidates: number;
}

/** Concepts with at most this many files link every pair of them. */
const DENSE_POSTING = 48;
/** Beyond that, each file links to its next RING files in a stable hash order. */
const RING = 8;

function candidates(input: GroupingInput, files: string[], index: Map<string, number>): Graph {
  const n = files.length;
  // Pair keys are numbers: min * n + max (n stays far below 2^26).
  const score = new Map<number, number>();
  const add = (i: number, j: number, weight: number) => {
    if (i === j || weight <= 0) return;
    const key = i < j ? i * n + j : j * n + i;
    score.set(key, (score.get(key) ?? 0) + weight);
  };

  const importPairs = new Set<number>();
  for (const { src, dst } of input.imports) {
    const i = index.get(src);
    const j = index.get(dst);
    if (i === undefined || j === undefined || i === j) continue;
    if (importPairs.has(i * n + j)) continue;
    importPairs.add(i * n + j);
    add(i, j, IMPORT_WEIGHT);
  }

  const postings = new Map<string, Set<number>>();
  const conceptsOf: string[][] = Array.from({ length: n }, () => []);
  for (const { file, concept } of input.mentions) {
    const i = index.get(file);
    if (i === undefined) continue;
    const set = postings.get(concept) ?? new Set<number>();
    if (!set.has(i)) conceptsOf[i]!.push(concept);
    set.add(i);
    postings.set(concept, set);
  }
  const idf = new Map<string, number>();
  for (const concept of [...postings.keys()].sort(byId)) {
    const members = [...postings.get(concept)!].sort((a, b) => a - b);
    const weight = Math.log(n / members.length);
    idf.set(concept, weight);
    // A concept nearly every file mentions is no evidence.
    if (weight <= 0.05) continue;
    if (members.length <= DENSE_POSTING) {
      for (let a = 0; a < members.length; a++)
        for (let b = a + 1; b < members.length; b++) add(members[a]!, members[b]!, weight);
    } else {
      // Bounded and free of path bias: a ring in hash order keeps the
      // concept's files connected with about RING links each.
      const ring = members
        .map((i) => [i, hash36(`${concept}\u0000${files[i]}`)] as const)
        .sort((a, b) => byId(a[1], b[1]) || a[0] - b[0])
        .map(([i]) => i);
      for (let a = 0; a < ring.length; a++)
        for (let k = 1; k <= RING && k < ring.length; k++)
          add(ring[a]!, ring[(a + k) % ring.length]!, weight);
    }
  }
  for (const list of conceptsOf) list.sort(byId);

  // Keep each file's strongest MAX_NEIGHBORS, then symmetrize.
  const ranked: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [key, weight] of score) {
    const i = Math.floor(key / n);
    const j = key % n;
    ranked[i]!.push([j, weight]);
    ranked[j]!.push([i, weight]);
  }
  score.clear();
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  let maxCandidates = 0;
  for (let i = 0; i < n; i++) {
    const top = ranked[i]!.sort((a, b) => b[1] - a[1] || byId(files[a[0]]!, files[b[0]]!)).slice(
      0,
      MAX_NEIGHBORS,
    );
    ranked[i] = [];
    maxCandidates = Math.max(maxCandidates, top.length);
    for (const [j, weight] of top) {
      adj[i]!.set(j, weight);
      adj[j]!.set(i, weight);
    }
  }
  return { adj, conceptsOf, idf, importPairs, maxCandidates };
}

// ---- 2. deterministic Louvain -------------------------------------------------

/**
 * One Louvain level: returns a community label per node. Nodes are visited in
 * index order (which follows sorted ids), and ties go to the smallest label.
 */
function louvain(adj: Map<number, number>[]): number[] {
  const n = adj.length;
  const degree = adj.map((m) => {
    let d = 0;
    for (const w of m.values()) d += w;
    return d;
  });
  const total = degree.reduce((a, b) => a + b, 0);
  const label = Array.from({ length: n }, (_, i) => i);
  if (total === 0) return label;
  const communityDegree = [...degree];
  for (let pass = 0; pass < LOUVAIN_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (adj[i]!.size === 0) continue;
      const own = label[i]!;
      const links = new Map<number, number>();
      for (const [j, w] of adj[i]!)
        if (j !== i) links.set(label[j]!, (links.get(label[j]!) ?? 0) + w);
      communityDegree[own]! -= degree[i]!;
      let best = own;
      let bestGain = (links.get(own) ?? 0) - (communityDegree[own]! * degree[i]!) / total;
      for (const [c, w] of [...links].sort((a, b) => a[0] - b[0])) {
        const gain = w - (communityDegree[c]! * degree[i]!) / total;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      communityDegree[best]! += degree[i]!;
      if (best !== own) {
        label[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return label;
}

/** The graph of communities: summed weights between labels, self-loops dropped. */
function aggregate(adj: Map<number, number>[], label: number[], count: number) {
  const out: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  for (let i = 0; i < adj.length; i++)
    for (const [j, w] of adj[i]!) {
      const a = label[i]!;
      const b = label[j]!;
      if (a !== b) out[a]!.set(b, (out[a]!.get(b) ?? 0) + w);
    }
  return out;
}

/** Relabel to 0..k-1 in order of first appearance (deterministic). */
function compact(label: number[]): { label: number[]; count: number } {
  const map = new Map<number, number>();
  const out = label.map((l) => {
    if (!map.has(l)) map.set(l, map.size);
    return map.get(l)!;
  });
  return { label: out, count: map.size };
}

// ---- 3. membership -----------------------------------------------------------

export function groupCapabilities(input: GroupingInput): Grouping {
  const files = [...new Set(input.files)].sort(byId);
  const index = new Map(files.map((f, i) => [f, i]));
  const { adj, conceptsOf, idf, importPairs, maxCandidates } = candidates(input, files, index);
  const n = files.length;
  const pairs = adj.reduce((n, m) => n + m.size, 0) / 2;

  const level1 = compact(louvain(adj));
  const areaGraph = aggregate(adj, level1.label, level1.count);
  const level2 = compact(louvain(areaGraph));

  // Members per area; singletons and evidence-free files are unclassified.
  const areaMembers = new Map<number, number[]>();
  files.forEach((_, i) => {
    if (adj[i]!.size === 0) return;
    const a = level1.label[i]!;
    const list = areaMembers.get(a) ?? [];
    list.push(i);
    areaMembers.set(a, list);
  });

  const conceptWeight = (members: number[]) => {
    const memberSet = new Set(members.map((i) => files[i]!));
    const weights = new Map<string, number>();
    for (const { file, concept } of input.mentions)
      if (memberSet.has(file)) weights.set(concept, (weights.get(concept) ?? 0) + 1);
    return [...weights]
      .filter(([, w]) => w >= 2 || members.length === 1)
      .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
      .slice(0, 5)
      .map(([id, weight]) => ({ id, name: input.conceptNames.get(id) ?? id, weight }));
  };
  const supportWithin = (i: number, members: Set<number>) => {
    let s = 0;
    for (const [j, w] of adj[i]!) if (members.has(j)) s += w;
    return s;
  };
  const anchorOf = (members: number[]) => {
    const set = new Set(members);
    return members
      .map((i) => [i, supportWithin(i, set)] as const)
      .sort((a, b) => b[1] - a[1] || byId(files[a[0]]!, files[b[0]]!))[0]![0];
  };

  const areas: Area[] = [];
  const areaOfFile = new Map<number, Area>();
  const capabilityOfArea = new Map<number, number>();
  for (const [a, members] of [...areaMembers].sort((x, y) => x[0] - y[0])) {
    if (members.length < 2) continue;
    const anchor = files[anchorOf(members)]!;
    const area: Area = {
      id: `area:${hash36(anchor)}`,
      capability: "",
      anchor,
      files: members.map((i) => files[i]!),
      concepts: conceptWeight(members),
    };
    areas.push(area);
    for (const i of members) areaOfFile.set(i, area);
    capabilityOfArea.set(a, level2.label[a]!);
  }

  // Capabilities: areas grouped by level two, anchored on their strongest file.
  const capAreas = new Map<number, Area[]>();
  for (const area of areas) {
    const a = level1.label[index.get(area.anchor)!]!;
    const c = capabilityOfArea.get(a)!;
    const list = capAreas.get(c) ?? [];
    list.push(area);
    capAreas.set(c, list);
  }
  const capabilities: Capability[] = [];
  const capabilityOfFile = new Map<number, Capability>();
  for (const [, list] of [...capAreas].sort((x, y) => x[0] - y[0])) {
    const members = list.flatMap((area) => area.files.map((f) => index.get(f)!));
    const anchor = files[anchorOf(members)]!;
    const concepts = conceptWeight(members);
    const capability: Capability = {
      id: `cap:${hash36(anchor)}`,
      anchor,
      areas: list.map((area) => area.id).sort(byId),
      files: members.length,
      concepts,
      name:
        concepts
          .slice(0, 2)
          .map((c) => c.name)
          .join(" & ") || (anchor.split("/").pop() ?? anchor).replace(/^file:/, ""),
    };
    for (const area of list) area.capability = capability.id;
    capabilities.push(capability);
    for (const i of members) capabilityOfFile.set(i, capability);
  }
  capabilities.sort((a, b) => b.files - a.files || byId(a.id, b.id));
  areas.sort((a, b) => byId(a.id, b.id));

  const members: Membership[] = files.map((file, i) => {
    const area = areaOfFile.get(i);
    const capability = capabilityOfFile.get(i);
    if (!area || !capability)
      return {
        file,
        area: null,
        capability: null,
        rationale: [],
        crossCutting: [],
        unclassified: adj[i]!.size === 0 ? "no-evidence" : "isolated",
      };
    const inArea = new Set(area.files.map((f) => index.get(f)!));
    const rationale: Evidence[] = [];
    const neighbors = [...adj[i]!]
      .filter(([j]) => inArea.has(j))
      .sort((a, b) => b[1] - a[1] || byId(files[a[0]]!, files[b[0]]!));
    for (const [j] of neighbors) {
      if (rationale.length >= MAX_RATIONALE) break;
      const other = files[j]!;
      if (importPairs.has(i * n + j))
        rationale.push({ kind: "imports", with: other, weight: IMPORT_WEIGHT });
      if (importPairs.has(j * n + i))
        rationale.push({ kind: "imported-by", with: other, weight: IMPORT_WEIGHT });
      const theirs = new Set(conceptsOf[j]);
      for (const concept of conceptsOf[i]!)
        if (theirs.has(concept) && (idf.get(concept) ?? 0) > 0.05)
          rationale.push({
            kind: "concept",
            with: concept,
            weight: Math.round((idf.get(concept) ?? 0) * 1000) / 1000,
          });
    }
    // Support for other capabilities, as references (never a second placement).
    const support = new Map<string, number>();
    for (const [j, w] of adj[i]!) {
      const other = capabilityOfFile.get(j);
      if (other) support.set(other.id, (support.get(other.id) ?? 0) + w);
    }
    const own = support.get(capability.id) ?? 0;
    const crossCutting = [...support]
      .filter(([id, s]) => id !== capability.id && s >= CROSS_RATIO * own && s > 0)
      .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
      .slice(0, MAX_CROSS)
      .map(([id, s]) => ({ capability: id, support: Math.round(s * 1000) / 1000 }));
    return {
      file,
      area: area.id,
      capability: capability.id,
      rationale: rationale.slice(0, MAX_RATIONALE),
      crossCutting,
    };
  });

  return {
    version: GROUPING_VERSION,
    capabilities,
    areas,
    members,
    stats: {
      files: files.length,
      candidatePairs: pairs,
      maxCandidates,
      unclassified: members.filter((m) => !m.capability).length,
    },
  };
}
