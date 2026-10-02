import { startTransition, useEffect, useState } from "react";
import type { BlobResponse } from "../../shared/api.ts";
import type { HighlightResult } from "../../shared/semantic/highlight.ts";
import { MAX_SOURCE_BYTES } from "../../shared/semantic/limits.ts";

/** Show source immediately; parsing never runs on the UI thread. */
export function useSourceHighlight({ path, text, size, binary, truncated }: BlobResponse) {
  const [highlight, setHighlight] = useState<{
    path: string;
    text: string;
    lines: HighlightResult["lines"];
  } | null>(null);
  const eligible = !binary && !truncated && text !== null && size <= MAX_SOURCE_BYTES;

  useEffect(() => {
    if (!eligible || text === null) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/highlight.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      // A blocked/unavailable worker leaves the original plain source readable.
      return;
    }
    let active = true;
    const stop = () => {
      active = false;
      worker.terminate();
      clearTimeout(timeout);
    };
    // Also bound pathological parsing or a worker that cannot finish loading.
    const timeout = setTimeout(stop, 5_000);
    worker.onmessage = ({ data }: MessageEvent<HighlightResult | null>) => {
      if (active && data) startTransition(() => setHighlight({ path, text, lines: data.lines }));
      stop();
    };
    worker.onerror = stop;
    worker.onmessageerror = stop;
    worker.postMessage({ path, text });
    return stop;
  }, [eligible, path, text]);

  // A previous file's tokens must never paint a newly navigated source.
  return eligible && highlight?.path === path && highlight.text === text ? highlight.lines : null;
}
