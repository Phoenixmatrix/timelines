import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Actor } from "../db.ts";
import { issueToken } from "../api/tokens.ts";
import { inspectCutoverDrain } from "../durable/cutover-drain.ts";
import { afterReplayedPush } from "../git/effects.ts";
import { recordPush, recordRefs } from "../ref-log/record.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { seedSpaceFixture } from "../testing/spaces.ts";
import {
  createLegacyCutoverTestEnvironment,
  cutoverTestManifest,
  CUTOVER_TEST_CHECKPOINT,
} from "../testing/space-cutover.ts";
import { spaceDigest } from "../../shared/space-cutover.ts";
import { CUTOVER_CONSUMERS } from "./control.ts";
import { advanceRefReconciliation, REF_SETTLE_MS, replayRefDivergence } from "./ref-barrier.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));
// Effect delivery (CI, mirror, knowledge, release notes, timelines) has its
// own suites; here the barrier must hand it the repository, real authority
// and the push-log entries it journaled (effects.test.ts covers their delivery).
vi.mock("../git/effects.ts", async (original) => ({
  ...(await original<typeof import("../git/effects.ts")>()),
  afterReplayedPush: vi.fn(async () => {}),
}));

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(afterReplayedPush).mockReset();
  vi.mocked(afterReplayedPush).mockImplementation(async () => {});
});
const oid = (n: number) => n.toString(16).padStart(40, "0");
const legacyRepo = {
  id: "repo",
  artifacts_name: "r-app",
  artifacts_remote: "https://app",
};

