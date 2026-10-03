// Remote search as you type: debounced, each request cancelling the last, and
// only the newest query's answer ever shown.

import type { SearchResponse } from "../../shared/search.ts";
import { SEARCH_LIMITS } from "../../shared/search.ts";

export type RemoteState =
  | { status: "idle"; query: "" }
  | { status: "loading"; query: string }
  | { status: "done"; query: string; response: SearchResponse }
  | { status: "failed"; query: string; error: string };

export type Fetch = (query: string, signal: AbortSignal) => Promise<SearchResponse>;

export const DEBOUNCE_MS = 150;

export interface RemoteSearch {
  /** The latest input; "" stops searching. */
  search(query: string): void;
  dispose(): void;
}

export function remoteSearch(
  fetch: Fetch,
  onState: (state: RemoteState) => void,
  debounceMs = DEBOUNCE_MS,
): RemoteSearch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;
  let latest = "";

  const cancel = () => {
    clearTimeout(timer);
    inflight?.abort();
    inflight = undefined;
  };

  return {
    search(raw) {
      const query = raw.trim().replace(/\s+/g, " ");
      if (query === latest) return;
      latest = query;
      cancel();
      // The server would reject these; only local commands answer them.
      if (
        !query ||
        query.length > SEARCH_LIMITS.queryLength ||
        query.split(" ").length > SEARCH_LIMITS.words
      ) {
        onState({ status: "idle", query: "" });
        return;
      }
      onState({ status: "loading", query });
      timer = setTimeout(() => {
        const controller = new AbortController();
        inflight = controller;
        fetch(query, controller.signal).then(
          (response) => {
            if (controller.signal.aborted || latest !== query) return;
            onState({ status: "done", query, response });
          },
          (error: unknown) => {
            if (controller.signal.aborted || latest !== query) return;
            onState({
              status: "failed",
              query,
              error: error instanceof Error ? error.message : "Search failed.",
            });
          },
        );
      }, debounceMs);
    },
    dispose() {
      cancel();
      latest = "";
    },
  };
}
