import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import type { CiRunDetail, CiRunSummary } from "../../apps/website/shared/api.ts";
import type { RetentionSettings } from "../../apps/website/shared/retention.ts";
import type { Timeline } from "../../apps/website/shared/timelines.ts";
import type { QueueGm, RepoInventory } from "./queue-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

/** Real owned Git/provider resources; the clock override applies only to this persona's run. */
export async function runSourceRetentionE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const owner = "sam";
  const token = fixtures.tokens.sam;
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret, "The isolated agent retention hook needs its secret");
  const name = `source-retention-${randomUUID().slice(0, 8)}`;
  const repo = `${owner}/${name}`;
  const api = `/api/repos/${repo}`;
  const timelines = `/api/tracker/${owner}/timelines`;
  const root = join(ctx.work, name);
  await mkdir(root, { recursive: true });
  async function json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    statuses = [200],
    credential = token,
  ): Promise<T> {
    const response = await fetch(`${ctx.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
      redirect: "error",
    });
    record({ method, path, status: response.status });
    assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  const gitEnv = {
    ...ctx.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(gitEnv))
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key) || key === "SSH_AUTH_SOCK")
      delete (gitEnv as NodeJS.ProcessEnv)[key];
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: root,
          timeout: 180_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...gitEnv,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
          },
        },
        (error, stdout) =>
          error
            ? reject(new Error(`Retention fixture git ${args[0]} failed (${error.code})`))
            : resolve(stdout.trim()),
      );
    });
  const retain = async (
    daysAhead: number,
    categories = { "timeline-work-sources": { landedDays: 30, abandonedDays: 90 } } as Record<
      string,
      Record<string, number>
    >,
  ) => {
    const result = await json<{ run: { status: string; categories: { error: string | null }[] } }>(
      "/api/dev/retention",
      "POST",
      { account: owner, categories, daysAhead, dryRun: false },
      [200],
      secret,
    );
    assert.equal(result.run.status, "succeeded", JSON.stringify(result.run));
    assert(result.run.categories.every((category) => category.error === null));
    return result.run;
  };
  const sourceSlugs = new Map<string, string>();
  const create = async (suffix: string, parent?: string, policy?: Timeline["policy"]) => {
    const slug = `${name}-${suffix}`;
    const result = await json<{ timeline: Timeline }>(
      timelines,
      "POST",
      { slug, repos: [repo], ...(parent ? { parent } : {}), ...(policy ? { policy } : {}) },
      [201],
    );
    const source = result.timeline.repos[0]?.source;
    assert(source?.sourceId && source.kind === "timeline-work");
    record({ timelineId: result.timeline.id, slug, sourceId: source.sourceId });
    sourceSlugs.set(source.sourceId, slug);
    return { slug, id: result.timeline.id, sourceId: source.sourceId };
  };
  const abandon = (slug: string) => json(`${timelines}/${slug}/abandon`, "POST", {});
  const readable = async (sourceId: string, oid: string) => {
    const commits = await json<{ commits: { oid: string }[] }>(
      `${api}/commits?source=${sourceId}&ref=${oid}`,
    );
    assert.equal(commits.commits[0]?.oid, oid);
    const slug = sourceSlugs.get(sourceId);
    if (slug)
      assert.equal(
        await git(["ls-remote", `${ctx.origin}/${repo}@${slug}.git`, "refs/heads/work"]),
        `${oid}\trefs/heads/work`,
      );
  };
  const inventory = (id = repo) =>
    json<RepoInventory>(
      `/api/dev/repo-inventory?repo=${encodeURIComponent(id)}`,
      "GET",
      undefined,
      [200],
      secret,
    );
  type Observation = {
    sourceId: string;
    artifactsName: string;
    state: string;
    exists: boolean;
    archivedAt: string | null;
    roots: { consumerKind: string; consumerId: string; commit: string }[];
    operations: { id: string; kind: string; state: string }[];
  };
  const hook = <T>(body: Record<string, unknown>) =>
    json<T>("/api/dev/source-retention", "POST", { repo, ...body }, [200], secret);
  const inspect = async () =>
    (await hook<{ sources: Observation[] }>({ action: "inspect" })).sources;
  const poll = async <T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      assert(Date.now() < deadline, `Timed out waiting for ${label}`);
      await delay(500);
    }
  };
  await gm(["repo", "create", name, "--owner", owner], "sam", root);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Source Retention Fixture"]);
  await git(["config", "user.email", "retention@example.invalid"]);
  await writeFile(join(root, "README.md"), "# Owned source retention fixture\n");
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Retention fixture canonical base"]);
  await git(["push", `${ctx.origin}/${repo}.git`, "HEAD:main"]);
  const settingsPath = `/api/accounts/${owner}/settings/retention`;
  const settings = await json<RetentionSettings>(settingsPath);
  const workPolicy = settings.categories.find(
    (category) => category.id === "timeline-work-sources",
  );
  assert(workPolicy);
  assert.deepEqual(workPolicy.values, { landedDays: 30, abandonedDays: 90 });
  assert.equal(
    settings.categories.find((category) => category.id === "tracker-activity")?.values
      .endedTimelineDays,
    180,
  );
  const endedPair = async (suffix: string) => {
    await git(["fetch", `${ctx.origin}/${repo}.git`, "main"]);
    await git(["checkout", "--detach", "FETCH_HEAD"]);
    const landed = await create(`${suffix}-landed`, undefined, "auto");
    await writeFile(join(root, `${suffix}.txt`), `${suffix}\n`);
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", `Land ${suffix}`]);
    const commit = await git(["rev-parse", "HEAD"]);
    await git(["push", `${ctx.origin}/${repo}@${landed.slug}.git`, "HEAD:work"]);
    await json(
      `${timelines}/${landed.slug}/checkpoints`,
      "POST",
      { summary: `Land ${suffix}` },
      [201],
    );
    const detail = await poll(
      () => json<{ timeline: Timeline }>(`${timelines}/${landed.slug}`),
      (value) => value.timeline.status === "landed",
      `${suffix} real compact landing`,
    );
    assert.equal(detail.timeline.status, "landed");
    const abandoned = await create(`${suffix}-abandoned`);
    await abandon(abandoned.slug);
    return { landed, abandoned, commit };
  };
  const state = async (sourceId: string, expected: "archived" | "purged") => {
    const source = (await inspect()).find((entry) => entry.sourceId === sourceId);
    assert(source);
    assert.equal(source.state, expected);
    assert.equal(source.exists, expected === "archived");
    record({ retentionSource: source });
  };
  const defaults = await endedPair("defaults");
  await retain(29);
  await readable(defaults.landed.sourceId, defaults.commit);
  await state(defaults.abandoned.sourceId, "archived");
  await retain(31);
  await state(defaults.landed.sourceId, "purged");
  await state(defaults.abandoned.sourceId, "archived");
  await retain(89);
  await state(defaults.abandoned.sourceId, "archived");
  await retain(91);
  await state(defaults.abandoned.sourceId, "purged");
  // Source expiry must not remove the independent 180-day timeline history.
  for (const source of [defaults.landed, defaults.abandoned])
    await json(`${timelines}/${source.slug}`);
  const custom = await endedPair("overrides");
  try {
    const configured = await json<RetentionSettings>(settingsPath, "PATCH", {
      categories: { "timeline-work-sources": { thresholds: { landedDays: 5, abandonedDays: 10 } } },
    });
    const policy = configured.categories.find(
      (category) => category.id === "timeline-work-sources",
    );
    assert(policy);
    assert.deepEqual(policy.values, { landedDays: 5, abandonedDays: 10 });
    assert.deepEqual(policy.valuesFrom, { landedDays: "account", abandonedDays: "account" });
    const categories = { "timeline-work-sources": policy.values };
    await retain(4, categories);
    await state(custom.landed.sourceId, "archived");
    await state(custom.abandoned.sourceId, "archived");
    await retain(6, categories);
    await state(custom.landed.sourceId, "purged");
    await state(custom.abandoned.sourceId, "archived");
    await retain(9, categories);
    await state(custom.abandoned.sourceId, "archived");
    await retain(11, categories);
    await state(custom.abandoned.sourceId, "purged");
    record({
      configuredWorkSourcePolicy: policy,
      defaultBoundaries: [29, 31, 89, 91],
      overrideBoundaries: [4, 6, 9, 11],
    });
  } finally {
    await json(settingsPath, "PATCH", {
      categories: {
        "timeline-work-sources": { thresholds: { landedDays: null, abandonedDays: null } },
      },
    });
  }
  await git(["fetch", `${ctx.origin}/${repo}.git`, "main"]);
  await git(["checkout", "--detach", "FETCH_HEAD"]);
  const oid = await git(["rev-parse", "HEAD"]);
  const parent = await create("parent");
  const child = await create("child", parent.slug);
  await abandon(parent.slug);
  await readable(parent.sourceId, oid);
  await retain(10, { "preview-records": { days: 1 }, "ended-timeline-data": { days: 1 } });
  await readable(parent.sourceId, oid);
  await retain(89);
  await readable(parent.sourceId, oid);
  await retain(91);
  await readable(parent.sourceId, oid);
  assert.equal(
    (await json<{ timeline: Timeline }>(`${timelines}/${child.slug}`)).timeline.status,
    "active",
  );
  record({
    archiveSurvivedShortPolicies: true,
    archiveSurvivedDependencyAtExpiry: true,
    oid,
    parent,
    child,
  });
  const consumer = await create("consumer");
  // A real runner waits on a bounded HTTP barrier. No injected root, deployment,
  // child, or unfinished push may protect this independent source.
  const capability = randomUUID();
  let waiting: ServerResponse | undefined;
  const barrier = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${capability}`) {
      response.writeHead(404).end();
      return;
    }
    assert.equal(waiting, undefined, "The fixture starts exactly one held job");
    waiting = response;
    response.setTimeout(300_000, () => response.writeHead(504).end());
  });
  const listening = Promise.withResolvers<void>();
  barrier.once("error", listening.reject);
  barrier.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  let heldNumber: number | undefined;
  const sourceObservation = async () => {
    const source = (await inspect()).find((entry) => entry.sourceId === consumer.sourceId);
    assert(source, "The owned consumer source remains in inventory");
    return source;
  };
  const expireConsumer = () =>
    hook<{ sourceId: string; state: string; cutoff: string }>({
      action: "expire",
      timeline: consumer.slug,
      sourceId: consumer.sourceId,
    });
  try {
    const address = barrier.address();
    assert(address && typeof address !== "string");
    await mkdir(join(root, ".gitmatrix"), { recursive: true });
    await writeFile(
      join(root, ".gitmatrix", "ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["never-agent-auto"] }, preview: {} },
        jobs: {
          hold: {
            if: 'trigger == "preview" && action == "create"',
            steps: [
              {
                run: `curl --fail --silent --show-error --max-time 305 http://127.0.0.1:${address.port}/${capability}`,
              },
            ],
          },
        },
      }),
    );
    await git(["add", ".gitmatrix/ci.yml"]);
    await git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Hold real source-aware preview CI",
    ]);
    const consumerOid = await git(["rev-parse", "HEAD"]);
    await git(["push", `${ctx.origin}/${repo}@${consumer.slug}.git`, "HEAD:work"]);
    const checkpoint = await json<{
      checkpoint: {
        id: string;
        number: number;
        repos: { source?: { sourceId: string }; commit: string }[];
      };
    }>(
      `${timelines}/${consumer.slug}/checkpoints`,
      "POST",
      { summary: "Retained CI preview" },
      [201],
    );
    assert.equal(checkpoint.checkpoint.repos[0]?.source?.sourceId, consumer.sourceId);
    assert.equal(checkpoint.checkpoint.repos[0]?.commit, consumerOid);
    const runsPath = `${api}/ci?source=${consumer.sourceId}`;
    const running = await poll(
      () => json<{ runs: CiRunSummary[] }>(runsPath),
      (result) =>
        result.runs.some((run) => run.trigger === "preview" && run.commit === consumerOid),
      "source-qualified checkpoint preview CI",
    );
    const run = running.runs.find(
      (entry) => entry.trigger === "preview" && entry.commit === consumerOid,
    )!;
    heldNumber = run.number;
    const runPath = `${api}/ci/runs/${run.number}`;
    await poll(
      async () => waiting,
      (gate) => Boolean(gate),
      "real runner reaching its barrier",
    );
    const active = await poll(
      () => json<CiRunDetail>(runPath),
      (detail) =>
        detail.status === "running" && detail.jobs.some((job) => job.status === "running"),
      "running CI state",
    );
    assert.equal(active.sourceId, consumer.sourceId);
    assert.equal(active.commit, consumerOid);
    assert.equal(active.jobs.length, 1);
    await abandon(consumer.slug);
    const archived = await sourceObservation();
    assert.equal(archived.state, "archived");
    assert(archived.archivedAt);
    assert.equal(archived.exists, true);
    assert.deepEqual(archived.operations, []);
    assert.deepEqual(archived.roots, [
      {
        consumerKind: "ci",
        consumerId: run.id,
        commit: consumerOid,
      },
    ]);
    const protectedExpiry = await expireConsumer();
    assert.equal(protectedExpiry.sourceId, consumer.sourceId);
    assert(Date.parse(archived.archivedAt) < Date.parse(protectedExpiry.cutoff));
    assert.equal(protectedExpiry.state, "archived");
    await readable(consumer.sourceId, consumerOid);
    const held = await json<CiRunDetail>(runPath);
    const protectedSource = await sourceObservation();
    assert.equal(held.status, "running");
    assert.equal(held.jobs[0]?.status, "running");
    assert.equal(waiting!.destroyed, false, "The runner is still held during expiry");
    assert.equal(protectedSource.state, "archived");
    assert.equal(protectedSource.exists, true);
    assert.deepEqual(protectedSource.roots, archived.roots);
    assert.deepEqual(protectedSource.operations, []);
    await retain(181, { "ci-runs": { days: 1, keepLatest: 1 } });
    assert.equal((await json<CiRunDetail>(runPath)).status, "running");
    assert.deepEqual((await sourceObservation()).roots, archived.roots);
    record({
      realCiRootBlockedPurge: {
        run: held,
        source: protectedSource,
        cutoff: protectedExpiry.cutoff,
      },
    });
    waiting!.writeHead(204).end();
    const completed = await poll(
      () => json<CiRunDetail>(runPath),
      (detail) => !["queued", "running"].includes(detail.status),
      "held CI completing normally",
    );
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.jobs[0]?.status, "succeeded");
    const terminalSource = await sourceObservation();
    assert.deepEqual(terminalSource.roots, [], "True CI completion releases its source claim");
    assert.equal(terminalSource.exists, true);
    // Normal history retention still keeps the latest run, independently of
    // source expiry. Completion, not history deletion, releases the claim.
    await retain(181, { "ci-runs": { days: 1, keepLatest: 1 } });
    const retainedHistory = await json<CiRunDetail>(runPath);
    assert.equal(retainedHistory.status, "succeeded");
    assert.deepEqual(retainedHistory.jobs, completed.jobs);
    heldNumber = undefined;
    const released = await sourceObservation();
    assert.deepEqual(released.roots, []);
    assert.deepEqual(released.operations, []);
    const purged = await expireConsumer();
    assert.equal(purged.state, "purged");
    const absent = await sourceObservation();
    assert.equal(absent.exists, false);
    assert.equal(absent.state, "purged");
    assert.deepEqual(await json<CiRunDetail>(runPath), retainedHistory);
    await json(
      `${api}/commits?source=${consumer.sourceId}&ref=${consumerOid}`,
      "GET",
      undefined,
      [410],
    );
    await assert.rejects(git(["ls-remote", `${ctx.origin}/${repo}@${consumer.slug}.git`]));
    // The checkpoint itself remains addressable: this must reject its expired
    // physical input, not merely fail because timeline metadata was removed.
    const checkpointPath = `${timelines}/${consumer.slug}/checkpoints/${checkpoint.checkpoint.number}`;
    const retained = await json<typeof checkpoint>(checkpointPath);
    assert.equal(retained.checkpoint.id, checkpoint.checkpoint.id);
    assert.equal(retained.checkpoint.repos[0]?.source?.sourceId, consumer.sourceId);
    const beforeRevival = await json<{ runs: CiRunSummary[] }>(runsPath);
    const revived = await json<{ runs: { number?: number; skipped?: string }[] }>(
      `${checkpointPath}/revive`,
      "POST",
      {},
    );
    assert.equal(revived.runs.length, 1);
    assert.equal(revived.runs[0]?.number, undefined);
    assert.match(revived.runs[0]?.skipped ?? "", /source.*(?:expired|unavailable)/i);
    assert.deepEqual((await json<{ runs: CiRunSummary[] }>(runsPath)).runs, beforeRevival.runs);
    assert.deepEqual((await sourceObservation()).roots, []);
    record({
      realCiCompleted: completed,
      terminalSource,
      retainedCiHistory: retainedHistory,
      realCiRootReleased: released,
      purgedSource: absent,
      expiredCheckpointPreview: revived,
    });
  } finally {
    try {
      if (heldNumber !== undefined) {
        const detail = await json<CiRunDetail>(`${api}/ci/runs/${heldNumber}`);
        if (["queued", "running"].includes(detail.status))
          await gm(["runs", "cancel", String(heldNumber), "--repo", repo], "sam", root);
      }
    } finally {
      barrier.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        barrier.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  await abandon(child.slug);
  // A child is removed first; its dependency root is released only after its provider is gone.
  for (let pass = 0; pass < 3; pass++) await retain(91);
  const expired = await json<{ code?: string; error?: string }>(
    `${api}/commits?source=${parent.sourceId}&ref=${oid}`,
    "GET",
    undefined,
    [410],
  );
  assert.match(JSON.stringify(expired), /source_expired|source has expired/i);
  await json(`${timelines}/${parent.slug}`);
  await retain(181, { "tracker-activity": { eventDays: 365, endedTimelineDays: 180 } });
  await json(`${timelines}/${parent.slug}`, "GET", undefined, [404]);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: ctx.origin });
  const page = await context.newPage();
  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as sam/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");
    await page.goto(`/${repo}?source=${parent.sourceId}`);
    await expect(page.getByText(/code source has expired/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: join(ctx.artifacts, "source-retention-expired.png"),
      fullPage: true,
    });
  } catch (error) {
    await page
      .screenshot({ path: join(ctx.artifacts, "source-retention-failure.png"), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
  const live = await create("tombstone");
  await readable(live.sourceId, oid);
  const reservation = await hook<{ sourceId: string; state: string }>({
    action: "reserve",
    commit: oid,
  });
  assert.equal(reservation.state, "reserved");
  const reservedBefore = (await inspect()).find(
    (source) => source.sourceId === reservation.sourceId,
  );
  assert(reservedBefore?.exists);
  await json("/api/dev/repo-orphans", "POST", { action: "sweep" }, [200], secret);
  const reservedAfter = (await inspect()).find(
    (source) => source.sourceId === reservation.sourceId,
  );
  assert.equal(reservedAfter?.state, "reserved");
  assert.equal(reservedAfter?.exists, true);
  // The dev sweep treats every provider repository as older than 24h.
  record({ reservedNameSurvivedOldResourceSweep: reservation.sourceId });
  await hook({ action: "initialize", sourceId: reservation.sourceId });
  await readable(reservation.sourceId, oid);
  const observed = await inspect();
  for (const sourceId of [parent.sourceId, child.sourceId, consumer.sourceId]) {
    const source = observed.find((item) => item.sourceId === sourceId);
    assert.equal(source?.state, "purged");
    assert.equal(source?.exists, false);
  }
  const before = await inventory();
  await json(api, "DELETE", undefined, [204]);
  await json(`${api}/commits?source=${live.sourceId}&ref=${oid}`, "GET", undefined, [404]);
  await assert.rejects(git(["ls-remote", `${ctx.origin}/${repo}@${live.slug}.git`]));
  await json(
    "/api/dev/repo-purge",
    "POST",
    { repo: before.repoId, action: "resume" },
    [200],
    secret,
  );
  const deadline = Date.now() + 300_000;
  let after: RepoInventory;
  for (;;) {
    after = await inventory(before.repoId);
    if (after.deletion?.phase === "done") break;
    assert(Date.now() < deadline, `Source purge stalled in ${after.deletion?.phase}`);
    await delay(1_000);
  }
  assert.equal(after.repo, null);
  assert.deepEqual(after.d1, {});
  assert.equal(after.artifacts.exists, false);
  assert.deepEqual(after.registry, { packageSources: 0, publishes: 0 });
  assert.deepEqual(after.previews, { live: 0, teardownsOpen: 0 });
  assert(!after.vectors && !after.searchItems);
  const providerAfter = await hook<{ sources: { sourceId: string; exists: boolean }[] }>({
    action: "inspect",
    observed: observed.map(({ sourceId, artifactsName }) => ({ sourceId, artifactsName })),
  });
  assert(
    providerAfter.sources.every((source) => !source.exists),
    "Every owned provider repository must be absent after purge",
  );
  record({ ownedProviderCleanup: providerAfter.sources });
  record({
    repoId: before.repoId,
    sources: [parent.sourceId, child.sourceId, live.sourceId],
    expired,
    purge: {
      d1: after.d1,
      phase: after.deletion?.phase,
      canonicalProviderExists: after.artifacts.exists,
    },
  });
}
