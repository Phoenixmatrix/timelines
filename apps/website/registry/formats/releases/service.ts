import { requestCompaction } from "../../core/blob-compaction.ts";
import {
  assetNameError,
  renderSha256Sums,
  selectLatest,
  validProjectName,
  validTag,
} from "@gitmatrix/formats/releases";

import type { AccessControl } from "../../core/acl.ts";
import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { storeBlob, type BlobBody, type StoredBlob } from "../../core/blobs.ts";
import type { Services } from "../../core/context.ts";
import { nowIso } from "../../core/db.ts";
import { RegistryError } from "../../core/errors.ts";
import { ulid } from "../../core/ids.ts";
import { ensurePackage, getPackage } from "../../core/catalog.ts";
import { markPublishes, recordFile, recordPublish } from "../../core/provenance.ts";
import { resolveFeed, type Repository } from "../../core/repos.ts";
import type {
  CreateReleaseInput,
  ReleaseAssetDto,
  ReleaseDto,
  ReleaseListDto,
  ReleaseProjectDto,
  UpdateReleaseInput,
} from "./types.ts";

/**
 * Releases: per-repository projects, each with tagged releases (notes,
 * draft/prerelease flags) and downloadable assets. Shared by the protocol
 * routes, the REST API and the web UI's RPC; every function authorizes the
 * caller in `services`. Drafts exist only for callers with write access.
 */

const MAX_TITLE = 256;
const MAX_NOTES = 512 * 1024;
const MAX_LABEL = 256;
const LATEST = "latest";

export interface ReleaseRow {
  id: string;
  repo_id: string;
  project: string;
  tag: string;
  title: string;
  notes: string;
  draft: number;
  prerelease: number;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
}

export interface AssetRow {
  release_id: string;
  name: string;
  digest: string;
  size: number;
  content_type: string;
  label: string;
  downloads: number;
  created_by: string | null;
  created_at: string;
  r2_key: string;
}

interface Ctx {
  services: Services;
  repo: Repository;
  access: AccessControl;
  canWrite: boolean;
}

async function context(
  services: Services,
  repoKey: string,
  action: "read" | "write" | "delete" = "read",
): Promise<Ctx> {
  const repo = await resolveFeed(services, "releases", repoKey);
  if (!repo || repo.format !== "releases") {
    throw RegistryError.notFound(`Repository ${repoKey} not found`);
  }
  const access = await services.access();
  await access.require(repo, action);
  return { services, repo, access, canWrite: await access.can(repo, "write") };
}

