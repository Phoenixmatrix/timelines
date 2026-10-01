import { createHash } from "node:crypto";

import { FakeD1, FakeR2Bucket } from "@gitmatrix/testing";
import { describe, expect, it } from "vite-plus/test";

import { commitBlob, parseRange, PART_SIZE, serveBlob, writeBlob } from "./blobs.ts";
import { createDb } from "./db.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

function db() {
  const d1 = new FakeD1();
  d1.applySql(
    readFileSync(
      fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url).href),
      "utf8",
    ),
  );
  return createDb(d1 as unknown as D1Database);
}

describe("writeBlob", () => {
  it("stores small bodies with a single put and computes every digest", async () => {
    const bucket = new FakeR2Bucket();
    const data = new TextEncoder().encode("hello world");
    const blob = await writeBlob(bucket as unknown as R2Bucket, data);
    expect(blob.size).toBe(11);
    expect(blob.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(blob.md5).toBe(createHash("md5").update(data).digest("hex"));
    expect(bucket.bytes(blob.r2Key)).toEqual(data);
  });

  it("cuts unknown-length streams into uniform multipart parts", async () => {
    const bucket = new FakeR2Bucket();
    const data = new Uint8Array(PART_SIZE * 2 + 12345).map((_, i) => i % 251);
    // Odd chunk sizes straddle part boundaries; FakeR2 rejects non-uniform parts.
    const blob = await writeBlob(bucket as unknown as R2Bucket, chunked(data, 1_000_003));
    expect(blob.size).toBe(data.length);
    const stored = bucket.bytes(blob.r2Key)!;
    // Deep-equality on 16 MiB typed arrays exhausts the heap; compare digests.
    expect(createHash("sha256").update(stored).digest("hex")).toBe(blob.sha256);
    expect(blob.digest).toBe(`sha256:${createHash("sha256").update(data).digest("hex")}`);
  });

  it("rejects mismatched checksums and deletes the object", async () => {
    const bucket = new FakeR2Bucket();
    await expect(
      writeBlob(bucket as unknown as R2Bucket, "abc", { expect: { sha256: "00" } }),
    ).rejects.toMatchObject({ code: "digest_invalid" });
    expect(bucket.objects.size).toBe(0);
  });

  it("enforces maxBytes", async () => {
    const bucket = new FakeR2Bucket();
    await expect(
      writeBlob(bucket as unknown as R2Bucket, "abcdef", { maxBytes: 3 }),
    ).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("commitBlob", () => {
  it("deduplicates identical content", async () => {
    const bucket = new FakeR2Bucket();
    const database = db();
    const first = await commitBlob(
      database,
      bucket as unknown as R2Bucket,
      await writeBlob(bucket as unknown as R2Bucket, "same"),
    );
    const second = await commitBlob(
      database,
      bucket as unknown as R2Bucket,
      await writeBlob(bucket as unknown as R2Bucket, "same"),
    );
    expect(second.r2Key).toBe(first.r2Key);
    expect(bucket.objects.size).toBe(1);
  });
});

describe("serveBlob", () => {
  it("serves ranges, HEAD and conditional requests", async () => {
    const bucket = new FakeR2Bucket();
    const blob = await writeBlob(bucket as unknown as R2Bucket, "0123456789");
    const serve = (init: RequestInit & { headers?: Record<string, string> }) =>
      serveBlob(new Request("https://x/", init), bucket as unknown as R2Bucket, blob);

    const ranged = await serve({ headers: { range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("234");
    expect(ranged.headers.get("content-range")).toBe("bytes 2-4/10");

    expect(await (await serve({ headers: { range: "bytes=-3" } })).text()).toBe("789");
    expect((await serve({ headers: { range: "bytes=20-" } })).status).toBe(416);
    expect((await serve({ headers: { "if-none-match": `"${blob.digest}"` } })).status).toBe(304);
    const head = await serve({ method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("10");
  });

  it("parses ranges", () => {
    expect(parseRange("bytes=0-", 5)).toEqual({ offset: 0, length: 5 });
    expect(parseRange("bytes=3-100", 5)).toEqual({ offset: 3, length: 2 });
    expect(parseRange("items=0-1", 5)).toBe("invalid");
  });
});
