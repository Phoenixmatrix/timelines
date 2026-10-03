import { digestHex } from "@gitmatrix/formats/hash";
import {
  checkDigest,
  EMPTY_JSON_DIGEST,
  isDigestReference,
  isValidTag,
  ManifestError,
  MAX_MANIFEST_BYTES,
  MEDIA_TYPES,
  nextLink,
  paginate,
  parseContentRange,
  parseManifest,
  parsePageParams,
  referrersIndex,
  requiredBlobs,
  referencedDigests,
  uploadRange,
  type PageParams,
  type ReferrerDescriptor,
} from "@gitmatrix/formats/oci";
import { Hono } from "hono";

import type { Action } from "../../core/acl.ts";
import { audit } from "../../core/audit.ts";
import { getBlob, PART_SIZE, serveBlob, storeBlob, type StoredBlob } from "../../core/blobs.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { ensurePackage, getPackage } from "../../core/catalog.ts";
import { markPublishes, movesLatest, recordPublish } from "../../core/provenance.ts";
import { getRepoByKey, resolveFeed, listRepos, type Repository } from "../../core/repos.ts";
import { candidates, deployTarget, firstMatch } from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";
import { API_VERSION_HEADER, OciError, renderOciError } from "./errors.ts";
import { splitName, type OciName } from "./names.ts";
import { parseRoute, type Route } from "./paths.ts";
import * as store from "./store.ts";
import { tokenEndpoint } from "./token.ts";
import {
  append,
  claim,
  commit,
  discard,
  finish,
  loadUpload,
  release,
  startUpload,
  writeTail,
} from "./uploads.ts";
import {
  remoteBlob,
  remoteManifest,
  remoteReferrers,
  remoteTags,
  resolveRemoteTag,
  upstreamImage,
} from "./upstream.ts";

/**
 * OCI Distribution Spec v1.1 and the Docker Registry HTTP API v2 at `/v2`.
 * Image names are `<repoKey>/<image path>`: the first segment picks the
 * gitmatrix repository, the rest is the image within it.
 */

// --- Names, repositories and authorization ---------------------------------

function nameOf(raw: string): OciName {
  const name = splitName(raw);
  if (!name) {
    throw new OciError(
      "NAME_INVALID",
      `Invalid repository name "${raw}" (want <repository>/<image>)`,
    );
  }
  return name;
}

function digestOf(value: string | null | undefined): string {
  if (!value) throw new OciError("DIGEST_INVALID", "A digest is required");
  const check = checkDigest(value);
  if (check === "unsupported") {
    throw new OciError("UNSUPPORTED", `Only sha256 digests are supported, not ${value}`, {
      status: 400,
    });
  }
  if (check === "invalid") throw new OciError("DIGEST_INVALID", `Invalid digest ${value}`);
  return value;
}

/** Unknown repositories look like private ones to anonymous callers (no existence leak). */
async function repoFor(c: AppContext, name: OciName): Promise<Repository> {
  const svc = services(c);
  const repo = await resolveFeed(svc, "oci", name.repoKey);
  if (!repo || repo.format !== "oci") {
    if ((await svc.actor()).kind === "anonymous") throw RegistryError.unauthorized();
    throw new OciError("NAME_UNKNOWN", `Repository ${name.repoKey} not found`);
  }
  c.set("repo", repo);
  return repo;
}

/**
 * A registry token missing a grant gets 401 + insufficient_scope, so the
 * client fetches a token for the scope in the challenge (docker, containerd).
 */
async function authorize(c: AppContext, repo: Repository, action: Action, resource: string) {
  const access = await services(c).access();
  try {
    await access.require(repo, action, resource);
  } catch (error) {
    if (
      error instanceof RegistryError &&
      error.code === "denied" &&
      access.actor.via === "registry"
    ) {
      throw new OciError("DENIED", "requested access to the resource is denied", {
        status: 401,
        insufficientScope: true,
      });
    }
    throw error;
  }
}

async function readable(c: AppContext, name: OciName): Promise<Repository> {
  const repo = await repoFor(c, name);
  await authorize(c, repo, "read", name.full);
  return repo;
}

