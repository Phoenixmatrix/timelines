import { CUTOVER_CONSUMERS, type CutoverRun } from "../space-cutover/control.ts";
import { cutoverControl, type CutoverConsumer } from "./cutover-admission.ts";
import { durableNamespace } from "./registry.ts";
import { reportCutoverRuntime } from "./cutover-runtime.ts";
import { dispatchCutoverWorkflowRuntime } from "./cutover-workflow-runtime.ts";

const DURABLE_RUNTIME_PROBES = [
  ["Tracker", "tracker"],
  ["Assistant", "assistant"],
  ["KnowledgeCoordinator", "knowledge-coordinator"],
  ["StepFeed", "step-feed"],
  ["CiSandbox", "ci-sandbox"],
  ["RegistryLogin", "registry-login"],
  ["RegistryRepo", "registry-repo"],
  ["RegistryUpload", "registry-upload"],
] as const;
const WORKER_BUNDLE_CONSUMERS = [
  "http-git-registry",
  "queue",
  "scheduled",
  "durable-registry",
] as const;

export interface CutoverDrainBlocker {
  code: string;
  consumer?: CutoverConsumer;
  message: string;
}

/** Reconciles known executions; never equates an empty new journal with legacy quiescence. */
export async function inspectCutoverDrain(env: Env, runId: string) {
  const control = cutoverControl(env);
  let run = await control.status();
  if (!run || run.runId !== runId) throw new Error("Cutover run mismatch");
  if (["reconciled", "restored", "opening", "opening-legacy"].includes(run.phase))
    return inspectReleaseRuntime(env, run);
  const blockers: CutoverDrainBlocker[] = [];
  // Tickets cover Git writes admitted since preparation. Earlier streams have
  // none, and no provider drain exists for writes Artifacts already accepted:
  // the ref barrier instead proves the push log holds every ref Artifacts does.
  const refs = (await control.refReconciliation(runId)).stages.fenced;
  if (!refs.clean)
    blockers.push(
      refs.latest?.complete
        ? {
            code: "artifacts_ref_divergence_unreconciled",
            consumer: "http-git-registry",
            message:
              "The last pass logged refs Artifacts accepted without a push-log entry; another complete pass must find none.",
          }
        : {
            code: "artifacts_ref_reconciliation_incomplete",
            consumer: "http-git-registry",
            message:
              "Under the storage fence, compare every repository's Artifacts refs with the push log before the stores drain.",
          },
    );
  if (run.phase !== "fenced" || !run.storageFenced) {
    blockers.push({
      code: "storage_fence_required",
      message:
        "Close the independent journal and both database write fences before reconciling executions.",
    });
  } else {
    // Database fences reject late SQL operations even after a Workflow terminates.
    // External effects still require their own consumer acknowledgement below.
    try {
      await control.reconcileWorkflowTickets();
    } catch {
      blockers.push({
        code: "workflow_status_unavailable",
        message:
          "Authoritative Workflow status could not be established; its tickets remain blocking.",
      });
    }
    try {
      await control.reconcileSandboxTickets(runId);
    } catch {
      blockers.push({
        code: "sandbox_shutdown_unverified",
        consumer: "ci-sandbox",
        message:
          "The container's stopped state and sealed replay boundary could not both be established.",
      });
    }
    // Workflows document no bound for work an older release started: settle the
    // provider's own census (terminating what remains) before they can drain.
    try {
      await control.settleLegacyWorkflows(runId);
    } catch {
      blockers.push({
        code: "legacy_workflow_status_unavailable",
        message:
          "Authoritative status or termination of a censused Workflow instance could not be established.",
      });
    }
  }
  // Acknowledges each consumer whose legacy work is provably over
  // (space-cutover/quiescence.ts); the rest report why not.
  const quiescence =
    run.phase === "fenced" && run.storageFenced ? await control.inspectQuiescence(runId) : [];
  run = await control.status();
  if (!run || run.runId !== runId) throw new Error("Cutover run changed during inspection");
  const activeTickets = await control.activeTickets();
  const consumers = CUTOVER_CONSUMERS.map((consumer) => {
    const active = activeTickets.filter((ticket) => ticket.consumer === consumer).length;
    const acknowledgement = run.consumers[consumer];
    const acknowledged = Boolean(
      acknowledgement?.drained && acknowledgement.checkpoint === run.checkpoint,
    );
    const finding = quiescence.find((entry) => entry.consumer === consumer);
    if (active) {
      blockers.push({
        code: "execution_still_admitted",
        consumer,
        message: `${active} execution ticket(s) still require completion or authoritative termination evidence.`,
      });
    } else if (!acknowledged && !blockers.some((blocker) => blocker.consumer === consumer)) {
      blockers.push({
        code: finding?.code ?? "consumer_quiescence_unverified",
        consumer,
        message:
          finding?.message ??
          "No authoritative quiescence acknowledgement exists for this deployed consumer; zero recorded tickets does not cover unrecorded legacy work.",
      });
    }
    return { consumer, active, acknowledged, evidence: acknowledgement?.evidence ?? null };
  });
  if (run.phase !== "fenced") {
    blockers.push({
      code: "cutover_phase_changed",
      message:
        "The cutover is no longer in its fenced drain phase; inspect its current status before continuing.",
    });
  }
  if (run.phase === "fenced") {
    await control.recordDrainInspection(runId, {
      preparationVersionId: env.CI_VERSION.id,
      blockers: blockers.map((blocker) =>
        blocker.consumer ? `${blocker.code}:${blocker.consumer}` : blocker.code,
      ),
    });
  }
  return { runId, ready: blockers.length === 0, blockers, activeTickets, consumers };
}

