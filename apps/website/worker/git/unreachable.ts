// Unreachable git data (CORE-202). A deleted branch, a force push, or a
// landed or abandoned timeline's bookmark leaves commits no ref reaches.
// Artifacts keeps them: it has no gc, prune or repack, and still serves an
// unreachable commit to a fetch by id (any-sha1-in-want). Its pricing bills
// stored bytes, so they cost money, but nothing here can delete them; we
// measure them instead (usage metering, worker/usage/collect.ts).
//
// The measurement: the commits the push log saw leave a ref (a deletion's or
// a force push's old commit) that no ref holds now are fetched with every
// current ref tip as a `have`, so the pack holds exactly the objects only
// unreachable commits reach. Its size, as Artifacts packs it, is the figure;
// nothing is stored, and the pack is counted as it streams.

import { lsRefs, upstreamToken } from "../artifacts.ts";
import { packFromFetchResponse } from "../mirror/protocol.ts";
import { DELIM, FLUSH, pkt } from "./pktline.ts";

export const UNREACHABLE_LIMITS = {
  /** Unreachable commits one fetch asks for (the most recent). */
  wants: 256,
  /** Pack bytes counted before stopping: the figure is then a lower bound. */
  maxBytes: 512 * 1024 * 1024,
  /** How long one measurement may stream. */
  timeoutMs: 15_000,
};

export interface UnreachableRepo {
  id: string;
  artifacts_name: string;
  artifacts_remote: string;
}

export interface Unreachable {
  /** Commits that left a ref and that no ref holds now (at most `wants`). */
  commits: number;
  /** Objects only those commits reach, and their packed bytes. */
  objects: number;
  bytes: number;
  /** The pack was cut short (size or time): the figures are lower bounds. */
  truncated: boolean;
}

/** The commits refs of `repoId` left, per the push log, newest first. */
export async function droppedCommits(
  d1: D1Database,
  repoId: string,
  limit = UNREACHABLE_LIMITS.wants,
): Promise<string[]> {
  const { results } = await d1
    .prepare(
      `SELECT old_oid AS oid, max(id) AS last FROM ref_updates
        WHERE repo_id = ?1 AND old_oid IS NOT NULL AND (new_oid IS NULL OR forced = 1)
        GROUP BY old_oid ORDER BY last DESC LIMIT ?2`,
    )
    .bind(repoId, limit)
    .all<{ oid: string }>();
  return results.map((r) => r.oid);
}

/** A protocol v2 fetch of everything `wants` reach and `haves` don't, as a full (not thin) pack. */
export function unreachableRequest(wants: string[], haves: string[]): string {
  let body =
    pkt("command=fetch\n") +
    pkt("agent=gitmatrix\n") +
    pkt("object-format=sha1\n") +
    DELIM +
    pkt("no-progress\n") +
    pkt("ofs-delta\n");
  for (const oid of wants) body += pkt(`want ${oid}\n`);
  for (const oid of haves) body += pkt(`have ${oid}\n`);
  return body + pkt("done\n") + FLUSH;
}

/** Count a pack as it streams: its object count (header) and bytes, up to `maxBytes`. */
export async function countPack(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ objects: number; bytes: number; truncated: boolean }> {
  let bytes = 0;
  const header = new Uint8Array(12);
  let truncated = false;
  try {
    for await (const chunk of packFromFetchResponse(stream)) {
      if (bytes < 12) header.set(chunk.subarray(0, 12 - bytes), bytes);
      bytes += chunk.length;
      if (bytes > maxBytes || signal?.aborted) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    // Everything wanted is had: Artifacts may answer without a pack.
    if (error instanceof Error && error.message === "Artifacts sent no pack")
      return { objects: 0, bytes: 0, truncated: false };
    if (!signal?.aborted) throw error;
    truncated = true;
  }
  if (truncated) await stream.cancel().catch(() => undefined);
  const objects =
    bytes >= 12 && new TextDecoder().decode(header.subarray(0, 4)) === "PACK"
      ? new DataView(header.buffer).getUint32(8)
      : 0;
  return { objects, bytes, truncated };
}

/** Measure a repository's unreachable data. One fetch, only when the push log saw a ref leave a commit. */
export async function measureUnreachable(
  env: Env,
  repo: UnreachableRepo,
  limits = UNREACHABLE_LIMITS,
): Promise<Unreachable> {
  const dropped = await droppedCommits(env.DB, repo.id, limits.wants);
  if (!dropped.length) return { commits: 0, objects: 0, bytes: 0, truncated: false };
  const tips = new Set(
    // Every ref, not only branches and tags: anything a ref reaches is reachable.
    (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, []))
      .map((ref) => ref.oid)
      .filter((oid): oid is string => Boolean(oid)),
  );
  const wants = dropped.filter((oid) => !tips.has(oid));
  if (!wants.length) return { commits: 0, objects: 0, bytes: 0, truncated: false };
  const token = await upstreamToken(env, repo.artifacts_name, "read");
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const response = await fetch(`${repo.artifacts_remote}/git-upload-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
    },
    body: unreachableRequest(wants, [...tips]),
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error(`Measuring unreachable data: fetch failed with HTTP ${response.status}`);
  const pack = await countPack(response.body, limits.maxBytes, signal);
  return { commits: wants.length, ...pack };
}
