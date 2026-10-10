// Retrying reads through transient failures (CORE-331). Cloudflare's services
// fail briefly now and then (an internal error, a dropped connection, a name
// lookup that fails once), so a read tries again after a short wait instead of
// failing the request. Only quick failures are retried: past a short deadline
// the last failure stands, so a slow endpoint isn't asked again and again, and
// retries nested in callers that retry stay bounded. Writes whose outcome a
// lost reply leaves unknown stay with their own recovery (push fences).

/** Waits before each retry of a read: short, so the request still answers promptly. */
export const READ_RETRY_DELAYS_MS = [200, 800, 2000] as const;

/** No retry starts this long after the first attempt did. */
export const READ_DEADLINE_MS = 10_000;

/** How long one call to a git endpoint may take before it counts as failed. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

export interface RetryOptions {
  /** Whether a failure is worth another attempt. */
  retryable: (error: unknown) => boolean;
  /** Waits before each retry (jittered); its length is the number of retries. */
  delays?: readonly number[];
  /** No retry starts later than this after the first attempt (READ_DEADLINE_MS). */
  deadlineMs?: number;
  /** Named in the warning each retry logs, with `context`. */
  label: string;
  context?: Record<string, unknown>;
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `work`, retried after each delay while it fails retryably and in time; then its last failure. */
export async function retrying<T>(work: () => Promise<T>, options: RetryOptions): Promise<T> {
  const delays = options.delays ?? READ_RETRY_DELAYS_MS;
  const deadline = options.deadlineMs ?? READ_DEADLINE_MS;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      // Jitter, so callers that failed together don't retry together.
      const delay = delays[attempt] === undefined ? undefined : jitter(delays[attempt]!);
      if (delay === undefined || !options.retryable(error) || now() - started + delay > deadline)
        throw error;
      console.warn(`${options.label}: retrying after a transient failure`, {
        ...options.context,
        attempt: attempt + 1,
        error: String(error),
      });
      await wait(delay);
    }
  }
}

const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

/**
 * `work`, or a TimeoutError after `ms`: for calls that take no AbortSignal
 * (binding RPC). The call itself isn't cancelled, only no longer awaited.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException(`Timed out after ${ms} ms`, "TimeoutError")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
