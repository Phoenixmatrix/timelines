import { createHash, type Hash } from "node:crypto";
import { sql } from "kysely";
import { getBlob, writeBlob } from "../core/blobs.ts";
import { readBlobStream } from "../core/blob-storage.ts";
import { createDb, type DB } from "../core/db.ts";
import { RegistryError } from "../core/errors.ts";

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const decoder = new TextDecoder();
const invalid = () => RegistryError.badRequest("Invalid or unsupported npm archive.");
export function archivePath(value: string): string {
  const path = value.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 31 || code === 127 || code === 92) throw invalid();
  }
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw invalid();
  return path;
}
function text(b: Uint8Array): string {
  const end = b.indexOf(0);
  return decoder.decode(end < 0 ? b : b.subarray(0, end));
}
function octal(b: Uint8Array): number {
  let n = 0;
  if (b[0]! & 128) {
    if (b[0] !== 128) throw invalid();
    for (const v of b.subarray(1)) n = n * 256 + v;
  } else {
    const value = text(b).trim();
    if (!/^[0-7]*$/.test(value)) throw invalid();
    n = value ? Number.parseInt(value, 8) : 0;
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BYTES) throw invalid();
  return n;
}
function pax(bytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    if (space < at) throw invalid();
    const size = Number(decoder.decode(bytes.subarray(at, space)));
    if (
      !Number.isSafeInteger(size) ||
      size <= space - at + 1 ||
      at + size > bytes.length ||
      bytes[at + size - 1] !== 10
    )
      throw invalid();
    const record = decoder.decode(bytes.subarray(space + 1, at + size - 1));
    const eq = record.indexOf("=");
    if (eq < 1) throw invalid();
    const key = record.slice(0, eq);
    if (key === "path" || key === "size") result[key] = record.slice(eq + 1);
    at += size;
  }
  return result;
}

/** The RepoDO coalesces calls; D1 ready is published only after the tar and index are durable. */
export async function cacheNpmArchive(env: Env, repoId: string, digest: string): Promise<string> {
  const db = createDb(env.REGISTRY_DB);
  const existing = await db
    .selectFrom("archive_caches")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("digest", "=", digest)
    .executeTakeFirst();
  if (existing?.ready) return existing.id;
  const blob = await getBlob(db, digest);
  if (!blob) throw RegistryError.notFound("Archive not found.");
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db.deleteFrom("archive_members").where("cache_id", "=", id).execute();
    if (existing.r2_key) await env.REGISTRY_BLOBS.delete(existing.r2_key);
  } else {
    await db
      .insertInto("archive_caches")
      .values({ id, repo_id: repoId, digest, r2_key: "", ready: 0 })
      .execute();
  }
  const parser = new TarIndex(db, id);
  const stream = (await readBlobStream(env.REGISTRY_BLOBS, blob.r2Key))
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          await parser.push(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          return parser.finish();
        },
      }),
    );
  const written = await writeBlob(env.REGISTRY_BLOBS, stream, { maxBytes: MAX_BYTES });
  try {
    await db
      .updateTable("archive_caches")
      .set({ r2_key: written.r2Key, ready: 1 })
      .where("id", "=", id)
      .execute();
  } catch (error) {
    await env.REGISTRY_BLOBS.delete(written.r2Key);
    throw error;
  }
  return id;
}

