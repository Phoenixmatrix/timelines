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

/** Durable stop at a real boundary. No provider result or receipt is fabricated.
 * Once hit, every competing progress invocation stays stopped until explicit release.
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
    "SELECT hit FROM dev_landing_barriers WHERE timeline_id=? AND released=0",
  )
    .bind(landing.timelineId)
    .first<{ hit: number }>();
  return barrier?.hit === 1;
}
