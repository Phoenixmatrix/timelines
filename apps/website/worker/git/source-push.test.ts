import { afterEach, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { retainProgress, reconcileSourcePushes } from "./source-push.ts";
import { writeRefs } from "../timelines/bookmarks.ts";

const recovery = vi.hoisted(() => ({ tip: "old", settled: [] as string[] }));
vi.mock("../tracker/stub.ts", () => ({
  trackerObject: () => ({
    sourcePushes: async () => ({
      ok: true,
      value: [
        {
          operationId: "pending",
          sourceId: "work_a",
          commands: [{ ref: "refs/heads/work", old: "old", new: "new" }],
        },
      ],
    }),
    finishSourcePush: async (id: string) => {
      recovery.settled.push(id);
      return { ok: true };
    },
  }),
}));
vi.mock("../artifacts.ts", () => ({
  lsRefs: vi.fn(async () => [{ name: "refs/heads/work", oid: recovery.tip }]),
  forgetUpstreamTokens: vi.fn(),
  isArtifactsError: vi.fn(() => false),
}));
vi.mock("../timelines/bookmarks.ts", () => ({ writeRefs: vi.fn(async () => [{ ok: true }]) }));
afterEach(() => vi.clearAllMocks());

test("retains rewrite roots and every merged ancestor in its exact source", async () => {
  const sqlite = migratedDatabase();
  const graph: Record<string, string[]> = {
    tip: ["left", "right"],
    left: ["base"],
    right: ["base"],
    base: [],
  };
  const read = vi.fn(async (oid: string) => (graph[oid] ? { parents: graph[oid] } : null));
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: { get: async () => ({ readCommit: read, [Symbol.dispose]() {} }) },
  } as unknown as Env;
  const repo = {
    id: "repo",
    source_id: "work_a",
    artifacts_name: "physical-a",
    artifacts_remote: "https://physical-a",
  };
  await retainProgress(env, repo, "operation", "tip");
  expect(vi.mocked(writeRefs)).toHaveBeenCalledWith(env, repo, [
    { ref: "refs/gitmatrix/progress/tip", old: null, new: "tip" },
  ]);
  expect(
    sqlite
      .prepare("SELECT source_id, commit_oid FROM source_progress_members ORDER BY commit_oid")
      .all(),
  ).toEqual([
    { source_id: "work_a", commit_oid: "base" },
    { source_id: "work_a", commit_oid: "left" },
    { source_id: "work_a", commit_oid: "right" },
    { source_id: "work_a", commit_oid: "tip" },
  ]);
  expect(read.mock.calls.filter(([oid]) => oid === "base")).toHaveLength(1);
  await expect(retainProgress(env, repo, "missing", "missing")).rejects.toThrow("unavailable");
  sqlite.close();
});

test("tombstoned push recovery settles observed-new only and retains ambiguous observed-old", async () => {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote,deleted_at) VALUES('repo','owner','app','private','canonical','https://canonical','2026-01-01');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
    VALUES('work_a','repo','timeline','search','owner','physical','https://physical','ready','allocate','canonical','old','tree','refs/heads/main','canonical','old','tree','refs/heads/main','2026-01-01','2026-01-01');
  `);
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: {
      get: async () => ({
        readCommit: async (oid: string) => ({ parents: oid === "new" ? ["old"] : [] }),
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;
  recovery.tip = "old";
  recovery.settled = [];
  expect(await reconcileSourcePushes(env, "repo")).toEqual([]);
  expect(recovery.settled).toEqual([]);
  recovery.tip = "new";
  expect(await reconcileSourcePushes(env, "repo")).toEqual(["pending"]);
  expect(recovery.settled).toEqual(["pending"]);
  expect(
    sqlite.prepare("SELECT commit_oid FROM source_progress_members ORDER BY commit_oid").all(),
  ).toEqual([{ commit_oid: "new" }, { commit_oid: "old" }]);
  sqlite.close();
});
