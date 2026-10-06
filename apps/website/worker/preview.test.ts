// The preview guard (CORE-80): in a timeline preview, nothing sends email,
// mirrors, enqueues to production's queues or starts production's Workflows,
// even when a binding for it is present.

import { describe, expect, test, vi } from "vite-plus/test";
import { requestCompaction } from "../registry/core/blob-compaction.ts";
import type { Services } from "../registry/core/context.ts";
import { scheduleSweeps } from "../registry/jobs/index.ts";
import { sendCode } from "./better-auth.ts";
import { startMergeRun } from "./ci/landing.ts";
import { startRun, startWorkflow } from "./ci/trigger.ts";
import { queueMirror } from "./mirror/queue.ts";
import { MirrorError, syncMirror } from "./mirror/sync.ts";
import { isPreview, PreviewModeError, productionOnly } from "./preview.ts";
import { ensureReleaseNotes, notifyReleaseNotes } from "./release-notes/queue.ts";

/** A preview's env with every production binding still attached, each a spy. */
function previewEnv() {
  const send = vi.fn(async () => {});
  const create = vi.fn(async () => ({}));
  const email = vi.fn(async () => {});
  // Any database access fails the test: the guard must come first.
  const DB = new Proxy(
    {},
    {
      get() {
        throw new Error("The guard must decide before touching the database.");
      },
    },
  );
  const env = {
    PREVIEW_MODE: "true",
    AI: {},
    DB,
    JOBS: { send },
    REGISTRY_JOBS: { send },
    CI_RUN: { create },
    KNOWLEDGE_BUILD: { create },
    EMAIL: { send: email },
    EMAIL_FROM: "gitmatrix@example.com",
  };
  return { env: env as unknown as Env, send, create, email };
}

describe("isPreview and productionOnly", () => {
  test("only PREVIEW_MODE=true is a preview", () => {
    expect(isPreview({ PREVIEW_MODE: "true" })).toBe(true);
    expect(isPreview({ PREVIEW_MODE: "false" })).toBe(false);
    expect(isPreview({})).toBe(false);
    expect(productionOnly({}, "email", "a code")).toBe(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(productionOnly({ PREVIEW_MODE: "true" }, "email", "a code")).toBe(false);
    expect(log).toHaveBeenCalledWith("[preview] email is off in previews: skipped a code");
    log.mockRestore();
  });
});

describe("in a preview", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  test("sign-in sends no email and says why", async () => {
    const { env, email } = previewEnv();
    await expect(sendCode(env, "hello@fward.me", "123456")).rejects.toThrow(/no email/);
    expect(email).not.toHaveBeenCalled();
  });

  test("pushes never queue a mirror sync, and syncing by hand refuses", async () => {
    const { env, send } = previewEnv();
    await queueMirror(env, "repo_1");
    expect(send).not.toHaveBeenCalled();
    await expect(syncMirror(env, "repo_1")).rejects.toBeInstanceOf(MirrorError);
  });

  test("release notes enqueue nothing", async () => {
    const { env, send } = previewEnv();
    await notifyReleaseNotes(env, "repo_1");
    await ensureReleaseNotes(env, "repo_1");
    expect(send).not.toHaveBeenCalled();
  });

  test("CI records no run and never starts the CiRun Workflow", async () => {
    const { env, create } = previewEnv();
    const started = await startRun(
      env,
      { id: "repo_1", artifacts_name: "a", artifacts_remote: "https://example.invalid/a.git" },
      { branch: "main", commit: "0".repeat(40), trigger: "push", actor: null, waitUntil: () => {} },
    );
    expect(started).toEqual({ skipped: "Previews don't run CI." });
    await expect(startWorkflow(env, "run_1")).rejects.toBeInstanceOf(PreviewModeError);
    // Nor a landing's merge run (CORE-77): nothing lands in a preview.
    await expect(
      startMergeRun(
        env,
        { id: "repo_1" },
        {
          runId: "run_2",
          landingId: "landing_1",
          slug: "x",
          branch: "landing/x",
          commit: "0".repeat(40),
          base: "1".repeat(40),
          mainBranch: "main",
          message: "Land x",
          title: "Land x",
          author: { name: "A", email: "a@example.com" },
          actor: null,
          source: {
            sourceId: "work_x",
            repoId: "repo_1",
            kind: "timeline-work",
            timelineId: "timeline_1",
            ref: "refs/heads/work",
            commit: "0".repeat(40),
            tree: "2".repeat(40),
          },
          logicalBase: {
            sourceId: "canonical",
            repoId: "repo_1",
            kind: "canonical",
            timelineId: null,
            ref: "refs/heads/main",
            commit: "1".repeat(40),
            tree: "3".repeat(40),
          },
          old: null,
        },
      ),
    ).rejects.toBeInstanceOf(PreviewModeError);
    expect(create).not.toHaveBeenCalled();
  });

  test("the registry queues no compaction or sweeps", async () => {
    const { env, send } = previewEnv();
    await requestCompaction({ env } as unknown as Services);
    await scheduleSweeps(env);
    expect(send).not.toHaveBeenCalled();
  });
});
