import type { CheckpointRepo } from "../../shared/timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import type { Access } from "../tracker/store.ts";
import type { NewTimeline, TimelineStore } from "../tracker/timelines.ts";

/** Allocate through the real Tracker authority before creating an active fixture. */
export function ownedTimeline(store: TimelineStore, access: Access, input: NewTimeline) {
  const id = store.reserveTimeline(access, input.slug, input.parent, JSON.stringify(input));
  const repos = input.repos.map((repo) => {
    const base: SourceSnapshot = {
      sourceId: "canonical",
      repoId: repo.id,
      kind: "canonical",
      timelineId: null,
      ref: "refs/heads/main",
      commit: input.commits[repo.id]!,
      tree: input.commits[repo.id]!,
    };
    const reserved = store.reserveWorkSource(
      { id: repo.id, owner_id: access.owner.id },
      {
        timelineId: id,
        timelineSlug: input.slug,
        base,
      },
    );
    const creating = store.transitionWorkSource(reserved.source_id, reserved.version, "creating");
    store.transitionWorkSource(
      creating.source_id,
      creating.version,
      "ready",
      `https://fixture/${reserved.artifacts_name}`,
    );
    return {
      ...repo,
      source: {
        sourceId: reserved.source_id,
        repoId: repo.id,
        timelineId: id,
        kind: "timeline-work" as const,
        ref: "refs/heads/work",
      },
      logicalBase: base,
      dependencies: [],
    };
  });
  return store.create(access, { ...input, id, repos });
}

export function ownedCheckpointRepo(
  store: TimelineStore,
  slug: string,
  repo: CheckpointRepo,
): CheckpointRepo {
  const entry = store.get(slug).repos.find((entry) => entry.id === repo.id)!;
  return {
    ...repo,
    source: { ...entry.source!, commit: repo.commit, tree: repo.commit },
    logicalBase: entry.logicalBase!,
    dependencies: entry.dependencies!,
  };
}
