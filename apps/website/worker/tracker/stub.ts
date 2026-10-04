import { durableStub } from "../durable/registry.ts";
import type { Tracker } from "./object.ts";

/** The tracker Durable Object for an account. */
export function trackerObject(env: Env, ownerId: string): DurableObjectStub<Tracker> {
  return durableStub(env, "Tracker", ownerId);
}
