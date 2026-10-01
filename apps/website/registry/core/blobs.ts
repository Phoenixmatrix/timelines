import { createHash, type Hash } from "node:crypto";

import { nowIso, type DB } from "./db.ts";
import { RegistryError } from "./errors.ts";

/**
 * The single write path for artifact bytes. Streams any body (known length or
 * not) into R2 at an opaque key, hashing as it goes, then records it in the
 * content-addressed `blobs` catalog. R2 has no rename and a streamed body's
 * digest is only known at the end, so the digest lives in D1, not the key.
 *
 * R2 multipart parts must all be the same size (except the last) and at least
 * 5 MiB, so bodies are cut into exact PART_SIZE buffers.
 */
export const PART_SIZE = 8 * 1024 * 1024;

export interface WrittenBlob {
  r2Key: string;
  size: number;
  /** `sha256:<hex>` */
  digest: string;
  sha256: string;
  sha1: string;
  md5: string;
  sha512: string;
}

export interface ExpectedDigests {
  sha256?: string;
  sha1?: string;
  md5?: string;
  sha512?: string;
  size?: number;
}

export interface WriteOptions {
  contentType?: string;
  maxBytes?: number;
  expect?: ExpectedDigests;
}

export type BlobBody = ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string;

function toStream(body: BlobBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function newBlobKey(): string {
  return `b/${crypto.randomUUID()}`;
}

class MultiHash {
  private readonly hashes: Record<"sha256" | "sha1" | "md5" | "sha512", Hash> = {
    sha256: createHash("sha256"),
    sha1: createHash("sha1"),
    md5: createHash("md5"),
    sha512: createHash("sha512"),
  };
  update(chunk: Uint8Array): void {
    for (const hash of Object.values(this.hashes)) hash.update(chunk);
  }
  digest() {
    return {
      sha256: this.hashes.sha256.digest("hex"),
      sha1: this.hashes.sha1.digest("hex"),
      md5: this.hashes.md5.digest("hex"),
      sha512: this.hashes.sha512.digest("hex"),
    };
  }
}

export async function writeBlob(
  bucket: R2Bucket,
  body: BlobBody,
  options: WriteOptions = {},
): Promise<WrittenBlob> {
  const key = newBlobKey();
  const hash = new MultiHash();
  const httpMetadata = options.contentType ? { contentType: options.contentType } : undefined;
  const buffer = new Uint8Array(PART_SIZE);
  let filled = 0;
  let size = 0;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];

  const flushPart = async () => {
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
    parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, filled)));
    filled = 0;
  };

  const reader = toStream(body).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.length;
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        throw new RegistryError("too_large", `Upload exceeds ${options.maxBytes} bytes`);
      }
      hash.update(chunk);
      let at = 0;
      while (at < chunk.length) {
        const take = Math.min(PART_SIZE - filled, chunk.length - at);
        buffer.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === PART_SIZE) await flushPart();
      }
    }
    if (upload === null) {
      await bucket.put(key, buffer.slice(0, filled), { httpMetadata });
    } else {
      if (filled > 0) await flushPart();
      await (upload as R2MultipartUpload).complete(parts);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    if (upload) await (upload as R2MultipartUpload).abort().catch(() => undefined);
    throw error;
  }

  const digests = hash.digest();
  const written: WrittenBlob = { r2Key: key, size, digest: `sha256:${digests.sha256}`, ...digests };
  const mismatch = checkExpected(written, options.expect);
  if (mismatch) {
    await bucket.delete(key);
    throw new RegistryError("digest_invalid", mismatch);
  }
  return written;
}

function checkExpected(blob: WrittenBlob, expect?: ExpectedDigests): string | null {
  if (!expect) return null;
  if (expect.size !== undefined && expect.size !== blob.size) {
    return `Size mismatch: expected ${expect.size}, got ${blob.size}`;
  }
  for (const algo of ["sha256", "sha1", "md5", "sha512"] as const) {
    const want = expect[algo]?.toLowerCase();
    if (want && want !== blob[algo]) return `${algo} mismatch: expected ${want}, got ${blob[algo]}`;
  }
  return null;
}

