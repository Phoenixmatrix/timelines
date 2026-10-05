// A Workflow's steps, with its model calls attributed and stoppable (CORE-285).
//
// The runtime calls a `step.do` callback from outside the AsyncLocalStorage
// context `run` set up, so each callback re-enters it here:
//   - aiWork: its calls record in ai_usage for the account and feature whose
//     work it is, not under the site as `unattributed`;
//   - paidWork: no call starts after the step attempt's timeout (the runtime
//     has retried or failed it by then), and none once `live` says the work
//     is no longer wanted. The latter fails the step without retries.

import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { aiWork, type AiWork } from "../usage/ai.ts";
import { paidWork } from "./paid-work.ts";

/** Workflows' step timeout when a step sets none. */
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

const UNITS: Record<string, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** A step timeout in ms: a number of ms, or "15 minutes" and the like. */
export function timeoutMs(timeout: WorkflowStepConfig["timeout"]): number {
  if (typeof timeout === "number") return timeout;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour|day)s?\s*$/i.exec(
    String(timeout ?? ""),
  );
  return match ? Number(match[1]) * UNITS[match[2]!.toLowerCase()]! : DEFAULT_STEP_TIMEOUT_MS;
}

type Callback = (ctx: unknown) => Promise<unknown>;

/**
 * `step`, whose `do` callbacks run as `work` under paid-work limits: the
 * attempt's deadline, and `live` (null while the work is wanted).
 */
export function paidSteps(
  step: WorkflowStep,
  work: AiWork,
  live?: () => Promise<string | null>,
  every?: number,
): WorkflowStep {
  const wrap =
    (callback: Callback, config: WorkflowStepConfig | undefined): Callback =>
    (ctx) =>
      aiWork(work, () =>
        paidWork(
          { deadline: Date.now() + timeoutMs(config?.timeout), live, every },
          async (guard) => {
            let result: unknown;
            try {
              result = await callback(ctx);
            } catch (error) {
              // Stopped work fails now; an expired attempt's error goes nowhere.
              if (guard.stopped) throw new NonRetryableError(guard.stopped.message);
              throw error;
            }
            // Even if the step carried on past refused calls (a page or file
            // that failed is usually skipped), stopped work goes no further.
            if (guard.stopped) throw new NonRetryableError(guard.stopped.message);
            return result;
          },
        ),
      );
  // A plain object, never a Proxy or `.bind`: the runtime's `step` is an RPC
  // stub, on which any property (`bind` included) is a remote call.
  const stub = step as unknown as {
    do(...args: unknown[]): Promise<unknown>;
    sleep(...args: unknown[]): Promise<void>;
    sleepUntil(...args: unknown[]): Promise<void>;
    waitForEvent(...args: unknown[]): Promise<unknown>;
  };
  const wrapped = {
    do(name: string, ...rest: unknown[]) {
      if (typeof rest[0] === "function")
        return stub.do(name, wrap(rest[0] as Callback, undefined), ...rest.slice(1));
      const config = rest[0] as WorkflowStepConfig;
      return stub.do(name, config, wrap(rest[1] as Callback, config), ...rest.slice(2));
    },
    sleep: (...args: unknown[]) => stub.sleep(...args),
    sleepUntil: (...args: unknown[]) => stub.sleepUntil(...args),
    waitForEvent: (...args: unknown[]) => stub.waitForEvent(...args),
  };
  return wrapped as unknown as WorkflowStep;
}
