// Approve when green (CORE-378): whose requests it may answer. Only those
// asked by the routed person or by one of their own agents that hasn't been
// revoked; and who asked is looked up in D1 a bounded number of ids at a time.

import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { autoApprovable, type HumanRequest, type Mutation } from "../../shared/tracker.ts";
import { issueToken } from "../api/tokens.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { ownedCheckpointRepo, ownedTimeline } from "../testing/timeline-source.ts";
import { freshTrackerStorage } from "../testing/tracker.ts";
import { agentsAmong, LOOKUP_CHUNK } from "./access.ts";
import { TrackerStore, type Access } from "./store.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");

/** Ben, his agent bot, an approval timeline at checkpoint #1, and approve-when-green on. */
async function setup() {
  const grant = {
    role: "admin" as const,
    repositoryRole: "write" as const,
    packageRole: "none" as const,
  };
  const { sql, transactionSync, close, scope, space, env } = await freshTrackerStorage("org", [
    { accountId: "ann", role: "member" as const, grant },
    { accountId: "ben", role: "member" as const, grant },
  ]);
  onTestFinished(close);
  await env.DB.prepare(
    "INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ben')",
  ).run();
  const credentials = new Map<string, Access["credential"]>();
  for (const [actor, person] of [
    ["ann", "ann"],
    ["ben", "ben"],
    ["agt_bot", "ben"],
  ] as const) {
    const token = await issueToken(
      env.DB,
      person,
      actor,
      "write",
      undefined,
      actor === person ? undefined : actor,
    );
    credentials.set(actor, { kind: "token", id: token.id });
  }
  let now = Date.parse("2026-10-03T00:00:00Z");
  const tracker = new TrackerStore(sql, transactionSync, () => (now += 1000));
  const people = [
    { id: "ann", slug: "ann", displayName: "Ann" },
    { id: "ben", slug: "ben", displayName: "Ben" },
  ];
  const bot = {
    id: "agt_bot",
    name: "bot",
    accountable: people[1]!,
    capabilities: null,
    capabilitiesUpdatedAt: null,
    revokedAt: null as string | null,
  };
  const agents = [bot];
  const as = (actorId: string, principalId = actorId): Access => ({
    actorId,
    principalId,
    agentId: actorId === principalId ? null : actorId,
    credential: credentials.get(actorId),
    agents,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: actorId === "ann",
    members: people,
    repos: [],
    writableRepoIds: ["app"],
  });
  let operation = 0;
  const mutate = (access: Access, ...mutations: Mutation[]) =>
    tracker.mutate(access, {
      contractVersion: 4,
      spaceId: access.spaceId,
      migrationEpoch: access.migrationEpoch,
      operationId: `op-${++operation}`,
      mutations,
    });
  mutate(as("ann"), { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } });
  mutate(as("ben"), { kind: "issue.create", id: "issue", data: { teamId: "team", title: "S" } });
  const timeline = ownedTimeline(tracker.timelines, as("agt_bot", "ben"), {
    slug: "search",
    parent: null,
    policy: "approval",
    repos: [{ id: "app", space: "org", name: "app" }],
    commits: { app: oid(1) },
  });
  tracker.timelines.finishSourcePush(
    tracker.timelines.beginSourcePush({
      authority: {
        spaceId: "org",
        migrationEpoch: scope.migrationEpoch,
        personId: "ben",
        agentId: "agt_bot",
        credential: credentials.get("agt_bot")!,
      },
      operationId: "push",
      timelineId: timeline.id,
      repoId: "app",
      sourceId: timeline.repos[0]!.source!.sourceId,
      commands: [{ ref: "refs/heads/work", old: oid(1), new: oid(2) }],
      actorId: "agt_bot",
      accountableId: "ben",
    }).operationId,
    "accepted",
  );
  const { checkpoint } = tracker.timelines.createCheckpoint(as("agt_bot", "ben"), "search", {
    summary: "Ready",
    repos: [
      ownedCheckpointRepo(tracker.timelines, "search", {
        id: "app",
        space: "org",
        name: "app",
        commit: oid(2),
        base: oid(1),
        changes: [{ changeId: "c2", commit: oid(2) }],
      }),
    ],
  });
  mutate(as("ben"), { kind: "automation.approveWhenGreen", id: "ben", data: { enabled: true } });
  const ask = (access: Access, id: string) =>
    mutate(access, {
      kind: "request.open",
      id,
      data: { issueId: "issue", kind: "approval", prompt: "Land?", checkpoint: checkpoint.id },
    });
  const request = (id: string) =>
    tracker.snapshot(as("ben")).requests.find((r) => r.id === id) as HumanRequest;
  return { tracker, bot, as, ask, request, checkpoint };
}

