import { describe, expect, test, vi } from "vite-plus/test";
import type { Timeline, Landing } from "../../shared/timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import { migratedDatabase, d1 } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore } from "../tracker/store.ts";
import { migrateLegacyTimeline } from "./migration.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_SCRIPT } from "../ci/compact-script.ts";

const rpc = vi.hoisted(() => ({
  timelineById: vi.fn(),
  beginLegacyMigration: vi.fn(),
  completeLegacyMigration: vi.fn(),
}));
const provider = vi.hoisted(() => ({
  lsRefs: vi.fn(),
  ensureWorkSource: vi.fn(),
  writeRefs: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => rpc }));
vi.mock(import("../artifacts.ts"), async (original) => ({
  ...(await original()),
  lsRefs: provider.lsRefs,
}));
vi.mock(import("./sources.ts"), async (original) => ({
  ...(await original()),
  ensureWorkSource: provider.ensureWorkSource,
}));
vi.mock("./bookmarks.ts", () => ({ writeRefs: provider.writeRefs }));

function fixture(status: Timeline["status"] = "active") {
  const sql = migratedDatabase();
  const durable = durableStorage();
  const store = new TrackerStore(durable.sql, durable.transactionSync);
  sql.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES ('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote,default_branch)
      VALUES ('a','owner','a','private','canonical-a','https://example/a','main'),
             ('b','owner','b','private','canonical-b','https://example/b','main');`);
  const timeline: Timeline = {
    id: "legacy-id",
    slug: "legacy",
    name: "Legacy",
    policy: "approval",
    experimental: false,
    parentId: null,
    forkPoint: { commits: { a: "base-a", b: "base-b" }, trackerCursor: 0 },
    repos: ["a", "b"].map((id) => ({ id, owner: "owner", name: id, bookmark: "timeline/legacy" })),
    status,
    accountableId: "owner",
    startedBy: "owner",
    agentIds: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pushedAt: null,
  };
  durable.db
    .prepare("INSERT INTO timelines(id,data) VALUES (?,?)")
    .run(timeline.id, JSON.stringify(timeline));
  const reply = (fn: () => unknown) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, status: 409, code: "blocked", error: String(error) };
    }
  };
  rpc.timelineById.mockImplementation((id: string) => reply(() => store.timelines.byId(id)));
  rpc.beginLegacyMigration.mockImplementation((id: string) =>
    reply(() => store.timelines.beginLegacyMigration(id)),
  );
  rpc.completeLegacyMigration.mockImplementation((id: string, repos: Timeline["repos"]) =>
    reply(() => store.timelines.completeLegacyMigration(id, repos)),
  );
  const heads: Record<string, string> = { "canonical-a": "head-a", "canonical-b": "head-b" };
  provider.lsRefs.mockImplementation(async (_env, name: string) =>
    heads[name] ? [{ name: "refs/heads/timeline/legacy", oid: heads[name] }] : [],
  );
  provider.writeRefs.mockImplementation(
    async (_env, repo: { artifacts_name: string }, writes: { ref: string; old: string }[]) => {
      if (heads[repo.artifacts_name] !== writes[0]!.old)
        return [{ ref: writes[0]!.ref, ok: false }];
      delete heads[repo.artifacts_name];
      return [{ ref: writes[0]!.ref, ok: true }];
    },
  );
  let failRepo: string | null = "b";
  const allocated = new Map<string, string>();
  provider.ensureWorkSource.mockImplementation(
    async (
      _env,
      repo: { id: string },
      input: { base: SourceSnapshot; initialHead: SourceSnapshot },
    ) => {
      if (repo.id === failRepo) {
        failRepo = null;
        throw new Error("fork interrupted");
      }
      const previous = allocated.get(repo.id);
      if (previous && previous !== input.initialHead.commit)
        throw new Error("fork moved from frozen input");
      allocated.set(repo.id, input.initialHead.commit);
      const source = {
        sourceId: `work_${repo.id}`,
        repoId: repo.id,
        kind: "timeline-work",
        timelineId: timeline.id,
        ref: "refs/heads/work",
      };
      durable.db
        .prepare(`INSERT INTO timeline_source_allocations(source_id,timeline_id,repo_id,data) VALUES (?,?,?,?)
      ON CONFLICT(source_id) DO NOTHING`)
        .run(source.sourceId, timeline.id, repo.id, JSON.stringify({ state: "ready" }));
      return { source };
    },
  );
  const env = {
    DB: d1(sql),
    ARTIFACTS: {
      get: async () => ({
        readCommit: async (oid: string) => ({ treeHash: `tree-${oid}` }),
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;
  return { sql, durable, store, env, timeline, heads, allocated };
}

describe("finite legacy source cutover", () => {
  test("a partial allocation leaves routing frozen; retries fork the frozen heads and switch all repositories once", async () => {
    const f = fixture();
    await expect(migrateLegacyTimeline(f.env, "owner", f.timeline.id)).rejects.toThrow(
      "fork interrupted",
    );
    const frozen = f.store.timelines.byId(f.timeline.id);
    expect(frozen.migrationState).toBe("frozen");
    expect(frozen.repos.map((repo) => repo.source)).toEqual([undefined, undefined]);
    expect(f.heads).toEqual({ "canonical-a": "head-a", "canonical-b": "head-b" });
    const migrated = await migrateLegacyTimeline(f.env, "owner", f.timeline.id);
    expect(migrated.migrationState).toBe("ready");
    expect(
      migrated.repos.map((repo) => [
        repo.source?.sourceId,
        repo.logicalBase?.commit,
        repo.bookmark,
      ]),
    ).toEqual([
      ["work_a", "base-a", "work"],
      ["work_b", "base-b", "work"],
    ]);
    expect([...f.allocated]).toEqual([
      ["a", "head-a"],
      ["b", "head-b"],
    ]);
    expect(f.heads).toEqual({});
    expect(await migrateLegacyTimeline(f.env, "owner", f.timeline.id)).toEqual(migrated);
    f.sql.close();
    f.durable.db.close();
  });

  test("ended records gain historical provenance without allocating or deleting Git", async () => {
    const f = fixture("abandoned");
    const migrated = await migrateLegacyTimeline(f.env, "owner", f.timeline.id);
    expect(
      migrated.repos.map((repo) => [repo.source?.kind, repo.source?.sourceId, repo.bookmark]),
    ).toEqual([
      ["canonical-historical", "canonical", "timeline/legacy"],
      ["canonical-historical", "canonical", "timeline/legacy"],
    ]);
    expect([...f.allocated]).toEqual([]);
    expect(f.heads).toEqual({ "canonical-a": "head-a", "canonical-b": "head-b" });
    f.sql.close();
    f.durable.db.close();
  });

  test("a tombstoned canonical repository prevents allocation and never resurrects routing", async () => {
    const f = fixture();
    f.sql.exec("UPDATE repos SET deleted_at='2026-10-04' WHERE id='a'");
    await expect(migrateLegacyTimeline(f.env, "owner", f.timeline.id)).rejects.toThrow(
      "cannot be resurrected",
    );
    expect([...f.allocated]).toEqual([]);
    expect(f.store.timelines.byId(f.timeline.id).repos.every((repo) => !repo.source)).toBe(true);
    f.sql.close();
    f.durable.db.close();
  });

  test("partly landed legacy work requires explicit abandonment and retains its successful receipt without replay", async () => {
    const f = fixture("partly_landed");
    const landing: Landing = {
      id: "old-landing",
      timelineId: f.timeline.id,
      slug: f.timeline.slug,
      checkpointId: "old-checkpoint",
      checkpointNumber: 1,
      state: "failed",
      reason: "second repository failed",
      trigger: "request",
      requestedBy: { actorId: "owner", accountableId: "owner", agentId: null },
      version: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      repos: f.timeline.repos.map((repo, index) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        commit: `head-${repo.id}`,
        base: `base-${repo.id}`,
        merge: index === 0 ? "already-integrated" : null,
        attempt: 1,
        state: index === 0 ? "advanced" : "failed",
        mergeRun: null,
        gateRun: null,
        reason: null,
      })),
    };
    f.durable.db
      .prepare("INSERT INTO timeline_landings(id,timeline_id,created_at,data) VALUES (?,?,?,?)")
      .run(landing.id, f.timeline.id, landing.createdAt, JSON.stringify(landing));
    await expect(migrateLegacyTimeline(f.env, "owner", f.timeline.id)).rejects.toThrow(
      "Resolve the legacy landing",
    );
    expect(() =>
      f.store.timelines.resolveLegacyLanding(f.timeline.id, 1, "cancel-unadvanced", "reviewed"),
    ).toThrow("cannot be canceled or replayed");
    f.store.timelines.resolveLegacyLanding(
      f.timeline.id,
      1,
      "accept-partial-and-abandon",
      "Keep A receipt; abandon remaining B.",
    );
    const migrated = await migrateLegacyTimeline(f.env, "owner", f.timeline.id);
    expect(migrated.status).toBe("abandoned");
    expect(migrated.repos.map((repo) => repo.source?.kind)).toEqual([
      "canonical-historical",
      "canonical-historical",
    ]);
    expect(f.store.timelines.landing(f.timeline.slug)?.repos[0]).toMatchObject({
      state: "advanced",
      merge: "already-integrated",
    });
    expect([...f.allocated]).toEqual([]);
    expect(f.heads).toEqual({ "canonical-a": "head-a", "canonical-b": "head-b" });
    f.sql.close();
    f.durable.db.close();
  });

  test("migrated legacy work materializes B-to-T rather than an empty T-to-T delta", async () => {
    const root = mkdtempSync(join(tmpdir(), "migrated-compact-"));
    const f = fixture();
    const identity = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env: identity, encoding: "utf8" }).trim();
    try {
      const canonical = join(root, "repo.git"),
        local = join(root, "local"),
        source = join(root, "repo@search.git");
      git(root, "init", "--quiet", "--bare", "-b", "main", canonical);
      git(root, "clone", "--quiet", canonical, local);
      writeFileSync(join(local, "base"), "base\n");
      git(local, "add", ".");
      git(local, "commit", "--quiet", "-m", "base");
      const base = git(local, "rev-parse", "HEAD");
      git(local, "push", "--quiet", "origin", "HEAD:main");
      writeFileSync(join(local, "legacy"), "retained legacy work\n");
      git(local, "add", ".");
      git(local, "commit", "--quiet", "-m", "legacy");
      const head = git(local, "rev-parse", "HEAD");
      git(root, "clone", "--quiet", "--bare", local, source);
      git(local, "push", "--quiet", source, `${head}:refs/heads/work`);
      git(local, "checkout", "--quiet", "--detach", base);
      writeFileSync(join(local, "independent"), "canonical change\n");
      git(local, "add", ".");
      git(local, "commit", "--quiet", "-m", "main");
      const main = git(local, "rev-parse", "HEAD");
      git(local, "push", "--quiet", "origin", "HEAD:main");
      f.timeline.forkPoint.commits = { a: base, b: base };
      f.durable.db
        .prepare("UPDATE timelines SET data=? WHERE id=?")
        .run(JSON.stringify(f.timeline), f.timeline.id);
      f.heads["canonical-a"] = head;
      f.heads["canonical-b"] = head;
      const env = {
        ...f.env,
        ARTIFACTS: {
          get: async () => ({
            readCommit: async (oid: string) => ({
              treeHash: git(local, "rev-parse", `${oid}^{tree}`),
            }),
            [Symbol.dispose]() {},
          }),
        },
      } as unknown as Env;
      await expect(migrateLegacyTimeline(env, "owner", f.timeline.id)).rejects.toThrow(
        "fork interrupted",
      );
      const migrated = await migrateLegacyTimeline(env, "owner", f.timeline.id);
      const entry = migrated.repos[0]!;
      const result = spawnSync("bash", ["-c", COMPACT_SCRIPT], {
        cwd: local,
        encoding: "utf8",
        env: {
          ...identity,
          GITMATRIX_URL: `file://${root}`,
          GITMATRIX_REPOSITORY: "repo",
          GITMATRIX_TOKEN: "local",
          GITMATRIX_COMMIT: f.allocated.get("a")!,
          GITMATRIX_LANDING_SOURCE: entry.source!.sourceId,
          GITMATRIX_LANDING_TIMELINE: "search",
          GITMATRIX_LANDING_SOURCE_TREE: git(local, "rev-parse", `${head}^{tree}`),
          GITMATRIX_LANDING_LOGICAL_COMMIT: entry.logicalBase!.commit,
          GITMATRIX_LANDING_LOGICAL_TREE: entry.logicalBase!.tree,
          GITMATRIX_LANDING_BASE: main,
          GITMATRIX_LANDING_BRANCH: "gitmatrix/landing/migrated",
          GITMATRIX_LANDING_OLD: "",
          GITMATRIX_LANDING_NAME: "test",
          GITMATRIX_LANDING_EMAIL: "test@example.invalid",
          GITMATRIX_LANDING_DATE: "2000-01-01T00:00:00Z",
          GITMATRIX_LANDING_MESSAGE: "Migrated work",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const candidate = git(canonical, "rev-parse", "refs/heads/gitmatrix/landing/migrated");
      expect(git(canonical, "show", `${candidate}:legacy`)).toBe("retained legacy work");
      expect(git(canonical, "show", `${candidate}:independent`)).toBe("canonical change");
      expect(git(canonical, "rev-list", "--parents", "-n", "1", candidate)).toBe(
        `${candidate} ${main}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      f.sql.close();
      f.durable.db.close();
    }
  });
});
