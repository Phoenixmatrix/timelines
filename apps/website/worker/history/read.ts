import type { CommitSummary, HistoryPage } from "../../shared/api.ts";
import type { RepoReader } from "../objects.ts";

type Reader = Pick<
  RepoReader,
  "log" | "commit" | "peekTree" | "fetchTree" | "peekDerived" | "recallDerived" | "storeDerived"
>;
type Commit = ArtifactsCommitMetadata;
type Tree = ArtifactsTreeEntry[];
type Trees = ReturnType<typeof treeLoader>;

export const HISTORY_PAGE_SIZE = 100;
/**
 * Commits one cover request walks itself (CORE-451) before answering with
 * `next` set. A count, not a time, so an answer it ends is exact for the range
 * it covers and can be kept. Where a head's answer stops still varies: it
 * takes the range of the newest kept answer it finds below the head (looked up
 * in the Cache API for the first BASE_PEEK commits, in this isolate's memory
 * only deeper), so a head found with a base reaches further than one without.
 * Every kept answer is exact for its range, a complete answer is the same
 * however it was reached, and the UI shows a plain count only once complete.
 */
export const COVER_BUDGET = 1000;
/** Not a budget but a safety stop: a walk still going after this long answers what it has, unkept. */
export const COVER_SAFETY_MS = 5000;
/** The longest range one cover answer spans, its own walk and a stored answer's together. */
export const COVER_MAX_RANGE = 5000;
/** Artifacts' largest log page. */
const LOG_LIMIT = 1000;
/** Commits whose changes are worked out together; only their trees are held. */
export const CHUNK = 200;
/** How many of a walk's first commits to look up a stored answer for in the Cache API. */
const BASE_PEEK = 32;
const TREE_CONCURRENCY = 8;
/** Kinds of derived data (RepoReader.peekDerived), versioned in their ids: they live for a year. */
export const CHANGES = "historychg";
export const LAST_CHANGES = "lastchange";
export const COVER_PAGES = "historypage";
// `p=` keeps "." and ".." from reading as URL path segments in Cache API keys.
export const derivedId = (commit: string, path: string) =>
  `v2/${commit}/p=${encodeURIComponent(path)}`;
const pageId = (head: string, cursor: string, path: string) =>
  `v2/${head}/${cursor}/p=${encodeURIComponent(path)}`;

/** What a commit changed at a path against its first parent: independent of any head. */
export interface ChangeSet {
  changed: boolean;
  /** Every direct child whose type, mode or object differs; absent when only `changed` was asked. */
  names?: string[];
}
/** A scanned commit that changed the path or a child; `at` counts commits from the walk's start. */
export interface HistoryStep {
  at: number;
  commit: CommitSummary;
  changed: boolean;
  names: string[];
}
/**
 * A cover answer as kept (CORE-451): every change in a first-parent range from
 * a commit, with all changed names (not only the head's), and `next` past it.
 * Complete when it holds every entry's latest change and the path's own, or
 * reaches the root; otherwise its budget or the range cap ended it. Either way
 * exact for its range, so a later head may take it as its base and walk on
 * from its `next` for whatever is still unresolved.
 */
export interface LastChanges {
  scanned: number;
  next: string | null;
  steps: HistoryStep[];
}
export interface HistoryOptions {
  /**
   * With entries: walk on until every entry at the head has its latest change
   * and stop at the commit that completes them (`next` is the one after),
   * rather than at a fixed page.
   */
  cover?: boolean;
  /** Commits the walk may scan itself (COVER_BUDGET). */
  budget?: number;
  safetyMs?: number;
  now?: () => number;
  /** Tests: how many trees the walk holds after each chunk. */
  trace?: (treesHeld: number) => void;
}
/**
 * `stopped`: the answer depends on timing, or on objects missing now (a parent
 * commit or a tree): exact for its range, but neither kept nor to be cached.
 */
export type HistoryRead = Omit<HistoryPage, "ref"> & { stopped?: true };

export function commitSummary(commit: Commit): CommitSummary {
  return {
    oid: commit.hash,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authoredAt: commit.authoredAt,
    parents: commit.parents,
  };
}

