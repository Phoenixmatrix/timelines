import type { SourceSnapshot } from "../../shared/code-source.ts";
import type { LandedTimeline } from "../../shared/release-notes.ts";
import { db } from "../schema.ts";

export interface CompactReleaseInput {
  receiptId: string;
  source: SourceSnapshot;
  commits: ArtifactsCommitMetadata[];
  timeline: LandedTimeline;
}

/** Durable metadata captured before CAS, not a read of an expirable work repository. */
export async function compactReleaseInputs(
  d1: D1Database,
  repoId: string,
  commits: string[],
): Promise<Map<string, CompactReleaseInput>> {
  const result = new Map<string, CompactReleaseInput>();
  for (let start = 0; start < commits.length; start += 90) {
    const rows = await db(d1)
      .selectFrom("source_integration_receipts as r")
      .innerJoin("source_integration_inputs as i", "i.receipt_id", "r.id")
      .leftJoin("timeline_work_sources as s", "s.source_id", "r.source_id")
      .innerJoin("repos as repository", "repository.id", "r.repo_id")
      .select([
        "r.id",
        "r.source_id",
        "r.source_commit",
        "r.source_tree",
        "r.canonical_commit",
        "i.commits_json",
        "s.timeline_id",
        "s.timeline_slug",
        "s.work_ref",
        "s.repo_id as source_repo_id",
        "s.space_id as source_space_id",
        "repository.space_id as repo_space_id",
      ])
      .where("r.repo_id", "=", repoId)
      .where("r.status", "=", "complete")
      .where("r.noop", "=", 0)
      .where("r.canonical_commit", "in", commits.slice(start, start + 90))
      .execute();
    for (const row of rows) {
      if (
        !row.source_space_id ||
        !row.repo_space_id ||
        row.source_repo_id !== repoId ||
        row.source_space_id !== row.repo_space_id ||
        row.timeline_id === null ||
        row.timeline_slug === null ||
        row.work_ref === null
      )
        throw new Error("release_source_scope_mismatch: compact receipt requires reconciliation.");
      const source: SourceSnapshot = {
        sourceId: row.source_id,
        repoId,
        timelineId: row.timeline_id,
        kind: "timeline-work",
        ref: row.work_ref,
        commit: row.source_commit,
        tree: row.source_tree,
      };
      result.set(row.canonical_commit, {
        receiptId: row.id,
        source,
        commits: JSON.parse(row.commits_json) as ArtifactsCommitMetadata[],
        timeline: {
          id: row.timeline_id,
          branch: `timeline/${row.timeline_slug}`,
          landing: row.canonical_commit,
          kind: "compact",
          source,
        },
      });
    }
  }
  return result;
}