describe("a revoked agent's approval request", () => {
  test("isn't approved by approve-when-green; Ben's own still is", async () => {
    const t = await setup();
    t.ask(t.as("agt_bot", "ben"), "from-bot");
    t.ask(t.as("ben"), "from-ben");
    // Ben revokes the bot while its request waits.
    t.bot.revokedAt = "2026-10-03T01:00:00Z";
    expect(autoApprovable(t.request("from-bot"), [t.bot])).toBe(false);
    expect(t.tracker.autoApprove(t.as("ben"), "from-bot", t.checkpoint.id)).toBeNull();
    expect(t.tracker.noteAutoApproveSkipped(t.as("ben"), "from-bot", t.checkpoint.id, "x")).toBe(
      false,
    );
    expect(t.request("from-bot").status).toBe("open");
    expect(t.tracker.autoApprove(t.as("ben"), "from-ben", t.checkpoint.id)).not.toBeNull();
    expect(t.request("from-ben")).toMatchObject({ status: "answered", via: "auto-approve" });
  });

  test("gets no Needs you hint: D1 says it was revoked", async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ben', 'user', 'ben', 'Ben');
      INSERT INTO agents (id, name, accountable_id, revoked_at) VALUES
        ('agt_bot', 'bot', 'ben', '2026-10-03T01:00:00Z'), ('agt_live', 'live', 'ben', NULL);`);
    const agents = await agentsAmong(d1(sqlite), ["agt_bot", "agt_live", "ben"]);
    expect(agents).toEqual(
      expect.arrayContaining([
        { id: "agt_bot", accountable: { id: "ben" }, revokedAt: "2026-10-03T01:00:00Z" },
        { id: "agt_live", accountable: { id: "ben" }, revokedAt: null },
      ]),
    );
    expect(agents).toHaveLength(2);
    const asked = (askedBy: string) => ({
      kind: "approval" as const,
      checkpoint: { id: "cp", number: 1, timelineId: "tl", timeline: "search" },
      askedBy,
      routeTo: "ben",
    });
    expect(autoApprovable(asked("agt_bot"), agents)).toBe(false);
    expect(autoApprovable(asked("agt_live"), agents)).toBe(true);
    expect(autoApprovable(asked("ben"), agents)).toBe(true);
  });
});

describe("who asked, looked up in D1", () => {
  test("more than 100 askers: every agent found, at most LOOKUP_CHUNK ids per query", async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(
      `INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ben', 'user', 'ben', 'Ben')`,
    );
    const ids = Array.from({ length: 130 }, (_, i) => `agt_${i}`);
    const insert = sqlite.prepare(
      "INSERT INTO agents (id, name, accountable_id) VALUES (?, ?, 'ben')",
    );
    for (const id of ids) insert.run(id, id);
    const base = d1(sqlite);
    const bound: number[] = [];
    // D1 that counts each statement's bound parameters.
    const counted = {
      prepare: (query: string) => ({
        bind: (...params: unknown[]) => {
          bound.push(params.length);
          return base.prepare(query).bind(...params);
        },
      }),
    } as unknown as D1Database;
    // People and repeats among them: only agents come back, once each.
    const found = await agentsAmong(counted, [...ids, ...ids.slice(0, 10), "ben", "ann"]);
    expect(found.map((agent) => agent.id).sort()).toEqual([...ids].sort());
    expect(bound.length).toBe(3);
    expect(Math.max(...bound)).toBeLessThanOrEqual(LOOKUP_CHUNK);
    expect(await agentsAmong(counted, [])).toEqual([]);
    expect(bound.length).toBe(3);
  });
});
