// What the timeline graph draws (CORE-81), in one request: every timeline,
// their events across the account, and the names and workspaces it groups by.

import type { Timeline, TimelineEvent, TimelineIssue } from "./timelines.ts";
import type { TrackerIdentity, TrackerOwner } from "./tracker.ts";

/** A person or agent a timeline names. */
export interface TimelineActor {
  name: string;
  /** Agents carry their accountable person's id; people don't. */
  accountableId: string | null;
}

export interface TimelineGraphData {
  owner: TrackerIdentity;
  /** The trackers the viewer can switch to. */
  trackers: TrackerOwner[];
  /** Newest first. */
  timelines: Timeline[];
  /** Every timeline's events, oldest first; a merge between two timelines appears once. */
  events: TimelineEvent[];
  /** Older events were left out. */
  truncated: boolean;
  /** People and agents in the tracker, by id. */
  actors: Record<string, TimelineActor>;
  /** The tracker workspaces subscribed to each repository the timelines touch, by repository id. */
  workspaces: Record<string, { id: string; slug: string; name: string }[]>;
  /** Each timeline's issues (CORE-74), by timeline id; absent from older servers. */
  issues?: Record<string, TimelineIssue[]>;
  /** Days without a push before an open timeline has stalled (the account's idle period). */
  idleDays?: number;
}