/** Throws unless `project` could be a project name; reads answer 404, writes 400. */
function checkProject(project: string, forWrite = false): void {
  if (validProjectName(project)) return;
  if (forWrite) {
    throw new RegistryError(
      "name_invalid",
      "Project names are 1-100 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  }
  throw RegistryError.notFound(`Project ${project} not found`);
}

function checkTag(tag: string): void {
  if (!validTag(tag)) {
    throw new RegistryError(
      "name_invalid",
      "Tags are 1-128 letters, digits, '.', '_', '+' or '-', starting with a letter or digit (and not 'latest')",
    );
  }
}

function checkAssetName(name: string): void {
  const error = assetNameError(name);
  if (error) throw new RegistryError("name_invalid", error);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function releaseBaseUrl(services: Services, repoKey: string, project: string, tag: string) {
  return `${services.baseUrl}/releases/${enc(repoKey)}/${enc(project)}/${enc(tag)}`;
}

function assetDto(ctx: Ctx, release: ReleaseRow, asset: AssetRow): ReleaseAssetDto {
  return {
    name: asset.name,
    label: asset.label,
    size: asset.size,
    sha256: asset.digest.slice("sha256:".length),
    contentType: asset.content_type,
    downloads: asset.downloads,
    createdBy: asset.created_by,
    createdAt: asset.created_at,
    browserDownloadUrl: `${releaseBaseUrl(ctx.services, ctx.repo.key, release.project, release.tag)}/download/${enc(asset.name)}`,
  };
}

async function assetsFor(
  services: Services,
  releaseIds: string[],
): Promise<Map<string, AssetRow[]>> {
  const out = new Map<string, AssetRow[]>();
  for (let i = 0; i < releaseIds.length; i += 90) {
    const rows = await services.db
      .selectFrom("release_assets as a")
      .innerJoin("blobs as b", "b.digest", "a.digest")
      .selectAll("a")
      .select("b.r2_key")
      .where("a.release_id", "in", releaseIds.slice(i, i + 90))
      .orderBy("a.name")
      .execute();
    for (const row of rows) {
      const list = out.get(row.release_id) ?? [];
      list.push(row);
      out.set(row.release_id, list);
    }
  }
  return out;
}

async function toDtos(ctx: Ctx, releases: ReleaseRow[], latestId: string | null) {
  const assets = await assetsFor(
    ctx.services,
    releases.map((r) => r.id),
  );
  return releases.map((release): ReleaseDto => ({
    id: release.id,
    repo: ctx.repo.key,
    project: release.project,
    tag: release.tag,
    title: release.title,
    notes: release.notes,
    draft: release.draft === 1,
    prerelease: release.prerelease === 1,
    latest: release.id === latestId,
    createdBy: release.created_by,
    createdAt: release.created_at,
    publishedAt: release.published_at,
    assets: (assets.get(release.id) ?? []).map((a) => assetDto(ctx, release, a)),
    checksumsUrl: `${releaseBaseUrl(ctx.services, ctx.repo.key, release.project, release.tag)}/SHA256SUMS`,
  }));
}

async function latestRow(ctx: Ctx, project: string): Promise<ReleaseRow | null> {
  // Publication-time ties are rare; a small window is enough for the semver tie-break.
  const rows = await ctx.services.db
    .selectFrom("releases")
    .selectAll()
    .where("repo_id", "=", ctx.repo.id)
    .where("project", "=", project)
    .where("draft", "=", 0)
    .where("prerelease", "=", 0)
    .where("published_at", "is not", null)
    .orderBy("published_at", "desc")
    .limit(25)
    .execute();
  const latest = selectLatest(
    rows.map((row) => ({
      row,
      tag: row.tag,
      draft: false,
      prerelease: false,
      publishedAt: row.published_at,
    })),
  );
  return latest?.row ?? null;
}

async function rowByTag(ctx: Ctx, project: string, tag: string): Promise<ReleaseRow | null> {
  const row = await ctx.services.db
    .selectFrom("releases")
    .selectAll()
    .where("repo_id", "=", ctx.repo.id)
    .where("project", "=", project)
    .where("tag", "=", tag)
    .executeTakeFirst();
  if (!row || (row.draft === 1 && !ctx.canWrite)) return null;
  return row;
}

/** A visible release by tag, or the latest one for `latest`. */
async function findRelease(ctx: Ctx, project: string, tag: string): Promise<ReleaseRow> {
  checkProject(project);
  const row = tag === LATEST ? await latestRow(ctx, project) : await rowByTag(ctx, project, tag);
  if (!row) {
    throw RegistryError.notFound(
      tag === LATEST
        ? `${project} has no published release`
        : `Release ${project}@${tag} not found`,
    );
  }
  return row;
}

async function releaseDto(ctx: Ctx, row: ReleaseRow): Promise<ReleaseDto> {
  const latest = await latestRow(ctx, row.project);
  return (await toDtos(ctx, [row], latest?.id ?? null))[0]!;
}

// ---------------------------------------------------------------------------
// Reads

export async function listProjects(
  services: Services,
  repoKey: string,
): Promise<ReleaseProjectDto[]> {
  const ctx = await context(services, repoKey);
  let query = services.db
    .selectFrom("releases")
    .select((eb) => [
      "project",
      eb.fn.countAll<number>().as("count"),
      eb.fn.max(eb.fn.coalesce("published_at", "created_at")).as("updated_at"),
    ])
    .where("repo_id", "=", ctx.repo.id)
    .groupBy("project")
    .orderBy("project")
    .limit(1000);
  if (!ctx.canWrite) query = query.where("draft", "=", 0);
  const out: ReleaseProjectDto[] = [];
  for (const row of await query.execute()) {
    const latest = await latestRow(ctx, row.project);
    out.push({
      name: row.project,
      releaseCount: Number(row.count),
      latest: latest ? (await toDtos(ctx, [latest], latest.id))[0]! : null,
      updatedAt: String(row.updated_at),
    });
  }
  return out;
}

export async function listReleases(
  services: Services,
  repoKey: string,
  project: string,
  options: { page?: number; perPage?: number } = {},
): Promise<ReleaseListDto> {
  const ctx = await context(services, repoKey);
  checkProject(project);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? 30)));
  let base = services.db
    .selectFrom("releases")
    .where("repo_id", "=", ctx.repo.id)
    .where("project", "=", project);
  if (!ctx.canWrite) base = base.where("draft", "=", 0);
  const total = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0,
  );
  // Drafts (no publication time yet) first, then newest published, like GitHub.
  const rows = await base
    .selectAll()
    .orderBy((eb) => eb.fn.coalesce("published_at", eb.val("9999")), "desc")
    .orderBy("created_at", "desc")
    .limit(perPage)
    .offset((page - 1) * perPage)
    .execute();
  const latest = await latestRow(ctx, project);
  return { releases: await toDtos(ctx, rows, latest?.id ?? null), total, page, perPage };
}

