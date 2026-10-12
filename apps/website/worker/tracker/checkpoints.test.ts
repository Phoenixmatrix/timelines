// Checkpoints and the approvals pinned to them (CORE-76), in the tracker's
// storage: immutable records, approval requests that pin the head checkpoint,
// and approvals that stop counting once the timeline moves past it.

import { describe, expect, test } from "vite-plus/test";
import type { HumanRequest, Mutation } from "../../shared/tracker.ts";
import type { CheckpointRepo } from "../../shared/timelines.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore, type Access } from "./store.ts";
import { ownedTimeline, ownedCheckpointRepo } from "../testing/timeline-source.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");

function setup(options: { policy?: "auto" | "approval" } = {}) {
  const { sql, transactionSync } = durableStorage();
  let now = Date.parse("2026-10-03T00:00:00Z");
  const clock = () => (now += 1000);
  const tracker = new TrackerStore(sql, transactionSync, clock);
  // The tracker's own: it withdraws superseded approvals, as in the Durable Object.
  const timelines = tracker.timelines;
  const people = [
    { id: "ann", slug: "ann", displayName: "Ann" },
    { id: "ben", slug: "ben", displayName: "Ben" },
  ];
  const agents = [
    {
      id: "agt_bot",
      name: "bot",
      accountable: people[1]!,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    },
    {
      id: "agt_annbot",
      name: "annbot",
      accountable: people[0]!,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    },
  ];
  const as = (actorId: string, principalId = actorId, writable = ["app"]): Access => ({
    actorId,
    principalId,
    agents,
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: actorId === "ann",
    members: people,
    repos: [],
    writableRepoIds: writable,
  });
  const ben = as("ben");
  const bot = as("agt_bot", "ben");
  let operation = 0;
  const mutate = (access: Access, ...mutations: Mutation[]) =>
    tracker.mutate(access, { operationId: `op-${++operation}`, mutations });
  mutate(as("ann"), {
    kind: "team.create",
    id: "team",
    data: { key: "ENG", name: "Engineering" },
  });
  mutate(ben, { kind: "issue.create", id: "issue", data: { teamId: "team", title: "Search" } });
  const timeline = ownedTimeline(timelines, bot, {
    slug: "search",
    parent: null,
    ...(options.policy ? { policy: options.policy } : {}),
    repos: [{ id: "app", owner: "org", name: "app" }],
    commits: { app: oid(1) },
  });
  const repo = (commit: number, base = 1): CheckpointRepo =>
    ownedCheckpointRepo(timelines, "search", {
      id: "app",
      owner: "org",
      name: "app",
      commit: oid(commit),
      base: oid(base),
      changes: [{ changeId: `change${commit}`, commit: oid(commit) }],
    });
  const checkpoint = (commit: number, summary = `work up to ${commit}`) =>
    timelines.createCheckpoint(bot, "search", { summary, repos: [repo(commit)] });
  let tip = oid(1);
  const admit = (commit: number) => {
    const operationId = `push-${++operation}`;
    timelines.beginSourcePush({
      operationId,
      timelineId: timeline.id,
      repoId: "app",
      sourceId: timeline.repos[0]!.source!.sourceId,
      commands: [{ ref: "refs/heads/work", old: tip, new: oid(commit) }],
      actorId: "agt_bot",
      accountableId: "ben",
    });
    return operationId;
  };
  const push = (commit: number) => {
    timelines.finishSourcePush(admit(commit), "accepted");
    tip = oid(commit);
  };
  const ask = (checkpointId: string, access = bot, leaseToken?: string) => {
    const id = `req-${++operation}`;
    mutate(access, {
      kind: "request.open",
      id,
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Ship it?",
        checkpoint: checkpointId,
        ...(leaseToken ? { leaseToken } : {}),
      },
    });
    return id;
  };
  const claim = () =>
    mutate(bot, { kind: "issue.claim", id: "issue", data: { agent: "session" } }).results[0]!
      .leaseToken as string;
  const issue = () => tracker.snapshot(ben).issues.find((i) => i.id === "issue")!;
  const answer = (access: Access, id: string, approved: boolean, answer?: string) =>
    mutate(access, {
      kind: "request.answer",
      id,
      data: { approved, ...(answer ? { answer } : {}) },
    });
  const request = (id: string) =>
    tracker.snapshot(ben).requests.find((r) => r.id === id) as HumanRequest;
  const approveWhenGreen = (access: Access, enabled: boolean, person = access.principalId) =>
    mutate(access, { kind: "automation.approveWhenGreen", id: person, data: { enabled } });
  return {
    sql,
    approveWhenGreen,
    tracker,
    timelines,
    as,
    ben,
    bot,
    repo,
    checkpoint,
    push,
    admit,
    ask,
    answer,
    request,
    claim,
    issue,
  };
}

