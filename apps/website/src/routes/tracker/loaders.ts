import {
  data,
  redirect,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";
import type { TrackerList, TrackerView } from "../../../shared/tracker.ts";
import { api, ApiError } from "../../lib/api.ts";
import { readLegacyDefaults } from "./preferences.ts";
import { assertTrackerSnapshot } from "./snapshot.ts";
import { tokenize } from "./query.ts";
import { scopeOf } from "../../lib/timelineScope.ts";

/** Obsolete Workspace filters, which the loader refuses rather than broaden. */
export function hasObsoleteTrackerFilters(url: URL): boolean {
  return (
    url.searchParams.has("workspace") ||
    url.searchParams.has("ws") ||
    tokenize(url.searchParams.get("q") ?? "").some((term) => /^-?(workspace|ws):/i.test(term))
  );
}

export function assertCurrentTrackerFilters(url: URL): void {
  if (hasObsoleteTrackerFilters(url))
    throw data(
      {
        message:
          "client_upgrade_required: This link uses obsolete Workspace filters. Replace them with project: filters; no broader query was opened.",
      },
      { status: 400 },
    );
}

/** These endpoints authenticate the request themselves; avoid a serial session preflight. */
async function loadTracker<T>(path: string, request: Request, url: URL): Promise<T> {
  try {
    return await api<T>(path, { signal: request.signal });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search + url.hash)}`);
      }
      throw data({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Open a page of your default tracker; with none to open, list the trackers. */
async function intoDefaultTracker(request: Request, url: URL, page: string) {
  const { viewerId, trackers, defaultSpaceId } = await loadTracker<TrackerList>(
    "/tracker",
    request,
    url,
  );
  // Server defaults first; a default this browser kept from before still counts.
  const preferred = defaultSpaceId ?? readLegacyDefaults(viewerId)?.spaceId;
  const tracker = trackers.find((entry) => entry.id === preferred);
  assertCurrentTrackerFilters(url);
  if (tracker) throw redirect(`/tracker/${tracker.slug}${page}${url.search}${url.hash}`);
  return { trackers };
}

export function trackerIndexLoader({ request, url }: LoaderFunctionArgs) {
  return intoDefaultTracker(request, url, "");
}

/** `/timelines`, `/release-notes` and `/highlights`, the rail's places: your default tracker's. */
export function timelinesIndexLoader({ request, url }: LoaderFunctionArgs) {
  return intoDefaultTracker(request, url, "/timelines");
}

export function releaseNotesIndexLoader({ request, url }: LoaderFunctionArgs) {
  return intoDefaultTracker(request, url, "/releases");
}

export function highlightsIndexLoader({ request, url }: LoaderFunctionArgs) {
  return intoDefaultTracker(request, url, "/highlights");
}

/** `?tl=<slug>` selects a timeline's view; main's is the default. */
export function timelineQuery(search: ConstructorParameters<typeof URLSearchParams>[0]): string {
  const tl = new URLSearchParams(search).get("tl");
  return tl && tl !== "main" ? `?timeline=${encodeURIComponent(tl)}` : "";
}

export async function trackerLoader({ request, params, url }: LoaderFunctionArgs) {
  assertCurrentTrackerFilters(url);
  const view = await loadTracker<TrackerView>(
    `/tracker/${encodeURIComponent(params.space!)}/view${timelineQuery(url.search)}`,
    request,
    url,
  );
  assertTrackerSnapshot(view.snapshot);
  if (view.snapshot.space.slug !== params.space)
    throw data(
      { message: "The response does not belong to the requested Space." },
      { status: 409 },
    );
  for (const [key, entries] of [
    ["project", view.snapshot.projects],
    ["team", view.snapshot.teams],
  ] as const) {
    const id = url.searchParams.get(key);
    if (id !== null && !entries.some((entry) => entry.id === id))
      throw data(
        {
          message: `The ${key} filter is unavailable in this Space. Update the link; no broader query was opened.`,
        },
        { status: 400 },
      );
  }
  return view;
}

/**
 * A tracker's view is read on entering the Space or a timeline's view (?tl=),
 * on a submission and on an explicit revalidation, plus whenever the address
 * carries filters the loader must check (obsolete Workspace filters, older
 * ?project= and ?team= links) so they are refused, never broadened. Opening an
 * issue, j/k, Escape, the query, sort and tabs use the view already loaded;
 * the workbench keeps it fresh by polling and on focus, and a refresh the
 * server refuses reads the route again (see Tracker.tsx).
 */
export const trackerShouldRevalidate: ShouldRevalidateFunction = ({
  currentParams,
  nextParams,
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return (
    currentParams.space !== nextParams.space ||
    scopeOf(currentUrl.search) !== scopeOf(nextUrl.search) ||
    nextUrl.searchParams.has("project") ||
    nextUrl.searchParams.has("team") ||
    hasObsoleteTrackerFilters(nextUrl)
  );
};
