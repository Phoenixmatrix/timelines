import type { Snapshot, TrackerPreferences } from "../../../shared/tracker.ts";
import { api } from "../../lib/api.ts";
import { DEFAULT_QUERY, filterToken, VIEWS } from "./query.ts";

export const VIEW_LABEL = { list: "List", board: "Board", graph: "Graph" } as const;
export type View = keyof typeof VIEW_LABEL;

export interface TrackerDefaults {
  ownerId: string;
  view: View;
  query: string;
  teamId: string;
}

export function readTrackerShortcuts(): boolean {
  try {
    return localStorage.getItem("gitmatrix:tracker-shortcuts") === "true";
  } catch {
    return false;
  }
}

export function saveTrackerShortcuts(enabled: boolean): void {
  localStorage.setItem("gitmatrix:tracker-shortcuts", String(enabled));
}

function storageKey(viewerId: string): string {
  return `gitmatrix:tracker-defaults:${viewerId}`;
}

/**
 * Defaults this browser kept before they moved to the server (CORE-119): read
 * once to carry them over, and as a fallback until then.
 */
export function readLegacyDefaults(viewerId: string): TrackerDefaults | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(viewerId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const stored = value as Record<string, unknown>;
    if (
      typeof stored.ownerId !== "string" ||
      typeof stored.teamId !== "string" ||
      typeof stored.view !== "string" ||
      !Object.hasOwn(VIEW_LABEL, stored.view) ||
      !VIEWS.some((view) => view.query === stored.query)
    ) {
      return null;
    }
    return {
      ownerId: stored.ownerId,
      teamId: stored.teamId,
      view: stored.view as View,
      query: stored.query as string,
    };
  } catch {
    return null;
  }
}

export function forgetLegacyDefaults(viewerId: string): void {
  try {
    localStorage.removeItem(storageKey(viewerId));
  } catch {
    // Nothing to forget without site storage.
  }
}

/** The tracker view's saved preferences, as the defaults the page applies. */
export function defaultsFromServer(
  preferences: TrackerPreferences | null,
  ownerId: string,
): TrackerDefaults | null {
  return preferences
    ? {
        ownerId,
        view: preferences.view,
        query: preferences.query,
        teamId: preferences.teamId ?? "",
      }
    : null;
}

/**
 * Save (or, with null, reset) the person's defaults for a tracker on the
 * server, where every browser and gm read them. Throws so the caller can say
 * the save failed instead of claiming it worked.
 */
export async function saveTrackerDefaults(
  owner: string,
  defaults: TrackerDefaults | null,
): Promise<TrackerDefaults | null> {
  const path = `/tracker/${encodeURIComponent(owner)}/preferences`;
  if (!defaults) {
    await api(path, { method: "DELETE" });
    return null;
  }
  await api(path, {
    method: "PUT",
    json: { teamId: defaults.teamId || null, view: defaults.view, query: defaults.query },
  });
  return defaults;
}

/** Explicit URL state wins, including an empty query and legacy filter links. */
export function withTrackerDefaults(
  params: URLSearchParams,
  defaults: TrackerDefaults | null,
  snapshot: Pick<Snapshot, "owner" | "teams">,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (defaults?.ownerId !== snapshot.owner.id) return next;
  const team = snapshot.teams.find((entry) => entry.id === defaults.teamId && !entry.archived);
  if (!next.has("view")) next.set("view", defaults.view);
  if (!["q", "team", "workspace", "status", "ready", "closed"].some((key) => next.has(key))) {
    next.set(
      "q",
      [defaults.query, ...(team ? [filterToken("team", team.key.toLowerCase())] : [])]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (team && !next.has("captureTeam")) next.set("captureTeam", team.id);
  return next;
}

export function initialTrackerDefaults(
  defaults: TrackerDefaults | null,
  snapshot: Pick<Snapshot, "owner" | "teams">,
): TrackerDefaults {
  if (defaults?.ownerId === snapshot.owner.id) {
    return {
      ...defaults,
      teamId: snapshot.teams.some((team) => team.id === defaults.teamId && !team.archived)
        ? defaults.teamId
        : "",
    };
  }
  return { ownerId: snapshot.owner.id, view: "list", query: DEFAULT_QUERY, teamId: "" };
}
