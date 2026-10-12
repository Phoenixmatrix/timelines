// The tracker's working model at scale: one index over the snapshot (built
// once per sync, so readiness and blockers are lookups, not scans), a small
// query language over it, facet counts, and opened/closed activity buckets.
// Everything here is pure, so it is tested without a browser.
//
//   is:ready is:waiting is:not_ready is:human_only is:blocked is:container is:claimed is:leased
//   is:open is:closed   (is:container: To do with open sub-issues, CORE-108)
//   status:backlog|todo|in_progress|done|done_in_timeline|canceled
//   team:CORE  ws:packages  assignee:jun|me|none  tag:perf  type:bug  p:1
//   (tag: is the issue's tags from the tracker's tag catalog; label: still works)
//   since:7d until:2026-09-01   (last activity: updatedAt)
//   parent:CORE-12   numbers/full keys match tickets exactly (case-insensitive);
//   requires:ux|tag:ux|memory>=16GiB|none   eligible:builder|me (CORE-32: which
//   agents meet an issue's requirements and pickup policy);
//   done-by:me|mine|builder|jun  done:14d   (CORE-220: who finished it and when,
//   from `completion`; mine is the agents you answer for);
//   other words match key, title and tags; - excludes.

import {
  hasRequirements,
  requirementTerms,
  unmetRequirements,
  type IssueRequirements,
  type UnmetRequirement,
} from "./requirements.ts";
import {
  actorName,
  claimHolder,
  hasActiveClaim,
  isFinished,
  isOpen,
  leasedAncestor,
  issuePickup,
  ISSUE_PICKUPS,
  readiness,
  readinessIndex,
  type Issue,
  type IssueClaim,
  type Snapshot,
} from "./tracker.ts";

export type IssueState =
  | "waiting"
  | "not_ready"
  | "human_only"
  | "claimed"
  | "leased"
  | "blocked"
  | "container"
  | "ready"
  | "in_progress"
  | "todo"
  | "backlog"
  | "done"
  | "done_in_timeline"
  | "canceled";

export const STATE_LABEL: Record<IssueState, string> = {
  waiting: "Waiting",
  not_ready: "Not ready",
  human_only: "Human only",
  ready: "Ready",
  in_progress: "In progress",
  claimed: "Claimed",
  leased: "Leased",
  blocked: "Blocked",
  container: "Sub-issues",
  todo: "To do",
  backlog: "Backlog",
  done: "Done",
  done_in_timeline: "Done in a timeline",
  canceled: "Canceled",
};

/**
 * How work sorts by default: what's underway first (CORE-295), then what can
 * move now, closed last. Each progress group below is a run of these ranks.
 */
const STATE_RANK: Record<IssueState, number> = {
  // Waiting needs a person, so it leads.
  waiting: 0,
  claimed: 1,
  leased: 2,
  in_progress: 3,
  // Finished, waiting for its timeline to land (CORE-74): close to done, so
  // it sits with work underway, ahead of what's next (CORE-298).
  done_in_timeline: 4,
  ready: 5,
  todo: 6,
  // The work is in its sub-issues: next, but not itself to pick up.
  container: 6.5,
  blocked: 7,
  not_ready: 7.1,
  human_only: 7.2,
  backlog: 8,
  done: 9,
  canceled: 10,
};

export interface IssueIndex {
  byId: Map<string, Issue>;
  byKey: Map<string, Issue>;
  /** Blocking issues that aren't done yet. */
  openBlockers: Map<string, Issue[]>;
  /** Issues this one blocks. */
  dependents: Map<string, string[]>;
  children: Map<string, string[]>;
  state: Map<string, IssueState>;
  /** For leased issues: the ancestor whose active lease covers them. */
  leasedBy: Map<string, Issue>;
  teamKey: Map<string, string>;
  workspaceSlug: Map<string, string>;
  memberSlug: Map<string, string>;
  memberName: Map<string, string>;
  agentIds: Set<string>;
  /** Members and agents, to show who's accountable for an actor or claim. */
  people: Pick<Snapshot, "members" | "agents">;
}