/** The local repository that receives writes to `name` (a virtual's deploy target). */
async function writable(
  c: AppContext,
  name: OciName,
  action: "write" | "delete",
): Promise<Repository> {
  let repo = await repoFor(c, name);
  if (repo.kind === "virtual") {
    const target = await deployTarget(services(c), repo);
    if (!target) {
      throw new OciError("UNSUPPORTED", `${repo.key} has no default deploy repository`);
    }
    repo = target;
  }
  if (repo.kind !== "local") {
    throw new OciError("UNSUPPORTED", `${repo.key} is a read-only remote repository`);
  }
  await authorize(c, repo, action, `${repo.key}/${name.image}`);
  return repo;
}

// --- Resolution across local, remote and virtual repositories --------------

interface ManifestHit {
  digest: string;
  mediaType: string;
  blob: StoredBlob;
}

async function findManifest(
  c: AppContext,
  repo: Repository,
  image: string,
  reference: string,
): Promise<ManifestHit | null> {
  const svc = services(c);
  if (repo.kind === "virtual") {
    const hit = await firstMatch(svc, repo, image, (m) => findManifest(c, m, image, reference));
    return hit?.value ?? null;
  }
  const byDigest = isDigestReference(reference);
  if (repo.kind === "remote") {
    const digest = byDigest
      ? reference
      : (await resolveRemoteTag(svc, repo, image, reference))?.digest;
    if (!digest) return null;
    const found = await remoteManifest(svc, repo, image, digest);
    return found ? { digest, mediaType: found.mediaType, blob: found.blob } : null;
  }
  const digest = byDigest ? reference : await store.tagDigest(svc.db, repo.id, image, reference);
  if (!digest) return null;
  const manifest = await store.getManifest(svc.db, repo.id, image, digest);
  const blob = manifest ? await getBlob(svc.db, digest) : null;
  return manifest && blob ? { digest, mediaType: manifest.mediaType, blob } : null;
}

async function findBlob(
  c: AppContext,
  repo: Repository,
  image: string,
  digest: string,
): Promise<StoredBlob | null> {
  const svc = services(c);
  if (repo.kind === "virtual") {
    return (
      (await firstMatch(svc, repo, image, (m) => findBlob(c, m, image, digest)))?.value ?? null
    );
  }
  if (repo.kind === "remote") return remoteBlob(svc, repo, image, digest);
  if (!(await store.blobVisible(svc.db, repo.id, image, digest))) return null;
  return getBlob(svc.db, digest);
}

/**
 * Whether `image` in `repo` already holds `digest`, without going upstream:
 * the check behind cross-repository mounts. Private layers never leak because
 * the caller must be able to read the source, and the blob must belong to it.
 */
async function holdsBlob(
  c: AppContext,
  repo: Repository,
  image: string,
  digest: string,
): Promise<boolean> {
  const svc = services(c);
  if (repo.kind === "local") return store.blobVisible(svc.db, repo.id, image, digest);
  if (repo.kind === "remote") {
    const entry = await svc.db
      .selectFrom("remote_entries")
      .select("status")
      .where("repo_id", "=", repo.id)
      .where("path", "=", `artifact/oci/blobs/${upstreamImage(repo, image)}@${digest}`)
      .executeTakeFirst();
    return entry?.status === 200;
  }
  for (const member of await candidates(svc, repo, image)) {
    if (await holdsBlob(c, member, image, digest)) return true;
  }
  return false;
}

// --- Handlers --------------------------------------------------------------

async function base(c: AppContext): Promise<Response> {
  const actor = await services(c).actor();
  if (actor.kind === "anonymous" && actor.via !== "registry") throw RegistryError.unauthorized();
  return c.json({});
}

function pageParams(c: AppContext): PageParams {
  const params = parsePageParams(c.req.query("n"), c.req.query("last"));
  if (!params)
    throw new OciError("UNSUPPORTED", "n must be a non-negative integer", { status: 400 });
  return params;
}

async function catalog(c: AppContext): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  const actor = access.actor;
  const everything =
    actor.via === "registry" &&
    (actor.access ?? []).some((g) => g.type === "registry" && g.name === "catalog");
  const names: string[] = [];
  for (const repo of await listRepos(svc.db, "oci")) {
    if (repo.kind !== "local") continue;
    if (!everything && !(await access.can(repo, "read"))) continue;
    for (const image of await store.listImageNames(svc.db, repo.id)) {
      const full = `${repo.key}/${image}`;
      if (!everything && actor.via === "registry" && !(await access.can(repo, "read", full))) {
        continue;
      }
      names.push(full);
    }
  }
  names.sort();
  const { page, next, limit } = paginate(names, pageParams(c), 1000);
  const headers: Record<string, string> = {};
  if (next) headers.link = nextLink("/v2/_catalog", limit, next);
  return c.json({ repositories: page }, 200, headers);
}

