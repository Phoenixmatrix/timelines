import { unzlibSync, zlibSync } from "fflate";

import { createHasher, fromHex, toHex } from "../hash/index.ts";

/**
 * Git object encoding (SHA-1 object format): loose-object hashing, trees,
 * commits and zlib. Trimmed to what a generated,
 * read-only repository needs.
 */
export type ObjType = "commit" | "tree" | "blob" | "tag";

export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjType | undefined> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function objectHeader(type: ObjType, size: number): Uint8Array {
  return enc.encode(`${type} ${size}\0`);
}

/** The object id: SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const hasher = createHasher("sha1");
  hasher.update(objectHeader(type, data.length));
  hasher.update(data);
  return toHex(hasher.digest());
}

/** zlib (RFC 1950) deflate, which is what loose objects and packs use. */
export function deflate(data: Uint8Array): Uint8Array {
  return zlibSync(data, { level: 6 });
}

export function inflate(data: Uint8Array): Uint8Array {
  return unzlibSync(data);
}

/** A loose object file's bytes: zlib(`<type> <size>\0<data>`). */
export function encodeLoose(type: ObjType, data: Uint8Array): Uint8Array {
  return deflate(concat([objectHeader(type, data.length), data]));
}

export interface TreeEntry {
  /** `100644`, `100755`, `120000`, `40000` or `160000`. */
  mode: string;
  name: string;
  oid: string;
}

function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Git's tree order: bytewise, with directory names compared as if they ended in `/`. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry) => enc.encode(isTreeMode(e.mode) ? `${e.name}/` : e.name);
  return [...entries].sort((a, b) => compareBytes(key(a), key(b)));
}

export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const entry of sortTreeEntries(entries)) {
    if (!entry.name || entry.name.includes("/") || entry.name.includes("\0")) {
      throw new Error(`invalid tree entry name ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) throw new Error(`duplicate tree entry ${entry.name}`);
    seen.add(entry.name);
    if (!isOid(entry.oid)) throw new Error(`invalid oid ${entry.oid}`);
    parts.push(enc.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid));
  }
  return concat(parts);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    let nul = sp + 1;
    while (nul < data.length && data[nul] !== 0) nul++;
    if (nul + 21 > data.length) throw new Error("truncated tree");
    entries.push({
      mode: dec.decode(data.subarray(i, sp)),
      name: dec.decode(data.subarray(sp + 1, nul)),
      oid: toHex(data.subarray(nul + 1, nul + 21)),
    });
    i = nul + 21;
  }
  return entries;
}

export function entryIsTree(entry: TreeEntry): boolean {
  return isTreeMode(entry.mode);
}

export function entryIsSubmodule(entry: TreeEntry): boolean {
  return entry.mode === "160000";
}

export interface Identity {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** `+0000` style offset. */
  tz?: string;
}

export function formatIdent(ident: Identity): string {
  const clean = (s: string) => s.replace(/[<>\n\0]/g, "");
  return `${clean(ident.name)} <${clean(ident.email)}> ${Math.floor(ident.time)} ${ident.tz ?? "+0000"}`;
}

export interface CommitInput {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  message: string;
}

export function encodeCommit(commit: CommitInput): Uint8Array {
  let text = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) text += `parent ${parent}\n`;
  text += `author ${formatIdent(commit.author)}\n`;
  text += `committer ${formatIdent(commit.committer)}\n\n`;
  text += commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return enc.encode(text);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): Commit {
  const text = dec.decode(data);
  const idx = text.indexOf("\n\n");
  const head = idx === -1 ? text : text.slice(0, idx);
  const commit: Commit = {
    tree: "",
    parents: [],
    author: "",
    committer: "",
    message: idx === -1 ? "" : text.slice(idx + 2),
  };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (key === "tree") commit.tree = val;
    else if (key === "parent") commit.parents.push(val);
    else if (key === "author") commit.author = val;
    else if (key === "committer") commit.committer = val;
  }
  return commit;
}

/** An encoded object ready to store: pack entries need zlib(data) without the header. */
export interface EncodedObject {
  oid: string;
  type: ObjType;
  size: number;
  data: Uint8Array;
}

export function makeObject(type: ObjType, data: Uint8Array): EncodedObject {
  return { oid: hashObject(type, data), type, size: data.length, data };
}
