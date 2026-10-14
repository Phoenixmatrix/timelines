import { durableStub } from "../durable/registry.ts";
import type { Tracker } from "./object.ts";

/** Immutable Space identity preserves the mapped Tracker's physical Durable Object. */
export function trackerObject(env: Env, spaceId: string): DurableObjectStub<Tracker> {
  return durableStub(env, "Tracker", spaceId);
}

/** Repositories one Tracker subscribedProjectsFor call answers for at most. */
export const SUBSCRIBED_PROJECTS_BATCH = 100;