interface Snapshot {
  identity: string | null;
  /** The tree at the path, when it is one. */
  folder: string | null;
  /** A tree on the way is missing. */
  broken?: true;
}
const EMPTY: Snapshot = { identity: null, folder: null };
const OVERTIME = Symbol("overtime");
const incomplete = (what: string) => new Error(`History is incomplete: ${what} is unavailable.`);

/**
 * A bounded first-parent walk. Compare object type and mode too: chmod is a change.
 *
 * A plain request answers one page of HISTORY_PAGE_SIZE commits. A cover
 * request walks on, up to COVER_BUDGET commits, until every entry and the path
 * itself have their latest change. Each commit's changes are kept by commit
 * (CHANGES); a cover answer from the head by head (LAST_CHANGES), from a
 * cursor by request (COVER_PAGES). A later head walks back only to the newest
 * commit with a kept answer and takes that answer's range. Wherever a walk
 * stops, its counts are exact for the range scanned, and `next` continues it.
 */
export async function readHistory(
  reader: Reader,
  head: string,
  path: string,
  entries: boolean,
  cursor = head,
  options: HistoryOptions = {},
): Promise<HistoryRead> {
  const tip = await reader.commit(head);
  if (!tip) throw new Error("History head is unavailable.");
  const cover = entries && !!options.cover;
  const fromHead = cursor === head;
  const parent = tip.parents[0];
  const own: [kind: string, id: string] = fromHead
    ? [LAST_CHANGES, derivedId(head, path)]
    : [COVER_PAGES, pageId(head, cursor, path)];
  // Kept answers for this request and the head's parent, looked up while the head's tree loads.
  const stored = cover
    ? Promise.all([
        reader.peekDerived<LastChanges>(...own),
        fromHead && parent
          ? reader.peekDerived<LastChanges>(LAST_CHANGES, derivedId(parent, path))
          : undefined,
        // A failed lookup is a miss: the walk works the answer out.
      ]).catch(() => [undefined, undefined] as const)
    : undefined;
  let trees = treeLoader(reader);
  const childrenAt = async (root: string) => {
    const [snapshot] = (await locate(trees, [root], path)) as [Snapshot];
    const tree = snapshot.folder ? (await trees.load([snapshot.folder])).get(snapshot.folder) : [];
    if (snapshot.broken || tree === null) throw incomplete("a tree");
    return childIdentities(tree);
  };
  const headChildren = entries ? await childrenAt(tip.treeHash) : new Map<string, string>();
  const wanted = new Set(headChildren.keys());
  const budget = options.budget ?? COVER_BUDGET;
  const safetyMs = options.safetyMs ?? COVER_SAFETY_MS;
  const now = options.now ?? Date.now;
  const started = now();

  // What a cover walk still looks for. From a cursor, the entries the client
  // lacks: one that differs there from the head changed above it.
  const unresolved = new Set<string>();
  let needSelf = false;
  /** Commits whose kept answer was already looked for. */
  const peeked = new Set<string>();
  /** A kept answer for a commit `at` commits below the start. */
  let base: { at: number; value: LastChanges } | undefined;
  if (stored) {
    const [kept, previous] = await stored;
    if (kept) return page(head, path, wanted, kept.steps, kept.scanned, kept.next);
    if (fromHead) {
      for (const name of wanted) unresolved.add(name);
      needSelf = true;
      if (parent) peeked.add(parent);
      if (previous) base = { at: 1, value: previous };
    } else {
      const start = await reader.commit(cursor);
      if (!start) throw new Error("History cursor is unavailable.");
      const there = await childrenAt(start.treeHash);
      for (const name of wanted)
        if (there.get(name) === headChildren.get(name)) unresolved.add(name);
    }
  }

  const steps: HistoryStep[] = [];
  /** Change sets worked out here, kept once the walk is over: their Cache API
   * writes would otherwise queue ahead of the walk's own reads. */
  const worked: [string, ChangeSet][] = [];
  let scanned = 0;
  let next: string | null = cursor;
  let done = false;
  let stopped = false;
  let walked = 0;
  /** Take one scanned commit's changes; true once a cover walk has all it looks for. */
  const consume = (at: number, commit: CommitSummary, changed: boolean, names: string[]) => {
    scanned = at + 1;
    next = commit.parents[0] ?? null;
    if (changed || names.length) steps.push({ at, commit, changed, names });
    if (!cover) return false;
    for (const name of names) unresolved.delete(name);
    if (changed) needSelf = false;
    // From a cursor ("Load older history"), at least a page, as before.
    return !unresolved.size && !needSelf && (fromHead || scanned >= HISTORY_PAGE_SIZE);
  };
  /** Between waves: past the safety stop, give up the chunk in hand (never the first). */
  const checkTime = () => {
    if (cover && walked > 0 && now() - started >= safetyMs) throw OVERTIME;
  };

  // The commits from `next` on, in walk order, as a log read them.
  let pending: Commit[] = base ? [tip] : [];
  let logged = false;
  while (!done && next) {
    if (cover && walked > 0 && (walked >= budget || scanned >= COVER_MAX_RANGE)) break;
    if (pending[0]?.hash !== next) {
      const limit =
        cover && logged ? Math.min(LOG_LIMIT, budget - walked + 1) : HISTORY_PAGE_SIZE + 1;
      const log = await reader.log(next, limit, 0);
      logged = true;
      if (!log.length) throw new Error("History cursor is unavailable.");
      pending = log;
    }
    let take = cover
      ? Math.min(pending.length, CHUNK, budget - walked, COVER_MAX_RANGE - scanned)
      : Math.min(pending.length, HISTORY_PAGE_SIZE);
    if (base) take = Math.min(take, base.at - scanned);
    else if (cover && fromHead) {
      // The newest commit below the head with a kept answer: the first few
      // asked of the Cache API too, the rest of this isolate's memory only.
      const found = await Promise.all(
        pending.slice(0, take).map(async (commit, index) => {
          const at = scanned + index;
          if (at === 0 || peeked.has(commit.hash)) return undefined;
          peeked.add(commit.hash);
          const id = derivedId(commit.hash, path);
          return at < BASE_PEEK
            ? reader.peekDerived<LastChanges>(LAST_CHANGES, id)
            : reader.recallDerived<LastChanges>(LAST_CHANGES, id);
        }),
      );
      const index = found.findIndex(Boolean);
      if (index !== -1) {
        base = { at: scanned + index, value: found[index]! };
        take = index;
      }
    }
    const chunk = pending.slice(0, take);
    const following = pending;
    const parents = Promise.all(
      chunk.map(async (commit, index) => {
        const id = commit.parents[0];
        if (!id) return null;
        const after = following[index + 1];
        // Undefined: missing, as in pruned history.
        return (after?.hash === id ? after : await reader.commit(id)) ?? undefined;
      }),
    );
    let sets: (ChangeSet | undefined)[];
    try {
      sets = await changeSets(reader, trees, path, entries, chunk, parents, worked, checkTime);
    } catch (error) {
      if (error !== OVERTIME) throw error;
      stopped = true;
      break;
    }
    // A commit that can't be compared (its parent or a tree is missing) ends
    // a cover walk above it, unkept: a page loads, the request for the next
    // fails, as paging always did. Plain pages fail outright.
    const resolved = await parents;
    const broken = sets.findIndex((set) => set === undefined);
    if (broken !== -1 && (!cover || scanned + broken === 0))
      throw incomplete(resolved[broken] === undefined ? "a parent commit" : "a tree");
    walked += chunk.length;
    pending = pending.slice(take);
    for (const [index, commit] of chunk.slice(0, broken === -1 ? take : broken).entries()) {
      const set = sets[index]!;
      if (consume(scanned, commitSummary(commit), set.changed, set.names ?? [])) {
        done = true;
        break;
      }
    }
    if (!done && broken !== -1) {
      stopped = true;
      break;
    }
    // Hold on only to the trees the next commit's comparison starts from.
    options.trace?.(trees.size());
    const boundary = resolved.at(-1)?.treeHash;
    trees = trees.keep(boundary ? [boundary] : [], path);
    if (!cover) break;
    if (!done && base?.at === scanned) {
      // Whatever is still unresolved is the same here as at the base, so its
      // latest change is in the base's range, or past it, from its `next`.
      const offset = base.at;
      let capped = false;
      for (const step of base.value.steps) {
        if (offset + step.at >= COVER_MAX_RANGE) {
          capped = true;
          break;
        }
        if (consume(offset + step.at, step.commit, step.changed, step.names)) {
          done = true;
          break;
        }
      }
      if (!done && !capped) {
        scanned = offset + base.value.scanned;
        next = base.value.next;
      }
      base = undefined;
      if (capped) break;
    }
  }
  for (const [id, set] of worked) reader.storeDerived(CHANGES, id, set);
  if (cover && !stopped)
    reader.storeDerived(own[0], own[1], { scanned, next, steps } satisfies LastChanges);
  return page(head, path, wanted, steps, scanned, next, stopped);
}

