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
  const deleted = new Set<string>();
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
      await delay(1_000);
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
    const b = await queueFixture(ctx, fixtures, record);
    owned.push(b);
    const commit = async (f: typeof a, file: string, content: string) => {
      await writeFile(join(f.root, file), content);
      await f.git(["add", file]);
      await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", `Migration ${file}`]);
      return f.git(["rev-parse", "HEAD"]);
    };
    // Replace queue-only gates before any migration baseline is pinned.
    for (const f of [a, b]) {
      await commit(
        f,
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
      await f.git(["push", "origin", "HEAD:main"]);
    }
    const B = await a.tip();
    const B2 = await b.tip();
    const T = await commit(a, "legacy.txt", "retained B-to-T contribution\n");
    const parent = slug("parent");
    const child = slug("child");
    const inflight = slug("inflight");
    const tombstone = slug("tombstone");
    const U = await commit(a, "nested.txt", "nested contribution\n");
    const seed = async (
      name: string,
      entries: { f: typeof a; base: string; head: string; merge?: string }[],
      extra: object = {},
    ) => {
      for (const { f, head } of entries)
        await f.git(["push", "origin", `${head}:refs/heads/gitmatrix/queue/${head}`]);
      return a.json<{ timeline: Timeline; landing: Landing | null }>(
        "/api/dev/source-fixtures",
        "POST",
        {
          slug: name,
          ...extra,
          repos: entries.map(({ f, ...entry }) => ({ name: f.repo.split("/")[1], ...entry })),
        },
        [201],
        secret,
      );
    };
    await seed(parent, [{ f: a, base: B, head: T }], { policy: "approval" });
    await seed(child, [{ f: a, base: T, head: U }], { parent, experimental: true });
    await seed(inflight, [{ f: a, base: B, head: T }], { operation: "inflight" });
    await seed(tombstone, [{ f: b, base: B2, head: B2 }]);
    for (const status of ["landed", "abandoned"] as const) {
      const name = slug(status);
      await seed(name, [{ f: a, base: B, head: T }], { status });
      await gm(["timeline", "migrate", name, "--space", "orbit"], "marco", a.root);
      const historical = await a.json<TimelineDetail>(path(name));
      assert.equal(historical.timeline.status, status);
      assert.equal(historical.timeline.repos[0]?.source?.kind, "canonical-historical");
      assert.equal(historical.timeline.repos[0]?.source?.sourceId, "canonical");
      const history = await a.json<CheckpointView>(`${path(name)}/checkpoints/1`);
      assert.equal(history.checkpoint.repos[0]?.commit, T);
      record({ historical: name, status, checkpoint: history.checkpoint.id, commit: T });
    }
    const oldApproval = await a.json<CheckpointView>(`${path(parent)}/checkpoints/1`);
    assert.equal(oldApproval.approved, true, "Fixture really persisted an approved old checkpoint");
    // Parent-first migration is mandatory; a child cannot guess its foreign baseline.
    await gm(
      ["timeline", "migrate", child, "--space", "orbit"],
      "marco",
      a.root,
      /parent first|historical dependency/i,
    );
    await a.git(["checkout", "--detach", B]);
    const M = await commit(a, "independent.txt", "independent canonical edit\n");
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
      "Concurrent migrations allocate exactly one work source; historical conversions allocate none",
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
    await gm(["timeline", "migrate", child, "--space", "orbit"], "marco", a.root);
    const nested = (await a.json<TimelineDetail>(path(child))).timeline;
    assert.equal(nested.experimental, true);
    assert.equal(nested.repos[0]?.logicalBase?.commit, T);
    assert.equal(nested.repos[0]?.logicalBase?.sourceId, sourceId);
    assert.equal(nested.repos[0]?.dependencies?.[0]?.source.commit, T);
    assert.equal(nested.repos[0]?.dependencies?.[0]?.base.commit, B);
    const nestedCheckpoint = await a.json<CheckpointView>(
      `${path(child)}/checkpoints`,
      "POST",
      { summary: "Fresh migrated nested work" },
      [201],
    );
    assert.equal(nestedCheckpoint.checkpoint.repos[0]?.source?.commit, U);
    await a.json(`${path(child)}/land`, "POST", {}, [200, 202, 409]);
    await poll(
      () => a.json<{ landing: Landing | null }>(`${path(child)}/landing`),
      (value) => value.landing?.state === "blocked_dependency",
      "unlanded migrated parent blocks child",
    );
    // A new WIP commit goes ONLY to owned work; canonical already contains old T by design.
    await a.git(["checkout", "--detach", T]);
    const W = await commit(a, "post-cutover.txt", "new source-only progress\n");
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
      nested: child,
    });
    await a.json(`${path(child)}/land`, "POST", {}, [200, 202, 409]);
    const childLanding = await poll(
      () => a.json<{ landing: Landing | null }>(`${path(child)}/landing`),
      (value) => !!value.landing && ["landed", "failed", "conflict"].includes(value.landing.state),
      "migrated nested landing after parent",
    );
    assert.equal(
      childLanding.landing?.state,
      "landed",
      childLanding.landing?.reason ?? "Nested landing failed",
    );
    const nestedCanonical = childLanding.landing?.repos[0]?.merge;
    assert(nestedCanonical);
    await a.git(["fetch", "origin", "main"]);
    assert.equal(await a.git(["show", `${nestedCanonical}:nested.txt`]), "nested contribution");
    assert.equal(
      await a.git(["show", `${nestedCanonical}:post-cutover.txt`]),
      "new source-only progress",
    );
    assert.equal(
      await a.git(["show", `${nestedCanonical}:independent.txt`]),
      "independent canonical edit",
    );
    assert.equal(await a.git(["show", "-s", "--format=%P", nestedCanonical]), C);
    record({ nested: child, logicalBase: T, integratedParent: C, canonical: nestedCanonical });

    await gm(
      ["timeline", "migrate", inflight, "--space", "orbit"],
      "marco",
      a.root,
      /Resolve the legacy landing|landing_unresolved/i,
    );
    await a.json(`${path(inflight)}/migration/resolve`, "POST", {
      expectedVersion: 1,
      action: "cancel-unadvanced",
      note: "No canonical advance; cancel old operation",
    });
    await gm(["timeline", "migrate", inflight, "--space", "orbit"], "marco", a.root);
    assert.equal(
      (await a.json<TimelineDetail>(path(inflight))).timeline.repos[0]?.source?.kind,
      "timeline-work",
    );

    // Real old partial success, followed by a real canonical revert before explicit resolution.
    const partial = slug("partial");
    await a.git(["checkout", "--detach", nestedCanonical]);
    const P = await commit(a, "partial.txt", "legacy successful contribution\n");
    await a.git(["checkout", "--detach", nestedCanonical]);
    await a.git([
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      P,
      "-m",
      "Legacy successful first repository",
    ]);
    const receipt = await a.git(["rev-parse", "HEAD"]);
    await a.git(["push", "origin", `${receipt}:main`]);
    await a.git(["-c", "core.hooksPath=/dev/null", "revert", "--no-edit", "-m", "1", receipt]);
    const reverted = await a.git(["rev-parse", "HEAD"]);
    await a.git(["push", "origin", `${reverted}:main`]);
    const pending = await commit(b, "remaining.txt", "unlanded second repository\n");
    await seed(
      partial,
      [
        { f: a, base: nestedCanonical, head: P, merge: receipt },
        { f: b, base: B2, head: pending },
      ],
      { operation: "partial" },
    );
    await gm(
      ["timeline", "migrate", partial, "--space", "orbit"],
      "marco",
      a.root,
      /Resolve the legacy landing|landing_unresolved/i,
    );
    await a.json(
      `${path(partial)}/migration/resolve`,
      "POST",
      { expectedVersion: 1, action: "cancel-unadvanced", note: "Must be refused after success" },
      [409],
    );
    await a.json(`${path(partial)}/migration/resolve`, "POST", {
      expectedVersion: 1,
      action: "accept-partial-and-abandon",
      note: "Preserve first receipt despite revert; remaining work needs new timeline",
    });
    await gm(["timeline", "migrate", partial, "--space", "orbit"], "marco", a.root);
    const abandoned = (await a.json<TimelineDetail>(path(partial))).timeline;
    assert.equal(abandoned.status, "abandoned");
    assert(abandoned.repos.every((repo) => repo.source?.kind === "canonical-historical"));
    const kept = (await a.json<{ landing: Landing }>(`${path(partial)}/landing`)).landing;
    assert.equal(kept.repos[0]?.merge, receipt);
    assert.equal(kept.repos[0]?.state, "advanced");
    await a.json(
      `${path(partial)}/checkpoints`,
      "POST",
      { summary: "Cannot reuse resolved partial timeline" },
      [409],
    );
    await a.json(`${path(partial)}/land`, "POST", {}, [409]);
    assert.equal(await a.tip(), reverted, "Resolution must not replay reverted successful content");
    assert.equal(await b.tip(), B2, "Resolution must not land remaining repository implicitly");
    await assert.rejects(a.git(["show", `${reverted}:partial.txt`]), /git show failed/);
    const replacement = join(ctx.work, `${partial}-replacement`);
    await gm(["clone", b.repo, replacement], "marco");
    await gm(
      ["timeline", "start", slug("replacement"), "--space", "orbit", "--policy", "auto"],
      "marco",
      replacement,
    );
    const replacementTimeline = (await a.json<TimelineDetail>(path(slug("replacement")))).timeline;
    assert.notEqual(replacementTimeline.id, abandoned.id);
    assert.equal(replacementTimeline.repos[0]?.logicalBase?.commit, B2);
    record({
      partial,
      receipt,
      reverted,
      pending,
      preservedReceipt: kept.repos[0]?.merge,
      replacement: replacementTimeline.id,
    });

    await b.json(b.api, "DELETE", undefined, [204]);
    deleted.add(b.repo);
    await gm(
      ["timeline", "migrate", tombstone, "--space", "orbit"],
      "marco",
      b.root,
      /deleted|not found|write access|forbidden|404/i,
    );
    await b.json(b.api, "GET", undefined, [404]);
    record({ tombstone, migrationRefused: true });
  } finally {
    for (const f of owned) {
      if (!deleted.has(f.repo)) {
        await f.json(f.api, "DELETE", undefined, [204, 404]);
        deleted.add(f.repo);
      }
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
