import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";

export function fail(c: Context<AppEnv>, status: ContentfulStatusCode, error: string) {
  return c.json({ error }, status);
}

/**
 * An error as a log line can show it: its name, message and code as well as
 * the stack. Logged bare, an Artifacts RPC error showed only stack frames, so a
 * production 500 said where it failed but not why (CORE-309).
 */
export function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(code !== undefined ? { code } : {}),
    stack: error.stack,
  };
}

export function requireActor(c: Context<AppEnv>): Actor | Response {
  const actor = c.get("actor");
  return actor ?? fail(c, 401, "Sign in to do that.");
}

/** Signed in as a person, not as one of their agents: for managing credentials and agents. */
export function requirePerson(c: Context<AppEnv>): Actor | Response {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  return actor.agent ? fail(c, 403, "Agents can't do that; sign in as their person.") : actor;
}

export async function readJson<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}
