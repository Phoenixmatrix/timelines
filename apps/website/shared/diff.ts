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

/**
 * Everything one line of work changes, as GET
 * /api/repos/:owner/:name/compare?base=&head=[&source=] returns it (CORE-382):
 * `head` against where it meets `base` (their merge base), so main merged
 * into a timeline doesn't count as the timeline's own change.
 */
export interface CompareDiff {
  /** The requested base and head, resolved to commits. */
  base: string;
  head: string;
  /** What the diff starts from: the merge base, or `base` when none was found. */
  from: string;
  /** Null when the histories share nothing within the search budget. */
  mergeBase: string | null;
  /** The merge-base search stopped at its budget; `from` is `base`. */
  historyTruncated: boolean;
  /**
   * Commits on head's first-parent chain since `from`, newest first, at most
   * COMPARE_COMMITS: a merge of main shows as its merge commit.
   */
  commits: {
    oid: string;
    summary: string;
    authorName: string;
    authoredAt: number;
    /** More than one parent. */
    merge: boolean;
  }[];
  /** More commits than were listed. */
  commitsTruncated: boolean;
  files: DiffFile[];
  /** More files changed than were listed. */
  truncated: boolean;
}

/** Commits listed by a compare. */
export const COMPARE_COMMITS = 100;

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
