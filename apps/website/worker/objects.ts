// Reading git objects through the Artifacts binding, cached.
//
// Commits, trees and blobs are immutable by hash, and so is a page of history
// counted from a given commit, so they are cached forever: first in this
// isolate's memory, then in the Workers Cache API (shared by every isolate in
// the colo). Only branch and tag names are mutable; they resolve through a
// short-lived ref cache that pushes through the proxy invalidate.

import { listRefs, type RepoRefs } from "./artifacts.ts";
import type { Timing } from "./timing.ts";

const MEMORY_BUDGET = 64 * 1024 * 1024;
/** Refs are served from cache this long without asking Artifacts… */
const REFS_FRESH_MS = 5_000;
/** …and up to this long while a background refresh runs. Pushes through the
 * proxy invalidate them immediately either way. */
const REFS_STALE_MS = 10 * 60_000;
const CACHE_ORIGIN = "https://objects.gitmatrix.internal";

const memory = new Map<string, { value: unknown; size: number }>();
let memoryUsed = 0;

function remember(key: string, value: unknown, size: number) {
  if (size > MEMORY_BUDGET / 8) return;
  memory.delete(key);
  memory.set(key, { value, size });
  memoryUsed += size;
  // Map iteration order is insertion order: the oldest entries go first.
  for (const [oldKey, entry] of memory) {
    if (memoryUsed <= MEMORY_BUDGET) break;
    memory.delete(oldKey);
    memoryUsed -= entry.size;
  }
}

function recall<T>(key: string): T | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  // Refresh recency.
  memory.delete(key);
  memory.set(key, entry);
  return entry.value as T;
}

/** Drop this isolate's object memory, as a fresh isolate starts; the Cache API keeps its copies. */
export function forgetObjectMemory() {
  memory.clear();
  memoryUsed = 0;
}

// Only completed data may cross request boundaries. Pending I/O belongs to a reader.
const refsCache = new Map<string, { at: number; refs: RepoRefs }>();
/** Heads already warmed in this isolate. */
const warmed = new Set<string>();
const WARM_MAX_BLOBS = 400;
const WARM_MAX_BYTES = 8 * 1024 * 1024;
const WARM_CONCURRENCY = 16;

/** Forget cached refs for a repo, e.g. after a push went through the proxy. */
export function invalidateRefs(artifactsName: string) {
  refsCache.delete(artifactsName);
}

export interface BlobData {
  size: number;
  bytes: Uint8Array;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isCommitId(ref: string): boolean {
  return HEX40.test(ref);
}

const jsonEncode = (value: unknown) => {
  const body = JSON.stringify(value);
  return { body, size: body.length * 2 };
};
const jsonDecode = <T>(response: Response) => response.json() as Promise<T>;

export class RepoReader {
  #stub: Promise<ArtifactsRepo> | undefined;
  #inflight: Map<string, Promise<unknown>> | undefined;
  #refs: Promise<RepoRefs> | undefined;
  private env: Env;
  private artifactsName: string;
  private remote: string;
  private timing: Timing;
  private waitUntil: (work: Promise<unknown>) => void;
  private sourceRef: string | undefined;

  constructor(
    env: Env,
    artifactsName: string,
    remote: string,
    timing: Timing,
    waitUntil: (work: Promise<unknown>) => void,
    sourceRef?: string,
  ) {
    this.env = env;
    this.artifactsName = artifactsName;
    this.remote = remote;
    this.timing = timing;
    this.waitUntil = waitUntil;
    this.sourceRef = sourceRef;
  }

  /** The binding stub, fetched only when something misses the cache. */
  #repo(): Promise<ArtifactsRepo> {
    this.#stub ??= this.timing.measure("artifacts-get", this.env.ARTIFACTS.get(this.artifactsName));
    return this.#stub;
  }

  /** Release the binding stub, if one was opened. */
  async close() {
    const stub = await this.#stub?.catch(() => null);
    stub?.[Symbol.dispose]();
  }

