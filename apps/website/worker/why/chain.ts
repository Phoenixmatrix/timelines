// The rest of the "why" chain once blame has named a commit (CORE-85): its
// change id, the refs and timelines the change reached (CORE-68's push log),
// the merges that carried it, its issues, the checkpoints that pinned it and
// their approvals (CORE-76), and the queue landing that advanced main (CORE-77).
//
// Change ids join rewritten commits to their history. An exact main ref
// update joins the authoritative landing and its pinned checkpoint.

import type { ChangeRef } from "../../shared/api.ts";
import type { CodeSource } from "../../shared/code-source.ts";
import type {
  CheckpointState,
  Landing,
  Timeline,
  TimelineEvent,
  TimelineIssue,
} from "../../shared/timelines.ts";
import { timelineSlugOf } from "../../shared/timelines.ts";
import type { IssueStatus } from "../../shared/tracker.ts";
import {
  NO_DISCUSSIONS,
  type WhyChain,
  type WhyChangeSource,
  type WhyCheckpoint,
  type WhyCommit,
  type WhyIssue,
  type WhyLanding,
  type WhyLineKind,
  type WhyMerge,
  type WhyRef,
  type WhyTimeline,
} from "../../shared/why.ts";
import { issueKeys } from "../release-notes/keys.ts";

/** Commits of a change (on other refs) whose messages are read for issue keys. */
const MESSAGE_COMMITS = 8;

/** Where the chain's facts come from: D1, Artifacts and the owner's tracker, or fakes. */
export interface WhySources {
  repoId: string;
  defaultBranch: string;
  source?: CodeSource;
  /** A commit the repository has, or null. */
  commit(oid: string): Promise<WhyCommit | null>;
  /** The change the push log saw this commit as (first or latest commit on a ref). */
  changeFromPushLog(oid: string): Promise<string | null>;
  /** The commit's own `change-id` header, read from the repository. */
  changeFromHeader(oid: string): Promise<string | null>;
  /** The refs a change reached, oldest first. */
  changeRefs(changeId: string): Promise<ChangeRef[]>;
  /** Null when the caller can't read the owner's tracker: no tracker records then. */
  tracker: WhyTracker | null;
  /** Issues by key, from the trackers the caller can read that the repository is subscribed to. */
  issues(
    keys: string[],
  ): Promise<
    { id: string; key: string; title: string; status: IssueStatus; trackerOwner: string }[]
  >;
}

export interface WhyTracker {
  owner: string;
  timelines(): Promise<Timeline[]>;
  /** A timeline's events, oldest first, and its issues. */
  timeline(slug: string): Promise<{ events: TimelineEvent[]; issues: TimelineIssue[] } | null>;
  checkpoints(slug: string): Promise<CheckpointState[]>;
  /** Historical queue advance of this repository to an exact main tip. */
  landing(commit: string): Promise<{ landing: Landing; checkpoint: CheckpointState } | null>;
}

/** Memoize a one-argument async lookup for the length of a request. */
function once<A, R>(fn: (arg: A) => Promise<R>): (arg: A) => Promise<R> {
  const seen = new Map<A, Promise<R>>();
  return (arg) => {
    let hit = seen.get(arg);
    if (!hit) {
      hit = fn(arg);
      seen.set(arg, hit);
    }
    return hit;
  };
}

/** The same sources, each lookup made at most once: chains for one request share them. */
export function shared(sources: WhySources): WhySources {
  const tracker = sources.tracker;
  const timelines = tracker && once(() => tracker.timelines());
  return {
    ...sources,
    commit: once((oid) => sources.commit(oid)),
    changeFromPushLog: once((oid) => sources.changeFromPushLog(oid)),
    changeFromHeader: once((oid) => sources.changeFromHeader(oid)),
    changeRefs: once((id) => sources.changeRefs(id)),
    tracker: tracker && {
      owner: tracker.owner,
      timelines: () => timelines!(undefined),
      timeline: once((slug) => tracker.timeline(slug)),
      checkpoints: once((slug) => tracker.checkpoints(slug)),
      landing: once((commit) => tracker.landing(commit)),
    },
  };
}

function lineKind(ref: string, mainRef: string): WhyLineKind {
  if (ref === mainRef) return "main";
  if (timelineSlugOf(ref)) return "timeline";
  return ref.startsWith("refs/tags/") ? "tag" : "branch";
}

function whyTimeline(timeline: Timeline): WhyTimeline {
  return {
    id: timeline.id,
    slug: timeline.slug,
    name: timeline.name,
    status: timeline.status,
    policy: timeline.policy,
    experimental: timeline.experimental,
  };
}

