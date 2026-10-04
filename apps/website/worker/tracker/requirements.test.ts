// Issue requirements in the tracker (CORE-32): agents that don't meet an
// issue's requirements can't claim it, aren't given it by next or a handoff,
// and are told why; people always can, and an explicit assignment stands.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { AgentCapabilities } from "../../shared/api.ts";
import type { Issue, Mutation, TrackerAgent } from "../../shared/tracker.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";

const GiB = 2 ** 30;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const alice = { id: "alice", slug: "alice", displayName: "Alice" };
const bob = { id: "bob", slug: "bob", displayName: "Bob" };
const ux: AgentCapabilities = {
  version: 1,
  harness: "claude-code",
  model: "claude-opus-4-5",
  environment: { os: "linux", arch: "x86_64", runtime: "host", cpuCount: 8, memoryBytes: 32 * GiB },
  tags: ["ux"],
  skills: [{ name: "playwright", description: "", source: "detected" }],
};
function agent(id: string, capabilities: AgentCapabilities | null, accountable = alice) {
  return {
    id,
    name: id.replace("agt-", ""),
    accountable,
    capabilities,
    capabilitiesUpdatedAt: capabilities ? "2026-10-01T00:00:00Z" : null,
    revokedAt: null,
  } satisfies TrackerAgent;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const now = Date.parse("2026-10-01T00:00:00Z");
  const store = new TrackerStore(trackerSql(db), transactional(db), () => now);
  const owner: Access = {
    actorId: "alice",
    principalId: "alice",
    agents: [agent("agt-ux", ux), agent("agt-blank", null), agent("agt-bobs", ux, bob)],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [alice, bob],
    repos: [],
  };
  const as = (actorId: string, principalId = "alice", canAdmin = principalId === "alice") => ({
    ...owner,
    actorId,
    principalId,
    canAdmin,
  });
  const people = { alice: owner, bob: as("bob", "bob", false) };
  const agents = {
    ux: as("agt-ux"),
    blank: as("agt-blank"),
    bobs: as("agt-bobs", "bob", false),
  };
  let n = 0;
  const run = (access: Access, ...mutations: Mutation[]) =>
    store.mutate(access, { operationId: `op-${++n}`, mutations });
  run(owner, { kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } });
  const create = (id: string, data: Record<string, unknown> = {}) =>
    run(owner, { kind: "issue.create", id, data: { teamId: "team", title: id, ...data } });
  const issue = (id: string) => store.snapshot(owner).issues.find((i) => i.id === id) as Issue;
  /** The refusal a mutation raises: its code, message and unmet requirements. */
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof TrackerError)
        return { code: error.code, message: error.message, unmet: error.details.unmet };
      throw error;
    }
    throw new Error("Expected a refusal");
  };
  return { store, owner, people, agents, run, create, issue, refusal };
}