async function getBlobHandler(c: AppContext, route: Extract<Route, { kind: "blob" }>) {
  const name = nameOf(route.name);
  const digest = digestOf(route.digest);
  const repo = await readable(c, name);
  const blob = await findBlob(c, repo, name.image, digest);
  if (!blob) throw new OciError("BLOB_UNKNOWN", `Blob ${digest} not found`, { detail: { digest } });
  return serveBlob(c.req.raw, services(c).bucket, blob, {
    contentType: "application/octet-stream",
    headers: { "docker-content-digest": digest },
  });
}

async function deleteBlobHandler(c: AppContext, route: Extract<Route, { kind: "blob" }>) {
  const name = nameOf(route.name);
  const digest = digestOf(route.digest);
  const repo = await writable(c, name, "delete");
  if (!(await store.unlinkBlob(services(c).db, repo.id, name.image, digest))) {
    throw new OciError("BLOB_UNKNOWN", `Blob ${digest} not found`, { detail: { digest } });
  }
  return new Response(null, { status: 202, headers: { "content-length": "0" } });
}

function uploadLocation(name: OciName, uuid: string): string {
  return `/v2/${name.full}/blobs/uploads/${uuid}`;
}

function uploadAccepted(name: OciName, uuid: string, offset: number, status = 202): Response {
  return new Response(null, {
    status,
    headers: {
      location: uploadLocation(name, uuid),
      range: uploadRange(offset),
      "docker-upload-uuid": uuid,
      "oci-chunk-min-length": String(PART_SIZE),
      "content-length": "0",
    },
  });
}

function blobCreated(name: OciName, digest: string): Response {
  return new Response(null, {
    status: 201,
    headers: {
      location: `/v2/${name.full}/blobs/${digest}`,
      "docker-content-digest": digest,
      "content-length": "0",
    },
  });
}

async function startUploadHandler(c: AppContext, route: Extract<Route, { kind: "uploads" }>) {
  const svc = services(c);
  const name = nameOf(route.name);
  const repo = await writable(c, name, "write");
  const url = new URL(c.req.url);

  const mount = url.searchParams.get("mount");
  const from = url.searchParams.get("from");
  if (mount) {
    const digest = digestOf(mount);
    const source = from ? splitName(from) : null;
    if (await store.blobVisible(svc.db, repo.id, name.image, digest)) {
      return blobCreated(name, digest);
    }
    if (source) {
      const fromRepo = await getRepoByKey(svc.db, "oci", source.repoKey);
      const access = await svc.access();
      if (
        fromRepo?.format === "oci" &&
        (await access.can(fromRepo, "read", source.full)) &&
        (await holdsBlob(c, fromRepo, source.image, digest)) &&
        (await getBlob(svc.db, digest))
      ) {
        await store.linkBlob(svc.db, repo.id, name.image, digest);
        return blobCreated(name, digest);
      }
    }
    // Not mountable: the client falls back to uploading through this session.
  } else if (url.searchParams.has("digest")) {
    const digest = digestOf(url.searchParams.get("digest"));
    const blob = await storeBlob(svc.db, svc.bucket, c.req.raw.body ?? new Uint8Array(), {
      maxBytes: repo.config.maxUploadBytes,
      expect: { sha256: digest.slice("sha256:".length) },
    });
    await store.linkBlob(svc.db, repo.id, name.image, blob.digest);
    return blobCreated(name, digest);
  }

  const { uuid } = await startUpload(svc, repo.id, name.image);
  return uploadAccepted(name, uuid, 0);
}

function rangeError(name: OciName, uuid: string, offset: number, message: string): OciError {
  return new OciError("BLOB_UPLOAD_INVALID", message, {
    status: 416,
    headers: { location: uploadLocation(name, uuid), range: uploadRange(offset) },
  });
}

