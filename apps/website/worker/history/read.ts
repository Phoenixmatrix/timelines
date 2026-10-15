import type { CommitSummary, HistoryPage } from "../../shared/api.ts";
import type { RepoReader } from "../objects.ts";

type Reader = Pick<
  RepoReader,
  "log" | "commit" | "peekTree" | "fetchTree" | "peekDerived" | "recallDerived" | "storeDerived"
>;
type Commit = ArtifactsCommitMetadata;
type Trees = ReturnType<typeof treeLoader>;

export const HISTORY_PAGE_SIZE = 100;
/** What one cover request may walk itself (CORE-451) before answering with `next` set. */
export const COVER_BUDGET = { commits: 1000, ms: 1500 };
/** The longest range one cover answer spans, its own walk and a stored answer's together. */
export const COVER_MAX_RANGE = 5000;
/** Artifacts' largest log page: after the first page, a cover walk reads this many at once. */
const LOG_LIMIT = 1000;
/** Commits whose changes are worked out together, between budget checks. */
const CHUNK = 200;
/** How many of a walk's first commits to look up a stored answer for in the Cache API. */
const BASE_PEEK = 32;
const TREE_CONCURRENCY = 8;
/** Kinds of derived data (RepoReader.peekDerived), versioned in their ids: they live for a year. */
export const CHANGES = "historychg";
export const LAST_CHANGES = "lastchange";
export const derivedId = (commit: string, path: string) =>
  `v1/${commit}/${encodeURIComponent(path)}`;

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
 * A directory's last changes from a commit (CORE-451): the steps of the
 * shortest first-parent range from it holding every child's latest change and
 * the directory's own, and `next` past that range (null at the root). Exact,
 * so kept by commit.
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
  budget?: { commits: number; ms: number };
  now?: () => number;
}
/** `cut`: a cover walk stopped by its budget rather than by finding every change. */
export type HistoryRead = Omit<HistoryPage, "ref"> & { cut?: true };

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
}
const EMPTY: Snapshot = { identity: null, folder: null };

