import {
  groupPath,
  isSnapshot,
  lastUpdatedStamp,
  METADATA_FILE,
  versioningFor,
  writeMetadataXml,
  type MavenMetadata,
  type PluginEntry,
  type SnapshotVersionEntry,
} from "@gitmatrix/formats/maven";
import { sql } from "kysely";

import {
  deleteFile,
  filesForVersions,
  getPackage,
  listVersions,
  type FileRow,
} from "../../core/catalog.ts";
import type { Services } from "../../core/context.ts";
import { nowIso, type DB } from "../../core/db.ts";
import { deleteDerived, listDerived, putDerived } from "../../core/derived.ts";
import type { Repository } from "../../core/repos.ts";

/**
 * Server-generated `maven-metadata.xml`. Client uploads of metadata are
 * ignored; every deploy marks its package dirty (bumps `updated_at`) and the
 * RepoDO's debounced rebuild regenerates metadata for dirty packages only,
 * recording `indexedAt` in the package metadata.
 */

export interface MavenFileMeta {
  classifier?: string | null;
  extension?: string;
  timestamp?: string | null;
  buildNumber?: number | null;
  /** A checksum sidecar uploaded before its artifact; verified when it arrives. */
  pendingChecksum?: string;
}

export interface MavenPackageMeta {
  groupId?: string;
  artifactId?: string;
  pluginPrefix?: string;
  pluginName?: string;
  indexedAt?: string;
}

export const METADATA_CONTENT_TYPE = "text/xml";

export function isPending(file: Pick<FileRow<MavenFileMeta>, "metadata">): boolean {
  return Boolean(file.metadata.pendingChecksum);
}

function buildKey(file: FileRow<MavenFileMeta>): string | null {
  const { timestamp, buildNumber } = file.metadata;
  return timestamp && buildNumber ? `${timestamp}-${String(buildNumber).padStart(9, "0")}` : null;
}

/** Deletes files of all but the newest `keep` timestamped builds of a SNAPSHOT version. */
async function pruneSnapshotBuilds(
  db: DB,
  repo: Repository,
  files: FileRow<MavenFileMeta>[],
  keep: number,
): Promise<void> {
  const builds = [...new Set(files.map(buildKey).filter((k): k is string => k !== null))].sort();
  if (builds.length <= keep) return;
  const doomed = new Set(builds.slice(0, builds.length - keep));
  for (const file of files) {
    const key = buildKey(file);
    if (key && doomed.has(key)) await deleteFile(db, repo.id, file.path);
  }
}

function snapshotMetadata(
  groupId: string,
  artifactId: string,
  version: string,
  files: FileRow<MavenFileMeta>[],
): MavenMetadata | null {
  const entries = new Map<string, SnapshotVersionEntry & { rank: string }>();
  let latest: { timestamp: string; buildNumber: number; rank: string } | null = null;
  let lastUpdated = "";
  for (const file of files) {
    const { classifier = null, extension, timestamp, buildNumber } = file.metadata;
    if (!extension) continue;
    const key = `${classifier ?? ""}:${extension}`;
    const rank = buildKey(file);
    const entry =
      rank && timestamp && buildNumber
        ? {
            classifier,
            extension,
            value: `${version.slice(0, -"SNAPSHOT".length)}${timestamp}-${buildNumber}`,
            updated: timestamp.replace(".", ""),
            rank: `1:${rank}`,
          }
        : {
            classifier,
            extension,
            value: version,
            updated: lastUpdatedStamp(file.createdAt),
            rank: `0:${file.createdAt}`,
          };
    const current = entries.get(key);
    if (!current || entry.rank > current.rank) entries.set(key, entry);
    if (entry.updated > lastUpdated) lastUpdated = entry.updated;
    if (rank && timestamp && buildNumber && (!latest || rank > latest.rank)) {
      latest = { timestamp, buildNumber, rank };
    }
  }
  if (entries.size === 0) return null;
  const snapshotVersions = [...entries.values()]
    .sort(
      (a, b) =>
        (a.classifier ?? "").localeCompare(b.classifier ?? "") ||
        a.extension.localeCompare(b.extension),
    )
    .map(({ rank: _rank, ...entry }) => entry);
  return {
    groupId,
    artifactId,
    version,
    versioning: {
      ...(latest
        ? { snapshot: { timestamp: latest.timestamp, buildNumber: latest.buildNumber } }
        : {}),
      lastUpdated,
      snapshotVersions,
    },
  };
}

async function artifactLevel(
  db: DB,
  repo: Repository,
  groupId: string,
  artifactId: string,
): Promise<MavenMetadata | null> {
  if (!groupId) return null;
  const pkg = await getPackage(db, repo.id, `${groupId}:${artifactId}`);
  if (!pkg) return null;
  const versions = await listVersions(db, pkg.id);
  const files = await filesForVersions<MavenFileMeta>(
    db,
    repo.id,
    versions.map((v) => v.id),
  );
  const present: string[] = [];
  let lastUpdated = "";
  for (const version of versions) {
    const own = (files.get(version.id) ?? []).filter((f) => !isPending(f));
    if (own.length === 0) continue;
    present.push(version.version);
    for (const file of own) {
      const stamp = lastUpdatedStamp(file.createdAt);
      if (stamp > lastUpdated) lastUpdated = stamp;
    }
  }
  if (present.length === 0) return null;
  return { groupId, artifactId, versioning: versioningFor(present, lastUpdated) };
}

