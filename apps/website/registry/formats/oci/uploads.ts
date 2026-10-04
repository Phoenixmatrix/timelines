import { createHasher, resumeHasher, toHex, type HasherState } from "@gitmatrix/formats/hash";

import { commitBlob, newBlobKey, PART_SIZE, type StoredBlob } from "../../core/blobs.ts";
import type { Services } from "../../core/context.ts";
import { OciError } from "./errors.ts";
import { durableStub } from "../../../worker/durable/registry.ts";

/**
 * Chunked blob uploads. The Worker streams bytes straight to an R2 multipart
 * upload; the session's UploadDO only holds resumable state. R2 needs every
 * part but the last to be the same size, so each PATCH prepends the carried
 * tail (a temporary R2 object shorter than one part), cuts exact PART_SIZE
 * parts, and stores the remainder as the next tail. The SHA-256 state is
 * serialized between requests.
 */

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** R2's multipart part limit: 10,000 x 8 MiB, about 78 GiB per blob. */
export const MAX_PARTS = 10_000;
/** Holds a session against concurrent PATCHes while one streams. */
const BUSY_MS = 15 * 60 * 1000;

export interface UploadState {
  version: number;
  repoId: string;
  name: string;
  r2Key: string;
  r2UploadId: string | null;
  partSize: number;
  parts: { partNumber: number; etag: string }[];
  offset: number;
  hasherState: HasherState;
  tailKey: string | null;
  expiresAt: number;
  busyUntil: number;
}

/** The UploadDO RPC surface (do/upload-do.ts; FakeStateObject in tests). */
interface UploadStub {
  getState<T>(): Promise<T | null>;
  putState<T extends { version: number }>(state: T, expected: number | null): Promise<boolean>;
  expireAt(at: number): Promise<void>;
  clear(): Promise<void>;
}

export function uploadStub(svc: Services, uuid: string): UploadStub {
  return durableStub(svc.env, "RegistryUpload", uuid) as unknown as UploadStub;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unknownUpload(): OciError {
  return new OciError("BLOB_UPLOAD_UNKNOWN", "Upload session not found or expired");
}

export async function startUpload(svc: Services, repoId: string, name: string) {
  const uuid = crypto.randomUUID();
  const now = Date.now();
  const state: UploadState = {
    version: 1,
    repoId,
    name,
    r2Key: newBlobKey(),
    r2UploadId: null,
    partSize: PART_SIZE,
    parts: [],
    offset: 0,
    hasherState: createHasher("sha256").exportState(),
    tailKey: null,
    expiresAt: now + SESSION_TTL_MS,
    busyUntil: 0,
  };
  const stub = uploadStub(svc, uuid);
  if (!(await stub.putState(state, null))) throw new OciError("UNKNOWN", "Upload id collision");
  await stub.expireAt(state.expiresAt);
  return { uuid, state };
}

/** Loads a live session that belongs to this repository and image. */
export async function loadUpload(
  svc: Services,
  uuid: string,
  repoId: string,
  name: string,
): Promise<{ stub: UploadStub; state: UploadState }> {
  if (!UUID_RE.test(uuid)) throw unknownUpload();
  const stub = uploadStub(svc, uuid);
  const state = await stub.getState<UploadState>();
  if (!state || state.repoId !== repoId || state.name !== name) throw unknownUpload();
  if (state.expiresAt < Date.now()) {
    await discard(svc.bucket, state);
    await stub.clear();
    throw unknownUpload();
  }
  return { stub, state };
}

/**
 * Takes the session for one request (optimistic version check). A PATCH that
 * races another gets 416 before it writes any part, so parts are never
 * overwritten by a request that would lose the commit anyway.
 */
export async function claim(
  stub: UploadStub,
  state: UploadState,
  location: string,
): Promise<UploadState> {
  const busy = () =>
    new OciError("BLOB_UPLOAD_INVALID", "Another request is writing to this upload", {
      status: 416,
      headers: { location, range: `0-${Math.max(state.offset - 1, 0)}` },
    });
  if (state.busyUntil > Date.now()) throw busy();
  const claimed = { ...state, version: state.version + 1, busyUntil: Date.now() + BUSY_MS };
  if (!(await stub.putState(claimed, state.version))) throw busy();
  return claimed;
}

/** Gives the session back unchanged after a failed request. */
export async function release(stub: UploadStub, claimed: UploadState): Promise<void> {
  await stub
    .putState({ ...claimed, version: claimed.version + 1, busyUntil: 0 }, claimed.version)
    .catch(() => false);
}

/** Commits new state over a claimed session; false if someone took it over. */
export async function commit(
  stub: UploadStub,
  claimed: UploadState,
  next: Omit<UploadState, "version" | "busyUntil">,
): Promise<UploadState | null> {
  const state: UploadState = { ...next, version: claimed.version + 1, busyUntil: 0 };
  return (await stub.putState(state, claimed.version)) ? state : null;
}

export interface Appended {
  parts: UploadState["parts"];
  r2UploadId: string | null;
  offset: number;
  hasherState: HasherState;
  /** Bytes after the last full part (always shorter than one part). */
  tail: Uint8Array;
  received: number;
}

async function readTail(bucket: R2Bucket, key: string | null): Promise<Uint8Array> {
  if (!key) return new Uint8Array();
  const object = await bucket.get(key);
  if (!object) throw new OciError("BLOB_UPLOAD_UNKNOWN", "Upload data is missing; restart it");
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * Streams `body` onto the session: tail + body are cut into exact parts, each
 * uploaded as it fills. Nothing about the session changes until the caller
 * commits the returned state.
 */
export async function append(
  bucket: R2Bucket,
  state: UploadState,
  body: ReadableStream<Uint8Array> | null,
  maxBytes?: number,
): Promise<Appended> {
  const partSize = state.partSize;
  const buffer = new Uint8Array(partSize);
  const carried = await readTail(bucket, state.tailKey);
  buffer.set(carried);
  let filled = carried.length;
  const hasher = resumeHasher(state.hasherState);
  const parts = [...state.parts];
  let offset = state.offset;
  let received = 0;
  let upload: R2MultipartUpload | null = state.r2UploadId
    ? bucket.resumeMultipartUpload(state.r2Key, state.r2UploadId)
    : null;

  const flush = async () => {
    if (parts.length >= MAX_PARTS) {
      throw new OciError("SIZE_INVALID", "Blob exceeds the maximum size (10,000 parts of 8 MiB)");
    }
    upload ??= await bucket.createMultipartUpload(state.r2Key);
    // A copy: the buffer is reused for the next part.
    parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, filled)));
    filled = 0;
  };

  if (body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        offset += chunk.length;
        received += chunk.length;
        if (maxBytes !== undefined && offset > maxBytes) {
          throw new OciError("SIZE_INVALID", `Blob exceeds ${maxBytes} bytes`, { status: 413 });
        }
        hasher.update(chunk);
        let at = 0;
        while (at < chunk.length) {
          const take = Math.min(partSize - filled, chunk.length - at);
          buffer.set(chunk.subarray(at, at + take), filled);
          filled += take;
          at += take;
          if (filled === partSize) await flush();
        }
      }
    } catch (error) {
      reader.cancel().catch(() => undefined);
      throw error;
    }
  }
  return {
    parts,
    r2UploadId: upload ? (upload as R2MultipartUpload).uploadId : null,
    offset,
    hasherState: hasher.exportState(),
    tail: buffer.slice(0, filled),
    received,
  };
}