export async function getRelease(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
): Promise<ReleaseDto> {
  const ctx = await context(services, repoKey);
  return releaseDto(ctx, await findRelease(ctx, project, tag));
}

export function getLatestRelease(
  services: Services,
  repoKey: string,
  project: string,
): Promise<ReleaseDto> {
  return getRelease(services, repoKey, project, LATEST);
}

// ---------------------------------------------------------------------------
// Writes

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw RegistryError.badRequest(`${field} must be a string`);
  if (value.length > max) throw RegistryError.badRequest(`${field} is longer than ${max}`);
  return value;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw RegistryError.badRequest(`${field} must be true or false`);
  return value;
}

async function insertRelease(
  ctx: Ctx,
  project: string,
  input: CreateReleaseInput,
): Promise<ReleaseRow> {
  checkProject(project, true);
  if (typeof input?.tag !== "string") throw RegistryError.badRequest("tag is required");
  checkTag(input.tag);
  // The project is the package: gate the publish before writing.
  const pkg = await ensurePackage(ctx.services.db, ctx.repo.id, project, project.toLowerCase(), {
    kind: "release",
  });
  const draft = flag(input.draft, "draft") ?? false;
  const now = nowIso();
  const row: ReleaseRow = {
    id: ulid(),
    repo_id: ctx.repo.id,
    project,
    tag: input.tag,
    title: text(input.title, "title", MAX_TITLE) || input.tag,
    notes: text(input.notes, "notes", MAX_NOTES) ?? "",
    draft: draft ? 1 : 0,
    prerelease: flag(input.prerelease, "prerelease") ? 1 : 0,
    created_by: principalOf(ctx.access.actor),
    created_at: now,
    published_at: draft ? null : now,
  };
  const result = await ctx.services.db
    .insertInto("releases")
    .values(row)
    .onConflict((oc) => oc.columns(["repo_id", "project", "tag"]).doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
    throw RegistryError.conflict(`Release ${project}@${input.tag} already exists`);
  }
  await recordPublish(ctx.services.db, {
    packageId: pkg.id,
    repoId: ctx.repo.id,
    version: input.tag,
    action: "releases.create",
  });
  await audit(ctx.services.db, ctx.access.actor, "releases.create", {
    repoId: ctx.repo.id,
    target: `${project}@${input.tag}`,
    detail: { draft, prerelease: row.prerelease === 1 },
  });
  return row;
}

export async function createRelease(
  services: Services,
  repoKey: string,
  project: string,
  input: CreateReleaseInput,
): Promise<ReleaseDto> {
  const ctx = await context(services, repoKey, "write");
  return releaseDto(ctx, await insertRelease(ctx, project, input));
}

