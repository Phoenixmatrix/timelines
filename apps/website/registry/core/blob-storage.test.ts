import { createHash } from "node:crypto";

import { compressFrame, FRAME_SIZE, makeDelta } from "@gitmatrix/formats/artifact-storage";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeHarness } from "../testing/harness.ts";
import {
  loadBlobManifest,
  readBlobRange,
  readBlobStream,
  type BlobManifest,
} from "./blob-storage.ts";
import { serveBlob } from "./blobs.ts";
import { RegistryError } from "./errors.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let value = 0x6b843921;
  for (let i = 0; i < length; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    bytes[i] = value & 255;
  }
  return bytes;
}

async function representation(
  bucket: R2Bucket,
  bytes: Uint8Array,
  base?: { key: string; bytes: Uint8Array },
): Promise<{ key: string; manifest: BlobManifest }> {
  const prefix = `c/${crypto.randomUUID()}/`;
  const key = `${prefix}index.json`;
  const manifest: BlobManifest = {
    version: 1,
    size: bytes.length,
    digest: `sha256:${hash(bytes)}`,
    frameSize: FRAME_SIZE,
    base: base?.key ?? null,
    frames: [],
  };
  for (let offset = 0; offset < bytes.length; offset += FRAME_SIZE) {
    const frame = bytes.subarray(offset, offset + FRAME_SIZE);
    const payload = base
      ? makeDelta(base.bytes.subarray(offset, offset + FRAME_SIZE), frame)
      : frame;
    const compressed = compressFrame(payload);
    const frameKey = `${prefix}${manifest.frames.length}.frame`;
    await bucket.put(frameKey, compressed.data);
    manifest.frames.push({
      key: frameKey,
      size: frame.length,
      sha256: hash(frame),
      codec: compressed.codec,
      payloadSize: payload.length,
      storedSize: compressed.data.length,
      delta: base !== undefined,
    });
  }
  await bucket.put(key, JSON.stringify(manifest));
  return { key, manifest };
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function same(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

describe("historical artifact reads", () => {
  it("preserves downloads, checksums, HEAD and ranges across a delta frame boundary", async () => {
    const h = await makeHarness();
    const bucket = h.env.REGISTRY_BLOBS;
    const original = noise(FRAME_SIZE + 97);
    const snapshot = await representation(bucket, original);
    const changed = original.slice();
    changed[FRAME_SIZE - 3] = changed[FRAME_SIZE - 3]! ^ 19;
    changed[FRAME_SIZE + 4] = changed[FRAME_SIZE + 4]! ^ 73;
    const version = await representation(bucket, changed, { key: snapshot.key, bytes: original });
    const blob = { r2Key: version.key, size: changed.length, digest: version.manifest.digest };
    const download = await serveBlob(
      new Request("https://registry.test/old-version"),
      bucket,
      blob,
    );
    expect(download.headers.get("etag")).toBe(`"${blob.digest}"`);
    expect(download.headers.get("content-length")).toBe(String(changed.length));
    same(new Uint8Array(await download.arrayBuffer()), changed);
    const range = await serveBlob(
      new Request("https://registry.test/old-version", {
        headers: { range: `bytes=${FRAME_SIZE - 8}-${FRAME_SIZE + 15}` },
      }),
      bucket,
      blob,
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes ${FRAME_SIZE - 8}-${FRAME_SIZE + 15}/${changed.length}`,
    );
    same(
      new Uint8Array(await range.arrayBuffer()),
      changed.subarray(FRAME_SIZE - 8, FRAME_SIZE + 16),
    );
    const head = await serveBlob(
      new Request("https://registry.test/old-version", { method: "HEAD" }),
      bucket,
      blob,
    );
    expect(head.headers.get("content-length")).toBe(String(changed.length));
    expect(await head.text()).toBe("");
    const unchanged = await serveBlob(
      new Request("https://registry.test/old-version", {
        headers: { "if-none-match": `"${blob.digest}"` },
      }),
      bucket,
      blob,
    );
    expect(unchanged.status).toBe(304);
    same(
      await readBlobRange(bucket, snapshot.key, FRAME_SIZE - 8, 24),
      original.subarray(FRAME_SIZE - 8, FRAME_SIZE + 16),
    );
  });

  it("rejects a delta whose base is another delta", async () => {
    const h = await makeHarness();
    const bucket = h.env.REGISTRY_BLOBS;
    const original = noise(4096);
    const snapshot = await representation(bucket, original);
    const delta = await representation(bucket, original, { key: snapshot.key, bytes: original });
    const chained = await representation(bucket, original, { key: delta.key, bytes: original });
    await expect(collect(await readBlobStream(bucket, chained.key))).rejects.toThrowError(
      RegistryError,
    );
  });

  it("rejects corrupted payloads and oversized frame descriptors before serving data", async () => {
    const h = await makeHarness();
    const bucket = h.env.REGISTRY_BLOBS;
    const bytes = noise(4096);
    const stored = await representation(bucket, bytes);
    const frame = stored.manifest.frames[0]!;
    await bucket.put(frame.key, new Uint8Array(frame.storedSize));
    await expect(collect(await readBlobStream(bucket, stored.key))).rejects.toThrow();
    frame.payloadSize = FRAME_SIZE * 3;
    await bucket.put(stored.key, JSON.stringify(stored.manifest));
    await expect(loadBlobManifest(bucket, stored.key)).rejects.toThrowError(RegistryError);
  });

  it("serves previously read historical frames from the access cache without their origin payloads", async () => {
    const entries = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, new Response(await response.arrayBuffer(), response));
        },
        delete: async (request: Request) => entries.delete(request.url),
      }),
    });
    const h = await makeHarness();
    const bucket = h.env.REGISTRY_BLOBS;
    const original = noise(16_384);
    const snapshot = await representation(bucket, original);
    const changed = original.slice();
    changed[900] = changed[900]! ^ 128;
    const historical = await representation(bucket, changed, {
      key: snapshot.key,
      bytes: original,
    });
    same(await collect(await readBlobStream(bucket, historical.key)), changed);
    // The immutable manifest remains authoritative; only payload retrieval is cached.
    await bucket.delete(
      [...snapshot.manifest.frames, ...historical.manifest.frames].map((frame) => frame.key),
    );
    same(await readBlobRange(bucket, historical.key, 890, 32), changed.subarray(890, 922));
  });
});