/** Content-Range, when sent, must continue exactly where the session stands. */
function expectedLength(c: AppContext, name: OciName, uuid: string, offset: number) {
  const range = parseContentRange(c.req.header("content-range"));
  if (range === "invalid") throw rangeError(name, uuid, offset, "Malformed Content-Range");
  if (range && range.start !== offset) {
    throw rangeError(name, uuid, offset, `Chunk starts at ${range.start}, expected ${offset}`);
  }
  return range ? range.end - range.start + 1 : null;
}

async function patchUpload(c: AppContext, name: OciName, uuid: string): Promise<Response> {
  const svc = services(c);
  const repo = await writable(c, name, "write");
  const { stub, state } = await loadUpload(svc, uuid, repo.id, name.image);
  const expected = expectedLength(c, name, uuid, state.offset);
  const claimed = await claim(stub, state, uploadLocation(name, uuid));

  let tailKey: string | null = null;
  try {
    const appended = await append(svc.bucket, claimed, c.req.raw.body, repo.config.maxUploadBytes);
    if (expected !== null && appended.received !== expected) {
      throw rangeError(name, uuid, state.offset, "Content-Range does not match the body length");
    }
    if (appended.received === 0) {
      await release(stub, claimed);
      return uploadAccepted(name, uuid, state.offset);
    }
    tailKey = await writeTail(svc.bucket, claimed, appended.tail);
    const next = await commit(stub, claimed, {
      repoId: claimed.repoId,
      name: claimed.name,
      r2Key: claimed.r2Key,
      partSize: claimed.partSize,
      expiresAt: claimed.expiresAt,
      r2UploadId: appended.r2UploadId,
      parts: appended.parts,
      offset: appended.offset,
      hasherState: appended.hasherState,
      tailKey,
    });
    if (!next) throw rangeError(name, uuid, state.offset, "The upload was modified concurrently");
    if (claimed.tailKey && claimed.tailKey !== tailKey) {
      await svc.bucket.delete(claimed.tailKey).catch(() => undefined);
    }
    return uploadAccepted(name, uuid, next.offset);
  } catch (error) {
    if (tailKey) await svc.bucket.delete(tailKey).catch(() => undefined);
    await release(stub, claimed);
    throw error;
  }
}

async function putUpload(c: AppContext, name: OciName, uuid: string): Promise<Response> {
  const svc = services(c);
  const digest = digestOf(c.req.query("digest"));
  const repo = await writable(c, name, "write");
  const { stub, state } = await loadUpload(svc, uuid, repo.id, name.image);
  const expected = expectedLength(c, name, uuid, state.offset);
  const claimed = await claim(stub, state, uploadLocation(name, uuid));
  const body = c.req.raw.body;
  const maxBytes = repo.config.maxUploadBytes;

  let blob: StoredBlob;
  try {
    if (body && claimed.offset === 0 && expected === null) {
      // POST then one PUT with the whole blob: a plain streamed write.
      blob = await storeBlob(svc.db, svc.bucket, body, {
        maxBytes,
        expect: { sha256: digest.slice("sha256:".length) },
      });
    } else {
      const appended = await append(svc.bucket, claimed, body, maxBytes);
      if (expected !== null && appended.received !== expected) {
        throw rangeError(name, uuid, state.offset, "Content-Range does not match the body length");
      }
      blob = await finish(svc, claimed, appended, digest);
    }
  } catch (error) {
    if (error instanceof RegistryError && error.code === "digest_invalid") {
      await discard(svc.bucket, claimed);
      await stub.clear();
    } else {
      await release(stub, claimed);
    }
    throw error;
  }
  await store.linkBlob(svc.db, repo.id, name.image, blob.digest);
  await stub.clear();
  return blobCreated(name, digest);
}

async function uploadStatus(c: AppContext, name: OciName, uuid: string): Promise<Response> {
  const repo = await writable(c, name, "write");
  const { state } = await loadUpload(services(c), uuid, repo.id, name.image);
  return uploadAccepted(name, uuid, state.offset, 204);
}

async function cancelUpload(c: AppContext, name: OciName, uuid: string): Promise<Response> {
  const svc = services(c);
  const repo = await writable(c, name, "write");
  const { stub, state } = await loadUpload(svc, uuid, repo.id, name.image);
  await discard(svc.bucket, state);
  await stub.clear();
  return new Response(null, { status: 204 });
}

