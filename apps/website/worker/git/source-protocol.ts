import { parsePktLines, pkt, FLUSH } from "./pktline.ts";

/** A work clone sees one logical branch even when the fork inherited canonical refs. */
export function workAdvertisement(bytes: Uint8Array, oid: string, ref = "refs/heads/work") {
  const decoder = new TextDecoder();
  const lines = [...parsePktLines(bytes)];
  if (
    lines.some((line) => line.type === "data" && decoder.decode(line.data).trim() === "version 2")
  )
    return bytes;
  let service = "";
  let caps = "";
  for (const line of lines) {
    if (line.type !== "data") continue;
    const text = decoder.decode(line.data);
    if (text.startsWith("# service=")) service = pkt(text) + FLUSH;
    const nul = text.indexOf("\0");
    if (nul >= 0)
      caps = text
        .slice(nul + 1)
        .trim()
        .split(" ")
        .filter((cap) => !cap.startsWith("symref="))
        .join(" ");
  }
  return new TextEncoder().encode(
    service + pkt(`${oid} HEAD\0${caps} symref=HEAD:${ref}\n`) + pkt(`${oid} ${ref}\n`) + FLUSH,
  );
}

/** Inspect only the first protocol command; preserve every byte for fetch streaming. */
export async function uploadCommand(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let prefix = new Uint8Array(0);
  let length: number | null = null;
  while (length === null || prefix.length < length) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    const joined = new Uint8Array(
      prefix.length + Math.min(next.value.length, 65520 - prefix.length),
    );
    joined.set(prefix);
    joined.set(next.value.subarray(0, joined.length - prefix.length), prefix.length);
    prefix = joined;
    if (prefix.length >= 4 && length === null) {
      length = Number.parseInt(new TextDecoder().decode(prefix.subarray(0, 4)), 16);
      if (!Number.isFinite(length) || length < 4 || length > 65520) break;
    }
  }
  const command =
    length && length >= 4 ? new TextDecoder().decode(prefix.subarray(4, length)).trim() : "";
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        controller.close();
      } else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
  return { command, body: stream };
}

/** Metadata responses are bounded; packs always stay on the streaming path. */
export async function protocolBytes(response: Response, limit = 4 * 1024 * 1024) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Git metadata response exceeds its limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
