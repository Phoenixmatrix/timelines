import { startTransition, useEffect, useState } from "react";
import type { BlobResponse } from "../../shared/api.ts";
import type { HighlightResult } from "../../shared/semantic/highlight.ts";
import { MAX_SOURCE_BYTES } from "../../shared/semantic/limits.ts";
import { startHighlight } from "./highlightWorker.ts";

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
    return startHighlight([{ key: path, path, text }], (_key, lines) =>
      startTransition(() => setHighlight({ path, text, lines })),
    );
  }, [eligible, path, text]);

  // A previous file's tokens must never paint a newly navigated source.
  return eligible && highlight?.path === path && highlight.text === text ? highlight.lines : null;
}
