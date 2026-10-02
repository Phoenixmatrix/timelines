import { createHash } from "node:crypto";

import {
  applyDelta,
  decompressFrame,
  FRAME_SIZE,
  MAX_DELTA_SIZE,
  type FrameCodec,
} from "@gitmatrix/formats/artifact-storage";

import { RegistryError } from "./errors.ts";

export interface BlobFrame {
  key: string;
  size: number;
  sha256: string;
  codec: FrameCodec;
  payloadSize: number;
  storedSize: number;
  delta: boolean;
}

export interface BlobManifest {
  version: 1;
  size: number;
  digest: string;
  frameSize: number;
  base: string | null;
  frames: BlobFrame[];
}

const MANIFEST_LIMIT = 8 * 1024 * 1024;
const FRAME_LIMIT = 20_000; // The existing 8 MiB × 10,000-part upload ceiling.
const MANIFEST_KEY = /^c\/[a-zA-Z0-9_-]{1,80}\/index\.json$/;
const CACHE_NAME = "gitmatrix-artifact-frames-v1";
const CACHE_SECONDS = 3600;

function invalid(message: string): never {
  throw new RegistryError("internal", `Invalid blob storage: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("expected an object");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function isCompactKey(key: string): boolean {
  return key.startsWith("c/");
}

/** Manifests and their payload keys are immutable; bases are pinned by the physical catalog. */
export async function loadBlobManifest(bucket: R2Bucket, key: string): Promise<BlobManifest> {
  if (!MANIFEST_KEY.test(key)) return invalid("manifest key");
  const object = await bucket.get(key);
  if (!object || object.size > MANIFEST_LIMIT) return invalid("missing or oversized manifest");
  const value = record(JSON.parse(await object.text()));
  if (
    value.version !== 1 ||
    value.frameSize !== FRAME_SIZE ||
    !integer(value.size, 0, FRAME_SIZE * FRAME_LIMIT) ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !(value.base === null || (typeof value.base === "string" && MANIFEST_KEY.test(value.base))) ||
    value.base === key ||
    !Array.isArray(value.frames) ||
    value.frames.length !== Math.ceil(value.size / FRAME_SIZE)
  ) {
    return invalid("manifest header");
  }
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  const frames: BlobFrame[] = value.frames.map((input: unknown, index: number) => {
    const frame = record(input);
    const size = Math.min(FRAME_SIZE, Number(value.size) - index * FRAME_SIZE);
    if (
      typeof frame.key !== "string" ||
      !frame.key.startsWith(prefix) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(frame.key.slice(prefix.length)) ||
      frame.key === key ||
      frame.size !== size ||
      typeof frame.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(frame.sha256) ||
      !(frame.codec === "raw" || frame.codec === "deflate") ||
      typeof frame.delta !== "boolean" ||
      (frame.delta && value.base === null) ||
      !integer(frame.payloadSize, 0, frame.delta ? MAX_DELTA_SIZE : FRAME_SIZE) ||
      (!frame.delta && frame.payloadSize !== size) ||
      !integer(frame.storedSize, 0, frame.payloadSize) ||
      (frame.codec === "raw" && frame.storedSize !== frame.payloadSize)
    ) {
      return invalid("frame descriptor");
    }
    return {
      key: frame.key,
      size,
      sha256: frame.sha256,
      codec: frame.codec,
      payloadSize: frame.payloadSize,
      storedSize: frame.storedSize,
      delta: frame.delta,
    };
  });
  return {
    version: 1,
    size: value.size,
    digest: value.digest,
    frameSize: FRAME_SIZE,
    base: value.base,
    frames,
  };
}

async function frameCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch (error) {
    console.warn("artifact frame cache unavailable", error);
    return null;
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readFrame(
  bucket: R2Bucket,
  manifest: BlobManifest,
  index: number,
  cache: Cache | null,
  base: () => Promise<BlobManifest>,
): Promise<Uint8Array> {
  const frame = manifest.frames[index];
  if (!frame) return invalid("missing frame");
  const cacheKey = new Request(`https://artifact-frames.invalid/${encodeURIComponent(frame.key)}`);
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.length === frame.size && checksum(bytes) === frame.sha256) return bytes;
        await cache.delete(cacheKey);
      }
    } catch (error) {
      console.warn("artifact frame cache read failed", error);
    }
  }
  const object = await bucket.get(frame.key);
  if (!object || object.size !== frame.storedSize) return invalid("missing or truncated frame");
  const stored = new Uint8Array(await object.arrayBuffer());
  if (stored.length !== frame.storedSize) return invalid("truncated frame payload");
  const payload = decompressFrame(frame.codec, stored, frame.payloadSize);
  let bytes = payload;
  if (frame.delta) {
    const snapshot = await base();
    if (snapshot.base !== null || snapshot.frames.some((entry) => entry.delta)) {
      return invalid("delta chains are forbidden");
    }
    const original = await readFrame(bucket, snapshot, index, cache, () => {
      return Promise.reject(new RegistryError("internal", "A full snapshot cannot have a base"));
    });
    bytes = applyDelta(original, payload, frame.size);
  }
  if (bytes.length !== frame.size || checksum(bytes) !== frame.sha256) {
    return invalid("frame checksum mismatch");
  }
  if (cache) {
    try {
      // Await the cache write: buffering a background put for every frame defeats backpressure.
      await cache.put(
        cacheKey,
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
          },
        }),
      );
    } catch (error) {
      console.warn("artifact frame cache write failed", error);
    }
  }
  return bytes;
}

