// The rest of the "why" chain once blame has named a commit (CORE-85): its
// change id, the refs and timelines the change reached (CORE-68's push log),
// the merges that carried it, its issues, the checkpoints that pinned it and
// their approvals (CORE-76), and its landing on the default branch.
//
// Everything after the commit is found through the change id, never the
// commit id: a rebase or amend makes a new commit of the same change, and the
// push log, checkpoints and merges all still name it.

import type { ChangeRef } from "../../shared/api.ts";
import type {
  CheckpointState,
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

  const landed = changeRefs.find((row) => row.ref === mainRef);
  const refs: WhyRef[] = changeRefs.map((row) => {
    const slug = timelineSlugOf(row.ref);
    const timeline = slug ? bySlug.get(slug) : undefined;
    return {
      ref: row.ref,
      kind: lineKind(row.ref, mainRef),
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

  // Merges: a merge event whose push first brought the change to its target.
  const refOf = (id: string | null) =>
    id === null ? mainRef : byId.get(id) ? `refs/heads/timeline/${byId.get(id)!.slug}` : null;
  const slugOf = (id: string | null) => (id === null ? null : (byId.get(id)?.slug ?? null));
  const merges: WhyMerge[] = [];
  const checkpoints: WhyCheckpoint[] = [];
  const issues: WhyIssue[] = [];
  if (tracker && changeId) {
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
        const pinned = repo?.changes.find((c) => c.changeId === changeId);
        if (!pinned) continue;
        checkpoints.push({
          id: state.checkpoint.id,
          timeline: timeline.slug,
          number: state.checkpoint.number,
          commit: pinned.commit,
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
  const main = refs.find((ref) => ref.ref === mainRef);
  if (main) {
    const merge = merges.find((m) => m.into === null) ?? null;
    const before = refs.filter((r) => r.timeline && !r.afterLanding && r !== main).at(-1);
    landing = {
      ref: main.ref,
      commit: main.lastCommit,
      at: main.firstSeenAt,
      update: main.firstUpdate,
      via: merge ? "merge" : tracker ? "push" : "unknown",
      timeline: merge?.from ?? before?.timeline?.slug ?? null,
      merge,
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
  };
}
