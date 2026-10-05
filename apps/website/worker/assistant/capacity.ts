import { APICallError, type LanguageModelMiddleware } from "ai";

// The binding omits an HTTP status for 3021, so the SDK cannot retry it.
// Match only the evidenced per-minute refusal, not billing or generic failures.
function rateLimited(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    error.url.startsWith("workers-ai:binding/run/") &&
    /\b3021:\s*rate limiting:\s*inference request per min rate reached\b/i.test(error.message)
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", aborted);
    resolve();
  }, ms);
  function aborted() {
    clearTimeout(timer);
    reject(signal.reason);
  }
  signal.addEventListener("abort", aborted, { once: true });
  return promise;
}

/**
 * Retry only acquisition of a model step, never its returned stream or the turn.
 * Three waits (5s, 15s, 45s) span a quota minute; acquisition has a 90s deadline.
 * The provider forwards this signal to AI.run. Once it returns, remove the
 * deadline: stream consumption and tools retain the caller's cancellation.
 */
export const assistantCapacity: LanguageModelMiddleware = {
  wrapStream: async ({ model, params }) => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(new DOMException("Assistant model acquisition timed out", "TimeoutError")),
      90_000,
    );
    const signal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, deadline.signal])
      : deadline.signal;
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          return await model.doStream({ ...params, abortSignal: signal });
        } catch (error) {
          signal.throwIfAborted();
          if (!rateLimited(error) || attempt === 3) throw error;
          await sleep(5_000 * 3 ** attempt, signal);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  },
};
