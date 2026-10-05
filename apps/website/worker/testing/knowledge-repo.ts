// Test helpers for whole Knowledge builds (CORE-286): a small repository with
// a real git shape (blobs, trees, commits), deterministic stand-ins for every
// model the pipeline calls, and in-memory Vectorize and AI Search. A model's
// answer depends only on what it is asked, so two databases built through
// different paths can be compared row for row.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MODELS } from "../knowledge/models.ts";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const hash32 = (text: string) => Number.parseInt(sha1(text).slice(0, 8), 16);

// ---- the repository ---------------------------------------------------------------

/** Concept names with shared words, so they pair, merge and nest. */
const VOCABULARY = [
  "Invoice",
  "Invoice Ledger",
  "Billing Engine",
  "Billing",
  "Payment Gateway",
  "Payments",
  "Access Token",
  "Session Token",
  "Session Store",
  "Auth Session",
  "Page Router",
  "Router",
  "Request Handler",
  "API Handler",
  "Rate Limit",
  "Rate Limiter",
  "Cache Layer",
  "Response Cache",
  "Ledger",
  "Refund Flow",
  "Refunds",
  "Webhook Delivery",
  "Webhooks",
  "Retry Policy",
  // A family sharing one word: each has more close candidates than it keeps.
  "Refresh Token",
  "Token Store",
  "Token Cache",
  "Token Signing",
];

// src/web and src/webhooks share a prefix, as sibling directories often do.
const DIRS = ["src/billing", "src/auth", "src/web/pages", "src/web/api", "src/webhooks", "lib"];

export interface KnowledgeFixture {
  /** path -> file content. */
  files: Map<string, string>;
  /** Bumped per edit, so contents (and so blobs and summaries) change. */
  edits: number;
}

function content(path: string, concepts: string[], imports: string[], version: number): string {
  const name = path.split("/").pop()!.replace(/\.ts$/, "").replace(/\W/g, "_");
  return [
    `// concepts: ${concepts.join("; ")}`,
    ...imports.map((spec, i) => `import { dep${i} } from "${spec}";`),
    `export function ${name}() {`,
    `  return ${version};`,
    `}`,
    ``,
  ].join("\n");
}

/** Concepts a fixture file declares. */
export function conceptsOf(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("// concepts:"));
  return line
    ? line
        .slice("// concepts:".length)
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];
}

const importsOf = (text: string) =>
  [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);