function baseLoader(bucket: R2Bucket, manifest: BlobManifest): () => Promise<BlobManifest> {
  let promise: Promise<BlobManifest> | undefined;
  return () => {
    if (!manifest.base) return invalid("missing snapshot reference");
    promise ??= loadBlobManifest(bucket, manifest.base);
    return promise;
  };
}

export async function readBlobFrame(
  bucket: R2Bucket,
  manifest: BlobManifest,
  index: number,
  cacheResult = true,
): Promise<Uint8Array> {
  return readFrame(
    bucket,
    manifest,
    index,
    cacheResult ? await frameCache() : null,
    baseLoader(bucket, manifest),
  );
}

/** Reads original artifact bytes, never physical compressed bytes or a version-history chain. */
export async function readBlobStream(
  bucket: R2Bucket,
  key: string,
  range?: { offset: number; length: number },
): Promise<ReadableStream<Uint8Array>> {
  if (
    range &&
    (!integer(range.offset, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(range.length, 0, Number.MAX_SAFE_INTEGER))
  ) {
    return invalid("range bounds");
  }
  if (!isCompactKey(key)) {
    const object = await bucket.get(key, range ? { range } : undefined);
    if (!object) throw new RegistryError("internal", `Blob ${key} is missing from storage`);
    return object.body;
  }
  const manifest = await loadBlobManifest(bucket, key);
  const start = range?.offset ?? 0;
  const length = range?.length ?? manifest.size;
  if (start > manifest.size || length > manifest.size - start) return invalid("range outside blob");
  const end = start + length;
  let index = Math.floor(start / FRAME_SIZE);
  const stop = Math.ceil(end / FRAME_SIZE);
  const cache = await frameCache();
  const base = baseLoader(bucket, manifest);
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (cancelled) return;
        if (index >= stop || length === 0) {
          controller.close();
          return;
        }
        const offset = index * FRAME_SIZE;
        const bytes = await readFrame(bucket, manifest, index++, cache, base);
        if (!cancelled) {
          controller.enqueue(
            bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset)),
          );
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

export async function readBlobRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (length === 0 && integer(offset, 0, Number.MAX_SAFE_INTEGER)) return new Uint8Array();
  return new Uint8Array(
    await new Response(await readBlobStream(bucket, key, { offset, length })).arrayBuffer(),
  );
}

/** GC calls this only after atomically releasing all logical, base and in-flight references. */
export async function deleteBlobRepresentation(bucket: R2Bucket, key: string): Promise<void> {
  if (!isCompactKey(key)) {
    await bucket.delete(key);
    return;
  }
  if (!MANIFEST_KEY.test(key)) return invalid("deletion key");
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  // Re-list the first page after deletion; continuation offsets are not stable while deleting.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return;
    await bucket.delete(page.objects.map((object) => object.key));
  }
}