export async function updateRelease(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
  patch: UpdateReleaseInput,
): Promise<ReleaseDto> {
  const ctx = await context(services, repoKey, "write");
  const row = await findRelease(ctx, project, tag);
  const title = text(patch?.title, "title", MAX_TITLE);
  const notes = text(patch?.notes, "notes", MAX_NOTES);
  const draft = flag(patch?.draft, "draft");
  const prerelease = flag(patch?.prerelease, "prerelease");
  const next: ReleaseRow = {
    ...row,
    title: title === undefined ? row.title : title || row.tag,
    notes: notes ?? row.notes,
    prerelease: prerelease === undefined ? row.prerelease : prerelease ? 1 : 0,
    draft: draft === undefined ? row.draft : draft ? 1 : 0,
  };
  const published = row.draft === 1 && next.draft === 0;
  if (published) next.published_at = nowIso();
  if (next.draft === 1) next.published_at = null;
  await services.db
    .updateTable("releases")
    .set({
      title: next.title,
      notes: next.notes,
      draft: next.draft,
      prerelease: next.prerelease,
      published_at: next.published_at,
    })
    .where("id", "=", row.id)
    .execute();
  await audit(services.db, ctx.access.actor, published ? "releases.publish" : "releases.update", {
    repoId: ctx.repo.id,
    target: `${row.project}@${row.tag}`,
    detail: {
      fields: Object.entries({ title, notes, draft, prerelease })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k),
    },
  });
  return releaseDto(ctx, next);
}

export async function deleteRelease(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
): Promise<void> {
  const ctx = await context(services, repoKey, "delete");
  if (tag === LATEST) throw RegistryError.badRequest("Name the release to delete by its tag");
  const row = await findRelease(ctx, project, tag);
  await services.db.deleteFrom("release_assets").where("release_id", "=", row.id).execute();
  await services.db.deleteFrom("releases").where("id", "=", row.id).execute();
  const pkg = await getPackage(services.db, ctx.repo.id, row.project.toLowerCase());
  if (pkg) await markPublishes(services.db, pkg.id, row.tag, "deleted");
  await audit(services.db, ctx.access.actor, "releases.delete", {
    repoId: ctx.repo.id,
    target: `${row.project}@${row.tag}`,
  });
}

export interface UploadAssetOptions {
  contentType?: string;
  label?: string;
  /** Expected SHA-256 (hex) of the body; the upload fails on mismatch. */
  sha256?: string;
  /** Replace an existing asset (needs delete permission). */
  overwrite?: boolean;
  /** Create the release, published, if the tag does not exist yet. */
  createRelease?: boolean;
}

async function getAsset(services: Services, releaseId: string, name: string) {
  return (
    (await services.db
      .selectFrom("release_assets as a")
      .innerJoin("blobs as b", "b.digest", "a.digest")
      .selectAll("a")
      .select("b.r2_key")
      .where("a.release_id", "=", releaseId)
      .where("a.name", "=", name)
      .executeTakeFirst()) ?? null
  );
}