  /** Memory, then the Cache API; never the remote. Fills memory on a Cache API hit. */
  async #fromCache<T>(
    kind: string,
    id: string,
    encode: (value: T) => { body: BodyInit; size: number },
    decode: (response: Response) => Promise<T>,
  ): Promise<T | undefined> {
    const key = `${this.artifactsName}/${kind}/${id}`;
    const hit = recall<T>(key);
    if (hit !== undefined && hit !== null) {
      this.timing.count(`${kind}-memory`);
      return hit;
    }
    const stored = await caches.default.match(`${CACHE_ORIGIN}/${key}`);
    if (stored?.headers.get("x-gitmatrix-object") !== "present") return undefined;
    this.timing.count(`${kind}-cache`);
    const value = await decode(stored);
    remember(key, value, encode(value).size);
    return value;
  }

  async #cached<T>(
    kind: string,
    id: string,
    load: () => Promise<T>,
    encode: (value: T) => { body: BodyInit; size: number },
    decode: (response: Response) => Promise<T>,
    /** The caller already found neither cache holds it (CORE-400): go straight to the remote. */
    checked = false,
  ): Promise<T> {
    const key = `${this.artifactsName}/${kind}/${id}`;
    const hit = recall<T>(key);
    if (hit !== undefined && hit !== null) {
      this.timing.count(`${kind}-memory`);
      return hit;
    }
    const pending = this.#inflight?.get(key) as Promise<T> | undefined;
    if (pending) {
      this.timing.count(`${kind}-shared`);
      return pending;
    }
    const work = (async () => {
      const stored = checked ? undefined : await this.#fromCache(kind, id, encode, decode);
      if (stored !== undefined) return stored;
      const value = await this.timing.measure(kind, load());
      // Absence is mutable: an object may arrive in a later push or fork.
      if (value === null) return value;
      const { body, size } = encode(value);
      remember(key, value, size);
      await caches.default.put(
        `${CACHE_ORIGIN}/${key}`,
        new Response(body, {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "x-gitmatrix-object": "present",
          },
        }),
      );
      return value;
    })();
    (this.#inflight ??= new Map()).set(key, work);
    try {
      return await work;
    } finally {
      this.#inflight.delete(key);
    }
  }

  /** Seed the cache with a value obtained some other way. */
  #seed(kind: string, id: string, value: unknown) {
    const key = `${this.artifactsName}/${kind}/${id}`;
    if (recall(key) === undefined) remember(key, value, JSON.stringify(value).length * 2);
  }

  #json<T>(kind: string, id: string, load: () => Promise<T>, checked = false): Promise<T> {
    return this.#cached<T>(kind, id, load, jsonEncode, jsonDecode<T>, checked);
  }

  commit(oid: string): Promise<ArtifactsCommitMetadata | null> {
    return this.#json("commit", oid, async () => (await this.#repo()).readCommit(oid));
  }

  tree(oid: string): Promise<ArtifactsTreeEntry[] | null> {
    return this.#json("tree", oid, async () => (await this.#repo()).readTree(oid));
  }

  /** Cache-only reads (CORE-400): memory, then the Cache API; undefined when neither has it. */
  peekCommit(oid: string): Promise<ArtifactsCommitMetadata | undefined> {
    return this.#fromCache<ArtifactsCommitMetadata>("commit", oid, jsonEncode, jsonDecode);
  }

  peekTree(oid: string): Promise<ArtifactsTreeEntry[] | undefined> {
    return this.#fromCache<ArtifactsTreeEntry[]>("tree", oid, jsonEncode, jsonDecode);
  }

  /** This isolate's memory only (CORE-400): free, so callers may ask every reader. */
  recallCommit(oid: string): ArtifactsCommitMetadata | undefined {
    return recall<ArtifactsCommitMetadata>(`${this.artifactsName}/commit/${oid}`) ?? undefined;
  }

  recallTree(oid: string): ArtifactsTreeEntry[] | undefined {
    return recall<ArtifactsTreeEntry[]>(`${this.artifactsName}/tree/${oid}`) ?? undefined;
  }

  /** blobLimited from memory only (CORE-400), with the same oversize answer. */
  peekBlobLimited(oid: string, maxBytes: number): BlobData | undefined {
    const cached = recall<BlobData | null>(`${this.artifactsName}/blob/${oid}`);
    if (!cached) return undefined;
    return cached.size > maxBytes ? { size: cached.size, bytes: new Uint8Array(0) } : cached;
  }

  /** commit() after peekCommit() missed: the remote, then both caches (CORE-400). */
  fetchCommit(oid: string): Promise<ArtifactsCommitMetadata | null> {
    return this.#json("commit", oid, async () => (await this.#repo()).readCommit(oid), true);
  }

  /** tree() after peekTree() missed: the remote, then both caches (CORE-400). */
  fetchTree(oid: string): Promise<ArtifactsTreeEntry[] | null> {
    return this.#json("tree", oid, async () => (await this.#repo()).readTree(oid), true);
  }

  /** A page of first-parent history counted from a commit: immutable too. */
  async log(oid: string, limit: number, offset: number): Promise<ArtifactsCommitMetadata[]> {
    const commits = await this.#json(`log`, `${oid}-${limit}-${offset}`, async () =>
      (await this.#repo()).log({ ref: oid, limit, offset }),
    );
    // History pages carry full commit metadata: opening any of them is free.
    for (const commit of commits) this.#seed("commit", commit.hash, commit);
    return commits;
  }

  blob(oid: string): Promise<BlobData | null> {
    return this.#cached<BlobData | null>(
      "blob",
      oid,
      async () => {
        const blob = await (await this.#repo()).readBlob(oid);
        return blob ? { size: blob.size, bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
      },
      (value) => ({ body: value ? value.bytes : "", size: value?.size ?? 0 }),
      async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { size: bytes.length, bytes };
      },
    );
  }

  /** Inspect size before materializing source bytes for bounded semantic analysis.
   * Oversized blobs return their size with no bytes, never a truncated cache entry. */
  async blobLimited(oid: string, maxBytes: number): Promise<BlobData | null> {
    const cached = this.peekBlobLimited(oid, maxBytes);
    if (cached) return cached;
    const blob = await this.timing.measure("blob-limited", (await this.#repo()).readBlob(oid));
    if (!blob) return null;
    if (blob.size > maxBytes) return { size: blob.size, bytes: new Uint8Array(0) };
    const value = { size: blob.size, bytes: new Uint8Array(await blob.arrayBuffer()) };
    remember(`${this.artifactsName}/blob/${oid}`, value, value.size);
    return value;
  }

  /** A work repository exposes its logical work HEAD, never the fork's inherited HEAD. */
  #sourceRefs(refs: RepoRefs): RepoRefs {
    if (!this.sourceRef) return refs;
    const branch = refs.branches.find((entry) => entry.name === this.sourceRef);
    return {
      headBranch: this.sourceRef.replace(/^refs\/heads\//, ""),
      head: branch?.oid ?? null,
      branches: branch ? [branch] : [],
      tags: [],
    };
  }

  /** Branch and tag tips: cached, and refreshed in the background once stale. */
  async refs(): Promise<RepoRefs> {
    const cached = refsCache.get(this.artifactsName);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < REFS_FRESH_MS) {
      this.timing.count("refs-memory");
      return this.#sourceRefs(cached.refs);
    }
    const refresh = async () => {
      const refs = await listRefs(this.env, this.artifactsName, this.remote, this.timing);
      refsCache.set(this.artifactsName, { at: Date.now(), refs });
      return refs;
    };
    if (cached && age < REFS_STALE_MS) {
      this.timing.count("refs-stale");
      // Mark it fresh now so concurrent requests don't all refresh at once.
      refsCache.set(this.artifactsName, { at: Date.now(), refs: cached.refs });
      this.waitUntil(refresh().catch(() => refsCache.delete(this.artifactsName)));
      return this.#sourceRefs(cached.refs);
    }
    this.#refs ??= this.timing.measure("ls-refs", refresh());
    return this.#sourceRefs(await this.#refs);
  }

  /** A branch, tag or commit id, as a commit id. */
  async resolve(ref: string): Promise<string | null> {
    if (isCommitId(ref)) return ref;
    const refs = await this.refs();
    if (ref === "HEAD") return refs.head;
    const match =
      refs.branches.find((b) => b.shortName === ref || b.name === ref) ??
      refs.tags.find((t) => t.shortName === ref || t.name === ref);
    return match?.oid ?? null;
  }

  /**
   * Split a URL tail like `jun/feature/src/app.ts` into a ref and a path: the
   * longest branch or tag that prefixes it wins, then a commit id, then the
   * first segment.
   */
  async split(spec: string): Promise<{ ref: string; path: string }> {
    const refs = await this.refs();
    return splitRefPath(
      spec,
      [...refs.branches, ...refs.tags].map((r) => r.shortName),
    );
  }

  /**
   * Load everything a visitor is likely to open next at `head`: every tree,
   * the smaller files and the first page of history. Repos here are small, so
   * after this, browsing is served from memory.
   */
  async warm(head: string, logPage: number): Promise<void> {
    const key = `${this.artifactsName}@${head}`;
    if (warmed.has(key)) return;
    warmed.add(key);
    try {
      const commit = await this.commit(head);
      if (!commit) return;
      const history = this.log(head, logPage, 0);
      const blobs: string[] = [];
      let level = [commit.treeHash];
      while (level.length) {
        const trees = await pool(level, WARM_CONCURRENCY, (oid) => this.tree(oid));
        level = [];
        for (const entries of trees) {
          for (const entry of entries ?? []) {
            if (entry.type === "tree") level.push(entry.hash);
            else if (entry.type === "blob" || entry.type === "exec") blobs.push(entry.hash);
          }
        }
      }
      let bytes = 0;
      await pool(blobs.slice(0, WARM_MAX_BLOBS), WARM_CONCURRENCY, async (oid) => {
        if (bytes > WARM_MAX_BYTES) return;
        const blob = await this.blob(oid);
        bytes += blob?.size ?? 0;
      });
      await history;
    } catch (error) {
      warmed.delete(key);
      console.warn("warm-up failed", this.artifactsName, error);
    }
  }

  /** The tree id at `path` inside a commit's root tree, or null. */
  async treeAt(rootTree: string, path: string): Promise<string | null> {
    let current = rootTree;
    for (const segment of path ? path.split("/") : []) {
      const entries = (await this.tree(current)) ?? [];
      const next = entries.find((entry) => entry.name === segment && entry.type === "tree");
      if (!next) return null;
      current = next.hash;
    }
    return current;
  }

  /** The blob entry at `path` inside a commit's root tree, or null. */
  async entryAt(rootTree: string, path: string): Promise<ArtifactsTreeEntry | null> {
    const slash = path.lastIndexOf("/");
    const dir = await this.treeAt(rootTree, slash === -1 ? "" : path.slice(0, slash));
    if (!dir) return null;
    const name = path.slice(slash + 1);
    return ((await this.tree(dir)) ?? []).find((entry) => entry.name === name) ?? null;
  }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Split a URL tail into a ref and a path, given the repo's branch and tag
 * names: the longest name that prefixes it wins, then a commit id, then the
 * first segment.
 */
export function splitRefPath(spec: string, names: string[]): { ref: string; path: string } {
  const trimmed = spec.replace(/^\/+|\/+$/g, "");
  const known = [...names]
    .sort((a, b) => b.length - a.length)
    .find((name) => trimmed === name || trimmed.startsWith(`${name}/`));
  const ref = known ?? trimmed.split("/")[0] ?? "";
  return { ref, path: trimmed.slice(ref.length).replace(/^\/+/, "") };
}
