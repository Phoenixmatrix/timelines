// Blame for a few lines, in the Worker (CORE-85). The Artifacts binding reads
// commits, trees and blobs (cached by objects.ts), which is all blame needs:
// walk back from the head and, at each commit, diff the file against its
// parents. A line the commit left as its parent had it passes to that parent;
// a line no parent had is the commit's. Like `git blame`, a merge passes a
// line to the first parent that has it, so work landed by a merge is blamed
// on the timeline's own commit, not on the merge. Renames aren't followed.
//
// Only the asked-for lines are traced, so a commit that left them alone
// costs one tree lookup, and a parent with the same blob passes everything
// without a diff.

import { diffArrays } from "diff";
import type { WhyLine } from "../../shared/why.ts";
import type { BlobData } from "../objects.ts";

export interface BlameReader {
  commit(oid: string): Promise<ArtifactsCommitMetadata | null>;
  /** First-parent history from `oid`, itself first. */
  log(oid: string, limit: number, offset: number): Promise<ArtifactsCommitMetadata[]>;
  entryAt(rootTree: string, path: string): Promise<ArtifactsTreeEntry | null>;
  blob(oid: string): Promise<BlobData | null>;
}

export interface BlameLimits {
  /** Commits visited before the remaining lines are blamed where they stand. */
  commits: number;
  /** Diffs computed, the expensive step. */
  diffs: number;
  /** Larger files aren't diffed. */
  bytes: number;
}

export const BLAME_LIMITS: BlameLimits = { commits: 3000, diffs: 300, bytes: 2 * 1024 * 1024 };

export class BlameError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BlameResult {
  head: string;
  lines: WhyLine[];
  truncated: boolean;
}

interface Tracked {
  /** The line in the head's file, 1-based. */
  target: number;
  /** Its index in this commit's file, 0-based. */
  at: number;
}

interface Pending {
  commit: ArtifactsCommitMetadata;
  blob: string;
  lines: Tracked[];
}

const decoder = new TextDecoder();
/** The lines of a file as the code view numbers them. */
export function fileLines(bytes: Uint8Array): string[] {
  return decoder.decode(bytes).replace(/\n$/, "").split("\n");
}

/**
 * For each child line index, the parent line index it was unchanged from, or
 * -1. Null when the files differ too much to diff within the limit.
 */
export function unchangedFrom(parent: string[], child: string[]): Int32Array | null {
  const map = new Int32Array(child.length).fill(-1);
  const changes = diffArrays(parent, child, { maxEditLength: 4000 });
  if (!changes) return null;
  let p = 0;
  let c = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.length;
    if (change.added) c += count;
    else if (change.removed) p += count;
    else {
      for (let i = 0; i < count; i++) map[c + i] = p + i;
      c += count;
      p += count;
    }
  }
  return map;
}

/** Blame lines `start`–`end` (1-based, inclusive) of `path` at commit `head`. */
export async function blameLines(
  reader: BlameReader,
  head: string,
  path: string,
  start: number,
  end: number,
  limits: BlameLimits = BLAME_LIMITS,
): Promise<BlameResult> {
  // Commits by id, filled a first-parent page at a time.
  const known = new Map<string, ArtifactsCommitMetadata>();
  const meta = async (oid: string) => {
    const hit = known.get(oid);
    if (hit) return hit;
    const page = await reader.log(oid, 64, 0);
    for (const commit of page) known.set(commit.hash, commit);
    return known.get(oid) ?? (await reader.commit(oid));
  };
  const blobId = async (commit: ArtifactsCommitMetadata) => {
    const entry = await reader.entryAt(commit.treeHash, path);
    return entry && (entry.type === "blob" || entry.type === "exec" || entry.type === "symlink")
      ? entry.hash
      : null;
  };
  const contents = new Map<string, string[] | null>();
  const text = async (oid: string) => {
    if (!contents.has(oid)) {
      const blob = await reader.blob(oid);
      contents.set(oid, blob && blob.size <= limits.bytes ? fileLines(blob.bytes) : null);
    }
    return contents.get(oid)!;
  };

  const tip = await meta(head);
  if (!tip) throw new BlameError(404, `No commit ${head}.`);
  const tipBlob = await blobId(tip);
  if (!tipBlob) throw new BlameError(404, `No file at ${path}.`);
  const tipLines = await text(tipBlob);
  if (!tipLines) throw new BlameError(400, `${path} is too large to blame.`);
  if (start < 1 || end < start || start > tipLines.length)
    throw new BlameError(400, `${path} has ${tipLines.length} lines.`);
  end = Math.min(end, tipLines.length);

  const blamed: WhyLine[] = [];
  const blame = (commit: string, lines: Tracked[]) => {
    for (const line of lines) blamed.push({ line: line.target, commit, originalLine: line.at + 1 });
  };
  const pending = new Map<string, Pending>();
  const add = (commit: ArtifactsCommitMetadata, blob: string, lines: Tracked[]) => {
    const entry = pending.get(commit.hash);
    if (!entry) pending.set(commit.hash, { commit, blob, lines: [...lines] });
    else
      for (const line of lines)
        if (!entry.lines.some((l) => l.target === line.target)) entry.lines.push(line);
  };
  add(
    tip,
    tipBlob,
    Array.from({ length: end - start + 1 }, (_, i) => ({ target: start + i, at: start + i - 1 })),
  );

  let visited = 0;
  let diffs = 0;
  let truncated = false;
  while (pending.size) {
    // Newest first, so a commit reached through two children is handled once, after both.
    let next: Pending | undefined;
    for (const entry of pending.values())
      if (!next || entry.commit.committedAt > next.commit.committedAt) next = entry;
    const { commit, blob, lines } = next!;
    pending.delete(commit.hash);
    if (++visited > limits.commits) {
      truncated = true;
      blame(commit.hash, lines);
      continue;
    }
    const parents: { commit: ArtifactsCommitMetadata; blob: string }[] = [];
    for (const oid of commit.parents) {
      const parent = await meta(oid);
      const parentBlob = parent ? await blobId(parent) : null;
      if (parent && parentBlob) parents.push({ commit: parent, blob: parentBlob });
    }
    // A parent with the same file takes every line, unchanged.
    const same = parents.find((p) => p.blob === blob);
    if (same) {
      add(same.commit, same.blob, lines);
      continue;
    }
    let left = lines;
    for (const parent of parents) {
      if (!left.length) break;
      if (++diffs > limits.diffs) {
        truncated = true;
        break;
      }
      const [before, after] = await Promise.all([text(parent.blob), text(blob)]);
      const map = before && after ? unchangedFrom(before, after) : null;
      if (!map) {
        truncated = true;
        continue;
      }
      const passed: Tracked[] = [];
      const kept: Tracked[] = [];
      for (const line of left) {
        const at = map[line.at] ?? -1;
        if (at >= 0) passed.push({ target: line.target, at });
        else kept.push(line);
      }
      if (passed.length) add(parent.commit, parent.blob, passed);
      left = kept;
    }
    blame(commit.hash, left);
  }
  blamed.sort((a, b) => a.line - b.line);
  return { head, lines: blamed, truncated };
}
