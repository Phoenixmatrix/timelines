import { cutoverControl, type CutoverConsumer } from "./cutover-admission.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";

/** Control-plane only: attest this invocation, never initialize a business store. */
export async function reportCutoverRuntime(env: Env, runId: string, consumer: CutoverConsumer) {
  const versionId = env.CI_VERSION?.id;
  const checkpoint = env.CUTOVER_DEPLOYMENT_CHECKPOINT;
  if (!versionId || !checkpoint)
    throw new Error(
      "Runtime acknowledgement requires this producer's deployed version and checkpoint",
    );
  // Report this compiled consumer contract; the collector cannot select a
  // version or substitute metadata from its own Worker.
  const contractVersion = CONTENT_CONTRACT_VERSION;
  await cutoverControl(env).acknowledgeRuntime(runId, consumer, contractVersion, {
    versionId,
    checkpoint,
  });
  return { consumer, contractVersion, versionId, checkpoint };
}
