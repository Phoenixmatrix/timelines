import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { freshTrackerStorage } from "../testing/tracker.ts";
import { TrackerStore, type Access } from "./store.ts";
import { TimelineStore, type SourcePush } from "./timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";

const oid = (value: number) => value.toString(16).padStart(40, "0");
const authority = {
  spaceId: "org",
  migrationEpoch: 0,
  personId: "ann",
  agentId: null,
  credential: { kind: "token" as const, id: "ann-token" },
};
async function fixture() {
  const { sql, transactionSync, close, scope, space } = await freshTrackerStorage();
  onTestFinished(close);
  new TrackerStore(sql, transactionSync);
  const store = new TimelineStore(sql, transactionSync);
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    members: [],
    repos: [],
    agentId: null,
    credential: authority.credential,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: true,
  };
  const base: SourceSnapshot = {
    sourceId: "canonical",
    repoId: "repo",
    kind: "canonical",
    timelineId: null,
    ref: "refs/heads/main",
    commit: oid(1),
    tree: oid(10),
  };
  const id = store.reserveTimeline(access, "work", null, "request");
  const reserved = store.reserveWorkSource(
    { id: "repo", space_id: "org" },
    { authority, timelineId: id, timelineSlug: "work", base },
  );
  const creating = store.transitionWorkSource(reserved.source_id, reserved.version, "creating");
  store.transitionWorkSource(
    creating.source_id,
    creating.version,
    "ready",
    "https://provider/work",
  );
  const source = {
    sourceId: reserved.source_id,
    repoId: "repo",
    timelineId: id,
    kind: "timeline-work" as const,
    ref: "refs/heads/work",
  };
  const timeline = store.create(access, {
    id,
    slug: "work",
    parent: null,
    policy: "auto",
    repos: [
      { id: "repo", space: "org", name: "repo", source, logicalBase: base, dependencies: [] },
    ],
    commits: { repo: oid(1) },
  });
  const push: SourcePush = {
    authority,
    operationId: "push1",
    timelineId: id,
    repoId: "repo",
    sourceId: source.sourceId,
    commands: [{ ref: source.ref, old: oid(1), new: oid(2) }],
    actorId: "ann",
    accountableId: "ann",
  };
  const checkpoint = () =>
    store.createCheckpoint(access, "work", {
      repos: [
        {
          id: "repo",
          space: "org",
          name: "repo",
          commit: oid(2),
          base: oid(1),
          source: { ...source, commit: oid(2), tree: oid(20) },
          logicalBase: base,
          dependencies: [],
          changes: [],
        },
      ],
    });
  return { store, access, base, reserved, timeline, source, push, checkpoint };
}

