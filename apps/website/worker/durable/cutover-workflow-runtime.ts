import type { WorkflowStep } from "cloudflare:workers";
import { cutoverControl } from "./cutover-admission.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";

export type CutoverWorkflowBinding = "CI_RUN" | "KNOWLEDGE_BUILD" | "REPO_PURGE";

/** Maintenance-only parameters; never interpreted as a repository/AI job. */
export interface WorkflowRuntimeProbe {
  cutoverRuntime: { runId: string };
}

/** Only executing Workflow code can report its own provider identity and release. */
export async function reportWorkflowRuntime(
  env: Env,
  binding: CutoverWorkflowBinding,
  event: { instanceId: string },
  probe: WorkflowRuntimeProbe,
  step: WorkflowStep,
): Promise<void> {
  if (!event.instanceId || typeof event.instanceId !== "string")
    throw new Error("Provider Workflow instance identity required");
  if (
    !probe.cutoverRuntime ||
    typeof probe.cutoverRuntime.runId !== "string" ||
    !probe.cutoverRuntime.runId
  )
    throw new Error("Cutover runtime probe run identity required");
  // Capture this executing isolate's metadata, never dispatcher payload claims.
  const versionId = env.CI_VERSION?.id;
  const checkpoint = env.CUTOVER_DEPLOYMENT_CHECKPOINT;
  if (!versionId || !checkpoint) throw new Error("Workflow release metadata unavailable");
  await step.do("Report executing cutover Workflow runtime", async () => {
    await cutoverControl(env).reportWorkflowRuntime(
      probe.cutoverRuntime.runId,
      binding,
      event.instanceId,
      versionId,
      checkpoint,
      CONTENT_CONTRACT_VERSION,
    );
  });
}

export interface WorkflowRuntimeDispatch {
  binding: CutoverWorkflowBinding;
  instanceId: string | null;
  attempt: number;
  status: "acknowledged" | "pending" | "blocked";
  reason: string | null;
}

/** One bounded pass. The independent journal, not this request, owns retries. */
export async function dispatchCutoverWorkflowRuntime(
  env: Env,
  runId: string,
): Promise<WorkflowRuntimeDispatch[]> {
  const control = cutoverControl(env);
  const versionId = env.CI_VERSION?.id;
  const checkpoint = env.CUTOVER_DEPLOYMENT_CHECKPOINT;
  if (!versionId || !checkpoint) throw new Error("Workflow release metadata unavailable");
  const results: WorkflowRuntimeDispatch[] = [];
  for (const name of ["CI_RUN", "KNOWLEDGE_BUILD", "REPO_PURGE"] as const) {
    const binding = env[name];
    if (!binding) {
      results.push({
        binding: name,
        instanceId: null,
        attempt: 0,
        status: "blocked",
        reason: "Workflow binding unavailable",
      });
      continue;
    }
    const reserved = await control.reserveWorkflowRuntimeProbe(runId, name, versionId, checkpoint);
    if (reserved.status !== "reserved") {
      results.push({
        binding: name,
        instanceId: reserved.instanceId,
        attempt: reserved.attempt,
        status: reserved.status === "reported" ? "acknowledged" : "blocked",
        reason: reserved.status === "reported" ? null : "Workflow runtime probe attempts exhausted",
      });
      continue;
    }
    let providerStatus = "unknown";
    let observationError: string | null = null;
    try {
      providerStatus = (await (await binding.get(reserved.instanceId)).status()).status;
    } catch (error) {
      observationError = error instanceof Error ? error.message : String(error);
    }
    if (providerStatus === "unknown") {
      try {
        // The provider rejects duplicate IDs. A lost create response therefore
        // retries this journaled ID, never launches an untracked replacement.
        await binding.create({
          id: reserved.instanceId,
          params: { cutoverRuntime: { runId } },
        });
        observationError = null;
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error);
      }
    }
    // Re-read the journal: create success/status complete alone is NOT a report.
    // The controller itself verifies terminal status before any bounded retry.
    const current = await control.reserveWorkflowRuntimeProbe(runId, name, versionId, checkpoint);
    results.push({
      binding: name,
      instanceId: current.instanceId,
      attempt: current.attempt,
      status:
        current.status === "reported"
          ? "acknowledged"
          : current.status === "exhausted"
            ? "blocked"
            : "pending",
      reason:
        current.status === "reported"
          ? null
          : current.status === "exhausted"
            ? "Workflow runtime probe attempts exhausted"
            : (observationError ?? "Waiting for executing Workflow runtime report"),
    });
  }
  return results;
}
