/** The slice of RepoReader a range walk needs. */
export interface HistoryReader {
  log(oid: string, limit: number, offset: number): Promise<ArtifactsCommitMetadata[]>;
}

const PAGE = 100;
/** Enough for any release here; longer walks report `truncated`. */
export const MAX_RANGE_COMMITS = 1000;

/**
 * First-parent history from `start`, newest first, stopping before the first
 * commit `isBase` accepts. Pass `includeStart` so a tagged starting commit is
 * part of its own release rather than the base it stops at.
 */
export async function walkRange(
  reader: HistoryReader,
  start: string,
  isBase: (oid: string) => boolean,
  { includeStart = false, max = MAX_RANGE_COMMITS } = {},
): Promise<{ commits: ArtifactsCommitMetadata[]; base: string | null; truncated: boolean }> {
  const commits: ArtifactsCommitMetadata[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await reader.log(start, PAGE, offset);
    for (const commit of page) {
      const first = offset === 0 && commit === page[0];
      if (!(first && includeStart) && isBase(commit.hash))
        return { commits, base: commit.hash, truncated: false };
      if (commits.length === max) return { commits, base: null, truncated: true };
      commits.push(commit);
    }
    if (page.length < PAGE) return { commits, base: null, truncated: false };
  }
}