async function groupLevel(db: DB, repo: Repository, groupId: string): Promise<PluginEntry[]> {
  const prefix = `${groupId}:`;
  const rows = await db
    .selectFrom("packages")
    .select(["name", "metadata"])
    .where("repo_id", "=", repo.id)
    .where(sql<boolean>`substr(normalized_name, 1, ${prefix.length}) = ${prefix}`)
    .where(sql<boolean>`json_extract(metadata, '$.pluginPrefix') is not null`)
    .execute();
  const plugins: PluginEntry[] = [];
  for (const row of rows) {
    const meta = JSON.parse(row.metadata) as MavenPackageMeta;
    const artifactId = row.name.slice(prefix.length);
    if (!meta.pluginPrefix || artifactId.includes(":")) continue;
    plugins.push({ name: meta.pluginName, prefix: meta.pluginPrefix, artifactId });
  }
  return plugins.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

async function snapshotLevel(
  db: DB,
  repo: Repository,
  groupId: string,
  artifactId: string,
  version: string,
): Promise<MavenMetadata | null> {
  const pkg = await getPackage(db, repo.id, `${groupId}:${artifactId}`);
  if (!pkg) return null;
  const row = (await listVersions(db, pkg.id)).find((v) => v.version === version);
  if (!row) return null;
  const files = (await filesForVersions<MavenFileMeta>(db, repo.id, [row.id])).get(row.id) ?? [];
  return snapshotMetadata(
    groupId,
    artifactId,
    version,
    files.filter((f) => !isPending(f)),
  );
}

/**
 * The metadata document for a directory of a local repository. A directory
 * can be an artifact (`g/a`), a group holding plugins (`g`), both at once, or
 * a SNAPSHOT version (`g/a/1.0-SNAPSHOT`).
 */
export async function metadataForDir(
  db: DB,
  repo: Repository,
  dir: string,
): Promise<MavenMetadata | null> {
  const segments = dir.split("/");
  const last = segments[segments.length - 1]!;
  if (isSnapshot(last) && segments.length >= 3) {
    return snapshotLevel(
      db,
      repo,
      segments.slice(0, -2).join("."),
      segments[segments.length - 2]!,
      last,
    );
  }
  const artifact = await artifactLevel(db, repo, segments.slice(0, -1).join("."), last);
  const plugins = await groupLevel(db, repo, segments.join("."));
  if (!artifact && plugins.length === 0) return null;
  return { ...artifact, ...(plugins.length > 0 ? { plugins } : {}) };
}

async function writeDir(services: Services, repo: Repository, dir: string): Promise<void> {
  const path = `${dir}/${METADATA_FILE}`;
  const meta = await metadataForDir(services.db, repo, dir);
  if (meta) {
    await putDerived(
      services.db,
      services.bucket,
      repo.id,
      path,
      writeMetadataXml(meta),
      METADATA_CONTENT_TYPE,
    );
  } else {
    await deleteDerived(services.db, repo.id, path);
  }
}

async function reindexPackage(
  services: Services,
  repo: Repository,
  pkg: { id: string; name: string },
): Promise<void> {
  const db = services.db;
  const colon = pkg.name.lastIndexOf(":");
  const groupId = pkg.name.slice(0, colon);
  const artifactId = pkg.name.slice(colon + 1);
  const artifactDir = `${groupPath(groupId)}/${artifactId}`;
  const dirs = new Set<string>([artifactDir, groupPath(groupId)]);

  const keep = repo.config.retention?.keepLatest;
  const versions = await listVersions(db, pkg.id);
  const files = await filesForVersions<MavenFileMeta>(
    db,
    repo.id,
    versions.map((v) => v.id),
  );
  for (const version of versions) {
    if (!isSnapshot(version.version)) continue;
    dirs.add(`${artifactDir}/${version.version}`);
    if (keep) await pruneSnapshotBuilds(db, repo, files.get(version.id) ?? [], keep);
  }
  // Stale SNAPSHOT metadata of versions that no longer exist.
  for (const derived of await listDerived(db, repo.id, `${artifactDir}/`)) {
    const rest = derived.path.slice(artifactDir.length + 1).split("/");
    if (rest.length === 2 && rest[1] === METADATA_FILE && isSnapshot(rest[0]!)) {
      dirs.add(`${artifactDir}/${rest[0]}`);
    }
  }
  for (const dir of dirs) await writeDir(services, repo, dir);
}

export async function rebuildMaven(services: Services, repo: Repository): Promise<void> {
  if (repo.kind !== "local") return;
  const db = services.db;
  const dirty = await db
    .selectFrom("packages")
    .select(["id", "name", "updated_at"])
    .where("repo_id", "=", repo.id)
    .where(sql<boolean>`updated_at > coalesce(json_extract(metadata, '$.indexedAt'), '')`)
    .execute();
  for (const pkg of dirty) {
    await reindexPackage(services, repo, pkg);
    // A deploy that lands during this rebuild bumps updated_at past this mark.
    await db
      .updateTable("packages")
      .set({ metadata: sql`json_set(metadata, '$.indexedAt', ${pkg.updated_at})` })
      .where("id", "=", pkg.id)
      .execute();
  }
}

/** Marks a package dirty for the next rebuild (after its files are written). */
export async function touchPackage(db: DB, packageId: string): Promise<void> {
  await db
    .updateTable("packages")
    .set({ updated_at: nowIso() })
    .where("id", "=", packageId)
    .execute();
}
