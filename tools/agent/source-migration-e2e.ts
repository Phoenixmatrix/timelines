import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CheckpointView,
  Landing,
  Timeline,
  TimelineDetail,
} from "../../apps/website/shared/timelines.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";
import { queueFixture, type QueueGm } from "./queue-e2e.ts";

interface OwnedMigrationRepo {
  repo: string;
  api: string;
  json<T>(
    path: string,
    method?: string,
    body?: unknown,
    statuses?: number[],
    credential?: string | null,
  ): Promise<T>;
}

/** Literal old durable records plus native canonical bookmarks; all cutover actions are public. */
export async function runSourceMigrationE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const owned: OwnedMigrationRepo[] = [];
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret, "Migration fixtures require the named agent development secret");
  const tag = randomUUID().slice(0, 8);
  const slug = (suffix: string) => `source-migration-${tag}-${suffix}`;
  const path = (name: string) => `/api/tracker/orbit/timelines/${name}`;
  async function poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
    timeout = 300_000,
  ) {
    const deadline = Date.now() + timeout;
    while (true) {
      const value = await read();
      if (done(value)) return value;
      assert(Date.now() < deadline, `Timed out: ${label}`);
      await delay(250);
    }
  }
  type Inventory = {
    repo: unknown;
    deletion: { phase: string } | null;
    artifacts: { exists: boolean };
    d1: Record<string, number>;
  };
  try {
    const a = await queueFixture(ctx, fixtures, record);
    owned.push(a);
    const commit = async (file: string, content: string) => {
      await writeFile(join(a.root, file), content);
      await a.git(["add", file]);
      await a.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", `Migration ${file}`]);
      return a.git(["rev-parse", "HEAD"]);
    };
    // Replace queue-only gates before any migration baseline is pinned.
    await commit(
      ".gitmatrix/ci.yml",
      JSON.stringify({
        on: { push: { branches: ["never-agent-auto"] } },
        jobs: {
          gate: {
            if: 'trigger == "landing"',
            steps: [{ run: 'test "$(git log -1 --format=%P | wc -w)" = 1' }],
          },
        },
      }),
    );
    await a.git(["push", "origin", "HEAD:main"]);
    const B = await a.tip();
    const T = await commit("legacy.txt", "retained B-to-T contribution\n");
    const parent = slug("parent");
    await a.git(["push", "origin", `${T}:refs/heads/gitmatrix/queue/${T}`]);
    await a.json<{ timeline: Timeline; landing: Landing | null }>(
      "/api/dev/source-fixtures",
      "POST",
      {
        slug: parent,
        policy: "approval",
        repos: [{ name: a.repo.split("/")[1], base: B, head: T }],
      },
      [201],
      secret,
    );
    const oldApproval = await a.json<CheckpointView>(`${path(parent)}/checkpoints/1`);
    assert.equal(oldApproval.approved, true, "Fixture really persisted an approved old checkpoint");
    await a.git(["checkout", "--detach", B]);
    const M = await commit("independent.txt", "independent canonical edit\n");
    const attempts = await Promise.allSettled([
      gm(["timeline", "migrate", parent, "--space", "orbit"], "marco", a.root),
      gm(["timeline", "migrate", parent, "--space", "orbit"], "marco", a.root),
      a.git(["push", "origin", `${M}:main`]),
    ]);
    assert.equal(
      attempts[2]?.status,
      "fulfilled",
      "Independent main push must succeed during cutover",
    );
    assert(
      attempts.slice(0, 2).some((result) => result.status === "fulfilled"),
      "At least one concurrent migration completes",
    );
    await gm(["timeline", "migrate", parent, "--space", "orbit"], "marco", a.root);
    const migrated = (await a.json<TimelineDetail>(path(parent))).timeline;
    const entry = migrated.repos[0]!;
    assert.equal(entry.logicalBase?.commit, B);
    assert.equal(entry.source?.kind, "timeline-work");
    assert(entry.source);
    const sourceId = entry.source.sourceId;
    const workUrl = `${ctx.origin}/${a.repo}@${parent}.git`;
    const sourceRefs = await a.git(["ls-remote", workUrl, "refs/heads/work"]);
    assert.equal(
      sourceRefs.split(/\s+/)[0],
      T,
      "Work source must pin legacy T, not moving main M or logical base B",
    );
    await gm(["timeline", "migrate", parent, "--space", "orbit"], "marco", a.root);
    assert.equal(
      (await a.json<TimelineDetail>(path(parent))).timeline.repos[0]?.source?.sourceId,
      sourceId,
    );
    const allocated = await a.json<Inventory>(
      `/api/dev/repo-inventory?repo=${encodeURIComponent(a.repo)}`,
      "GET",
      undefined,
      [200],
      secret,
    );
    assert.equal(
      allocated.d1.timeline_work_sources,
      1,
      "Concurrent migrations allocate exactly one work source",
    );
    assert.equal(await a.git(["ls-remote", "origin", `refs/heads/timeline/${parent}`]), "");
    const staleApproval = await a.json<CheckpointView>(`${path(parent)}/checkpoints/1`);
    assert.equal(staleApproval.current, false);
    assert.equal(staleApproval.approved, false);
    await assert.rejects(
      a.git(["push", "origin", `${T}:refs/heads/timeline/${parent}`]),
      /git push failed/,
    );
    assert.equal(
      await a.git(["ls-remote", "origin", `refs/heads/timeline/${parent}`]),
      "",
      "Stale canonical client cannot recreate the retired bookmark",
    );
    // A new WIP commit goes ONLY to owned work; canonical already contains old T by design.
    await a.git(["checkout", "--detach", T]);
    const W = await commit("post-cutover.txt", "new source-only progress\n");
    await a.git(["push", workUrl, `${W}:refs/heads/work`]);
    const progress = await a.json<{ commits: { oid: string }[] }>(
      `${a.api}/commits?source=${sourceId}&ref=${W}`,
    );
    assert.equal(progress.commits[0]?.oid, W);
    await a.json(`${a.api}/commits?ref=${W}`, "GET", undefined, [404]);
    const checkpoint = await a.json<CheckpointView>(
      `${path(parent)}/checkpoints`,
      "POST",
      { summary: "Renewed source identity and retained legacy delta" },
      [201],
    );
    assert.notEqual(checkpoint.checkpoint.id, oldApproval.checkpoint.id);
    assert.equal(checkpoint.checkpoint.repos[0]?.logicalBase?.commit, B);
    assert.equal(checkpoint.checkpoint.repos[0]?.source?.commit, W);
    assert.equal(checkpoint.approved, false);
    await a.json(`${path(parent)}/land`, "POST", {}, [409]);
    assert.equal(fixtures.tracker.space, "orbit");
    const issueId = randomUUID();
    const requestId = randomUUID();
    await a.json("/api/tracker/orbit/mutate", "POST", {
      operationId: randomUUID(),
      mutations: [
        {
          kind: "issue.create",
          id: issueId,
          data: { teamId: fixtures.tracker.team, title: `Review migrated source ${parent}` },
        },
        {
          kind: "request.open",
          id: requestId,
          data: {
            issueId,
            kind: "approval",
            prompt: "Approve the renewed owned-source checkpoint",
            checkpoint: checkpoint.checkpoint.id,
          },
        },
      ],
    });
    await a.json("/api/tracker/orbit/mutate", "POST", {
      operationId: randomUUID(),
      mutations: [
        {
          kind: "request.answer",
          id: requestId,
          data: {
            approved: true,
            answer: "Reviewed the retained legacy delta and source identity",
          },
        },
      ],
    });
    assert.equal(
      (await a.json<CheckpointView>(`${path(parent)}/checkpoints/${checkpoint.checkpoint.id}`))
        .approved,
      true,
    );
    await a.json(`${path(parent)}/land`, "POST", {}, [200, 202, 409]);
    const landing = await poll(
      () => a.json<{ landing: Landing | null }>(`${path(parent)}/landing`),
      (value) => !!value.landing && ["landed", "failed", "conflict"].includes(value.landing.state),
      "migrated parent landing",
    );
    assert.equal(landing.landing?.state, "landed", landing.landing?.reason ?? "Landing failed");
    const C = landing.landing?.repos[0]?.merge;
    assert(C, "Migrated landing must persist its canonical receipt");
    await a.git(["fetch", "origin", "main"]);
    assert.equal(await a.git(["show", `${C}:legacy.txt`]), "retained B-to-T contribution");
    assert.equal(await a.git(["show", `${C}:independent.txt`]), "independent canonical edit");
    assert.equal(await a.git(["show", `${C}:post-cutover.txt`]), "new source-only progress");
    assert.equal(await a.git(["show", "-s", "--format=%P", C]), M);
    const mirror = join(ctx.work, `${parent}-canonical.git`);
    await a.git(["clone", "--mirror", `${ctx.origin}/${a.repo}.git`, mirror]);
    assert(
      !(await a.git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], mirror))
        .split("\n")
        .includes(W),
      "Landing must not upload new WIP objects to canonical",
    );
    record({
      migration: parent,
      B,
      T,
      M,
      W,
      C,
      sourceId,
      approvalInvalidated: true,
    });
  } finally {
    for (const f of owned) {
      await f.json(f.api, "DELETE", undefined, [204, 404]);
      await f.json(
        "/api/dev/repo-purge",
        "POST",
        { repo: f.repo, action: "resume" },
        [200],
        secret,
      );
      const inventory: Inventory = await poll<Inventory>(
        (): Promise<Inventory> =>
          f.json<Inventory>(
            `/api/dev/repo-inventory?repo=${encodeURIComponent(f.repo)}`,
            "GET",
            undefined,
            [200],
            secret,
          ),
        (value) => value.deletion?.phase === "done",
        `purge ${f.repo}`,
        900_000,
      );
      assert.equal(inventory.repo, null);
      assert.equal(inventory.artifacts.exists, false);
      assert.deepEqual(inventory.d1, {});
      record({ repo: f.repo, purge: "done", canonicalProviderAbsent: true, d1: inventory.d1 });
    }
  }
}
