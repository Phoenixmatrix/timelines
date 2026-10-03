// The timeline graph's data (CORE-81), under a tracker account
// (/api/tracker/:owner/timeline-graph): every timeline, the newest events
// across all of them, the people and agents they name and the workspaces their
// repositories belong to. One request instead of one per timeline; the graph
// itself is laid out in the browser.

import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import type { TimelineActor, TimelineGraphData } from "../../shared/timeline-graph.ts";
import { accessible, authorize } from "../tracker/api.ts";
import { TrackerError } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";

/** Events drawn at most: the newest, so a long history still loads quickly. */
const EVENT_LIMIT = 5000;

export const timelineGraph = new Hono<AppEnv>();

timelineGraph.onError((error, c) => {
  if (error instanceof TrackerError)
    return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
});

timelineGraph.get("/", async (c) => {
  const access = await authorize(c);
  const tracker = trackerObject(c.env, access.owner.id);
  const [graph, trackers] = await Promise.all([
    tracker.timelineGraph(EVENT_LIMIT),
    accessible(c.env.DB, c.get("actor")!),
  ]);
  if (!graph.ok) throw new TrackerError(graph.status, graph.code, graph.error);
  const { timelines, events, truncated, issues } = graph.value;

  const actors: Record<string, TimelineActor> = {};
  for (const member of access.members)
    actors[member.id] = { name: member.displayName, accountableId: null };
  for (const agent of access.agents)
    actors[agent.id] = { name: agent.name, accountableId: agent.accountable.id };

  const repoIds = [...new Set(timelines.flatMap((timeline) => timeline.repos.map((r) => r.id)))];
  const workspaces: TimelineGraphData["workspaces"] = {};
  await Promise.all(
    repoIds.map(async (repoId) => {
      const reply = await tracker.subscribedWorkspaces(repoId);
      workspaces[repoId] = reply.ok
        ? reply.value.map((w) => ({ id: w.workspaceId, slug: w.slug, name: w.name }))
        : [];
    }),
  );
  return c.json<TimelineGraphData>({
    owner: access.owner,
    trackers,
    timelines,
    events,
    truncated,
    actors,
    workspaces,
    issues,
  });
});
