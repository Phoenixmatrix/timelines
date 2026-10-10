import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CheckpointView, TimelineDetail } from "../../apps/website/shared/timelines.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";
import { queueFixture, type QueueFixture, type QueueGm, type RepoInventory } from "./queue-e2e.ts";
import type { CiRunList, RepoDetail } from "../../apps/website/shared/api.ts";

type Operation = {
  operationId: string;
  sourceId: string;
  state: string;
  commands: { ref: string; old: string; new: string }[];
};
type Recovery = {
  sourceId: string;
  operationId: string;
  state: "accepted" | "rejected";
  head: string | null;
  recoveryId: string | null;
  fenceCommit: string | null;
  syncRequired: boolean;
};
type Control = {
  barrier: { point: string; hit: number; released: number; operationId: string | null } | null;
};
type Case = { slug: string; cwd: string; sourceId: string; remote: string; before: string };

/** Real Artifacts CAS and CLI recovery; named-dev barriers only interrupt execution. */
export async function runSourcePushRecoveryE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret, "Source recovery requires the named development secret");
  const tag = randomUUID().slice(0, 8);
  const cases: Case[] = [];
  const clones: string[] = [];
  const running: Promise<{ value: string } | { error: unknown }>[] = [];
  let f: QueueFixture | undefined;
  let failure: unknown;
  const errors: unknown[] = [];
  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() >= deadline) {
        record({ event: "source-recovery.timeout", label, last: value });
        throw new Error(`Source recovery timed out: ${label}`);
      }
      await delay(500);
    }
  }
  const control = (s: Case, action: string, extra: object = {}) =>
    f!.json<Control>(
      "/api/dev/source-push-fixtures",
      "POST",
      { sourceId: s.sourceId, action, ...extra },
      [200],
      secret,
    );
  const inspect = async (s: Case, id: string): Promise<Operation> =>
    JSON.parse(await gm(["timeline", "pushes", id], "marco", s.cwd));
  const recover = async (s: Case, id: string): Promise<Recovery> =>
    JSON.parse(await gm(["timeline", "recover-push", id], "marco", s.cwd));
  const head = async (s: Case) =>
    (await f!.git(["ls-remote", s.remote, "refs/heads/work"])).split(/\s/)[0]!;
  const launch = (args: string[], s: Case, fails?: true) => {
    const promise = gm(args, "marco", s.cwd, fails).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    running.push(promise);
    return async () => {
      const result = await promise;
      if ("error" in result) throw result.error;
      return result.value;
    };
  };
  const hit = async (s: Case) => {
    const result = await poll(
      () => control(s, "inspect"),
      ({ barrier }) => barrier?.hit === 1,
      `${s.slug} boundary`,
    );
    assert(result.barrier?.operationId);
    return result.barrier.operationId;
  };
  async function start(name: string, policy: "auto" | "approval" = "auto"): Promise<Case> {
    const slug = `source-recovery-${tag}-${name}`;
    const cwd = join(ctx.work, slug);
    clones.push(cwd);
    await gm(["clone", f!.repo, cwd], "marco");
    await gm(["timeline", "start", slug, "--owner", "orbit", "--policy", policy], "marco", cwd);
    const detail = await f!.json<TimelineDetail>(`/api/tracker/orbit/timelines/${slug}`);
    const source = detail.timeline.repos[0]!.source!;
    assert.equal(source.kind, "timeline-work");
    const s = {
      slug,
      cwd,
      sourceId: source.sourceId,
      remote: `${ctx.origin}/${f!.repo}@${slug}.git`,
      before: "",
    };
    cases.push(s);
    s.before = await head(s);
    await writeFile(join(cwd, "local.txt"), `${slug}\n`);
    await gm(["commit", "-m", `Source recovery ${name}`], "marco", cwd);
    return s;
  }
  async function marker(s: Case, result: Recovery, id: string) {
    assert.equal(result.sourceId, s.sourceId);
    assert.equal(result.operationId, id);
    assert.equal(result.state, "rejected");
    assert.equal(result.syncRequired, true);
    assert(result.recoveryId);
    assert(result.fenceCommit && result.fenceCommit !== s.before);
    assert.equal(result.head, result.fenceCommit);
    assert.equal(await head(s), result.fenceCommit);
    await f!.git(["fetch", s.remote, "refs/heads/work"]);
    assert.equal(await f!.git(["show", "-s", "--format=%P", "FETCH_HEAD"]), s.before);
    assert.equal(
      await f!.git(["rev-parse", "FETCH_HEAD^{tree}"]),
      await f!.git(["rev-parse", `${s.before}^{tree}`]),
      "A recovery fence must not change source files",
    );
  }
  async function publish(s: Case, sync: boolean) {
    if (sync) await gm(["sync"], "marco", s.cwd);
    assert.equal(await readFile(join(s.cwd, "local.txt"), "utf8"), `${s.slug}\n`);
    await gm(["push"], "marco", s.cwd);
    await f!.git(["fetch", s.remote, "refs/heads/work"]);
    assert.equal(await f!.git(["show", "FETCH_HEAD:local.txt"]), s.slug);
    const pending = JSON.parse(await gm(["timeline", "pushes"], "marco", s.cwd)) as {
      operations: Operation[];
    };
    assert.deepEqual(pending.operations, [], "Publication must clear the actual write fence");
  }
  try {
    f = await queueFixture(ctx, fixtures, record);
    await writeFile(
      join(f.root, ".gitmatrix/ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["never-source-recovery-auto"] } },
        jobs: { gate: { if: 'trigger == "landing"', steps: ["true"] } },
      }),
    );
    await f.git(["add", ".gitmatrix/ci.yml"]);
    await f.git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Source recovery fixture gates",
    ]);
    await f.git(["push", "origin", "HEAD:main"]);
    const canonical = await f.tip();

    const before = await start("before-provider");
    await control(before, "arm", { point: "before-provider", mode: "fail" });
    await gm(["push"], "marco", before.cwd, true);
    const beforeId = await hit(before);
    assert.equal((await inspect(before, beforeId)).state, "rejected");
    assert.equal(await head(before), before.before);
    await control(before, "delete");
    await publish(before, false);
    record({ case: "before-provider", operationId: beforeId, rejectedWithoutProviderWrite: true });

    const late = await start("late-original");
    await control(late, "arm", { point: "before-forward", mode: "hold" });
    const original = launch(["push"], late, true);
    const lateId = await hit(late);
    const pending = JSON.parse(await gm(["timeline", "pushes"], "marco", late.cwd)) as {
      operations: Operation[];
    };
    assert(pending.operations.some((operation) => operation.operationId === lateId));
    const localHead = await f.git(["rev-parse", "HEAD"], late.cwd);
    const binding = await readFile(join(late.cwd, ".gitmatrix/agent.local.yml"), "utf8");
    await writeFile(join(late.cwd, "uncommitted.txt"), "authoritative local work\n");
    const fenced = await recover(late, lateId);
    await marker(late, fenced, lateId);
    assert.equal(await f.git(["rev-parse", "HEAD"], late.cwd), localHead);
    assert.equal(await readFile(join(late.cwd, ".gitmatrix/agent.local.yml"), "utf8"), binding);
    assert.equal(
      await readFile(join(late.cwd, "uncommitted.txt"), "utf8"),
      "authoritative local work\n",
    );
    await control(late, "release");
    await original();
    assert.equal(await head(late), fenced.fenceCommit, "The delayed original CAS must lose");
    assert.equal((await inspect(late, lateId)).state, "rejected");
    assert.deepEqual(await recover(late, lateId), fenced);
    await control(late, "delete");
    await gm(["sync"], "marco", late.cwd);
    await gm(["commit", "-m", "Publish preserved local work after recovery"], "marco", late.cwd);
    await publish(late, false);
    assert.equal(
      await readFile(join(late.cwd, "uncommitted.txt"), "utf8"),
      "authoritative local work\n",
    );
    record({
      case: "late-original",
      ...fenced,
      originalCasRejected: true,
      normalSyncPublished: true,
    });

    const mergedFence = await start("merge-checkpoint", "approval");
    await control(mergedFence, "arm", { point: "before-forward", mode: "fail" });
    await launch(["push"], mergedFence, true)();
    const mergedId = await hit(mergedFence);
    const mergedRecovery = await recover(mergedFence, mergedId);
    await marker(mergedFence, mergedRecovery, mergedId);
    await control(mergedFence, "delete");
    await gm(["fetch"], "marco", mergedFence.cwd);
    await gm(
      ["merge", mergedRecovery.fenceCommit!, "-m", "Integrate the proven source recovery fence"],
      "marco",
      mergedFence.cwd,
    );
    await publish(mergedFence, false);
    const mergedHead = await head(mergedFence);
    assert.equal(
      (await f.git(["show", "-s", "--format=%P", "FETCH_HEAD"])).split(" ")[1],
      mergedRecovery.fenceCommit,
      "Exercise the recovery fence as a merge parent, not only linear rebased history",
    );
    const checkpoint = JSON.parse(
      await gm(
        ["timeline", "checkpoint", "-m", "Review normally merged recovery-fence ancestry"],
        "marco",
        mergedFence.cwd,
      ),
    ) as CheckpointView;
    assert.equal(checkpoint.checkpoint.repos[0]!.source?.commit, mergedHead);
    assert.equal(checkpoint.checkpoint.repos[0]!.logicalBase?.commit, mergedFence.before);
    assert.deepEqual(checkpoint.checkpoint.repos[0]!.dependencies, []);
    assert.equal(checkpoint.approved, false, "Recovery provenance must not grant approval");
    record({
      case: "merge-checkpoint",
      fenceCommit: mergedRecovery.fenceCommit,
      head: mergedHead,
      checkpoint: checkpoint.checkpoint.id,
      canonicalBasePreserved: true,
    });

    const accepted = await start("accepted-provider");
    await writeFile(
      join(accepted.cwd, ".gitmatrix/ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["work"] } },
        jobs: { verify: { steps: ["test -f local.txt && echo RECOVERED_SOURCE_CI_OK"] } },
      }),
    );
    await gm(["commit", "-m", "Enable the recovered source's real CI gate"], "marco", accepted.cwd);
    await control(accepted, "arm", { point: "after-provider", mode: "hold" });
    const acceptedOriginal = launch(["push"], accepted);
    const acceptedId = await hit(accepted);
    const proposed = (await inspect(accepted, acceptedId)).commands[0]!.new;
    assert.equal(await head(accepted), proposed);
    const recovered = await recover(accepted, acceptedId);
    assert.equal(recovered.state, "accepted");
    assert.equal(recovered.head, proposed);
    assert.equal(recovered.syncRequired, false);
    const ciPath = `${f.api}/ci?source=${accepted.sourceId}`;
    const delivered = await poll(
      () => f!.json<CiRunList>(ciPath),
      ({ runs }) =>
        runs.some(
          (run) =>
            run.commit === proposed && ["succeeded", "failed", "cancelled"].includes(run.status),
        ),
      "recovered CI completes while the original request remains held",
    );
    const recoveredRun = delivered.runs.find((run) => run.commit === proposed)!;
    assert.equal(recoveredRun.status, "succeeded");
    await control(accepted, "release");
    await acceptedOriginal();
    assert.equal((await inspect(accepted, acceptedId)).state, "accepted");
    assert.deepEqual(await recover(accepted, acceptedId), recovered);
    await control(accepted, "delete");
    await writeFile(join(accepted.cwd, "next.txt"), "ordinary subsequent publication\n");
    await gm(["commit", "-m", "Publish after accepted recovery"], "marco", accepted.cwd);
    await publish(accepted, false);
    const latest = await head(accepted);
    assert.notEqual(latest, proposed);
    const subsequent = await poll(
      () => f!.json<CiRunList>(ciPath),
      ({ runs }) =>
        runs.some(
          (run) =>
            run.commit === latest && ["succeeded", "failed", "cancelled"].includes(run.status),
        ),
      "the subsequent ordinary source CI run",
    );
    const latestRun = subsequent.runs.find((run) => run.commit === latest)!;
    assert.equal(latestRun.status, "succeeded");
    assert.deepEqual(await recover(accepted, acceptedId), recovered);
    const current = await f.json<RepoDetail>(`${f.api}?source=${accepted.sourceId}`);
    assert.equal(current.branches.find((branch) => branch.shortName === "work")?.oid, latest);
    const replayedRuns = (await f.json<CiRunList>(ciPath)).runs;
    assert.deepEqual(
      replayedRuns.filter((run) => run.commit === proposed).map((run) => run.id),
      [recoveredRun.id],
    );
    assert.deepEqual(
      replayedRuns.filter((run) => run.commit === latest).map((run) => run.id),
      [latestRun.id],
    );
    record({
      case: "accepted-provider",
      ...recovered,
      recoveredCi: recoveredRun.number,
      nextCi: latestRun.number,
      historicalReplayPreservedCurrentHead: true,
    });

    const replay = await start("recovery-replay");
    await control(replay, "arm", { point: "before-forward", mode: "fail" });
    await gm(["push"], "marco", replay.cwd, true);
    const replayId = await hit(replay);
    assert.equal((await inspect(replay, replayId)).state, "ambiguous");
    assert.equal(await head(replay), replay.before);
    await control(replay, "arm", { point: "after-recovery-fence", mode: "hold" });
    const firstRecovery = launch(["timeline", "recover-push", replayId], replay);
    assert.equal(await hit(replay), replayId);
    const replayed = await recover(replay, replayId);
    await marker(replay, replayed, replayId);
    await control(replay, "release");
    assert.deepEqual(JSON.parse(await firstRecovery()), replayed);
    assert.deepEqual(await recover(replay, replayId), replayed);
    await control(replay, "delete");
    await publish(replay, true);
    assert.equal(await f.tip(), canonical, "Source recovery must not advance canonical main");
    record({
      case: "recovery-replay",
      ...replayed,
      replayReusedFence: true,
      canonicalUnchanged: true,
    });
  } catch (error) {
    failure = error;
  }
  // Release held real requests before deletion; never clear an authoritative push record.
  for (const s of cases) {
    try {
      await control(s, "delete");
    } catch (error) {
      errors.push(error);
    }
  }
  for (const result of await Promise.all(running))
    if ("error" in result && result.error !== failure) errors.push(result.error);
  if (f) {
    try {
      for (const s of cases) {
        const pending = await f.json<{ operations: Operation[] }>(
          `${f.api}/sources/${s.sourceId}/pushes`,
        );
        for (const operation of pending.operations) {
          record({ event: "source-recovery.cleanup-operation", operation });
          await recover(s, operation.operationId);
        }
      }
      await f.json(f.api, "DELETE", undefined, [200, 202, 204, 404]);
      await f.json(
        "/api/dev/repo-purge",
        "POST",
        { repo: f.repo, action: "resume" },
        [200],
        secret,
      );
      const inventory = await poll(
        () =>
          f!.json<RepoInventory>(
            `/api/dev/repo-inventory?repo=${encodeURIComponent(f!.repo)}`,
            "GET",
            undefined,
            [200],
            secret,
          ),
        (value) => value.deletion?.phase === "done",
        `${f.repo} deletion`,
      );
      assert.equal(inventory.repo, null);
      assert.equal(inventory.artifacts.exists, false);
      assert.deepEqual(inventory.d1, {});
      record({ repo: f.repo, purge: "done" });
      await rm(f.root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const cwd of clones) await rm(cwd, { recursive: true, force: true });
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, errors.map((error) => String(error)).join("; "));
}