describe("owned source coordination", () => {
  test("settlement cannot invent advances or replace immutable landing identity", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push);
    f.store.finishSourcePush(f.push.operationId, "accepted");
    f.checkpoint();
    const queued = f.store.beginLanding(f.access, "work", {
      authority,
      trigger: "request",
      green: { ok: true, why: null },
      agentId: null,
    }).landing;
    const scope = { spaceId: "org", landingId: queued.id };
    expect(() =>
      f.store.saveLandingForSettlement(scope, { ...queued, state: "landed" }, queued.version),
    ).toThrow(/proven repository effects/);
    const advanced = f.store.saveLanding(
      {
        ...queued,
        state: "advancing",
        repos: queued.repos.map((repo) => ({ ...repo, state: "advanced", merge: oid(3) })),
      },
      queued.version,
      "ann",
    );
    expect(() =>
      f.store.saveLandingForSettlement(
        { ...scope, spaceId: "other" },
        { ...advanced, state: "landed" },
        advanced.version,
      ),
    ).toThrow(/proven repository effects/);
    expect(() =>
      f.store.saveLandingForSettlement(
        scope,
        {
          ...advanced,
          state: "landed",
          repos: advanced.repos.map((repo) => ({ ...repo, merge: oid(4) })),
        },
        advanced.version,
      ),
    ).toThrow(/proven repository effects/);
    const landed = f.store.saveLandingForSettlement(
      scope,
      { ...advanced, state: "landed" },
      advanced.version,
    );
    expect(landed.state).toBe("landed");
    expect(landed.requestedBy).toEqual(queued.requestedBy);
    expect(landed.authority).toEqual(authority);
  });

  test("source allocation and operation provenance cannot cross Space or actor scope", async () => {
    const f = await fixture();
    expect(() =>
      f.store.reserveWorkSource(
        { id: "repo", space_id: "other" },
        { authority, timelineId: f.timeline.id, timelineSlug: "work", base: f.base },
      ),
    ).toThrow(/authorized Space/);
    expect(() =>
      f.store.beginSourcePush({
        ...f.push,
        authority: { ...authority, personId: "other" },
      }),
    ).toThrow(/attribution/);
    expect(f.store.sourcePushes()).toEqual([]);
  });

  test("unacknowledged admission is recoverable without ever permitting its delayed activation", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push, true);
    expect(f.store.sourcePushes("repo")).toMatchObject([{ state: "projecting" }]);
    expect(() => f.store.sourcePush(f.push.operationId, "different", f.source.sourceId)).toThrow(
      /matching/,
    );
    f.store.finishSourcePush(f.push.operationId, "rejected");
    expect(() => f.store.activateSourcePush(f.push.operationId)).toThrow(/interrupted/);
    expect(f.store.sourcePushes("repo")).toEqual([]);
    f.store.beginSourcePush({ ...f.push, operationId: "next" }, true);
    f.store.activateSourcePush("next");
    expect(f.store.sourcePush("next").state).toBe("admitted");
  });
  test("cancellation survives restart and fences reservation, allocation, and readiness", async () => {
    const f = await fixture();
    const { sql, transactionSync, close } = await freshTrackerStorage();
    onTestFinished(close);
    new TrackerStore(sql, transactionSync);
    let store = new TimelineStore(sql, transactionSync);
    const id = store.reserveTimeline(f.access, "partial", null, "request");
    const allocation = store.reserveWorkSource(
      { id: "repo", space_id: "org" },
      { authority, timelineId: id, timelineSlug: "partial", base: f.base },
    );
    const creating = store.transitionWorkSource(
      allocation.source_id,
      allocation.version,
      "creating",
    );
    expect(() =>
      store.cancelReservedCreation({ ...f.access, actorId: "other" }, "partial"),
    ).toThrow(/Only the actor/);
    expect(store.cancelReservedCreation(f.access, "partial")).toMatchObject([
      { source_id: creating.source_id },
    ]);
    store = new TimelineStore(sql, transactionSync);
    expect(() => store.reserveTimeline(f.access, "partial", null, "request")).toThrow(/cancelled/);
    expect(() =>
      store.reserveWorkSource(
        { id: "another", space_id: "org" },
        {
          authority,
          timelineId: id,
          timelineSlug: "partial",
          base: { ...f.base, repoId: "another" },
        },
      ),
    ).toThrow(/cancelled/);
    expect(() => store.transitionWorkSource(creating.source_id, creating.version, "ready")).toThrow(
      /cancelled/,
    );
    const purging = store.transitionWorkSource(creating.source_id, creating.version, "purging");
    store.transitionWorkSource(purging.source_id, purging.version, "purged");
    expect(store.cancelReservedCreation(f.access, "partial")).toMatchObject([{ state: "purged" }]);
    expect(f.store.cancelReservedCreation(f.access, "work")).toBeNull();
  });
  test("reservation retries retain the exact fork snapshot and owned name", async () => {
    const f = await fixture();
    expect(f.store.reserveTimeline(f.access, "work", null, "request")).toBe(f.timeline.id);
    expect(() => f.store.reserveTimeline(f.access, "work", null, "different")).toThrow(/reserved/);
    const retried = f.store.reserveWorkSource(
      { id: "repo", space_id: "org" },
      {
        authority,
        timelineId: f.timeline.id,
        timelineSlug: "work",
        base: { ...f.base, commit: oid(99) },
      },
    );
    expect(retried.artifacts_name).toBe(f.reserved.artifacts_name);
    expect(retried.fork_commit).toBe(oid(1));
  });
  test("migration retains B separately from the initial work tip T across retry", async () => {
    const f = await fixture();
    const allocated = f.store.reserveWorkSource(
      { id: "other", space_id: "org" },
      {
        authority,
        timelineId: f.timeline.id,
        timelineSlug: "work",
        base: { ...f.base, repoId: "other" },
        initialHead: { ...f.base, repoId: "other", commit: oid(8), tree: oid(80) },
      },
    );
    expect(allocated.fork_commit).toBe(oid(1));
    expect(allocated.initial_commit).toBe(oid(8));
    const recovered = f.store.reserveWorkSource(
      { id: "other", space_id: "org" },
      {
        authority,
        timelineId: f.timeline.id,
        timelineSlug: "work",
        base: { ...f.base, repoId: "other", commit: oid(9) },
      },
    );
    expect(recovered.fork_commit).toBe(oid(1));
    expect(recovered.initial_commit).toBe(oid(8));
  });
  test("ambiguous push holds admission and checkpoint fences until reconciled", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push);
    f.store.finishSourcePush(f.push.operationId, "ambiguous");
    expect(() => f.store.beginSourcePush({ ...f.push, operationId: "push2" })).toThrow(
      /reconciliation/,
    );
    expect(() => f.checkpoint()).toThrow(/not reconciled/);
    f.store.finishSourcePush(f.push.operationId, "accepted");
    expect(f.checkpoint().current).toBe(true);
    expect(() => f.store.finishSourcePush(f.push.operationId, "rejected")).toThrow(/settled/);
  });
  test("delayed canonical bookmark cleanup cannot invalidate an owned checkpoint", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push);
    f.store.finishSourcePush(f.push.operationId, "accepted");
    const checkpoint = f.checkpoint();
    const before = f.store.get("work");
    f.store.recordPush({
      repo: { id: "repo", spaceId: "org", space: "org", name: "repo" },
      actorId: "ann",
      accountableId: "ann",
      pushed: [],
      heads: [{ slug: "work", commit: null }],
      merges: [],
    });
    expect(f.store.checkpoint("work", checkpoint.checkpoint.id).current).toBe(true);
    expect(f.store.get("work")).toEqual(before);
  });
  test("landing retries preserve durable CAS identity and prohibit new source writes", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push);
    f.store.finishSourcePush(f.push.operationId, "accepted");
    f.checkpoint();
    const request = {
      authority,
      trigger: "request" as const,
      green: { ok: true, why: null },
      agentId: null,
    };
    const first = f.store.beginLanding(f.access, "work", request).landing;
    expect(() => f.store.beginSourcePush({ ...f.push, operationId: "push2" })).toThrow(/fence/);
    const failed = f.store.saveLanding(
      {
        ...first,
        state: "failed",
        repos: first.repos.map((repo) => ({
          ...repo,
          state: "failed",
          base: oid(1),
          merge: oid(3),
          casIntent: { base: oid(1), candidate: oid(3), tree: oid(20) },
        })),
      },
      first.version,
      "ann",
    );
    expect(() => f.store.beginSourcePush({ ...f.push, operationId: "push2" })).toThrow(/fence/);
    const retried = f.store.beginLanding(f.access, "work", request).landing;
    expect(retried.id).toBe(failed.id);
    expect(retried.repos[0]).toMatchObject({
      state: "tested",
      merge: oid(3),
      casIntent: failed.repos[0]!.casIntent,
    });
  });
  test("retrying the same checkpoint preserves tested candidates without a CAS intent", async () => {
    const f = await fixture();
    f.store.beginSourcePush(f.push);
    f.store.finishSourcePush(f.push.operationId, "accepted");
    f.checkpoint();
    const request = {
      authority,
      trigger: "request" as const,
      green: { ok: true, why: null },
      agentId: null,
    };
    const first = f.store.beginLanding(f.access, "work", request).landing;
    const stopped = f.store.saveLanding(
      {
        ...first,
        state: "failed",
        repos: first.repos.map((repo) => ({
          ...repo,
          state: "tested",
          base: oid(1),
          merge: oid(3),
          mergeRun: { id: "materialization", number: 1 },
          gateRun: { id: "gate", number: 2 },
        })),
      },
      first.version,
      "ann",
    );
    const retried = f.store.beginLanding(f.access, "work", request).landing;
    expect(retried.id).toBe(stopped.id);
    expect(retried.repos[0]).toEqual(stopped.repos[0]);
    expect(() => f.store.beginSourcePush({ ...f.push, operationId: "push2" })).toThrow(/fence/);
  });
  test("purged allocation cannot be revived by a stale creation retry", async () => {
    const f = await fixture();
    const ready = f.store.getWorkSource(f.source.sourceId);
    const purging = f.store.transitionWorkSource(ready.source_id, ready.version, "purging");
    const purged = f.store.transitionWorkSource(ready.source_id, purging.version, "purged");
    expect(f.store.transitionWorkSource(ready.source_id, purging.version, "purged")).toEqual(
      purged,
    );
    expect(() => f.store.transitionWorkSource(ready.source_id, ready.version, "ready")).toThrow(
      /changed/,
    );
  });
});
