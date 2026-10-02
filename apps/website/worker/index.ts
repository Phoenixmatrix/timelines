import { app } from "./app.ts";
import { runMirrorJob, type MirrorJob } from "./mirror/queue.ts";
import { runReleaseNotesJob, type ReleaseNotesJob } from "./release-notes/queue.ts";
import { runJob, scheduleSweeps, type Job } from "../registry/jobs/index.ts";

export default {
  fetch: app.fetch,
  /**
   * Work queued off the request path: repository mirrors and release notes
   * (gitmatrix-jobs), and registry index rebuilds, retention and GC
   * (gitmatrix-registry-jobs).
   */
  async queue(batch, env, ctx) {
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
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduleSweeps(env));
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
