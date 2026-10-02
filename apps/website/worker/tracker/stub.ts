import type { Tracker } from "./object.ts";

/** The tracker Durable Object for an account. */
export function trackerObject(env: Env, ownerId: string): DurableObjectStub<Tracker> {
  // String-named exports in the config cannot infer their RPC class.
  return (env.TRACKER as unknown as DurableObjectNamespace<Tracker>).getByName(ownerId);
}