/** Persists a PATCH's remainder under a fresh key (the previous tail stays valid until commit). */
export async function writeTail(
  bucket: R2Bucket,
  state: UploadState,
  tail: Uint8Array,
): Promise<string | null> {
  if (tail.length === 0) return null;
  const key = `${state.r2Key}.tail.${crypto.randomUUID()}`;
  await bucket.put(key, tail);
  return key;
}

/** Finishes the R2 object from the appended state; returns the verified blob. */
export async function finish(
  svc: Services,
  state: UploadState,
  appended: Appended,
  expected: string,
): Promise<StoredBlob> {
  const bucket = svc.bucket;
  const digest = `sha256:${toHex(resumeHasher(appended.hasherState).digest())}`;
  if (digest !== expected) {
    await discard(bucket, { ...state, r2UploadId: appended.r2UploadId });
    throw new OciError("DIGEST_INVALID", `Upload digest is ${digest}, not ${expected}`);
  }
  if (appended.parts.length === 0) {
    await bucket.put(state.r2Key, appended.tail);
  } else {
    const upload = bucket.resumeMultipartUpload(state.r2Key, appended.r2UploadId!);
    const parts = [...appended.parts];
    if (appended.tail.length > 0) {
      if (parts.length >= MAX_PARTS) {
        await discard(bucket, { ...state, r2UploadId: appended.r2UploadId });
        throw new OciError("SIZE_INVALID", "Blob exceeds the maximum size (10,000 parts of 8 MiB)");
      }
      parts.push(await upload.uploadPart(parts.length + 1, appended.tail));
    }
    await upload.complete(parts);
  }
  await deleteTails(bucket, state);
  return commitBlob(svc.db, bucket, { r2Key: state.r2Key, size: appended.offset, digest });
}

/** Aborts the multipart upload and removes the tail. */
export async function discard(bucket: R2Bucket, state: UploadState): Promise<void> {
  if (state.r2UploadId) {
    await bucket
      .resumeMultipartUpload(state.r2Key, state.r2UploadId)
      .abort()
      .catch(() => undefined);
  }
  await deleteTails(bucket, state);
}

/** Every tail of the session, including ones a crashed PATCH left behind. */
async function deleteTails(bucket: R2Bucket, state: UploadState): Promise<void> {
  const keys = new Set(state.tailKey ? [state.tailKey] : []);
  const listed = await bucket.list({ prefix: `${state.r2Key}.tail.` }).catch(() => null);
  for (const object of listed?.objects ?? []) keys.add(object.key);
  if (keys.size > 0) await bucket.delete([...keys]).catch(() => undefined);
}
