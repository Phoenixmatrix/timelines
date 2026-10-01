import {
  DOWNLOAD_STRATEGY_PATH,
  downloadStrategySource,
  TAP_DIRS,
  tapMetadata,
  tapReadme,
  type TapFileKind,
  type TapSummary,
  type TapSummaryEntry,
} from "@gitmatrix/formats/brew";
import {
  enc,
  encodeCommit,
  encodeTree,
  inflate,
  makeObject,
  parseCommit,
  type EncodedObject,
  type TreeEntry,
} from "@gitmatrix/formats/git";

import { readBlobBytes } from "../../core/blobs.ts";
import {
  addFile,
  deletePackage,
  ensurePackage,
  getFile,
  getPackage,
  getVersion,
  listFiles,
  upsertVersion,
  type FileRow,
} from "../../core/catalog.ts";
import type { Services } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import type { Repository } from "../../core/repos.ts";
import { existingOids, getHead, getObject, putObjects, type Head } from "./store.ts";

/**
 * A tap is a git repository generated from the catalog: every formula and
 * cask is a file row (`Formula/<name>.rb`, `Casks/<name>.rb`) whose metadata
 * carries its git blob id, plus files gitmatrix writes itself. Each change
 * commits a new tree on top of refs/heads/main, serialized in the RepoDO.
 */

export const BRANCH = "refs/heads/main";
const IDENTITY = { name: "gitmatrix", email: "noreply@gitmatrix.dev" };

export interface TapFileMeta {
  gitOid: string;
  kind: TapFileKind;
  name: string;
  version: string;
  desc?: string;
}

export interface TapVersionMeta {
  digest: string;
  gitOid: string;
  path: string;
  desc?: string;
  commit?: string;
}

/** Runs a tap mutation in the repository's Durable Object. */
export async function mutateTap<T>(
  services: Services,
  repo: Repository,
  op: "putFile" | "deleteFile" | "refresh",
  payload: unknown,
): Promise<T> {
  // The RPC stub's inferred type for an `unknown` result is not thenable.
  const actor = await services.actor();
  const result: unknown = services.repoObject(repo).mutate(repo.id, op, payload, actor);
  return (await Promise.resolve(result)) as T;
}

export function tapName(repo: Repository): string {
  return repo.config.tapName ?? repo.key;
}

export function tapUrl(baseUrl: string, repo: Repository): string {
  return `${baseUrl}/brew/${repo.key}/homebrew-${tapName(repo)}.git`;
}

export function bottleRootUrl(baseUrl: string, repo: Repository): string {
  return `${baseUrl}/brew/${repo.key}/bottles`;
}

/** Private and internal taps need credentials for git and for downloads. */
export function needsAuth(repo: Repository): boolean {
  return repo.visibility !== "public";
}

export function tapPath(kind: TapFileKind, name: string): string {
  return `${TAP_DIRS[kind]}/${name}.rb`;
}

export async function listTapFiles(services: Services, repo: Repository) {
  const [formulae, casks] = await Promise.all([
    listFiles<TapFileMeta>(services.db, repo.id, { prefix: "Formula/" }),
    listFiles<TapFileMeta>(services.db, repo.id, { prefix: "Casks/" }),
  ]);
  return { formulae, casks };
}

function summaryEntry(file: FileRow<TapFileMeta>): TapSummaryEntry {
  return {
    name: file.metadata.name,
    version: file.metadata.version,
    desc: file.metadata.desc,
    sha256: file.digest.slice("sha256:".length),
  };
}

function treeOf(entries: TreeEntry[], objects: EncodedObject[]): string {
  const tree = makeObject("tree", encodeTree(entries));
  objects.push(tree);
  return tree.oid;
}

async function headTree(services: Services, repo: Repository, head: Head | null) {
  if (!head) return null;
  const object = await getObject(services.db, repo.id, head.oid);
  return object ? parseCommit(inflate(object.zdata)).tree : null;
}

export interface CommitResult {
  commit: string;
  seq: number;
  changed: boolean;
}

/**
 * Commits the current tap contents if they differ from HEAD. `known` holds
 * blobs the caller already encoded (the file being published). Runs in the
 * RepoDO only.
 */
