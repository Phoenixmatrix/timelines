import type { Landing } from "../../shared/timelines.ts";

export const LANDING_FIXTURE_POINTS = [
  "prepared",
  "before-cas",
  "after-cas",
  "after-receipt",
  "before-finalize",
] as const;
export type LandingFixturePoint = (typeof LANDING_FIXTURE_POINTS)[number];

export function landingFixtureEnabled(env: Env): boolean {
  const id = Reflect.get(env, "AGENT_ID");
  return Reflect.get(env, "DEV_MODE") === "true" && typeof id === "string" && !!id.trim();
}

/**
 * Whether the barrier had been hit when each step began: the step's first,
 * pointless check records it (CORE-307).
 */
const hitOnEntry = new WeakMap<Landing, boolean>();

/** Durable stop at a real boundary. No provider result or receipt is fabricated.
 * Once hit, every competing progress invocation stays stopped until explicit release,
 * and a step that began before the hit stays stopped after it: what it read may
 * predate the change the fixture makes while holding (a rewritten main).
 * Production and non-fixture timelines return before any storage access.
 */
export async function landingFixtureBarrier(
  env: Env,
  landing: Landing,
  point?: LandingFixturePoint,
  repoId?: string,
): Promise<boolean> {
  if (
    !landingFixtureEnabled(env) ||
    !/^source-landing-[a-f0-9]{8}-[a-z-]+$/.test(landing.slug) ||
    landing.repos.length !== 2 ||
    landing.repos.some((repo) => repo.owner !== "orbit" || !/^queue-[a-f0-9]{8}$/.test(repo.name))
  )
    return false;
  const exists = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dev_landing_barriers'",
  ).first();
  if (!exists) return false;
  if (point)
    await env.DB.prepare(
      "UPDATE dev_landing_barriers SET hit=1 WHERE timeline_id=? AND point=? AND (repo_id IS NULL OR repo_id=?) AND released=0",
    )
      .bind(landing.timelineId, point, repoId ?? null)
      .run();
  const barrier = await env.DB.prepare(
    "SELECT hit,released FROM dev_landing_barriers WHERE timeline_id=?",
  )
    .bind(landing.timelineId)
    .first<{ hit: number; released: number }>();
  const hit = barrier?.hit === 1;
  if (!point) hitOnEntry.set(landing, hit);
  return hit && (barrier.released === 0 || hitOnEntry.get(landing) === false);
}
