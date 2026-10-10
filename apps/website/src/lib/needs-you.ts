// The rail's Needs you count (CORE-301): how many open requests the Needs you
// page would show you (routed to you, or open to anyone in your trackers), and
// how many of those are routed to you, kept fresh while the app is open. It refreshes on load, on every
// navigation, when the tab comes back, every 30 seconds while visible, and when
// a page answers or cancels a request (NEEDS_YOU_CHANGED).

import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import type { RequestSummary } from "../../shared/tracker.ts";
import { api } from "./api.ts";

/** Dispatched on window after answering or cancelling a request, so the count follows. */
export const NEEDS_YOU_CHANGED = "gitmatrix:needs-you-changed";

/** What the Needs you page holds for you, or null until known (and when signed out). */
export function useNeedsYou(signedIn: boolean): RequestSummary | null {
  const { pathname } = useLocation();
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  useEffect(() => {
    if (!signedIn) {
      setSummary(null);
      return;
    }
    let controller: AbortController | null = null;
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const next = await api<RequestSummary>("/requests/summary", { signal: request.signal });
        if (!disposed && !request.signal.aborted) setSummary(next);
      } catch {
        // Keep the last count: a failed refresh shouldn't hide or invent requests.
      } finally {
        if (controller === request) controller = null;
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const changed = () => void refresh();
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(NEEDS_YOU_CHANGED, changed);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(NEEDS_YOU_CHANGED, changed);
    };
  }, [signedIn, pathname]);
  return summary;
}

/** The badge's text: the count, capped so the badge stays small. */
export function needsYouBadge(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** The place's accessible name and tooltip: how many requests wait, and how many are routed to you. */
export function needsYouLabel(summary: RequestSummary | null): string {
  if (!summary?.open) return "Needs you";
  const { open, forYou } = summary;
  const waiting = `${open} ${open === 1 ? "request" : "requests"} waiting`;
  return forYou ? `Needs you: ${waiting}, ${forYou} for you` : `Needs you: ${waiting}`;
}
