// A commit's changes against its first parent, as GET
// /api/repos/:owner/:name/commits/:oid/diff returns them (CORE-234).

/** One hunk of a unified diff: lines start with " ", "+" or "-". */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Not text: no hunks. */
  binary: boolean;
  /** Over the size or file budget: counted, no hunks. */
  omitted: boolean;
  hunks: DiffHunk[];
}

export interface CommitDiff {
  oid: string;
  parents: string[];
  message: string;
  authorName: string;
  /** Unix seconds. */
  authoredAt: number;
  files: DiffFile[];
  /** More files changed than were listed. */
  truncated: boolean;
}

/** Bounds on what one diff reads and returns. */
export const DIFF_LIMITS = {
  /** Files listed. */
  files: 300,
  /** Files whose patch is computed. */
  patched: 60,
  /** Bytes per side of a patched file. */
  blobBytes: 256 * 1024,
  /** Tree reads while comparing. */
  trees: 400,
} as const;
