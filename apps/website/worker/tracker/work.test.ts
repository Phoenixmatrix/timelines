// An issue's linked work and the Chronicle over HTTP (CORE-250): real D1 and
// registry databases and a real tracker store behind the routes. Work in a
// repository the viewer can't read is left out without a trace.

import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Chronicle, LinkedWork } from "../../shared/chronicle.ts";
import type { Landing } from "../../shared/timelines.ts";
import type { Mutation } from "../../shared/tracker.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { durableStorage } from "../testing/durable.ts";
import { d1 } from "../testing/d1.ts";
import { tracker as trackerApi } from "./api.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { ownedTimeline, ownedCheckpointRepo } from "../testing/timeline-source.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { initializeFreshTrackerSpace } from "./space-migration.ts";
import { fakeDurableObjectId } from "../testing/durable-state.ts";

const closers: { close(): void }[] = [];
afterEach(() => {
  for (const c of closers) c.close();
  closers.length = 0;
});

const oid = (n: number) => n.toString(16).padStart(40, "0");
const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const carl: Actor = { id: "carl", slug: "carl", displayName: "Carl", isSiteAdmin: false };

async function world() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, registry } = fresh;
  closers.push(fresh);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'),
      ('carl', 'user', 'carl', 'Carl');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four) VALUES
      ('ann-token','ann','fixture','write','ann-fixture-hash','test'),
      ('ben-token','ben','fixture','write','ben-fixture-hash','test'),
      ('carl-token','carl','fixture','write','carl-fixture-hash','test');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "orbit", slug: "orbit", displayName: "Orbit" },
    actorId: "ann",
    members: [
      ...["ann", "ben"].map((accountId) => ({
        accountId,
        role: "member" as const,
        grant: {
          role: "member" as const,
          repositoryRole: "none" as const,
          packageRole: "read" as const,
        },
      })),
      { accountId: "carl", role: "owner" },
    ],
  });
  await seedSpaceFixture(d1(sqlite), {
    organization: {
      id: "other-company",
      slug: "other-company",
      displayName: "Other",
      kind: "company",
    },
    space: { id: "other", slug: "other", displayName: "Other" },
    actorId: "ann",
    members: [],
  });
  sqlite.exec(`
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt-bot', 'builder', 'ann');
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r-engine', 'orbit', 'engine', 'private', 'a1', 'https://a/1'),
      ('r-secret', 'orbit', 'secret', 'private', 'a2', 'https://a/2');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES
      ('r-engine', 'ann', 'read'), ('r-secret', 'ben', 'write'), ('r-engine', 'carl', 'read');
    -- Agent work contexts: the issue's, in both repositories, and another issue's.
    INSERT INTO step_contexts (repo_id, change_id, commit_oid, author_id, accountable_id, timeline, issue_key, summary, context, committed_at, verified_at) VALUES
      ('r-engine', 'chgone', '${oid(6)}', 'agt-bot', 'ann', 'search', 'CORE-1', 'Add ranking', '{"why":"Results were unordered.","model":"claude-opus"}', '2026-09-01T10:00:00.000Z', '2026-09-01T10:01:00.000Z'),
      ('r-secret', 'chgtwo', '${oid(7)}', 'agt-bot', 'ann', 'search', 'CORE-1', 'Hidden work', '{}', '2026-09-01T10:05:00.000Z', NULL),
      ('r-engine', 'chgthree', '${oid(8)}', 'agt-bot', 'ann', NULL, 'CORE-9', 'Other issue', '{}', '2026-09-01T10:06:00.000Z', NULL);
    INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at) VALUES
      ('r-engine', '@day:2026-09-02', '${oid(6)}', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
      ('r-secret', '@day:2026-09-02', '${oid(7)}', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
      ('r-engine', '@day:2026-09-03', '${oid(6)}', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
    INSERT INTO release_note_entries (id, repo_id, release, subject, kind, category, title, summary, tracker_space_id, issue_id, issue_key, commits, shipped_at, inputs_hash, updated_at) VALUES
      ('n1', 'r-engine', '@day:2026-09-02', 'CORE-1', 'issue', 'feature', 'Search ranks results', '', 'orbit', 'work', 'CORE-1', '["${oid(6)}"]', '2026-09-02T00:00:00.000Z', 'h1', '2026-09-02T00:00:00.000Z'),
      ('n2', 'r-secret', '@day:2026-09-02', 'CORE-1', 'issue', 'feature', 'Hidden note', '', 'orbit', 'work', 'CORE-1', '["${oid(7)}"]', '2026-09-02T00:00:00.000Z', 'h2', '2026-09-02T00:00:00.000Z'),
      ('n3', 'r-engine', '@day:2026-09-03', 'CORE-1', 'issue', 'fix', 'Another tracker''s CORE-1', '', 'other', 'x', 'CORE-1', '[]', '2026-09-03T00:00:00.000Z', 'h3', '2026-09-03T00:00:00.000Z');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, title, status, created_at, landing_id) VALUES
      ('run1', 'r-engine', 1, '${oid(6)}', 'refs/heads/timeline/search', 'push', 'Add ranking', 'succeeded', '2026-09-01T10:02:00.000Z', NULL),
      ('run7', 'r-engine', 7, '${oid(4)}', 'refs/heads/gitmatrix/landing/search', 'manual', 'Merge', 'succeeded', '2026-09-01T12:00:00.000Z', 'land1'),
      ('run8', 'r-engine', 8, '${oid(4)}', 'refs/heads/gitmatrix/landing/search', 'manual', 'Gates', 'succeeded', '2026-09-01T12:05:00.000Z', 'land1'),
      ('run9', 'r-secret', 9, '${oid(5)}', 'refs/heads/gitmatrix/landing/search', 'manual', 'Merge', 'succeeded', '2026-09-01T12:00:00.000Z', 'land1'),
      ('run10', 'r-secret', 10, '${oid(7)}', 'refs/heads/timeline/search', 'push', 'Hidden', 'failed', '2026-09-01T10:06:00.000Z', NULL);
    -- Commit messages naming CORE-1 (CORE-22): in engine, in secret, one that
    -- named another tracker's CORE-1, and one left ambiguous; a run of the first.
    INSERT INTO commit_issue_mentions (repo_id, commit_oid, issue_key, change_id, resolution, tracker_space_id, issue_id, title, committed_at, first_ref, pushed_at) VALUES
      ('r-engine', '${oid(20)}', 'CORE-1', 'chgmention', 'linked', 'orbit', 'work', 'CORE-1: Tune ranking weights', '2026-09-03T09:00:00.000Z', 'refs/heads/main', '2026-09-03T09:01:00.000Z'),
      ('r-engine', '${oid(19)}', 'CORE-1', NULL, 'linked', 'orbit', 'work', 'Prepare for CORE-1', NULL, NULL, '2026-09-02T09:01:00.000Z'),
      ('r-secret', '${oid(21)}', 'CORE-1', NULL, 'linked', 'orbit', 'work', 'CORE-1 hidden mention', '2026-09-03T10:00:00.000Z', 'refs/heads/main', '2026-09-03T10:01:00.000Z'),
      ('r-engine', '${oid(22)}', 'CORE-1', NULL, 'linked', 'other', 'x', 'Other tracker work', '2026-09-03T11:00:00.000Z', 'refs/heads/main', '2026-09-03T11:01:00.000Z'),
      ('r-engine', '${oid(23)}', 'CORE-1', NULL, 'ambiguous', NULL, NULL, 'Ambiguous CORE-1', '2026-09-03T12:00:00.000Z', 'refs/heads/main', '2026-09-03T12:01:00.000Z');
    -- One pushed to a timeline's work source: it opens there (CORE-296).
    UPDATE commit_issue_mentions SET source_id = 'work_search' WHERE commit_oid = '${oid(19)}';
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, title, status, created_at, landing_id) VALUES
      ('run20', 'r-engine', 20, '${oid(20)}', 'refs/heads/main', 'push', 'CORE-1: Tune ranking weights', 'succeeded', '2026-09-03T09:02:00.000Z', NULL);
    INSERT INTO deployments (repo_id, environment, timeline_slug, timeline_id, checkpoint_id, commit_oid, url, status, run_id, created_at) VALUES
      ('r-engine', 'timeline-search', 'search', NULL, NULL, '${oid(2)}', 'https://search.preview.test', 'active', NULL, '2026-09-01T11:00:00.000Z'),
      ('r-secret', 'timeline-search', 'search', NULL, NULL, '${oid(3)}', 'https://hidden.preview.test', 'active', NULL, '2026-09-01T11:00:00.000Z');
    -- What ran, as recorded (CORE-351).
    UPDATE deployments SET provider = 'cloudflare', provider_service = 'engine',
      provider_version_id = 'ver-2', provider_deployment_id = 'dep-2', percentage = 10,
      artifact_publish_id = 'pub',
      artifact_package_id = 'pkg', artifact_format = 'npm', artifact_name = '@orbit/ranker',
      artifact_version = '1.2.0', artifact_digest = NULL
      WHERE repo_id = 'r-engine';
  `);
  registry.exec(`
    INSERT INTO repositories (id, space_id, key, format, kind, visibility, config, created_at, updated_at) VALUES
      ('feed', 'orbit', 'orbit', 'npm', 'local', 'private', '{}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at) VALUES
      ('pkg', 'feed', '@orbit/ranker', '@orbit/ranker', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('hid', 'feed', '@orbit/hidden', '@orbit/hidden', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO publishes (id, feed_id, format, package_id, version, action, status, git_repo_id, commit_oid, actor, actor_label, via, at) VALUES
      ('u1', 'feed', 'npm', 'pkg', '1.2.0', 'publish', 'active', 'r-engine', '${oid(6)}', 'job:j', 'ci', 'ci', '2026-09-01T10:10:00Z'),
      ('u2', 'feed', 'npm', 'hid', '0.1.0', 'publish', 'active', 'r-secret', '${oid(7)}', 'job:k', 'ci', 'ci', '2026-09-01T10:10:00Z'),
      ('u3', 'feed', 'npm', 'pkg', '1.3.0', 'publish', 'active', 'r-engine', '${oid(20)}', 'job:m', 'ci', 'ci', '2026-09-03T09:05:00Z');
  `);

  // The tracker: CORE-1 worked in timeline "search", which touches both repositories.
  const { db, sql, transactionSync } = durableStorage();
  closers.push(db);
  const identity = fakeDurableObjectId("orbit");
  Reflect.set(fresh.env, "TRACKER", { idFromName: fakeDurableObjectId });
  await initializeFreshTrackerSpace(
    fresh.env,
    {
      id: identity,
      storage: { sql, transactionSync },
    } as unknown as Pick<DurableObjectState, "id" | "storage">,
    "orbit",
  );
  let now = Date.parse("2026-09-01T09:00:00Z");
  const store = new TrackerStore(sql, transactionSync, () => now);
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    credential: { kind: "token", id: "ann-token" },
    agents: [],
    agentId: null,
    spaceId: "orbit",
    contractVersion: 4,
    migrationEpoch: 0,
    authorizationVersion: 1,
    space: {
      id: "orbit",
      slug: "orbit",
      displayName: "Orbit",
      organizationId: "company",
      organization: {
        id: "company",
        slug: "company",
        displayName: "Company",
        avatarUrl: null,
        kind: "company",
        personalAccountId: null,
        defaultSpaceId: "orbit",
        createdAt: "",
      },
      archivedAt: null,
      authorizationVersion: 1,
      createdAt: "",
    },
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let n = 0;
  const mutate = (timeline: string | undefined, ...mutations: Mutation[]) =>
    store.mutate(access, {
      contractVersion: 4,
      spaceId: access.spaceId,
      migrationEpoch: access.migrationEpoch,
      operationId: `op-${++n}`,
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  mutate(
    undefined,
    { kind: "team.create", id: "team", data: { key: "CORE", name: "Core" } },
    { kind: "issue.create", id: "work", data: { teamId: "team", title: "Rank search results" } },
  );
  const repos = [
    { id: "r-engine", space: "orbit", name: "engine" },
    { id: "r-secret", space: "orbit", name: "secret" },
  ];
  const search = ownedTimeline(store.timelines, access, {
    slug: "search",
    parent: null,
    repos,
    commits: { "r-engine": oid(1), "r-secret": oid(1) },
  });
  now += 3_600_000;
  const token = String(
    mutate("search", { kind: "issue.claim", id: "work", data: { agent: "ann" } }).results[0]!
      .leaseToken,
  );
  mutate("search", {
    kind: "issue.complete",
    id: "work",
    data: { leaseToken: token, evidence: "Ranked." },
  });
  store.timelines.createCheckpoint(access, "search", {
    summary: "Ranking ready",
    repos: [
      ownedCheckpointRepo(store.timelines, "search", {
        ...repos[0]!,
        commit: oid(2),
        base: oid(1),
        changes: [],
      }),
      ownedCheckpointRepo(store.timelines, "search", {
        ...repos[1]!,
        commit: oid(3),
        base: oid(1),
        changes: [],
      }),
    ],
  });
  const landing: Landing = {
    id: "land1",
    timelineId: search.id,
    slug: "search",
    checkpointId: "cp",
    checkpointNumber: 1,
    state: "landed",
    repos: [
      {
        ...repos[0]!,
        commit: oid(2),
        base: oid(1),
        merge: oid(4),
        attempt: 1,
        state: "advanced",
        mergeRun: { id: "run7", number: 7 },
        gateRun: { id: "run8", number: 8 },
        reason: null,
      },
      {
        ...repos[1]!,
        commit: oid(3),
        base: oid(1),
        merge: oid(5),
        attempt: 1,
        state: "advanced",
        mergeRun: { id: "run9", number: 9 },
        gateRun: null,
        reason: null,
      },
    ],
    reason: null,
    trigger: "auto",
    authority: {
      spaceId: "orbit",
      migrationEpoch: 0,
      personId: "ann",
      agentId: null,
      credential: { kind: "token", id: "ann-token" },
    },
    requestedBy: { actorId: "ann", accountableId: "ann", agentId: null },
    version: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:10:00.000Z",
  };
  db.prepare(
    "INSERT INTO timeline_landings (id, timeline_id, created_at, data) VALUES (?, ?, ?, ?)",
  ).run(landing.id, landing.timelineId, landing.createdAt, JSON.stringify(landing));

  const reply = <T>(fn: () => T) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      if (error instanceof TrackerError)
        return {
          ok: false,
          status: error.status,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      throw error;
    }
  };
  const stub = {
    chronicle: async (a: Access, options: Parameters<TrackerStore["chronicle"]>[1]) =>
      reply(() => store.chronicle(a, options)),
    issueWork: async (_access: Access, issue: string) => reply(() => store.issueWork(issue)),
  };
  const env = {
    ...fresh.env,
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    TRACKER: { idFromName: fakeDurableObjectId, getByName: () => stub },
  } as unknown as Env;
  const call = (actor: Actor | null, path: string) => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set(
        "actor",
        actor ? { ...actor, credential: { kind: "token", id: `${actor.id}-token` } } : null,
      );
      await next();
    });
    app.route("/api", trackerApi);
    return app.request(`/api${path}`, { headers: { "X-Gitmatrix-Content-Version": "4" } }, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext);
  };
  return { call, sqlite };
}

