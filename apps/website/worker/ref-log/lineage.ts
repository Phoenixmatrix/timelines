import type { SourceLineage } from "../../shared/api.ts";
import type { CodeSource, SourceSnapshot } from "../../shared/code-source.ts";
import type { RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import { canonicalSource, getWorkSource } from "../timelines/sources.ts";
import { Timing } from "../timing.ts";
import { lsRefs } from "../artifacts.ts";

/** Complete parent walk. Missing objects are unknown, never proof of non-membership. */
export async function ancestorSet(
  reader: Pick<RepoReader, "commit">,
  head: string,
): Promise<Set<string> | null> {
  const seen = new Set<string>();
  const pending = [head];
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    const commit = await reader.commit(oid);
    if (!commit) return null;
    seen.add(oid);
    pending.push(...commit.parents);
  }
  return seen;
}

/** Canonical authorization is the caller's responsibility; source identity is never a provider URL. */
export async function sourceLineage(
  env: Env,
  repo: RepoRow,
  sourceId: string,
  commit: string,
): Promise<SourceLineage | null> {
  const live = await db(env.DB)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", repo.id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!live) return null;
  const canonicalIdentity = canonicalSource(repo);
  const owned = sourceId === "canonical" ? null : await getWorkSource(env, repo.id, sourceId);
  if (sourceId !== "canonical" && (!owned || owned.owner_id !== repo.owner_id)) return null;
  const source: CodeSource = owned
    ? {
        sourceId,
        repoId: repo.id,
        kind: "timeline-work",
        timelineId: owned.timeline_id,
        ref: owned.work_ref,
      }
    : canonicalIdentity;
  const result: SourceLineage = {
    status: "unknown",
    source,
    commit,
    integration: null,
    canonical: null,
    members: [],
  };
  const expired = owned?.state === "purged" || owned?.state === "purging";
  const pending: Promise<unknown>[] = [];
  const reader = new RepoReader(
    env,
    repo.artifacts_name,
    repo.artifacts_remote,
    new Timing(),
    (work) => {
      pending.push(work);
    },
  );
  try {
    const refs = await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, [
      canonicalIdentity.ref,
    ]);
    const head = refs.find((ref) => ref.name === canonicalIdentity.ref)?.oid ?? null;
    const tip = head ? await reader.commit(head) : null;
    if (tip) result.canonical = { ...canonicalIdentity, commit: tip.hash, tree: tip.treeHash };
    const rows = await db(env.DB)
      .selectFrom("source_integration_members as m")
      .innerJoin("source_integration_receipts as r", "r.id", "m.receipt_id")
      .selectAll("r")
      .where("m.repo_id", "=", repo.id)
      .where("m.source_id", "=", sourceId)
      .where("m.commit_oid", "=", commit)
      .where("r.repo_id", "=", repo.id)
      .where("r.source_id", "=", sourceId)
      .where("r.status", "=", "complete")
      .execute();
    if (!rows.length) {
      const member = await db(env.DB)
        .selectFrom("source_progress_members")
        .select("commit_oid")
        .where("repo_id", "=", repo.id)
        .where("source_id", "=", sourceId)
        .where("commit_oid", "=", commit)
        .executeTakeFirst();
      result.status = expired ? "expired" : member ? "pending" : "unknown";
      return result;
    }
    const canonicalAncestors = head ? await ancestorSet(reader, head) : null;
    const admitted = canonicalAncestors
      ? rows.filter((row) => canonicalAncestors.has(row.canonical_commit))
      : [];
    // A rewritten canonical graph, an unavailable proof, or multiple integration
    // anchors cannot silently select a replay baseline for a local checkout.
    const unique = new Map(
      admitted.map((row) => [`${row.source_commit}:${row.canonical_commit}`, row]),
    );
    if (unique.size !== 1 || admitted.length !== rows.length) {
      result.status = expired ? "expired" : "ambiguous";
      return result;
    }
    const receipt = [...unique.values()][0]!;
    result.status = expired ? "expired" : "integrated";
    result.members = [commit];
    result.integration = {
      source: { ...source, commit: receipt.source_commit, tree: receipt.source_tree },
      canonical: {
        ...canonicalIdentity,
        commit: receipt.canonical_commit,
        tree: receipt.canonical_tree,
      },
      logicalBase: JSON.parse(receipt.logical_base_json) as SourceSnapshot,
    };
    return result;
  } finally {
    await Promise.allSettled(pending);
    await reader.close();
  }
}
