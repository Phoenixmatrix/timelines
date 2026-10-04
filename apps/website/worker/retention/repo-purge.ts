// The RepoPurge Workflow (CORE-199): one instance per attempt at purging a
// deleted repository. The work is repo-deletion.ts's `runPurge`; this only
// gives it durable steps. A crashed instance's replay skips the steps it
// finished; a new instance (the cron's, after one died) starts at the phase
// recorded in repo_deletions.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runPurge, type PurgeStep } from "./repo-deletion.ts";

export interface RepoPurgeParams {
  repoId: string;
}

export class RepoPurge extends WorkflowEntrypoint<Env, RepoPurgeParams> {
  async run(event: Readonly<WorkflowEvent<RepoPurgeParams>>, step: WorkflowStep) {
    const steps: PurgeStep = {
      do: (name, config, work) =>
        step.do(name, config, work as () => Promise<Rpc.Serializable<unknown>>) as Promise<never>,
      sleep: (name, duration) => step.sleep(name, duration as WorkflowSleepDuration),
    };
    return runPurge(this.env, event.payload.repoId, steps, {
      waitUntil: (work) => this.ctx.waitUntil(work),
    });
  }
}
