import type { Snapshot } from "../../../shared/tracker.ts";
import { DEFAULT_QUERY, filterToken, VIEWS } from "./query.ts";

export const VIEW_LABEL = { list: "List", board: "Board", graph: "Graph" } as const;
export type View = keyof typeof VIEW_LABEL;

export interface TrackerDefaults {
  ownerId: string;
  view: View;
  query: string;
  teamId: string;
}

function storageKey(viewerId: string): string {
  return `gitmatrix:tracker-defaults:${viewerId}`;
}

export function readTrackerDefaults(viewerId: string): TrackerDefaults | null {
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

/** Let the caller show a failed write instead of claiming the defaults were saved. */
export function saveTrackerDefaults(viewerId: string, defaults: TrackerDefaults | null): void {
  if (defaults) localStorage.setItem(storageKey(viewerId), JSON.stringify(defaults));
  else localStorage.removeItem(storageKey(viewerId));
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