/** An issue's sub-issues, from the index. */
export function childrenOf(issue: Issue, index: IssueIndex): Issue[] {
  return (index.children.get(issue.id) ?? []).flatMap((id) => index.byId.get(id) ?? []);
}

/**
 * How far a parent is through its sub-issues (CORE-108). Canceled ones aren't
 * part of the work; done in a timeline stays open until it lands, as readiness
 * counts it.
 */
export function subIssueProgress(children: readonly Issue[]): {
  done: number;
  total: number;
  open: Issue[];
} {
  const open = children.filter(isOpen);
  const done = children.filter((child) => child.status === "done").length;
  return { done, total: done + open.length, open };
}

/** A container's badge: "Sub-issues · 2/5 done". */
export function subIssueLabel(progress: { done: number; total: number }): string {
  return `${STATE_LABEL.container} · ${progress.done}/${progress.total} done`;
}

/**
 * Why an issue isn't ready, in one line (CORE-108), or null when it is ready
 * or finished. One wording for every readiness state, wherever it's shown.
 */
export function whyNotReady(
  issue: Issue,
  index: IssueIndex,
  snapshot: Pick<Snapshot, "requests" | "members" | "agents">,
): string | null {
  const keys = (issues: readonly Issue[]) => issues.map((item) => item.key).join(", ");
  switch (index.state.get(issue.id)) {
    case "waiting": {
      const asks = snapshot.requests.filter((r) => r.issueId === issue.id && r.status === "open");
      const who = [...new Set(asks.map((r) => actorName(snapshot, r.routeTo)))];
      return `Waiting on ${who.join(", ") || "a person"} to answer ${asks.length > 1 ? `${asks.length} requests` : "a request"}`;
    }
    case "claimed":
      return issue.claim ? `Claimed by ${claimLabel(index, issue.claim)}` : null;
    case "leased":
      return `Covered by ${index.leasedBy.get(issue.id)?.key}'s lease`;
    case "not_ready":
      return "Pickup is paused until a person enables it";
    case "human_only":
      return "Only people can pick up this issue";
    case "blocked":
      return `Blocked by ${keys(index.openBlockers.get(issue.id) ?? [])}`;
    case "container": {
      const { open, total } = subIssueProgress(childrenOf(issue, index));
      return `${open.length} of ${total} ${total === 1 ? "sub-issue" : "sub-issues"} still open`;
    }
    case "backlog":
      return "In Backlog: move it to To do to queue it";
    case "in_progress":
      return "In progress, but nobody holds a claim on it";
    // Ready, or finished (done, canceled, done in a timeline): nothing to explain.
    default:
      return null;
  }
}

/** Who holds a claim, in words: "builder for Ann Lee", or "Ann Lee (laptop)". */
export function claimLabel(index: IssueIndex, claim: IssueClaim): string {
  return claimHolder(index.people, claim);
}

