// The tracker's working model at scale: one index over the snapshot (built
// once per sync, so readiness and blockers are lookups, not scans), a small
// query language over it, facet counts, and opened/closed activity buckets.
// Everything here is pure, so it is tested without a browser.
//
//   is:ready is:waiting is:blocked is:claimed is:leased is:open is:closed
//   status:backlog|todo|in_progress|done|done_in_timeline|canceled
//   team:CORE  ws:packages  assignee:jun|me|none  label:perf  type:bug  p:1
//   since:7d until:2026-09-01   (last activity: updatedAt)
//   parent:CORE-12   numbers/full keys match tickets exactly (case-insensitive);
//   requires:ux|tag:ux|memory>=16GiB|none   eligible:builder|me (CORE-32: which
//   agents meet an issue's requirements; people always can);
//   other words match key, title and labels; - excludes.

import { hasRequirements, requirementTerms, unmetRequirements } from "./requirements.ts";
import {
  actorName,
  claimHolder,
  leasedAncestor,
  readiness,
  readinessIndex,
  type Issue,
  type IssueClaim,
  type Snapshot,
} from "./tracker.ts";

export type IssueState =
  | "waiting"
  | "claimed"
  | "leased"
  | "blocked"
  | "ready"
  | "in_progress"
  | "todo"
  | "backlog"
  | "done"
  | "done_in_timeline"
  | "canceled";

export const STATE_LABEL: Record<IssueState, string> = {
  waiting: "Waiting",
  ready: "Ready",
  in_progress: "In progress",
  claimed: "Claimed",
  leased: "Leased",
  blocked: "Blocked",
  todo: "To do",
  backlog: "Backlog",
  done: "Done",
  done_in_timeline: "Done in a timeline",
  canceled: "Canceled",
};

/** How work sorts by default: what can move now first, closed last. */
const STATE_RANK: Record<IssueState, number> = {
  // Waiting needs a person, so it leads.
  waiting: 0,
  ready: 1,
  claimed: 2,
  leased: 3,
  in_progress: 4,
  todo: 5,
  blocked: 6,
  // Finished, waiting for its timeline to land (CORE-74).
  done_in_timeline: 7,
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
    else if (why === "blocked") value = "blocked";
    else if (why === "leased_above") value = "leased";
    else if (why === "ready") value = "ready";
    // Containers (open sub-issues) and everything else show their status.
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
  "label",
  "type",
  "p",
  "since",
  "until",
  "parent",
  "requires",
  "eligible",
] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];
const ALIASES: Record<string, QueryKey> = {
  workspace: "ws",
  priority: "p",
  state: "is",
  owner: "assignee",
};

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
  for (const match of query.matchAll(/(-?[A-Za-z]+:)?"([^"]*)"|\S+/g)) {
    tokens.push(match[2] !== undefined ? `${match[1] ?? ""}${match[2]}` : match[0]);
  }
  return tokens;
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { filters: [], words: [], unknown: [] };
  for (const token of tokenize(query)) {
    const match = /^(-?)([A-Za-z]+):(.*)$/.exec(token);
    if (!match) {
      const negated = token.length > 1 && token.startsWith("-");
      parsed.words.push({ text: (negated ? token.slice(1) : token).toLowerCase(), negated });
      continue;
    }
    const name = match[2]!.toLowerCase();
    const key = (QUERY_KEYS as readonly string[]).includes(name)
      ? (name as QueryKey)
      : ALIASES[name];
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

/** Add `key:value` to the query, or remove it when present. */
export function toggleToken(query: string, key: QueryKey, value: string): string {
  const tokens = tokenize(query);
  const token = filterToken(key, value);
  const at = tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
  if (at !== -1) tokens.splice(at, 1);
  else tokens.push(token);
  return tokens.join(" ");
}

/** Replace every token of these keys. */
export function withoutKeys(query: string, keys: QueryKey[]): string {
  return tokenize(query)
    .filter((t) => !keys.some((k) => new RegExp(`^-?${k}:`, "i").test(t)))
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
    case "label":
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
      // People can always claim: `eligible:me` for a person matches everything.
      if (v === "me" && !agents.length) return () => true;
      return (i) => agents.some((agent) => agentEligible(i, agent));
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
}
export interface AgentEligibility {
  trackers: { tracker: { slug: string; displayName: string }; agents: AgentWork[] }[];
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
  return {
    agentId,
    open: open.length,
    requiring: requiring.length,
    eligible: requiring.length - missing.length,
    missing: missing.slice(0, limit).map((i) => ({
      key: i.key,
      title: i.title,
      unmet: unmetRequirements(i.requires, agent?.capabilities ?? null).map((u) => u.message),
    })),
  };
}

/**
 * Whether an agent may claim an issue (CORE-32), as the tracker decides it:
 * it meets the requirements, or the issue is assigned to it.
 */
export function agentEligible(
  issue: Issue,
  agent: Pick<Snapshot["agents"][number], "id" | "capabilities">,
): boolean {
  return (
    issue.assigneeId === agent.id || !unmetRequirements(issue.requires, agent.capabilities).length
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
  label: FacetValue[];
}

const STATE_TOKEN: Record<IssueState, { key: QueryKey; value: string }> = {
  waiting: { key: "is", value: "waiting" },
  ready: { key: "is", value: "ready" },
  claimed: { key: "is", value: "claimed" },
  leased: { key: "is", value: "leased" },
  blocked: { key: "is", value: "blocked" },
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
  const labels = count<string>(["label"], (i) => i.labels);
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
    label: sorted(
      [...labels].map(([l, n]) => ({
        token: { key: "label" as const, value: l.toLowerCase() },
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
  { label: "Everything", query: "" },
];
