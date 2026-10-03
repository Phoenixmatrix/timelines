// Test helpers: git objects and packs built by hand.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const encoder = new TextEncoder();
const TYPES = { commit: 1, tree: 2, blob: 3, "ofs-delta": 6, "ref-delta": 7 } as const;

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A commit's body as git (and gm, with a change id) writes it. */
export function commitBody(options: {
  parents?: string[];
  changeId?: string;
  message?: string;
}): Uint8Array {
  const lines = [`tree ${EMPTY_TREE}`, ...(options.parents ?? []).map((p) => `parent ${p}`)];
  lines.push("author Ann Lee <ann@example.com> 1790000000 +0000");
  lines.push("committer Ann Lee <ann@example.com> 1790000000 +0000");
  if (options.changeId) lines.push(`change-id ${options.changeId}`);
  return encoder.encode(`${lines.join("\n")}\n\n${options.message ?? "Change"}\n`);
}

export function objectId(type: string, body: Uint8Array): string {
  return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

/** A delta that copies `base`'s common prefix and inserts the rest of `target`. */
export function makeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
      n >>>= 7;
    } while (n);
    return out;
  };
  const bytes = [...varint(base.length), ...varint(target.length)];
  let prefix = 0;
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix])
    prefix++;
  // Copy: offset 0 (no offset bytes), size in up to three bytes.
  if (prefix > 0) bytes.push(0x80 | 0x10 | 0x20, prefix & 0xff, (prefix >> 8) & 0xff);
  for (let at = prefix; at < target.length; at += 127) {
    const chunk = target.subarray(at, Math.min(at + 127, target.length));
    bytes.push(chunk.length, ...chunk);
  }
  return new Uint8Array(bytes);
}

export type PackEntry =
  | { type: "commit" | "tree" | "blob"; body: Uint8Array }
  /** `base` is the index of an earlier entry. */
  | { type: "ofs-delta"; base: number; delta: Uint8Array }
  | { type: "ref-delta"; base: string; delta: Uint8Array };

/** A version 2 pack of `entries`, in order. */
export function buildPack(entries: PackEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 12;
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, entries.length);
  parts.push(header);
  for (const entry of entries) {
    offsets.push(size);
    const data = "body" in entry ? entry.body : entry.delta;
    let length = data.length;
    const head = [(TYPES[entry.type] << 4) | (length & 15)];
    length >>>= 4;
    while (length) {
      head[head.length - 1]! |= 0x80;
      head.push(length & 0x7f);
      length >>>= 7;
    }
    if (entry.type === "ofs-delta") {
      let distance = size - offsets[entry.base]!;
      const encoded = [distance & 0x7f];
      while ((distance >>>= 7)) {
        distance--;
        encoded.unshift(0x80 | (distance & 0x7f));
      }
      head.push(...encoded);
    } else if (entry.type === "ref-delta") {
      head.push(...Buffer.from(entry.base, "hex"));
    }
    const object = new Uint8Array([...head, ...deflateSync(data)]);
    parts.push(object);
    size += object.length;
  }
  const pack = new Uint8Array(size + 20);
  let offset = 0;
  for (const part of parts) {
    pack.set(part, offset);
    offset += part.length;
  }
  pack.set(createHash("sha1").update(pack.subarray(0, size)).digest(), size);
  return pack;
}
