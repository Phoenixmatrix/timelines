import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Landing, TimelineDetail, TimelineRepo } from "../../apps/website/shared/timelines.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";
import type { CiLogs, CiRunDetail, CiRunList } from "../../apps/website/shared/api.ts";
import {
  queueFixture,
  type QueueGm,
  type QueueFixture as Fixture,
  type RepoInventory,
} from "./queue-e2e.ts";

interface Scenario {
  slug: string;
  first: TimelineRepo;
  second: TimelineRepo;
  fa: Fixture;
  fb: Fixture;
  sources: Map<string, string>;
}
type Receipt = {
  id: string;
  landing_id: string;
  repo_id: string;
  source_commit: string;
  canonical_base: string;
  canonical_commit: string;
  status: string;
};
type Control = {
  barrier: { point: string; hit: number; released: number } | null;
  receipts: Receipt[];
};

/** Real two-repository compact jobs, gates, native CAS, ledger and public retry.
 * Faults only stop execution at durable boundaries; they never seed modern success.
 */
export async function runSourceLandingE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret, "Landing fixtures require the named development secret");
  const owned: Fixture[] = [];
  const slugs: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let phase: { name: string; started: number } | undefined;
  const finishPhase = (outcome: "passed" | "failed") => {
    if (!phase) return;
    record({
      event: "e2e.phase",
      name: `source-landing.${phase.name}`,
      elapsedMs: performance.now() - phase.started,
      outcome,
    });
    phase = undefined;
  };
  const beginPhase = (name: string) => {
    finishPhase("passed");
    phase = { name, started: performance.now() };
  };
  const path = (slug: string) => `/api/tracker/orbit/timelines/${slug}`;
  async function poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
    timeout = 300_000,
  ): Promise<T> {
    const deadline = performance.now() + timeout;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      assert(performance.now() < deadline, `Landing fixture timed out: ${label}`);
      await delay(1000);
    }
  }
  const commit = async (f: Fixture, file: string, content: string) => {
    await writeFile(join(f.root, file), content);
    await f.git(["add", file]);
    await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", `Landing fixture ${file}`]);
    return f.git(["rev-parse", "HEAD"]);
  };
  let failure: unknown;
  try {
    beginPhase("fixture");
    const a = await queueFixture(ctx, fixtures, record);
    owned.push(a);
    const b = await queueFixture(ctx, fixtures, record);
    owned.push(b);
    for (const f of owned) {
      await commit(
        f,
        ".gitmatrix/ci.yml",
        JSON.stringify({
          on: { push: { branches: ["never-agent-auto"] } },
          jobs: {
            gate: {
              if: 'trigger == "landing"',
              steps: [
                {
                  run: 'test "$(git log -1 --format=%P | wc -w)" = 1 && test ! -f landing-fail.txt && echo COMPACT_GATE_OK',
                },
              ],
            },
          },
        }),
      );
      await f.git(["push", "origin", "HEAD:main"]);
    }
    finishPhase("passed");
    const control = (slug: string, action: string, extra: object = {}) =>
      a.json<Control>(
        "/api/dev/landing-fixtures",
        "POST",
        { slug, action, ...extra },
        [200],
        secret,
      );
    const current = async (slug: string) => {
      const value = await poll(
        () => a.json<{ landing: Landing | null }>(`${path(slug)}/landing`),
        (value) => value.landing !== null,
        `${slug} admission`,
      );
      return value.landing!;
    };
    const stopped = (slug: string) =>
      poll(
        async () => {
          await control(slug, "tick");
          return current(slug);
        },
        (value) => ["landed", "failed", "conflict", "blocked_dependency"].includes(value.state),
        slug,
      );
    const waitBarrier = async (slug: string) => {
      let lastControl: Control | undefined;
      try {
        const state = await poll(
          async () => (lastControl = await control(slug, "tick")),
          (value) => value.barrier?.hit === 1,
          `${slug} boundary`,
        );
        return state.barrier?.point === "after-receipt"
          ? await poll(
              () => current(slug),
              (value) => value.repos.some((repo) => repo.state === "advanced"),
              `${slug} durable receipt save`,
            )
          : await current(slug);
      } catch (error) {
        // Preserve the failed wait, but retain the state cleanup is about to erase.
        // These reads never tick, release a barrier, or restart a failed landing.
        const capture = async <T>(kind: string, read: () => Promise<T>): Promise<T | undefined> => {
          try {
            const value = await read();
            record({ event: "source-landing.boundary-failure", scenario: slug, kind, value });
            return value;
          } catch (diagnosticError) {
            record({
              event: "source-landing.boundary-failure",
              scenario: slug,
              kind,
              error: String(diagnosticError),
            });
            return undefined;
          }
        };
        record({
          event: "source-landing.boundary-failure",
          scenario: slug,
          kind: "last-tick",
          value: lastControl ?? null,
          error: String(error),
        });
        const snapshot = await capture("landing", () =>
          a.json<{ landing: Landing | null }>(`${path(slug)}/landing`),
        );
        await capture("control", () => control(slug, "inspect", { diagnostics: true }));
        for (const f of owned) {
          const list = await capture(`${f.repo}:ci`, () => f.json<CiRunList>(`${f.api}/ci`));
          const repo = snapshot?.landing?.repos.find(
            (value) => `${value.space}/${value.name}` === f.repo,
          );
          const numbers = new Set(
            [repo?.mergeRun?.number, repo?.gateRun?.number].filter(
              (number): number is number => number !== undefined && number > 0,
            ),
          );
          for (const run of list?.runs ?? [])
            if (
              run.landing &&
              (run.landing.timeline === slug || run.landing.id === snapshot?.landing?.id)
            )
              numbers.add(run.number);
          for (const number of numbers) {
            const detail = await capture(`${f.repo}:ci:${number}`, () =>
              f.json<CiRunDetail>(`${f.api}/ci/runs/${number}`),
            );
            for (const job of detail?.jobs ?? [])
              if (job.status === "failed")
                await capture(`${f.repo}:ci:${number}:${job.name}:logs`, () =>
                  f.json<CiLogs>(`${f.api}/ci/jobs/${job.id}/logs`),
                );
          }
        }
        throw error;
      }
    };
    const resume = async (slug: string) => {
      await control(slug, "release");
      // A concurrent sweep may finish after release, before this recovery request arrives.
      const result = await a.json<{ landing: Landing } | { code: string; error: string }>(
        `${path(slug)}/land`,
        "POST",
        {},
        [200, 202, 409],
      );
      if ("code" in result) {
        assert.equal(result.code, "timeline_ended");
        assert.equal((await current(slug)).state, "landed");
      }
    };
    // Move canonical main to a commit its gate rejects.
    const failMain = async (f: Fixture, slug: string) => {
      await f.git(["fetch", "origin", "main"]);
      await f.git(["checkout", "--detach", "origin/main"]);
      const oid = await commit(f, "landing-fail.txt", `${slug}\n`);
      await f.git(["push", "origin", "HEAD:main"]);
      return oid;
    };
    async function start(suffix: string, point: string): Promise<Scenario> {
      const slug = `source-landing-${tag}-${suffix}`;
      await a.json(
        "/api/tracker/orbit/timelines",
        "POST",
        { slug, policy: "auto", repos: owned.map((f) => f.repo) },
        [201],
      );
      slugs.push(slug);
      const detail = await a.json<TimelineDetail>(path(slug));
      // Use the actual admission order, not assumptions about database repository ordering.
      const first = detail.timeline.repos[0]!;
      const second = detail.timeline.repos[1]!;
      const fa = owned.find((f) => f.repo === `${first.space}/${first.name}`)!;
      const fb = owned.find((f) => f.repo === `${second.space}/${second.name}`)!;
      const sources = new Map<string, string>();
      for (const entry of detail.timeline.repos) {
        const f = owned.find((value) => value.repo === `${entry.space}/${entry.name}`)!;
        assert(entry.source?.kind === "timeline-work");
        const url = `${ctx.origin}/${f.repo}@${slug}.git`;
        await f.git(["fetch", url, "refs/heads/work"]);
        await f.git(["checkout", "--detach", "FETCH_HEAD"]);
        const tip = await commit(f, `${slug}.txt`, `approved ${slug}\n`);
        await f.git(["push", url, `${tip}:refs/heads/work`]);
        sources.set(entry.id, tip);
      }
      await control(slug, "arm", { point, repoId: first.id });
      await a.json(`${path(slug)}/checkpoints`, "POST", { summary: `A7 ${suffix}` }, [201]);
      return { slug, first, second, fa, fb, sources };
    }
    async function assertComplete(s: Scenario) {
      const landed = await stopped(s.slug);
      record({ scenario: s.slug, landing: landed });
      assert.equal(landed.state, "landed", landed.reason ?? "Landing failed");
      const receipts = (await control(s.slug, "inspect")).receipts;
      assert.equal(receipts.length, 2);
      for (const repo of landed.repos) {
        const f = owned.find((value) => value.repo === `${repo.space}/${repo.name}`)!;
        const receipt = receipts.find((value) => value.repo_id === repo.id)!;
        assert.equal(receipt.status, "complete");
        assert.equal(receipt.canonical_commit, repo.merge);
        assert.equal(receipt.source_commit, s.sources.get(repo.id));
        assert(repo.gateRun?.number, "Real gate run is recorded for each candidate");
        const gate = await f.json<CiRunDetail>(`${f.api}/ci/runs/${repo.gateRun.number}`);
        assert.equal(gate.status, "succeeded");
        assert.equal(gate.commit, repo.merge);
        await f.git(["fetch", "origin", "main"]);
        await f.git(["merge-base", "--is-ancestor", repo.merge!, "origin/main"]);
        assert.equal(await f.git(["show", "-s", "--format=%P", repo.merge!]), repo.base);
        assert.equal(
          (await f.git(["rev-list", "origin/main"])).split("\n").filter((oid) => oid === repo.merge)
            .length,
          1,
        );
      }
      await gm(
        ["timeline", "land", s.slug, "--space", "orbit"],
        "marco",
        a.root,
        /landed|timeline_ended/i,
      );
      assert.deepEqual(
        (await control(s.slug, "inspect")).receipts,
        receipts,
        "Repeated completion changes no receipt",
      );
      record({ scenario: s.slug, state: landed.state, receipts });
      return landed;
    }
    beginPhase("retry-partial");
    const s = await start("retry-partial", "after-receipt");
    const paused = await waitBarrier(s.slug);
    const fixedA = paused.repos.find((repo) => repo.id === s.first.id)!;
    assert.equal(fixedA.state, "advanced");
    const receiptA = (await control(s.slug, "inspect")).receipts.find(
      (r) => r.repo_id === s.first.id,
    )!;
    assert.equal(receiptA.status, "integrated");
    const failedMain = await failMain(s.fb, s.slug);
    await resume(s.slug);
    const partial = await stopped(s.slug);
    assert.equal(partial.state, "failed");
    assert.equal((await a.json<TimelineDetail>(path(s.slug))).timeline.status, "partly_landed");
    assert.equal(await s.fa.tip(), fixedA.merge);
    assert.equal(await s.fb.tip(), failedMain);
    assert.deepEqual(
      (await control(s.slug, "inspect")).receipts.find((r) => r.repo_id === s.first.id),
      receiptA,
    );
    // Fix B canonically: the admitted work source remains frozen and unchanged.
    await s.fb.git(["fetch", "origin", "main"]);
    await s.fb.git(["checkout", "--detach", "origin/main"]);
    await s.fb.git(["rm", "landing-fail.txt"]);
    await s.fb.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Repair canonical gate B"]);
    const repaired = await s.fb.git(["rev-parse", "HEAD"]);
    await s.fb.git(["push", "origin", "HEAD:main"]);
    await gm(["timeline", "land", s.slug, "--space", "orbit"], "marco", a.root);
    const landed = await assertComplete(s);
    const finalA = landed.repos.find((r) => r.id === s.first.id)!;
    assert.equal(finalA.merge, fixedA.merge);
    assert.equal(finalA.attempt, fixedA.attempt);
    assert.deepEqual(finalA.mergeRun, fixedA.mergeRun);
    assert.deepEqual(finalA.gateRun, fixedA.gateRun);
    assert.equal(landed.repos.find((r) => r.id === s.second.id)?.base, repaired);
    record({ scenario: s.slug, partial: partial.state, successfulReceipt: receiptA });
    finishPhase("passed");
  } catch (error) {
    finishPhase("failed");
    failure = error;
  }
  // Cleanup always runs; it reports its own failures and the scenario's.
  {
    beginPhase("cleanup");
    const errors: unknown[] = [];
    for (const slug of slugs) {
      try {
        await owned[0]!.json(
          "/api/dev/landing-fixtures",
          "POST",
          { slug, action: "delete" },
          [200],
          secret,
        );
      } catch (error) {
        errors.push(error);
      }
    }
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
        const inventory: RepoInventory = await poll(
          () =>
            f.json<RepoInventory>(
              `/api/dev/repo-inventory?repo=${encodeURIComponent(f.repo)}`,
              "GET",
              undefined,
              [200],
              secret,
            ),
          (value) => value.deletion?.phase === "done",
          `${f.repo} cleanup`,
          900_000,
        );
        assert.equal(inventory.repo, null);
        assert.equal(inventory.artifacts.exists, false);
        assert.deepEqual(inventory.d1, {});
        record({ repo: f.repo, purge: "done", d1: inventory.d1 });
        await rm(f.root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    finishPhase(errors.length ? "failed" : "passed");
    // Name what failed; when the scenario failed too, keep its error first.
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    if (errors.length) {
      const cleanup = `Landing fixture cleanup failed for ${errors.length} resources: ${errors
        .map(message)
        .join("; ")}`;
      throw new AggregateError(
        failure === undefined ? errors : [failure, ...errors],
        failure === undefined ? cleanup : `Scenario failed: ${message(failure)}. ${cleanup}`,
      );
    }
    if (failure !== undefined) throw failure;
  }
}
