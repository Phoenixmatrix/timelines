// Paid inference that knows when to stop (CORE-285). Work that spends on
// models declares its limits once; every model call underneath
// (worker/knowledge/models.ts) checks them before it is sent, and calls in
// flight are aborted the moment the work stops:
//
//   deadline  when this Workflow step attempt's time is up. The runtime has
//             then retried or failed the step, but code still running in the
//             old attempt would keep calling models next to its retry.
//   live      whether the work is still wanted (a build the watchdog stopped,
//             or that failed, isn't). Checked at most every `every` ms.
//
// No cloudflare: imports here: models.ts is used everywhere, tests included.

import { AsyncLocalStorage } from "node:async_hooks";

/** Stable cancellation identity, separate from its human-readable explanation. */
export type PaidWorkStopReason = string | { code: string; message: string };

/** Why paid work stopped: its step attempt expired, or the work was stopped. */
export class PaidWorkStopped extends Error {
  override name = "PaidWorkStopped";
  readonly kind: "expired" | "stopped";
  readonly code: string | undefined;
  constructor(kind: "expired" | "stopped", reason: PaidWorkStopReason) {
    super(typeof reason === "string" ? reason : reason.message);
    this.kind = kind;
    this.code = typeof reason === "string" ? undefined : reason.code;
  }
}

export interface PaidWorkLimits {
  /** Epoch ms after which no call may start, and calls in flight are aborted. */
  deadline?: number;
  /** Null while the work is wanted; otherwise why it isn't. Errors stop work. */
  live?: () => Promise<PaidWorkStopReason | null>;
  /** How often `live` is asked, in ms (default 10 s). */
  every?: number;
}

export class PaidWorkGuard {
  readonly #controller = new AbortController();
  readonly #limits: PaidWorkLimits;
  #checkedAt = 0;
  #pending: Promise<void> | null = null;

  constructor(limits: PaidWorkLimits) {
    this.#limits = limits;
  }

  /** Aborted when the work stops; its reason is the PaidWorkStopped. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Milliseconds left before the deadline (Infinity without one). */
  remaining(now = Date.now()): number {
    return this.#limits.deadline === undefined ? Infinity : this.#limits.deadline - now;
  }

  /** Why the work was stopped (not merely expired), once it was. */
  get stopped(): PaidWorkStopped | null {
    const reason: unknown = this.signal.reason;
    return reason instanceof PaidWorkStopped && reason.kind === "stopped" ? reason : null;
  }

  stop(kind: PaidWorkStopped["kind"], reason: PaidWorkStopReason) {
    if (!this.signal.aborted) this.#controller.abort(new PaidWorkStopped(kind, reason));
  }

  /** Throws the PaidWorkStopped if no more calls may be made. */
  async check(): Promise<void> {
    this.#throwIfStopped();
    if (this.remaining() <= 0) this.stop("expired", "The step's time ran out; no more model calls");
    this.#throwIfStopped();
    const { live, every = 10_000 } = this.#limits;
    if (live && Date.now() - this.#checkedAt >= every) {
      this.#pending ??= live()
        .catch(() => "Work authorization could not be verified")
        .then((reason) => {
          this.#checkedAt = Date.now();
          if (reason) this.stop("stopped", reason);
        })
        .finally(() => {
          this.#pending = null;
        });
      await this.#pending;
    }
    this.#throwIfStopped();
  }

  #throwIfStopped() {
    if (this.signal.aborted) throw this.signal.reason;
  }
}

const current = new AsyncLocalStorage<PaidWorkGuard>();

/** Run `work` under `limits`; its model calls stop when they say so. */
export async function paidWork<T>(
  limits: PaidWorkLimits,
  work: (guard: PaidWorkGuard) => Promise<T>,
): Promise<T> {
  const guard = new PaidWorkGuard(limits);
  const ms = guard.remaining();
  // At the deadline, abort what's in flight too.
  const timer = Number.isFinite(ms)
    ? setTimeout(
        () => guard.stop("expired", "The step's time ran out; no more model calls"),
        Math.max(0, ms),
      )
    : null;
  try {
    return await current.run(guard, () => work(guard));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The limits the current model call runs under, if any. */
export function paidWorkGuard(): PaidWorkGuard | undefined {
  return current.getStore();
}
