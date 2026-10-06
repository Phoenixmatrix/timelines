import { RepoReader } from "../objects.ts";
import { Timing } from "../timing.ts";
import { db } from "../schema.ts";
import { getWorkSource } from "../timelines/sources.ts";
import { knowledgeRepo } from "./sources.ts";
import { loadSnapshot, saveSnapshot, type SnapshotFile } from "./graph.ts";

/** Capture canonical files from an exact indexed commit, never its mutable ref. */
export async function pinKnowledgeBase(env: Env, repoId: string, commit: string, snapshot: string) {
  const repo = await knowledgeRepo(env, repoId);
  if (!repo) throw new Error("Repository not found");
  const pending: Promise<unknown>[] = [];
  const reader = new RepoReader(
    env,
    repo.artifacts_name,
    repo.artifacts_remote,
    new Timing(),
    (work) => pending.push(work),
  );
  try {
    const root = await reader.commit(commit);
    if (!root) throw new Error(`Canonical knowledge base ${commit} unavailable`);
    const files: SnapshotFile[] = [];
    const walk = async (tree: string, prefix: string) => {
      const entries = await reader.tree(tree);
      if (!entries) throw new Error(`Canonical knowledge base tree ${tree} unavailable`);
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === "tree") await walk(entry.hash, path);
        else if (entry.type === "blob" || entry.type === "exec")
          files.push({ path, blob: entry.hash, mode: entry.mode });
      }
    };
    await walk(root.treeHash, "");
    await saveSnapshot(env.DB, repoId, snapshot, files);
    return files;
  } finally {
    await reader.close();
    await Promise.all(pending);
  }
}

/** Only canonical blobs rooted in the pinned base can supplement the work tree. */
class OverlayReader extends RepoReader {
  private readonly canonical: RepoReader;
  private readonly baseBlobs: Set<string>;
  constructor(
    env: Env,
    name: string,
    remote: string,
    canonical: RepoReader,
    baseBlobs: Set<string>,
    waitUntil: (work: Promise<unknown>) => void,
    sourceRef: string,
  ) {
    super(env, name, remote, new Timing(), waitUntil, sourceRef);
    this.canonical = canonical;
    this.baseBlobs = baseBlobs;
  }
  override async blob(oid: string) {
    const work = await super.blob(oid);
    return work ?? (this.baseBlobs.has(oid) ? await this.canonical.blob(oid) : null);
  }
  override async close() {
    await Promise.all([super.close(), this.canonical.close()]);
  }
}

export async function withOverlayReader<T>(
  env: Env,
  repoId: string,
  sourceId: string,
  snapshot: string,
  waitUntil: (work: Promise<unknown>) => void,
  work: (reader: RepoReader) => Promise<T>,
): Promise<T> {
  const source = await getWorkSource(env, repoId, sourceId);
  if (source?.state !== "ready") throw new Error("Timeline source is read-only or unavailable");
  const [repo, canonical, files] = await Promise.all([
    knowledgeRepo(env, repoId, sourceId),
    knowledgeRepo(env, repoId),
    loadSnapshot(env.DB, repoId, snapshot),
  ]);
  if (!repo || !canonical) throw new Error("Repository not found");
  const base = new RepoReader(
    env,
    canonical.artifacts_name,
    canonical.artifacts_remote,
    new Timing(),
    waitUntil,
  );
  const reader = new OverlayReader(
    env,
    repo.artifacts_name,
    repo.artifacts_remote,
    base,
    new Set(files.map((file) => file.blob)),
    waitUntil,
    source.work_ref,
  );
  try {
    return await work(reader);
  } finally {
    await reader.close();
  }
}

export async function releaseKnowledgeBase(env: Env, repoId: string, snapshot: string) {
  await db(env.DB)
    .deleteFrom("kg_files")
    .where("repo_id", "=", repoId)
    .where("snapshot", "=", snapshot)
    .execute();
}
