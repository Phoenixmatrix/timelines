import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import { findSpaceById } from "../spaces/access.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { durableStorage } from "../testing/durable.ts";
import { accessFor } from "../tracker/access.ts";
import { Tracker } from "../tracker/object.ts";
import { trackerObject } from "../tracker/stub.ts";
import { recordQueueFailure, validateQueueIssues } from "./remediation.ts";
import { fakeDurableObjectId } from "../testing/durable-state.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const databases: DatabaseSync[] = [];
const environments: Array<() => void> = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const close of environments.splice(0)) close();
});

async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  environments.push(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('owner', 'user', 'owner', 'Owner'), ('priya', 'user', 'priya', 'Priya');
    INSERT INTO agents (id, name, accountable_id) VALUES
      ('agt_priya', 'Priya builder', 'priya'), ('agt_owner', 'Owner builder', 'owner');
    INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four, agent_id) VALUES
      ('owner-token', 'owner', 'Queue', 'write', 'owner-token-hash', 'hash', NULL),
      ('priya-token', 'priya', 'Queue', 'write', 'priya-token-hash', 'hash', NULL),
      ('priya-agent-token', 'priya', 'Queue agent', 'write', 'priya-agent-token-hash', 'hash', 'agt_priya');
  `);
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      kind: "personal",
      personalAccountId: "owner",
    },
    space: { id: "space", slug: "owner", displayName: "Queue Space" },
    members: [
      {
        accountId: "owner",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "owner",
  });
  sqlite.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','space','app','private','a','https://a'); INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','priya','write')",
  );
  const trackers = new Map<string, Tracker>();
  const storage = durableStorage();
  databases.push(storage.db);
  const ctx = {
    id: fakeDurableObjectId("space"),
    storage: { sql: storage.sql, transactionSync: storage.transactionSync },
  } as unknown as DurableObjectState;
  Object.assign(env, {
    TRACKER: {
      idFromName: fakeDurableObjectId,
      getByName: (id: string) => trackers.get(id),
    },
  });
  await initializeFreshTrackerSpace(env, ctx, "space");
  trackers.set("space", new Tracker(ctx, env));
  const space = (await findSpaceById(env.DB, "space"))!;
  const access = await accessFor(env, space, "owner", null, true, {
    kind: "token",
    id: "owner-token",
  });
  const tracker = trackerObject(env, "space");
  const created = await tracker.mutate(access, {
    contractVersion: 4,
    spaceId: access.spaceId,
    migrationEpoch: access.migrationEpoch,
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
    sqlite,
    space,
    tracker,
    access,
    input: {
      spaceId: "space",
      repoId: "repo",
      actorId: "priya",
      agentId: null as string | null,
      credential: { kind: "token" as const, id: "priya-token" },
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
    "requires an explicit Space grant for queue failure attribution: $agentId",
    async ({ agentId, actor }) => {
      const t = await setup();
      const input = {
        ...t.input,
        agentId,
        credential: { kind: "token" as const, id: agentId ? "priya-agent-token" : "priya-token" },
      };
      await expect(
        validateQueueIssues(t.env, { ...input, issueIds: ["original"] }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(recordQueueFailure(t.env, input)).rejects.toMatchObject({ status: 403 });
      const before = await t.tracker.snapshot(t.access);
      if (!before.ok) throw new Error(before.error);
      expect(before.value.issues.map((issue) => issue.id)).toEqual(["original"]);
      t.sqlite.exec(`
        INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by)
        VALUES('organization','priya','member','test-fixture','owner');
        INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
        VALUES('space','organization','priya','member','write','none','test-fixture','owner');
      `);
      t.access = await accessFor(t.env, t.space, "owner", null, true, {
        kind: "token",
        id: "owner-token",
      });
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
      expect(await validateQueueIssues(t.env, { ...input, issueIds: ["original"] })).toEqual([
        "original",
      ]);
      const normalAccess = await accessFor(
        t.env,
        t.space,
        "priya",
        agentId,
        true,
        input.credential,
      );
      expect(normalAccess.members.map((member) => member.id)).toEqual(["owner", "priya"]);
      expect(normalAccess.agents.map((agent) => agent.id)).toEqual(["agt_owner", "agt_priya"]);
      t.sqlite.exec("DELETE FROM space_grants WHERE space_id='space' AND account_id='priya'");
      await expect(recordQueueFailure(t.env, input)).rejects.toMatchObject({ status: 403 });
      await expect(
        validateQueueIssues(t.env, { ...input, issueIds: ["original"] }),
      ).rejects.toMatchObject({ status: 403 });
      t.access = await accessFor(t.env, t.space, "owner", null, true, {
        kind: "token",
        id: "owner-token",
      });
      const retained = await t.tracker.snapshot(t.access);
      if (!retained.ok) throw new Error(retained.error);
      expect(retained.value.issues.find((issue) => issue.id === remediation.id)!.createdBy).toEqual(
        actor,
      );
    },
  );

  test("a missing principal cannot publish failure evidence as another person", async () => {
    const t = await setup();
    await expect(
      recordQueueFailure(t.env, { ...t.input, actorId: "missing" }),
    ).rejects.toMatchObject({ status: 403 });
    const snapshot = await t.tracker.snapshot(t.access);
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(snapshot.value.issues.map((issue) => issue.id)).toEqual(["original"]);
  });
});