describe("an issue's linked work", () => {
  test("repository read does not replace package permission and revocation applies on the next read", async () => {
    const { call, sqlite } = await world();
    const before = await call(ann, "/tracker/orbit/issues/CORE-1/work");
    expect(((await before.json()) as LinkedWork).packages).not.toHaveLength(0);
    sqlite
      .prepare("UPDATE space_grants SET package_role='none' WHERE space_id=? AND account_id=?")
      .run("orbit", "ann");
    const after = await call(ann, "/tracker/orbit/issues/CORE-1/work");
    const work = (await after.json()) as LinkedWork;
    expect(work.commits.length).toBeGreaterThan(0);
    expect(work.packages).toEqual([]);
    expect(work.mentions.every((mention) => mention.packages.length === 0)).toBe(true);
  });

  test("returns its commits, work contexts, runs, previews, packages, timeline and release notes", async () => {
    const { call } = await world();
    const response = await call(ann, "/tracker/orbit/issues/CORE-1/work");
    expect(response.status).toBe(200);
    const work = (await response.json()) as LinkedWork;
    expect(work.issue).toMatchObject({ key: "CORE-1", status: "done_in_timeline" });
    expect(work.steps).toMatchObject([
      {
        repo: { space: "orbit", name: "engine" },
        changeId: "chgone",
        commitOid: oid(6),
        summary: "Add ranking",
        author: { kind: "agent", name: "builder", accountable: { displayName: "Ann" } },
        verified: true,
        why: "Results were unordered.",
        model: "claude-opus",
        href: `/orbit/engine?commit=${oid(6)}`,
      },
    ]);
    expect(work.commits.map((c) => [c.oid, c.sources.sort()])).toEqual(
      expect.arrayContaining([
        [oid(6), ["release-note", "step"]],
        [oid(2), ["checkpoint"]],
        [oid(4), ["landing"]],
      ]),
    );
    expect(work.commits).toHaveLength(3);
    expect(work.runs.map((r) => [r.number, r.kind, r.href])).toEqual([
      [8, "landing", "/orbit/engine/ci/8"],
      [7, "landing", "/orbit/engine/ci/7"],
      [1, "push", "/orbit/engine/ci/1"],
    ]);
    expect(work.deployments).toMatchObject([
      {
        repoId: "r-engine",
        sourceId: "canonical",
        environment: "timeline-search",
        status: "active",
        commit: oid(2),
        href: "https://search.preview.test",
        provider: { name: "cloudflare", service: "engine", versionId: "ver-2" },
        artifact: { name: "@orbit/ranker", version: "1.2.0", digest: null },
        percentage: 10,
      },
    ]);
    expect(work.packages).toMatchObject([
      {
        format: "npm",
        name: "@orbit/ranker",
        version: "1.2.0",
        space: "orbit",
        href: "/orbit/-/packages/npm/%40orbit/ranker",
      },
    ]);
    expect(work.timelines).toMatchObject([
      {
        slug: "search",
        href: "/tracker/orbit/timelines?tl=search",
        checkpoints: [{ number: 1, summary: "Ranking ready", commits: [{ oid: oid(2) }] }],
        landings: [
          {
            state: "landed",
            runs: [
              { number: 7, href: "/orbit/engine/ci/7" },
              { number: 8, href: "/orbit/engine/ci/8" },
            ],
          },
        ],
      },
    ]);
    expect(work.releaseNotes).toEqual([
      {
        repo: { id: "r-engine", space: "orbit", name: "engine" },
        release: "@day:2026-09-02",
        label: "2026-09-02",
        title: "Search ranks results",
        category: "feature",
        shippedAt: "2026-09-02T00:00:00.000Z",
        href: "/orbit/engine/releases/%40day%3A2026-09-02",
      },
    ]);
    expect(work.truncated).toBe(false);
  });

  test("leaves out what lives in repositories the viewer can't read, without a trace", async () => {
    const { call } = await world();
    const text = await (await call(ann, "/tracker/orbit/issues/CORE-1/work")).text();
    for (const hidden of ["secret", "r-secret", oid(3), oid(5), oid(7), "Hidden", "hidden"])
      expect(text).not.toContain(hidden);
    // Ben reads the secret repository but not engine: he sees the other half.
    const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
    const work = (await (
      await call(ben, "/tracker/orbit/issues/CORE-1/work")
    ).json()) as LinkedWork;
    expect(work.steps.map((s) => s.repo.name)).toEqual(["secret"]);
    expect(work.packages.map((p) => p.name)).toEqual(["@orbit/hidden"]);
    expect(JSON.stringify(work)).not.toContain("engine");
  });

  test("lists the commits that mention it apart, with their runs and packages, as the viewer may read them", async () => {
    const { call } = await world();
    const work = (await (
      await call(ann, "/tracker/orbit/issues/CORE-1/work")
    ).json()) as LinkedWork;
    expect(work.mentions).toEqual([
      {
        repo: { id: "r-engine", space: "orbit", name: "engine" },
        oid: oid(20),
        changeId: "chgmention",
        title: "CORE-1: Tune ranking weights",
        committedAt: "2026-09-03T09:00:00.000Z",
        ref: "refs/heads/main",
        pushedAt: "2026-09-03T09:01:00.000Z",
        href: `/orbit/engine?commit=${oid(20)}`,
        runs: [
          expect.objectContaining({
            number: 20,
            status: "succeeded",
            commit: oid(20),
            href: "/orbit/engine/ci/20",
          }),
        ],
        packages: [
          expect.objectContaining({
            name: "@orbit/ranker",
            version: "1.3.0",
            commit: oid(20),
            href: "/orbit/-/packages/npm/%40orbit/ranker",
          }),
        ],
      },
      // Found in history: no committer time recorded, ordered by when it was seen.
      expect.objectContaining({
        oid: oid(19),
        committedAt: null,
        ref: null,
        href: `/orbit/engine?source=work_search&commit=${oid(19)}`,
        runs: [],
        packages: [],
      }),
    ]);
    // Mentions aren't evidence: their commit, run and package stay out of the explicit lists.
    for (const list of [work.commits, work.runs, work.packages])
      expect(JSON.stringify(list)).not.toContain(oid(20));
    // Another tracker's issue, an ambiguous key and an unreadable repository don't show.
    const text = JSON.stringify(work);
    for (const hidden of [oid(21), oid(22), oid(23)]) expect(text).not.toContain(hidden);
    // Ben reads secret, not engine: he sees only its mention.
    const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
    const his = (await (await call(ben, "/tracker/orbit/issues/CORE-1/work")).json()) as LinkedWork;
    expect(his.mentions.map((m) => [m.repo.name, m.oid])).toEqual([["secret", oid(21)]]);
  });

  test("needs tracker membership, and names a missing issue", async () => {
    const { call } = await world();
    expect((await call(null, "/tracker/orbit/issues/CORE-1/work")).status).toBe(401);
    expect((await call(carl, "/tracker/orbit/issues/CORE-1/work")).status).toBe(403);
    const missing = await call(ann, "/tracker/orbit/issues/CORE-404/work");
    expect(missing.status).toBe(404);
  });
});