class TarIndex {
  private header = new Uint8Array(512);
  private filled = 0;
  private position = 0;
  private remaining = 0;
  private padding = 0;
  private ended = false;
  private entries = 0;
  private extension: Uint8Array | null = null;
  private extensionAt = 0;
  private type = "";
  private local: Record<string, string> = {};
  private global: Record<string, string> = {};
  private longName: string | null = null;
  private member: { path: string; offset: number; size: number } | null = null;
  private hash: Hash | null = null;
  private readonly directories = new Set<string>();
  private pending: {
    path: string;
    parent: string;
    kind: "file" | "directory";
    offset: number;
    size: number;
    digest: string | null;
  }[] = [];
  private indexedBytes = 0;
  private pendingBytes = 0;
  private readonly db: DB;
  private readonly id: string;
  constructor(db: DB, id: string) {
    this.db = db;
    this.id = id;
  }
  async push(chunk: Uint8Array): Promise<void> {
    let at = 0;
    while (at < chunk.length) {
      if (this.ended) {
        if (chunk.subarray(at).some((b) => b !== 0)) throw invalid();
        this.position += chunk.length - at;
        return;
      }
      if (this.remaining) {
        const take = Math.min(this.remaining, chunk.length - at);
        const part = chunk.subarray(at, at + take);
        this.hash?.update(part);
        if (this.extension) {
          this.extension.set(part, this.extensionAt);
          this.extensionAt += take;
        }
        at += take;
        this.position += take;
        this.remaining -= take;
        if (!this.remaining) await this.endMember();
      } else if (this.padding) {
        const take = Math.min(this.padding, chunk.length - at);
        this.padding -= take;
        this.position += take;
        at += take;
      } else {
        const take = Math.min(512 - this.filled, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.filled);
        this.filled += take;
        at += take;
        this.position += take;
        if (this.filled === 512) {
          this.filled = 0;
          await this.startMember();
        }
      }
    }
    if (this.position > MAX_BYTES) throw invalid();
  }
  private async startMember(): Promise<void> {
    const h = this.header;
    if (h.every((b) => b === 0)) {
      this.ended = true;
      return;
    }
    const sum = h.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(h.subarray(148, 156))) throw invalid();
    if (++this.entries > MAX_ENTRIES) throw invalid();
    this.type = String.fromCharCode(h[156]!);
    const ext = ["x", "g", "L", "K"].includes(this.type);
    const attrs = { ...this.global, ...this.local };
    const size =
      !ext && attrs.size !== undefined ? Number(attrs.size) : octal(h.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw invalid();
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    if (ext) {
      if (size > 1024 * 1024) throw invalid();
      this.extension = new Uint8Array(size);
      this.extensionAt = 0;
    } else {
      const prefix = text(h.subarray(345, 500));
      const name =
        attrs.path ??
        this.longName ??
        (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
      this.local = {};
      this.longName = null;
      const path = archivePath(name);
      if (["0", "\0", "7", "5"].includes(this.type)) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) await this.directory(parts.slice(0, i).join("/"));
        if (this.type === "5") await this.directory(path);
        else {
          this.member = { path, offset: this.position, size };
          this.hash = createHash("sha256");
        }
      }
      // Links and special devices are deliberately not materialized or followed.
    }
    if (!size) await this.endMember();
  }
  private async directory(path: string): Promise<void> {
    if (this.directories.has(path)) return;
    this.directories.add(path);
    await this.index({
      path,
      parent: path.split("/").slice(0, -1).join("/"),
      kind: "directory",
      offset: 0,
      size: 0,
      digest: null,
    });
  }
  private async endMember(): Promise<void> {
    if (this.extension) {
      if (this.type === "x") this.local = pax(this.extension);
      if (this.type === "g") this.global = { ...this.global, ...pax(this.extension) };
      if (this.type === "L") this.longName = text(this.extension);
      this.extension = null;
    }
    if (this.member && this.hash) {
      const m = this.member;
      await this.index({
        ...m,
        parent: m.path.split("/").slice(0, -1).join("/"),
        kind: "file",
        digest: `sha256:${this.hash.digest("hex")}`,
      });
      this.member = null;
      this.hash = null;
    }
  }
  private async index(row: (typeof this.pending)[number]): Promise<void> {
    this.indexedBytes += row.path.length * 2 + row.parent.length * 2;
    if (this.indexedBytes > 16 * 1024 * 1024)
      throw new RegistryError("too_large", "Archive names exceed the 16 MiB index limit.");
    this.pending.push(row);
    this.pendingBytes += row.path.length * 2 + row.parent.length * 2;
    if (this.pending.length >= 500 || this.pendingBytes > 128 * 1024) await this.flushIndex();
  }
  private async flushIndex(): Promise<void> {
    if (!this.pending.length) return;
    // One bounded JSON parameter avoids D1's SQL-variable limit and per-member round trips.
    await sql`INSERT INTO archive_members (cache_id, path, parent, kind, offset, size, digest)
      SELECT ${this.id}, json_extract(value, '$.path'), json_extract(value, '$.parent'),
        json_extract(value, '$.kind'), json_extract(value, '$.offset'),
        json_extract(value, '$.size'), json_extract(value, '$.digest')
      FROM json_each(${JSON.stringify(this.pending)})`.execute(this.db);
    this.pending = [];
    this.pendingBytes = 0;
  }
  async finish(): Promise<void> {
    if (!this.ended || this.remaining || this.filled) throw invalid();
    await this.flushIndex();
  }
}
