import { Kysely, type Generated } from "kysely";
import { D1Dialect } from "kysely-d1";

/**
 * Handwritten schema for Kysely over the registry's own D1 database
 * (REGISTRY_DB). The SQL migrations in `registry/migrations/` are the source of
 * truth; every migration updates this interface in the same change. JSON
 * columns are TEXT and parsed at the edges. People, tokens and permissions
 * live in gitmatrix's database (DB), not here.
 */
export interface Database {
  archive_caches: {
    id: string;
    repo_id: string;
    digest: string;
    r2_key: string;
    ready: Generated<number>;
  };
  archive_members: {
    cache_id: string;
    path: string;
    parent: string;
    kind: "file" | "directory";
    offset: number;
    size: number;
    digest: string | null;
  };
  repositories: {
    id: string;
    key: string;
    format: string;
    owner_id: string;
    kind: "local" | "remote" | "virtual";
    visibility: "public" | "internal" | "private";
    description: Generated<string>;
    config: Generated<string>;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  };
  virtual_members: {
    virtual_id: string;
    member_id: string;
    position: number;
    include_patterns: Generated<string>;
    exclude_patterns: Generated<string>;
  };
  blobs: {
    digest: string;
    r2_key: string;
    size: number;
    md5: string | null;
    sha1: string | null;
    sha512: string | null;
    created_at: string;
  };
  blob_representations: {
    key: string;
    digest: string;
    base_key: string | null;
    state: Generated<"live" | "retired" | "deleting">;
    retired_at: string | null;
  };
  artifact_publications: {
    id: Generated<number>;
    repo_id: string;
    lineage: string;
    version: string;
    source: string;
    digest: string;
    created_at: string;
    status: Generated<"pending" | "done" | "gone">;
    snapshot_key: string | null;
  };
  artifact_backfill: { name: string; cursor: Generated<number>; done: Generated<number> };
  artifact_hot_versions: {
    repo_id: string;
    lineage: string;
    version: string;
    publication_id: number;
    created_at: string;
  };
  blob_compactions: {
    id: string;
    publication_id: number;
    digest: string;
    source_key: string;
    base_key: string | null;
    size: number;
    frame: Generated<number>;
    hash_state: string;
    full_bytes: Generated<number>;
    delta_bytes: Generated<number>;
    phase: Generated<"build" | "cleanup">;
    cleanup_cursor: string | null;
    result_key: string | null;
    fence: string | null;
    lease_until: Generated<number>;
    updated_at: number;
    created_at: number;
  };
  blob_compaction_frames: {
    work_id: string;
    frame: number;
    full_frame: string;
    delta_frame: string | null;
  };
  packages: {
    id: string;
    repo_id: string;
    name: string;
    normalized_name: string;
    metadata: Generated<string>;
    created_at: string;
    updated_at: string;
  };
  versions: {
    id: string;
    package_id: string;
    version: string;
    metadata: Generated<string>;
    status: Generated<"active" | "yanked" | "deprecated">;
    status_reason: string | null;
    published_by: string | null;
    created_at: string;
  };
  files: {
    id: string;
    repo_id: string;
    path: string;
    version_id: string | null;
    digest: string;
    size: number;
    content_type: Generated<string>;
    metadata: Generated<string>;
    downloads: Generated<number>;
    created_by: string | null;
    created_at: string;
  };
  dist_tags: { package_id: string; tag: string; version: string; updated_at: string };
  oci_blob_links: { repo_id: string; name: string; digest: string; created_at: string };
  oci_manifests: {
    repo_id: string;
    name: string;
    digest: string;
    media_type: string;
    artifact_type: string | null;
    subject: string | null;
    size: number;
    annotations: Generated<string>;
    created_at: string;
  };
  oci_manifest_refs: { repo_id: string; name: string; manifest: string; ref: string };
  oci_tags: { repo_id: string; name: string; tag: string; digest: string; updated_at: string };
  releases: {
    id: string;
    repo_id: string;
    project: string;
    tag: string;
    title: Generated<string>;
    notes: Generated<string>;
    draft: Generated<number>;
    prerelease: Generated<number>;
    created_by: string | null;
    created_at: string;
    published_at: string | null;
  };
  release_assets: {
    release_id: string;
    name: string;
    digest: string;
    size: number;
    content_type: string;
    label: Generated<string>;
    downloads: Generated<number>;
    created_by: string | null;
    created_at: string;
  };
  derived_files: {
    repo_id: string;
    path: string;
    r2_key: string;
    size: number;
    sha256: string;
    content_type: string;
    generation: Generated<number>;
    updated_at: string;
  };
  remote_entries: {
    repo_id: string;
    path: string;
    status: number;
    digest: string | null;
    content_type: string | null;
    etag: string | null;
    last_modified: string | null;
    fetched_at: string;
    expires_at: string;
  };
  signing_keys: {
    repo_id: string;
    algorithm: string;
    fingerprint: string;
    public_key: string;
    private_key_sealed: string;
    created_at: string;
  };
  package_sources: {
    package_id: string;
    git_repo_id: string;
    granted_by: string | null;
    granted_at: string;
  };
  publishes: {
    id: string;
    feed_id: string;
    format: string;
    package_id: string;
    version: string;
    digest: string | null;
    size: number | null;
    action: string;
    status: Generated<"active" | "yanked" | "deprecated" | "deleted">;
    git_repo_id: string | null;
    commit_oid: string | null;
    ref: string | null;
    off_default_branch: Generated<number>;
    ci_run_id: string | null;
    ci_job_id: string | null;
    run_number: number | null;
    actor: string;
    actor_label: string;
    via: string;
    at: string;
  };
  audit_log: {
    id: string;
    at: string;
    actor: string;
    action: string;
    repo_id: string | null;
    target: string | null;
    detail: Generated<string>;
  };
}

export type DB = Kysely<Database>;

export function createDb(d1: D1Database): DB {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }) });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
