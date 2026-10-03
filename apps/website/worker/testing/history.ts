// Test helpers: a repository's history in memory, readable the way the
// Artifacts binding (readCommit, readTree, readBlob, log) and RepoReader read
// it. Objects are content-addressed, so the same file is the same blob.

import { createHash } from "node:crypto";
import type { BlameReader } from "../why/blame.ts";

const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha1").update(text).digest("hex");

export interface FakeCommit {
  parents?: string[];
  /** Path to contents: the whole tree at this commit. */
  files: Record<string, string>;
  message?: string;
  /** Unix seconds; defaults to one second after the newest parent. */
  at?: number;
}

export function fakeHistory() {
  const commits = new Map<string, ArtifactsCommitMetadata>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, Uint8Array>();

  const writeTree = (files: Record<string, string>): string => {
    const here = new Map<string, Record<string, string> | string>();
    for (const [path, text] of Object.entries(files)) {
      const [head, ...rest] = path.split("/");
      if (!rest.length) here.set(head!, text);
      else {
        const sub = (here.get(head!) as Record<string, string> | undefined) ?? {};
        sub[rest.join("/")] = text;
        here.set(head!, sub);
      }
    }
    const entries: ArtifactsTreeEntry[] = [...here]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        if (typeof value === "string") {
          const hash = sha(`blob ${value}`);
          blobs.set(hash, encoder.encode(value));
          return { name, mode: "100644", hash, type: "blob" };
        }
        return { name, mode: "40000", hash: writeTree(value), type: "tree" };
      });
    const hash = sha(`tree ${JSON.stringify(entries)}`);
    trees.set(hash, entries);
    return hash;
  };

  const commit = (spec: FakeCommit): string => {
    const parents = spec.parents ?? [];
    const at =
      spec.at ?? Math.max(1_790_000_000, ...parents.map((p) => commits.get(p)!.committedAt + 1));
    const treeHash = writeTree(spec.files);
    const message = spec.message ?? "Change";
    const hash = sha(`commit ${treeHash} ${parents.join(",")} ${at} ${message}`);
    commits.set(hash, {
      hash,
      treeHash,
      message,
      author: { name: "Ann Lee", email: "ann@example.com" },
      committer: { name: "Ann Lee", email: "ann@example.com" },
      parents,
      authoredAt: at,
      committedAt: at,
    });
    return hash;
  };

  const log = (oid: string, limit: number, offset: number) => {
    const chain: ArtifactsCommitMetadata[] = [];
    for (let next = commits.get(oid); next && chain.length < offset + limit;) {
      chain.push(next);
      next = next.parents[0] ? commits.get(next.parents[0]) : undefined;
    }
    return chain.slice(offset);
  };

  const entryAt = async (root: string, path: string) => {
    let entries = trees.get(root) ?? [];
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      const entry = entries.find((e) => e.name === segment);
      if (!entry) return null;
      if (index === segments.length - 1) return entry;
      entries = trees.get(entry.hash) ?? [];
    }
    return null;
  };

  /** What blame reads, straight from memory. */
  const reader: BlameReader = {
    commit: async (oid) => commits.get(oid) ?? null,
    log: async (oid, limit, offset) => log(oid, limit, offset),
    entryAt,
    blob: async (oid) => {
      const bytes = blobs.get(oid);
      return bytes ? { size: bytes.length, bytes } : null;
    },
  };

  /** An Artifacts binding serving this history under any name. */
  const artifacts = {
    get: async () => ({
      readCommit: async (oid: string) => commits.get(oid) ?? null,
      readTree: async (oid: string) => trees.get(oid) ?? null,
      readBlob: async (oid: string) => {
        const bytes = blobs.get(oid);
        return bytes ? new Blob([bytes]) : null;
      },
      log: async ({ ref, limit, offset }: { ref: string; limit: number; offset: number }) =>
        log(ref, limit, offset),
      [Symbol.dispose]() {},
    }),
  };

  return { commit, commits, reader, artifacts };
}
