import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Landing, TimelineDetail } from "../../apps/website/shared/timelines.ts";
import { queueFixture, type QueueFixture, type QueueGm, type RepoInventory } from "./queue-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

/** A8: external native clones plus the compiled CLI, with exact object/ref evidence. */
export async function runSourceSyncE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret);
  const owned: QueueFixture[] = [];
  const clones: string[] = [];
  const tag = randomUUID().slice(0, 8);
  const errors: unknown[] = [];
  const poll = async <T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
    timeout = 300_000,
  ) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      assert(Date.now() < deadline, `${label}: deadline exceeded`);
      await delay(1_000);
    }
  };
  const denied = async (cwd: string, args: string[], code: string) => {
    const env: NodeJS.ProcessEnv = {
      ...ctx.env,
      GM_SERVER: ctx.origin,
      GM_TOKEN: fixtures.tokens.marco,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const key of Object.keys(env))
      if (
        /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key) ||
        key === "SSH_AUTH_SOCK" ||
        key === "GITMATRIX_TOKEN"
      )
        delete env[key];
    const result = await new Promise<{ failed: boolean; stderr: string }>((resolve) => {
      execFile(
        ctx.gm,
        ["--output", "json", ...args],
        { cwd, env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
        (error, _stdout, stderr) => resolve({ failed: error !== null, stderr }),
      );
    });
    assert(result.failed, `Expected typed ${code} rejection`);
    const error = JSON.parse(result.stderr) as { error: { code: string } };
    assert.equal(error.error.code, code);
    record({ client: "gm", command: args[0], rejection: error.error.code });
  };
  try {
    const f = await queueFixture(ctx, fixtures, record);
    owned.push(f);
    const nativeCommit = async (cwd: string, file: string, text: string, message: string) => {
      await writeFile(join(cwd, file), text);
      await f.git(["add", file], cwd);
      await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", message], cwd);
      return f.git(["rev-parse", "HEAD"], cwd);
    };
    await nativeCommit(
      f.root,
      ".gitmatrix/ci.yml",
      JSON.stringify({
        on: { push: { branches: ["never-source-sync-auto"] } },
        jobs: {
          gate: {
            if: 'trigger == "landing"',
            steps: [
              {
                run: 'test "$(git log -1 --format=%P | wc -w)" = 1',
              },
            ],
          },
        },
      }),
      "Single-parent source sync fixture gate",
    );
    await nativeCommit(f.root, "shared.txt", "base\n", "Sync conflict baseline");
    await f.git(["push", "origin", "HEAD:main"]);
    const base = await f.tip();
    const path = (slug: string) => `/api/tracker/orbit/timelines/${slug}`;
    const slug = `source-sync-${tag}`;
    const author = join(ctx.work, `${slug}-author`);
    clones.push(author);
    await gm(["clone", f.repo, author], "marco");
    await gm(["timeline", "start", slug, "--space", "orbit", "--policy", "auto"], "marco", author);
    await writeFile(join(author, "approved.txt"), "approved snapshot\n");
    await gm(["commit", "-m", "Approved source snapshot"], "marco", author);
    await gm(["push"], "marco", author);
    const detail = await f.json<TimelineDetail>(path(slug));
    const source = detail.timeline.repos[0]!.source!;
    assert.equal(source.kind, "timeline-work");
    const remote = `${ctx.origin}/${f.repo}@${slug}.git`;
    const admitted = (await f.git(["ls-remote", remote, "refs/heads/work"])).split(/\s/)[0]!;
    assert.notEqual(admitted, base);
    const clone = async (name: string) => {
      const cwd = join(ctx.work, `${slug}-${name}`);
      clones.push(cwd);
      await gm(["clone", f.repo, cwd], "marco");
      await f.git(["config", "user.name", "Source Sync Fixture"], cwd);
      await f.git(["config", "user.email", "source-sync@example.invalid"], cwd);
      await gm(["timeline", "use", slug, "--space", "orbit"], "marco", cwd);
      return cwd;
    };
    const late = await clone("late");
    const revised = await clone("revised");
    const conflict = await clone("conflict");
    const expired = await clone("expired");
    const divergent = await clone("divergent");
    await f.git(["checkout", "--detach", base], divergent);
    await nativeCommit(
      divergent,
      "divergent.txt",
      "unrelated local stack\n",
      "Not based on admitted source",
    );
    await f.git(["branch", "divergent-local", "HEAD"], divergent);
    const lateOid = await nativeCommit(
      late,
      "suffix.txt",
      "local suffix only\n",
      "Unpushed local suffix",
    );
    await nativeCommit(
      conflict,
      "shared.txt",
      "local conflicting suffix\n",
      "Conflicting local suffix",
    );
    await nativeCommit(
      expired,
      "expired-local.txt",
      "preserve after source expiry\n",
      "Late work before retention",
    );
    // Native object rewriting preserves gm's real change-id header while changing the tree.
    await writeFile(join(revised, "approved.txt"), "locally edited same change\n");
    await f.git(["add", "approved.txt"], revised);
    const tree = await f.git(["write-tree"], revised);
    const original = await f.git(["cat-file", "commit", admitted], revised, true);
    assert.match(original, /^change-id /m);
    const objectFile = join(ctx.work, `${slug}-commit-object`);
    clones.push(objectFile);
    await writeFile(objectFile, original.replace(/^tree [a-f0-9]+/m, `tree ${tree}`));
    const revisedOid = await f.git(["hash-object", "-t", "commit", "-w", objectFile], revised);
    await f.git(["checkout", "--detach", revisedOid], revised);
    await f.git(["branch", "same-change", revisedOid], revised);
    assert.notEqual(revisedOid, admitted);
    assert.equal(
      (await f.git(["cat-file", "commit", revisedOid], revised, true)).match(
        /^change-id .+$/m,
      )?.[0],
      original.match(/^change-id .+$/m)?.[0],
    );
    // A canonical independent update supplies a normal conflict during late suffix replay.
    const moved = await nativeCommit(
      f.root,
      "shared.txt",
      "canonical changed after fork\n",
      "Independent canonical update",
    );
    await f.git(["push", "origin", "HEAD:main"]);
    await f.json(`${path(slug)}/checkpoints`, "POST", { summary: "Late exact source sync" }, [201]);
    const landed = await poll(
      () => f.json<{ landing: Landing | null }>(`${path(slug)}/landing`),
      ({ landing }) =>
        !!landing && ["landed", "failed", "conflict", "blocked_dependency"].includes(landing.state),
      "compact source landing",
    );
    assert.equal(landed.landing?.state, "landed");
    const canonical = await f.tip();
    await f.git(["fetch", "origin", "main"]);
    assert.equal(await f.git(["show", "-s", "--format=%P", canonical]), moved);
    const canonicalOnly = join(ctx.work, `${slug}-canonical-only`);
    clones.push(canonicalOnly);
    await f.git(["clone", "--no-local", `${ctx.origin}/${f.repo}.git`, canonicalOnly]);
    for (const oid of [admitted, lateOid, revisedOid]) {
      await assert.rejects(() => f.git(["cat-file", "-e", oid], canonicalOnly));
      await f.json(`${f.api}/commits?source=canonical&ref=${oid}`, "GET", undefined, [404]);
      await assert.rejects(() => f.git(["fetch", "origin", oid], canonicalOnly));
      assert(!(await f.git(["rev-list", "--all"], canonicalOnly)).split("\n").includes(oid));
    }
    const guard = await readFile(join(late, ".gitmatrix/agent.local.yml"), "utf8");
    await denied(late, ["push"], "timeline_ended");
    await gm(["sync"], "marco", late);
    assert.equal(await readFile(join(late, "suffix.txt"), "utf8"), "local suffix only\n");
    assert.equal(
      await readFile(join(late, "shared.txt"), "utf8"),
      "canonical changed after fork\n",
    );
    assert.equal(await readFile(join(late, ".gitmatrix/agent.local.yml"), "utf8"), guard);
    await f.git(["merge-base", "--is-ancestor", canonical, "HEAD"], late);
    const suffix = (await f.git(["rev-list", `HEAD`, `^${canonical}`], late))
      .split("\n")
      .filter(Boolean);
    assert.equal(suffix.length, 1);
    assert.equal(await f.git(["show", "-s", "--format=%P", "HEAD"], late), canonical);
    assert.equal(await f.git(["show", "HEAD:suffix.txt"], late), "local suffix only");
    assert(!suffix.includes(admitted));
    const head = await f.git(["rev-parse", "HEAD"], late);
    const bookmarks = await f.git(
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
      late,
    );
    await gm(["sync"], "marco", late);
    assert.equal(await f.git(["rev-parse", "HEAD"], late), head);
    assert.equal(
      await f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], late),
      bookmarks,
    );
    await denied(late, ["push"], "timeline_ended");
    await gm(["timeline", "use", "main", "--space", "orbit"], "marco", late);
    const mainChoice = JSON.parse(
      await gm(["timeline", "list", "--space", "orbit"], "marco", late),
    );
    assert.equal(mainChoice.current, null);
    await gm(["push"], "marco", late);
    assert.equal(await f.tip(), canonical);

    await gm(["sync"], "marco", revised);
    assert.equal(
      await readFile(join(revised, "approved.txt"), "utf8"),
      "locally edited same change\n",
    );
    await f.git(["merge-base", "--is-ancestor", canonical, "HEAD"], revised);
    const retained = await f.git(["rev-parse", "refs/heads/same-change"], revised);
    assert.equal(
      await f.git(["show", `${retained}:approved.txt`], revised),
      "locally edited same change",
    );
    assert.equal(await f.git(["show", "-s", "--format=%P", retained], revised), canonical);
    await denied(revised, ["push"], "timeline_ended");
    const continuation = `${slug}-continuation`;
    await gm(
      ["timeline", "start", continuation, "--space", "orbit", "--policy", "approval"],
      "marco",
      revised,
    );
    await writeFile(join(revised, "continued.txt"), "explicit continuation\n");
    await gm(["commit", "-m", "Explicit continuation"], "marco", revised);
    await gm(["push"], "marco", revised);
    const continued = await f.json<TimelineDetail>(path(continuation));
    const continuedSource = continued.timeline.repos[0]!.source!;
    assert.notEqual(continuedSource.sourceId, source.sourceId);
    const continuedTip = (
      await f.git(["ls-remote", `${ctx.origin}/${f.repo}@${continuation}.git`, "refs/heads/work"])
    ).split(/\s/)[0]!;
    assert.equal(
      await f.git(["show", `${continuedTip}:continued.txt`], revised),
      "explicit continuation",
    );
    assert.equal(
      await f.git(["show", `${continuedTip}:approved.txt`], revised),
      "locally edited same change",
    );
    assert.equal(await f.tip(), canonical);
    assert.equal(
      await f.git(["ls-remote", remote, "refs/heads/work"]),
      `${admitted}\trefs/heads/work`,
    );
    assert.equal((await f.json<TimelineDetail>(path(slug))).timeline.status, "landed");

    const oldConflict = await f.git(["rev-parse", "HEAD"], conflict);
    await gm(["sync"], "marco", conflict);
    const status = JSON.parse(await gm(["status"], "marco", conflict));
    assert(
      status.conflicts.some((entry: { paths: string[] }) => entry.paths.includes("shared.txt")),
    );
    const recovery = (
      await f.git(
        ["for-each-ref", "--format=%(objectname)", `refs/gm/source-sync/${source.sourceId}`],
        conflict,
      )
    ).split("\n");
    assert(recovery.length > 0);
    assert(
      await Promise.all(
        recovery.map(async (oid) => {
          try {
            await f.git(["merge-base", "--is-ancestor", oldConflict, oid], conflict);
            return true;
          } catch {
            return false;
          }
        }),
      ).then((results) => results.some(Boolean)),
    );
    assert.equal(
      await f.git(["show", `${oldConflict}:shared.txt`], conflict),
      "local conflicting suffix",
    );
    await writeFile(join(conflict, "shared.txt"), "resolved local and canonical\n");
    await gm(["status"], "marco", conflict);
    assert.equal(
      await readFile(join(conflict, "shared.txt"), "utf8"),
      "resolved local and canonical\n",
    );
    await denied(conflict, ["push"], "timeline_ended");

    await gm(["status"], "marco", divergent);
    const divergentHead = await f.git(["rev-parse", "HEAD"], divergent);
    const divergentRefs = await f.git(
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
      divergent,
    );
    await denied(divergent, ["sync"], "source_lineage_unresolved");
    assert.equal(await f.git(["rev-parse", "HEAD"], divergent), divergentHead);
    assert.equal(
      await f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], divergent),
      divergentRefs,
    );
    assert.equal(
      await readFile(join(divergent, "divergent.txt"), "utf8"),
      "unrelated local stack\n",
    );

    // An abandoned divergent source has no exact integration receipt: refusing must be atomic.
    const unknownSlug = `${slug}-unknown`;
    await gm(
      ["timeline", "start", unknownSlug, "--space", "orbit", "--policy", "approval"],
      "marco",
      late,
    );
    await writeFile(join(late, "unknown.txt"), "never admitted\n");
    await gm(["commit", "-m", "Unknown divergent work"], "marco", late);
    await gm(["push"], "marco", late);
    await f.json(`${path(unknownSlug)}/abandon`, "POST", {}, [200]);
    await gm(["status"], "marco", late);
    const beforeUnknown = await f.git(["rev-parse", "HEAD"], late);
    const beforeRefs = await f.git(
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
      late,
    );
    await denied(late, ["sync"], "source_lineage_unresolved");
    assert.equal(await f.git(["rev-parse", "HEAD"], late), beforeUnknown);
    assert.equal(
      await f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], late),
      beforeRefs,
    );
    assert.equal(await readFile(join(late, "unknown.txt"), "utf8"), "never admitted\n");
    await gm(["status"], "marco", expired);
    const expiredHead = await f.git(["rev-parse", "HEAD"], expired);
    const expiredRefs = await f.git(
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
      expired,
    );
    const expiredBinding = await readFile(join(expired, ".gitmatrix/agent.local.yml"), "utf8");
    await f.json(
      "/api/dev/source-retention",
      "POST",
      {
        action: "expire",
        repo: f.repo,
        timeline: slug,
        sourceId: source.sourceId,
      },
      [200],
      secret,
    );
    await poll(
      () =>
        f.json<{ status: string }>(
          `${f.api}/sources/${source.sourceId}/lineage?commit=${admitted}`,
        ),
      (value) => value.status === "expired",
      "targeted source expiry",
    );
    await denied(expired, ["sync"], "source_expired");
    assert.equal(await f.git(["rev-parse", "HEAD"], expired), expiredHead);
    assert.equal(
      await f.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], expired),
      expiredRefs,
    );
    assert.equal(
      await readFile(join(expired, ".gitmatrix/agent.local.yml"), "utf8"),
      expiredBinding,
    );
    assert.equal(
      await readFile(join(expired, "expired-local.txt"), "utf8"),
      "preserve after source expiry\n",
    );
    await denied(expired, ["push"], "source_expired");
    assert.equal(await f.tip(), canonical);
    record({
      sourceSync: {
        source: source.sourceId,
        admitted,
        canonical,
        suffixHead: head,
        revised: retained,
        singleParent: true,
        retryIdempotent: true,
        bothExplicitChoices: true,
        unknownAtomic: true,
        divergentAtomic: true,
        conflictRecovery: true,
        expiredSyncRefused: true,
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    for (const f of owned) {
      try {
        await f.json(f.api, "DELETE", undefined, [200, 202, 204, 404]);
        await f.json(
          "/api/dev/repo-purge",
          "POST",
          { repo: f.repo, action: "resume" },
          [200],
          secret,
        );
        const inventory: RepoInventory = await poll<RepoInventory>(
          () =>
            f.json<RepoInventory>(
              `/api/dev/repo-inventory?repo=${encodeURIComponent(f.repo)}`,
              "GET",
              undefined,
              [200],
              secret,
            ),
          (value) => value.deletion?.phase === "done",
          "source sync fixture purge",
          900_000,
        );
        assert.equal(inventory.repo, null);
        assert.equal(inventory.artifacts.exists, false);
        assert.deepEqual(inventory.d1, {});
        record({ sourceSyncCleanup: "purged", repo: f.repo });
        await rm(f.root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    for (const cwd of clones)
      await rm(cwd, { recursive: true, force: true }).catch((error) => errors.push(error));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Source sync verification or owned cleanup failed");
}
