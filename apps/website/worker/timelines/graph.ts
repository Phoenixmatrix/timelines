// The timeline graph's data (CORE-81), under a tracker Space
// (/api/tracker/:space/timeline-graph): every timeline, the newest events
// across all of them, the people and agents they name and the Projects their
// repositories belong to. One request instead of one per timeline; the graph
// itself is laid out in the browser.

import { Hono } from "hono";
import { requestTiming, type AppEnv } from "../auth.ts";
import type { TimelineActor, TimelineGraphData } from "../../shared/timeline-graph.ts";
import { previewSettings } from "../deployments/settings.ts";
import { accessible, authorize } from "../tracker/api.ts";
import { TrackerError } from "../tracker/store.ts";
import { SUBSCRIBED_PROJECTS_BATCH, trackerObject } from "../tracker/stub.ts";
import { chunk } from "../knowledge/util.ts";
import { timedCall, timedEnv } from "../timing.ts";

/** Events drawn at most: the newest, so a long history still loads quickly. */
const EVENT_LIMIT = 5000;

export const timelineGraph = new Hono<AppEnv>();

timelineGraph.onError((error, c) => {
  if (error instanceof TrackerError)
    return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
});

timelineGraph.get("/", async (c) => {
  const timing = requestTiming(c);
  const env = timedEnv(c.env, timing);
  const access = await authorize(c, true, env, timing);
  const tracker = trackerObject(env, access.space.id);
  const [graph, trackers, settings] = await Promise.all([
    timedCall(timing, tracker.timelineGraph(access, EVENT_LIMIT)),
    accessible(env.DB, c.get("actor")!),
    previewSettings(env.DB, access.space.id),
  ]);
  if (!graph.ok) throw new TrackerError(graph.status, graph.code, graph.error);
  const { timelines, events, truncated, issues } = graph.value;

  const actors: Record<string, TimelineActor> = {};
  for (const member of access.members)
    actors[member.id] = { name: member.displayName, accountableId: null, slug: member.slug };
  for (const agent of access.agents)
    actors[agent.id] = { name: agent.name, accountableId: agent.accountable.id };

  const repoIds = [...new Set(timelines.flatMap((timeline) => timeline.repos.map((r) => r.id)))];
  const projects: TimelineGraphData["projects"] = {};
  // One Tracker call per batch of repositories, each authorized once.
  const replies = await Promise.all(
    chunk(repoIds, SUBSCRIBED_PROJECTS_BATCH).map((batch) =>
      timedCall(timing, tracker.subscribedProjectsFor(access, batch)),
    ),
  );
  for (const reply of replies) {
    if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
    for (const [repoId, subscribed] of Object.entries(reply.value))
      projects[repoId] = subscribed.map((project) => ({
        id: project.projectId,
        slug: project.slug,
        name: project.name,
      }));
  }
  return c.json<TimelineGraphData>({
    space: access.space,
    trackers,
    timelines,
    events,
    truncated,
    actors,
    projects,
    issues,
    idleDays: settings.idleDays,
  });
});