export function buildIndex(snapshot: Snapshot, serverTime: string): IssueIndex {
  const byId = new Map<string, Issue>();
  const byKey = new Map<string, Issue>();
  for (const issue of snapshot.issues) {
    byId.set(issue.id, issue);
    byKey.set(issue.key.toLowerCase(), issue);
  }
  const openBlockers = new Map<string, Issue[]>();
  const dependents = new Map<string, string[]>();
  for (const link of snapshot.links) {
    if (link.kind !== "blocks") continue;
    const blocker = byId.get(link.fromId);
    if (!blocker || !byId.has(link.toId)) continue;
    dependents.set(link.fromId, [...(dependents.get(link.fromId) ?? []), link.toId]);
    if (blocker.status !== "done") {
      openBlockers.set(link.toId, [...(openBlockers.get(link.toId) ?? []), blocker]);
    }
  }
  const children = new Map<string, string[]>();
  for (const issue of snapshot.issues) {
    if (issue.parentId)
      children.set(issue.parentId, [...(children.get(issue.parentId) ?? []), issue.id]);
  }
  // Readiness is shared with the server and gm, so "ready" here means what an agent can take.
  const graph = readinessIndex(snapshot.issues, snapshot.links);
  const state = new Map<string, IssueState>();
  const leasedBy = new Map<string, Issue>();
  for (const issue of snapshot.issues) {
    const why = readiness(issue, graph, serverTime);
    if (why === "leased_above") leasedBy.set(issue.id, leasedAncestor(issue, graph, serverTime)!);
    let value: IssueState;
    if (why === "waiting") value = "waiting";
    // Done in a timeline whatever its lease: the work is waiting to land, not going on.
    else if (issue.status === "done_in_timeline") value = "done_in_timeline";
    else if (why === "claimed") value = "claimed";
    else if (issue.status === "done" || issue.status === "canceled") value = issue.status;
    else if (why === "not_ready" || why === "human_only") value = why;
    else if (why === "blocked") value = "blocked";
    // Open sub-issues: the work is in those (CORE-108).
    else if (why === "container") value = "container";
    else if (why === "leased_above") value = "leased";
    else if (why === "ready") value = "ready";
    // Everything else (backlog, in progress without a claim) shows its status.
    else value = issue.status;
    state.set(issue.id, value);
  }
  return {
    byId,
    byKey,
    openBlockers,
    dependents,
    children,
    state,
    leasedBy,
    teamKey: new Map(snapshot.teams.map((t) => [t.id, t.key])),
    workspaceSlug: new Map(snapshot.workspaces.map((w) => [w.id, w.slug])),
    memberSlug: new Map(snapshot.members.map((m) => [m.id, m.slug])),
    memberName: new Map([
      ...snapshot.members.map((m): [string, string] => [m.id, m.displayName]),
      // Agents read as "builder for Ann Lee" wherever a name is shown.
      ...snapshot.agents.map((a): [string, string] => [a.id, actorName(snapshot, a.id)]),
    ]),
    agentIds: new Set(snapshot.agents.map((a) => a.id)),
    people: { members: snapshot.members, agents: snapshot.agents },
  };
}

// ── Query language ──────────────────────────────────────────────────────────

export const QUERY_KEYS = [
  "is",
  "status",
  "team",
  "ws",
  "assignee",
  "tag",
  "type",
  "p",
  "since",
  "until",
  "parent",
  "requires",
  "eligible",
  "done-by",
  "done",
] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];
/** Other spellings of a key; `label:` is the old name of `tag:` (CORE-271). */
export const QUERY_ALIASES: Record<string, QueryKey> = {
  workspace: "ws",
  priority: "p",
  state: "is",
  owner: "assignee",
  label: "tag",
  labels: "tag",
  tags: "tag",
  doneby: "done-by",
};
/** The key a written key means, aliases included; undefined when it isn't one. */
export function queryKey(name: string): QueryKey | undefined {
  const lower = name.toLowerCase();
  return (QUERY_KEYS as readonly string[]).includes(lower)
    ? (lower as QueryKey)
    : QUERY_ALIASES[lower];
}

export interface Filter {
  key: QueryKey;
  value: string;
  negated: boolean;
}
export interface ParsedQuery {
  filters: Filter[];
  words: { text: string; negated: boolean }[];
  unknown: string[];
}

export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(/(-?[A-Za-z][A-Za-z-]*:)?"([^"]*)"|\S+/g)) {
    tokens.push(match[2] !== undefined ? `${match[1] ?? ""}${match[2]}` : match[0]);
  }
  return tokens;
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { filters: [], words: [], unknown: [] };
  for (const token of tokenize(query)) {
    const match = /^(-?)([A-Za-z][A-Za-z-]*):(.*)$/.exec(token);
    if (!match) {
      const negated = token.length > 1 && token.startsWith("-");
      parsed.words.push({ text: (negated ? token.slice(1) : token).toLowerCase(), negated });
      continue;
    }
    const key = queryKey(match[2]!);
    if (!key || !match[3]) {
      parsed.unknown.push(token);
      continue;
    }
    parsed.filters.push({ key, value: match[3].toLowerCase(), negated: match[1] === "-" });
  }
  return parsed;
}

export function filterToken(key: QueryKey, value: string, negated = false): string {
  return `${negated ? "-" : ""}${key}:${/\s/.test(value) ? `"${value}"` : value}`;
}

