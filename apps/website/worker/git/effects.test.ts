import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import type * as CiTrigger from "../ci/trigger.ts";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import { queueCandidateBranch, queueSourceBranch } from "../../shared/merge-queue.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { admitQueue, getQueue, type QueueState } from "../merge-queue/store.ts";
import { progressQueue } from "../merge-queue/scheduler.ts";
import { afterPush, type PushedRepo } from "./effects.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
// These observational consumers are not part of guaranteed notification delivery.
// Queue main CI has its own persisted deployment state and scheduler regressions.
vi.mock("../ci/trigger.ts", async (original) => ({
  ...(await original<typeof CiTrigger>()),
  onPush: vi.fn(async () => {}),
}));
vi.mock("../timelines/activity.ts", () => ({ logPush: vi.fn(async () => {}) }));

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','owner','app','private','a','https://a');
    INSERT INTO account_settings(account_id,ai_knowledge,ai_release_notes)
      VALUES('owner',1,1);
    INSERT INTO repo_mirrors(repo_id,url,enabled,status)
      VALUES('repo','https://mirror.example/app',1,'ok');
  `);
  const delivery = { fail: null as string | null };
  const sent: { type: string; repoId: string }[] = [];
  const knowledge = new Set<string>();
  const env = {
    DB: d1(sqlite),
    AI: {},
    JOBS: {
      async send(body: { type: string; repoId: string }) {
        if (delivery.fail === body.type) throw new Error(`${body.type} delivery unavailable`);
        sent.push(body);
      },
    },
    KNOWLEDGE_COORDINATOR: {
      getByName: () => ({
        async notify(repoId: string) {
          if (delivery.fail === "knowledge") throw new Error("knowledge delivery unavailable");
          knowledge.add(repoId);
        },
      }),
    },
  } as unknown as Env;
  const repo: PushedRepo = {
    id: "repo",
    owner_id: "owner",
    owner_slug: "owner",
    name: "app",
    default_branch: "main",
    artifacts_name: "a",
    artifacts_remote: "https://a",
  };
  const commit = "1".repeat(40);
  const state: QueueState = {
    entry: {
      id: commit,
      repo: { id: "repo", owner: "owner", name: "app" },
      commit,
      branch: "main",
      sourceBranch: queueSourceBranch(commit),
      candidateBranch: queueCandidateBranch(commit),
      status: "landed",
      base: "2".repeat(40),
      candidate: "3".repeat(40),
      mergeRun: 1,
      gateRun: 2,
      deployRun: 3,
      deployStatus: "succeeded",
      coveredBy: null,
      issueIds: [],
      remediationIssueId: null,
      failure: null,
      decision: null,
      attempts: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    actor: { id: "owner" },
    snapshot: LEGACY_AI_SNAPSHOT,
    mergeSource: commit,
    combinedIds: [],
    rebaseAttempts: 0,
    mergeRunId: null,
    gateRunId: null,
    deployRunId: null,
    resolution: null,
    resolutionInput: null,
    resolutionClaimed: false,
    classificationClaimed: false,
    effectsPending: true,
    remediationPending: false,
    history: [],
  };
  return { sqlite, env, repo, delivery, sent, knowledge, state };
}

test("work pushes do not mutate canonical push time or enqueue its mirror and release notes", async () => {
  const f = setup();
  const pending: Promise<unknown>[] = [];
  afterPush(
    f.env,
    { ...f.repo, source_id: "work_a", artifacts_name: "work-physical", default_branch: "work" },
    null,
    (work) => pending.push(work),
  );
  await Promise.all(pending);
  expect(f.sent).toEqual([]);
  expect(f.sqlite.prepare("SELECT pushed_at FROM repos WHERE id='repo'").get()).toEqual({
    pushed_at: null,
  });
  expect(f.sqlite.prepare("SELECT status FROM repo_mirrors").get()).toEqual({ status: "ok" });
  expect(f.sqlite.prepare("SELECT repo_id FROM release_note_state").all()).toEqual([]);
});

describe("queued push notification delivery", () => {
  for (const failed of ["mirror", "release-notes", "knowledge"]) {
    test(`${failed} rejection retains the durable outbox until real consumer delivery recovers`, async () => {
      const f = setup();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await admitQueue(f.env.DB, f.state);
      f.delivery.fail = failed;
      await progressQueue(f.env, "repo", () => {});
      const deferred = await getQueue(f.env.DB, "repo", f.state.entry.id);
      expect(deferred).toMatchObject({ effectsPending: true, entry: { status: "landed" } });
      expect(f.sqlite.prepare("SELECT status FROM repo_mirrors").get()).toEqual({
        status: "pending",
      });
      expect(f.sqlite.prepare("SELECT dirty FROM release_note_state").get()).toEqual({ dirty: 1 });
      if (failed === "knowledge") expect(f.knowledge.has("repo")).toBe(false);
      else expect(f.sent.filter((message) => message.type === failed)).toEqual([]);

      f.delivery.fail = null;
      await progressQueue(f.env, "repo", () => {});
      expect(await getQueue(f.env.DB, "repo", f.state.entry.id)).toMatchObject({
        effectsPending: false,
        entry: { status: "landed", deployStatus: "succeeded" },
      });
      expect(f.sent).toContainEqual({ type: "mirror", repoId: "repo" });
      expect(f.sent).toContainEqual({ type: "release-notes", repoId: "repo" });
      expect(f.knowledge.has("repo")).toBe(true);
      // Retrying an outbox is at-least-once, while the consumers' durable state
      // remains one dirty release-note record and one pending mirror.
      expect(f.sqlite.prepare("SELECT repo_id,dirty FROM release_note_state").all()).toEqual([
        { repo_id: "repo", dirty: 1 },
      ]);
      expect(f.sqlite.prepare("SELECT repo_id,status FROM repo_mirrors").all()).toEqual([
        { repo_id: "repo", status: "pending" },
      ]);
      const delivered = [...f.sent];
      await progressQueue(f.env, "repo", () => {});
      expect(f.sent).toEqual(delivered);
    });
  }

  for (const failed of ["mirror", "release-notes"]) {
    test(`ordinary push still treats ${failed} enqueue rejection as best-effort`, async () => {
      const f = setup();
      vi.spyOn(console, "error").mockImplementation(() => {});
      f.delivery.fail = failed;
      const pending: Promise<unknown>[] = [];
      afterPush(f.env, f.repo, { id: "owner" }, (work) => {
        pending.push(work);
      });
      await Promise.all(pending);
      expect(f.sent.filter((message) => message.type === failed)).toEqual([]);
      expect(f.sent).toContainEqual({
        type: failed === "mirror" ? "release-notes" : "mirror",
        repoId: "repo",
      });
      expect(f.knowledge.has("repo")).toBe(true);
    });
  }
});
