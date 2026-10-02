export interface TrackerIdentity {
  id: string;
  slug: string;
  displayName: string;
}
/** An agent in the tracker, with its accountable human inline. */
export interface TrackerAgent {
  id: string;
  name: string;
  accountable: TrackerIdentity;
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
}
export interface Workspace extends TrackerEntity {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
}
export type IssueType = "task" | "bug" | "prd" | "chore" | "research";
export type IssueStatus = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export interface IssueClaim {
  /** The holder: an agent's id, or a person's. */
  actorId: string;
  /** The human answerable for the holder (the holder itself for a person). */
  accountableId?: string;
  /** A label for the working session (from `gm issue claim --agent`). */
  agent: string;
  expiresAt: string;
}
export interface Issue extends TrackerEntity {
  key: string;
  teamId: string;
  title: string;
  description: string;
  acceptance: string;
  type: IssueType;
  status: IssueStatus;
  priority: 0 | 1 | 2 | 3 | 4;
  assigneeId: string | null;
  parentId: string | null;
  workspaceIds: string[];
  labels: string[];
  claim: IssueClaim | null;
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
  issues: Issue[];
  links: Link[];
  comments: Comment[];
  subscriptions: Subscription[];
  cursor: number;
  serverTime: string;
}
export type EntityType = "team" | "workspace" | "issue" | "link" | "comment" | "subscription";
export interface TrackerEvent {
  cursor: number;
  operationId: string;
  actorId: string;
  kind: string;
  entityType: EntityType;
  entityId: string;
  entity: Team | Workspace | Issue | Link | Comment | Subscription | null;
  createdAt: string;
}
export type IssueFields = Pick<
  Issue,
  | "title"
  | "description"
  | "acceptance"
  | "type"
  | "status"
  | "priority"
  | "assigneeId"
  | "parentId"
  | "workspaceIds"
  | "labels"
>;
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
      data: Partial<Pick<Team, "name" | "description" | "memberIds" | "archived">>;
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
      data: { teamId: string; title: string } & Partial<Omit<IssueFields, "title">>;
    }
  | {
      kind: "issue.update";
      id: string;
      expectedVersion: number;
      data: Partial<IssueFields> & { leaseToken?: string };
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
  | { kind: "issue.claim"; id: string; data: { agent: string; ttlSeconds?: number } }
  | { kind: "issue.renew"; id: string; data: { leaseToken: string; ttlSeconds?: number } }
  | { kind: "issue.release"; id: string; data: { leaseToken: string } }
  | { kind: "issue.complete"; id: string; data: { leaseToken: string; evidence: string } };
export interface MutationRequest {
  operationId: string;
  mutations: Mutation[];
}
export interface MutationResult {
  cursor: number;
  events: TrackerEvent[];
  results: { id: string; leaseToken?: string; expiresAt?: string }[];
  serverTime: string;
}
export interface Changes {
  events: TrackerEvent[];
  cursor: number;
  hasMore: boolean;
  serverTime: string;
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
export function claimHolder(
  snapshot: Pick<Snapshot, "members" | "agents">,
  claim: IssueClaim,
): string {
  return actorOf(snapshot, claim.actorId).agent ? actorName(snapshot, claim.actorId) : claim.agent;
}

/** Done and canceled issues are closed; everything else still has work in it. */
export function isOpen(issue: Pick<Issue, "status">): boolean {
  return issue.status !== "done" && issue.status !== "canceled";
}

export function hasActiveClaim(issue: Issue, now: string): boolean {
  return issue.claim !== null && issue.claim.expiresAt > now;
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
 * - `unavailable`: backlog, done, canceled, or in progress without a claim;
 * - `blocked`: a `blocks` predecessor isn't done (a missing one still blocks);
 * - `container`: it has open sub-issues, so the work is in those;
 * - `leased_above`: an ancestor's active lease covers it.
 */
export type Readiness =
  | "ready"
  | "claimed"
  | "unavailable"
  | "blocked"
  | "container"
  | "leased_above";

export function readiness(issue: Issue, index: ReadinessIndex, now: string): Readiness {
  if (hasActiveClaim(issue, now)) return "claimed";
  if (!(issue.status === "todo" || (issue.status === "in_progress" && issue.claim !== null)))
    return "unavailable";
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
