// Loading the Chronicle (CORE-251): pages of GET /chronicle for a range a
// little wider than the window, so panning a bit needs no request; a new
// request only when the window leaves what's loaded or the query changes.
// Never the whole event log: at most MAX_PAGES pages of issues.

import { useEffect, useRef, useState } from "react";
import type { Chronicle, ChronicleIssue } from "../../../shared/chronicle.ts";
import { api } from "../../lib/api.ts";

const PAGE = 200;
const MAX_PAGES = 10;

export interface Loaded {
  query: string;
  /** The range the rows were read for. */
  from: number;
  to: number;
  issues: ChronicleIssue[];
  actors: Chronicle["actors"];
  teams: Chronicle["teams"];
  history: Chronicle["history"];
  density: NonNullable<Chronicle["density"]> | null;
  quiet: number;
  serverTime: number;
  /** More issues matched than MAX_PAGES pages hold. */
  truncated: boolean;
}

export function useChronicle(
  space: string,
  query: string,
  window: { from: number; to: number },
  now: number,
): { data: Loaded | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const density = useRef<{ query: string; value: Loaded["density"] } | null>(null);
  const covered =
    !!data &&
    data.query === query &&
    data.from <= window.from &&
    data.to >= Math.min(window.to, now) &&
    // Zoomed far into a wide load: read again, so rows quiet here drop out.
    window.to - window.from > (data.to - data.from) / 12;
  const key = covered ? null : `${query}|${Math.round(window.from)}|${Math.round(window.to)}`;
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const span = window.to - window.from;
    const from = window.from - span / 2;
    const to = Math.min(window.to + span / 2, now + 3_600_000);
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const issues: ChronicleIssue[] = [];
        let cursor: string | null = null;
        let first: Chronicle | null = null;
        let quiet = 0;
        let pages = 0;
        do {
          const params = new URLSearchParams({
            from: new Date(from).toISOString(),
            to: new Date(Math.max(to, from + 60_000)).toISOString(),
            q: query,
            limit: String(PAGE),
          });
          if (cursor) params.set("cursor", cursor);
          const page: Chronicle = await api<Chronicle>(
            `/tracker/${encodeURIComponent(space)}/chronicle?${params}`,
            { signal: controller.signal },
          );
          first ??= page;
          issues.push(...page.issues);
          quiet += page.quiet;
          // Later pages name more people.
          Object.assign(first.actors, page.actors);
          cursor = page.next;
          pages++;
        } while (cursor && pages < MAX_PAGES);
        if (first.density) density.current = { query, value: first.density };
        setData({
          query,
          from,
          to,
          issues,
          actors: first.actors,
          teams: first.teams,
          history: first.history,
          density: density.current?.query === query ? density.current.value : null,
          quiet,
          serverTime: Date.parse(first.serverTime),
          truncated: !!cursor,
        });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Couldn't read the history.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The key holds what matters; the window's values ride along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, space]);
  return { data, loading: loading || key !== null, error };
}
