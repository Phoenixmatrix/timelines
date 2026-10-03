/** The slice of RepoReader a range walk needs. */
export interface HistoryReader {
  /** First-parent history from a commit, newest first. */
  log(oid: string, limit: number, offset: number): Promise<ArtifactsCommitMetadata[]>;
  commit(oid: string): Promise<ArtifactsCommitMetadata | null>;
}

const PAGE = 100;
/** Enough for any release here; longer walks report `truncated`. */
export const MAX_RANGE_COMMITS = 1000;
/** Commits read to find what one merge landed; a longer search reports `truncated`. */
export const MAX_LANDING_READS = 2000;

export interface RangeWalk {
  /**
   * Newest first: the first-parent line, each merge on it followed by the
   * commits it landed.
   */
  commits: ArtifactsCommitMetadata[];
  /** The commits merges landed, by commit id: the id of the merge that landed it. */
  landings: Map<string, string>;
  base: string | null;
  truncated: boolean;
}

const SIDE = 1;
const BASE = 2;

/**
 * The commits a merge landed: reachable from its other parents but not from
 * its first, newest first. A timeline lands as a real merge into the default
 * branch, so this is the timeline's work.
 *
 * Both sides are painted in committer-date order, like git's merge-base
 * search, until no commit is left that only the merged side reaches.
 */
export async function landedBy(
  reader: HistoryReader,
  merge: ArtifactsCommitMetadata,
  { max = MAX_LANDING_READS } = {},
): Promise<{ commits: ArtifactsCommitMetadata[]; truncated: boolean }> {
  const [first, ...others] = merge.parents;
  if (!first || !others.length) return { commits: [], truncated: false };
  // A page of each merged side's history warms the reader's commit cache.
  await Promise.all(others.map((oid) => reader.log(oid, PAGE, 0)));

  const loaded = new Map<string, ArtifactsCommitMetadata>();
  const flags = new Map<string, number>();
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
    let at = queue.length;
    while (at > 0 && queue[at - 1]!.committedAt > commit.committedAt) at--;
    queue.splice(at, 0, commit);
  };
  await paint(first, BASE);
  for (const oid of others) await paint(oid, SIDE);

  let reads = 0;
  let truncated = false;
  while (queue.some((commit) => flags.get(commit.hash) === SIDE)) {
    if (reads++ === max) {
      truncated = true;
      break;
    }
    const commit = queue.pop()!;
    const flag = flags.get(commit.hash)!;
    for (const parent of commit.parents) await paint(parent, flag);
  }
  const commits = [...loaded.values()]
    .filter((commit) => flags.get(commit.hash) === SIDE)
    .sort((a, b) => b.committedAt - a.committedAt);
  return { commits, truncated };
}

/**
 * First-parent history from `start`, newest first, stopping before the first
 * commit `isBase` accepts. Pass `includeStart` so a tagged starting commit is
 * part of its own release rather than the base it stops at. Each merge on the
 * line brings the commits it landed along with it.
 */
export async function walkRange(
  reader: HistoryReader,
  start: string,
  isBase: (oid: string) => boolean,
  { includeStart = false, max = MAX_RANGE_COMMITS } = {},
): Promise<RangeWalk> {
  const line: ArtifactsCommitMetadata[] = [];
  let base: string | null = null;
  let truncated = false;
  walk: for (let offset = 0; ; offset += PAGE) {
    const page = await reader.log(start, PAGE, offset);
    for (const commit of page) {
      const first = offset === 0 && commit === page[0];
      if (!(first && includeStart) && isBase(commit.hash)) {
        base = commit.hash;
        break walk;
      }
      if (line.length === max) {
        truncated = true;
        break walk;
      }
      line.push(commit);
    }
    if (page.length < PAGE) break;
  }

  const commits: ArtifactsCommitMetadata[] = [];
  const landings = new Map<string, string>();
  for (const commit of line) {
    commits.push(commit);
    if (commit.parents.length < 2) continue;
    const landed = await landedBy(reader, commit);
    truncated ||= landed.truncated;
    for (const side of landed.commits) {
      commits.push(side);
      landings.set(side.hash, commit.hash);
    }
  }
  return { commits, landings, base, truncated };
}
