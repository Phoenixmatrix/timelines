// Shared by the commit diff and the compare route (CORE-234, CORE-382): file
// patches between two trees, objects read across a work source and its
// canonical repository, and the commits one side has that the other lacks.

import { structuredPatch } from "diff";
import { COMPARE_COMMITS, DIFF_LIMITS, type DiffFile } from "../shared/diff.ts";
import { diffTrees, MAX_HISTORY_READS, type FileChange } from "./knowledge/overlay.ts";
import type { BlobData } from "./objects.ts";

/** A diff read more trees than DIFF_LIMITS.trees allows. */
export class DiffBudget extends Error {}

/** The objects a diff reads. */
export interface DiffObjects {
  tree(oid: string): Promise<ArtifactsTreeEntry[] | null>;
  blobLimited(oid: string, maxBytes: number): Promise<BlobData | null>;
}

/**
 * The files that differ between two trees (`fromTree` null: everything is
 * added), patched within DIFF_LIMITS. Throws DiffBudget when the trees alone
 * are too many to compare.
 */
export async function diffFiles(
  objects: DiffObjects,
  fromTree: string | null,
  toTree: string,
): Promise<{ files: DiffFile[]; truncated: boolean }> {
  let reads = 0;
  const trees = {
    tree: (tree: string) => {
      if (++reads > DIFF_LIMITS.trees) throw new DiffBudget();
      return objects.tree(tree);
    },
  };
  const changes: FileChange[] = await diffTrees(trees, fromTree, toTree);
  const listed = changes.slice(0, DIFF_LIMITS.files);
  const text = async (blob: string | null) => {
    if (!blob) return { text: "", binary: false, omitted: false };
    const data = await objects.blobLimited(blob, DIFF_LIMITS.blobBytes);
    if (!data || data.bytes.length < data.size) return { text: "", binary: false, omitted: true };
    if (data.bytes.subarray(0, 8000).includes(0)) return { text: "", binary: true, omitted: false };
    return { text: new TextDecoder().decode(data.bytes), binary: false, omitted: false };
  };
  const files: DiffFile[] = [];
  for (const [index, change] of listed.entries()) {
    const status = !change.before ? "added" : !change.blob ? "deleted" : "modified";
    const file: DiffFile = {
      path: change.path,
      status,
      additions: 0,
      deletions: 0,
      binary: false,
      omitted: index >= DIFF_LIMITS.patched,
      hunks: [],
    };
    if (!file.omitted) {
      const [before, after] = await Promise.all([text(change.before), text(change.blob)]);
      file.binary = before.binary || after.binary;
      file.omitted = before.omitted || after.omitted;
      if (!file.binary && !file.omitted) {
        const patch = structuredPatch(change.path, change.path, before.text, after.text, "", "", {
          context: 3,
        });
        file.hunks = patch.hunks.map((h) => ({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          lines: h.lines,
        }));
        for (const line of patch.hunks.flatMap((h) => h.lines)) {
          if (line.startsWith("+")) file.additions++;
          else if (line.startsWith("-")) file.deletions++;
        }
      }
    }
    files.push(file);
  }
  return { files, truncated: changes.length > listed.length };
}

interface ObjectReader extends DiffObjects {
  commit(oid: string): Promise<ArtifactsCommitMetadata | null>;
}

/** What readEither needs of each repository: reads that never go remote (CORE-400). */
export interface EitherSide extends ObjectReader {
  recallCommit(oid: string): ArtifactsCommitMetadata | undefined;
  recallTree(oid: string): ArtifactsTreeEntry[] | undefined;
  peekBlobLimited(oid: string, maxBytes: number): BlobData | undefined;
  peekCommit(oid: string): Promise<ArtifactsCommitMetadata | undefined>;
  peekTree(oid: string): Promise<ArtifactsTreeEntry[] | undefined>;
  fetchCommit(oid: string): Promise<ArtifactsCommitMetadata | null>;
  fetchTree(oid: string): Promise<ArtifactsTreeEntry[] | null>;
}

/** An object's reads on one repository, from cheapest to dearest. */
interface Reads<T> {
  recall(side: EitherSide): T | undefined;
  peek(side: EitherSide): Promise<T | undefined>;
  load(side: EitherSide): Promise<T | null>;
}

/**
 * Two repositories read as one. Objects are content-addressed, so a commit,
 * tree or blob found in either is the same object: a timeline's work source
 * is a fork, and main's newer commits exist only in the canonical repository
 * (CORE-382). Callers pass only those two repositories of one canonical repo.
 *
 * Absence isn't cached, so a remote read that misses is paid on every request
 * (CORE-400). Each read therefore tries both repositories' memory, then their
 * Cache API, and only then the remote, the repository that last served a
 * neighbour first: a commit's parents and tree, and a tree's entries, most
 * likely live where it did. `prefer` seeds that for the starting commits.
 */