/** Streams `body` into a release asset. Returns the asset and whether it was new. */
export async function uploadAsset(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
  name: string,
  body: BlobBody,
  options: UploadAssetOptions = {},
): Promise<{ asset: ReleaseAssetDto; created: boolean }> {
  const ctx = await context(services, repoKey, "write");
  checkAssetName(name);
  const label = text(options.label, "label", MAX_LABEL) ?? "";

  let release: ReleaseRow;
  if (options.createRelease && tag !== LATEST) {
    checkProject(project, true);
    checkTag(tag);
    release =
      (await rowByTag(ctx, project, tag)) ??
      (await insertRelease(ctx, project, { tag }).catch(async (error: unknown) => {
        // Lost a race with a concurrent one-shot upload for the same tag.
        const row = await rowByTag(ctx, project, tag);
        if (row) return row;
        throw error;
      }));
  } else {
    release = await findRelease(ctx, project, tag);
  }

  const pkg = await ensurePackage(
    services.db,
    ctx.repo.id,
    release.project,
    release.project.toLowerCase(),
    { kind: "release" },
  );
  const existing = await getAsset(services, release.id, name);
  const replace = Boolean(existing && options.overwrite);
  if (replace) await ctx.access.require(ctx.repo, "delete");
  const blob: StoredBlob = await storeBlob(services.db, services.bucket, body, {
    contentType: options.contentType,
    maxBytes: ctx.repo.config.maxUploadBytes,
    expect: { sha256: options.sha256 },
  });
  const contentType = options.contentType || "application/octet-stream";
  const values = {
    release_id: release.id,
    name,
    digest: blob.digest,
    size: blob.size,
    content_type: contentType,
    label,
    created_by: principalOf(ctx.access.actor),
    created_at: nowIso(),
  };
  let created = true;
  if (replace) {
    await services.db
      .insertInto("release_assets")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["release_id", "name"]).doUpdateSet({
          digest: values.digest,
          size: values.size,
          content_type: values.content_type,
          label: values.label,
          created_by: values.created_by,
          created_at: values.created_at,
        }),
      )
      .execute();
    created = false;
  } else {
    const result = await services.db
      .insertInto("release_assets")
      .values(values)
      .onConflict((oc) => oc.columns(["release_id", "name"]).doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
      const current = await getAsset(services, release.id, name);
      // Re-uploading identical bytes is idempotent.
      if (current?.digest !== blob.digest) {
        throw RegistryError.conflict(
          `${name} already exists in ${release.project}@${release.tag}; retry with ?overwrite=1 (needs delete permission)`,
        );
      }
      created = false;
    }
  }
  await requestCompaction(services);
  await recordFile(
    services.db,
    { packageId: pkg.id, repoId: ctx.repo.id, version: release.tag, action: "releases.publish" },
    blob,
  );
  await audit(services.db, ctx.access.actor, "releases.asset.upload", {
    repoId: ctx.repo.id,
    target: `${release.project}@${release.tag}/${name}`,
    detail: { digest: blob.digest, size: blob.size, replaced: Boolean(existing) },
  });
  const row = (await getAsset(services, release.id, name))!;
  return { asset: assetDto(ctx, release, row), created };
}

export async function deleteAsset(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
  name: string,
): Promise<void> {
  const ctx = await context(services, repoKey, "delete");
  const release = await findRelease(ctx, project, tag);
  const result = await services.db
    .deleteFrom("release_assets")
    .where("release_id", "=", release.id)
    .where("name", "=", name)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) {
    throw RegistryError.notFound(`${name} not found in ${release.project}@${release.tag}`);
  }
  await audit(services.db, ctx.access.actor, "releases.asset.delete", {
    repoId: ctx.repo.id,
    target: `${release.project}@${release.tag}/${name}`,
  });
}

// ---------------------------------------------------------------------------
// Downloads (protocol routes)

/** The asset to serve for a download URL, with the release it belongs to. */
export async function resolveAsset(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
  name: string,
): Promise<{ release: ReleaseRow; asset: AssetRow }> {
  const ctx = await context(services, repoKey);
  const release = await findRelease(ctx, project, tag);
  const asset = await getAsset(services, release.id, name);
  if (!asset)
    throw RegistryError.notFound(`${name} not found in ${release.project}@${release.tag}`);
  return { release, asset };
}

export async function countAssetDownload(
  services: Services,
  releaseId: string,
  name: string,
): Promise<void> {
  await services.db
    .updateTable("release_assets")
    .set((eb) => ({ downloads: eb("downloads", "+", 1) }))
    .where("release_id", "=", releaseId)
    .where("name", "=", name)
    .execute();
}

/** `SHA256SUMS` for a release's assets. */
export async function checksums(
  services: Services,
  repoKey: string,
  project: string,
  tag: string,
): Promise<{ release: ReleaseRow; text: string }> {
  const ctx = await context(services, repoKey);
  const release = await findRelease(ctx, project, tag);
  const assets = (await assetsFor(services, [release.id])).get(release.id) ?? [];
  return {
    release,
    text: renderSha256Sums(assets.map((a) => ({ name: a.name, sha256: a.digest.slice(7) }))),
  };
}
