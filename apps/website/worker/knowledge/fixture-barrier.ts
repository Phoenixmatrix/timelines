import type { WorkflowStep } from "cloudflare:workers";

export function knowledgeFixtureEnabled(env: Env): boolean {
  const id = Reflect.get(env, "AGENT_ID");
  return Reflect.get(env, "DEV_MODE") === "true" && typeof id === "string" && id.trim().length > 0;
}

/** Only an explicitly armed disposable source pauses; no fabricated provider result. */
export async function knowledgeFixtureBarrier(
  env: Env,
  step: WorkflowStep,
  sourceId: string,
  buildId: string,
) {
  if (!knowledgeFixtureEnabled(env)) return;
  const exists = await env.DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dev_knowledge_barriers'",
  ).first();
  if (!exists) return;
  const barrier = await env.DB.prepare(
    "UPDATE dev_knowledge_barriers SET build_id=? WHERE source_id=? AND released=0 RETURNING source_id",
  )
    .bind(buildId, sourceId)
    .first();
  if (!barrier) return;
  for (let attempt = 0; attempt < 240; attempt++) {
    const current = await env.DB.prepare(
      "SELECT released FROM dev_knowledge_barriers WHERE source_id=?",
    )
      .bind(sourceId)
      .first<{ released: number }>();
    if (!current || current.released) return;
    await step.sleep(`fixture-publication-${attempt}`, "5 seconds");
  }
  throw new Error("Owned knowledge fixture publication barrier timed out");
}
