export const SOURCE_PUSH_FIXTURE_POINTS = [
  "before-provider",
  "before-forward",
  "after-provider",
  "after-recovery-fence",
] as const;
export type SourcePushFixturePoint = (typeof SOURCE_PUSH_FIXTURE_POINTS)[number];

export function sourcePushFixtureEnabled(env: Env): boolean {
  const id = Reflect.get(env, "AGENT_ID");
  return Reflect.get(env, "DEV_MODE") === "true" && typeof id === "string" && !!id.trim();
}

/** One invocation stops at a real boundary; a concurrent recovery may proceed.
 * Only the named-development fixture endpoint can arm a disposable source.
 * No provider result or source-operation outcome is manufactured here.
 */
export async function sourcePushFixtureBoundary(
  env: Env,
  repoId: string,
  sourceId: string,
  operationId: string,
  point: SourcePushFixturePoint,
): Promise<void> {
  if (!sourcePushFixtureEnabled(env)) return;
  const exists = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dev_source_push_barriers'",
  ).first();
  if (!exists) return;
  const held = await env.DB.prepare(
    "UPDATE dev_source_push_barriers SET hit=1,operation_id=? WHERE repo_id=? AND source_id=? AND point=? AND hit=0 AND released=0 RETURNING nonce,mode",
  )
    .bind(operationId, repoId, sourceId, point)
    .first<{ nonce: string; mode: "hold" | "fail" }>();
  if (!held) return;
  if (held.mode === "fail") throw new Error(`Source push fixture interrupted ${point}.`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = await env.DB.prepare(
      "SELECT nonce,released FROM dev_source_push_barriers WHERE source_id=?",
    )
      .bind(sourceId)
      .first<{ nonce: string; released: number }>();
    if (!current || current.nonce !== held.nonce || current.released === 1) return;
    if (Date.now() >= deadline) throw new Error(`Source push fixture timed out at ${point}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}