/** A token with its key in the canonical spelling: `label:ux` reads `tag:ux`. */
export function canonicalToken(token: string): string {
  const match = /^(-?)([A-Za-z][A-Za-z-]*):(.*)$/.exec(token);
  const key = match && queryKey(match[2]!);
  return key ? `${match[1]}${key}:${match[3]}` : token;
}

/**
 * Add `key:value` (`-key:value` when negated) to the query, or remove it when
 * present, every copy and in any spelling.
 */
export function toggleToken(query: string, key: QueryKey, value: string, negated = false): string {
  const tokens = tokenize(query);
  const token = filterToken(key, value, negated);
  const kept = tokens.filter(
    (t) => canonicalToken(filterTokenOf(t)).toLowerCase() !== token.toLowerCase(),
  );
  if (kept.length === tokens.length) kept.push(token);
  return kept.join(" ");
}
/** The query's filters as filterToken writes them, lowercase: what a facet shows as pressed. */
export function queryTokenSet(query: string): Set<string> {
  return new Set(tokenize(query).map((t) => canonicalToken(filterTokenOf(t)).toLowerCase()));
}
/** A tokenized `key:value` written back the way filterToken writes it (quotes kept). */
function filterTokenOf(token: string): string {
  const match = /^(-?[A-Za-z][A-Za-z-]*:)(.*)$/.exec(token);
  return match && /\s/.test(match[2]!) ? `${match[1]}"${match[2]}"` : token;
}

/** Replace every token of these keys, whatever spelling they were written in. */
export function withoutKeys(query: string, keys: QueryKey[]): string {
  return tokenize(query)
    .filter((t) => {
      const match = /^-?([A-Za-z][A-Za-z-]*):/.exec(t);
      const key = match && queryKey(match[1]!);
      return !key || !keys.includes(key);
    })
    .join(" ");
}