export interface StoredBlob {
  digest: string;
  r2Key: string;
  size: number;
  md5: string | null;
  sha1: string | null;
  sha512: string | null;
}

/**
 * Records a written blob. If the digest already exists, the new copy is
 * deleted and the existing one is returned (global deduplication).
 */
export async function commitBlob(
  db: DB,
  bucket: R2Bucket,
  written: Pick<WrittenBlob, "r2Key" | "size" | "digest"> & Partial<WrittenBlob>,
): Promise<StoredBlob> {
  const result = await db
    .insertInto("blobs")
    .values({
      digest: written.digest,
      r2_key: written.r2Key,
      size: written.size,
      md5: written.md5 ?? null,
      sha1: written.sha1 ?? null,
      sha512: written.sha512 ?? null,
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.column("digest").doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
    const existing = await getBlob(db, written.digest);
    if (existing && existing.r2Key !== written.r2Key) {
      await bucket.delete(written.r2Key);
      // Backfill digests the earlier writer did not compute (e.g. OCI uploads).
      if (written.md5 && !existing.md5) {
        await db
          .updateTable("blobs")
          .set({ md5: written.md5, sha1: written.sha1 ?? null, sha512: written.sha512 ?? null })
          .where("digest", "=", written.digest)
          .execute();
      }
      return existing;
    }
  }
  return {
    digest: written.digest,
    r2Key: written.r2Key,
    size: written.size,
    md5: written.md5 ?? null,
    sha1: written.sha1 ?? null,
    sha512: written.sha512 ?? null,
  };
}

export async function storeBlob(
  db: DB,
  bucket: R2Bucket,
  body: BlobBody,
  options: WriteOptions = {},
): Promise<StoredBlob> {
  return commitBlob(db, bucket, await writeBlob(bucket, body, options));
}

export async function getBlob(db: DB, digest: string): Promise<StoredBlob | null> {
  const row = await db
    .selectFrom("blobs")
    .selectAll()
    .where("digest", "=", digest)
    .executeTakeFirst();
  return row
    ? {
        digest: row.digest,
        r2Key: row.r2_key,
        size: row.size,
        md5: row.md5,
        sha1: row.sha1,
        sha512: row.sha512,
      }
    : null;
}

export async function readBlobBytes(bucket: R2Bucket, r2Key: string): Promise<Uint8Array> {
  const object = await bucket.get(r2Key);
  if (!object) throw new RegistryError("internal", `Blob ${r2Key} is missing from storage`);
  return new Uint8Array(await object.arrayBuffer());
}

export async function readBlobText(bucket: R2Bucket, r2Key: string): Promise<string> {
  return new TextDecoder().decode(await readBlobBytes(bucket, r2Key));
}

type ParsedRange = { offset: number; length: number } | "invalid" | null;

export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

export interface ServeOptions {
  contentType?: string;
  /** Sets Content-Disposition: attachment with this filename. */
  filename?: string;
  cacheControl?: string;
  headers?: Record<string, string>;
}

/** Streams a stored blob with HEAD, Range and If-None-Match support. */
export async function serveBlob(
  request: Request,
  bucket: R2Bucket,
  blob: Pick<StoredBlob, "r2Key" | "size" | "digest">,
  options: ServeOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("content-type", options.contentType ?? "application/octet-stream");
  headers.set("etag", `"${blob.digest}"`);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", options.cacheControl ?? "private, max-age=0, must-revalidate");
  if (options.filename) {
    headers.set(
      "content-disposition",
      `attachment; filename="${options.filename.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
    );
  }

  const inm = request.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${blob.digest}"`)) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get("range"), blob.size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(range ? range.length : blob.size));
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${blob.size}`,
      );
    }
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const object = await bucket.get(blob.r2Key, range ? { range } : undefined);
  if (!object || !("body" in object)) {
    throw new RegistryError("internal", "Blob is missing from storage");
  }
  headers.set("content-length", String(range ? range.length : blob.size));
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${blob.size}`,
    );
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
