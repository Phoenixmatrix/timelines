import { durableStub } from "../durable/registry.ts";
import type { Tracker } from "./object.ts";

/** Immutable Space identity preserves the mapped Tracker's physical Durable Object. */
export function trackerObject(env: Env, spaceId: string): DurableObjectStub<Tracker> {
  return durableStub(env, "Tracker", spaceId);
}
