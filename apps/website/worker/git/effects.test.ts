import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type * as CiTrigger from "../ci/trigger.ts";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import { queueCandidateBranch, queueSourceBranch } from "../../shared/merge-queue.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { issueToken } from "../api/tokens.ts";
import { admitQueue, getQueue, type QueueState } from "../merge-queue/store.ts";
import { progressQueue } from "../merge-queue/scheduler.ts";
import { afterPush, type PushedRepo } from "./effects.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
// These observational consumers are not part of guaranteed notification delivery.
// Queue main CI has its own persisted deployment state and scheduler regressions.
vi.mock("../ci/trigger.ts", async (original) => ({
  ...(await original<typeof CiTrigger>()),
  onPush: vi.fn(async () => {}),
}));
vi.mock("../timelines/activity.ts", () => ({ logPush: vi.fn(async () => {}) }));

const controlClosers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of controlClosers.splice(0)) close();
});

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  controlClosers.push(fresh.close);
  const delivery = { fail: null as string | null };
  const sent: { type: string; repoId: string }[] = [];
  const knowledge = new Set<string>();
  const env = {
    ...fresh.env,
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
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "space", slug: "space", displayName: "Space" },
    actorId: "owner",
    members: [
      {
        accountId: "owner",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','space','app','private','a','https://a');
    INSERT INTO space_settings(space_id,ai_knowledge,ai_release_notes) VALUES('space',1,1);
    INSERT INTO repo_mirrors(repo_id,url,enabled,status) VALUES('repo','https://mirror.example/app',1,'ok');
  `);
  const token = await issueToken(env.DB, "owner", "push initiator", "write");
  const actor = { id: "owner", credential: { kind: "token" as const, id: token.id } };
  const authority = await captureWorkAuthority(env, "repo", actor);
  const repo: PushedRepo = {
    id: "repo",
    space_id: "space",
    space_slug: "space",
    name: "app",
    default_branch: "main",
    artifacts_name: "a",
    artifacts_remote: "https://a",
  };
  const commit = "1".repeat(40);
  const state: QueueState = {
    entry: {
      id: commit,
      repo: { id: "repo", space: "space", name: "app" },
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
    actor,
    authority,
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
  return { sqlite, env, repo, delivery, sent, knowledge, state, actor, authority };
}

test("work pushes do not mutate canonical push time or enqueue its mirror and release notes", async () => {
  const f = await setup();
  const pending: Promise<unknown>[] = [];
  afterPush(
    f.env,
    { ...f.repo, source_id: "work_a", artifacts_name: "work-physical", default_branch: "work" },
    f.actor,
    (work) => pending.push(work),
  );
  while (pending.length) await Promise.all(pending.splice(0));
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
      const f = await setup();
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
      expect(f.sent).toContainEqual({ type: "mirror", repoId: "repo", authority: f.authority });
      expect(f.sent).toContainEqual({
        type: "release-notes",
        repoId: "repo",
        authority: f.authority,
      });
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
      const f = await setup();
      vi.spyOn(console, "error").mockImplementation(() => {});
      f.delivery.fail = failed;
      const pending: Promise<unknown>[] = [];
      afterPush(f.env, f.repo, f.actor, (work) => {
        pending.push(work);
      });
      while (pending.length) await Promise.all(pending.splice(0));
      expect(f.sent.filter((message) => message.type === failed)).toEqual([]);
      expect(f.sent).toContainEqual({
        type: failed === "mirror" ? "release-notes" : "mirror",
        repoId: "repo",
        authority: f.authority,
      });
      expect(f.knowledge.has("repo")).toBe(true);
    });
  }
});
