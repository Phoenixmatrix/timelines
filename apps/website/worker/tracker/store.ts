import { timingSafeEqual } from "node:crypto";
import {
  DEFAULT_ATTEMPT_LIMIT,
  hasActiveClaim,
  isOpen,
  leasedAncestor,
  readiness,
  readinessIndex,
  type Changes,
  type Comment,
  type HumanRequest,
  type IssueClaim,
  type EntityType,
  type Issue,
  type Link,
  type Mutation,
  type MutationRequest,
  type MutationResult,
  type Snapshot,
  type Subscription,
  type Team,
  type TrackerAgent,
  type TrackerEvent,
  type TrackerIdentity,
  type Workspace,
} from "../../shared/tracker.ts";
import { sql as raw } from "kysely";
import { all, first, json, one, run, tracker, type SqlDatabase } from "./sql.ts";

export type { SqlDatabase } from "./sql.ts";

export class TrackerError extends Error {
  public status: 400 | 401 | 403 | 404 | 409 | 413;
  public code: string;
  public details: { currentVersion?: number; current?: Team | Workspace | Issue };
  constructor(
    status: TrackerError["status"],
    code: string,
    message: string,
    details: TrackerError["details"] = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export interface Access {
  /** Who actions are attributed to: an agent's id, or the person's. */
  actorId: string;
  /** Whose memberships and permissions apply: the person (an agent's accountable human). */
  principalId: string;
  /** Agents accountable to members: they may hold leases and be assigned work. */
  agents: TrackerAgent[];
  owner: TrackerIdentity;
  canAdmin: boolean;
  members: TrackerIdentity[];
  repos: { id: string; owner: string; name: string }[];
  /** D1-confirmed missing repositories; permits removing their orphan associations only. */
  deletedRepoIds?: string[];
}
type Entity = Team | Workspace | Issue | Link | Comment | HumanRequest | Subscription;
const tables = {
  team: "teams",
  workspace: "workspaces",
  issue: "issues",
  link: "links",
  comment: "comments",
  request: "requests",
  subscription: "subscriptions",
} as const;
function fail(code: string, message: string, status: TrackerError["status"] = 400): never {
  throw new TrackerError(status, code, message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Expected an object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("invalid_input", `Unknown field: ${key}.`);
}
function text(value: unknown, name: string, max = 200, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\u0000")
  )
    fail("invalid_input", `${name} must be ${empty ? "0" : "1"}–${max} characters without NUL.`);
  return value;
}
function id(value: unknown): string {
  const out = text(value, "id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(out))
    fail("invalid_input", "IDs must use letters, digits, dots, underscores, colons or hyphens.");
  return out;
}
function strings(value: unknown, name: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max)
    fail("invalid_input", `${name} must be an array of at most ${max} entries.`);
  const out = value.map((v) => text(v, name, 100));
  if (new Set(out).size !== out.length)
    fail("invalid_input", `${name} must not contain duplicates.`);
  return out;
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) fail("invalid_input", `Invalid ${name}.`);
  return value as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateRequest(value: unknown): MutationRequest {
  const body = object(value);
  keys(body, ["operationId", "mutations"]);
  id(body.operationId);
  if (!Array.isArray(body.mutations) || body.mutations.length < 1 || body.mutations.length > 100)
    fail("invalid_input", "mutations must contain 1–100 operations.");
  for (const entry of body.mutations) {
    const mutation = object(entry);
    keys(mutation, ["kind", "id", "expectedVersion", "data"]);
    text(mutation.kind, "kind", 40);
    id(mutation.id);
    if (mutation.data !== undefined) object(mutation.data);
    if (
      "expectedVersion" in mutation &&
      (!Number.isSafeInteger(mutation.expectedVersion) || Number(mutation.expectedVersion) < 1)
    )
      fail("invalid_input", "expectedVersion must be a positive integer.");
  }
  return { operationId: String(body.operationId), mutations: body.mutations as Mutation[] };
}

/** After its last request is answered, a parked lease's holder has this long to resume. */
export const RESUME_WINDOW_SECONDS = 3600;

/** All state and event writes run synchronously inside the caller's SQLite transaction. */
export class TrackerStore {
  private sql: SqlDatabase;
  private transaction: <T>(fn: () => T) => T;
  private clock: () => number;
  constructor(
    sql: SqlDatabase,
    transaction: <T>(fn: () => T) => T,
    clock: () => number = Date.now,
  ) {
    this.sql = sql;
    this.transaction = transaction;
    this.clock = clock;
    sql.exec(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_numbers (id TEXT PRIMARY KEY, number INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (issue_id TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offers (issue_id TEXT PRIMARY KEY, code TEXT NOT NULL, lease_token TEXT NOT NULL, to_actor TEXT, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS team_keys ON teams(json_extract(data, '$.key'));
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_slugs ON workspaces(json_extract(data, '$.slug'));
      CREATE INDEX IF NOT EXISTS blockers ON links(json_extract(data, '$.toId'), json_extract(data, '$.kind'));
      CREATE INDEX IF NOT EXISTS subscriptions_repo ON subscriptions(json_extract(data, '$.repoId'));
      CREATE INDEX IF NOT EXISTS parents ON issues(json_extract(data, '$.parentId'));
      CREATE INDEX IF NOT EXISTS request_issues ON requests(json_extract(data, '$.issueId'));`);
  }
  private all<T extends Entity>(type: EntityType): T[] {
    return all(this.sql, tracker.selectFrom(tables[type]).select("data").orderBy("id")).map(
      (r) => JSON.parse(r.data) as T,
    );
  }
  private get<T extends Entity>(type: EntityType, entityId: string): T {
    const row = first(
      this.sql,
      tracker.selectFrom(tables[type]).select("data").where("id", "=", entityId),
    );
    if (!row) fail("not_found", `${type} ${entityId} not found.`, 404);
    return JSON.parse(row.data) as T;
  }
  private cursor(): number {
    return one(
      this.sql,
      tracker
        .selectFrom("events")
        .select((eb) => eb.fn.coalesce(eb.fn.max("cursor"), eb.lit(0)).as("cursor")),
    ).cursor;
  }
  snapshot(access: Access): Snapshot {
    return {
      owner: access.owner,
      canAdmin: access.canAdmin,
      members: access.members,
      agents: access.agents,
      teams: this.all("team"),
      workspaces: this.all("workspace"),
      issues: this.all("issue"),
      links: this.all("link"),
      comments: this.all("comment"),
      requests: this.all("request"),
      subscriptions: this.all("subscription"),
      cursor: this.cursor(),
      serverTime: new Date(this.clock()).toISOString(),
    };
  }
  /** Open requests to people, with the issue each is about. */
  openRequests(): { request: HumanRequest; issue: Pick<Issue, "id" | "key" | "title"> }[] {
    return this.all<HumanRequest>("request")
      .filter((request) => request.status === "open")
      .map((request) => {
        const issue = this.get<Issue>("issue", request.issueId);
        return { request, issue: { id: issue.id, key: issue.key, title: issue.title } };
      });
  }
  subscribedWorkspaces(repoId: string): { workspaceId: string; slug: string; name: string }[] {
    id(repoId);
    return all(
      this.sql,
      tracker
        .selectFrom("subscriptions as s")
        .innerJoin("workspaces as w", (join) =>
          join.on("w.id", "=", json<string>("s.data", "$.workspaceId")),
        )
        .select([
          "w.id as workspaceId",
          json<string>("w.data", "$.slug").as("slug"),
          json<string>("w.data", "$.name").as("name"),
        ])
        .distinct()
        .where(json("s.data", "$.repoId"), "=", repoId)
        .where(json("w.data", "$.archived"), "=", raw.lit(0))
        .orderBy("slug"),
    );
  }
  subscriptionRepoIds(subscriptionIds: string[]): string[] {
    if (!subscriptionIds.length) return [];
    return all(
      this.sql,
      tracker
        .selectFrom("subscriptions")
        .select(json<string>("data", "$.repoId").as("repoId"))
        .distinct()
        .where("id", "in", subscriptionIds),
    ).map((row) => row.repoId);
  }
  changes(after: number, limit: number): Changes {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      fail("invalid_input", "after must be a nonnegative integer; limit must be 1–500.");
    const rows = all(
      this.sql,
      tracker
        .selectFrom("events")
        .select(["cursor", "data"])
        .where("cursor", ">", after)
        .orderBy("cursor")
        .limit(limit + 1),
    );
    const events = rows
      .slice(0, limit)
      .map((row) => ({ ...JSON.parse(row.data), cursor: row.cursor }) as TrackerEvent);
    return {
      events,
      cursor: events.at(-1)?.cursor ?? after,
      hasMore: rows.length > limit,
      serverTime: new Date(this.clock()).toISOString(),
    };
  }
  mutate(access: Access, input: unknown): MutationResult {
    const request = validateRequest(input);
    const encoded = canonical(request);
    if (new TextEncoder().encode(encoded).byteLength > 1_048_576)
      fail("body_too_large", "Mutation body exceeds 1 MiB.", 413);
    return this.transaction(() => {
      const receipt = first(
        this.sql,
        tracker
          .selectFrom("receipts")
          .select(["actor_id", "request", "result"])
          .where("id", "=", request.operationId),
      );
      if (receipt) {
        if (receipt.actor_id !== access.actorId || receipt.request !== encoded)
          fail(
            "operation_conflict",
            "operationId was already used with a different actor or payload.",
            409,
          );
        return JSON.parse(receipt.result) as MutationResult;
      }
      const now = new Date(this.clock()).toISOString();
      const events: TrackerEvent[] = [];
      const results: MutationResult["results"] = [];
      const started = new Set<string>();
      const emit = (type: EntityType, entityId: string, entity: Entity | null, kind: string) => {
        if (entity)
          run(
            this.sql,
            tracker
              .insertInto(tables[type])
              .values({ id: entityId, data: JSON.stringify(entity) })
              .onConflict((oc) =>
                oc.column("id").doUpdateSet((eb) => ({ data: eb.ref("excluded.data") })),
              ),
          );
        else run(this.sql, tracker.deleteFrom(tables[type]).where("id", "=", entityId));
        const event = {
          operationId: request.operationId,
          actorId: access.actorId,
          kind,
          entityType: type,
          entityId,
          entity,
          createdAt: now,
        };
        const cursor = one(
          this.sql,
          tracker
            .insertInto("events")
            .values({ data: JSON.stringify(event) })
            .returning("cursor"),
        ).cursor;
        events.push({ ...event, cursor });
      };
      const admin = () => {
        if (!access.canAdmin)
          fail("forbidden", "Tracker administration requires account ownership.", 403);
      };
      const member = (memberId: string) => {
        if (!access.members.some((m) => m.id === memberId))
          fail("invalid_member", "User is not a current account member.");
      };
      /** A member, or an agent accountable to one: the human who answers for it. */
      const answerable = (actorId: string) => {
        const agent = access.agents.find((a) => a.id === actorId);
        member(agent ? agent.accountable.id : actorId);
        return agent ? agent.accountable.id : actorId;
      };
      const unique = (type: EntityType, entityId: string) => {
        if (
          all(this.sql, tracker.selectFrom(tables[type]).select("id").where("id", "=", entityId))
            .length
        )
          fail("already_exists", `${type} ID already exists.`, 409);
      };
      const version = (entity: Team | Workspace | Issue, expected: unknown) => {
        if (!Number.isSafeInteger(expected) || Number(expected) < 1)
          fail("invalid_input", "expectedVersion is required and must be a positive integer.");
        if (entity.version !== expected)
          throw new TrackerError(409, "version_conflict", "Entity changed since it was read.", {
            currentVersion: entity.version,
            current: entity,
          });
      };
      const teamWritable = (team: Team) => {
        if (team.archived) fail("archived", "Team is archived.", 409);
        if (
          !access.canAdmin &&
          team.memberIds.length &&
          !team.memberIds.includes(access.principalId)
        )
          fail("forbidden", "Only team members may change this team's work.", 403);
      };
      const unblocked = (issue: Issue) => {
        const blocked = all(
          this.sql,
          tracker
            .selectFrom("links")
            .select("data")
            .where(json("data", "$.toId"), "=", issue.id)
            .where(json("data", "$.kind"), "=", raw.lit("blocks")),
        ).some(
          (row) =>
            this.get<Issue>("issue", (JSON.parse(row.data) as Link).fromId).status !== "done",
        );
        if (blocked)
          fail("blocked", "Resolve all blockers before starting or completing work.", 409);
      };
      /** Constant-time comparison for secrets. */
      const same = (a: string, b: string) => {
        const x = new TextEncoder().encode(a);
        const y = new TextEncoder().encode(b);
        return x.length === y.length && timingSafeEqual(x, y);
      };
      /** A lease that ends or changes its token takes any pending handoff with it. */
      const dropOffer = (issue: Issue) => {
        run(this.sql, tracker.deleteFrom("offers").where("issue_id", "=", issue.id));
        if (issue.handoff) issue.handoff = null;
      };
      /** Whether the caller holds `issue`'s active lease with `token`. */
      const holds = (issue: Issue, token: string) => {
        if (!issue.claim || !hasActiveClaim(issue, now) || issue.claim.actorId !== access.actorId)
          return false;
        const row = first(
          this.sql,
          tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
        );
        const a = new TextEncoder().encode(token);
        const b = new TextEncoder().encode(row?.token ?? "");
        return a.length === b.length && timingSafeEqual(a, b);
      };
      /** The active leases above an issue, nearest first. */
      const leasedAbove = (issue: Issue) => {
        const index = graph();
        const out: Issue[] = [];
        for (
          let above = leasedAncestor(issue, index, now);
          above;
          above = leasedAncestor(above, index, now)
        )
          out.push(above);
        return out;
      };
      /** Who a claim is for: the caller, or one of the caller's own agents. */
      const holderFor = (forActorId: unknown) => {
        if (forActorId === undefined || forActorId === access.actorId)
          return { actorId: access.actorId, accountableId: access.principalId };
        const agent = access.agents.find((a) => a.id === id(forActorId));
        if (!agent || agent.accountable.id !== access.principalId)
          fail("forbidden", "Claims can only be delegated to yourself or your own agents.", 403);
        return { actorId: agent.id, accountableId: agent.accountable.id };
      };
      /** `issue`'s lease must match `token`; `covered` is the descendant being changed, if any. */
      const lease = (issue: Issue, token: unknown, covered?: Issue) => {
        if (covered && covered.id !== issue.id && typeof token !== "string")
          fail(
            "subtree_leased",
            `${issue.key} is leased by ${issue.claim!.agent}, and its lease covers ${covered.key}; changing its status or parent needs that lease's token.`,
            409,
          );
        const supplied = text(token, "leaseToken", 200);
        const row = first(
          this.sql,
          tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
        );
        const a = new TextEncoder().encode(supplied);
        const b = new TextEncoder().encode(row?.token ?? "");
        if (
          !issue.claim ||
          !hasActiveClaim(issue, now) ||
          issue.claim.actorId !== access.actorId ||
          a.length !== b.length ||
          !timingSafeEqual(a, b)
        )
          fail("lease_lost", "Claim expired, was superseded, or belongs to another agent.", 409);
      };
      // The graph as this transaction sees it so far.
      const graph = () => readinessIndex(this.all<Issue>("issue"), this.all<Link>("link"));
      /** A lease on an issue covers its subtree: its holder speaks for every descendant. */
      const coveringLease = (issue: Issue) =>
        hasActiveClaim(issue, now) ? issue : leasedAncestor(issue, graph(), now);
      // A parent with open sub-issues is never offered as work, but claiming it
      // explicitly is how an orchestrating agent takes its whole subtree.
      const claimable = (issue: Issue, underToken?: unknown) => {
        const above = leasedAncestor(issue, graph(), now);
        if (above && underToken !== undefined) {
          if (!holds(above, text(underToken, "underToken", 200)))
            fail(
              "lease_lost",
              `That token doesn't hold ${above.key}'s lease, which covers ${issue.key}.`,
              409,
            );
          return above;
        }
        if (above)
          fail(
            "subtree_leased",
            `${above.key} is leased by ${above.claim!.agent}, and its lease covers ${issue.key}.`,
            409,
          );
        return null;
      };
      /** Hold `issue` for the caller: a fresh token, or the same one when renewing. */
      const grant = (
        issue: Issue,
        agent: string,
        ttl: number,
        token?: string,
        holder: { actorId: string; accountableId: string } = {
          actorId: access.actorId,
          accountableId: access.principalId,
        },
        delegatedFrom?: Issue | null,
      ) => {
        const leaseToken = token ?? crypto.randomUUID() + crypto.randomUUID();
        const expiresAt = new Date(Date.parse(now) + ttl * 1000).toISOString();
        issue.claim = {
          ...holder,
          agent,
          expiresAt,
          ...(delegatedFrom ? { delegatedFrom: delegatedFrom.id } : {}),
        };
        issue.status = "in_progress";
        run(
          this.sql,
          tracker
            .insertInto("leases")
            .values({ issue_id: issue.id, token: leaseToken })
            .onConflict((oc) =>
              oc.column("issue_id").doUpdateSet((eb) => ({ token: eb.ref("excluded.token") })),
            ),
        );
        return { leaseToken, expiresAt };
      };
      /**
       * The next issue to take in a scope: ready, not a PRD, unassigned or assigned to
       * the caller; first by priority, then by how much open work it unblocks
       * (critical path first), then by age.
       */
      const pick = (scope: {
        teamId?: string;
        workspaceId?: string;
        underId?: string;
        /** The caller holds underId's lease: its own subtree is open to it. */
        own?: Issue;
      }) => {
        const index = graph();
        const takeable = (issue: Issue) => {
          const why = readiness(issue, index, now);
          return (
            why === "ready" ||
            (why === "leased_above" && leasedAncestor(issue, index, now)?.id === scope.own?.id)
          );
        };
        const writable = (issue: Issue) => {
          const team = this.get<Team>("team", issue.teamId);
          return (
            !team.archived &&
            (access.canAdmin ||
              !team.memberIds.length ||
              team.memberIds.includes(access.principalId))
          );
        };
        const under = (issue: Issue) => {
          const seen = new Set<string>();
          for (
            let id = issue.parentId;
            id && !seen.has(id);
            id = index.byId.get(id)?.parentId ?? null
          ) {
            if (id === scope.underId) return true;
            seen.add(id);
          }
          return false;
        };
        const dependents = new Map<string, string[]>();
        for (const link of this.all<Link>("link"))
          if (link.kind === "blocks")
            dependents.set(link.fromId, [...(dependents.get(link.fromId) ?? []), link.toId]);
        const unblocks = (issue: Issue) => {
          const reached = new Set<string>();
          const queue = [issue.id];
          while (queue.length)
            for (const next of dependents.get(queue.pop()!) ?? [])
              if (!reached.has(next) && index.byId.get(next) && isOpen(index.byId.get(next)!)) {
                reached.add(next);
                queue.push(next);
              }
          return reached.size;
        };
        const candidates = [...index.byId.values()].filter(
          (issue) =>
            takeable(issue) &&
            issue.type !== "prd" &&
            (issue.assigneeId === null || issue.assigneeId === access.actorId) &&
            (!scope.teamId || issue.teamId === scope.teamId) &&
            (!scope.workspaceId || issue.workspaceIds.includes(scope.workspaceId)) &&
            (!scope.underId || under(issue)) &&
            writable(issue),
        );
        const weight = new Map(candidates.map((issue) => [issue.id, unblocks(issue)]));
        return (
          candidates.sort(
            (a, b) =>
              a.priority - b.priority ||
              weight.get(b.id)! - weight.get(a.id)! ||
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          )[0] ?? null
        );
      };
      /**
       * Recount an issue's open requests. When none are left, a parked lease unparks
       * with a window for its holder to resume; after that anyone may claim it.
       */
      const settle = (issue: Issue) => {
        const open = this.all<HumanRequest>("request").filter(
          (r) => r.issueId === issue.id && r.status === "open",
        ).length;
        issue.waiting = open;
        if (!open && issue.claim?.parkedAt) {
          delete issue.claim.parkedAt;
          issue.claim.expiresAt = new Date(
            Date.parse(now) + RESUME_WINDOW_SECONDS * 1000,
          ).toISOString();
        }
        issue.version++;
        issue.updatedAt = now;
        emit("issue", issue.id, issue, "issue.update");
      };
      /**
       * A claim released without completion. At the team's limit, the issue asks the
       * claim's accountable person what the next attempt should do differently, and
       * waits (out of ready) until someone answers.
       */
      const failedAttempt = (issue: Issue, released: IssueClaim) => {
        issue.attempts = (issue.attempts ?? 0) + 1;
        const limit = this.get<Team>("team", issue.teamId).attemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
        const requests = this.all<HumanRequest>("request");
        if (
          !limit ||
          issue.attempts < limit ||
          requests.some((r) => r.issueId === issue.id && r.status === "open" && r.escalation)
        )
          return;
        const checkpoints = this.all<Comment>("comment")
          .filter((c) => c.issueId === issue.id && c.kind === "checkpoint")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 3);
        const quoted = checkpoints.map((c) => `> ${c.body.split("\n").join("\n> ")}`).join("\n\n");
        const human = released.accountableId ?? access.principalId;
        const requestId = crypto.randomUUID();
        emit(
          "request",
          requestId,
          {
            id: requestId,
            issueId: issue.id,
            kind: "question",
            prompt:
              `Agents have released ${issue.key} ${issue.attempts} times without finishing it. ` +
              `What should the next attempt do differently?` +
              (quoted ? `\n\nLatest checkpoints:\n\n${quoted}` : ""),
            choices: [],
            secret: null,
            status: "open",
            askedBy: access.actorId,
            routeTo: access.members.some((m) => m.id === human) ? human : access.principalId,
            answer: null,
            answeredBy: null,
            answeredAt: null,
            createdAt: now,
            escalation: true,
          },
          "request.open",
        );
        issue.waiting =
          requests.filter((r) => r.issueId === issue.id && r.status === "open").length + 1;
      };
      const childrenClosed = (issue: Issue) => {
        const open = (graph().children.get(issue.id) ?? []).filter(isOpen);
        if (open.length)
          fail(
            "children_open",
            `Close its sub-issues first: ${open.map((child) => child.key).join(", ")}.`,
            409,
          );
      };
      const fields = (data: Record<string, unknown>, issue: Issue, creating: boolean) => {
        for (const key of ["title", "description", "acceptance"] as const)
          if (key in data)
            issue[key] = text(data[key], key, key === "title" ? 500 : 131072, key !== "title");
        if ("type" in data)
          issue.type = choice(data.type, ["task", "bug", "prd", "chore", "research"], "issue type");
        if ("status" in data)
          issue.status = choice(
            data.status,
            ["backlog", "todo", "in_progress", "done", "canceled"],
            "status",
          );
        if ("priority" in data) {
          if (
            !Number.isInteger(data.priority) ||
            Number(data.priority) < 0 ||
            Number(data.priority) > 4
          )
            fail("invalid_input", "priority must be 0–4.");
          issue.priority = data.priority as Issue["priority"];
        }
        if ("assigneeId" in data)
          issue.assigneeId = data.assigneeId === null ? null : id(data.assigneeId);
        if (issue.assigneeId) {
          // An agent can be assigned when its accountable human could be.
          const human = answerable(issue.assigneeId);
          const team = this.get<Team>("team", issue.teamId);
          if (team.memberIds.length && !team.memberIds.includes(human))
            fail("invalid_member", "Assignee must belong to the owning team.");
        }
        if ("parentId" in data) {
          issue.parentId = data.parentId === null ? null : id(data.parentId);
          if (issue.parentId) {
            this.get<Issue>("issue", issue.parentId);
            let parent: string | null = issue.parentId;
            const seen = new Set([issue.id]);
            while (parent) {
              if (seen.has(parent)) fail("parent_cycle", "Parent hierarchy must be acyclic.", 409);
              seen.add(parent);
              parent = this.get<Issue>("issue", parent).parentId;
            }
          }
        }
        if ("workspaceIds" in data) {
          const workspaceIds = strings(data.workspaceIds, "workspaceIds");
          for (const workspaceId of workspaceIds) {
            const workspace = this.get<Workspace>("workspace", workspaceId);
            if (workspace.archived && (creating || !issue.workspaceIds.includes(workspaceId)))
              fail("archived", "Cannot add work to an archived workspace.", 409);
          }
          issue.workspaceIds = workspaceIds;
        }
        if ("labels" in data) issue.labels = strings(data.labels, "labels", 50);
      };
      for (const mutation of request.mutations) {
        const entityId = mutation.id;
        const data = object("data" in mutation ? mutation.data : {});
        const base = { id: entityId, version: 1, createdAt: now, updatedAt: now };
        let result: MutationResult["results"][number] = { id: entityId };
        switch (mutation.kind) {
          case "team.create": {
            admin();
            keys(data, ["key", "name", "description", "memberIds"]);
            unique("team", entityId);
            const key = text(data.key, "key", 6);
            if (!/^[A-Z][A-Z0-9]{1,5}$/.test(key))
              fail(
                "invalid_input",
                "Team key must be 2–6 uppercase letters/digits starting with a letter.",
              );
            if (this.all<Team>("team").some((t) => t.key === key))
              fail("already_exists", "Team key already exists.", 409);
            const memberIds =
              data.memberIds === undefined ? [] : strings(data.memberIds, "memberIds");
            memberIds.forEach(member);
            emit(
              "team",
              entityId,
              {
                ...base,
                key,
                name: text(data.name, "name"),
                description: text(
                  data.description === undefined ? "" : data.description,
                  "description",
                  16384,
                  true,
                ),
                memberIds,
                archived: false,
              },
              mutation.kind,
            );
            break;
          }
          case "workspace.create": {
            admin();
            keys(data, ["slug", "name", "description"]);
            unique("workspace", entityId);
            const slug = text(data.slug, "slug", 80);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
              fail(
                "invalid_input",
                "Workspace slug must be lowercase letters/digits separated by hyphens.",
              );
            if (this.all<Workspace>("workspace").some((w) => w.slug === slug))
              fail("already_exists", "Workspace slug already exists.", 409);
            emit(
              "workspace",
              entityId,
              {
                ...base,
                slug,
                name: text(data.name, "name"),
                description: text(
                  data.description === undefined ? "" : data.description,
                  "description",
                  16384,
                  true,
                ),
                archived: false,
              },
              mutation.kind,
            );
            break;
          }
          case "team.update":
          case "workspace.update": {
            admin();
            const type = mutation.kind === "team.update" ? "team" : "workspace";
            keys(
              data,
              type === "team"
                ? ["name", "description", "memberIds", "archived", "attemptLimit"]
                : ["name", "description", "archived"],
            );
            const entity = this.get<Team | Workspace>(type, entityId);
            version(entity, mutation.expectedVersion);
            if ("name" in data) entity.name = text(data.name, "name");
            if ("description" in data)
              entity.description = text(data.description, "description", 16384, true);
            if ("archived" in data) {
              if (typeof data.archived !== "boolean")
                fail("invalid_input", "archived must be boolean.");
              entity.archived = data.archived;
            }
            if ("attemptLimit" in data && "memberIds" in entity) {
              if (
                !Number.isInteger(data.attemptLimit) ||
                Number(data.attemptLimit) < 0 ||
                Number(data.attemptLimit) > 20
              )
                fail("invalid_input", "attemptLimit must be 0 (never ask) to 20.");
              entity.attemptLimit = Number(data.attemptLimit);
            }
            if ("memberIds" in data && "memberIds" in entity) {
              const memberIds = strings(data.memberIds, "memberIds");
              memberIds.forEach(member);
              if (
                memberIds.length &&
                this.all<Issue>("issue").some(
                  (i) => i.teamId === entityId && i.assigneeId && !memberIds.includes(i.assigneeId),
                )
              )
                fail(
                  "invalid_member",
                  "Reassign existing issues before removing their assignees from the team.",
                  409,
                );
              entity.memberIds = memberIds;
            }
            entity.version++;
            entity.updatedAt = now;
            emit(type, entityId, entity, mutation.kind);
            break;
          }
          case "issue.create":
          case "issue.update": {
            const creating = mutation.kind === "issue.create";
            keys(data, [
              "title",
              "description",
              "acceptance",
              "type",
              "status",
              "priority",
              "assigneeId",
              "parentId",
              "workspaceIds",
              "labels",
              ...(creating ? ["teamId"] : ["leaseToken"]),
            ]);
            let issue: Issue;
            if (creating) {
              unique("issue", entityId);
              const team = this.get<Team>("team", id(data.teamId));
              teamWritable(team);
              const number = one(
                this.sql,
                tracker
                  .insertInto("team_numbers")
                  .values({ id: team.id, number: raw.lit(1) })
                  .onConflict((oc) =>
                    oc
                      .column("id")
                      .doUpdateSet((eb) => ({ number: eb("number", "+", raw.lit(1)) })),
                  )
                  .returning("number"),
              ).number;
              issue = {
                ...base,
                teamId: team.id,
                key: `${team.key}-${number}`,
                title: text(data.title, "title", 500),
                description: "",
                acceptance: "",
                type: "task",
                status: "todo",
                priority: 2,
                assigneeId: null,
                parentId: null,
                workspaceIds: [],
                labels: [],
                claim: null,
              };
            } else {
              issue = this.get<Issue>("issue", entityId);
              teamWritable(this.get("team", issue.teamId));
              version(issue, mutation.expectedVersion);
              const covering = coveringLease(issue);
              if (
                covering &&
                (("status" in data && data.status !== issue.status) ||
                  ("parentId" in data && data.parentId !== issue.parentId))
              )
                lease(covering, data.leaseToken, issue);
            }
            const previous = issue.status;
            fields(data, issue, creating);
            if (issue.status === "done" && previous !== "done") childrenClosed(issue);
            if (
              (creating || issue.status !== previous) &&
              ["in_progress", "done"].includes(issue.status)
            ) {
              unblocked(issue);
              started.add(entityId);
            }
            if ("status" in data && issue.status !== previous) {
              issue.claim = null;
              run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
              dropOffer(issue);
            }
            if (!creating) {
              issue.version++;
              issue.updatedAt = now;
            }
            emit("issue", entityId, issue, mutation.kind);
            break;
          }
          case "link.add": {
            keys(data, ["fromId", "toId", "kind"]);
            unique("link", entityId);
            const fromId = id(data.fromId);
            const toId = id(data.toId);
            const kind = choice(data.kind, ["blocks", "related", "duplicates"], "link kind");
            const from = this.get<Issue>("issue", fromId);
            const to = this.get<Issue>("issue", toId);
            teamWritable(this.get("team", from.teamId));
            teamWritable(this.get("team", to.teamId));
            if (fromId === toId) fail("graph_cycle", "An issue cannot link to itself.", 409);
            const links = this.all<Link>("link");
            if (links.some((l) => l.kind === kind && l.fromId === fromId && l.toId === toId))
              fail("already_exists", "This relationship already exists.", 409);
            if (kind === "blocks") {
              const seen = new Set<string>();
              const queue = [toId];
              while (queue.length) {
                const next = queue.pop()!;
                if (next === fromId) fail("graph_cycle", "Blocker graph must be acyclic.", 409);
                if (seen.has(next)) continue;
                seen.add(next);
                for (const link of links)
                  if (link.kind === "blocks" && link.fromId === next) queue.push(link.toId);
              }
              if (from.status !== "done" && to.status === "done")
                fail("blocked", "Reopen completed work before adding an unresolved blocker.", 409);
            }
            emit("link", entityId, { id: entityId, fromId, toId, kind }, mutation.kind);
            break;
          }
          case "link.remove": {
            keys(data, []);
            const link = this.get<Link>("link", entityId);
            teamWritable(this.get("team", this.get<Issue>("issue", link.fromId).teamId));
            teamWritable(this.get("team", this.get<Issue>("issue", link.toId).teamId));
            emit("link", entityId, null, mutation.kind);
            break;
          }
          case "comment.add": {
            keys(data, ["issueId", "body", "kind"]);
            unique("comment", entityId);
            const issueId = id(data.issueId);
            teamWritable(this.get("team", this.get<Issue>("issue", issueId).teamId));
            emit(
              "comment",
              entityId,
              {
                id: entityId,
                issueId,
                body: text(data.body, "body", 131072),
                kind: choice(
                  data.kind === undefined ? "comment" : data.kind,
                  ["comment", "checkpoint", "evidence"],
                  "comment kind",
                ),
                actorId: access.actorId,
                createdAt: now,
              },
              mutation.kind,
            );
            break;
          }
          case "subscription.add": {
            admin();
            keys(data, ["workspaceId", "repoId"]);
            unique("subscription", entityId);
            const workspaceId = id(data.workspaceId);
            if (this.get<Workspace>("workspace", workspaceId).archived)
              fail("archived", "Cannot subscribe to an archived workspace.", 409);
            const repoId = id(data.repoId);
            const repo = access.repos.find((r) => r.id === repoId);
            if (!repo) fail("forbidden", "Repository administration is required.", 403);
            if (
              this.all<Subscription>("subscription").some(
                (s) => s.workspaceId === workspaceId && s.repoId === repoId,
              )
            )
              fail("already_exists", "Repository already subscribes to this workspace.", 409);
            emit(
              "subscription",
              entityId,
              { id: entityId, workspaceId, repoId, owner: repo.owner, name: repo.name },
              mutation.kind,
            );
            break;
          }
          case "subscription.remove": {
            admin();
            keys(data, []);
            const subscription = this.get<Subscription>("subscription", entityId);
            if (
              !access.repos.some((r) => r.id === subscription.repoId) &&
              !access.deletedRepoIds?.includes(subscription.repoId)
            )
              fail("forbidden", "Repository administration is required.", 403);
            emit("subscription", entityId, null, mutation.kind);
            break;
          }
          case "issue.next": {
            keys(data, [
              "agent",
              "ttlSeconds",
              "teamId",
              "workspaceId",
              "underId",
              "underToken",
              "forActorId",
            ]);
            const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
            if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
              fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
            const agent = text(data.agent, "agent", 200);
            const scope = {
              ...(data.teamId === undefined ? {} : { teamId: id(data.teamId) }),
              ...(data.workspaceId === undefined ? {} : { workspaceId: id(data.workspaceId) }),
              ...(data.underId === undefined ? {} : { underId: id(data.underId) }),
            };
            if (scope.teamId) this.get<Team>("team", scope.teamId);
            if (scope.workspaceId) this.get<Workspace>("workspace", scope.workspaceId);
            let own: Issue | null = null;
            if (scope.underId) {
              const under = this.get<Issue>("issue", scope.underId);
              if (data.underToken !== undefined) {
                if (!holds(under, text(data.underToken, "underToken", 200)))
                  fail("lease_lost", `That token doesn't hold ${under.key}'s lease.`, 409);
                own = under;
              }
            } else if (data.underToken !== undefined)
              fail("invalid_input", "underToken needs underId: the issue whose lease it is.");
            const holder = holderFor(data.forActorId);
            const issue = pick({ ...scope, ...(own ? { own } : {}) });
            // Nothing ready is an answer, not an error: the agent can stop or wait.
            if (!issue) break;
            result = {
              id: entityId,
              issueId: issue.id,
              key: issue.key,
              ...grant(issue, agent, Number(ttl), undefined, holder, own),
            };
            issue.version++;
            issue.updatedAt = now;
            emit("issue", issue.id, issue, "issue.claim");
            break;
          }
          case "request.open": {
            keys(data, ["issueId", "kind", "prompt", "choices", "secret", "routeTo", "leaseToken"]);
            unique("request", entityId);
            const issue = this.get<Issue>("issue", id(data.issueId));
            teamWritable(this.get("team", issue.teamId));
            const kind = choice(
              data.kind,
              ["question", "approval", "decision", "credential"] as const,
              "request kind",
            );
            const choices = kind === "decision" ? strings(data.choices ?? [], "choices", 20) : [];
            if (kind === "decision" && choices.length < 2)
              fail("invalid_input", "A decision needs at least two choices.");
            if (kind !== "decision" && data.choices !== undefined)
              fail("invalid_input", "Only decisions have choices.");
            let secret: HumanRequest["secret"] = null;
            if (kind === "credential") {
              const target = object(data.secret);
              keys(target, ["repo", "name"]);
              const repo = text(target.repo, "secret.repo", 200);
              const name = text(target.name, "secret.name", 100);
              if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
                fail("invalid_input", "secret.repo must be owner/name.");
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
                fail("invalid_input", "secret.name must be letters, digits and underscores.");
              secret = { repo, name };
            } else if (data.secret !== undefined)
              fail("invalid_input", "Only credential requests name a secret.");
            const routeTo = data.routeTo === undefined ? access.principalId : id(data.routeTo);
            member(routeTo);
            // Asking with the issue's own lease parks it: it holds while the agent waits.
            if (data.leaseToken !== undefined) {
              lease(issue, data.leaseToken);
              issue.claim!.parkedAt = now;
            }
            emit(
              "request",
              entityId,
              {
                id: entityId,
                issueId: issue.id,
                kind,
                prompt: text(data.prompt, "prompt", 20000),
                choices,
                secret,
                status: "open",
                askedBy: access.actorId,
                routeTo,
                answer: null,
                answeredBy: null,
                answeredAt: null,
                createdAt: now,
              },
              mutation.kind,
            );
            settle(issue);
            break;
          }
          case "request.answer":
          case "request.cancel": {
            const request = this.get<HumanRequest>("request", entityId);
            const issue = this.get<Issue>("issue", request.issueId);
            teamWritable(this.get("team", issue.teamId));
            if (request.status !== "open")
              fail("not_open", `This request was already ${request.status}.`, 409);
            if (mutation.kind === "request.cancel") {
              keys(data, []);
              if (request.askedBy !== access.actorId && !access.canAdmin)
                fail("forbidden", "Only whoever asked can cancel a request.", 403);
              request.status = "canceled";
            } else {
              keys(data, ["answer", "choice", "approved", "stored"]);
              // Requests are for people: an agent can't answer its own (or another's) question.
              if (access.actorId !== access.principalId)
                fail("forbidden", "Agents can't answer requests; a person has to.", 403);
              if (request.kind === "question") request.answer = text(data.answer, "answer", 20000);
              else if (request.kind === "decision") {
                const picked = text(data.choice, "choice", 100);
                if (!request.choices.includes(picked))
                  fail("invalid_input", `Choose one of: ${request.choices.join(", ")}.`);
                request.answer = picked;
              } else if (request.kind === "approval") {
                if (typeof data.approved !== "boolean")
                  fail("invalid_input", "Approve or reject: approved must be true or false.");
                const note =
                  data.answer === undefined ? "" : ` · ${text(data.answer, "answer", 20000)}`;
                request.answer = `${data.approved ? "approved" : "rejected"}${note}`;
              } else {
                // The value went to the secret store; the tracker only records where.
                if (data.stored !== true || data.answer !== undefined)
                  fail(
                    "invalid_input",
                    "Store the credential as its secret, then answer with stored: true and no value.",
                  );
                request.answer = `Stored as ${request.secret!.name} on ${request.secret!.repo}`;
              }
              request.status = "answered";
              request.answeredBy = access.actorId;
              request.answeredAt = now;
              // The person said what to try next: the attempts start over.
              if (request.escalation) issue.attempts = 0;
            }
            emit("request", entityId, request, mutation.kind);
            settle(issue);
            break;
          }
          case "issue.offer":
          case "issue.withdraw": {
            keys(
              data,
              mutation.kind === "issue.offer"
                ? ["leaseToken", "toActorId", "ttlSeconds"]
                : ["leaseToken"],
            );
            const issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            lease(issue, data.leaseToken);
            if (mutation.kind === "issue.withdraw") dropOffer(issue);
            else {
              const ttl = data.ttlSeconds === undefined ? 600 : data.ttlSeconds;
              if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 3600)
                fail("invalid_input", "An offer lasts 30 to 3600 seconds.");
              // To a member or a member's agent; anyone with the code when unset.
              const to = data.toActorId === undefined ? null : id(data.toActorId);
              if (to) answerable(to);
              const random = () => crypto.randomUUID().replaceAll("-", "");
              const code = `${issue.key}.${random()}${random()}`;
              const expiresAt = new Date(Date.parse(now) + Number(ttl) * 1000).toISOString();
              const values = {
                issue_id: issue.id,
                code,
                lease_token: String(data.leaseToken),
                to_actor: to,
                expires_at: expiresAt,
              };
              run(
                this.sql,
                tracker
                  .insertInto("offers")
                  .values(values)
                  .onConflict((oc) => oc.column("issue_id").doUpdateSet(values)),
              );
              issue.handoff = { to, expiresAt };
              result = { id: entityId, offerCode: code, expiresAt };
            }
            issue.version++;
            issue.updatedAt = now;
            emit("issue", entityId, issue, mutation.kind);
            break;
          }
          case "issue.accept": {
            keys(data, ["code", "agent", "ttlSeconds"]);
            const issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
            if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
              fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
            const code = text(data.code, "code", 300);
            const offer = first(
              this.sql,
              tracker.selectFrom("offers").selectAll().where("issue_id", "=", issue.id),
            );
            const current = first(
              this.sql,
              tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
            );
            // The offer only stands while the lease it was made under does.
            if (
              !offer ||
              !same(offer.code, code) ||
              offer.expires_at <= now ||
              !current ||
              !same(current.token, offer.lease_token) ||
              !hasActiveClaim(issue, now) ||
              (offer.to_actor !== null && offer.to_actor !== access.actorId)
            )
              fail(
                "offer_invalid",
                "That handoff code is expired, used, withdrawn, or for someone else.",
                409,
              );
            const previous = issue.claim!;
            result = {
              id: entityId,
              ...grant(
                issue,
                data.agent === undefined ? previous.agent : text(data.agent, "agent", 200),
                Number(ttl),
                undefined,
                { actorId: access.actorId, accountableId: access.principalId },
                previous.delegatedFrom ? this.get<Issue>("issue", previous.delegatedFrom) : null,
              ),
            };
            dropOffer(issue);
            issue.version++;
            issue.updatedAt = now;
            emit("issue", entityId, issue, "issue.accept");
            break;
          }
          case "issue.resume": {
            keys(data, ["ttlSeconds"]);
            const issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
            if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
              fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
            if (!issue.claim || issue.claim.actorId !== access.actorId)
              fail("not_holder", `Only ${issue.key}'s lease holder can resume it.`, 409);
            if (issue.waiting) fail("waiting", `${issue.key} still has open requests.`, 409);
            const claim = issue.claim;
            dropOffer(issue);
            result = {
              id: entityId,
              ...grant(
                issue,
                claim.agent,
                Number(ttl),
                undefined,
                {
                  actorId: claim.actorId,
                  accountableId: claim.accountableId ?? access.principalId,
                },
                claim.delegatedFrom ? this.get<Issue>("issue", claim.delegatedFrom) : null,
              ),
            };
            issue.version++;
            issue.updatedAt = now;
            emit("issue", entityId, issue, "issue.resume");
            break;
          }
          case "issue.revoke": {
            keys(data, ["underToken"]);
            const issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            if (!issue.claim || !hasActiveClaim(issue, now))
              fail("not_claimed", `${issue.key} has no active claim to revoke.`, 409);
            const token = text(data.underToken, "underToken", 200);
            // Any lease above the issue may take it back, not just the nearest.
            if (!leasedAbove(issue).some((above) => holds(above, token)))
              fail(
                "lease_lost",
                `Only the holder of a lease above ${issue.key} can revoke its claim.`,
                409,
              );
            issue.claim = null;
            issue.status = "todo";
            run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
            dropOffer(issue);
            issue.version++;
            issue.updatedAt = now;
            emit("issue", entityId, issue, "issue.revoke");
            break;
          }
          case "issue.claim":
          case "issue.renew":
          case "issue.release":
          case "issue.complete": {
            const kind = mutation.kind;
            keys(
              data,
              kind === "issue.claim"
                ? ["agent", "ttlSeconds", "underToken", "forActorId"]
                : kind === "issue.renew"
                  ? ["leaseToken", "ttlSeconds"]
                  : kind === "issue.complete"
                    ? ["leaseToken", "evidence"]
                    : ["leaseToken"],
            );
            const issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            let delegator: Issue | null = null;
            if (kind === "issue.claim" || kind === "issue.renew") {
              const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
              if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
                fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
              if (kind === "issue.claim") {
                if (hasActiveClaim(issue, now))
                  fail("claim_busy", "Issue already has an active claim.", 409);
                if (issue.waiting)
                  fail(
                    "waiting",
                    `${issue.key} is waiting on a person; answer its requests first.`,
                    409,
                  );
                if (
                  issue.status !== "todo" &&
                  !(issue.status === "in_progress" && issue.claim && !hasActiveClaim(issue, now))
                )
                  fail("not_ready", "Only todo or expired claimed work may be claimed.", 409);
                unblocked(issue);
                delegator = claimable(issue, data.underToken);
                if (!delegator && data.forActorId !== undefined)
                  fail(
                    "invalid_input",
                    "forActorId delegates inside your leased subtree; pass that lease's underToken.",
                  );
              } else lease(issue, data.leaseToken);
              result = {
                id: entityId,
                ...grant(
                  issue,
                  kind === "issue.claim" ? text(data.agent, "agent", 200) : issue.claim!.agent,
                  Number(ttl),
                  kind === "issue.claim" ? undefined : String(data.leaseToken),
                  kind === "issue.claim"
                    ? holderFor(data.forActorId)
                    : {
                        actorId: issue.claim!.actorId,
                        accountableId: issue.claim!.accountableId ?? access.principalId,
                      },
                  kind === "issue.claim"
                    ? delegator
                    : issue.claim?.delegatedFrom
                      ? this.get<Issue>("issue", issue.claim.delegatedFrom)
                      : null,
                ),
              };
            } else {
              lease(issue, data.leaseToken);
              if (kind === "issue.complete") {
                unblocked(issue);
                childrenClosed(issue);
                const body = text(data.evidence, "evidence", 131072);
                const commentId = crypto.randomUUID();
                emit(
                  "comment",
                  commentId,
                  {
                    id: commentId,
                    issueId: entityId,
                    body,
                    kind: "evidence",
                    actorId: access.actorId,
                    createdAt: now,
                  },
                  "comment.add",
                );
              }
              const released = issue.claim!;
              issue.status = kind === "issue.complete" ? "done" : "todo";
              issue.claim = null;
              run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
              dropOffer(issue);
              if (kind === "issue.release") failedAttempt(issue, released);
            }
            issue.version++;
            issue.updatedAt = now;
            emit("issue", entityId, issue, kind);
            break;
          }
          default:
            fail("invalid_input", "Unknown mutation kind.");
        }
        results.push(result);
      }
      // Later mutations must not invalidate work started/completed earlier in the batch.
      for (const event of events) {
        if (event.kind === "issue.claim" || event.kind === "issue.complete")
          started.add(event.entityId);
      }
      for (const issueId of started) {
        const issue = this.get<Issue>("issue", issueId);
        if (issue.status === "in_progress" || issue.status === "done") unblocked(issue);
        if (issue.status === "done") childrenClosed(issue);
      }
      const result: MutationResult = { cursor: this.cursor(), events, results, serverTime: now };
      run(
        this.sql,
        tracker.insertInto("receipts").values({
          id: request.operationId,
          actor_id: access.actorId,
          request: encoded,
          result: JSON.stringify(result),
        }),
      );
      return result;
    });
  }
}
