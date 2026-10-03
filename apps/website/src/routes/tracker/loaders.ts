import { data, redirect, type LoaderFunctionArgs } from "react-router";
import type { TrackerList, TrackerView } from "../../../shared/tracker.ts";
import { api, ApiError } from "../../lib/api.ts";
import { readLegacyDefaults } from "./preferences.ts";

/** These endpoints authenticate the request themselves; avoid a serial session preflight. */
async function loadTracker<T>(path: string, request: Request): Promise<T> {
  try {
    return await api<T>(path, { signal: request.signal });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        const url = new URL(request.url);
        throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      throw data({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function trackerIndexLoader({ request }: LoaderFunctionArgs) {
  const { viewerId, trackers, defaultOwnerId } = await loadTracker<TrackerList>(
    "/tracker",
    request,
  );
  // Server defaults first; a default this browser kept from before still counts.
  const preferred = defaultOwnerId ?? readLegacyDefaults(viewerId)?.ownerId;
  const tracker = trackers.find((entry) => entry.id === preferred) ?? trackers[0];
  if (tracker) throw redirect(`/tracker/${tracker.slug}${new URL(request.url).search}`);
  return { trackers };
}

export function trackerLoader({ request, params }: LoaderFunctionArgs) {
  return loadTracker<TrackerView>(`/tracker/${encodeURIComponent(params.owner!)}/view`, request);
}
