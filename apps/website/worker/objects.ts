// Reading git objects through the Artifacts binding, cached.
//
// Commits, trees and blobs are immutable by hash, and so is a page of history
// counted from a given commit, so they are cached forever: first in this
// isolate's memory, then in the Workers Cache API (shared by every isolate in
// the colo). Only branch and tag names are mutable; they resolve through a
// short-lived ref cache that pushes through the proxy invalidate.
//
// Refs consistency (CORE-444). Listing them costs ~2 s on a cold isolate, and
// production deploys often enough that isolates usually are cold, so the
// interactive read API (readers given the repository's refs generation, from
// api/repos.ts; never git smart-HTTP, CI triggers, release notes, knowledge or
// landing) also keeps them in the colo's Cache API, keyed by that generation
// (D1: repos.refs_generation, or timeline_work_sources' for a work source):
// - Every ref write the Worker makes or proxies bumps the generation once the
//   write is over, or its outcome unknown, and before its client sees it end
//   (invalidateRefs). A read that loads the row afterwards asks for the new
//   generation, under which no listing begun before the write is ever stored,
//   in memory or in any colo's Cache API: it reads that write. This relies on
//   that read reaching D1's primary, as every read here does (no D1 Sessions
//   or read replicas); a lagging replica could still return the old generation.
// - Within a generation, refs up to REFS_FRESH_MS old (counted from when their
//   listing started) are served as they are, and older ones, up to
//   GENERATION_STALE_MS (a day), once while a background listing replaces
//   them. Since the generation already moves with every write the Worker makes,
//   that age bounds only ref changes no bump follows: ones Artifacts makes on
//   its own, writes made straight to Artifacts rather than through the
//   Worker, and a bump that failed (D1 unreachable or stalled; logged). The first read after such a change that finds the refs older
//   than REFS_FRESH_MS still gets the old ones, and starts the listing whose
//   result every later read gets. The day only decides when a quiet
//   repository's first visit waits for a listing (~2.5 s) instead. Ages count
//   from when the listing started (listedAt): a stale serve re-stamps only the
//   freshness clock.
// - An import gives no such window: until Artifacts finishes it, listing its
//   refs fails, as api/repos.ts relies on (after a failed listing it reads
//   IMPORT_IN_PROGRESS from the binding and reports "importing"; app.ts
//   answers that error with 409 elsewhere), and a
//   failed listing is never kept. So the first listing that is kept is one
//   made after the import finished. The Worker never observes that finish
//   otherwise (POST /repos only starts ARTIFACTS.import; nothing records or
//   polls an import's state), so there is no write to bump the generation at.
// - Other readers keep refs in isolate memory only, as before: a push through
//   this isolate forgets them, and a listing begun before that is not kept.
//   Nothing tells them of a push through another isolate, so their stale
//   window stays REFS_STALE_MS, by listing age, even for an entry a reader
//   with a generation listed and keeps for longer.
// - Tokens are never cached outside isolate memory.

import { listRefs, type RepoRefs } from "./artifacts.ts";
import { UPSTREAM_TIMEOUT_MS, withTimeout } from "./retry.ts";
import type { Timing } from "./timing.ts";

const MEMORY_BUDGET = 64 * 1024 * 1024;
/** Refs are served from cache this long without asking Artifacts… */
const REFS_FRESH_MS = 5_000;
/** …and, to readers without a refs generation, up to this long while a
 * background refresh runs. Pushes through this isolate invalidate them
 * immediately either way. */
const REFS_STALE_MS = 10 * 60_000;
/** Under a refs generation (memory and the Cache API), up to this long: every
 * ref write the Worker makes moves the generation, so age only bounds changes
 * no bump follows (see the consistency model above). */
const GENERATION_STALE_MS = 24 * 60 * 60_000;
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
interface RefsEntry {
  /** Freshness clock: when these refs were listed, or last handed out while a refresh runs. */
  at: number;
  /**
   * When the listing behind these refs started. Handing them out stale moves
   * `at`, never this: the stale bounds count from here, so re-stamping can't
   * stretch them.
   */
  listedAt: number;
  refs: RepoRefs;
  /** The refs generation they were listed under; undefined from a reader without one. */
  generation: number | undefined;
  /** Read from the Cache API (another isolate's listing), not listed here. */
  shared: boolean;
}
const refsCache = new Map<string, RefsEntry>();
/** How often each repository's refs were invalidated in this isolate. */
const invalidations = new Map<string, number>();
const invalidationsOf = (artifactsName: string) => invalidations.get(artifactsName) ?? 0;
const refsKey = (artifactsName: string, generation: number) =>
  `${CACHE_ORIGIN}/${artifactsName}/refs/v2/${generation}`;
