// The RepoPurge Workflow (CORE-199): one instance per attempt at purging a
// deleted repository. The work is repo-deletion.ts's `runPurge`; this only
// gives it durable steps. A crashed instance's replay skips the steps it
// finished; a new instance (the cron's, after one died) starts at the phase
// recorded in repo_deletions.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runPurge, type PurgeStep } from "./repo-deletion.ts";
import { withWorkflowCutoverAdmission } from "../durable/cutover-admission.ts";
import {
  reportWorkflowRuntime,
  type WorkflowRuntimeProbe,
} from "../durable/cutover-workflow-runtime.ts";

export interface RepoPurgeParams {
  repoId: string;
}

export class RepoPurge extends WorkflowEntrypoint<Env, RepoPurgeParams | WorkflowRuntimeProbe> {
  async run(
    event: Readonly<WorkflowEvent<RepoPurgeParams | WorkflowRuntimeProbe>>,
    step: WorkflowStep,
  ) {
    if ("cutoverRuntime" in event.payload)
      return reportWorkflowRuntime(this.env, "REPO_PURGE", event, event.payload, step);
    const { repoId } = event.payload;
    const steps: PurgeStep = {
      do: (name, config, work) =>
        step.do(
          name,
          config,
          work as (ctx: { attempt: number }) => Promise<Rpc.Serializable<unknown>>,
        ) as Promise<never>,
      sleep: (name, duration) => step.sleep(name, duration as WorkflowSleepDuration),
    };
    return withWorkflowCutoverAdmission(
      this.env,
      "repo-purge",
      event,
      step,
      "REPO_PURGE",
      (waitUntil) => runPurge(this.env, repoId, steps, { waitUntil }),
    );
  }
}