async function readManifestBody(c: AppContext): Promise<Uint8Array> {
  const tooLarge = () =>
    new OciError("SIZE_INVALID", `Manifests are limited to ${MAX_MANIFEST_BYTES} bytes`, {
      status: 413,
    });
  if (Number(c.req.header("content-length") ?? "0") > MAX_MANIFEST_BYTES) throw tooLarge();
  const body = c.req.raw.body;
  if (!body) throw new OciError("MANIFEST_INVALID", "Manifest body is empty");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function getManifestHandler(c: AppContext, route: Extract<Route, { kind: "manifest" }>) {
  const name = nameOf(route.name);
  const reference = route.reference;
  const unknown = () =>
    new OciError("MANIFEST_UNKNOWN", `Manifest ${reference} not found`, { detail: { reference } });
  if (isDigestReference(reference)) digestOf(reference);
  else if (!isValidTag(reference)) throw unknown();
  const repo = await readable(c, name);
  const hit = await findManifest(c, repo, name.image, reference);
  if (!hit) throw unknown();
  return serveBlob(c.req.raw, services(c).bucket, hit.blob, {
    contentType: hit.mediaType,
    headers: { "docker-content-digest": hit.digest },
  });
}

async function putManifestHandler(c: AppContext, route: Extract<Route, { kind: "manifest" }>) {
  const svc = services(c);
  const name = nameOf(route.name);
  const reference = route.reference;
  const byDigest = isDigestReference(reference);
  if (byDigest) digestOf(reference);
  else if (!isValidTag(reference)) {
    throw new OciError("MANIFEST_INVALID", `Invalid tag "${reference}"`);
  }
  const repo = await writable(c, name, "write");
  const bytes = await readManifestBody(c);
  let manifest;
  try {
    manifest = parseManifest(bytes, c.req.header("content-type"));
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new OciError(
        error.code,
        error.message,
        error.code === "UNSUPPORTED" ? { status: 400 } : {},
      );
    }
    throw error;
  }
  const digest = `sha256:${await digestHex("SHA-256", bytes)}`;
  if (byDigest && reference !== digest) {
    throw new OciError("DIGEST_INVALID", `Manifest digest is ${digest}, not ${reference}`, {
      detail: { digest },
    });
  }

  for (const d of requiredBlobs(manifest)) {
    let blob = (await store.blobVisible(svc.db, repo.id, name.image, d.digest))
      ? await getBlob(svc.db, d.digest)
      : null;
    if (!blob && d.digest === EMPTY_JSON_DIGEST) {
      // OCI 1.1 artifacts may reference the `{}` config without pushing it.
      blob = await storeBlob(svc.db, svc.bucket, "{}", { expect: { sha256: d.digest.slice(7) } });
      await store.linkBlob(svc.db, repo.id, name.image, d.digest);
    }
    if (!blob) {
      throw new OciError("MANIFEST_BLOB_UNKNOWN", `Blob ${d.digest} is not in ${name.full}`, {
        detail: { digest: d.digest },
      });
    }
    if (blob.size !== d.size) {
      throw new OciError(
        "MANIFEST_INVALID",
        `Blob ${d.digest} is ${blob.size} bytes, not ${d.size}`,
      );
    }
  }
  for (const d of manifest.manifests) {
    const child = await store.getManifest(svc.db, repo.id, name.image, d.digest);
    if (!child) {
      throw new OciError("MANIFEST_BLOB_UNKNOWN", `Manifest ${d.digest} is not in ${name.full}`, {
        detail: { digest: d.digest },
      });
    }
  }
  // The image is the package: gate the publish (and claim it for a CI job's
  // repository) before anything is stored.
  const pkg = await ensurePackage(svc.db, repo.id, name.image, name.image.toLowerCase(), {
    kind: "image",
  });
  // A branch build may push `latest`, but only the default branch moves it: the
  // manifest is stored and stays reachable by digest, the tag stays put.
  const tagged = !byDigest && (reference !== "latest" || movesLatest((await svc.access()).actor));
  if (tagged && repo.config.immutable === true) {
    const current = await store.tagDigest(svc.db, repo.id, name.image, reference);
    if (current && current !== digest) {
      throw new OciError("DENIED", `Tag ${reference} is immutable in ${repo.key}`, { status: 409 });
    }
  }

  await storeBlob(svc.db, svc.bucket, bytes, {
    contentType: manifest.mediaType,
    expect: { sha256: digest.slice(7) },
  });
  await store.putManifest(svc.db, {
    repoId: repo.id,
    name: name.image,
    digest,
    mediaType: manifest.mediaType,
    artifactType: manifest.artifactType,
    subject: manifest.subject?.digest ?? null,
    size: bytes.length,
    annotations: manifest.annotations,
    refs: referencedDigests(manifest),
  });
  let pruned: string[] = [];
  if (tagged) {
    const previous = await store.setTag(svc.db, repo.id, name.image, reference, digest);
    if (previous && previous !== digest && repo.config.retention?.deleteUntagged) {
      pruned = await store.pruneUntagged(svc.db, repo.id, name.image, previous);
    }
  }
  if (tagged) {
    // A tag is a version in the package's history; children of a multi-arch
    // index arrive by digest and stay out of it.
    const size = bytes.length + requiredBlobs(manifest).reduce((n, d) => n + d.size, 0);
    await recordPublish(svc.db, {
      packageId: pkg.id,
      repoId: repo.id,
      version: reference,
      action: "oci.push",
      digest,
      size,
    });
  }
  const access = await svc.access();
  await audit(svc.db, access.actor, "oci.push", {
    repoId: repo.id,
    target: `${name.image}${byDigest ? "@" : ":"}${reference}`,
    detail: { digest, mediaType: manifest.mediaType, size: bytes.length, pruned },
  });
  const headers: Record<string, string> = {
    location: `/v2/${name.full}/manifests/${digest}`,
    "docker-content-digest": digest,
    "content-length": "0",
  };
  if (manifest.subject) headers["oci-subject"] = manifest.subject.digest;
  return new Response(null, { status: 201, headers });
}