function page(
  head: string,
  path: string,
  wanted: Set<string>,
  steps: HistoryStep[],
  scanned: number,
  next: string | null,
  stopped = false,
): HistoryRead {
  const result: HistoryRead = {
    head,
    path,
    scanned,
    next,
    commits: [],
    entries: Object.create(null),
  };
  if (stopped) result.stopped = true;
  for (const step of steps) {
    if (step.changed) result.commits.push(step.commit);
    for (const name of step.names) {
      if (!wanted.has(name)) continue;
      const entryPath = path ? `${path}/${name}` : name;
      const previous = result.entries[entryPath];
      result.entries[entryPath] = {
        latest: previous?.latest ?? step.commit,
        count: (previous?.count ?? 0) + 1,
      };
    }
  }
  return result;
}

/**
 * Each commit's changes against its first parent: kept ones first, the rest
 * from their trees, read a level at a time for all of them together.
 * Undefined where the parent or a tree is missing.
 */
async function changeSets(
  reader: Reader,
  trees: Trees,
  path: string,
  entries: boolean,
  commits: Commit[],
  parentsOf: Promise<(Commit | null | undefined)[]>,
  worked: [string, ChangeSet][],
  checkTime: () => void,
): Promise<(ChangeSet | undefined)[]> {
  const ids = commits.map((commit) => derivedId(commit.hash, path));
  const [parents, stored] = await Promise.all([
    parentsOf,
    Promise.all(ids.map((id) => reader.peekDerived<ChangeSet>(CHANGES, id))),
  ]);
  const sets = stored.map((set, index) =>
    set && (!entries || set.names) && parents[index] !== undefined ? set : undefined,
  );
  // Not where the parent is missing: there is nothing to compare with.
  const missing = sets.flatMap((set, index) =>
    set || parents[index] === undefined ? [] : [index],
  );
  if (!missing.length) return sets;
  const roots = missing.flatMap((index) => {
    const parent = parents[index];
    return parent ? [commits[index]!.treeHash, parent.treeHash] : [commits[index]!.treeHash];
  });
  const located = await locate(trees, roots, path, checkTime);
  const snapshots = new Map(roots.map((root, index) => [root, located[index]!]));
  const pairs = missing.map((index) => {
    const parent = parents[index];
    return {
      index,
      after: snapshots.get(commits[index]!.treeHash)!,
      before: parent ? snapshots.get(parent.treeHash)! : EMPTY,
    };
  });
  // Children only where the path itself differs: the same tree has the same children.
  const differs = ({ after, before }: (typeof pairs)[number]) =>
    after.identity !== before.identity && (after.folder !== null || before.folder !== null);
  const folders = entries
    ? pairs.filter(differs).flatMap(({ after, before }) => [after.folder, before.folder])
    : [];
  checkTime();
  const children = await trees.load(folders.filter((folder) => folder !== null));
  for (const pair of pairs) {
    const { index, after, before } = pair;
    if (after.broken || before.broken) continue;
    const set: ChangeSet = { changed: !path || after.identity !== before.identity };
    if (!differs(pair)) set.names = [];
    else if (entries) {
      const now = after.folder ? children.get(after.folder) : [];
      const was = before.folder ? children.get(before.folder) : [];
      if (now === null || was === null) continue;
      const nowIds = childIdentities(now);
      const wasIds = childIdentities(was);
      const names = [...nowIds.keys()].filter((name) => nowIds.get(name) !== wasIds.get(name));
      for (const name of wasIds.keys()) if (!nowIds.has(name)) names.push(name);
      set.names = names;
    }
    sets[index] = set;
    worked.push([ids[index]!, set]);
  }
  return sets;
}

