import type { CommitSummary, HistoryPage } from "../../shared/api.ts";
import type { RepoReader } from "../objects.ts";

type Reader = Pick<RepoReader, "log" | "commit" | "tree" | "treeAt" | "entryAt">;
export const HISTORY_PAGE_SIZE = 100;

export function commitSummary(commit: ArtifactsCommitMetadata): CommitSummary {
  return {
    oid: commit.hash,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authoredAt: commit.authoredAt,
    parents: commit.parents,
  };
}

/** A bounded first-parent walk. Compare object type and mode too: chmod is a change. */
export async function readHistory(
  reader: Reader,
  head: string,
  path: string,
  entries: boolean,
  cursor = head,
): Promise<Omit<HistoryPage, "ref">> {
  const tip = await reader.commit(head);
  if (!tip) throw new Error("History head is unavailable.");
  const currentTree = entries ? await reader.treeAt(tip.treeHash, path) : null;
  const names = currentTree ? ((await reader.tree(currentTree)) ?? []).map((e) => e.name) : [];
  const log = await reader.log(cursor, HISTORY_PAGE_SIZE + 1, 0);
  if (!log.length) throw new Error("History cursor is unavailable.");
  const page = log.slice(0, HISTORY_PAGE_SIZE);
  const snapshots = new Map<
    string,
    Promise<{ identity: string | null; children: Map<string, string> }>
  >();
  const snapshot = (tree: string) => {
    let pending = snapshots.get(tree);
    if (!pending) {
      pending = (async () => {
        const entry = path ? await reader.entryAt(tree, path) : null;
        const folder = path ? (entry?.type === "tree" ? entry.hash : null) : tree;
        return {
          identity: path ? identity(entry) : tree,
          children: new Map(
            entries && folder
              ? ((await reader.tree(folder)) ?? []).map((e) => [e.name, identity(e)!])
              : [],
          ),
        };
      })();
      snapshots.set(tree, pending);
    }
    return pending;
  };
  const empty = { identity: null, children: new Map<string, string>() };
  const changes: { commit: CommitSummary; changed: boolean; names: string[] }[] = [];
  // Eight commits at a time bounds binding traffic, independent of directory width.
  for (let offset = 0; offset < page.length; offset += 8) {
    changes.push(
      ...(await Promise.all(
        page.slice(offset, offset + 8).map(async (commit, index) => {
          const parentId = commit.parents[0];
          const following = log[offset + index + 1];
          const parent = parentId
            ? following?.hash === parentId
              ? following
              : await reader.commit(parentId)
            : null;
          if (parentId && !parent)
            throw new Error("History is incomplete: a parent commit is unavailable.");
          const [after, before] = await Promise.all([
            snapshot(commit.treeHash),
            parent ? snapshot(parent.treeHash) : empty,
          ]);
          return {
            commit: commitSummary(commit),
            changed: !path || after.identity !== before.identity,
            names: names.filter((name) => after.children.get(name) !== before.children.get(name)),
          };
        }),
      )),
    );
  }
  const result: Omit<HistoryPage, "ref"> = {
    head,
    path,
    scanned: page.length,
    next: page.at(-1)?.parents[0] ?? null,
    commits: [],
    entries: Object.create(null),
  };
  for (const change of changes) {
    if (change.changed) result.commits.push(change.commit);
    for (const name of change.names) {
      const entryPath = path ? `${path}/${name}` : name;
      const previous = result.entries[entryPath];
      result.entries[entryPath] = {
        latest: previous?.latest ?? change.commit,
        count: (previous?.count ?? 0) + 1,
      };
    }
  }
  return result;
}
function identity(entry: ArtifactsTreeEntry | null): string | null {
  return entry ? `${entry.type}:${entry.mode}:${entry.hash}` : null;
}