/** The Cache API, where this runtime has one. */
const cacheApi = () => (typeof caches === "undefined" ? undefined : caches.default);
/** Heads already warmed in this isolate. */
const warmed = new Set<string>();
const WARM_MAX_BLOBS = 400;
const WARM_MAX_BYTES = 8 * 1024 * 1024;
const WARM_CONCURRENCY = 16;

/**
 * Forget this isolate's refs for the repo, and keep any listing already under
 * way here from being remembered: for a reader that wants refs listed from now
 * on, where no ref write happened (one that did calls invalidateRefs).
 */
export function forgetRefs(artifactsName: string): void {
  refsCache.delete(artifactsName);
  invalidations.set(artifactsName, invalidationsOf(artifactsName) + 1);
}

/**
 * After a ref write (or one whose outcome is unknown) is over: forget this
 * isolate's refs for the repo, and bump the refs generation of whichever row
 * owns that Artifacts repository, so no read that loads it later is served refs
 * listed before. Await it before the writer's client sees the write end. Never
 * rejects, and gives up on D1 after UPSTREAM_TIMEOUT_MS so a stalled D1 can't
 * hold a push's answer: a failed bump is logged, leaving the age bounds above.
 */
export async function invalidateRefs(d1: D1Database, artifactsName: string): Promise<void> {
  forgetRefs(artifactsName);
  try {
    await withTimeout(
      d1.batch(
        ["repos", "timeline_work_sources"].map((table) =>
          d1
            .prepare(
              `UPDATE ${table} SET refs_generation = refs_generation + 1 WHERE artifacts_name = ?`,
            )
            .bind(artifactsName),
        ),
      ),
      UPSTREAM_TIMEOUT_MS,
    );
  } catch (error) {
    // Provider names stay out of logs (they are public-output-sensitive, see source-auth-e2e).
    console.error("refs generation bump failed", error);
  }
}

