// Test harness for issue completion credit (CORE-220): a real fresh Space with
// Ann, her agent bot and their own credentials, over the Tracker Durable Object.

import { onTestFinished } from "vite-plus/test";
import type { Issue, Mutation, Snapshot } from "../../shared/tracker.ts";
import { issueToken } from "../api/tokens.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import { Tracker, type TrackerReply } from "../tracker/object.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";
import { TrackerStore, type Access } from "../tracker/store.ts";
import { d1 } from "./d1.ts";
import { fakeDurableObjectId } from "./durable-state.ts";
import { durableStorage } from "./durable.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "./spaces.ts";

export const oid = (n: number) => n.toString(16).padStart(40, "0");

export function value<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/** Ann (a Space admin), her agent `agt-bot`, team ENG and issues `a` and `b`. */
export async function completionTracker() {
  const { sql, db, transactionSync } = durableStorage();
  const identity = fakeDurableObjectId("org");
  const ctx = { id: identity, storage: { sql, transactionSync } } as unknown as DurableObjectState;
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  onTestFinished(() => db.close());
  fresh.sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('ann','user','ann','Ann');
    INSERT INTO agents(id,name,accountable_id) VALUES('agt-bot','bot','ann');
  `);
  await seedSpaceFixture(d1(fresh.sqlite), {
    organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "org", slug: "org", displayName: "Org" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  fresh.sqlite.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('app','org','app','private','app','https://provider/app')",
  );
  const env = { ...fresh.env, TRACKER: { idFromName: fakeDurableObjectId } } as unknown as Env;
  await initializeFreshTrackerSpace(env, ctx, "org");
  const tracker = new Tracker(ctx, env);
  // The object's own store, over the same storage, for what it doesn't expose.
  const store = new TrackerStore(sql, transactionSync);
  const space = await findSpaceById(env.DB, "org");
  if (!space) throw new Error("Missing seeded Space");
  const annToken = await issueToken(env.DB, "ann", "ann", "write");
  const botToken = await issueToken(env.DB, "ann", "bot", "write", undefined, "agt-bot");
  const ann: Access = await accessFor(env, space, "ann", null, true, {
    kind: "token",
    id: annToken.id,
  });
  const agent: Access = await accessFor(env, space, "ann", "agt-bot", true, {
    kind: "token",
    id: botToken.id,
  });
  let operation = 0;
  const mutate = async (as: Access, timeline: string | undefined, ...mutations: Mutation[]) =>
    value(
      await tracker.mutate(as, {
        contractVersion: 4,
        spaceId: as.spaceId,
        migrationEpoch: as.migrationEpoch,
        operationId: `op-${++operation}`,
        mutations,
        ...(timeline ? { timeline } : {}),
      }),
    );
  const fork = async (slug: string) =>
    value(
      await tracker.createTimeline(ann, {
        slug,
        parent: null,
        repos: [{ id: "app", space: "org", name: "app" }],
        commits: { app: oid(1) },
      }),
    );
  let commit = 10;
  const merge = async (from: string, into: string) =>
    value(
      await tracker.recordTimelinePush({
        repo: { id: "app", spaceId: "org", space: "org", name: "app" },
        actorId: "ann",
        accountableId: "ann",
        pushed: [into],
        merges: [{ into, from, commit: oid(++commit), parent: oid(++commit), refUpdateId: null }],
      }),
    );
  const view = async (timeline?: string): Promise<Snapshot> =>
    value(await tracker.snapshot(ann, timeline));
  const issue = async (id: string, timeline?: string) =>
    (await view(timeline)).issues.find((i) => i.id === id) as Issue;
  /** Claim and complete `id` as `as`, in a timeline or main. */
  const finish = async (as: Access, id: string, timeline?: string, session = "laptop") => {
    const claimed = (
      await mutate(as, timeline, { kind: "issue.claim", id, data: { agent: session } })
    ).results[0]!;
    await mutate(as, timeline, {
      kind: "issue.complete",
      id,
      data: { leaseToken: claimed.leaseToken! },
    });
  };
  const status = async (as: Access, id: string, to: string, timeline?: string) =>
    mutate(as, timeline, {
      kind: "issue.update",
      id,
      expectedVersion: (await issue(id, timeline)).version,
      data: { status: to, ...(to === "canceled" ? { closeReason: "obsolete" } : {}) },
    } as Mutation);
  await mutate(
    ann,
    undefined,
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } },
    { kind: "issue.create", id: "b", data: { teamId: "team", title: "B" } },
  );
  const end = (id: string) =>
    db
      .prepare(`UPDATE timelines SET data = json_set(data, '$.status', 'landed') WHERE id = ?`)
      .run(id);
  return {
    tracker,
    store,
    sql,
    db,
    transactionSync,
    ann,
    agent,
    mutate,
    fork,
    merge,
    view,
    issue,
    finish,
    status,
    end,
  };
}

export type CompletionTracker = Awaited<ReturnType<typeof completionTracker>>;
