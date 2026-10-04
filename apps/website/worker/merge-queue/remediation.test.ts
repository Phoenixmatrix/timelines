import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import { db } from "../schema.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { accessFor } from "../tracker/access.ts";
import { Tracker } from "../tracker/object.ts";
import { trackerObject } from "../tracker/stub.ts";
import { recordQueueFailure, validateQueueIssues } from "./remediation.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('owner', 'user', 'owner', 'Owner'), ('priya', 'user', 'priya', 'Priya');
    INSERT INTO agents (id, name, accountable_id) VALUES
      ('agt_priya', 'Priya builder', 'priya'), ('agt_owner', 'Owner builder', 'owner');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'owner', 'app', 'private', 'a', 'https://a');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('repo', 'priya', 'write');
  `);
  const trackers = new Map<string, Tracker>();
  const env = {
    DB: d1(sqlite),
    TRACKER: {
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const storage = durableStorage();
          databases.push(storage.db);
          const ctx = {
            storage: { sql: storage.sql, transactionSync: storage.transactionSync },
          } as unknown as DurableObjectState;
          trackers.set(id, new Tracker(ctx, {} as Env));
        }
        return trackers.get(id);
      },
    },
  } as unknown as Env;
  const owner = await db(env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", "owner")
    .executeTakeFirstOrThrow();
  const access = await accessFor(env.DB, owner, "owner", null, true);
  const tracker = trackerObject(env, "owner");
  const created = await tracker.mutate(access, {
    operationId: "original",
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } },
      {
        kind: "issue.create",
        id: "original",
        data: { teamId: "team", title: "Private tracker work" },
      },
    ],
  });
  if (!created.ok) throw new Error(created.error);
  const failure: QueueFailure = {
    queueId: "a".repeat(40),
    commit: "a".repeat(40),
    repo: "owner/app",
    attempt: 1,
    stage: "gates",
    kind: "build_failed",
    reason: "Build failed",
    runNumber: 42,
    failedJobs: ["build"],
    conflictPaths: [],
    classificationModel: null,
    repairModel: null,
    occurredAt: "2026-10-04T00:00:00Z",
  };
  return {
    env,
    tracker,
    access,
    input: {
      ownerId: "owner",
      repoId: "repo",
      actorId: "priya",
      agentId: null as string | null,
      issueIds: [] as string[],
      failure,
    },
  };
}

describe("trusted queue failure attribution", () => {
  test.each([
    { agentId: null, actor: { id: "priya", kind: "person", name: "Priya", accountable: null } },
    {
      agentId: "agt_priya",
      actor: {
        id: "agt_priya",
        kind: "agent",
        name: "Priya builder",
        accountable: { id: "priya", slug: "priya", displayName: "Priya" },
      },
    },
  ])(
    "attributes an external collaborator honestly without granting tracker access: $agentId",
    async ({ agentId, actor }) => {
      const t = await setup();
      const input = { ...t.input, agentId };
      await expect(
        validateQueueIssues(t.env, { ...input, issueIds: ["original"] }),
      ).rejects.toMatchObject({ status: 403 });
      const remediation = await recordQueueFailure(t.env, input);
      const snapshot = await t.tracker.snapshot(t.access);
      if (!snapshot.ok) throw new Error(snapshot.error);
      expect(snapshot.value.issues.find((issue) => issue.id === remediation.id)!.createdBy).toEqual(
        actor,
      );
      const history = await t.tracker.history(t.access, remediation.id, null, 100);
      if (!history.ok) throw new Error(history.error);
      expect(history.value.events.find((event) => event.kind === "issue.create")!.actor).toEqual(
        actor,
      );
      await expect(
        validateQueueIssues(t.env, { ...input, issueIds: ["original"] }),
      ).rejects.toMatchObject({ status: 403 });
      const normalAccess = await accessFor(
        t.env.DB,
        await db(t.env.DB)
          .selectFrom("accounts")
          .selectAll()
          .where("id", "=", "owner")
          .executeTakeFirstOrThrow(),
        "priya",
        agentId,
      );
      expect(normalAccess.members.map((member) => member.id)).toEqual(["owner"]);
      expect(normalAccess.agents.map((agent) => agent.id)).toEqual(["agt_owner"]);
    },
  );

  test("a missing principal stays unknown rather than acquiring another person's identity", async () => {
    const t = await setup();
    const remediation = await recordQueueFailure(t.env, { ...t.input, actorId: "missing" });
    const snapshot = await t.tracker.snapshot(t.access);
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(snapshot.value.issues.find((issue) => issue.id === remediation.id)!.createdBy).toEqual({
      id: "missing",
      kind: "unknown",
      name: null,
      accountable: null,
    });
  });
});
