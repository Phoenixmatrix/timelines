// What the timeline graph draws (CORE-81), in one request: every timeline,
// their events across the Space, and the names and Projects it groups by.

import type { Timeline, TimelineEvent, TimelineIssue } from "./timelines.ts";
import type { TrackerSpace } from "./tracker.ts";
import type { SpaceSummary } from "./spaces.ts";

/** A person or agent a timeline names. */
export interface TimelineActor {
  name: string;
  /** Agents carry their accountable person's id; people don't. */
  accountableId: string | null;
  /** A person's account slug, for their profile; agents have none. */
  slug?: string;
}

export interface TimelineGraphData {
  space: SpaceSummary;
  /** The trackers the viewer can switch to. */
  trackers: TrackerSpace[];
  /** Newest first. */
  timelines: Timeline[];
  /** Every timeline's events, oldest first; a merge between two timelines appears once. */
  events: TimelineEvent[];
  /** Older events were left out. */
  truncated: boolean;
  /** People and agents in the tracker, by id. */
  actors: Record<string, TimelineActor>;
  /** The Projects subscribed to each repository the timelines touch, by repository id. */
  projects: Record<string, { id: string; slug: string; name: string }[]>;
  /** Each timeline's issues (CORE-74), by timeline id; absent from older servers. */
  issues?: Record<string, TimelineIssue[]>;
  /** Days without a push before an open timeline has stalled (the Space's idle period). */
  idleDays?: number;
}
