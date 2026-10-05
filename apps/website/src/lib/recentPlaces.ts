// Recent places (CORE-22): the last few distinct pages a viewer opened
// (repositories, issues, CI runs, packages, timelines, commits), offered by
// the palette before anything is typed. Kept per viewer in this browser only;
// storage can be missing or refuse writes (private windows, blocked site
// data), and then there are simply no recents.

import { useEffect } from "react";
import { useViewer } from "./session.ts";

export type PlaceKind = "repo" | "issue" | "run" | "package" | "timeline" | "commit";

export interface RecentPlace {
  kind: PlaceKind;
  /** The name people know it by: owner/name, an issue key, #12, a package name. */
  title: string;
  /** Where it lives, or what it is: the issue's title, the run's repository. */
  detail: string;
  /** An in-app address; one entry per address. */
  to: string;
  /** When it was last opened (epoch ms). */
  at: number;
}

/** Places kept. */
export const RECENT_LIMIT = 8;

const KINDS: readonly PlaceKind[] = ["repo", "issue", "run", "package", "timeline", "commit"];

export function recentKey(viewerId: string | null): string {
  return `gitmatrix:recent-places:${viewerId ?? "signed-out"}`;
}

function valid(value: unknown): value is RecentPlace {
  const place = value as RecentPlace | null;
  return (
    !!place &&
    KINDS.includes(place.kind) &&
    typeof place.title === "string" &&
    typeof place.detail === "string" &&
    typeof place.to === "string" &&
    place.to.startsWith("/") &&
    !place.to.startsWith("//") &&
    typeof place.at === "number"
  );
}

/** The viewer's recent places, newest first; empty when storage can't be read. */
export function readRecent(viewerId: string | null, storage = safeStorage()): RecentPlace[] {
  try {
    const raw = storage?.getItem(recentKey(viewerId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** `places` with `place` first: one entry per address, at most RECENT_LIMIT. */
export function addRecent(places: RecentPlace[], place: RecentPlace): RecentPlace[] {
  return [place, ...places.filter((p) => p.to !== place.to)].slice(0, RECENT_LIMIT);
}

export function rememberPlace(
  viewerId: string | null,
  place: Omit<RecentPlace, "at">,
  storage = safeStorage(),
  now = Date.now(),
): void {
  try {
    const next = addRecent(readRecent(viewerId, storage), { ...place, at: now });
    storage?.setItem(recentKey(viewerId), JSON.stringify(next));
  } catch {
    // Full or blocked storage: recents are a convenience, never an error.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Remember the page being shown as a recent place, once its name is known
 * (pass null until then). Only a change of address or name writes again.
 */
export function useRememberPlace(place: Omit<RecentPlace, "at"> | null): void {
  const viewer = useViewer();
  const viewerId = viewer?.id ?? null;
  const key = place ? JSON.stringify([place.kind, place.title, place.detail, place.to]) : null;
  useEffect(() => {
    if (!key) return;
    const [kind, title, detail, to] = JSON.parse(key) as [PlaceKind, string, string, string];
    rememberPlace(viewerId, { kind, title, detail, to });
  }, [key, viewerId]);
}
