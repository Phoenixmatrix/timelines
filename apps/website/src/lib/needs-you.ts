// The rail's Needs you count (CORE-301): how many open requests the Needs you
// page would show you (routed to you, or open to anyone in your trackers), and
// how many of those are routed to you, kept fresh while the app is open. It refreshes on load, on a
// navigation once its last read is NAVIGATION_FRESH_MS old (and on every
// visit to the Needs you page, so the count agrees with its list), when the
// tab comes back, every 30 seconds while visible, and when a page answers or
// cancels a request (NEEDS_YOU_CHANGED).

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { RequestSummary } from "../../shared/tracker.ts";
import { api } from "./api.ts";
import { accessEpoch, onAccessChange } from "./session.ts";

/** Dispatched on window after answering or cancelling a request, so the count follows. */
export const NEEDS_YOU_CHANGED = "gitmatrix:needs-you-changed";

/**
 * A navigation this soon after a successful read (as made, for the same
 * identity) keeps its count: moving around quickly doesn't ask every Tracker
 * again each time. Nothing else waits for it.
 */
export const NAVIGATION_FRESH_MS = 10_000;
const NEEDS_YOU_PATH = "/needs-you";

/** What the Needs you page holds for you, or null until known (and when signed out). */
export function useNeedsYou(signedIn: boolean): RequestSummary | null {
  const { pathname } = useLocation();
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  /** What a navigation to `pathname` does, while signed in. */
  const navigated = useRef<((pathname: string) => void) | null>(null);
  useEffect(() => {
    if (!signedIn) {
      setSummary(null);
      return;
    }
    let controller: AbortController | null = null;
    /** The access epoch (lib/session.ts) the read under way was made in. */
    let controllerEpoch = -1;
    let disposed = false;
    /** When the last read that succeeded was made, and for which identity. */
    let last: { at: number; epoch: number } | null = null;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const made = { at: Date.now(), epoch: accessEpoch() };
      controllerEpoch = made.epoch;
      try {
        const next = await api<RequestSummary>("/requests/summary", { signal: request.signal });
        // A read made for an identity this tab no longer has counts for nobody.
        if (!disposed && !request.signal.aborted && made.epoch === accessEpoch()) {
          setSummary(next);
          last = made;
        }
      } catch {
        // Keep the last count: a failed refresh shouldn't hide or invent requests.
      } finally {
        if (controller === request) controller = null;
      }
    };
    navigated.current = (pathname) => {
      // A read under way (the first one, on load) is as new as this navigation,
      // unless it was made for another identity: then this one replaces it.
      if (controller && controllerEpoch === accessEpoch()) return;
      const fresh =
        last && last.epoch === accessEpoch() && Date.now() - last.at < NAVIGATION_FRESH_MS;
      if (fresh && pathname !== NEEDS_YOU_PATH) return;
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const changed = () => void refresh();
    // Who is signed in may have changed: the count shown was theirs, so it goes
    // (and so does any read made for them), and the new identity's is read.
    const forget = onAccessChange(() => {
      controller?.abort();
      last = null;
      setSummary(null);
      void refresh();
    });
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(NEEDS_YOU_CHANGED, changed);
    return () => {
      disposed = true;
      navigated.current = null;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(NEEDS_YOU_CHANGED, changed);
      forget();
    };
  }, [signedIn]);
  useEffect(() => navigated.current?.(pathname), [pathname]);
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
