import { app } from "./app.ts";
import { sweepAtlasRetention } from "./atlas/retention.ts";
import { isPreview } from "./preview.ts";
import { previewFetch } from "./preview-gate.ts";
import { sweepPreviews } from "./deployments/sweep.ts";
import { sweepDurableInstances } from "./durable/sweep.ts";
import { collectUsage } from "./usage/collect.ts";
import { runMirrorJob, type MirrorJob } from "./mirror/queue.ts";
import { runReleaseNotesJob, type ReleaseNotesJob } from "./release-notes/queue.ts";
import {
  runReleaseHighlightsJob,
  sweepReleaseHighlights,
  type ReleaseHighlightsJob,
} from "./release-notes/highlights.ts";
import { retentionCron, runRetentionJob, type RetentionJob } from "./retention/runs.ts";
import { resumeDeletions } from "./retention/repo-deletion.ts";
import { sweepRepoOrphans, sweepsOrphans } from "./retention/repo-orphans.ts";
import { runJob, scheduleSweeps, type Job } from "../registry/jobs/index.ts";
import { settled, sweepLandings } from "./timelines/landing.ts";
import { sweepQueue } from "./merge-queue/index.ts";
import { artifactsHistory, backfillMentions } from "./mentions/backfill.ts";
import { checkCatalogDaily } from "./usage/prices.ts";
import {
  cutoverControl,
  wrapCutoverFetch,
  wrapCutoverBackground,
} from "./durable/cutover-admission.ts";
import { initializeFreshSpaceInstallation } from "./space-cutover/installation.ts";
import { startTiming } from "./timing.ts";