/**
 * A bounded first-parent walk. Compare object type and mode too: chmod is a change.
 *
 * A plain request answers one page of HISTORY_PAGE_SIZE commits. A cover
 * request walks on, within COVER_BUDGET, until every entry and the path itself
 * have their latest change. Each commit's changes are kept by commit
 * (CHANGES), and a complete cover answer from the head by head (LAST_CHANGES):
 * a later head walks back only to the newest commit that has one and takes
 * the rest from it. Wherever a walk stops, its counts are exact for the range
 * scanned, and `next` continues it.
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
  // Stored answers for the head and its parent, looked up while the head's tree loads.
  const stored =
    cover && fromHead
      ? Promise.all([
          reader.peekDerived<LastChanges>(LAST_CHANGES, derivedId(head, path)),
          parent
            ? reader.peekDerived<LastChanges>(LAST_CHANGES, derivedId(parent, path))
            : undefined,
          // A failed lookup is a miss: the walk works the answer out.
        ]).catch(() => [undefined, undefined] as const)
      : undefined;
  const trees = treeLoader(reader);
  const childrenAt = async (root: string) => {
    const [{ folder }] = (await locate(trees, [root], path)) as [Snapshot];
    return childIdentities(folder ? (await trees.load([folder])).get(folder) : null);
  };
  const headChildren = entries ? await childrenAt(tip.treeHash) : new Map<string, string>();
  const wanted = new Set(headChildren.keys());
  const budget = options.budget ?? COVER_BUDGET;
  const now = options.now ?? Date.now;
  const started = now();

  // What a cover walk still looks for. From a cursor, the entries the client
  // lacks: one that differs there from the head changed above it.
  const unresolved = new Set<string>();
  let needSelf = false;
  /** Commits whose stored answer was already looked for. */
  const peeked = new Set<string>();
  /** A stored answer for a commit `at` commits below the start. */
  let base: { at: number; value: LastChanges } | undefined;
  if (stored) {
    for (const name of wanted) unresolved.add(name);
    needSelf = true;
    const [own, previous] = await stored;
    if (own) return page(head, path, wanted, own.steps, own.scanned, own.next);
    if (parent) peeked.add(parent);
    if (previous) base = { at: 1, value: previous };
  } else if (cover) {
    const start = await reader.commit(cursor);
    if (!start) throw new Error("History cursor is unavailable.");
    const there = await childrenAt(start.treeHash);
    for (const name of wanted) if (there.get(name) === headChildren.get(name)) unresolved.add(name);
  }

  const steps: HistoryStep[] = [];
  /** Change sets worked out here, stored once the walk is over: their Cache API
   * writes would otherwise queue ahead of the walk's own reads. */
  const worked: [string, ChangeSet][] = [];
  let scanned = 0;
  let next: string | null = cursor;
  let done = false;
  let cut = false;
  let walked = 0;
  /** Take one scanned commit's changes; true once a cover walk has all it looks for. */
  const consume = (at: number, commit: CommitSummary, changed: boolean, names: string[]) => {
    scanned = at + 1;
    next = commit.parents[0] ?? null;
    if (changed || names.length) steps.push({ at, commit, changed, names });
    if (!cover) return false;
    for (const name of names) unresolved.delete(name);
    if (changed) needSelf = false;
    return !unresolved.size && !needSelf;
  };

  // The commits from `next` on, in walk order, as a log read them.
  let pending: Commit[] = base ? [tip] : [];
  let logged = false;
  while (!done && next) {
    if (
      cover &&
      walked > 0 &&
      (walked >= budget.commits || now() - started >= budget.ms || scanned >= COVER_MAX_RANGE)
    ) {
      cut = true;
      break;
    }
    if (pending[0]?.hash !== next) {
      const log = await reader.log(next, logged ? LOG_LIMIT : HISTORY_PAGE_SIZE + 1, 0);
      logged = true;
      if (!log.length) throw new Error("History cursor is unavailable.");
      pending = log;
    }
    let take = cover
      ? Math.min(pending.length, CHUNK, budget.commits - walked, COVER_MAX_RANGE - scanned)
      : Math.min(pending.length, HISTORY_PAGE_SIZE);
    if (base) take = Math.min(take, base.at - scanned);
    else if (cover && fromHead) {
      // The newest commit below the head with a stored answer: the first few
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
      if (index > 0) {
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
        const parent = after?.hash === id ? after : await reader.commit(id);
        if (!parent) throw new Error("History is incomplete: a parent commit is unavailable.");
        return parent;
      }),
    );
    const sets = await changeSets(reader, trees, path, entries, chunk, parents, worked);
    walked += chunk.length;
    pending = pending.slice(take);
    for (const [index, commit] of chunk.entries()) {
      const set = sets[index]!;
      if (consume(scanned, commitSummary(commit), set.changed, set.names ?? [])) {
        done = true;
        break;
      }
    }
    if (!cover) break;
    if (!done && base?.at === scanned) {
      // Whatever is still unresolved is the same here as at the base, so its
      // latest change is in the base's range.
      const offset = base.at;
      for (const step of base.value.steps) {
        if (offset + step.at >= COVER_MAX_RANGE) {
          cut = true;
          break;
        }
        if (consume(offset + step.at, step.commit, step.changed, step.names)) {
          done = true;
          break;
        }
      }
      if (!done && !cut) {
        scanned = offset + base.value.scanned;
        next = base.value.next;
      }
      base = undefined;
      if (cut) break;
    }
  }
  for (const [id, set] of worked) reader.storeDerived(CHANGES, id, set);
  if (cover && fromHead && !cut) {
    // Complete: every change found, or the walk reached the root.
    reader.storeDerived(LAST_CHANGES, derivedId(head, path), {
      scanned,
      next,
      steps,
    } satisfies LastChanges);
  }
  return page(head, path, wanted, steps, scanned, next, cut);
}

