import { app } from "./app.ts";
import { sweepAtlasRetention } from "./atlas/retention.ts";
import { isPreview } from "./preview.ts";
import { previewFetch } from "./preview-gate.ts";
import { sweepPreviews } from "./deployments/sweep.ts";
import { runMirrorJob, type MirrorJob } from "./mirror/queue.ts";
import { runReleaseNotesJob, type ReleaseNotesJob } from "./release-notes/queue.ts";
import { runJob, scheduleSweeps, type Job } from "../registry/jobs/index.ts";
import { settled, sweepLandings } from "./timelines/landing.ts";

export default {
  // A timeline preview answers only through its access gate (worker/preview-gate.ts).
  fetch: (request, env, ctx) =>
    isPreview(env) ? previewFetch(request, env, ctx, app) : app.fetch(request, env, ctx),
  /**
   * Work queued off the request path: repository mirrors and release notes
   * (gitmatrix-jobs), and registry index rebuilds, retention and GC
   * (gitmatrix-registry-jobs).
   */
  async queue(batch, env, ctx) {
    // A preview has no consumers (cloudflare.config.ts); if one were attached,
    // it would be consuming production's messages, so leave them be.
    if (isPreview(env)) return batch.retryAll();
    if (batch.queue === "gitmatrix-jobs") {
      for (const message of batch.messages as readonly Message<MirrorJob | ReleaseNotesJob>[]) {
        if (message.body.type === "release-notes")
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
  },
  /**
   * Hourly: package sweeps, tearing down expired timeline previews (CORE-79)
   * and Atlas projection retention (CORE-159).
   */
  async scheduled(_controller, env, ctx) {
    if (isPreview(env)) return;
    ctx.waitUntil(scheduleSweeps(env));
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
    // Landings a CI run's end didn't move on (CORE-77).
    ctx.waitUntil(
      settled(env, (deps) => sweepLandings(env, deps)).catch((error) =>
        console.error("Landing: sweep failed", error),
      ),
    );
  },
} satisfies ExportedHandler<Env, Job | MirrorJob | ReleaseNotesJob>;
export { KnowledgeBuild } from "./knowledge/build.ts";
export { KnowledgeCoordinator } from "./knowledge/coordinator.ts";
export { CiRun } from "./ci/workflow.ts";
export { CiSandbox } from "./ci/sandbox.ts";
export { RepoDO as RegistryRepo } from "../registry/do/repo-do.ts";
export { UploadDO as RegistryUpload } from "../registry/do/upload-do.ts";
export { LoginDO as RegistryLogin } from "../registry/do/login-do.ts";
export { Tracker } from "./tracker/object.ts";
export { Assistant } from "./assistant/agent.ts";
