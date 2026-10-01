import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";

export function fail(c: Context<AppEnv>, status: ContentfulStatusCode, error: string) {
  return c.json({ error }, status);
}

export function requireActor(c: Context<AppEnv>): Actor | Response {
  const actor = c.get("actor");
  return actor ?? fail(c, 401, "Sign in to do that.");
}

export async function readJson<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}