function page(
  head: string,
  path: string,
  wanted: Set<string>,
  steps: HistoryStep[],
  scanned: number,
  next: string | null,
  cut = false,
): HistoryRead {
  const result: HistoryRead = {
    head,
    path,
    scanned,
    next,
    commits: [],
    entries: Object.create(null),
  };
  if (cut) result.cut = true;
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
 * Each commit's changes against its first parent: stored ones first, the rest
 * from their trees, read a level at a time for all of them together.
 */
async function changeSets(
  reader: Reader,
  trees: Trees,
  path: string,
  entries: boolean,
  commits: Commit[],
  parentsOf: Promise<(Commit | null)[]>,
  worked: [string, ChangeSet][],
): Promise<ChangeSet[]> {
  const ids = commits.map((commit) => derivedId(commit.hash, path));
  const [parents, stored] = await Promise.all([
    parentsOf,
    Promise.all(ids.map((id) => reader.peekDerived<ChangeSet>(CHANGES, id))),
  ]);
  const sets = stored.map((set) => (set && (!entries || set.names) ? set : undefined));
  const missing = sets.flatMap((set, index) => (set ? [] : [index]));
  if (!missing.length) return sets as ChangeSet[];
  const roots = missing.flatMap((index) => {
    const parent = parents[index];
    return parent ? [commits[index]!.treeHash, parent.treeHash] : [commits[index]!.treeHash];
  });
  const located = await locate(trees, roots, path);
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
  const children = await trees.load(folders.filter((folder) => folder !== null));
  for (const pair of pairs) {
    const { index, after, before } = pair;
    const set: ChangeSet = { changed: !path || after.identity !== before.identity };
    if (!differs(pair)) set.names = [];
    else if (entries) {
      const now = childIdentities(after.folder ? children.get(after.folder) : null);
      const was = childIdentities(before.folder ? children.get(before.folder) : null);
      const names = [...now.keys()].filter((name) => now.get(name) !== was.get(name));
      for (const name of was.keys()) if (!now.has(name)) names.push(name);
      set.names = names;
    }
    sets[index] = set;
    worked.push([ids[index]!, set]);
  }
  return sets as ChangeSet[];
}

/** The entry at `path` in each root tree, read a level at a time for all of them. */
async function locate(trees: Trees, roots: string[], path: string): Promise<Snapshot[]> {
  if (!path) return roots.map((root) => ({ identity: root, folder: root }));
  const segments = path.split("/");
  const result: Snapshot[] = roots.map(() => EMPTY);
  let current: (string | null)[] = roots;
  for (const [depth, segment] of segments.entries()) {
    const loaded = await trees.load(current.filter((tree) => tree !== null));
    const last = depth === segments.length - 1;
    current = current.map((tree, index) => {
      const entry = tree ? (loaded.get(tree)?.find((e) => e.name === segment) ?? null) : null;
      if (last)
        result[index] = {
          identity: identity(entry),
          folder: entry?.type === "tree" ? entry.hash : null,
        };
      return entry?.type === "tree" ? entry.hash : null;
    });
  }
  return result;
}

/**
 * Trees for one request: each read once, the ones in either cache looked up
 * together, and only the rest fetched, a few at a time.
 */
function treeLoader(reader: Reader) {
  const known = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  return {
    async load(oids: string[]): Promise<Map<string, ArtifactsTreeEntry[] | null>> {
      const missing = [...new Set(oids)].filter((oid) => !known.has(oid));
      if (missing.length) {
        const work = (async () => {
          const hits = await Promise.all(missing.map((oid) => reader.peekTree(oid)));
          const misses = missing.filter((_, index) => hits[index] === undefined);
          const fetched = await pool(misses, TREE_CONCURRENCY, (oid) => reader.fetchTree(oid));
          const found = new Map(missing.map((oid, index) => [oid, hits[index] ?? null]));
          for (const [index, oid] of misses.entries()) found.set(oid, fetched[index] ?? null);
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

function childIdentities(tree: ArtifactsTreeEntry[] | null | undefined): Map<string, string> {
  return new Map((tree ?? []).map((entry) => [entry.name, identity(entry)!]));
}

function identity(entry: ArtifactsTreeEntry | null): string | null {
  return entry ? `${entry.type}:${entry.mode}:${entry.hash}` : null;
}