export default {
  // A timeline preview answers only through its access gate (worker/preview-gate.ts).
  fetch: async (request, env, ctx) => {
    // Server-Timing's `total` starts here, before the cutover checks below (app.ts emits it).
    const timing = startTiming(request);
    const path = new URL(request.url).pathname;
    const handler = async (input: Request, bindings: Env, execution: ExecutionContext) =>
      isPreview(bindings)
        ? previewFetch(input, bindings, execution, app)
        : app.fetch(input, bindings, execution);
    if (path === "/api/admin/space-cutover" || path.startsWith("/api/admin/space-cutover/"))
      return handler(request, env, ctx);
    if (!isPreview(env)) {
      try {
        await initializeFreshSpaceInstallation(env, timing);
      } catch (error) {
        return Response.json(
          {
            error: "space_installation_maintenance",
            message:
              "Space initialization is incomplete. Existing legacy data requires the reviewed cutover, not automatic migration.",
            detail: String(error),
          },
          { status: 503, headers: { "Retry-After": "5", "Server-Timing": timing.header() } },
        );
      }
    }
    return wrapCutoverFetch(request, env, ctx, handler, timing);
  },
  /**
   * Work queued off the request path: repository mirrors and release notes
   * (gitmatrix-jobs), and registry index rebuilds, retention and GC
   * (gitmatrix-registry-jobs). A self-hosted instance names its queues
   * <prefix>-jobs and <prefix>-registry-jobs (vite/instance.ts).
   */
  async queue(batch, env, ctx) {
    // A preview has no consumers (cloudflare.config.ts); if one were attached,
    // it would be consuming production's messages, so leave them be.
    if (isPreview(env)) return batch.retryAll();
    if (!(await cutoverControl(env).admission()).allowed) return batch.retryAll();
    return wrapCutoverBackground(env, "queue", ctx, async (ctx) => {
      if (!batch.queue.endsWith("-registry-jobs")) {
        for (const message of batch.messages as readonly Message<
          MirrorJob | ReleaseNotesJob | ReleaseHighlightsJob | RetentionJob
        >[]) {
          if (message.body.type === "retention")
            await runRetentionJob(env, message as Message<RetentionJob>);
          else if (message.body.type === "release-highlights")
            await runReleaseHighlightsJob(env, message as Message<ReleaseHighlightsJob>);
          else if (message.body.type === "release-notes")
            await runReleaseNotesJob(env, message as Message<ReleaseNotesJob>, (work) =>
              ctx.waitUntil(work),
            );
          else await runMirrorJob(env, message as Message<MirrorJob>);
        }
        return;
      }
      for (const message of batch.messages as readonly Message<Job>[]) {
        try {
          await runJob(env, message.body);
          message.ack();
        } catch (error) {
          console.error("Registry job failed", message.body, error);
          message.retry();
        }
      }
    });
  },
  /**
   * Hourly: package sweeps, tearing down expired timeline previews (CORE-79),
   * Atlas projection retention (CORE-159), data retention runs (CORE-198),
   * usage snapshots (CORE-207), the daily price check (CORE-208) and the
   * commit-mention backfill (CORE-22).
   */
  async scheduled(_controller, env, ctx) {
    if (isPreview(env)) return;
    if (!(await cutoverControl(env).admission()).allowed) return;
    return wrapCutoverBackground(env, "scheduled", ctx, async (ctx) => {
      ctx.waitUntil(scheduleSweeps(env));
      ctx.waitUntil(
        sweepReleaseHighlights(env).catch((error) =>
          console.error("Release highlights: hourly sweep failed", error),
        ),
      );
      ctx.waitUntil(
        sweepPreviews(env, { waitUntil: (work) => ctx.waitUntil(work) }).catch((error) =>
          console.error("Previews: the sweep failed", error),
        ),
      );
      // Atlas retention: priors due to expire, and reclaiming left over (CORE-159).
      ctx.waitUntil(
        sweepAtlasRetention(env.DB).catch((error) =>
          console.error("Atlas: the retention sweep failed", error),
        ),
      );
      // The Durable Object registry: backfill, owners and sizes (CORE-197).
      ctx.waitUntil(
        sweepDurableInstances(env).catch((error) =>
          console.error("Durable: the registry sweep failed", error),
        ),
      );
      // Data retention (CORE-198): scheduled runs of enabled and fixed categories
      // only, and restarting stalled runs; with nothing enabled, only auth hygiene.
      ctx.waitUntil(
        retentionCron(env).catch((error) => console.error("Retention: the cron failed", error)),
      );
      // Repository deletions whose purge Workflow died: a new one resumes (CORE-199).
      ctx.waitUntil(
        resumeDeletions(env, { waitUntil: (work) => ctx.waitUntil(work) }).catch((error) =>
          console.error("Repository deletion: resuming purges failed", error),
        ),
      );
      // What repositories deleted before that left behind, once (production only).
      if (sweepsOrphans(env))
        ctx.waitUntil(
          sweepRepoOrphans(env, { waitUntil: (work) => ctx.waitUntil(work) }).catch((error) =>
            console.error("Repository deletion: the orphan sweep failed", error),
          ),
        );
      // Per-account usage snapshots, a bounded slice per run (CORE-207).
      ctx.waitUntil(
        collectUsage(env).catch((error) => console.error("Usage: the collection failed", error)),
      );
      // Once a day: does every Cloudflare pricing page still parse, and did a price change? (CORE-208)
      ctx.waitUntil(
        checkCatalogDaily(env.DB).catch((error) =>
          console.error("Prices: the daily check failed", error),
        ),
      );
      // Landings a CI run's end didn't move on (CORE-77).
      ctx.waitUntil(
        settled(env, (deps) => sweepLandings(env, deps)).catch((error) =>
          console.error("Landing: sweep failed", error),
        ),
      );
      ctx.waitUntil(
        sweepQueue(env, (work) => ctx.waitUntil(work)).catch((error) =>
          console.error("Merge queue: sweep failed", error),
        ),
      );
      // Issue mentions in history pushed before the index existed, a few repositories a run.
      ctx.waitUntil(
        backfillMentions(
          env,
          artifactsHistory(env, (work) => ctx.waitUntil(work)),
        ).catch((error) => console.error("Mentions: the backfill failed", error)),
      );
    });
  },
} satisfies ExportedHandler<
  Env,
  Job | MirrorJob | ReleaseNotesJob | ReleaseHighlightsJob | RetentionJob
>;
export { KnowledgeBuild } from "./knowledge/build.ts";
export { KnowledgeCoordinator } from "./knowledge/coordinator.ts";
export { StepFeed } from "./steps/feed.ts";
export { CiRun } from "./ci/workflow.ts";
export { RepoPurge } from "./retention/repo-purge.ts";
export { CiSandbox } from "./ci/sandbox.ts";
export { RepoDO as RegistryRepo } from "../registry/do/repo-do.ts";
export { UploadDO as RegistryUpload } from "../registry/do/upload-do.ts";
export { LoginDO as RegistryLogin } from "../registry/do/login-do.ts";
export { Tracker } from "./tracker/object.ts";
export { Assistant } from "./assistant/agent.ts";
export { SpaceCutover } from "./space-cutover/control.ts";