export async function commitTap(
  services: Services,
  repo: Repository,
  message: string,
  options: { publishedBy?: string | null; known?: EncodedObject[] } = {},
): Promise<CommitResult> {
  const { db, bucket, baseUrl } = services;
  const head = await getHead(db, repo.id);
  const { formulae, casks } = await listTapFiles(services, repo);
  const objects: EncodedObject[] = [...(options.known ?? [])];

  // Blobs for tap files that are not stored yet (normally none, or the one
  // just published) are re-read from R2.
  const files = [...formulae, ...casks];
  const stored = await existingOids(
    db,
    repo.id,
    files.map((f) => f.metadata.gitOid),
  );
  for (const file of files) {
    const oid = file.metadata.gitOid;
    if (stored.has(oid) || objects.some((o) => o.oid === oid)) continue;
    const blob = makeObject("blob", await readBlobBytes(bucket, file.r2Key));
    if (blob.oid !== oid) throw new RegistryError("internal", `${file.path} changed in storage`);
    objects.push(blob);
  }

  const summary: TapSummary = {
    repository: repo.key,
    tapName: tapName(repo),
    tapUrl: tapUrl(baseUrl, repo),
    bottleRootUrl: bottleRootUrl(baseUrl, repo),
    authenticated: needsAuth(repo),
    formulae: formulae.map(summaryEntry),
    casks: casks.map(summaryEntry),
  };
  const blob = (content: string) => {
    const object = makeObject("blob", enc.encode(content));
    objects.push(object);
    return object.oid;
  };
  const dirEntries = (list: FileRow<TapFileMeta>[]): TreeEntry[] =>
    list.map((f) => ({ mode: "100644", name: `${f.metadata.name}.rb`, oid: f.metadata.gitOid }));

  const root: TreeEntry[] = [
    { mode: "100644", name: "README.md", oid: blob(tapReadme(summary)) },
    { mode: "100644", name: ".gitmatrix.json", oid: blob(tapMetadata(summary)) },
    {
      mode: "40000",
      name: "lib",
      oid: treeOf(
        [
          {
            mode: "100644",
            name: DOWNLOAD_STRATEGY_PATH.slice("lib/".length),
            oid: blob(downloadStrategySource(new URL(baseUrl).hostname)),
          },
        ],
        objects,
      ),
    },
  ];
  if (formulae.length > 0) {
    root.push({ mode: "40000", name: "Formula", oid: treeOf(dirEntries(formulae), objects) });
  }
  if (casks.length > 0) {
    root.push({ mode: "40000", name: "Casks", oid: treeOf(dirEntries(casks), objects) });
  }
  const tree = treeOf(root, objects);
  if (head && (await headTree(services, repo, head)) === tree) {
    return { commit: head.oid, seq: head.seq, changed: false };
  }

  const now = { ...IDENTITY, time: Math.floor(Date.now() / 1000) };
  const trailer = options.publishedBy ? `\n\nPublished-by: ${options.publishedBy}\n` : "\n";
  const commit = makeObject(
    "commit",
    encodeCommit({
      tree,
      parents: head ? [head.oid] : [],
      author: now,
      committer: now,
      message: `${message}${trailer}`,
    }),
  );
  const seq = (head?.seq ?? 0) + 1;
  // The commit goes last so a failed write never leaves HEAD pointing at missing objects.
  await putObjects(db, repo.id, seq, objects);
  await putObjects(db, repo.id, seq, [commit]);
  return { commit: commit.oid, seq, changed: true };
}

export interface PutFilePayload {
  kind: TapFileKind;
  name: string;
  content: string;
  digest: string;
  size: number;
  version: string;
  desc?: string;
  publishedBy: string | null;
  allowOverwrite: boolean;
}

export interface PutFileResult extends CommitResult {
  version: string;
}

async function putFile(services: Services, repo: Repository, raw: unknown) {
  const payload = raw as PutFilePayload;
  const { db } = services;
  const path = tapPath(payload.kind, payload.name);
  const blob = makeObject("blob", enc.encode(payload.content));

  const existing = await getFile(db, repo.id, path);
  if (existing?.digest === payload.digest) {
    const head = await commitTap(services, repo, `Update ${payload.name}`);
    return { ...head, changed: false, version: payload.version } satisfies PutFileResult;
  }

  const pkg = await ensurePackage(db, repo.id, payload.name, path.slice(0, -3), {
    kind: payload.kind,
    path,
  });
  const previous = await getVersion<TapVersionMeta>(db, pkg.id, payload.version);
  if (previous && previous.metadata.digest !== payload.digest && !payload.allowOverwrite) {
    throw new RegistryError(
      "immutable",
      `${payload.name} ${payload.version} is already published with different content`,
    );
  }
  const metadata: TapVersionMeta = {
    digest: payload.digest,
    gitOid: blob.oid,
    path,
    ...(payload.desc ? { desc: payload.desc } : {}),
  };
  const version = await upsertVersion(db, pkg.id, payload.version, metadata, payload.publishedBy);
  await addFile(db, {
    repoId: repo.id,
    path,
    versionId: version.id,
    digest: payload.digest,
    size: payload.size,
    contentType: "text/x-ruby; charset=utf-8",
    metadata: {
      gitOid: blob.oid,
      kind: payload.kind,
      name: payload.name,
      version: payload.version,
      ...(payload.desc ? { desc: payload.desc } : {}),
    } satisfies TapFileMeta,
    createdBy: payload.publishedBy,
    overwrite: true,
  });
  const verb = existing ? "Update" : "Add";
  const label = payload.kind === "cask" ? `cask ${payload.name}` : payload.name;
  const result = await commitTap(services, repo, `${verb} ${label} ${payload.version}`, {
    publishedBy: payload.publishedBy,
    known: [blob],
  });
  await upsertVersion(
    db,
    pkg.id,
    payload.version,
    { ...metadata, commit: result.commit },
    payload.publishedBy,
  );
  return { ...result, version: payload.version } satisfies PutFileResult;
}

export interface DeleteFilePayload {
  kind: TapFileKind;
  name: string;
  publishedBy: string | null;
}

async function deleteTapFile(services: Services, repo: Repository, raw: unknown) {
  const payload = raw as DeleteFilePayload;
  const path = tapPath(payload.kind, payload.name);
  const pkg = await getPackage(services.db, repo.id, path.slice(0, -3));
  const file = await getFile(services.db, repo.id, path);
  if (!pkg && !file) throw RegistryError.notFound(`${path} not found`);
  // Versions cascade to their file rows; git history keeps the old content.
  if (pkg) await deletePackage(services.db, pkg.id);
  const label = payload.kind === "cask" ? `cask ${payload.name}` : payload.name;
  return commitTap(services, repo, `Delete ${label}`, { publishedBy: payload.publishedBy });
}

export const tapMutations = {
  putFile,
  deleteFile: deleteTapFile,
  refresh: (services: Services, repo: Repository) =>
    commitTap(services, repo, "Regenerate tap files"),
};
