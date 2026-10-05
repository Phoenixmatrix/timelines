import type { AgentCapabilities } from "./api.ts";
import type { CheckpointView, Timeline, TimelineEvent, TimelinePolicy } from "./timelines.ts";
import type { QueueFailure } from "./merge-queue.ts";
import type { IssueRequirements } from "./requirements.ts";

export interface TrackerIdentity {
  id: string;
  slug: string;
  displayName: string;
  /**
   * A person's profile picture, on live member lists only; never stored in
   * tracker history, where it would go stale.
   */
  avatarUrl?: string | null;
}
/** An open request on the Needs you page: which tracker and issue it's about. */
export interface OpenRequest {
  tracker: { slug: string; displayName: string };
  request: HumanRequest;
  issue: { id: string; key: string; title: string };
  /** For a checkpoint's approval: its commits, CI runs, previews and summary. */
  checkpoint?: CheckpointView;
}
export interface OpenRequests {
  requests: OpenRequest[];
  /** Names for the ids the requests mention: a person, or "builder for Ann Lee". */
  names: Record<string, string>;
}
/** An agent in the tracker, with its accountable human inline. */
export interface TrackerAgent {
  id: string;
  name: string;
  accountable: TrackerIdentity;
  capabilities: AgentCapabilities | null;
  capabilitiesUpdatedAt: string | null;
  revokedAt: string | null;
}
export interface TrackerOwner extends TrackerIdentity {
  canAdmin: boolean;
}
export interface TrackerEntity {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Team extends TrackerEntity {
  key: string;
  name: string;
  description: string;
  memberIds: string[];
  archived: boolean;
  /**
   * Releases without completion before an issue asks its accountable person what
   * to do differently (default 3; 0 never asks).
   */
  attemptLimit?: number;
}

/** Releases without completion before a team's issues escalate, unless it sets its own. */
export const DEFAULT_ATTEMPT_LIMIT = 3;
export interface Workspace extends TrackerEntity {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
}
export type IssueType = "task" | "bug" | "prd" | "chore" | "research" | "remediation";
export type IssuePickup = "anyone" | "not_ready" | "human_only";
export const ISSUE_PICKUPS: Record<IssuePickup, string> = {
  anyone: "Anyone",
  not_ready: "Not ready",
  human_only: "Human only",
};
/** Pickup policy is global across timeline views; legacy issues allow anyone. */
export function issuePickup(issue: Pick<Issue, "pickup">): IssuePickup {
  return issue.pickup ?? "anyone";
}
/**
 * `done_in_timeline` (TIMELINES-RESEARCH.md, "Tracker"; CORE-74): finished
 * inside a timeline that hasn't landed. It is main's view of that work, and
 * that of timelines that don't have it: it keeps blocking and isn't ready, so
 * nobody does the work twice. The tracker sets and clears it; nobody picks it.
 */
export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "done"
  | "done_in_timeline"
  | "canceled";
/** The statuses a person or agent may set. */
export const SETTABLE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const satisfies readonly IssueStatus[];
/** The timeline an issue is done in, while it's `done_in_timeline`. Slugs never change. */
export interface DoneIn {
  id: string;
  slug: string;
}
export const CLOSE_REASONS = {
  duplicate: "Duplicate",
  not_planned: "Not planned",
  obsolete: "No longer needed",
  cannot_reproduce: "Cannot reproduce",
  other: "Other",
} as const;
export type IssueCloseReason = keyof typeof CLOSE_REASONS;
/**
 * Whether an agent works this issue in a timeline (TIMELINES-RESEARCH.md,
 * "When an agent uses a timeline"): `required`, `never`, or left to the agent,
 * which also reads the description or PRD. Issues from before the field read
 * as `agent_decides`.
 */
export const TIMELINE_USES = {
  agent_decides: "Agent decides",
  required: "Required",
  never: "Never",
} as const;
export type IssueTimelineUse = keyof typeof TIMELINE_USES;
/** An issue's timeline rule, with the default filled in for issues that predate it. */
export function issueTimeline(issue: Pick<Issue, "timelineUse" | "timelinePolicy">): {
  use: IssueTimelineUse;
  policy: TimelinePolicy | null;
} {
  const use = issue.timelineUse ?? "agent_decides";
  return { use, policy: use === "required" ? (issue.timelinePolicy ?? null) : null };
}
/** "Required (approval)", "Agent decides": the rule in words. */
export function issueTimelineText(issue: Pick<Issue, "timelineUse" | "timelinePolicy">): string {
  const { use, policy } = issueTimeline(issue);
  return policy ? `${TIMELINE_USES[use]} (${policy})` : TIMELINE_USES[use];
}
export interface IssueClaim {
  /** The holder: an agent's id, or a person's. */
  actorId: string;
  /** The human answerable for the holder (the holder itself for a person). */
  accountableId?: string;
  /** A label for the working session (from `gm issue claim --agent`). */
  agent: string;
  expiresAt: string;
  /** For a delegated claim: the ancestor whose lease handed this one out. */
  delegatedFrom?: string;
  /**
   * Set while the issue waits on a person: the lease doesn't expire, and its holder
   * may exit. Answering the last request unparks it for the holder to resume.
   */
  parkedAt?: string;
  /**
   * Set once the holder finished the issue inside a timeline (CORE-75, the
   * "retained" state of Unity's Smart Locks): the lease stays the holder's,
   * with no renewal needed, until that timeline lands (released as done) or is
   * abandoned (released back to ready). Nobody else can claim the issue
   * meanwhile. Merging the timeline into another moves the lease with the work.
   */
  retainedIn?: DoneIn;
}

/** Identity captured at mutation time, independent of later renames or membership changes. */
export interface AuditActor {
  id: string;
  kind: "person" | "agent" | "unknown";
  name: string | null;
  accountable: TrackerIdentity | null;
}
/** Client-reported transport, not an authorization signal. Old events have no recorded source. */
export type AuditSource = "web" | "cli" | "api" | "assistant" | "unknown";
export interface Issue extends TrackerEntity {
  key: string;
  /** Immutable creator; legacy records without a creation event remain unknown. */
  createdBy?: AuditActor | null;
  teamId: string;
  title: string;
  description: string;
  acceptance: string;
  type: IssueType;
  status: IssueStatus;
  /** Who may start work; absent on legacy issues means anyone. */
  pickup?: IssuePickup;
  /** Why it was canceled. Historical cancellations may have no recorded reason. */
  closeReason?: IssueCloseReason | null;
  /** Whether to work it in a timeline; absent on older issues (read as `agent_decides`). */
  timelineUse?: IssueTimelineUse;
  /** With `required`: the policy the agent's timeline must use, or null for either. */
  timelinePolicy?: TimelinePolicy | null;
  /**
   * What an agent must report to claim it (CORE-32, shared/requirements.ts);
   * absent or null on issues any agent may take. People can always claim.
   */
  requires?: IssueRequirements | null;
  priority: 0 | 1 | 2 | 3 | 4;
  assigneeId: string | null;
  parentId: string | null;
  workspaceIds: string[];
  labels: string[];
  claim: IssueClaim | null;
  /** Open requests to a person: while any is open the issue waits, whatever its status. */
  waiting?: number;
  /** Claims released without completion since it was last escalated to a person. */
  attempts?: number;
  /** A pending handoff of the lease: to whom (anyone with the code when null), and until when. */
  handoff?: { to: string | null; expiresAt: string } | null;
  /** The timeline it was created in; absent or null for main. */
  timelineId?: string | null;
  /**
   * The unlanded timeline it was finished in (CORE-74). Shared by every view,
   * like the lease: main's status is then `done_in_timeline`, and so is the
   * status of any timeline whose view doesn't include that one.
   */
  doneIn?: DoneIn | null;
  /** Latest trusted queue failure; global across timeline views and never client-writable. */
  queueFailure?: QueueFailure | null;
}

/**
 * Issue fields that differ between timelines' views (TIMELINES-RESEARCH.md,
 * "Tracker"): what a timeline changes stays in its view until it lands. The
 * rest (identity, version, claim, assignee, waiting) is shared by every view:
 * leases stay unique per issue across timelines.
 */
export const TIMELINE_SCOPED_ISSUE_FIELDS = [
  "title",
  "description",
  "acceptance",
  "type",
  "status",
  "closeReason",
  "priority",
  "parentId",
  "workspaceIds",
  "labels",
] as const satisfies readonly (keyof Issue)[];
/** Entity types whose existence and contents are per view; the rest are shared by every view. */
export const TIMELINE_SCOPED_TYPES = ["issue", "link", "comment"] as const;
/** The timeline a snapshot is a view of. */
export interface TimelineScope {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export type RequestKind = "question" | "approval" | "decision" | "credential";
/**
 * Something an agent (or anyone) needs from a person to carry on with an issue.
 * A credential's value never lives here: answering stores it as a secret and
 * records only where.
 */
export interface HumanRequest {
  id: string;
  issueId: string;
  kind: RequestKind;
  /** Markdown: what's needed and why. */
  prompt: string;
  /** For a decision: the options to choose from. */
  choices: string[];
  /** For a credential: the repository secret the answer is stored as. */
  secret: { repo: string; name: string } | null;
  status: "open" | "answered" | "canceled";
  askedBy: string;
  /** The person it's for: the asker's accountable human, unless routed elsewhere. */
  routeTo: string;
  /**
   * The answer: text, the chosen option, approved/rejected, or where a secret
   * went; for a withdrawn request, why, when a reason was given.
   */
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
  /** Opened by the tracker after repeated failed attempts; answering resets the count. */
  escalation?: boolean;
  /**
   * For an approval: the timeline checkpoint it asks to approve (CORE-76).
   * Approving needs write access to its repositories, and only counts while
   * it is still the timeline's head.
   */
  checkpoint?: RequestCheckpoint;
}
/** The checkpoint an approval request pins. */
export interface RequestCheckpoint {
  id: string;
  number: number;
  timelineId: string;
  /** The timeline's slug, which never changes. */
  timeline: string;
}
export interface Comment {
  id: string;
  issueId: string;
  body: string;
  kind: "comment" | "checkpoint" | "evidence";
  actorId: string;
  createdAt: string;
}
export interface Link {
  id: string;
  fromId: string;
  toId: string;
  kind: "blocks" | "related" | "duplicates";
}
export interface Subscription {
  id: string;
  workspaceId: string;
  repoId: string;
  owner: string;
  name: string;
}
export interface Snapshot {
  owner: TrackerIdentity;
  canAdmin: boolean;
  members: TrackerIdentity[];
  /** Agents accountable to members: who an actorId names when it isn't a member. */
  agents: TrackerAgent[];
  teams: Team[];
  workspaces: Workspace[];
  /** Defined tags, shared across timelines and retained after their last use. */
  labels: string[];
  issues: Issue[];
  links: Link[];
  comments: Comment[];
  requests: HumanRequest[];
  subscriptions: Subscription[];
  cursor: number;
  serverTime: string;
  /**
   * Set when this is a timeline's view: main's issues with the timeline's
   * (and its ancestors') changes on top. Absent for main's view.
   */
  timeline?: TimelineScope;
  /** With `timelines=1`: every timeline, and every timeline event (by `seq`). */
  timelines?: Timeline[];
  timelineEvents?: TimelineEvent[];
}
/** Initial browser data; repository choices are loaded only in management. */
export interface TrackerView {
  snapshot: Snapshot;
  trackers: TrackerOwner[];
  /** The viewer's saved defaults for this tracker, if any. */
  preferences: TrackerPreferences | null;
}
export interface TrackerList {
  viewerId: string;
  trackers: TrackerOwner[];
  /** The tracker whose defaults the viewer saved most recently: where /tracker opens. */
  defaultOwnerId: string | null;
}
export const TRACKER_LAYOUTS = ["list", "board", "graph", "chronicle"] as const;
/**
 * A person's defaults for one tracker (CORE-119), saved on the server so they
 * follow them everywhere. The team is also gm's default when nothing more
 * specific (a flag, the checkout, the project) names one, for the person and
 * their agents.
 */
export interface TrackerPreferences {
  teamId: string | null;
  view: (typeof TRACKER_LAYOUTS)[number];
  query: string;
  updatedAt: string;
}

/**
 * The team to file into when no default is saved: the person's own team; with
 * several, the one they (or their agents) filed into most recently; then any
 * team they filed into; then the first open team.
 */
export function fallbackTeam(
  snapshot: Pick<Snapshot, "teams" | "issues" | "agents">,
  personId: string,
): string | null {
  const open = snapshot.teams.filter((team) => !team.archived);
  const mine = open.filter((team) => team.memberIds.includes(personId));
  if (mine.length === 1) return mine[0]!.id;
  const agents = new Set(
    snapshot.agents.filter((a) => a.accountable.id === personId).map((a) => a.id),
  );
  const filed = snapshot.issues
    .filter(
      (issue) =>
        issue.createdBy && (issue.createdBy.id === personId || agents.has(issue.createdBy.id)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((issue) => issue.teamId);
  const pool = mine.length ? mine : open;
  return filed.find((id) => pool.some((team) => team.id === id)) ?? pool[0]?.id ?? null;
}
export type EntityType =
  | "team"
  | "workspace"
  | "issue"
  | "link"
  | "comment"
  | "request"
  | "subscription";
export interface TrackerEvent {
  cursor: number;
  operationId: string;
  actorId: string;
  kind: string;
  entityType: EntityType;
  entityId: string;
  entity: Team | Workspace | Issue | Link | Comment | HumanRequest | Subscription | null;
  createdAt: string;
  actor?: AuditActor;
  source?: AuditSource;
  /** The requested mutation, which may also emit secondary events. */
  mutationKind?: string;
  /**
   * `before` and `entity` are always main's view (what a replica of main
   * applies). An event made in a timeline names it here.
   */
  before?: TrackerEvent["entity"];
  timelineId?: string;
  /**
   * For an issue, link or comment changed in a timeline: the entity as that
   * timeline saw it, before and after. Main's `entity` then changes only
   * shared fields (and is null for something that exists only in timelines).
   */
  view?: { before: TrackerEvent["entity"]; entity: TrackerEvent["entity"] };
}
export interface IssueAuditEvent extends TrackerEvent {
  actor: AuditActor;
  source: AuditSource;
  mutationKind: string;
  before: TrackerEvent["entity"];
}
/** Newest first; before is an exclusive event cursor. */
export interface IssueHistory {
  issueId: string;
  creator: AuditActor | null;
  events: IssueAuditEvent[];
  nextBefore: number | null;
  hasMore: boolean;
}
export type IssueFields = Pick<
  Issue,
  | "title"
  | "description"
  | "acceptance"
  | "type"
  | "status"
  | "closeReason"
  | "pickup"
  | "timelineUse"
  | "timelinePolicy"
  | "priority"
  | "assigneeId"
  | "parentId"
  | "workspaceIds"
  | "labels"
>;
/** Fields a create or update may set beyond the inspector's draft fields. */
export type IssueData = Partial<IssueFields> & { requires?: IssueRequirements | null };
export type Mutation =
  | {
      kind: "team.create";
      id: string;
      data: { key: string; name: string; description?: string; memberIds?: string[] };
    }
  | {
      kind: "team.update";
      id: string;
      expectedVersion: number;
      data: Partial<Pick<Team, "name" | "description" | "memberIds" | "archived" | "attemptLimit">>;
    }
  | {
      kind: "workspace.create";
      id: string;
      data: { slug: string; name: string; description?: string };
    }
  | {
      kind: "workspace.update";
      id: string;
      expectedVersion: number;
      data: Partial<Pick<Workspace, "name" | "description" | "archived">>;
    }
  | {
      kind: "issue.create";
      id: string;
      data: { teamId: string; title: string } & Omit<IssueData, "title">;
    }
  | {
      kind: "issue.update";
      id: string;
      expectedVersion: number;
      data: IssueData & { leaseToken?: string };
    }
  | { kind: "link.add"; id: string; data: Omit<Link, "id"> }
  | { kind: "link.remove"; id: string }
  | {
      kind: "comment.add";
      id: string;
      data: { issueId: string; body: string; kind?: Comment["kind"] };
    }
  | { kind: "subscription.add"; id: string; data: { workspaceId: string; repoId: string } }
  | { kind: "subscription.remove"; id: string }
  | {
      kind: "issue.claim";
      id: string;
      data: {
        agent: string;
        ttlSeconds?: number;
        /** Inside a leased subtree: the covering lease's token, delegating this claim. */
        underToken?: string;
        /** Delegate to one of your agents instead of holding it yourself. */
        forActorId?: string;
        /**
         * Take over an active claim: tracker owners only, acting as themselves
         * (not through an agent). The holder's token stops working, the
         * takeover is noted on the issue, and it isn't counted as their failure.
         */
        force?: boolean;
      };
    }
  /** Ask a person for something; with the issue's lease token, the lease is parked. */
  | {
      kind: "request.open";
      id: string;
      data: {
        issueId: string;
        kind: RequestKind;
        prompt: string;
        choices?: string[];
        secret?: { repo: string; name: string };
        /** A member to ask instead of the asker's accountable human. */
        routeTo?: string;
        leaseToken?: string;
        /** For an approval: the id of the timeline checkpoint to approve, its timeline's head. */
        checkpoint?: string;
      };
    }
  /**
   * Answer a request: `answer` for a question, `choice` for a decision,
   * `approved` for an approval; a credential sets `stored` once the secret is saved.
   */
  | {
      kind: "request.answer";
      id: string;
      data: { answer?: string; choice?: string; approved?: boolean; stored?: boolean };
    }
  | { kind: "request.cancel"; id: string }
  /**
   * Hand the lease on: returns a single-use code. The giver keeps the lease (and
   * can withdraw) until the code is accepted; then its token stops working.
   */
  | {
      kind: "issue.offer";
      id: string;
      data: { leaseToken: string; toActorId?: string; ttlSeconds?: number };
    }
  | { kind: "issue.withdraw"; id: string; data: { leaseToken: string } }
  /** Take a handed-off lease: a fresh token, and the lease moves to you. */
  | {
      kind: "issue.accept";
      id: string;
      data: { code: string; agent?: string; ttlSeconds?: number };
    }
  /** After its requests are answered, the parked lease's holder takes it back up. */
  | { kind: "issue.resume"; id: string; data: { ttlSeconds?: number } }
  /** The holder of a lease above an issue takes back the issue's claim. */
  | { kind: "issue.revoke"; id: string; data: { underToken: string } }
  | {
      kind: "issue.next";
      /** A fresh id for this request; the claimed issue comes back as `issueId`. */
      id: string;
      data: {
        agent: string;
        ttlSeconds?: number;
        teamId?: string;
        workspaceId?: string;
        /** Only descendants of this issue. */
        underId?: string;
        /** With underId: that issue's lease token, to pick inside your own leased subtree. */
        underToken?: string;
        forActorId?: string;
      };
    }
  | { kind: "issue.renew"; id: string; data: { leaseToken: string; ttlSeconds?: number } }
  /** Owners acting as themselves may end someone else's claim with force and no token. */
  | { kind: "issue.release"; id: string; data: { leaseToken?: string; force?: boolean } }
  | { kind: "issue.complete"; id: string; data: { leaseToken: string; evidence: string } };
export interface MutationRequest {
  operationId: string;
  mutations: Mutation[];
  /**
   * Make the changes in a timeline (its slug or id): they apply to its view,
   * and issues created become the timeline's. Absent or `main` for main.
   */
  timeline?: string;
}
export interface MutationResult {
  cursor: number;
  events: TrackerEvent[];
  results: {
    id: string;
    leaseToken?: string;
    expiresAt?: string;
    /** For issue.next: the issue it claimed (absent when nothing was ready). */
    issueId?: string;
    key?: string;
    /** For issue.offer: the single-use code to hand over, shown once. */
    offerCode?: string;
    /**
     * For issue.next: ready issues it passed over because the agent doesn't
     * meet their requirements (CORE-32), so it isn't silently starved.
     */
    skipped?: { requirements: number; keys: string[]; message: string };
  }[];
  serverTime: string;
}
/**
 * A timeline record or timeline event, in the change feed for replicas that
 * ask for them (`timelines=1`): older replicas fail on entity types they
 * don't know, so they never see these.
 */
export interface TimelineFeedEvent {
  cursor: number;
  operationId: string;
  /** Who made the change, when known. */
  actorId: string | null;
  kind: string;
  entityType: "timeline" | "timelineEvent";
  entityId: string;
  /** Null when it was removed (by retention: kind `retention.remove`). */
  entity: Timeline | TimelineEvent | null;
  createdAt: string;
}
export const TIMELINE_FEED_TYPES = ["timeline", "timelineEvent"] as const;
export interface Changes {
  events: (TrackerEvent | TimelineFeedEvent)[];
  cursor: number;
  hasMore: boolean;
  serverTime: string;
  /** With `directory=1`: who can act here now, for replicas to refresh. */
  members?: Snapshot["members"];
  agents?: Snapshot["agents"];
  canAdmin?: boolean;
}
/** Who an actor id names: a member, or an agent with the human accountable for it. */
export function actorOf(
  snapshot: Pick<Snapshot, "members" | "agents">,
  id: string,
): { name: string; agent: TrackerAgent | null } {
  const agent = snapshot.agents.find((a) => a.id === id) ?? null;
  if (agent) return { name: agent.name, agent };
  return { name: snapshot.members.find((m) => m.id === id)?.displayName ?? id, agent: null };
}

/** An actor in one line: "Ann Lee", or "builder for Ann Lee" for an agent. */
export function actorName(snapshot: Pick<Snapshot, "members" | "agents">, id: string): string {
  const { name, agent } = actorOf(snapshot, id);
  return agent ? `${name} for ${agent.accountable.displayName}` : name;
}

/** Who holds a claim: an agent identity by name and human, else the session label. */
/** Who's behind an actor or a claim, so the accountable person is visible at a glance. */
export interface Attribution {
  /** What to call it: an agent's name, a person's display name, or a session's label. */
  name: string;
  /** An agent identity, a person, or a person's own labeled working session (`--agent`). */
  kind: "agent" | "person" | "session";
  /** The human accountable: the agent's person, or the person themself. */
  person: TrackerIdentity | null;
}
export function attribution(
  snapshot: Pick<Snapshot, "members" | "agents">,
  id: string,
): Attribution {
  const agent = snapshot.agents.find((a) => a.id === id);
  if (agent) return { name: agent.name, kind: "agent", person: agent.accountable };
  const person = snapshot.members.find((m) => m.id === id) ?? null;
  return { name: person?.displayName ?? id, kind: "person", person };
}
/** A claim's holder: its agent, or the person with their session label when they gave one. */
export function claimAttribution(
  snapshot: Pick<Snapshot, "members" | "agents">,
  claim: IssueClaim,
): Attribution {
  const who = attribution(snapshot, claim.actorId);
  if (who.kind === "agent") return who;
  const person =
    snapshot.members.find((m) => m.id === (claim.accountableId ?? claim.actorId)) ?? who.person;
  const label = claim.agent.trim();
  return label && label !== person?.displayName && label !== person?.slug
    ? { name: label, kind: "session", person }
    : { name: person?.displayName ?? label, kind: "person", person };
}
/** "builder for Ann Lee", "Ann Lee (laptop)", "Ann Lee": the same, in words. */
export function attributionText(who: Attribution): string {
  if (!who.person || who.kind === "person") return who.name;
  return who.kind === "agent"
    ? `${who.name} for ${who.person.displayName}`
    : `${who.person.displayName} (${who.name})`;
}
export function claimHolder(
  snapshot: Pick<Snapshot, "members" | "agents">,
  claim: IssueClaim,
): string {
  return attributionText(claimAttribution(snapshot, claim));
}

/**
 * Done and canceled issues are closed; everything else still has work in it,
 * including work done in a timeline that hasn't landed.
 */
export function isOpen(issue: Pick<Issue, "status">): boolean {
  return issue.status !== "done" && issue.status !== "canceled";
}

/**
 * A claim holds while it's unexpired, parked waiting on a person, or retained
 * by a timeline the issue was finished in (CORE-75).
 */
export function hasActiveClaim(issue: Issue, now: string): boolean {
  return (
    issue.claim !== null &&
    (issue.claim.parkedAt !== undefined ||
      issue.claim.retainedIn !== undefined ||
      issue.claim.expiresAt > now)
  );
}

/** A lease kept after finishing in a timeline: held, but no longer working (CORE-75). */
export function isRetained(issue: Pick<Issue, "claim">): boolean {
  return !!issue.claim?.retainedIn;
}

/** Lookups readiness needs, built once per snapshot. */
export interface ReadinessIndex {
  byId: Map<string, Issue>;
  children: Map<string, Issue[]>;
  /** Blocking issue ids by blocked issue id. */
  blockers: Map<string, string[]>;
}

export function readinessIndex(issues: Issue[], links: Link[]): ReadinessIndex {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const children = new Map<string, Issue[]>();
  for (const issue of issues)
    if (issue.parentId)
      children.set(issue.parentId, [...(children.get(issue.parentId) ?? []), issue]);
  const blockers = new Map<string, string[]>();
  for (const link of links)
    if (link.kind === "blocks")
      blockers.set(link.toId, [...(blockers.get(link.toId) ?? []), link.fromId]);
  return { byId, children, blockers };
}

/** The nearest ancestor with an active lease: its holder owns this whole subtree. */
export function leasedAncestor(issue: Issue, index: ReadinessIndex, now: string): Issue | null {
  const seen = new Set([issue.id]);
  for (let id = issue.parentId; id && !seen.has(id);) {
    seen.add(id);
    const ancestor = index.byId.get(id);
    if (!ancestor) return null;
    if (hasActiveClaim(ancestor, now)) return ancestor;
    id = ancestor.parentId;
  }
  return null;
}

/**
 * Why an issue can or can't be picked up:
 * - `ready`: todo (or in progress with an expired claim), unblocked, a leaf,
 *   and outside any other active lease's subtree;
 * - `claimed`: it has an active lease;
 * - `unavailable`: backlog, done, done in a timeline (not in this view),
 *   canceled, or in progress without a claim;
 * - `not_ready`: pickup is disabled for everyone;
 * - `human_only`: pickup is disabled for the default agent actor, not a person;
 * - `blocked`: a `blocks` predecessor isn't done in this view (a missing one,
 *   or one only done in another timeline, still blocks);
 * - `container`: it has open sub-issues, so the work is in those;
 * - `leased_above`: an ancestor's active lease covers it;
 * - `waiting`: it has open requests to a person.
 */
export type Readiness =
  | "ready"
  | "waiting"
  | "not_ready"
  | "human_only"
  | "claimed"
  | "unavailable"
  | "blocked"
  | "container"
  | "leased_above";

export function readiness(
  issue: Issue,
  index: ReadinessIndex,
  now: string,
  actor: "agent" | "person" = "agent",
): Readiness {
  if (issue.waiting) return "waiting";
  if (hasActiveClaim(issue, now)) return "claimed";
  if (!(issue.status === "todo" || (issue.status === "in_progress" && issue.claim !== null)))
    return "unavailable";
  const pickup = issuePickup(issue);
  if (pickup === "not_ready") return "not_ready";
  if (pickup === "human_only" && actor === "agent") return "human_only";
  if ((index.blockers.get(issue.id) ?? []).some((id) => index.byId.get(id)?.status !== "done"))
    return "blocked";
  if ((index.children.get(issue.id) ?? []).some(isOpen)) return "container";
  if (leasedAncestor(issue, index, now)) return "leased_above";
  return "ready";
}

export function isIssueReady(
  issue: Issue,
  issues: Issue[],
  links: Link[],
  serverTime = new Date().toISOString(),
): boolean {
  return readiness(issue, readinessIndex(issues, links), serverTime) === "ready";
}