describe("issue requirements", () => {
  test("are stored normalized, cleared by null, and recorded in history", () => {
    const f = fixture();
    f.create("a", { requires: { tags: ["UX", "ux"], minMemory: 16 * GiB } });
    expect(f.issue("a").requires).toEqual({ tags: ["ux"], minMemory: 16 * GiB });
    f.run(f.owner, {
      kind: "issue.update",
      id: "a",
      expectedVersion: 1,
      data: { requires: { models: ["claude-*"] } },
    });
    expect(f.issue("a").requires).toEqual({ models: ["claude-*"] });
    f.run(f.owner, { kind: "issue.update", id: "a", expectedVersion: 2, data: { requires: null } });
    expect("requires" in f.issue("a")).toBe(false);
    const history = f.store.history(f.owner, "a", null, 10);
    expect(history.events.map((e) => (e.entity as Issue).requires ?? null)).toEqual([
      null,
      { models: ["claude-*"] },
      { tags: ["ux"], minMemory: 16 * GiB },
    ]);
    expect(f.refusal(() => f.create("bad", { requires: { tags: ["a b"] } }))).toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/Invalid tag/),
    });
    expect(f.refusal(() => f.create("bad", { requires: { gpu: 1 } }))).toMatchObject({
      code: "invalid_input",
      message: "Unknown requirement: gpu.",
    });
    // Issues without requirements stay as they were: no field at all.
    f.create("plain");
    expect("requires" in f.issue("plain")).toBe(false);
  });

  test("claims: agents must meet them, people always can", () => {
    const f = fixture();
    f.create("ui", { requires: { tags: ["ux"], minMemory: 64 * GiB } });
    f.create("plain");
    const refused = f.refusal(() =>
      f.run(f.agents.ux, { kind: "issue.claim", id: "ui", data: { agent: "s" } }),
    );
    expect(refused).toMatchObject({
      code: "requirements_unmet",
      message:
        "ux doesn't meet ENG-1's requirements: needs at least 64GiB of memory (it reports 32GiB).",
      unmet: [{ requirement: "minMemory", wanted: "memory>=64GiB", reported: "32GiB" }],
    });
    // An agent that never reported capabilities is told how to.
    expect(
      f.refusal(() =>
        f.run(f.agents.blank, { kind: "issue.claim", id: "ui", data: { agent: "s" } }),
      ),
    ).toMatchObject({
      code: "requirements_unmet",
      message: expect.stringContaining("run `gm agent setup`"),
      unmet: [{ requirement: "capabilities" }],
    });
    // Without requirements, any agent claims as before.
    f.run(f.agents.blank, { kind: "issue.claim", id: "plain", data: { agent: "s" } });
    expect(f.issue("plain").claim?.actorId).toBe("agt-blank");
    // A person claims whatever it requires.
    f.run(f.people.bob, { kind: "issue.claim", id: "ui", data: { agent: "laptop" } });
    expect(f.issue("ui").claim?.actorId).toBe("bob");
  });

  test("next skips what the agent doesn't meet and says how many", () => {
    const f = fixture();
    f.create("gpu", { priority: 0, requires: { tags: ["gpu"] } });
    f.create("design", { priority: 1, requires: { tags: ["ux"], models: ["claude-opus-*"] } });
    f.create("plain", { priority: 3 });
    const next = (access: Access) =>
      f.run(access, { kind: "issue.next", id: crypto.randomUUID(), data: { agent: "s" } })
        .results[0]!;
    const first = next(f.agents.ux);
    expect(first).toMatchObject({
      key: "ENG-2",
      skipped: { requirements: 1, keys: ["ENG-1"] },
    });
    expect(first.skipped!.message).toMatch(
      /^Skipped 1 ready issue whose requirements ux doesn't meet: ENG-1\./,
    );
    expect(next(f.agents.ux)).toMatchObject({ key: "ENG-3", skipped: { requirements: 1 } });
    const none = next(f.agents.ux);
    expect(none.issueId).toBeUndefined();
    expect(none.skipped).toMatchObject({ requirements: 1, keys: ["ENG-1"] });
    // Without capabilities, everything with requirements is skipped, with the fix.
    const g = fixture();
    g.create("gpu", { priority: 0, requires: { tags: ["gpu"] } });
    g.create("plain", { priority: 3 });
    const blank = g.run(g.agents.blank, {
      kind: "issue.next",
      id: "n",
      data: { agent: "s" },
    }).results[0]!;
    expect(blank.key).toBe("ENG-2");
    expect(blank.skipped!.message).toContain(
      "blank hasn't reported its capabilities: run `gm agent setup`",
    );
    // People aren't filtered, and nothing is reported skipped.
    const person = g.run(g.owner, { kind: "issue.next", id: "p", data: { agent: "s" } })
      .results[0]!;
    expect(person).toMatchObject({ key: "ENG-1" });
    expect(person.skipped).toBeUndefined();
  });

  test("handoffs: an offer to an agent and its acceptance both check it", () => {
    const f = fixture();
    f.create("ui", { requires: { tags: ["ux"] } });
    const token = f.run(f.owner, { kind: "issue.claim", id: "ui", data: { agent: "me" } })
      .results[0]!.leaseToken!;
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.offer",
          id: "ui",
          data: { leaseToken: token, toActorId: "agt-blank" },
        }),
      ),
    ).toMatchObject({ code: "requirements_unmet", unmet: [{ requirement: "capabilities" }] });
    const code = f.run(f.owner, { kind: "issue.offer", id: "ui", data: { leaseToken: token } })
      .results[0]!.offerCode!;
    expect(
      f.refusal(() => f.run(f.agents.blank, { kind: "issue.accept", id: "ui", data: { code } })),
    ).toMatchObject({ code: "requirements_unmet" });
    f.run(f.agents.ux, { kind: "issue.accept", id: "ui", data: { code } });
    expect(f.issue("ui").claim?.actorId).toBe("agt-ux");
  });

  test("assignment to an agent that doesn't meet them is a person's explicit call", () => {
    const f = fixture();
    f.create("ui", { requires: { tags: ["ux", "gpu"] } });
    const assign = (access: Access, assigneeId: string) =>
      f.run(access, {
        kind: "issue.update",
        id: "ui",
        expectedVersion: f.issue("ui").version,
        data: { assigneeId },
      });
    // Not the agent's person nor a tracker owner.
    expect(f.refusal(() => assign(f.people.bob, "agt-blank"))).toMatchObject({
      code: "requirements_unmet",
      message: expect.stringContaining("Only a tracker owner or Alice can assign it anyway."),
    });
    // Agents can't hand it on to one that doesn't meet them.
    expect(f.refusal(() => assign(f.agents.ux, "agt-blank"))).toMatchObject({
      code: "requirements_unmet",
      message: expect.stringContaining("a person can"),
    });
    // Bob may assign his own agent; the owner may assign anyone's.
    assign(f.people.bob, "agt-bobs");
    assign(f.owner, "agt-blank");
    expect(f.issue("ui").assigneeId).toBe("agt-blank");
    // The assigned agent may then claim it, mismatch and all; others still can't.
    expect(
      f.refusal(() => f.run(f.agents.ux, { kind: "issue.claim", id: "ui", data: { agent: "s" } })),
    ).toMatchObject({ code: "requirements_unmet", unmet: [{ wanted: "tag:gpu" }] });
    f.run(f.agents.blank, { kind: "issue.claim", id: "ui", data: { agent: "s" } });
    expect(f.issue("ui").claim?.actorId).toBe("agt-blank");
  });
});
