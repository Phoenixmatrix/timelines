// Issue requirements in the tracker (CORE-32): agents that don't meet an
// issue's requirements can't claim it, aren't given it by next or a handoff,
// and are told why; people always can, and an explicit assignment stands.

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { AgentCapabilities } from "../../shared/api.ts";
import {
  issuePickup,
  readiness,
  readinessIndex,
  type Issue,
  type Mutation,
  type TrackerAgent,
} from "../../shared/tracker.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { freshTrackerStorage } from "../testing/tracker.ts";

const GiB = 2 ** 30;
const databases: { close(): void }[] = [];
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

async function fixture() {
  const storage = await freshTrackerStorage("org", [
    {
      accountId: "alice",
      role: "owner",
      grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
    },
    {
      accountId: "bob",
      role: "member",
      grant: { role: "member", repositoryRole: "read", packageRole: "read" },
    },
  ]);
  databases.push(storage);
  const { db, sql, transactionSync, scope, space } = storage;
  let now = Date.parse("2026-10-01T00:00:00Z");
  const store = new TrackerStore(sql, transactionSync, () => now);
  const owner: Access = {
    actorId: "alice",
    principalId: "alice",
    agents: [agent("agt-ux", ux), agent("agt-blank", null), agent("agt-bobs", ux, bob)],
    agentId: null,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: true,
    members: [alice, bob],
    repos: [],
  };
  const as = (actorId: string, principalId = "alice", canAdmin = principalId === "alice") => ({
    ...owner,
    actorId,
    principalId,
    agentId: actorId.startsWith("agt-") ? actorId : null,
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
    store.mutate(access, { ...scope, operationId: `op-${++n}`, mutations });
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
  return {
    db,
    store,
    owner,
    people,
    agents,
    run,
    create,
    issue,
    refusal,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

describe("issue pickup authority", () => {
  test("expired holders cannot resume after pickup becomes restricted", async () => {
    const f = await fixture();
    f.create("work");
    f.run(f.agents.ux, {
      kind: "issue.claim",
      id: "work",
      data: { agent: "worker", ttlSeconds: 30 },
    });
    f.advance(31);
    f.run(f.owner, {
      kind: "issue.update",
      id: "work",
      expectedVersion: 2,
      data: { pickup: "human_only" },
    });
    expect(
      f.refusal(() =>
        f.run(f.agents.ux, {
          kind: "issue.resume",
          id: "work",
          data: {},
        }),
      ),
    ).toMatchObject({ code: "pickup_human_only" });
    expect(f.issue("work").claim?.expiresAt).toBe("2026-10-01T00:00:30.000Z");
  });

  test("restricting a descendant cannot invalidate its ancestor's active agent lease", async () => {
    const f = await fixture();
    f.create("parent");
    f.create("child", { parentId: "parent" });
    const token = f.run(f.agents.ux, {
      kind: "issue.claim",
      id: "parent",
      data: { agent: "orchestrator" },
    }).results[0]!.leaseToken!;
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.update",
          id: "child",
          expectedVersion: 1,
          data: { pickup: "human_only" },
        }),
      ),
    ).toMatchObject({ code: "claim_busy" });
    f.run(f.agents.ux, {
      kind: "issue.update",
      id: "child",
      expectedVersion: 1,
      data: { status: "in_progress", leaseToken: token },
    });
    expect(f.issue("child").status).toBe("in_progress");
  });
  test("restricted work is excluded from next and exact claims, even when assigned", async () => {
    const f = await fixture();
    for (const pickup of ["not_ready", "human_only"] as const) {
      f.create(pickup, { pickup, assigneeId: "agt-ux", priority: 0 });
      expect(
        f.refusal(() =>
          f.run(f.agents.ux, {
            kind: "issue.claim",
            id: pickup,
            data: { agent: "human-looking label" },
          }),
        ),
      ).toMatchObject({ code: `pickup_${pickup}` });
    }
    f.create("plain", { priority: 4 });
    const next = f.run(f.agents.ux, {
      kind: "issue.next",
      id: "next",
      data: { agent: "Alice" },
    }).results[0]!;
    expect(next.key).toBe(f.issue("plain").key);
    expect(f.issue("not_ready").claim).toBeNull();
    expect(f.issue("human_only").claim).toBeNull();
  });

  test("people can take human-only work, but nobody can take not-ready work", async () => {
    const f = await fixture();
    f.create("human", { pickup: "human_only" });
    f.create("later", { pickup: "not_ready" });
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.claim",
          id: "later",
          data: { agent: "person", force: true },
        }),
      ),
    ).toMatchObject({ code: "pickup_not_ready" });
    const next = f.run(f.owner, {
      kind: "issue.next",
      id: "next",
      data: { agent: "claude-code" },
    }).results[0]!;
    expect(next.key).toBe(f.issue("human").key);
    expect(f.issue("human").claim?.actorId).toBe("alice");
    f.run(f.owner, { kind: "issue.renew", id: "human", data: { leaseToken: next.leaseToken! } });
    f.run(f.owner, {
      kind: "issue.complete",
      id: "human",
      data: { leaseToken: next.leaseToken!, evidence: "Reviewed by Alice" },
    });
    expect(f.issue("human").status).toBe("done");
  });

  test("delegated subtree claims and next cannot bypass pickup", async () => {
    const f = await fixture();
    f.create("parent");
    f.create("human", { parentId: "parent", pickup: "human_only" });
    f.create("later", { parentId: "parent", pickup: "not_ready" });
    const token = f.run(f.owner, {
      kind: "issue.claim",
      id: "parent",
      data: { agent: "orchestrator" },
    }).results[0]!.leaseToken!;
    for (const [id, code] of [
      ["human", "pickup_human_only"],
      ["later", "pickup_not_ready"],
    ]) {
      expect(
        f.refusal(() =>
          f.run(f.owner, {
            kind: "issue.claim",
            id: id!,
            data: { agent: "worker", underToken: token, forActorId: "agt-ux" },
          }),
        ),
      ).toMatchObject({ code });
    }
    const next = f.run(f.owner, {
      kind: "issue.next",
      id: "next",
      data: { agent: "worker", underId: "parent", underToken: token, forActorId: "agt-ux" },
    }).results[0]!;
    expect(next.leaseToken).toBeUndefined();
    expect(f.issue("human").claim).toBeNull();
  });

  test("agents cannot self-enable policies, including in the same mutation or batch", async () => {
    const f = await fixture();
    f.create("restricted", { pickup: "not_ready" });
    for (const pickup of ["anyone", "human_only"] as const) {
      expect(
        f.refusal(() =>
          f.run(f.agents.ux, {
            kind: "issue.update",
            id: "restricted",
            expectedVersion: 1,
            data: { pickup, status: "in_progress" },
          }),
        ),
      ).toMatchObject({ code: "forbidden" });
    }
    f.create("plain");
    expect(
      f.refusal(() =>
        f.run(
          f.agents.ux,
          { kind: "issue.update", id: "plain", expectedVersion: 1, data: { pickup: "human_only" } },
          { kind: "issue.update", id: "plain", expectedVersion: 2, data: { pickup: "anyone" } },
          { kind: "issue.claim", id: "plain", data: { agent: "worker" } },
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
    expect(f.issue("plain")).toMatchObject({ pickup: "anyone", version: 1, claim: null });
    f.run(f.agents.ux, {
      kind: "issue.update",
      id: "plain",
      expectedVersion: 1,
      data: { pickup: "human_only" },
    });
    f.run(f.owner, {
      kind: "issue.update",
      id: "restricted",
      expectedVersion: 1,
      data: { pickup: "anyone" },
    });
    f.run(f.agents.ux, { kind: "issue.claim", id: "restricted", data: { agent: "worker" } });
    expect(f.issue("restricted").claim?.actorId).toBe("agt-ux");
  });

  test("direct status starts and completion cannot bypass policy", async () => {
    const f = await fixture();
    for (const pickup of ["not_ready", "human_only"] as const) {
      f.create(pickup, { pickup });
      for (const status of ["in_progress", "done"] as const) {
        expect(
          f.refusal(() =>
            f.run(f.agents.ux, {
              kind: "issue.update",
              id: pickup,
              expectedVersion: 1,
              data: { status },
            }),
          ),
        ).toMatchObject({ code: `pickup_${pickup}` });
        expect(
          f.refusal(() =>
            f.run(f.agents.ux, {
              kind: "issue.create",
              id: `new-${pickup}-${status}`,
              data: { teamId: "team", title: "Restricted", pickup, status },
            }),
          ),
        ).toMatchObject({ code: `pickup_${pickup}` });
      }
    }
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.update",
          id: "not_ready",
          expectedVersion: 1,
          data: { status: "done" },
        }),
      ),
    ).toMatchObject({ code: "pickup_not_ready" });
  });

  test("active claims cannot be invalidated and human-only handoffs reject agents", async () => {
    const f = await fixture();
    f.create("work");
    const token = f.run(f.agents.ux, {
      kind: "issue.claim",
      id: "work",
      data: { agent: "worker" },
    }).results[0]!.leaseToken!;
    for (const pickup of ["human_only", "not_ready"] as const)
      expect(
        f.refusal(() =>
          f.run(f.owner, {
            kind: "issue.update",
            id: "work",
            expectedVersion: 2,
            data: { pickup },
          }),
        ),
      ).toMatchObject({ code: "claim_busy", message: expect.stringContaining("Release") });
    f.run(f.agents.ux, { kind: "issue.renew", id: "work", data: { leaseToken: token } });
    f.run(f.agents.ux, { kind: "issue.release", id: "work", data: { leaseToken: token } });
    f.run(f.owner, {
      kind: "issue.update",
      id: "work",
      expectedVersion: 4,
      data: { pickup: "human_only" },
    });
    const humanToken = f.run(f.owner, {
      kind: "issue.claim",
      id: "work",
      data: { agent: "person" },
    }).results[0]!.leaseToken!;
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.offer",
          id: "work",
          data: { leaseToken: humanToken, toActorId: "agt-ux" },
        }),
      ),
    ).toMatchObject({ code: "pickup_human_only" });
    const code = f.run(f.owner, {
      kind: "issue.offer",
      id: "work",
      data: { leaseToken: humanToken },
    }).results[0]!.offerCode!;
    expect(
      f.refusal(() =>
        f.run(f.agents.ux, {
          kind: "issue.accept",
          id: "work",
          data: { code },
        }),
      ),
    ).toMatchObject({ code: "pickup_human_only" });
    expect(f.issue("work").claim?.actorId).toBe("alice");
  });

  test("invalid values fail, legacy records remain ready, and actor readiness differs", async () => {
    const f = await fixture();
    for (const pickup of ["later", null, false, 1])
      expect(f.refusal(() => f.create("invalid", { pickup }))).toMatchObject({
        code: "invalid_input",
      });
    f.create("existing");
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.update",
          id: "existing",
          expectedVersion: 1,
          // @ts-expect-error Exercise untyped API input.
          data: { pickup: "later" },
        }),
      ),
    ).toMatchObject({ code: "invalid_input" });
    f.create("legacy");
    f.db
      .prepare("UPDATE issues SET data = json_remove(data, '$.pickup') WHERE id = ?")
      .run("legacy");
    const legacy = f.issue("legacy");
    const index = readinessIndex([legacy], []);
    const now = "2026-10-01T00:00:00Z";
    expect(issuePickup(legacy)).toBe("anyone");
    expect(readiness(legacy, index, now)).toBe("ready");
    expect(readiness({ ...legacy, pickup: "human_only" }, index, now)).toBe("human_only");
    expect(readiness({ ...legacy, pickup: "human_only" }, index, now, "person")).toBe("ready");
    expect(readiness({ ...legacy, pickup: "not_ready" }, index, now, "person")).toBe("not_ready");
    f.run(f.agents.ux, { kind: "issue.claim", id: "legacy", data: { agent: "worker" } });
    expect(f.issue("legacy").claim?.actorId).toBe("agt-ux");
  });
});

