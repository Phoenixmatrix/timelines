// Orchestration decisions of the ready path that need no environment: when the live E2E
// setup overlaps the gates, what a failure of either means, how cleanup runs, and when the
// seed's idempotency check is worth its time. main.ts supplies the real steps; tests fake them.

/** Either environment limit (installation quota or machine maximum), as main-e2e.ts detects them. */
export function isEnvironmentLimitRefusal(error: unknown): boolean {
  const text =
    error instanceof AggregateError
      ? error.errors.map(String).join("\n")
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    /Installation environment limit reached \(\d+\/\d+\)/.test(text) ||
    /Machine environment limit reached \(\d+\)/.test(text)
  );
}

export interface OverlapSteps<S> {
  /** Runs every selected gate in order; rejects with the first gate failure. */
  runGates(): Promise<void>;
  /** Prepare through seed. Resolves to its state even when a step failed (see `setupFailure`). */
  startLive(): Promise<S>;
  /** The error a started setup ended with, if any. */
  setupFailure(setup: S): unknown;
  /** Scenarios, shutdown, cleanup and completion. `overlapped` is false for a sequential run. */
  finishLive(setup: S, overlapped: boolean): Promise<void>;
  /** Stops and destroys what a started setup created, without running scenarios. */
  abortLive(setup: S): Promise<void>;
}

export interface OverlapOutcome {
  /** Whether setup ran during the gates (false: sequential, or the quota forced a fallback). */
  overlapped: boolean;
  /** The environment quota refused the overlapped provisioning. */
  quotaFallback: boolean;
}

/**
 * Starts the live setup before the gates and joins the two. A gate failure tears the setup
 * down and throws the gate error (with the setup's own error beside it); a setup failure
 * with passing gates is the live run's failure; a quota refusal is not a failure, because
 * the gates were the extra load: the setup is simply repeated after them.
 */
export async function overlapSetup<S>(steps: OverlapSteps<S>): Promise<OverlapOutcome> {
  // Attached before anything awaits, so a setup that fails during the gates never goes unhandled.
  const setup = steps.startLive().then(
    (state) => ({ state }) as { state: S; error?: undefined },
    (error: unknown) => ({ state: undefined, error }) as { state: undefined; error: unknown },
  );
  let gateFailure: { error: unknown } | undefined;
  try {
    await steps.runGates();
  } catch (error) {
    gateFailure = { error };
  }
  const settled = await setup;
  const state = settled.state;
  const error = state === undefined ? settled.error : steps.setupFailure(state);
  if (gateFailure) {
    const errors: unknown[] = [gateFailure.error];
    if (error !== undefined) errors.push(error);
    if (state !== undefined) {
      try {
        await steps.abortLive(state);
      } catch (abortError) {
        errors.push(abortError);
      }
    }
    if (errors.length === 1) throw gateFailure.error;
    throw new AggregateError(errors, "Gates failed and the live E2E teardown reported errors");
  }
  if (error === undefined && state !== undefined) {
    await steps.finishLive(state, true);
    return { overlapped: true, quotaFallback: false };
  }
  if (isEnvironmentLimitRefusal(error)) {
    // Nothing was provisioned (the refusal precedes any resource); set up now that the gates are done.
    const retried = await steps.startLive();
    await steps.finishLive(retried, false);
    return { overlapped: false, quotaFallback: true };
  }
  if (state !== undefined) {
    // Reports the failure with the same teardown and completion record as a sequential run.
    await steps.finishLive(state, true);
    return { overlapped: true, quotaFallback: false };
  }
  throw error;
}

/** Whether the live setup's `cf workers types` would race the gates that regenerate `.cloudflare/types`. */
export function gatesWriteBindingTypes(gates: readonly { name: string }[]): boolean {
  return gates.some(({ name }) => name === "website-types" || name === "bindings");
}

/**
 * Seed-related paths: the second seed run exists to prove the bootstrap repeatable
 * against real data, which only a change to the bootstrap or its fixtures can break.
 */
export function seedPathsChanged(changed: readonly string[]): boolean {
  return changed.some(
    (path) =>
      path === "tools/agent/seed.ts" ||
      path === "tools/agent/content-fixtures.ts" ||
      path.startsWith("tools/agent/fixtures/") ||
      path.startsWith("apps/website/seed/"),
  );
}

export type CleanupMode = "foreground" | "background";

/** Only `ready` (check) cleans up in the background; test, test-ai and the main watcher wait. */
export function cleanupMode(input: {
  ready: boolean;
  foregroundFlag: boolean;
  hosted: boolean;
}): CleanupMode {
  return input.ready && !input.foregroundFlag && !input.hosted ? "background" : "foreground";
}

/** The detached cleanup process: the same runtime and script, destroying one environment by id. */
export function backgroundCleanupSpawn(input: {
  execPath: string;
  execArgv: readonly string[];
  script: string;
  id: string;
}): { command: string; args: string[] } {
  if (!/^gma-[a-z0-9]{8,10}-[a-f0-9]{12}$/.test(input.id))
    throw new Error("Refusing malformed environment id.");
  return {
    command: input.execPath,
    args: [...input.execArgv, input.script, "destroy-environment", input.id],
  };
}