describe("the Chronicle over HTTP", () => {
  test("reads a range, validates it, and needs membership", async () => {
    const { call } = await world();
    const ok = await call(
      ann,
      "/tracker/orbit/chronicle?from=2026-09-01T08:00:00Z&to=2026-09-01T12:00:00Z&q=",
    );
    expect(ok.status).toBe(200);
    const chronicle = (await ok.json()) as Chronicle;
    expect(chronicle.issues.map((i) => i.key)).toEqual(["CORE-1"]);
    expect(chronicle.issues[0]!.spans).toMatchObject([
      { holder: "ann", retained: { timeline: { slug: "search" } }, end: null },
    ]);
    expect(chronicle.issues[0]!.markers.map((m) => m.kind)).toEqual([
      "created",
      "evidence",
      "timeline-checkpoint",
    ]);
    expect(chronicle.density?.counts.length).toBeGreaterThan(0);
    expect(
      (await call(ann, "/tracker/orbit/chronicle?from=nonsense&to=2026-09-01T12:00:00Z")).status,
    ).toBe(400);
    expect(
      (
        await call(
          ann,
          "/tracker/orbit/chronicle?from=2026-09-01T08:00:00Z&to=2026-09-01T12:00:00Z&limit=999",
        )
      ).status,
    ).toBe(400);
    expect((await call(carl, "/tracker/orbit/chronicle?from=2026-09-01T08:00:00Z")).status).toBe(
      403,
    );
  });
});