/** Drop this isolate's refs memory, as a fresh isolate starts (tests). */
export function forgetRefsMemory() {
  refsCache.clear();
  invalidations.clear();
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

export interface RepoReaderOptions {
  /**
   * Also keep refs in the Cache API, across isolates and deploys, under the
   * repository's refs generation as loaded for this request (CORE-444). Only
   * for interactive reads that tolerate the bounds described at the top of this
   * file; anything that acts on refs lists them itself.
   */
  sharedRefs?: { generation: number };
}

export class RepoReader {
  #stub: Promise<ArtifactsRepo> | undefined;
  #inflight: Map<string, Promise<unknown>> | undefined;
  #refs: Promise<RepoRefs> | undefined;
  #refsInvalidations: number | undefined;
  private env: Env;
  private artifactsName: string;
  private remote: string;
  private timing: Timing;
  private waitUntil: (work: Promise<unknown>) => void;
  private sourceRef: string | undefined;
  /** The refs generation to share refs under, when this reader opted in. */
  private generation: number | undefined;

  constructor(
    env: Env,
    artifactsName: string,
    remote: string,
    timing: Timing,
    waitUntil: (work: Promise<unknown>) => void,
    sourceRef?: string,
    options: RepoReaderOptions = {},
  ) {
    this.env = env;
    this.artifactsName = artifactsName;
    this.remote = remote;
    this.timing = timing;
    this.waitUntil = waitUntil;
    this.sourceRef = sourceRef;
    this.generation = options.sharedRefs?.generation;
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

  /**
   * Data derived from immutable objects and keyed by them (CORE-451: what a
   * commit changed at a path; a directory's last changes from a commit), so as
   * permanent as they are: memory, then the Cache API; undefined when neither
   * has it.
   */
  peekDerived<T>(kind: string, id: string): Promise<T | undefined> {
    return this.#fromCache<T>(kind, id, jsonEncode, jsonDecode);
  }

  /** peekDerived from this isolate's memory only: free, so a walk may ask for every commit. */
  recallDerived<T>(kind: string, id: string): T | undefined {
    const hit = recall<T>(`${this.artifactsName}/${kind}/${id}`) ?? undefined;
    if (hit !== undefined) this.timing.count(`${kind}-memory`);
    return hit;
  }

  /** Keep derived data: in memory now, in the Cache API in the background. */
  storeDerived(kind: string, id: string, value: unknown): void {
    const key = `${this.artifactsName}/${kind}/${id}`;
    const { body, size } = jsonEncode(value);
    remember(key, value, size);
    const cache = cacheApi();
    if (!cache) return;
    this.waitUntil(
      cache
        .put(
          `${CACHE_ORIGIN}/${key}`,
          new Response(body, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "x-gitmatrix-object": "present",
            },
          }),
        )
        .catch((error: unknown) => console.warn("derived cache put failed", key, error)),
    );
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
  refs(): Promise<RepoRefs> {
    // One lookup per reader (split() then resolve() must not ask twice), until
    // an invalidation in this isolate says its refs may have moved.
    const invalidations = invalidationsOf(this.artifactsName);
    if (!this.#refs || this.#refsInvalidations !== invalidations) {
      this.#refs = this.#lookupRefs();
      this.#refsInvalidations = invalidations;
    }
    return this.#refs.then((refs) => this.#sourceRefs(refs));
  }

  /** Memory, then (for shared readers) the Cache API, then a listing; physical refs. */
  async #lookupRefs(): Promise<RepoRefs> {
    const remembered = this.#memoryRefs();
    if (remembered) return remembered;
    if (this.generation !== undefined) {
      const stored = await this.#cachedRefs(this.generation);
      if (stored) return stored;
    }
    return this.timing.measure("ls-refs", this.#listRefs());
  }

  /** This isolate's refs, if this reader may have them; past REFS_FRESH_MS they start a refresh. */
  #memoryRefs(): RepoRefs | undefined {
    const cached = refsCache.get(this.artifactsName);
    if (!cached) return undefined;
    // A shared reader takes only its own generation; others never take another isolate's refs.
    if (this.generation === undefined ? cached.shared : cached.generation !== this.generation)
      return undefined;
    // Past its bound by listing age, an entry is never served, however recently
    // a stale serve re-stamped it: a reader without a generation never gets
    // refs listed more than REFS_STALE_MS ago, even ones a generation reader
    // listed here and keeps for a day.
    const bound = this.generation === undefined ? REFS_STALE_MS : GENERATION_STALE_MS;
    if (Date.now() - cached.listedAt >= bound) return undefined;
    const age = Date.now() - cached.at;
    if (age < REFS_FRESH_MS) {
      this.timing.count("refs-memory");
      return cached.refs;
    }
    this.timing.count("refs-stale");
    this.#refreshInBackground(cached);
    return cached.refs;
  }

  /** The colo's copy for `generation`, if younger than GENERATION_STALE_MS; fills memory. */
  async #cachedRefs(generation: number): Promise<RepoRefs | undefined> {
    const cache = cacheApi();
    if (!cache) return undefined;
    let stored: { startedAt: number; refs: RepoRefs } | undefined;
    try {
      const response = await cache.match(refsKey(this.artifactsName, generation));
      stored = response ? await response.json() : undefined;
    } catch {
      return undefined;
    }
    if (typeof stored?.startedAt !== "number" || !stored.refs) return undefined;
    const age = Date.now() - stored.startedAt;
    if (age >= GENERATION_STALE_MS) return undefined;
    // Another request here may have listed or read them meanwhile.
    const remembered = this.#memoryRefs();
    if (remembered) return remembered;
    const entry: RefsEntry = {
      at: stored.startedAt,
      listedAt: stored.startedAt,
      refs: stored.refs,
      generation,
      shared: true,
    };
    refsCache.set(this.artifactsName, entry);
    if (age < REFS_FRESH_MS) this.timing.count("refs-cache");
    else {
      this.timing.count("refs-cache-stale");
      this.#refreshInBackground(entry);
    }
    return stored.refs;
  }

  /** Serve `entry` while a listing replaces it. */
  #refreshInBackground(entry: RefsEntry) {
    // Mark it fresh now so concurrent requests don't all refresh at once.
    const marked = { ...entry, at: Date.now() };
    refsCache.set(this.artifactsName, marked);
    this.waitUntil(
      this.#listRefs().catch(() => {
        if (refsCache.get(this.artifactsName) === marked) refsCache.delete(this.artifactsName);
      }),
    );
  }

  /**
   * List refs from Artifacts and keep them, under the generation this reader
   * loaded, unless this isolate invalidated them meanwhile.
   */
  async #listRefs(): Promise<RepoRefs> {
    const name = this.artifactsName;
    const generation = this.generation;
    const invalidations = invalidationsOf(name);
    const startedAt = Date.now();
    const refs = await listRefs(this.env, name, this.remote, this.timing);
    if (invalidationsOf(name) !== invalidations) return refs;
    refsCache.set(name, { at: Date.now(), listedAt: startedAt, refs, generation, shared: false });
    const cache = cacheApi();
    if (cache && generation !== undefined) {
      const response = new Response(JSON.stringify({ startedAt, refs }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${GENERATION_STALE_MS / 1000}`,
        },
      });
      this.waitUntil(
        cache
          .put(refsKey(name, generation), response)
          .catch((error: unknown) => console.warn("refs cache put failed", name, error)),
      );
    }
    return refs;
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
      console.warn("warm-up failed", error);
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
