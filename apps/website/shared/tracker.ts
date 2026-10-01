export interface TrackerIdentity {
  id: string;
  slug: string;
  displayName: string;
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
  actorId: string;
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
export function isIssueReady(
  issue: Issue,
  issues: Issue[],
  links: Link[],
  serverTime = new Date().toISOString(),
): boolean {
  const active = issue.claim !== null && issue.claim.expiresAt > serverTime;
  return (
    !active &&
    (issue.status === "todo" || (issue.status === "in_progress" && issue.claim !== null)) &&
    !links.some(
      (link) =>
        link.kind === "blocks" &&
        link.toId === issue.id &&
        issues.find((item) => item.id === link.fromId)?.status !== "done",
    )
  );
}