export function readEither(
  first: EitherSide,
  second: EitherSide,
): ObjectReader & { prefer(oid: string, side: EitherSide): void } {
  const preferred = new Map<string, EitherSide>();
  const order = (oid: string) => {
    const side = preferred.get(oid) ?? first;
    return side === first ? [first, second] : [second, first];
  };
  const find = async <T>(oid: string, reads: Reads<T>) => {
    const sides = order(oid);
    for (const side of sides) {
      const value = reads.recall(side);
      if (value !== undefined) return { value, side };
    }
    for (const side of sides) {
      const value = await reads.peek(side);
      if (value !== undefined) return { value, side };
    }
    for (const side of sides) {
      const value = await reads.load(side);
      if (value) return { value, side };
    }
    return null;
  };
  const suggest = (oid: string, side: EitherSide) => {
    if (!preferred.has(oid)) preferred.set(oid, side);
  };
  return {
    prefer: (oid, side) => preferred.set(oid, side),
    commit: async (oid) => {
      const found = await find<ArtifactsCommitMetadata>(oid, {
        recall: (side) => side.recallCommit(oid),
        peek: (side) => side.peekCommit(oid),
        load: (side) => side.fetchCommit(oid),
      });
      if (!found) return null;
      for (const parent of found.value.parents) suggest(parent, found.side);
      suggest(found.value.treeHash, found.side);
      return found.value;
    },
    tree: async (oid) => {
      const found = await find<ArtifactsTreeEntry[]>(oid, {
        recall: (side) => side.recallTree(oid),
        peek: (side) => side.peekTree(oid),
        load: (side) => side.fetchTree(oid),
      });
      if (!found) return null;
      for (const entry of found.value) suggest(entry.hash, found.side);
      return found.value;
    },
    blobLimited: async (oid, max) =>
      (
        await find<BlobData>(oid, {
          recall: (side) => side.peekBlobLimited(oid, max),
          peek: async () => undefined,
          load: (side) => side.blobLimited(oid, max),
        })
      )?.value ?? null,
  };
}

export interface CompareCommit {
  oid: string;
  summary: string;
  authorName: string;
  authoredAt: number;
  /** A merge commit (more than one parent). */
  merge: boolean;
}

/**
 * The commits on `head`'s first-parent chain that `exclude` does not reach,
 * newest first: the steps of the line of work, where `git log --first-parent
 * exclude..head` lists them. Main merged into the line shows as its merge
 * commit, not as main's own commits. Membership is settled first: both sides
 * are painted in committer-date order, and a commit whose color changes after
 * it was processed is processed again, so skewed dates can't list what
 * `exclude` reaches. Bounded by `limit` listed and MAX_HISTORY_READS read.
 */
export async function commitsSince(
  reader: Pick<ObjectReader, "commit">,
  head: string,
  exclude: string,
  limit = COMPARE_COMMITS,
): Promise<{ commits: CompareCommit[]; truncated: boolean }> {
  const SHOWN = 1;
  const HIDDEN = 2;
  const flags = new Map<string, number>();
  const loaded = new Map<string, ArtifactsCommitMetadata>();
  const queued = new Set<string>();
  // Oldest first, so pop() takes the newest.
  const queue: ArtifactsCommitMetadata[] = [];
  const paint = async (oid: string, flag: number) => {
    const had = flags.get(oid) ?? 0;
    if ((had & flag) === flag) return;
    flags.set(oid, had | flag);
    let commit = loaded.get(oid);
    if (!commit) {
      const read = await reader.commit(oid);
      if (!read) return;
      loaded.set(oid, (commit = read));
    }
    if (queued.has(oid)) return; // Waiting; it will carry the new flag.
    queued.add(oid);
    let at = queue.length;
    while (at > 0 && queue[at - 1]!.committedAt > commit.committedAt) at--;
    queue.splice(at, 0, commit);
  };
  await paint(exclude, HIDDEN);
  await paint(head, SHOWN);
  let reads = 0;
  let truncated = false;
  // Until everything left is reachable from `exclude`.
  while (queue.some((entry) => flags.get(entry.hash) === SHOWN)) {
    if (reads++ >= MAX_HISTORY_READS) {
      truncated = true;
      break;
    }
    const commit = queue.pop()!;
    queued.delete(commit.hash);
    const flag = flags.get(commit.hash)!;
    for (const parent of commit.parents) await paint(parent, flag);
  }
  const commits: CompareCommit[] = [];
  let at: string | undefined = head;
  while (at && !((flags.get(at) ?? 0) & HIDDEN)) {
    const commit = loaded.get(at);
    if (!commit) break;
    if (commits.length >= limit) return { commits, truncated: true };
    commits.push({
      oid: commit.hash,
      summary: commit.message.split("\n", 1)[0] ?? "",
      authorName: commit.author.name,
      authoredAt: commit.authoredAt,
      merge: commit.parents.length > 1,
    });
    at = commit.parents[0];
  }
  return { commits, truncated };
}