describe("checkpoints", () => {
  test("record the commits, base, changes and summary, numbered, with an event", () => {
    const t = setup();
    expect(() => t.checkpoint(1)).toThrow(/no commits since it forked/);
    t.push(2);
    const first = t.checkpoint(2);
    expect(first).toMatchObject({
      checkpoint: {
        number: 1,
        summary: "work up to 2",
        repos: [{ id: "app", commit: oid(2), base: oid(1), changes: [{ changeId: "change2" }] }],
        actorId: "agt_bot",
        accountableId: "ben",
      },
      current: true,
      approval: null,
      approved: false,
    });
    expect(first.checkpoint.id).toMatch(/^cp_/);
    t.push(3);
    const second = t.checkpoint(3);
    expect(second.checkpoint.number).toBe(2);

    // Newest first; the first is no longer the head, and never changed.
    const listed = t.timelines.checkpoints("search");
    expect(listed.map((s) => [s.checkpoint.number, s.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(listed[1]!.checkpoint).toEqual(first.checkpoint);
    expect(t.timelines.checkpoint("search", "1").checkpoint).toEqual(first.checkpoint);
    expect(t.timelines.checkpoint("search", first.checkpoint.id).checkpoint.number).toBe(1);
    expect(() => t.timelines.checkpoint("search", "9")).toThrow(/no checkpoint 9/);

    const events = t.timelines
      .detail("search", 0, 50)
      .events.filter((e) => e.kind === "checkpoint");
    expect(events).toMatchObject([
      { checkpointId: first.checkpoint.id, number: 1, commits: { app: oid(2) } },
      { checkpointId: second.checkpoint.id, number: 2, summary: "work up to 3" },
    ]);
  });

  test("a migrated source needs a fresh checkpoint even when its commit is unchanged", () => {
    const t = setup();
    t.push(2);
    const first = t.checkpoint(2).checkpoint;
    const legacy = {
      ...first,
      repos: first.repos.map((repo) => ({
        ...repo,
        source: {
          ...repo.source!,
          sourceId: "canonical",
          kind: "canonical",
          timelineId: null,
          ref: "refs/heads/timeline/search",
        },
      })),
    };
    // Persisted pre-cutover checkpoint; the active timeline now owns its work source.
    t.sql.exec(
      "UPDATE timeline_checkpoints SET data = ? WHERE id = ?",
      JSON.stringify(legacy),
      first.id,
    );
    const renewed = t.checkpoint(2);
    expect(renewed.checkpoint.id).not.toBe(first.id);
    expect(renewed.checkpoint.number).toBe(2);
    expect(renewed.checkpoint.repos[0]?.source).toEqual(first.repos[0]?.source);
    expect(renewed.current).toBe(true);
    expect(t.timelines.checkpoint("search", first.id).checkpoint).toEqual(legacy);
    expect(() => t.checkpoint(2)).toThrow(
      expect.objectContaining({ code: "unchanged", status: 409 }),
    );
  });

  test("cover exactly the timeline's repositories, and not an ended timeline", () => {
    const t = setup();
    t.push(2);
    expect(() =>
      t.timelines.createCheckpoint(t.bot, "search", {
        repos: [t.repo(2), { ...t.repo(2), id: "lib" }],
      }),
    ).toThrow(expect.objectContaining({ code: "timeline_changed", status: 409 }));
    expect(() =>
      t.timelines.createCheckpoint(t.bot, "search", {
        repos: [{ ...t.repo(2), commit: "abc", source: { ...t.repo(2).source!, commit: "abc" } }],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    t.timelines.abandon(t.ben, "search", { app: oid(2) });
    expect(() => t.checkpoint(2)).toThrow(
      expect.objectContaining({ code: "timeline_ended", status: 409 }),
    );
  });
});

describe("approvals pinned to a checkpoint", () => {
  test("asking makes the timeline wait; a person with write access approves the head", () => {
    const t = setup();
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    expect(t.request(id).checkpoint).toEqual({
      id: checkpoint.id,
      number: 1,
      timelineId: checkpoint.timelineId,
      timeline: "search",
    });
    expect(t.timelines.get("search").status).toBe("waiting");
    expect(t.timelines.checkpoint("search", "1").approval).toMatchObject({
      requestId: id,
      state: "pending",
    });

    // Agents never approve; people need write access to every repository.
    expect(() => t.answer(t.bot, id, true)).toThrow(/Agents can't answer/);
    expect(() => t.answer(t.as("ann", "ann", []), id, true)).toThrow(/write access to org\/app/);
    t.answer(t.as("ann"), id, true, "looks good");

    expect(t.request(id)).toMatchObject({ status: "answered", answer: "approved · looks good" });
    expect(t.timelines.get("search").status).toBe("active");
    expect(t.timelines.checkpoint("search", "1")).toMatchObject({
      current: true,
      approved: true,
      approval: { requestId: id, state: "approved", by: "ann", note: "looks good" },
    });
    expect(t.timelines.detail("search", 0, 50).events.at(-1)).toMatchObject({
      kind: "approval",
      checkpointId: checkpoint.id,
      number: 1,
      requestId: id,
      outcome: "approved",
      note: "looks good",
      actorId: "ann",
    });
  });

  test("new commits invalidate an approval: it needs a new checkpoint and a new approval", () => {
    const t = setup();
    t.push(2);
    const first = t.checkpoint(2).checkpoint;
    t.answer(t.ben, t.ask(first.id), true);
    expect(t.timelines.checkpoint("search", "1").approved).toBe(true);

    // A push the push log records after the checkpoint at the same commit changes nothing.
    t.push(2);
    expect(t.timelines.checkpoint("search", "1").approved).toBe(true);

    t.push(3);
    expect(t.timelines.checkpoint("search", "1")).toMatchObject({
      current: false,
      approved: false,
      approval: { state: "approved" },
    });
    // The old checkpoint can't be asked about again.
    expect(() => t.ask(first.id)).toThrow(/isn't its head any more/);

    const second = t.checkpoint(3).checkpoint;
    const again = t.ask(second.id);
    expect(t.timelines.checkpoint("search", "2").approved).toBe(false);
    t.answer(t.ben, again, true);
    expect(t.timelines.checkpoint("search", "2").approved).toBe(true);
  });

  test.each(["logicalBase", "dependencies"] as const)(
    "renewing %s at the same work OID requires a fresh review",
    (field) => {
      const t = setup();
      t.push(2);
      const original = t.checkpoint(2).checkpoint;
      const requestId = t.ask(original.id);
      if (field === "logicalBase") t.answer(t.ben, requestId, true);
      const measured = t.repo(2);
      const foreign = {
        ...measured.logicalBase!,
        kind: "timeline-work" as const,
        sourceId: "work_parent",
        timelineId: "parent",
        ref: "refs/heads/work",
        commit: oid(10),
        tree: oid(11),
      };
      if (field === "logicalBase")
        measured.logicalBase = { ...measured.logicalBase!, commit: oid(10), tree: oid(11) };
      else measured.dependencies = [{ source: foreign, base: measured.logicalBase! }];
      const renewed = t.timelines.createCheckpoint(t.bot, "search", {
        summary: "Review the new dependency proof",
        repos: [measured],
      });
      expect(renewed).toMatchObject({ current: true, approved: false });
      expect(renewed.checkpoint.number).toBe(original.number + 1);
      expect(renewed.checkpoint.repos[0]?.commit).toBe(original.repos[0]?.commit);
      expect(t.timelines.checkpoint("search", original.id)).toMatchObject({
        current: false,
        approved: false,
      });
      expect(t.request(requestId).status).toBe(field === "logicalBase" ? "answered" : "canceled");
      expect(() =>
        t.timelines.createCheckpoint(t.bot, "search", {
          summary: "Same proof again",
          repos: [measured],
        }),
      ).toThrow(expect.objectContaining({ code: "unchanged" }));
    },
  );

  test("an admitted source write fences approval before provider completion", () => {
    const t = setup();
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const requestId = t.ask(checkpoint.id);
    const operation = t.admit(3);
    expect(t.timelines.checkpoint("search", checkpoint.id).current).toBe(false);
    expect(t.request(requestId).status).toBe("canceled");
    expect(() => t.answer(t.ben, requestId, true)).toThrow();
    t.timelines.finishSourcePush(operation, "rejected");
    expect(t.timelines.checkpoint("search", checkpoint.id)).toMatchObject({
      current: true,
      approved: false,
    });
  });

  test("a push past the checkpoint withdraws its open request and unparks the lease", () => {
    const t = setup();
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const token = t.claim();
    const id = t.ask(checkpoint.id, t.bot, token);
    expect(t.issue().claim?.parkedAt).toBeTruthy();
    expect(t.timelines.get("search").status).toBe("waiting");

    t.push(3);
    expect(t.request(id)).toMatchObject({
      status: "canceled",
    });
    expect(t.issue()).toMatchObject({ waiting: 0 });
    expect(t.issue().claim?.parkedAt).toBeUndefined();
    expect(t.timelines.get("search").status).toBe("active");
    expect(t.timelines.checkpoint("search", "1").approval).toMatchObject({
      requestId: id,
      state: "superseded",
      by: "agt_bot",
    });
    expect(t.timelines.detail("search", 0, 50).events.at(-1)).toMatchObject({
      kind: "approval",
      requestId: id,
      outcome: "superseded",
      actorId: "agt_bot",
    });
    // It's closed: nobody answers it now.
    expect(() => t.answer(t.ben, id, true)).toThrow(/already canceled/);
  });

  test("answered requests stay as they were when the timeline moves on", () => {
    const t = setup();
    t.push(2);
    const first = t.checkpoint(2).checkpoint;
    const approved = t.ask(first.id);
    t.answer(t.ben, approved, true);
    t.push(3);
    const second = t.checkpoint(3).checkpoint;
    const rejected = t.ask(second.id);
    t.answer(t.ben, rejected, false, "not yet");
    t.push(4);
    expect(t.request(approved)).toMatchObject({ status: "answered", answer: "approved" });
    expect(t.request(rejected)).toMatchObject({
      status: "answered",
      answer: "rejected · not yet",
    });
    const outcomes = t.timelines
      .detail("search", 0, 50)
      .events.flatMap((e) => (e.kind === "approval" ? [[e.requestId, e.outcome]] : []));
    expect(outcomes).toEqual([
      [approved, "approved"],
      [rejected, "rejected"],
    ]);
  });

  test("a new checkpoint supersedes an open request; withdrawing ends the wait too", () => {
    const t = setup();
    t.push(2);
    const first = t.checkpoint(2).checkpoint;
    const old = t.ask(first.id);
    // Checkpoint #2 measured commits the push log hasn't recorded yet.
    const second = t.checkpoint(3).checkpoint;
    expect(t.request(old)).toMatchObject({
      status: "canceled",
      answer: "Superseded by checkpoint #2 on timeline/search; ask about that one instead.",
    });
    expect(t.timelines.get("search").status).toBe("active");
    const id = t.ask(second.id);
    expect(t.timelines.get("search").status).toBe("waiting");
    t.tracker.mutate(t.bot, {
      operationId: "withdraw",
      mutations: [{ kind: "request.cancel", id }],
    });
    expect(t.timelines.get("search").status).toBe("active");
    expect(t.timelines.checkpoint("search", "2").approval).toBeNull();
  });

  test("only approvals pin checkpoints, and only checkpoints that exist", () => {
    const t = setup();
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    expect(() =>
      t.tracker.mutate(t.bot, {
        operationId: "question",
        mutations: [
          {
            kind: "request.open",
            id: "q",
            data: { issueId: "issue", kind: "question", prompt: "?", checkpoint: checkpoint.id },
          },
        ],
      }),
    ).toThrow(/Only approval requests name a checkpoint/);
    expect(() => t.ask("cp_missing")).toThrow(/No checkpoint cp_missing/);
  });
});

test("a client can't pre-claim the withdrawal of a superseded approval", () => {
  const t = setup();
  t.push(2);
  const first = t.checkpoint(2).checkpoint;
  const id = t.ask(first.id);
  // An agent uses the withdrawal's old operation id first.
  t.tracker.mutate(t.bot, {
    operationId: `superseded:${id}`,
    mutations: [{ kind: "comment.add", id: "squat", data: { issueId: "issue", body: "mine" } }],
  });
  expect(() =>
    t.tracker.mutate(t.bot, {
      operationId: `@superseded:${id}`,
      mutations: [{ kind: "comment.add", id: "squat2", data: { issueId: "issue", body: "x" } }],
    }),
  ).toThrow(/IDs must use letters/);
  // New commits still withdraw it, under the reserved spelling.
  t.push(3);
  expect(t.request(id)).toMatchObject({ status: "canceled" });
  const withdrawn = t.tracker
    .history(t.ben, "issue", null, 50)
    .events.find((event) => event.kind === "request.cancel" && event.entityId === id);
  expect(withdrawn).toMatchObject({ operationId: `@superseded:${id}` });
  // Again: nothing open to withdraw, so nothing happens.
  t.push(3);
  expect(t.request(id)).toMatchObject({ status: "canceled" });
});

describe("approve when green (CORE-378)", () => {
  test("only the person turns their own setting on or off, and each change is in the log", () => {
    const t = setup({ policy: "approval" });
    // Not an agent for its person, not an owner for someone else.
    expect(() => t.approveWhenGreen(t.bot, true)).toThrow(/Agents can't do that/);
    expect(() => t.approveWhenGreen(t.as("ann"), true, "ben")).toThrow(/you can only change yours/);
    expect(t.tracker.snapshot(t.ben).approveWhenGreen).toEqual([]);

    const on = t.approveWhenGreen(t.ben, true);
    expect(on.events).toMatchObject([
      {
        kind: "automation.approveWhenGreen",
        entityType: "automation",
        entityId: "ben",
        actorId: "ben",
        actor: { kind: "person" },
        before: { id: "ben", approveWhenGreen: false, enabledAt: null },
        entity: { id: "ben", approveWhenGreen: true, enabledAt: expect.any(String) },
      },
    ]);
    const since = (on.events[0]!.entity as { enabledAt: string }).enabledAt;
    expect(t.tracker.snapshot(t.as("ann")).approveWhenGreen).toEqual(["ben"]);
    // Again keeps when it was first turned on.
    expect(t.approveWhenGreen(t.ben, true).events[0]!.entity).toMatchObject({ enabledAt: since });
    const off = t.approveWhenGreen(t.ben, false);
    expect(off.events[0]).toMatchObject({
      before: { approveWhenGreen: true, enabledAt: since },
      entity: { approveWhenGreen: false, enabledAt: null },
    });
    expect(t.tracker.snapshot(t.ben).approveWhenGreen).toEqual([]);
    expect(() =>
      t.tracker.mutate(t.ben, {
        operationId: "bad",
        mutations: [
          { kind: "automation.approveWhenGreen", id: "ben", data: { enabled: "yes" as never } },
        ],
      }),
    ).toThrow(/enabled must be true or false/);
  });

  test("approves the pinned head for its routed person, marked, as them", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    const auto = (access = t.as("ben")) => t.tracker.autoApprove(access, id, checkpoint.id);

    // Off: nothing happens.
    expect(auto()).toBeNull();
    expect(t.request(id).status).toBe("open");

    t.approveWhenGreen(t.ben, true);
    // Never as the asking agent, and never for someone it isn't routed to.
    expect(auto(t.bot)).toBeNull();
    expect(auto(t.as("ann"))).toBeNull();
    expect(t.tracker.autoApprove(t.as("ben"), id, "cp_other")).toBeNull();

    const result = auto()!;
    expect(result.events[0]).toMatchObject({
      kind: "request.answer",
      operationId: `@auto-approve:${id}`,
      actorId: "ben",
      source: "automation",
    });
    expect(t.request(id)).toMatchObject({
      status: "answered",
      answeredBy: "ben",
      via: "auto-approve",
      answer: "approved · Checkpoint #1's CI is green.",
    });
    expect(t.timelines.checkpoint("search", "1")).toMatchObject({
      approved: true,
      approval: { requestId: id, state: "approved", by: "ben", via: "auto-approve" },
    });
    expect(t.timelines.detail("search", 0, 50).events.at(-1)).toMatchObject({
      kind: "approval",
      outcome: "approved",
      via: "auto-approve",
      actorId: "ben",
      accountableId: "ben",
    });
    // Answered once: a second run ending finds nothing open.
    expect(auto()).toBeNull();
  });

  test("a hand answer never carries the marker, even when the setting is on", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    // No client can claim the marker.
    expect(() =>
      t.tracker.mutate(t.ben, {
        operationId: "claimed",
        mutations: [
          {
            kind: "request.answer",
            id,
            data: { approved: true, via: "auto-approve" } as never,
          },
        ],
      }),
    ).toThrow(/via/);
    t.answer(t.ben, id, true);
    expect(t.request(id).via).toBeUndefined();
    expect(t.timelines.checkpoint("search", "1").approval?.via).toBeUndefined();
  });

  test("turning it off before CI completes means no approval", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    t.approveWhenGreen(t.ben, false);
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)).toBeNull();
    expect(t.request(id).status).toBe("open");
    expect(t.timelines.checkpoint("search", "1").approved).toBe(false);
  });

  test("a stale checkpoint is never approved", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    // Admitted but unsettled source write: the head is fenced.
    const operation = t.admit(3);
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)).toBeNull();
    expect(t.timelines.checkpoint("search", "1").approved).toBe(false);
    // Once the push lands, the request is withdrawn: still nothing to approve.
    t.timelines.finishSourcePush(operation, "accepted");
    expect(t.request(id).status).toBe("canceled");
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)).toBeNull();
  });

  test("why it was left to its person is noted once per reason, only for that person", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    const why = "Changes CI configuration (.gitmatrix/ci.yml in org/app): approve it yourself.";
    const note = (access: Access, reason = why) =>
      t.tracker.noteAutoApproveSkipped(access, id, checkpoint.id, reason);
    expect(note(t.bot)).toBe(false);
    expect(note(t.as("ann"))).toBe(false);
    expect(t.tracker.noteAutoApproveSkipped(t.as("ben"), id, "cp_other", why)).toBe(false);
    expect(note(t.as("ben"))).toBe(true);
    expect(t.request(id)).toMatchObject({
      status: "open",
      autoApproveSkipped: { checkpointId: checkpoint.id, reason: why },
    });
    expect(note(t.as("ben"))).toBe(false);
    const history = t.tracker.history(t.ben, "issue", null, 50).events;
    expect(history.filter((event) => event.kind === "request.autoApproveSkipped")).toMatchObject([
      { actorId: "ben", source: "automation", entityId: id },
    ]);
    // Answered by hand: nothing more to note.
    t.answer(t.ben, id, true);
    expect(note(t.as("ben"), "Something else.")).toBe(false);
  });

  test("only what the person or one of their own agents asked", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    t.approveWhenGreen(t.ben, true);
    const askAs = (access: Access, id: string) =>
      t.tracker.mutate(access, {
        operationId: `ask-${id}`,
        mutations: [
          {
            kind: "request.open",
            id,
            data: {
              issueId: "issue",
              kind: "approval",
              prompt: "Ship it?",
              checkpoint: checkpoint.id,
              routeTo: "ben",
            },
          },
        ],
      });
    askAs(t.as("ann"), "from-ann");
    askAs(t.as("agt_annbot", "ann"), "from-annbot");
    askAs(t.ben, "from-ben");
    const auto = (id: string) => t.tracker.autoApprove(t.as("ben"), id, checkpoint.id);
    expect(auto("from-ann")).toBeNull();
    expect(auto("from-annbot")).toBeNull();
    expect(t.tracker.noteAutoApproveSkipped(t.as("ben"), "from-ann", checkpoint.id, "x")).toBe(
      false,
    );
    expect(t.request("from-ann").status).toBe("open");
    expect(t.request("from-annbot").status).toBe("open");
    expect(auto("from-ben")).not.toBeNull();
    expect(t.request("from-ben")).toMatchObject({ status: "answered", via: "auto-approve" });
  });

  test("its operation id is one no client can use or pre-claim", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    const team = { kind: "team.update", id: "team", expectedVersion: 1, data: { name: "Eng" } };
    expect(() =>
      t.tracker.mutate(t.bot, { operationId: `@auto-approve:${id}`, mutations: [team as never] }),
    ).toThrow(/IDs must use letters/);
    // The old spelling is just another client id: it claims nothing.
    t.tracker.mutate(t.as("ann"), {
      operationId: `auto-approve:${id}`,
      mutations: [team as never],
    });
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)?.events[0]).toMatchObject({
      operationId: `@auto-approve:${id}`,
      kind: "request.answer",
    });
  });

  test("someone found no longer a member loses the setting, logged, and rejoining doesn't restore it", () => {
    const t = setup({ policy: "approval" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    const cursor = t.tracker.snapshot(t.ben).cursor;
    const gone = { ...t.as("ben"), members: [{ id: "ann", slug: "ann", displayName: "Ann" }] };
    expect(t.tracker.autoApprove(gone, id, checkpoint.id)).toBeNull();
    expect(t.tracker.changes(cursor, 10).events).toMatchObject([
      {
        kind: "automation.approveWhenGreen",
        entityType: "automation",
        entityId: "ben",
        source: "automation",
        before: { approveWhenGreen: true },
        entity: { approveWhenGreen: false, enabledAt: null },
      },
    ]);
    // Back as a member: off until Ben turns it on again.
    expect(t.tracker.snapshot(t.ben).approveWhenGreen).toEqual([]);
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)).toBeNull();
    expect(t.request(id).status).toBe("open");
  });

  test("only approval timelines", () => {
    const t = setup({ policy: "auto" });
    t.push(2);
    const { checkpoint } = t.checkpoint(2);
    const id = t.ask(checkpoint.id);
    t.approveWhenGreen(t.ben, true);
    expect(t.tracker.autoApprove(t.as("ben"), id, checkpoint.id)).toBeNull();
    expect(t.request(id).status).toBe("open");
  });
});
