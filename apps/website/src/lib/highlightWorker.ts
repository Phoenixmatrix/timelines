import type { HighlightResult } from "../../shared/semantic/highlight.ts";

export interface HighlightJob {
  key: string;
  path: string;
  text: string;
}

/**
 * Highlight jobs in one background worker, in order; `onResult` hears each
 * job that has tokens. Parsing never runs on the UI thread, a blocked worker
 * leaves the plain text as it was, and a worker that stalls is dropped after
 * 5 seconds without an answer. Returns the stop function (CORE-382).
 */
export function startHighlight(
  jobs: HighlightJob[],
  onResult: (key: string, lines: HighlightResult["lines"]) => void,
): () => void {
  let worker: Worker;
  try {
    worker = new Worker(new URL("../workers/highlight.ts", import.meta.url), { type: "module" });
  } catch {
    return () => {};
  }
  let active = true;
  let answered = 0;
  let timeout: ReturnType<typeof setTimeout>;
  const stop = () => {
    active = false;
    worker.terminate();
    clearTimeout(timeout);
  };
  // Also bound pathological parsing or a worker that cannot finish loading.
  const wait = () => {
    clearTimeout(timeout);
    timeout = setTimeout(stop, 5_000);
  };
  wait();
  worker.onmessage = ({ data }: MessageEvent<HighlightResult | null>) => {
    // Replies come back in the order the jobs went in.
    const job = jobs[answered++];
    if (active && job && data) onResult(job.key, data.lines);
    if (answered >= jobs.length) stop();
    else wait();
  };
  worker.onerror = stop;
  worker.onmessageerror = stop;
  for (const { path, text } of jobs) worker.postMessage({ path, text });
  return stop;
}