describe("issue requirements", () => {
  test("are stored normalized, cleared by null, and recorded in history", async () => {
    const f = await fixture();
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

  test("claims: agents must meet them, people always can", async () => {
    const f = await fixture();
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

  test("next skips what the agent doesn't meet and says how many", async () => {
    const f = await fixture();
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
    const g = await fixture();
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

  test("handoffs: an offer to an agent and its acceptance both check it", async () => {
    const f = await fixture();
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

  test("assignment to an agent that doesn't meet them is a person's explicit call", async () => {
    const f = await fixture();
    f.create("ui", { requires: { tags: ["ux", "gpu"] } });
    const assign = (access: Access, assigneeId: string) =>
      f.run(access, {
        kind: "issue.update",
        id: "ui",
        expectedVersion: f.issue("ui").version,
        data: { assigneeId },
      });
    // Not the agent's person nor a Space admin.
    expect(f.refusal(() => assign(f.people.bob, "agt-blank"))).toMatchObject({
      code: "requirements_unmet",
      message: expect.stringContaining("Only a Space admin or Alice can assign it anyway."),
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

describe("tightening requirements on a claimed issue (CORE-272)", () => {
  const claimed = async () => {
    const f = await fixture();
    f.create("ui", { requires: { tags: ["ux"] } });
    f.run(f.agents.ux, { kind: "issue.claim", id: "ui", data: { agent: "laptop" } });
    return f;
  };
  const comments = (f: { store: TrackerStore; owner: Access }) =>
    f.store
      .snapshot(f.owner)
      .comments.filter((c) => c.issueId === "ui")
      .map((c) => c.body);

  test("keeping the claim names who's affected and what they miss, and records it", async () => {
    const f = await claimed();
    const result = f.run(f.owner, {
      kind: "issue.update",
      id: "ui",
      expectedVersion: 2,
      data: { requires: { tags: ["ux", "gpu"] } },
    }).results[0]!;
    expect(result.claimEffect).toEqual({
      actorId: "agt-ux",
      agent: "ux",
      session: "laptop",
      unmet: [
        expect.objectContaining({
          wanted: "tag:gpu",
          message: "needs tag gpu (it reports tags: ux)",
        }),
      ],
      released: false,
    });
    expect(f.issue("ui").claim?.actorId).toBe("agt-ux");
    expect(comments(f)).toEqual([
      "Kept the claim held by ux (session `laptop`) although the new requirements no longer allow it: it needs tag gpu (it reports tags: ux).",
    ]);
  });

  test("releasing it ends the claim, puts the work back, and records it", async () => {
    const f = await claimed();
    const result = f.run(f.owner, {
      kind: "issue.update",
      id: "ui",
      expectedVersion: 2,
      data: { requires: { minMemory: 64 * GiB }, releaseClaim: true },
    }).results[0]!;
    expect(result.claimEffect).toMatchObject({ agent: "ux", released: true });
    const issue = f.issue("ui");
    expect(issue.claim).toBeNull();
    expect(issue.status).toBe("todo");
    // Unassigned too, so next doesn't hand it straight back.
    expect(issue.assigneeId).toBeNull();
    expect(
      f.run(f.agents.ux, { kind: "issue.next", id: "n", data: { agent: "s" } }).results[0]!.issueId,
    ).toBeUndefined();
    expect(issue.requires).toEqual({ minMemory: 64 * GiB });
    expect(comments(f)[0]).toMatch(
      /^Released the claim held by ux \(session `laptop`\) and unassigned it/,
    );
    // The holder's lease token no longer works.
    expect(
      f.refusal(() =>
        f.run(f.agents.ux, { kind: "issue.renew", id: "ui", data: { leaseToken: "x" } }),
      ).code,
    ).toBeTruthy();
  });

  test("only the Space admin or the agent's person may release, and only what tightening affects", async () => {
    // Bob is neither: his release is refused and nothing changes.
    const f = await claimed();
    expect(
      f.refusal(() =>
        f.run(f.people.bob, {
          kind: "issue.update",
          id: "ui",
          expectedVersion: 2,
          data: { requires: { tags: ["gpu"] }, releaseClaim: true },
        }),
      ),
    ).toMatchObject({ code: "forbidden" });
    expect(f.issue("ui").claim?.actorId).toBe("agt-ux");
    // Loosening, or a change the holder still meets, affects nobody: no effect, no comment.
    const loose = f.run(f.owner, {
      kind: "issue.update",
      id: "ui",
      expectedVersion: 2,
      data: { requires: { tags: ["ux"], models: ["claude-*"] }, releaseClaim: true },
    }).results[0]!;
    expect(loose.claimEffect).toBeUndefined();
    expect(f.issue("ui").claim?.actorId).toBe("agt-ux");
    expect(comments(f)).toEqual([]);
    expect(
      f.refusal(() =>
        f.run(f.owner, {
          kind: "issue.update",
          id: "ui",
          expectedVersion: 3,
          data: { title: "x", releaseClaim: "yes" as unknown as boolean },
        }),
      ).code,
    ).toBe("invalid_input");
  });

  test("a person's own claim is never affected", async () => {
    const g = await fixture();
    g.create("ui");
    g.run(g.owner, { kind: "issue.claim", id: "ui", data: { agent: "me" } });
    expect(
      g.run(g.owner, {
        kind: "issue.update",
        id: "ui",
        expectedVersion: 2,
        data: { requires: { tags: ["gpu"] } },
      }).results[0]!.claimEffect,
    ).toBeUndefined();
  });

  test("next says which requirements kept the most work and how to change the profile", async () => {
    const f = await fixture();
    f.create("a", { requires: { tags: ["gpu"] } });
    f.create("b", { requires: { tags: ["gpu"], minMemory: 64 * GiB } });
    f.create("c", { requires: { models: ["gpt-5*"] } });
    const skipped = f.run(f.agents.ux, {
      kind: "issue.next",
      id: "n",
      data: { agent: "s" },
    }).results[0]!.skipped!;
    expect(skipped.blocking).toEqual([
      { wanted: "tag:gpu", issues: 2 },
      { wanted: "memory>=64GiB", issues: 1 },
      { wanted: "model:gpt-5*", issues: 1 },
    ]);
    expect(skipped.message).toContain(
      "Most need tag:gpu (2 issues), memory>=64GiB (1 issue), model:gpt-5* (1 issue).",
    );
    expect(skipped.message).toContain("`gm agent setup --tag gpu`");
  });
});
