/**
 * An in-memory R2 bucket that enforces the rules the real one does and that
 * are easy to get wrong: `put` needs a known length for streams, multipart
 * parts must all be the same size (except the last) and at least 5 MiB, and
 * part numbers run 1..10000.
 */

const MIN_PART = 5 * 1024 * 1024;

interface Stored {
  bytes: Uint8Array;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  uploaded: Date;
  etag: string;
}

export interface FakeR2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

async function readAll(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new Error("FakeR2: unsupported value type");
}

function etagOf(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `${h.toString(16)}-${bytes.length}`;
}

export class FakeR2Object {
  readonly key: string;
  protected readonly stored: Stored;
  readonly range?: { offset: number; length: number };
  constructor(key: string, stored: Stored, range?: { offset: number; length: number }) {
    this.key = key;
    this.stored = stored;
    this.range = range;
  }
  get size(): number {
    return this.stored.bytes.length;
  }
  get etag(): string {
    return this.stored.etag;
  }
  get httpEtag(): string {
    return `"${this.stored.etag}"`;
  }
  get uploaded(): Date {
    return this.stored.uploaded;
  }
  get httpMetadata(): { contentType?: string } {
    return this.stored.httpMetadata;
  }
  get customMetadata(): Record<string, string> {
    return this.stored.customMetadata;
  }
  writeHttpMetadata(headers: Headers): void {
    if (this.stored.httpMetadata.contentType) {
      headers.set("content-type", this.stored.httpMetadata.contentType);
    }
  }
}

export class FakeR2ObjectBody extends FakeR2Object {
  private slice(): Uint8Array {
    const r = this.range;
    return r ? this.stored.bytes.slice(r.offset, r.offset + r.length) : this.stored.bytes.slice();
  }
  get body(): ReadableStream<Uint8Array> {
    const bytes = this.slice();
    return new ReadableStream({
      start(controller) {
        // Emit in modest chunks so consumers exercise their chunk handling.
        for (let i = 0; i < bytes.length; i += 64 * 1024) {
          controller.enqueue(bytes.slice(i, i + 64 * 1024));
        }
        controller.close();
      },
    });
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const s = this.slice();
    return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.slice());
  }
  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

interface PendingUpload {
  key: string;
  parts: Map<number, Uint8Array>;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

export class FakeR2MultipartUpload {
  private readonly bucket: FakeR2Bucket;
  readonly key: string;
  readonly uploadId: string;
  constructor(bucket: FakeR2Bucket, key: string, uploadId: string) {
    this.bucket = bucket;
    this.key = key;
    this.uploadId = uploadId;
  }

  async uploadPart(
    partNumber: number,
    value: unknown,
  ): Promise<{ partNumber: number; etag: string }> {
    const pending = this.bucket.pending(this.uploadId);
    if (partNumber < 1 || partNumber > 10_000) throw new Error("FakeR2: invalid part number");
    if (value instanceof ReadableStream) {
      throw new Error("FakeR2: uploadPart streams need a known length (use FixedLengthStream)");
    }
    const bytes = await readAll(value);
    pending.parts.set(partNumber, bytes);
    return { partNumber, etag: etagOf(bytes) };
  }

  async abort(): Promise<void> {
    this.bucket.dropPending(this.uploadId);
  }

  async complete(uploaded: { partNumber: number; etag: string }[]): Promise<FakeR2Object> {
    const pending = this.bucket.pending(this.uploadId);
    const ordered = [...uploaded].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    for (const [index, part] of ordered.entries()) {
      const bytes = pending.parts.get(part.partNumber);
      if (!bytes || etagOf(bytes) !== part.etag) throw new Error("FakeR2: unknown part");
      const last = index === ordered.length - 1;
      if (!last) {
        if (bytes.length < MIN_PART) throw new Error("FakeR2: EntityTooSmall (part < 5 MiB)");
        const first = pending.parts.get(ordered[0]!.partNumber)!;
        if (bytes.length !== first.length) {
          throw new Error("FakeR2: all non-trailing parts must have the same length (10048)");
        }
      }
      chunks.push(bytes);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    this.bucket.dropPending(this.uploadId);
    return this.bucket.store(this.key, bytes, pending.httpMetadata, pending.customMetadata);
  }
}

export class FakeR2Bucket {
  readonly objects = new Map<string, Stored>();
  private readonly uploads = new Map<string, PendingUpload>();
  private uploadCounter = 0;

  store(
    key: string,
    bytes: Uint8Array,
    httpMetadata: { contentType?: string } = {},
    customMetadata: Record<string, string> = {},
  ): FakeR2Object {
    const stored: Stored = {
      bytes,
      httpMetadata,
      customMetadata,
      uploaded: new Date(),
      etag: etagOf(bytes),
    };
    this.objects.set(key, stored);
    return new FakeR2Object(key, stored);
  }

  pending(uploadId: string): PendingUpload {
    const pending = this.uploads.get(uploadId);
    if (!pending) throw new Error("FakeR2: NoSuchUpload");
    return pending;
  }

  dropPending(uploadId: string): void {
    this.uploads.delete(uploadId);
  }

  async put(
    key: string,
    value: unknown,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    } = {},
  ): Promise<FakeR2Object> {
    if (value instanceof ReadableStream && !(value as { knownLength?: boolean }).knownLength) {
      throw new Error("FakeR2: put() of a stream requires a known length");
    }
    const bytes = await readAll(value);
    return this.store(key, bytes, options.httpMetadata ?? {}, options.customMetadata ?? {});
  }

  async get(key: string, options: { range?: FakeR2Range } = {}): Promise<FakeR2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const r = options.range;
    if (!r) return new FakeR2ObjectBody(key, stored);
    const size = stored.bytes.length;
    const offset = r.suffix !== undefined ? Math.max(0, size - r.suffix) : (r.offset ?? 0);
    const length = r.suffix !== undefined ? size - offset : (r.length ?? size - offset);
    return new FakeR2ObjectBody(key, stored, { offset, length: Math.min(length, size - offset) });
  }

  async head(key: string): Promise<FakeR2Object | null> {
    const stored = this.objects.get(key);
    return stored ? new FakeR2Object(key, stored) : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{
    objects: FakeR2Object[];
    truncated: boolean;
    cursor?: string;
  }> {
    const keys = [...this.objects.keys()]
      .filter((k) => !options.prefix || k.startsWith(options.prefix))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => new FakeR2Object(k, this.objects.get(k)!)),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    };
  }

  async createMultipartUpload(
    key: string,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    } = {},
  ): Promise<FakeR2MultipartUpload> {
    const uploadId = `upload-${++this.uploadCounter}`;
    this.uploads.set(uploadId, {
      key,
      parts: new Map(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    });
    return new FakeR2MultipartUpload(this, key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): FakeR2MultipartUpload {
    return new FakeR2MultipartUpload(this, key, uploadId);
  }

  bytes(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }
}