const relative = (from: string, to: string) => {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? "../".repeat(up) : "./"}${b.slice(i).join("/")}`;
};

/** `count` files over a few directories, each with 2-3 concepts and an import or two. */
export function knowledgeFixture(count = 36): KnowledgeFixture {
  const files = new Map<string, string>();
  const paths = Array.from(
    { length: count },
    (_, i) => `${DIRS[i % DIRS.length]}/f${Math.floor(i / DIRS.length)}.ts`,
  );
  paths.forEach((path, i) => {
    const concepts = [0, 1, 2]
      .slice(0, 2 + (i % 2))
      .map((k) => VOCABULARY[(i * 5 + k * 7) % VOCABULARY.length]!);
    // Some concepts only one file mentions: clef judges whether they are glossary-worthy.
    if (i % 4 === 0)
      concepts.push(`Detail ${["Alpha", "Beta", "Gamma", "Delta", "Omega"][i % 5]} ${i}`);
    const imports = [paths[(i + 1) % count]!, ...(i % 3 === 0 ? [paths[(i + 7) % count]!] : [])]
      .filter((p) => p !== path)
      .map((p) => relative(path, p));
    files.set(path, content(path, concepts, imports, 1));
  });
  files.set("README.md", "# Ledger app\n\nBills customers and takes payments.\n");
  return { files, edits: 0 };
}

/** Change a file's code only: its concepts and imports stay (its summary is rewritten). */
export function editCode(repo: KnowledgeFixture, path: string) {
  const text = repo.files.get(path)!;
  repo.edits++;
  repo.files.set(path, content(path, conceptsOf(text), importsOf(text), 100 + repo.edits));
}

/** Set a file's concepts (adding the file when new). */
export function setConcepts(repo: KnowledgeFixture, path: string, concepts: string[]) {
  const text = repo.files.get(path);
  repo.edits++;
  repo.files.set(path, content(path, concepts, text ? importsOf(text) : [], 100 + repo.edits));
}

export function moveFile(repo: KnowledgeFixture, from: string, to: string) {
  const text = repo.files.get(from)!;
  repo.files.delete(from);
  repo.files.set(to, content(to, conceptsOf(text), importsOf(text), 100 + ++repo.edits));
}

// ---- git ------------------------------------------------------------------------------

/** Git objects for fixture commits, readable as a RepoReader. */
export class FakeGit {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, ArtifactsTreeEntry[]>();
  commits = new Map<string, ArtifactsCommitMetadata>();
  head: string | null = null;
  /** Trees read, for asserting that an update reads only what changed. */
  treeReads = 0;

  /** Commit the fixture's files on top of the current head; returns the commit id. */
  commit(repo: KnowledgeFixture): string {
    const root = this.#tree([...repo.files].map(([path, text]) => [path.split("/"), text]));
    const parents = this.head ? [this.head] : [];
    const at = this.commits.size + 1;
    const hash = sha1(`commit\0${root}\0${parents.join(",")}\0${at}`);
    this.commits.set(hash, {
      hash,
      treeHash: root,
      message: `commit ${at}`,
      author: { name: "a", email: "a@example.com" },
      committer: { name: "a", email: "a@example.com" },
      parents,
      authoredAt: at,
      committedAt: at,
    } as ArtifactsCommitMetadata);
    this.head = hash;
    return hash;
  }

  #tree(entries: [string[], string][]): string {
    const children = new Map<string, [string[], string][]>();
    const out: ArtifactsTreeEntry[] = [];
    for (const [parts, text] of entries) {
      if (parts.length === 1) {
        const bytes = new TextEncoder().encode(text);
        const oid = sha1(`blob\0${text}`);
        this.blobs.set(oid, bytes);
        out.push({ name: parts[0]!, hash: oid, mode: "100644", type: "blob" });
      } else {
        const list = children.get(parts[0]!) ?? [];
        list.push([parts.slice(1), text]);
        children.set(parts[0]!, list);
      }
    }
    for (const [name, list] of children)
      out.push({ name, hash: this.#tree(list), mode: "40000", type: "tree" });
    out.sort((a, b) => a.name.localeCompare(b.name));
    const oid = sha1(`tree\0${JSON.stringify(out)}`);
    this.trees.set(oid, out);
    return oid;
  }

  reader() {
    return {
      refs: async () => ({ head: this.head, branches: [], tags: [] }),
      commit: async (oid: string) => this.commits.get(oid) ?? null,
      tree: async (oid: string) => {
        this.treeReads++;
        return this.trees.get(oid) ?? null;
      },
      blob: async (oid: string) => {
        const bytes = this.blobs.get(oid);
        return bytes ? { size: bytes.byteLength, bytes } : null;
      },
      close: async () => {},
    };
  }
}

// ---- models -----------------------------------------------------------------------------

/** Model calls, by what they were for. */
export type CallCounts = Record<string, number>;

const score = (seed: string) => {
  const h = hash32(seed) % 100;
  return h < 30 ? 1.8 : h < 65 ? 1 : 0.2;
};
const probability = (seed: string) => (hash32(seed) % 100) / 100;

function chat(text: string, usage = 50) {
  return {
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { total_tokens: usage * 2, prompt_tokens: usage, completion_tokens: usage },
  };
}

/** Deterministic stand-ins for clef, the chat models and the embedding model. */
export function fakeAi(calls: CallCounts) {
  const count = (kind: string) => {
    calls[kind] = (calls[kind] ?? 0) + 1;
    calls.total = (calls.total ?? 0) + 1;
  };
  return {
    async run(model: string, inputs: Record<string, unknown>) {
      if (model === MODELS.embed) {
        count("embed");
        const texts = inputs.text as string[];
        return {
          data: texts.map((t) =>
            Array.from({ length: 8 }, (_, i) => hash32(`${t}\0${i}`) / 2 ** 32),
          ),
        };
      }
      if (inputs.questions) {
        const questions = inputs.questions as Record<string, { type: string; criteria?: unknown }>;
        const state = JSON.stringify(inputs.state);
        const kind = Object.keys(questions).join(",");
        count(
          kind === "link,a_in_b,b_in_a"
            ? "pair"
            : kind === "link"
              ? "review"
              : kind === "glossary"
                ? "salience"
                : kind === "stale"
                  ? "stale"
                  : kind === "meaningful"
                    ? "cosmetic"
                    : "role",
        );
        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries(questions)) {
          const seed = `${name}\0${state}\0${JSON.stringify(q)}`;
          if (q.type === "score")
            answers[name] = { type: "score", score: score(seed), probabilities: [], confidence: 1 };
          else if (q.type === "choice")
            answers[name] = { type: "choice", choice: "source", probabilities: {}, confidence: 1 };
          // Every edit means something (no card is kept as cosmetic).
          else if (name === "meaningful") answers[name] = { type: "noul", noul: 1 };
          else answers[name] = { type: "noul", noul: probability(seed) };
        }
        return { answers };
      }
      const messages = inputs.messages as { role: string; content: string }[];
      const system = messages[0]!.content;
      const user = messages[1]!.content;
      if (system.startsWith("You build a knowledge graph")) {
        count("card");
        const path = /^File: (.*)$/m.exec(user)![1]!;
        return chat(
          JSON.stringify({
            // A summary is reworded on every edit, as a real model's is.
            summary: `${path} handles its part (${sha1(user).slice(0, 8)}).`,
            responsibilities: [`Serve ${path}`],
            symbols: [],
            concepts: conceptsOf(user.slice(user.indexOf("// concepts:"))),
          }),
        );
      }
      if (system.startsWith("You document one component")) {
        count("component");
        const input = JSON.parse(user) as { dir: string; files: { path: string }[] };
        return chat(
          JSON.stringify({
            title: `Component ${input.dir}`,
            summary: `Component ${input.dir}, version ${sha1(user).slice(0, 8)}.`,
            responsibilities: ["Things"],
            key_files: input.files.slice(0, 2).map((f) => ({ path: f.path, why: "Central." })),
          }),
        );
      }
      if (system.startsWith("You write a glossary")) {
        count("definitions");
        const input = JSON.parse(user) as { concepts: { name: string }[] };
        return chat(
          JSON.stringify({
            definitions: input.concepts.map((c) => ({
              name: c.name,
              definition: `${c.name} means ${sha1(JSON.stringify(c)).slice(0, 8)}.`,
            })),
          }),
        );
      }
      if (system.startsWith("You write the overview")) {
        count("overview");
        return chat(
          JSON.stringify({
            title: "Ledger",
            summary: `Overview ${sha1(user).slice(0, 8)}.`,
            tech_stack: ["TypeScript"],
          }),
        );
      }
      if (system.startsWith("You write one page")) {
        count("page");
        return chat(`## About\n\nPage ${sha1(user).slice(0, 8)}.`);
      }
      throw new Error(`Unexpected model call: ${system.slice(0, 40)}`);
    },
  };
}