/** The entry at `path` in each root tree, read a level at a time for all of them. */
async function locate(
  trees: Trees,
  roots: string[],
  path: string,
  checkTime = () => {},
): Promise<Snapshot[]> {
  if (!path) return roots.map((root) => ({ identity: root, folder: root }));
  const segments = path.split("/");
  const result: Snapshot[] = roots.map(() => EMPTY);
  const broken = new Set<number>();
  let current: (string | null)[] = roots;
  for (const [depth, segment] of segments.entries()) {
    checkTime();
    const loaded = await trees.load(current.filter((tree) => tree !== null));
    const last = depth === segments.length - 1;
    current = current.map((tree, index) => {
      const entries = tree ? loaded.get(tree) : [];
      if (entries === null) broken.add(index);
      const entry = entries?.find((e) => e.name === segment) ?? null;
      if (last)
        result[index] = broken.has(index)
          ? { ...EMPTY, broken: true }
          : { identity: identity(entry), folder: entry?.type === "tree" ? entry.hash : null };
      return entry?.type === "tree" ? entry.hash : null;
    });
  }
  return result;
}

/**
 * Trees for one chunk of a walk: each read once, the ones in either cache
 * looked up together, and only the rest fetched, a few at a time. Null: missing.
 */
function treeLoader(reader: Reader, carried: Map<string, Tree | null> = new Map()) {
  const known = new Map<string, Promise<Tree | null>>();
  const resolved = new Map(carried);
  for (const [oid, tree] of carried) known.set(oid, Promise.resolve(tree));
  return {
    size: () => known.size,
    async load(oids: string[]): Promise<Map<string, Tree | null>> {
      const missing = [...new Set(oids)].filter((oid) => !known.has(oid));
      if (missing.length) {
        const work = (async () => {
          const hits = await Promise.all(missing.map((oid) => reader.peekTree(oid)));
          const misses = missing.filter((_, index) => hits[index] === undefined);
          const fetched = await pool(misses, TREE_CONCURRENCY, (oid) => reader.fetchTree(oid));
          const found = new Map(missing.map((oid, index) => [oid, hits[index] ?? null]));
          for (const [index, oid] of misses.entries()) found.set(oid, fetched[index] ?? null);
          for (const [oid, tree] of found) resolved.set(oid, tree);
          return found;
        })();
        for (const oid of missing)
          known.set(
            oid,
            work.then((found) => found.get(oid) ?? null),
          );
      }
      const values = await Promise.all(oids.map((oid) => known.get(oid)!));
      return new Map(oids.map((oid, index) => [oid, values[index]!]));
    },
    /** A loader for the next chunk holding only these roots' trees along `path`. */
    keep(roots: string[], path: string) {
      const carry = new Map<string, Tree | null>();
      for (const root of roots) {
        let oid: string | undefined = root;
        for (const segment of [...(path ? path.split("/") : []), null]) {
          if (oid === undefined || !resolved.has(oid)) break;
          const tree: Tree | null = resolved.get(oid)!;
          carry.set(oid, tree);
          oid = tree?.find((e) => e.name === segment && e.type === "tree")?.hash;
        }
      }
      return treeLoader(reader, carry);
    },
  };
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

function childIdentities(tree: Tree | null | undefined): Map<string, string> {
  return new Map((tree ?? []).map((entry) => [entry.name, identity(entry)!]));
}

function identity(entry: ArtifactsTreeEntry | null): string | null {
  return entry ? `${entry.type}:${entry.mode}:${entry.hash}` : null;
}
