import { fixtureSpace } from "./content-fixtures.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RetentionSettings } from "../../apps/website/shared/retention.ts";
import type { Timeline } from "../../apps/website/shared/timelines.ts";
import type { QueueGm, RepoInventory } from "./queue-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

/** Shared real API/native-Git setup; each caller owns a fresh retention repository. */
export async function sourceRetentionFixture(
  ctx: HarnessContext,
  fixtures: SeedManifest,
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
      headers: {
        "X-Gitmatrix-Content-Version": "4",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
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
  return { owner, secret, name, repo, api, timelines, root, json, git };
}

/** Real owned Git/provider resources; the clock override applies only to this persona's run. */
export async function runSourceRetentionE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const { owner, secret, name, repo, api, timelines, root, json, git } =
    await sourceRetentionFixture(ctx, fixtures, record);
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
      {
        target: {
          kind: "space",
          id: (await fixtureSpace(ctx.origin, owner, fixtures.tokens.sam)).space.id,
        },
        categories,
        daysAhead,
        dryRun: false,
      },
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
      await delay(250);
    }
  };
  await gm(["repo", "create", name, "--space", owner], "sam", root);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Source Retention Fixture"]);
  await git(["config", "user.email", "retention@example.invalid"]);
  await writeFile(join(root, "README.md"), "# Owned source retention fixture\n");
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Retention fixture canonical base"]);
  await git(["push", `${ctx.origin}/${repo}.git`, "HEAD:main"]);
  const settingsPath = `/api/spaces/${owner}/retention`;
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
  await readable(defaults.landed.sourceId, defaults.commit);
  await state(defaults.abandoned.sourceId, "archived");
  await retain(31);
  await state(defaults.landed.sourceId, "purged");
  await state(defaults.abandoned.sourceId, "archived");
  await retain(91);
  await state(defaults.abandoned.sourceId, "purged");
  // Source expiry must not remove the independent 180-day timeline history.
  for (const source of [defaults.landed, defaults.abandoned])
    await json(`${timelines}/${source.slug}`);
  await git(["fetch", `${ctx.origin}/${repo}.git`, "main"]);
  await git(["checkout", "--detach", "FETCH_HEAD"]);
  const oid = await git(["rev-parse", "HEAD"]);
  const parent = await create("parent");
  const child = await create("child", parent.slug);
  await abandon(parent.slug);
  await readable(parent.sourceId, oid);
  await retain(91);
  await readable(parent.sourceId, oid);
  assert.equal(
    (await json<{ timeline: Timeline }>(`${timelines}/${child.slug}`)).timeline.status,
    "active",
  );
  record({
    archiveSurvivedDependencyAtExpiry: true,
    oid,
    parent,
    child,
  });
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
  for (const sourceId of [parent.sourceId, child.sourceId]) {
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
    await delay(250);
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