// ---- indexes ----------------------------------------------------------------------------

/** In-memory Vectorize: id -> values and metadata. */
export function fakeVectors() {
  const store = new Map<string, { values: number[]; metadata: unknown }>();
  return {
    store,
    async upsert(records: { id: string; values: number[]; metadata: unknown }[]) {
      for (const r of records) store.set(r.id, { values: r.values, metadata: r.metadata });
      return { mutationId: "m" };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    },
  };
}

/** In-memory AI Search items: name -> body and metadata. */
export function fakeSearch() {
  const items = new Map<string, { name: string; body: string; metadata: unknown }>();
  let next = 0;
  return {
    items,
    get: () => ({
      items: {
        async upload(name: string, body: string, options: { metadata: unknown }) {
          const id = `item-${++next}`;
          items.set(id, { name, body, metadata: options.metadata });
          return { id };
        },
        async delete(id: string) {
          items.delete(id);
        },
      },
    }),
  };
}

// ---- what a build produced ------------------------------------------------------------

/** Everything Knowledge holds for a repository, comparable across databases. */
export function knowledgeState(
  sqlite: DatabaseSync,
  repoId: string,
  indexes: { vectors: ReturnType<typeof fakeVectors>; search: ReturnType<typeof fakeSearch> },
) {
  const rows = (sql: string) => sqlite.prepare(sql).all(repoId);
  return {
    state: sqlite
      .prepare("SELECT indexed_commit, pipeline FROM kg_state WHERE repo_id = ?")
      .get(repoId),
    files: rows(
      "SELECT path, blob_oid, mode FROM kg_files WHERE repo_id = ? AND snapshot = 'current' ORDER BY path",
    ),
    nodes: rows(
      "SELECT id, kind, name, path, summary, data, content_hash, changed_in FROM kg_nodes WHERE repo_id = ? ORDER BY id",
    ),
    edges: rows(
      "SELECT src, dst, kind, weight FROM kg_edges WHERE repo_id = ? ORDER BY src, dst, kind",
    ),
    concepts: rows(
      "SELECT key, canonical, recurring, salient, salience_hash FROM kg_concepts WHERE repo_id = ? ORDER BY key",
    ),
    links: rows(
      "SELECT narrower, broader FROM kg_concept_links WHERE repo_id = ? ORDER BY narrower, broader",
    ),
    pairs: rows(
      "SELECT a, b, version, score, a_in_b, b_in_a FROM kg_concept_pairs WHERE repo_id = ? ORDER BY a, b",
    ),
    reviews: rows(
      "SELECT a, b, score, inputs_hash FROM kg_concept_reviews WHERE repo_id = ? ORDER BY a, b",
    ),
    pages: rows(
      "SELECT slug, title, section, position, node_id, body, diagram, sources, inputs_hash, generated_in, model FROM wiki_pages WHERE repo_id = ? ORDER BY slug",
    ),
    searchKeys: rows("SELECT key, version FROM kg_search_items WHERE repo_id = ? ORDER BY key"),
    vectors: [...indexes.vectors.store].sort(([a], [b]) => a.localeCompare(b)),
    search: [...indexes.search.items.values()]
      .map((i) => ({ name: i.name, body: i.body, metadata: i.metadata }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