async function deleteManifestHandler(c: AppContext, route: Extract<Route, { kind: "manifest" }>) {
  const svc = services(c);
  const name = nameOf(route.name);
  const reference = route.reference;
  const unknown = () => new OciError("MANIFEST_UNKNOWN", `Manifest ${reference} not found`);
  const byDigest = isDigestReference(reference);
  if (byDigest) digestOf(reference);
  else if (!isValidTag(reference)) throw unknown();
  const repo = await writable(c, name, "delete");
  const pruned: string[] = [];
  if (byDigest) {
    if (!(await store.deleteManifest(svc.db, repo.id, name.image, reference))) throw unknown();
  } else {
    const digest = await store.tagDigest(svc.db, repo.id, name.image, reference);
    if (!digest || !(await store.deleteTag(svc.db, repo.id, name.image, reference))) {
      throw unknown();
    }
    if (repo.config.retention?.deleteUntagged) {
      pruned.push(...(await store.pruneUntagged(svc.db, repo.id, name.image, digest)));
    }
    const pkg = await getPackage(svc.db, repo.id, name.image.toLowerCase());
    if (pkg) await markPublishes(svc.db, pkg.id, reference, "deleted");
  }
  await audit(svc.db, (await svc.access()).actor, "oci.delete", {
    repoId: repo.id,
    target: `${name.image}${byDigest ? "@" : ":"}${reference}`,
    detail: { pruned },
  });
  return new Response(null, { status: 202, headers: { "content-length": "0" } });
}

async function tagsOf(
  c: AppContext,
  repo: Repository,
  image: string,
  params: PageParams,
  limit: number,
): Promise<string[] | null> {
  const svc = services(c);
  if (repo.kind === "local") {
    const tags = await store.listTags(svc.db, repo.id, image, {
      after: params.last,
      limit: limit + 1,
    });
    if (tags.length === 0 && !params.last && !(await store.hasImage(svc.db, repo.id, image))) {
      return null;
    }
    return tags;
  }
  if (repo.kind === "remote") return remoteTags(svc, repo, image);
  let found = false;
  const all = new Set<string>();
  for (const member of await candidates(svc, repo, image)) {
    const tags = await tagsOf(c, member, image, { n: null, last: null }, 100_000);
    if (!tags) continue;
    found = true;
    for (const tag of tags) all.add(tag);
  }
  return found ? [...all].sort() : null;
}

