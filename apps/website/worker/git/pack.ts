// Reading the commits out of a git pack: enough to see headers git's own
// tools keep but the Artifacts binding drops (gm's `change-id`).
// https://git-scm.com/docs/pack-format

import { inflateSync } from "node:zlib";

const COMMIT = 1;
const OFS_DELTA = 6;
const REF_DELTA = 7;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface PackCommit {
  oid: string;
  parents: string[];
  /** gm's (and jj's) `change-id` header, when the commit has one. */
  changeId: string | null;
}

/**
 * Every commit in a pack, in pack order. Other objects are inflated only to
 * find where the next one starts. Deltas resolve against commits earlier in
 * the same pack (a pack fetched without `thin-pack` has its bases). A pack
 * cut short (a size cap) yields the commits read before the cut.
 */
export async function packCommits(pack: Uint8Array): Promise<PackCommit[]> {
  if (pack.length < 12 || decoder.decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("Not a git pack");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const count = view.getUint32(8);
  // Commit bodies by pack offset and by id, for deltas based on them.
  const byOffset = new Map<number, Uint8Array>();
  const byOid = new Map<string, Uint8Array>();
  const commits: PackCommit[] = [];
  let offset = 12;
  for (let index = 0; index < count && offset < pack.length; index++) {
    const start = offset;
    let byte = pack[offset++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80 && offset < pack.length) byte = pack[offset++]!;
    let base: Uint8Array | undefined;
    if (type === OFS_DELTA) {
      byte = pack[offset++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        distance = ((distance + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(start - distance);
    } else if (type === REF_DELTA) {
      base = byOid.get(hex(pack.subarray(offset, offset + 20)));
      offset += 20;
    }
    let data: Uint8Array;
    try {
      const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
        buffer: Uint8Array;
        engine: { bytesWritten: number };
      };
      data = inflated.buffer;
      offset += inflated.engine.bytesWritten;
    } catch {
      break; // Cut short mid-object.
    }
    // A delta's type is its base's; only commits are kept as bases.
    if (type === OFS_DELTA || type === REF_DELTA) {
      if (!base) continue;
      data = applyDelta(base, data);
    } else if (type !== COMMIT) continue;
    const oid = await objectId("commit", data);
    byOffset.set(start, data);
    byOid.set(oid, data);
    commits.push({ oid, ...parseCommitHeaders(data) });
  }
  return commits;
}

/** A commit's parents and change id, from its header lines. */
export function parseCommitHeaders(body: Uint8Array): {
  parents: string[];
  changeId: string | null;
} {
  const text = decoder.decode(body);
  const end = text.indexOf("\n\n");
  const parents: string[] = [];
  let changeId: string | null = null;
  for (const line of (end === -1 ? text : text.slice(0, end)).split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("change-id ")) changeId = line.slice(10).trim() || null;
  }
  return { parents, changeId };
}

/** Git's object id: SHA-1 over `<type> <size>\0<body>`. */
async function objectId(type: string, body: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${body.length}\0`);
  const whole = new Uint8Array(header.length + body.length);
  whole.set(header);
  whole.set(body, header.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", whole)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rebuild an object from its base and a git delta (copy and insert instructions). */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new Error("Delta base size mismatch");
  const out = new Uint8Array(varint());
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++)
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** (bit * 8);
      for (let bit = 0; bit < 3; bit++)
        if (op & (16 << bit)) size += delta[offset++]! * 2 ** (bit * 8);
      if (size === 0) size = 0x10000;
      out.set(base.subarray(copyOffset, copyOffset + size), written);
      written += size;
    } else if (op > 0) {
      out.set(delta.subarray(offset, offset + op), written);
      offset += op;
      written += op;
    } else throw new Error("Invalid delta instruction");
  }
  if (written !== out.length) throw new Error("Delta result size mismatch");
  return out;
}
