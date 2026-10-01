import {
  compareVersions,
  normalizeName,
  parseProjectHtml,
  parseProjectJson,
  SIMPLE_HTML,
  SIMPLE_JSON,
  type SimpleFile,
  type SimpleProject,
} from "@gitmatrix/formats/pypi";

import {
  filesForVersions,
  getPackage,
  listPackages,
  listVersions,
  type FileRow,
} from "../../core/catalog.ts";
import type { Services } from "../../core/context.ts";
import { cachedMetadata, upstreamBase } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { allMatches, firstMatch, isPinned, memberAllows, members } from "../../core/virtual.ts";

/** Per-file metadata stored on `files` rows of PyPI repositories. */
export interface PypiFileMeta {
  kind: "dist" | "core-metadata";
  filetype?: string;
  pyversion?: string;
  requiresPython?: string | null;
  blake2_256?: string | null;
  /** sha256 of the extracted `.metadata` file (PEP 658). */
  coreMetadataSha256?: string;
}

export interface PypiVersionMeta {
  name: string;
  version: string;
  summary?: string | null;
  requiresPython?: string | null;
  [key: string]: unknown;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+!~-]*$/;

/** A string usable as one URL path segment in our own routes (no traversal). */
export function safeSegment(value: string): boolean {
  return value.length <= 255 && SAFE_SEGMENT.test(value) && !value.includes("..");
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repoUrl(services: Services, key: string): string {
  return `${services.baseUrl}/pypi/${key}`;
}

// ---------------------------------------------------------------------------
// Local

export async function localProject(
  services: Services,
  repo: Repository,
  normalized: string,
  urlKey: string,
): Promise<SimpleProject | null> {
  const pkg = await getPackage(services.db, repo.id, normalized);
  if (!pkg) return null;
  const versions = await listVersions<PypiVersionMeta>(services.db, pkg.id);
  if (versions.length === 0) return null;
  const byVersion = await filesForVersions<PypiFileMeta>(
    services.db,
    repo.id,
    versions.map((v) => v.id),
  );
  const files: SimpleFile[] = [];
  const sorted = [...versions].sort((a, b) => compareVersions(a.version, b.version));
  for (const version of sorted) {
    const yanked = version.status === "yanked" ? version.statusReason || true : false;
    const dists = (byVersion.get(version.id) ?? []).filter((f) => f.metadata.kind === "dist");
    for (const file of dists)
      files.push(localFile(services, urlKey, file, yanked, version.metadata));
  }
  return { name: pkg.name, files, versions: sorted.map((v) => v.version) };
}

function localFile(
  services: Services,
  urlKey: string,
  file: FileRow<PypiFileMeta>,
  yanked: boolean | string,
  versionMeta: PypiVersionMeta,
): SimpleFile {
  return {
    filename: file.path.split("/").pop()!,
    url: `${repoUrl(services, urlKey)}/packages/${encodePath(file.path)}`,
    hashes: { sha256: file.digest.slice("sha256:".length) },
    requiresPython: file.metadata.requiresPython ?? versionMeta.requiresPython ?? null,
    coreMetadata: file.metadata.coreMetadataSha256
      ? { sha256: file.metadata.coreMetadataSha256 }
      : null,
    yanked,
    size: file.size,
    uploadTime: file.createdAt,
  };
}

export async function localProjectNames(services: Services, repo: Repository): Promise<string[]> {
  const names: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const batch = await listPackages(services.db, repo.id, { limit: 1000, after });
    names.push(...batch.map((p) => p.name));
    if (batch.length < 1000) break;
    after = batch.at(-1)!.normalizedName;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Remote

const UPSTREAM_ACCEPT = `${SIMPLE_JSON}, ${SIMPLE_HTML};q=0.2, text/html;q=0.1`;

/**
 * The upstream index root: `https://pypi.org` becomes `https://pypi.org/simple`;
 * an upstream URL that already ends in `simple` is used as is.
 */
export function upstreamIndex(repo: Repository): string {
  const base = upstreamBase(repo);
  return /(^|[/+])simple$/.test(new URL(base).pathname.replace(/\/+$/, ""))
    ? base
    : `${base}/simple`;
}

/** The upstream project page, parsed, with upstream URLs. */
export async function upstreamProject(
  services: Services,
  repo: Repository,
  normalized: string,
): Promise<SimpleProject | null> {
  const pageUrl = `${upstreamIndex(repo)}/${encodeURIComponent(normalized)}/`;
  const meta = await cachedMetadata(services, repo, `simple/${normalized}/`, {
    url: new URL(pageUrl),
    headers: { accept: UPSTREAM_ACCEPT },
  });
  if (meta.status !== 200) return null;
  try {
    const json = meta.contentType.includes("json") || meta.text.trimStart().startsWith("{");
    const project = json
      ? parseProjectJson(meta.text, pageUrl)
      : parseProjectHtml(meta.text, pageUrl, normalized);
    project.files = project.files.filter((f) => safeSegment(f.filename));
    return project;
  } catch {
    return null;
  }
}

export function remoteFileUrl(
  services: Services,
  urlKey: string,
  normalized: string,
  file: SimpleFile,
): string {
  const sha =
    file.hashes.sha256 && /^[0-9a-f]{64}$/.test(file.hashes.sha256) ? file.hashes.sha256 : "_";
  return `${repoUrl(services, urlKey)}/remote-files/${encodeURIComponent(normalized)}/${sha}/${encodeURIComponent(file.filename)}`;
}

export async function remoteProject(
  services: Services,
  repo: Repository,
  normalized: string,
  urlKey: string,
): Promise<SimpleProject | null> {
  const upstream = await upstreamProject(services, repo, normalized);
  if (!upstream) return null;
  return {
    name: upstream.name || normalized,
    versions: upstream.versions,
    files: upstream.files.map((file) => ({
      ...file,
      url: remoteFileUrl(services, urlKey, normalized, file),
    })),
  };
}

/** Projects this remote has cached (the upstream's full list is not proxied). */
export async function remoteProjectNames(services: Services, repo: Repository): Promise<string[]> {
  const rows = await services.db
    .selectFrom("remote_entries")
    .select("path")
    .where("repo_id", "=", repo.id)
    .where("status", "=", 200)
    .where("path", "like", "upstream/simple/%/")
    .execute();
  return rows.map((r) => r.path.slice("upstream/simple/".length, -1)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Any kind

function mergeProjects(pages: SimpleProject[]): SimpleProject {
  const seen = new Set<string>();
  const files: SimpleFile[] = [];
  let versions: Set<string> | null = new Set();
  for (const page of pages) {
    for (const file of page.files) {
      if (seen.has(file.filename)) continue;
      seen.add(file.filename);
      files.push(file);
    }
    if (page.versions && versions) for (const v of page.versions) versions.add(v);
    else versions = null;
  }
  return {
    name: pages[0]!.name,
    files,
    versions: versions ? [...versions].sort(compareVersions) : undefined,
  };
}

/** The project page as `repo` serves it, with links through `urlKey`. */
export async function resolveProject(
  services: Services,
  repo: Repository,
  normalized: string,
  urlKey = repo.key,
): Promise<SimpleProject | null> {
  if (repo.kind === "local") return localProject(services, repo, normalized, urlKey);
  if (repo.kind === "remote") return remoteProject(services, repo, normalized, urlKey);
  const probe = (member: Repository) => resolveProject(services, member, normalized, urlKey);
  if (repo.config.mergeVersions) {
    const pages = await allMatches(services, repo, normalized, probe);
    return pages.length ? mergeProjects(pages.map((p) => p.value)) : null;
  }
  return (await firstMatch(services, repo, normalized, probe))?.value ?? null;
}

export async function projectNames(services: Services, repo: Repository): Promise<string[]> {
  let names: string[];
  if (repo.kind === "local") names = await localProjectNames(services, repo);
  else if (repo.kind === "remote") names = await remoteProjectNames(services, repo);
  else {
    const access = await services.access();
    names = [];
    for (const member of await members(services, repo)) {
      if (!(await access.can(member.repo, "read"))) continue;
      for (const name of await projectNames(services, member.repo)) {
        const normalized = normalizeName(name);
        if (!memberAllows(member, normalized)) continue;
        if (member.repo.kind === "remote" && isPinned(repo, normalized)) continue;
        names.push(name);
      }
    }
  }
  const unique = new Map<string, string>();
  for (const name of names)
    if (!unique.has(normalizeName(name))) unique.set(normalizeName(name), name);
  return [...unique.values()].sort((a, b) => (normalizeName(a) < normalizeName(b) ? -1 : 1));
}