/** A legacy store whose push log last saw main at commit 1, as Artifacts holds it. */
async function fixture() {
  const h = createLegacyCutoverTestEnvironment();
  closers.push(() => h.close());
  h.sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name,is_site_admin) VALUES('test-person','user','test-person','Person',1)",
  );
  await seedSpaceFixture(h.env.DB, {
    organization: {
      id: "test-organization",
      slug: "test-person",
      displayName: "Test personal Organization",
      kind: "personal",
      personalAccountId: "test-person",
    },
    space: { id: "test-person", slug: "test-person", displayName: "General" },
    members: [
      {
        accountId: "test-person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "test-person",
  });
  h.sqlite.exec(`
    INSERT INTO repos(id,owner_id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','test-person','test-person','app','private','r-app','https://app');
    INSERT INTO repo_refs(repo_id,source_id,ref,oid) VALUES('repo','canonical','refs/heads/main','${oid(1)}');
  `);
  const token = await issueToken(h.env.DB, "test-person", "Operator", "write");
  const git = fakeRemotes();
  const remote = git.add("https://app", { "refs/heads/main": oid(1) }, "refs/heads/main", "r-app");
  vi.stubGlobal("fetch", git.fetch);
  Reflect.set(h.env, "ARTIFACTS", git.artifacts);
  const run = await h.control.prepare(
    cutoverTestManifest(),
    CUTOVER_TEST_CHECKPOINT,
    "test-person",
    "test-recovery-digest",
  );
  h.control.approve(run.runId, run.manifestDigest, run.checkpoint, "test-person");
  h.control.fence(run.runId);
  await h.control.fenceDatabases(run.runId);
  const operator: Actor = {
    id: "test-person",
    slug: "test-person",
    displayName: "Person",
    isSiteAdmin: true,
    credential: { kind: "token", id: token.id },
  };
  const log = () =>
    h.sqlite
      .prepare(
        "SELECT ref,old_oid,new_oid,actor_id FROM ref_updates WHERE repo_id='repo' ORDER BY id",
      )
      .all();
  const logged = () =>
    h.sqlite
      .prepare("SELECT oid FROM repo_refs WHERE repo_id='repo' AND ref='refs/heads/main'")
      .get()?.oid;
  const updateId = (old: string, next: string) =>
    (
      h.sqlite
        .prepare("SELECT id FROM ref_updates WHERE repo_id='repo' AND old_oid=? AND new_oid=?")
        .get(old, next) as { id: number } | undefined
    )?.id;
  /** Another person in the test Organization, with a write token but no Space grant yet. */
  const person = async (id: string): Promise<Actor> => {
    h.sqlite.exec(`
      INSERT INTO accounts(id,kind,slug,display_name) VALUES('${id}','user','${id}','${id}');
      INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by)
        VALUES('test-organization','${id}','member','test-fixture','test-person');
    `);
    const credential = await issueToken(h.env.DB, id, "Writer", "write");
    return {
      id,
      slug: id,
      displayName: id,
      isSiteAdmin: false,
      credential: { kind: "token", id: credential.id },
    };
  };
  return { ...h, run, remote, operator, log, logged, updateId, person };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The reviewed v4 release, deployed and attested by every consumer. */
function approveSpaceRelease(h: Fixture) {
  const checkpoint = "b".repeat(40);
  const versionId = "reviewed-v4";
  h.control.approveRelease(h.run.runId, checkpoint, versionId, "space", "test-person");
  Reflect.set(h.env, "CUTOVER_DEPLOYMENT_CHECKPOINT", checkpoint);
  Reflect.set(h.env, "CI_VERSION", { id: versionId, tag: checkpoint });
  for (const consumer of CUTOVER_CONSUMERS)
    h.control.acknowledgeRuntime(h.run.runId, consumer, 4, { versionId, checkpoint });
}

/** Drain acknowledgements and protocol-state stores, as control.test.ts exercises them. */
async function migrateToReconciled(h: Fixture) {
  const { control, run } = h;
  control.recordDrainInspection(run.runId, {
    preparationVersionId: run.preparationVersionId,
    blockers: [],
  });
  for (const consumer of CUTOVER_CONSUMERS)
    control.acknowledge(run.runId, consumer, run.checkpoint, 3);
  control.beginMigration(run.runId);
  control.recordPreflight(run.runId);
  const stores = ["application", "registry", `tracker:${run.manifest.mapping[0]!.space.id}`];
  for (const storeId of stores) {
    const payload = JSON.stringify({ storeId, fixture: "protocol checkpoint" });
    control.recordInventory(run.runId, {
      storeId,
      digest: await spaceDigest(payload),
      counts: { business: 0 },
    });
    await control.storePage(run.runId, storeId, 0, {
      cursor: null,
      nextCursor: null,
      payload,
      digest: await spaceDigest(payload),
    });
    control.recordStore(run.runId, storeId, "exported");
  }
  for (const storeId of stores) {
    control.recordStore(run.runId, storeId, "migrated");
    control.recordStore(run.runId, storeId, "reconciled");
  }
  control.recordMapping(run.runId, run.manifest.mapping[0]!.space.id);
  control.complete(run.runId, stores);
  // These stores are reconciled by protocol only. The canonical reconstruction
  // (canonical-schema.ts) also adds Organization avatars, which live reads select.
  h.sqlite.exec("ALTER TABLE organizations ADD COLUMN avatar_key TEXT");
}

describe("Artifacts ref barrier instead of a provider drain", () => {
  test("a write Artifacts accepted under the fence is logged before migration, and only a clean pass lets the stores drain", async () => {
    const h = await fixture();
    // A pre-preparation stream finishes: Artifacts moves main, and the old
    // Worker's bookkeeping is rejected by the storage fence.
    h.remote.refs.set("refs/heads/main", oid(2));
    await expect(recordPush(h.env, legacyRepo, null)).rejects.toThrow("space_cutover_fenced");
    expect(h.logged()).toBe(oid(1));

    const drain = await inspectCutoverDrain(h.env, h.run.runId);
    const codes = drain.blockers.map((blocker) => blocker.code);
    expect(codes).toContain("artifacts_ref_reconciliation_incomplete");
    expect(codes).not.toContain("legacy_external_execution_unverified");

    // The first attempt repairs the push log, then loses its acknowledgement.
    const lost = vi.spyOn(h.control, "recordRefPage").mockImplementationOnce(() => {
      throw new Error("lost page acknowledgement");
    });
    await expect(advanceRefReconciliation(h.env, h.run.runId)).rejects.toThrow("acknowledgement");
    lost.mockRestore();
    expect(h.logged()).toBe(oid(2));
    expect(h.log()).toEqual([
      { ref: "refs/heads/main", old_oid: oid(1), new_oid: oid(2), actor_id: null },
    ]);
    // Ordinary writers are still fenced: only the run's own authority repaired it.
    await expect(
      h.env.DB.prepare("DELETE FROM repo_refs WHERE repo_id='repo'").run(),
    ).rejects.toThrow("space_cutover_fenced");

    // The retried page finds nothing new, but its pass still saw the divergence.
    let status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.stages.fenced.latest).toMatchObject({ complete: true, divergent: 1 });
    expect(status.stages.fenced.clean).toBe(false);
    expect(status.pendingReplays).toBe(1);
    h.control.recordDrainInspection(h.run.runId, {
      preparationVersionId: h.run.preparationVersionId,
      blockers: [],
    });
    for (const consumer of CUTOVER_CONSUMERS)
      h.control.acknowledge(h.run.runId, consumer, h.run.checkpoint, 3);
    expect(() => h.control.beginMigration(h.run.runId)).toThrow("Artifacts refs must reconcile");
    // Push effects are new-epoch work: never replayed while fenced.
    const [replay] = h.control.pendingRefReplays(h.run.runId, 1);
    expect(replay).toMatchObject({
      stage: "fenced",
      changes: [{ ref: "refs/heads/main", old: oid(1), new: oid(2) }],
    });
    expect(() => h.control.settleRefReplay(h.run.runId, replay!)).toThrow("admission opened");

    status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.stages.fenced).toMatchObject({
      clean: true,
      latest: { complete: true, divergent: 0, targets: 1 },
    });
    const ready = await inspectCutoverDrain(h.env, h.run.runId);
    expect(ready.blockers.map((blocker) => blocker.code)).not.toContain(
      "artifacts_ref_divergence_unreconciled",
    );
    h.control.recordDrainInspection(h.run.runId, {
      preparationVersionId: h.run.preparationVersionId,
      blockers: [],
    });
    h.control.beginMigration(h.run.runId);
    // No repair while a store is checkpointed or transformed.
    await expect(advanceRefReconciliation(h.env, h.run.runId)).rejects.toThrow("unavailable");
    expect(afterReplayedPush).not.toHaveBeenCalled();
  });

  test("admission stays closed while a write that landed during migration is unlogged; after opening, later writes replay forward under a human's authority", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await fixture();
    const clean = await advanceRefReconciliation(h.env, h.run.runId);
    expect(clean.stages.fenced.clean).toBe(true);
    await migrateToReconciled(h);

    // A write Artifacts accepted while the stores were migrating.
    h.remote.refs.set("refs/heads/main", oid(3));
    approveSpaceRelease(h);
    await expect(h.control.openWriteAdmission(h.run.runId)).rejects.toThrow(
      "Artifacts refs must reconcile",
    );
    let status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.stages["pre-open"]).toMatchObject({
      clean: false,
      latest: { phase: "reconciled", complete: true, divergent: 1 },
    });
    expect(h.logged()).toBe(oid(3));
    await expect(h.control.openWriteAdmission(h.run.runId)).rejects.toThrow(
      "Artifacts refs must reconcile",
    );
    status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.stages["pre-open"].clean).toBe(true);
    await h.control.openWriteAdmission(h.run.runId);
    expect(h.control.status()?.phase).toBe("active");

    // A late move after opening, before the post-open pass.
    h.remote.refs.set("refs/heads/main", oid(4));
    // Without a person nothing replays, but the pass still runs; and a fresh
    // post-open divergence waits, in case a live push is still logging itself.
    status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(afterReplayedPush).not.toHaveBeenCalled();
    expect(status.pendingReplays).toBe(1);
    expect(status.stages["post-open"]).toMatchObject({
      clean: false,
      latest: { phase: "active", complete: true, divergent: 0, deferred: 1 },
    });
    expect(h.logged()).toBe(oid(3));

    // The migration-time divergence replays for a person, from its journaled entry.
    status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(status.pendingReplays).toBe(0);
    expect(afterReplayedPush).toHaveBeenCalledTimes(1);
    const [, repo, actor, authority, logged] = vi.mocked(afterReplayedPush).mock.calls[0]!;
    expect(repo).toMatchObject({
      id: "repo",
      space_id: "test-person",
      space_slug: "test-person",
      artifacts_name: "r-app",
    });
    expect(actor).toBe(h.operator);
    expect(authority).toMatchObject({
      spaceId: "test-person",
      migrationEpoch: h.run.migrationEpoch,
      personId: "test-person",
      agentId: null,
    });
    // Timeline activity and mentions come from the logged update itself:
    // repo_refs has already moved past it.
    expect(logged).toEqual([
      expect.objectContaining({
        id: h.updateId(oid(1), oid(3)),
        ref: "refs/heads/main",
        old: oid(1),
        new: oid(3),
      }),
    ]);
    // Still unrepaired: the same observation must hold for REF_SETTLE_MS.
    expect(status.stages["post-open"].latest).toMatchObject({ divergent: 0, deferred: 1 });
    expect(h.logged()).toBe(oid(3));

    vi.setSystemTime(Date.now() + REF_SETTLE_MS);
    status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(status.stages["post-open"]).toMatchObject({
      clean: false,
      latest: { phase: "active", complete: true, divergent: 1, deferred: 0 },
    });
    expect(status.pendingReplays).toBe(1);
    expect(h.logged()).toBe(oid(4));
    status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(afterReplayedPush).toHaveBeenCalledTimes(2);
    expect(vi.mocked(afterReplayedPush).mock.calls[1]![4]).toEqual([
      expect.objectContaining({ id: h.updateId(oid(3), oid(4)), old: oid(3), new: oid(4) }),
    ]);
    expect(status.stages["post-open"]).toMatchObject({
      clean: true,
      latest: { complete: true, divergent: 0, deferred: 0 },
    });
    expect(h.log()).toEqual([
      { ref: "refs/heads/main", old_oid: oid(1), new_oid: oid(3), actor_id: null },
      { ref: "refs/heads/main", old_oid: oid(3), new_oid: oid(4), actor_id: null },
    ]);
    // Forward-only: the barrier never reopens a restoration path.
    expect(() => h.control.recover(h.run.runId)).toThrow("forward-only");
  });

  test("a live push during the post-open pass keeps its pusher: the divergence waits while Git is in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await fixture();
    await advanceRefReconciliation(h.env, h.run.runId);
    await migrateToReconciled(h);
    approveSpaceRelease(h);
    await advanceRefReconciliation(h.env, h.run.runId);
    await h.control.openWriteAdmission(h.run.runId);

    // Artifacts accepted a live push whose request is still finishing.
    const push = h.control.acquire("http-git-registry", 4);
    h.remote.refs.set("refs/heads/main", oid(5));
    let status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(status.stages["post-open"].latest).toMatchObject({ divergent: 0, deferred: 1 });
    // However long it takes, nothing is repaired while a Git request is admitted.
    vi.setSystemTime(Date.now() + 2 * REF_SETTLE_MS);
    status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(status.stages["post-open"].latest).toMatchObject({ divergent: 0, deferred: 1 });
    expect(h.logged()).toBe(oid(1));

    // The push logs itself, with its pusher (as recordPush does), and finishes.
    await recordRefs(
      h.env.DB,
      "repo",
      new Map([["refs/heads/main", oid(5)]]),
      { id: "test-person" },
      async () => ({ commits: [], truncated: false }),
    );
    h.control.release(push.ticket);
    vi.setSystemTime(Date.now() + REF_SETTLE_MS);
    status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(status.stages["post-open"]).toMatchObject({
      clean: true,
      latest: { divergent: 0, deferred: 0 },
    });
    expect(h.log()).toEqual([
      { ref: "refs/heads/main", old_oid: oid(1), new_oid: oid(5), actor_id: "test-person" },
    ]);
    expect(status.pendingReplays).toBe(0);
    expect(afterReplayedPush).not.toHaveBeenCalled();
  });

  test("a replay that cannot run is blocked with its reason, never holding up the others or the pass; a Space writer re-triggers it", async () => {
    const h = await fixture();
    // One write lands under the fence, another while the stores migrate.
    h.remote.refs.set("refs/heads/main", oid(2));
    await advanceRefReconciliation(h.env, h.run.runId);
    await advanceRefReconciliation(h.env, h.run.runId);
    await migrateToReconciled(h);
    h.remote.refs.set("refs/heads/main", oid(3));
    approveSpaceRelease(h);
    await advanceRefReconciliation(h.env, h.run.runId);
    await advanceRefReconciliation(h.env, h.run.runId);
    await h.control.openWriteAdmission(h.run.runId);
    expect((await advanceRefReconciliation(h.env, h.run.runId)).pendingReplays).toBe(2);

    vi.mocked(afterReplayedPush).mockRejectedValueOnce(new Error("mirror enqueue failed"));
    let status = await advanceRefReconciliation(h.env, h.run.runId, { actor: h.operator });
    expect(afterReplayedPush).toHaveBeenCalledTimes(2);
    expect(status.pendingReplays).toBe(0);
    expect(status.blockedReplays).toBe(1);
    expect(status.blocked).toEqual([
      {
        pass: 1,
        repoId: "repo",
        sourceId: "canonical",
        reason: "Replay failed: mirror enqueue failed",
      },
    ]);
    // The barrier's own pass still completes.
    expect(status.stages["post-open"].clean).toBe(true);

    // A person without write access in the Space can't run it: still blocked, with why.
    const writer = await h.person("writer");
    status = await replayRefDivergence(
      h.env,
      h.run.runId,
      { pass: 1, repoId: "repo", sourceId: "canonical" },
      writer,
    );
    expect(status.blocked[0]?.reason).toBe(
      "Needs a person with write access in test-person to replay it.",
    );
    expect(afterReplayedPush).toHaveBeenCalledTimes(2);
    h.sqlite.exec(
      "INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by) VALUES('test-person','test-organization','writer','member','write','read','test-fixture','test-person')",
    );
    status = await replayRefDivergence(
      h.env,
      h.run.runId,
      { pass: 1, repoId: "repo", sourceId: "canonical" },
      writer,
    );
    expect(status.blockedReplays).toBe(0);
    expect(afterReplayedPush).toHaveBeenCalledTimes(3);
    const [, , actor, authority, logged] = vi.mocked(afterReplayedPush).mock.calls[2]!;
    expect(actor).toBe(writer);
    expect(authority).toMatchObject({ personId: "writer", spaceId: "test-person" });
    expect(logged).toEqual([
      expect.objectContaining({ id: h.updateId(oid(1), oid(2)), old: oid(1), new: oid(2) }),
    ]);
    // Nothing is left to re-trigger.
    await expect(
      replayRefDivergence(
        h.env,
        h.run.runId,
        { pass: 1, repoId: "repo", sourceId: "canonical" },
        writer,
      ),
    ).rejects.toThrow("No such replay");
  });

  test("after a legacy reopening the pass still logs late writes, and journaled replays are blocked with why, never left pending", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await fixture();
    h.remote.refs.set("refs/heads/main", oid(2));
    await advanceRefReconciliation(h.env, h.run.runId);
    await advanceRefReconciliation(h.env, h.run.runId);
    await migrateToReconciled(h);
    await advanceRefReconciliation(h.env, h.run.runId);
    h.control.recover(h.run.runId);
    await h.control.establishRecoveryFences(h.run.runId);
    const stores = Object.keys(h.control.status()!.stores);
    for (const store of stores) h.control.recordStore(h.run.runId, store, "restored");
    h.control.finishRestore(h.run.runId, stores);
    await advanceRefReconciliation(h.env, h.run.runId);
    expect(h.control.refStageClean(h.run.runId, "pre-open", "restored")).toBe(true);
    // The legacy release handshake (participant release, runtime attestation)
    // is control.test.ts's; here the journal stands where it leaves the run.
    const run = h.control.status()!;
    run.releaseApproval = {
      id: "legacy-release",
      checkpoint: run.checkpoint,
      versionId: run.preparationVersionId,
      mode: "legacy",
      operatorId: "test-person",
      at: new Date().toISOString(),
    };
    run.phase = "legacy-active";
    run.storageFenced = false;
    Reflect.get(h.control, "save").call(h.control, run);
    h.sqlite.exec("UPDATE _space_cutover_fence SET fenced=0,bypass=0 WHERE id=1");

    h.remote.refs.set("refs/heads/main", oid(3));
    let status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.pendingReplays).toBe(0);
    expect(status.blocked).toEqual([
      expect.objectContaining({
        pass: 1,
        reason: expect.stringContaining("Legacy reopening"),
      }),
    ]);
    expect(status.stages["post-open"].latest).toMatchObject({
      phase: "legacy-active",
      deferred: 1,
    });
    vi.setSystemTime(Date.now() + REF_SETTLE_MS);
    status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(h.logged()).toBe(oid(3));
    status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status).toMatchObject({ pendingReplays: 0, blockedReplays: 2 });
    expect(status.stages["post-open"].clean).toBe(true);
    expect(afterReplayedPush).not.toHaveBeenCalled();
    // Re-triggering needs Space admission: a legacy journal's replays stay blocked.
    await expect(
      replayRefDivergence(
        h.env,
        h.run.runId,
        { pass: 1, repoId: "repo", sourceId: "canonical" },
        h.operator,
      ),
    ).rejects.toThrow("Space write admission");
  });

  test("a restoration discards the reconciled stores' repairs, so legacy reopening needs its own clean pass", async () => {
    const h = await fixture();
    await advanceRefReconciliation(h.env, h.run.runId);
    await migrateToReconciled(h);
    const status = await advanceRefReconciliation(h.env, h.run.runId);
    expect(status.stages["pre-open"].clean).toBe(true);
    h.control.recover(h.run.runId);
    await h.control.establishRecoveryFences(h.run.runId);
    const stores = Object.keys(h.control.status()!.stores);
    for (const store of stores) h.control.recordStore(h.run.runId, store, "restored");
    h.control.finishRestore(h.run.runId, stores);
    expect(h.control.refStageClean(h.run.runId, "pre-open", "restored")).toBe(false);
    const restored = await advanceRefReconciliation(h.env, h.run.runId);
    expect(restored.stages["pre-open"]).toMatchObject({
      clean: true,
      latest: { phase: "restored", complete: true },
    });
    expect(h.control.refStageClean(h.run.runId, "pre-open", "restored")).toBe(true);
  });
});