const DURATION = /^(\d+)(m|h|d|w)$/;
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export function parseWhen(value: string, now: number): number | null {
  const d = DURATION.exec(value);
  if (d) return now - Number(d[1]) * UNIT[d[2] as keyof typeof UNIT];
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

type Predicate = (issue: Issue) => boolean;

function predicate(filter: Filter, index: IssueIndex, viewerId: string, now: number): Predicate {
  const v = filter.value;
  switch (filter.key) {
    case "is":
      if (v === "open") return (i) => i.status !== "done" && i.status !== "canceled";
      if (v === "closed") return (i) => i.status === "done" || i.status === "canceled";
      return (i) => index.state.get(i.id) === v;
    case "status":
      return (i) => i.status === v;
    case "team":
      return (i) => index.teamKey.get(i.teamId)?.toLowerCase() === v;
    case "ws":
      return (i) => i.workspaceIds.some((w) => index.workspaceSlug.get(w)?.toLowerCase() === v);
    case "assignee":
      if (v === "none") return (i) => i.assigneeId === null;
      if (v === "me") return (i) => i.assigneeId === viewerId;
      return (i) =>
        !!i.assigneeId && (index.memberSlug.get(i.assigneeId) ?? i.assigneeId).toLowerCase() === v;
    case "tag":
      return (i) => i.labels.some((l) => l.toLowerCase() === v);
    case "type":
      return (i) => i.type === v;
    case "p":
      return (i) => String(i.priority) === v.replace(/^p/, "");
    case "since":
    case "until": {
      const t = parseWhen(v, now);
      if (t === null) return () => true;
      return filter.key === "since"
        ? (i) => Date.parse(i.updatedAt) >= t
        : (i) => Date.parse(i.updatedAt) < t;
    }
    case "parent": {
      const parent = index.byKey.get(v) ?? index.byId.get(v);
      return (i) => !!parent && i.parentId === parent.id;
    }
    case "requires":
      if (v === "none") return (i) => !hasRequirements(i.requires);
      // A whole term ("tag:ux", "memory>=16gib"), else any listed value ("ux").
      return (i) =>
        requirementTerms(i.requires).some((term) => {
          const t = term.toLowerCase();
          return t === v || t.slice(t.indexOf(":") + 1) === v;
        });
    case "eligible": {
      const id = v === "me" ? viewerId : null;
      const agents = index.people.agents.filter((a) =>
        id ? a.id === id : a.id.toLowerCase() === v || a.name.toLowerCase() === v,
      );
      // People bypass capability requirements, but never the not-ready policy.
      if (v === "me" && !agents.length) return (i) => issuePickup(i) !== "not_ready";
      return (i) => agents.some((agent) => agentEligible(i, agent));
    }
    case "done-by": {
      // Only finished work with a credit on record (CORE-220).
      const credit = (i: Issue) => (isFinished(i.status) ? (i.completion ?? null) : null);
      if (v === "me") return (i) => credit(i)?.actorId === viewerId;
      if (v === "mine") {
        // An agent viewing counts its person's agents.
        const person =
          index.people.agents.find((a) => a.id === viewerId)?.accountable.id ?? viewerId;
        return (i) => credit(i)?.accountableId === person;
      }
      const ids = new Set([
        ...index.people.agents
          .filter((a) => a.id.toLowerCase() === v || a.name.toLowerCase() === v)
          .map((a) => a.id),
        ...index.people.members
          .filter((m) => m.id.toLowerCase() === v || m.slug.toLowerCase() === v)
          .map((m) => m.id),
      ]);
      return (i) => {
        const by = credit(i)?.actorId;
        return !!by && (ids.has(by) || by.toLowerCase() === v);
      };
    }
    case "done": {
      const t = parseWhen(v, now);
      if (t === null) return () => true;
      return (i) => {
        const at = isFinished(i.status) ? i.completion?.at : undefined;
        return !!at && Date.parse(at) >= t;
      };
    }
  }
}

/** Which open work an agent can take in one tracker (CORE-32), for the Agents page. */
export interface AgentWork {
  agentId: string;
  /** Open issues other than PRDs. */
  open: number;
  /** Of those, the ones with requirements. */
  requiring: number;
  /** Of those, the ones it meets (or is assigned). */
  eligible: number;
  /** A few it doesn't meet, highest priority first, and why. */
  missing: { key: string; title: string; unmet: string[] }[];
  /**
   * A few open issues it can take, to do first, highest priority first
   * (CORE-272); absent from servers before it.
   */
  takeable?: { key: string; title: string; status: Issue["status"]; requires: boolean }[];
}
export interface AgentEligibility {
  trackers: {
    tracker: { slug: string; displayName: string };
    agents: AgentWork[];
    /** The tracker's tag catalog (CORE-271), which agents' tags are chosen from. */
    tags?: string[];
  }[];
}

/** An agent's open work in a snapshot: how much of it asks for what it doesn't report. */
export function agentWork(
  snapshot: Pick<Snapshot, "issues" | "agents">,
  agentId: string,
  limit = 5,
): AgentWork {
  const agent = snapshot.agents.find((a) => a.id === agentId);
  const open = snapshot.issues.filter(
    (i) => i.status !== "done" && i.status !== "canceled" && i.type !== "prd",
  );
  const requiring = open.filter((i) => hasRequirements(i.requires));
  const missing = requiring
    .filter((i) => !agent || !agentEligible(i, agent))
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  const order = (a: Issue, b: Issue) =>
    Number(b.status === "todo") - Number(a.status === "todo") ||
    a.priority - b.priority ||
    a.key.localeCompare(b.key);
  const takeable = open
    .filter((i) => !i.claim && (!agent || agentEligible(i, agent)))
    .filter((i) => i.status === "todo" || i.status === "backlog")
    .sort(order)
    .slice(0, limit)
    .map((i) => ({
      key: i.key,
      title: i.title,
      status: i.status,
      requires: hasRequirements(i.requires),
    }));
  return {
    agentId,
    open: open.length,
    requiring: requiring.length,
    eligible: requiring.length - missing.length,
    takeable,
    missing: missing.slice(0, limit).map((i) => ({
      key: i.key,
      title: i.title,
      unmet: [
        ...(issuePickup(i) === "anyone" ? [] : [`Pickup: ${ISSUE_PICKUPS[issuePickup(i)]}.`]),
        ...unmetRequirements(i.requires, agent?.capabilities ?? null).map((u) => u.message),
      ],
    })),
  };
}

/**
 * What new requirements would do to the claim on an issue (CORE-272): the
 * holding agent, when it met the old ones (or missed less) and misses the new
 * ones, with what it misses. Null when nothing changes for the holder: no
 * active claim, or a person holds it.
 * The tracker computes the same on save; the web previews it before.
 */
export function tighteningEffect(
  issue: Issue,
  requires: IssueRequirements | null | undefined,
  agents: Snapshot["agents"],
  now: string,
): { agent: Snapshot["agents"][number]; unmet: UnmetRequirement[] } | null {
  if (!issue.claim || !hasActiveClaim(issue, now)) return null;
  const agent = agents.find((a) => a.id === issue.claim!.actorId);
  // A claim assigns its holder, so assignment doesn't exempt it here: the
  // editor decides, with the mismatch in view.
  if (!agent) return null;
  const unmet = unmetRequirements(requires, agent.capabilities);
  if (!unmet.length) return null;
  const before = new Set(
    unmetRequirements(issue.requires, agent.capabilities).map((u) => u.wanted),
  );
  return unmet.some((u) => !before.has(u.wanted)) ? { agent, unmet } : null;
}

/**
 * Whether an agent may claim an issue (CORE-32), as the tracker decides it:
 * pickup permits agents, and it meets requirements or is explicitly assigned.
 */
export function agentEligible(
  issue: Issue,
  agent: Pick<Snapshot["agents"][number], "id" | "capabilities">,
): boolean {
  return (
    issuePickup(issue) === "anyone" &&
    (issue.assigneeId === agent.id || !unmetRequirements(issue.requires, agent.capabilities).length)
  );
}

export interface Compiled {
  /** All filters; `except` drops one facet's own keys so its siblings stay visible. */
  matches: (issue: Issue, except?: QueryKey[]) => boolean;
  parsed: ParsedQuery;
}

export function compile(query: string, index: IssueIndex, viewerId: string, now: number): Compiled {
  const parsed = parseQuery(query);
  const groups = new Map<QueryKey, { positive: Predicate[]; negative: Predicate[] }>();
  for (const filter of parsed.filters) {
    const group = groups.get(filter.key) ?? { positive: [], negative: [] };
    (filter.negated ? group.negative : group.positive).push(
      predicate(filter, index, viewerId, now),
    );
    groups.set(filter.key, group);
  }
  const tickets: Predicate[] = [];
  const words: ParsedQuery["words"] = [];
  for (const word of parsed.words) {
    if (/^\d+$/.test(word.text)) {
      const suffix = `-${word.text}`;
      tickets.push((issue) => issue.key.endsWith(suffix) !== word.negated);
    } else if (/^[a-z][a-z0-9]{1,5}-\d+$/.test(word.text)) {
      tickets.push((issue) => (issue.key.toLowerCase() === word.text) !== word.negated);
    } else {
      words.push(word);
    }
  }
  return {
    parsed,
    matches(issue, except) {
      for (const [key, { positive, negative }] of groups) {
        if (except?.includes(key)) continue;
        if (positive.length && !positive.some((p) => p(issue))) return false;
        if (negative.some((p) => p(issue))) return false;
      }
      for (const ticket of tickets) if (!ticket(issue)) return false;
      if (words.length) {
        const haystack = `${issue.key} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
        for (const word of words) if (haystack.includes(word.text) === word.negated) return false;
      }
      return true;
    },
  };
}

export type SortKey = "rank" | "updated" | "created" | "priority" | "key";

const KEY_ORDER = new Intl.Collator(undefined, { numeric: true });

export function sortIssues(issues: Issue[], index: IssueIndex, sort: SortKey): Issue[] {
  const by: Record<SortKey, (a: Issue, b: Issue) => number> = {
    rank: (a, b) =>
      STATE_RANK[index.state.get(a.id)!] - STATE_RANK[index.state.get(b.id)!] ||
      a.priority - b.priority ||
      b.updatedAt.localeCompare(a.updatedAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    priority: (a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
    key: (a, b) => KEY_ORDER.compare(a.key, b.key),
  };
  return [...issues].sort(by[sort]);
}

// ── Progress groups ─────────────────────────────────────────────────────────

/**
 * The list's sections (CORE-295): work underway on top, then what's next, and
 * what's finished below. A group is a run of state ranks, so a sort only ever
 * reorders issues inside their group.
 */
export const PROGRESS_GROUPS = [
  {
    key: "underway",
    label: "In progress",
    states: ["waiting", "claimed", "leased", "in_progress"],
  },
  { key: "landing", label: "Done in a timeline", states: ["done_in_timeline"] },
  {
    key: "next",
    label: "Up next",
    states: ["ready", "todo", "container", "blocked", "not_ready", "human_only"],
  },
  { key: "backlog", label: "Backlog", states: ["backlog"] },
  { key: "closed", label: "Closed", states: ["done", "canceled"] },
] as const satisfies readonly { key: string; label: string; states: readonly IssueState[] }[];
export type GroupKey = (typeof PROGRESS_GROUPS)[number]["key"];

const GROUP_OF = new Map<IssueState, GroupKey>(
  PROGRESS_GROUPS.flatMap((g) => g.states.map((s): [IssueState, GroupKey] => [s, g.key])),
);

export interface IssueGroup {
  key: GroupKey;
  label: string;
  issues: Issue[];
  /** How many of each state, in rank order, for the group's summary. */
  states: { state: IssueState; count: number }[];
}

/** Sorted issues split into their progress groups, keeping the sort; empty groups drop out. */
export function groupIssues(sorted: Issue[], index: IssueIndex): IssueGroup[] {
  const buckets = new Map<GroupKey, Issue[]>();
  for (const issue of sorted) {
    const key = GROUP_OF.get(index.state.get(issue.id) ?? "todo") ?? "next";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(issue);
    else buckets.set(key, [issue]);
  }
  return PROGRESS_GROUPS.flatMap((g) => {
    const issues = buckets.get(g.key);
    if (!issues) return [];
    const counts = new Map<IssueState, number>();
    for (const issue of issues) {
      const state = index.state.get(issue.id) ?? "todo";
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return [
      {
        key: g.key,
        label: g.label,
        issues,
        states: g.states.flatMap((state) =>
          counts.has(state) ? [{ state, count: counts.get(state)! }] : [],
        ),
      },
    ];
  });
}

// ── Facets ──────────────────────────────────────────────────────────────────

export interface FacetValue {
  token: { key: QueryKey; value: string };
  label: string;
  count: number;
}
export interface Facets {
  state: FacetValue[];
  team: FacetValue[];
  ws: FacetValue[];
  assignee: FacetValue[];
  type: FacetValue[];
  tag: FacetValue[];
}

const STATE_TOKEN: Record<IssueState, { key: QueryKey; value: string }> = {
  waiting: { key: "is", value: "waiting" },
  not_ready: { key: "is", value: "not_ready" },
  human_only: { key: "is", value: "human_only" },
  ready: { key: "is", value: "ready" },
  claimed: { key: "is", value: "claimed" },
  leased: { key: "is", value: "leased" },
  blocked: { key: "is", value: "blocked" },
  container: { key: "is", value: "container" },
  in_progress: { key: "status", value: "in_progress" },
  todo: { key: "status", value: "todo" },
  backlog: { key: "status", value: "backlog" },
  done: { key: "status", value: "done" },
  done_in_timeline: { key: "status", value: "done_in_timeline" },
  canceled: { key: "status", value: "canceled" },
};

export function facetsOf(
  issues: Issue[],
  compiled: Compiled,
  index: IssueIndex,
  snapshot: Snapshot,
): Facets {
  const count = <K>(keys: QueryKey[], pick: (i: Issue) => K[]) => {
    const counts = new Map<K, number>();
    for (const issue of issues) {
      if (!compiled.matches(issue, keys)) continue;
      for (const k of pick(issue)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const states = count<IssueState>(["is", "status"], (i) => [index.state.get(i.id)!]);
  const teams = count<string>(["team"], (i) => [i.teamId]);
  const wss = count<string>(["ws"], (i) => i.workspaceIds);
  const people = count<string>(["assignee"], (i) => [i.assigneeId ?? ""]);
  const kinds = count<string>(["type"], (i) => [i.type]);
  const tags = count<string>(["tag"], (i) => i.labels);
  const sorted = (values: FacetValue[]) => values.sort((a, b) => b.count - a.count);
  return {
    state: (Object.keys(STATE_RANK) as IssueState[])
      .sort((a, b) => STATE_RANK[a] - STATE_RANK[b])
      .map((s) => ({ token: STATE_TOKEN[s], label: STATE_LABEL[s], count: states.get(s) ?? 0 }))
      .filter((f) => f.count > 0),
    team: sorted(
      [...teams].map(([id, n]) => ({
        token: { key: "team" as const, value: (index.teamKey.get(id) ?? id).toLowerCase() },
        label: snapshot.teams.find((t) => t.id === id)?.name ?? id,
        count: n,
      })),
    ),
    ws: sorted(
      [...wss].map(([id, n]) => ({
        token: { key: "ws" as const, value: (index.workspaceSlug.get(id) ?? id).toLowerCase() },
        label: snapshot.workspaces.find((w) => w.id === id)?.name ?? id,
        count: n,
      })),
    ),
    assignee: sorted(
      [...people].map(([id, n]) => ({
        token: { key: "assignee" as const, value: id ? (index.memberSlug.get(id) ?? id) : "none" },
        label: id ? (index.memberName.get(id) ?? id) : "Unassigned",
        count: n,
      })),
    ),
    type: sorted(
      [...kinds].map(([t, n]) => ({
        token: { key: "type" as const, value: t },
        label: t === "prd" ? "PRD" : t[0]!.toUpperCase() + t.slice(1),
        count: n,
      })),
    ),
    tag: sorted(
      [...tags].map(([l, n]) => ({
        token: { key: "tag" as const, value: l.toLowerCase() },
        label: l,
        count: n,
      })),
    ).slice(0, 12),
  };
}

// ── Activity ────────────────────────────────────────────────────────────────

export interface Activity {
  start: number;
  bucketMs: number;
  opened: number[];
  closed: number[];
}

const BUCKETS = [3_600_000, 6 * 3_600_000, 86_400_000, 7 * 86_400_000];

/** Opened (createdAt) and closed (updatedAt of done/canceled) per bucket, at most ~90 bars. */
export function activityOf(
  issues: Issue[],
  now: number,
  rangeStart?: number,
  rangeEnd?: number,
): Activity {
  let first = rangeStart ?? now;
  if (rangeStart === undefined)
    for (const i of issues) first = Math.min(first, Date.parse(i.createdAt));
  const end = rangeEnd ?? now;
  const span = Math.max(end - first, 3_600_000);
  const bucketMs = BUCKETS.find((b) => span / b <= 90) ?? BUCKETS[BUCKETS.length - 1]!;
  const start = Math.floor(first / bucketMs) * bucketMs;
  const n = Math.max(1, Math.ceil((end - start) / bucketMs));
  const opened = Array.from({ length: n }, () => 0);
  const closed = Array.from({ length: n }, () => 0);
  for (const issue of issues) {
    const o = Math.floor((Date.parse(issue.createdAt) - start) / bucketMs);
    if (o >= 0 && o < n) opened[o]!++;
    if (issue.status === "done" || issue.status === "canceled") {
      const c = Math.floor((Date.parse(issue.updatedAt) - start) / bucketMs);
      if (c >= 0 && c < n) closed[c]!++;
    }
  }
  return { start, bucketMs, opened, closed };
}

export const DEFAULT_QUERY = "is:open";

export const VIEWS: { label: string; query: string }[] = [
  { label: "Open", query: DEFAULT_QUERY },
  { label: "Ready", query: "is:ready" },
  { label: "Remediation", query: "type:remediation is:open" },
  { label: "Mine", query: "assignee:me is:open" },
  { label: "In progress", query: "status:in_progress" },
  { label: "Claimed", query: "is:claimed" },
  { label: "Blocked", query: "is:blocked" },
  { label: "Closed lately", query: "is:closed since:14d" },
  { label: "My agents' work", query: "done-by:mine done:14d" },
  { label: "Everything", query: "" },
];
