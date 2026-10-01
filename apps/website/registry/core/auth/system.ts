import { ALL_SCOPES, type Actor } from "./actor.ts";

/** The registry acting on its own behalf (Durable Objects, queue jobs, cron). */
export const SYSTEM_ACTOR: Actor = Object.freeze({
  kind: "user",
  subject: "system",
  name: "gitmatrix",
  email: null,
  scopes: new Set(ALL_SCOPES),
  tokenId: null,
  via: "session",
  isSiteAdmin: true,
}) as Actor;