/** Compatibility of an approved release, separate from old-execution quiescence. */
async function inspectReleaseRuntime(env: Env, initial: CutoverRun) {
  const { runId, releaseApproval: approval } = initial;
  const control = cutoverControl(env);
  const blockers: CutoverDrainBlocker[] = [];
  // Writes Artifacts accepted during migration must be logged before admission.
  const proved = ["restored", "opening-legacy"].includes(initial.phase) ? "restored" : "reconciled";
  if (!(await control.refStageClean(runId, "pre-open", proved)))
    blockers.push({
      code: "artifacts_ref_reconciliation_required",
      message:
        "A complete pass must find every repository's Artifacts refs in the push log before write admission opens.",
    });
  if (!approval)
    return {
      stage: "runtime",
      runId,
      ready: false,
      blockers: [
        ...blockers,
        {
          code: "release_approval_required",
          message:
            "A human must approve the exact release before its producer runtimes are checked.",
        },
      ],
      consumers: [],
      workflows: [],
    };
  const expectedContract = approval.mode === "legacy" ? 3 : 4;
  const acknowledged = (run: CutoverRun, consumer: CutoverConsumer) => {
    const receipt = run.runtimeConsumers[consumer];
    return (
      receipt?.checkpoint === approval.checkpoint &&
      receipt.versionId === approval.versionId &&
      receipt.contractVersion === expectedContract
    );
  };
  // These stateless handlers share this invocation's immutable Worker bundle.
  // This reports its contract, not native queue/cron execution or a drain barrier.
  for (const consumer of WORKER_BUNDLE_CONSUMERS) {
    if (acknowledged(initial, consumer)) continue;
    try {
      await reportCutoverRuntime(env, runId, consumer);
    } catch {
      blockers.push({
        code: "worker_runtime_unverified",
        consumer,
        message: "This Worker's actual version and contract do not attest the approved release.",
      });
    }
  }
  await Promise.all(
    DURABLE_RUNTIME_PROBES.map(async ([cls, consumer]) => {
      if (acknowledged(initial, consumer)) return;
      try {
        // A control-plane probe is not a tenant instance use and must not write do_instances.
        await durableNamespace(env, cls)
          .getByName("__space_cutover_runtime__")
          .cutoverRuntime(runId);
      } catch {
        blockers.push({
          code: "durable_runtime_unverified",
          consumer,
          message: "The actual Durable Object runtime has not attested the approved release.",
        });
      }
    }),
  );
  const workflows = await dispatchCutoverWorkflowRuntime(env, runId);
  const current = await control.status();
  if (!current || current.runId !== runId || current.releaseApproval?.id !== approval.id)
    throw new Error("Release approval changed during runtime inspection");
  const consumers = CUTOVER_CONSUMERS.map((consumer) => {
    const verified = acknowledged(current, consumer);
    if (!verified && !blockers.some((blocker) => blocker.consumer === consumer))
      blockers.push({
        code: "runtime_acknowledgement_pending",
        consumer,
        message:
          "The independently executing producer has not reported the approved version and contract.",
      });
    return { consumer, acknowledged: verified };
  });
  return { stage: "runtime", runId, ready: blockers.length === 0, blockers, consumers, workflows };
}
