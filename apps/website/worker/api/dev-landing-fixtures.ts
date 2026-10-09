import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { fail, readJson } from "./http.ts";
import { trackerObject } from "../tracker/stub.ts";
import { selectRepos } from "../db.ts";
import { LANDING_FIXTURE_POINTS, landingFixtureEnabled } from "../timelines/landing-fixture.ts";
import { LANDING_ACTIVE } from "../../shared/timelines.ts";
import { settled, progress } from "../timelines/landing.ts";

/** Mounted ONLY behind /api/dev's named-agent secret allowlist. */
export async function landingFixtures(c: Context<AppEnv>) {
  if (!landingFixtureEnabled(c.env)) return fail(c, 404, "Not found.");
  const input = await readJson<{
    slug: string;
    action: "arm" | "inspect" | "tick" | "release" | "delete";
    point?: string;
    repoId?: string;
    diagnostics?: boolean;
  }>(c);
  if (
    typeof input.slug !== "string" ||
    typeof input.action !== "string" ||
    !/^source-landing-[a-f0-9]{8}-[a-z-]+$/.test(input.slug) ||
    !["arm", "inspect", "tick", "release", "delete"].includes(input.action)
  )
    return fail(c, 400, "Invalid landing fixture.");
  const detail = await trackerObject(c.env, "acc_orbit").timeline(input.slug, 0, 1);
  if (!detail.ok) return fail(c, 404, "Fixture timeline not found.");
  const timeline = detail.value.timeline;
  if (
    timeline.repos.length !== 2 ||
    timeline.repos.some((repo) => repo.owner !== "orbit" || !/^queue-[a-f0-9]{8}$/.test(repo.name))
  )
    return fail(c, 400, "Only two disposable owned repositories are allowed.");
  const rows = await selectRepos(c.env.DB, "acc_marco")
    .where("r.owner_id", "=", "acc_orbit")
    .where(
      "r.id",
      "in",
      timeline.repos.map((repo) => repo.id),
    )
    .execute();
  if (rows.length !== 2) return fail(c, 404, "Fixture repositories are missing or deleted.");
  if (input.repoId !== undefined && !timeline.repos.some((repo) => repo.id === input.repoId))
    return fail(c, 400, "Invalid fixture repository.");
  await c.env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS dev_landing_barriers (timeline_id TEXT PRIMARY KEY, point TEXT NOT NULL, repo_id TEXT, hit INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0)",
  ).run();
  if (input.action === "arm") {
    if (!LANDING_FIXTURE_POINTS.some((point) => point === input.point))
      return fail(c, 400, "Invalid boundary.");
    await c.env.DB.prepare(
      "INSERT INTO dev_landing_barriers(timeline_id,point,repo_id) VALUES(?,?,?) ON CONFLICT(timeline_id) DO UPDATE SET point=excluded.point,repo_id=excluded.repo_id,hit=0,released=0",
    )
      .bind(timeline.id, input.point!, input.repoId ?? null)
      .run();
  } else if (input.action === "release") {
    await c.env.DB.prepare("UPDATE dev_landing_barriers SET released=1 WHERE timeline_id=?")
      .bind(timeline.id)
      .run();
  } else if (input.action === "delete") {
    await c.env.DB.prepare("DELETE FROM dev_landing_barriers WHERE timeline_id=?")
      .bind(timeline.id)
      .run();
  }
  const barrier = await c.env.DB.prepare(
    "SELECT point,repo_id,hit,released FROM dev_landing_barriers WHERE timeline_id=?",
  )
    .bind(timeline.id)
    .first();
  // Ledger identities come from the real Tracker landing, never supplied fixture successes.
  const current = await trackerObject(c.env, "acc_orbit").landing(timeline.slug);
  const landing = current.ok ? current.value : null;
  if (input.action === "tick" && landing && LANDING_ACTIVE.includes(landing.state)) {
    // Local development has no hourly cron. Drive the real recovery state
    // machine without restarting failed gates or manufacturing receipts.
    await settled(c.env, (deps) => progress(c.env, deps, "acc_orbit", landing));
  }
  const ledger =
    current.ok && current.value
      ? await c.env.DB.prepare(
          "SELECT id,landing_id,repo_id,source_commit,canonical_base,canonical_commit,status FROM source_integration_receipts WHERE landing_id=? ORDER BY repo_id",
        )
          .bind(current.value.id)
          .all()
      : { results: [] };
  if (input.action === "inspect" && input.diagnostics === true && landing) {
    const runs = await c.env.DB.prepare(
      "SELECT id,status,config_error,started_at,finished_at FROM ci_runs WHERE landing_id=?",
    )
      .bind(landing.id)
      .all<{ id: string }>();
    const jobs = await c.env.DB.prepare(
      "SELECT id,run_id,name,status,error,exit_code,claimed_by,source_completion_pending FROM ci_jobs WHERE run_id IN (SELECT id FROM ci_runs WHERE landing_id=?)",
    )
      .bind(landing.id)
      .all();
    const workflows = await Promise.all(
      runs.results.map(async ({ id }) => {
        try {
          return { id, ...(await (await c.env.CI_RUN.get(id)).status()) };
        } catch (error) {
          return { id, error: String(error) };
        }
      }),
    );
    return c.json({
      barrier,
      receipts: ledger.results,
      ci: { runs: runs.results, jobs: jobs.results, workflows },
    });
  }
  return c.json({ barrier, receipts: ledger.results });
}