export interface ChainRequest {
  /** The commit blame named. */
  oid: string;
  /** Its change id, when gm read it from the commit. */
  changeId?: string | null;
  /** The request's lines this commit explains. */
  lines: number[];
}

/** The chain for one commit. */
export async function resolveChain(sources: WhySources, request: ChainRequest): Promise<WhyChain> {
  const mainRef = `refs/heads/${sources.defaultBranch}`;
  const commit = await sources.commit(request.oid);

  let changeId: string | null = request.changeId ?? null;
  let changeSource: WhyChangeSource | null = changeId ? "client" : null;
  if (!changeId) {
    changeId = await sources.changeFromPushLog(request.oid);
    if (changeId) changeSource = "push-log";
  }
  if (!changeId && commit) {
    changeId = await sources.changeFromHeader(request.oid);
    if (changeId) changeSource = "header";
  }

  const changeRefs = changeId ? await sources.changeRefs(changeId) : [];
  const tracker = sources.tracker;
  const records = tracker ? await tracker.timelines() : [];
  const bySlug = new Map(records.map((t) => [t.slug, t]));
  const byId = new Map(records.map((t) => [t.id, t]));

  const landed =
    sources.source?.kind === "timeline-work"
      ? undefined
      : changeRefs.find((row) => row.ref === mainRef);
  const refs: WhyRef[] = changeRefs.map((row) => {
    const slug = timelineSlugOf(row.ref);
    const timeline = sources.source?.timelineId
      ? byId.get(sources.source.timelineId)
      : slug
        ? bySlug.get(slug)
        : undefined;
    return {
      ref: row.ref,
      kind: sources.source?.kind === "timeline-work" ? "timeline" : lineKind(row.ref, mainRef),
      timeline: timeline ? whyTimeline(timeline) : null,
      firstCommit: row.firstCommit,
      firstSeenAt: row.firstSeenAt,
      firstUpdate: row.firstUpdate,
      lastCommit: row.lastCommit,
      lastSeenAt: row.lastSeenAt,
      rewritten: row.firstCommit !== row.lastCommit,
      afterLanding: !!landed && row.firstUpdate.id > landed.firstUpdate.id,
    };
  });
  const timelines: WhyTimeline[] = [];
  for (const ref of refs)
    if (ref.timeline && !ref.afterLanding && !timelines.some((t) => t.id === ref.timeline!.id))
      timelines.push(ref.timeline);
  const sourceTimeline = sources.source?.timelineId
    ? byId.get(sources.source.timelineId)
    : undefined;
  if (sourceTimeline && !timelines.some((timeline) => timeline.id === sourceTimeline.id))
    timelines.push(whyTimeline(sourceTimeline));

  // Main's first update identifies the operation that introduced this change,
  // not a later rewrite or a nearby timeline push. Match that exact advance
  // and the queue's pinned checkpoint, not its bounded, asynchronously collected
  // change index: omission there does not contradict the recorded main advance.
  const queued =
    tracker && landed?.firstUpdate.new ? await tracker.landing(landed.firstUpdate.new) : null;
  const queueRepo = queued?.landing.repos.find(
    (repo) =>
      repo.id === sources.repoId &&
      repo.state === "advanced" &&
      repo.merge === landed?.firstUpdate.new,
  );
  const pinnedRepo = queued?.checkpoint.checkpoint.repos.find((repo) => repo.id === sources.repoId);
  const queueTimeline = queued && byId.get(queued.landing.timelineId);
  const authoritative =
    queued &&
    queueRepo &&
    queueTimeline &&
    queued.checkpoint.checkpoint.id === queued.landing.checkpointId &&
    queued.checkpoint.checkpoint.timelineId === queueTimeline.id &&
    pinnedRepo?.commit === queueRepo.commit
      ? { ...queued, repo: queueRepo, timeline: queueTimeline }
      : null;
  if (authoritative && !timelines.some((timeline) => timeline.id === authoritative.timeline.id))
    timelines.push(whyTimeline(authoritative.timeline));

  // Merges: a merge event whose push first brought the change to its target.
  const refOf = (id: string | null) =>
    id === null ? mainRef : byId.get(id) ? `refs/heads/timeline/${byId.get(id)!.slug}` : null;
  const slugOf = (id: string | null) => (id === null ? null : (byId.get(id)?.slug ?? null));
  const merges: WhyMerge[] = [];
  const checkpoints: WhyCheckpoint[] = [];
  const issues: WhyIssue[] = [];
  if (tracker && (changeId || sources.source?.kind === "timeline-work")) {
    const seen = new Set<string>();
    for (const timeline of timelines) {
      const detail = await tracker.timeline(timeline.slug);
      for (const event of detail?.events ?? []) {
        if (event.kind !== "merge" || event.repoId !== sources.repoId || seen.has(event.id))
          continue;
        seen.add(event.id);
        const target = refOf(event.intoId);
        const reached = refs.find((ref) => ref.ref === target);
        if (!reached || reached.firstUpdate.id !== event.refUpdateId) continue;
        merges.push({
          from: slugOf(event.fromId),
          into: slugOf(event.intoId),
          commit: event.commit,
          parent: event.parent,
          at: event.createdAt,
          actorId: event.actorId,
        });
      }
      for (const issue of detail?.issues ?? [])
        if (!issues.some((i) => i.key === issue.key))
          issues.push({
            id: issue.id,
            key: issue.key,
            title: issue.title,
            status: issue.status,
            trackerOwner: tracker.owner,
            source: "timeline",
          });
      for (const state of await tracker.checkpoints(timeline.slug)) {
        const repo = state.checkpoint.repos.find((r) => r.id === sources.repoId);
        const sameSource =
          !sources.source || (repo?.source?.sourceId ?? "canonical") === sources.source.sourceId;
        const pinned =
          sameSource &&
          repo?.changes.find((c) =>
            sources.source?.kind === "timeline-work"
              ? c.commit === request.oid
              : c.changeId === changeId,
          );
        const exactHead = sameSource && repo?.commit === request.oid;
        if (!pinned && !exactHead) continue;
        checkpoints.push({
          id: state.checkpoint.id,
          timeline: timeline.slug,
          number: state.checkpoint.number,
          commit: pinned ? pinned.commit : request.oid,
          summary: state.checkpoint.summary,
          createdAt: state.checkpoint.createdAt,
          actorId: state.checkpoint.actorId,
          current: state.current,
          approval: state.approval && {
            requestId: state.approval.requestId,
            state: state.approval.state,
            by: state.approval.by,
            at: state.approval.at,
            note: state.approval.note,
          },
        });
      }
    }
  }
  merges.sort((a, b) => a.at.localeCompare(b.at));
  checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decided = [...checkpoints].reverse().find((c) => c.approval);
  const approval = decided?.approval
    ? {
        ...decided.approval,
        checkpointId: decided.id,
        timeline: decided.timeline,
        number: decided.number,
      }
    : null;

  // Landing: when the change reached the default branch, and how.
  let landing: WhyLanding | null = null;
  const main =
    sources.source?.kind === "timeline-work" ? undefined : refs.find((ref) => ref.ref === mainRef);
  if (main) {
    const queue = authoritative?.landing;
    landing = {
      ref: main.ref,
      commit: main.firstCommit,
      at: main.firstSeenAt,
      update: main.firstUpdate,
      via: queue ? "queue" : tracker ? "push" : "unknown",
      timeline: authoritative?.timeline.slug ?? null,
      queue:
        queue && authoritative
          ? {
              id: queue.id,
              checkpointId: queue.checkpointId,
              checkpointNumber: queue.checkpointNumber,
              trigger: queue.trigger,
              requestedBy: queue.requestedBy,
              mergeRun: authoritative.repo.mergeRun,
              gateRun: authoritative.repo.gateRun,
            }
          : null,
    };
  }

  // Issues the change's commits cite: the blamed one, and its other commits on refs.
  const messages = commit ? [commit.message] : [];
  const others = [...new Set(refs.flatMap((r) => [r.lastCommit, r.firstCommit]))]
    .filter((oid) => oid !== request.oid)
    .slice(0, MESSAGE_COMMITS);
  for (const oid of others) {
    const other = await sources.commit(oid);
    if (other) messages.push(other.message);
  }
  const keys = [...new Set(messages.flatMap(issueKeys))];
  const cited = keys.length ? await sources.issues(keys) : [];
  const fromCommits: WhyIssue[] = cited.map((issue) => ({
    id: issue.id,
    key: issue.key,
    title: issue.title,
    status: issue.status,
    trackerOwner: issue.trackerOwner,
    source: "commit",
  }));

  return {
    ...(sources.source ? { source: sources.source } : {}),
    commit,
    oid: request.oid,
    lines: request.lines,
    changeId,
    changeSource,
    refs,
    timelines,
    merges,
    issues: [...fromCommits, ...issues.filter((i) => !fromCommits.some((c) => c.key === i.key))],
    checkpoints,
    approval,
    landing,
    discussions: NO_DISCUSSIONS,
    // Filled in by the route, which reads steps like the repository (CORE-243).
    step: null,
  };
}