async function tagsHandler(c: AppContext, route: Extract<Route, { kind: "tags" }>) {
  const name = nameOf(route.name);
  const repo = await readable(c, name);
  const params = pageParams(c);
  const max = 1000;
  const limit = Math.min(params.n ?? max, max);
  const tags = await tagsOf(c, repo, name.image, params, limit);
  if (!tags)
    throw new OciError("NAME_UNKNOWN", `${name.full} not found`, { detail: { name: name.full } });
  // Local tags arrive already past `last`; paginate() re-filters harmlessly.
  const { page, next } = paginate(tags, params, max);
  const headers: Record<string, string> = {};
  if (next) headers.link = nextLink(`/v2/${name.full}/tags/list`, limit, next);
  return c.json({ name: name.full, tags: page }, 200, headers);
}

async function referrersOf(
  c: AppContext,
  repo: Repository,
  image: string,
  digest: string,
): Promise<ReferrerDescriptor[]> {
  const svc = services(c);
  if (repo.kind === "local") {
    return (await store.listReferrers(svc.db, repo.id, image, digest)).map((m) => ({
      mediaType: m.mediaType,
      digest: m.digest,
      size: m.size,
      ...(m.artifactType ? { artifactType: m.artifactType } : {}),
      annotations: m.annotations,
    }));
  }
  if (repo.kind === "remote") {
    return (await remoteReferrers(svc, repo, image, digest)).filter(
      (d): d is ReferrerDescriptor & Record<string, unknown> =>
        typeof d.mediaType === "string" &&
        typeof d.digest === "string" &&
        typeof d.size === "number",
    );
  }
  const seen = new Map<string, ReferrerDescriptor>();
  for (const member of await candidates(svc, repo, image)) {
    for (const d of await referrersOf(c, member, image, digest)) {
      if (!seen.has(d.digest)) seen.set(d.digest, d);
    }
  }
  return [...seen.values()];
}

async function referrersHandler(c: AppContext, route: Extract<Route, { kind: "referrers" }>) {
  const name = nameOf(route.name);
  const digest = digestOf(route.digest);
  const repo = await readable(c, name);
  const artifactType = c.req.query("artifactType");
  let referrers = await referrersOf(c, repo, name.image, digest);
  const headers: Record<string, string> = { "content-type": MEDIA_TYPES.ociIndex };
  if (artifactType) {
    referrers = referrers.filter((r) => r.artifactType === artifactType);
    headers["oci-filters-applied"] = "artifactType";
  }
  return new Response(JSON.stringify(referrersIndex(referrers)), { status: 200, headers });
}

// --- Routing ---------------------------------------------------------------

function unsupported(c: AppContext): OciError {
  return new OciError("UNSUPPORTED", `${c.req.method} is not supported here`);
}

async function dispatch(c: AppContext): Promise<Response> {
  const route = parseRoute(new URL(c.req.url).pathname);
  const method = c.req.method;
  const read = method === "GET" || method === "HEAD";
  if (!route) throw new OciError("NAME_UNKNOWN", "Not found", { status: 404 });
  switch (route.kind) {
    case "base":
      if (read) return base(c);
      break;
    case "token":
      if (method === "GET" || method === "POST") return tokenEndpoint(c);
      break;
    case "catalog":
      if (read) return catalog(c);
      break;
    case "blob":
      if (read) return getBlobHandler(c, route);
      if (method === "DELETE") return deleteBlobHandler(c, route);
      break;
    case "uploads": {
      if (route.uuid === null) {
        if (method === "POST") return startUploadHandler(c, route);
        break;
      }
      const name = nameOf(route.name);
      if (method === "PATCH") return patchUpload(c, name, route.uuid);
      if (method === "PUT") return putUpload(c, name, route.uuid);
      if (read) return uploadStatus(c, name, route.uuid);
      if (method === "DELETE") return cancelUpload(c, name, route.uuid);
      break;
    }
    case "manifest":
      if (read) return getManifestHandler(c, route);
      if (method === "PUT") return putManifestHandler(c, route);
      if (method === "DELETE") return deleteManifestHandler(c, route);
      break;
    case "tags":
      if (read) return tagsHandler(c, route);
      break;
    case "referrers":
      if (read) return referrersHandler(c, route);
      break;
  }
  throw unsupported(c);
}

const routes = new Hono<AppEnv>();
routes.use("*", async (c, next) => {
  await next();
  c.res.headers.set(
    "docker-distribution-api-version",
    API_VERSION_HEADER["docker-distribution-api-version"],
  );
});
routes.all("/", dispatch);
routes.all("/*", dispatch);

export const ociFormat: FormatModule = {
  id: "oci",
  routes,
  renderError: renderOciError,
};
