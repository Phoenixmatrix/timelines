// Stored step artifact images (CORE-383), in the STEP_ARTIFACTS bucket.

import { db } from "../schema.ts";

/** Keys checked per query, well under D1's bound-parameter limit. */
const KEYS_PER_QUERY = 50;

/** `step-artifacts/<repoId>/<runId>/<sha>.<ext>`: a key is only ever shared within one run. */
const KEY = /^step-artifacts\/[^/]+\/([^/]+)\/[^/]+$/;

/**
 * Deletes these objects unless a remaining row still points at them: one run
 * stores a picture once, however many names show it. Call it after the rows
 * that pointed at them are gone. The check is per run so it uses the run_id
 * index; object_key alone isn't indexed.
 */
export async function deleteUnreferenced(env: Env, keys: string[]): Promise<void> {
  const byRun = new Map<string, string[]>();
  for (const key of new Set(keys)) {
    const run = KEY.exec(key)?.[1];
    // Not a key this module wrote; leave it alone rather than guess.
    if (run) byRun.set(run, [...(byRun.get(run) ?? []), key]);
  }
  const gone: string[] = [];
  for (const [run, runKeys] of byRun) {
    for (let i = 0; i < runKeys.length; i += KEYS_PER_QUERY) {
      const chunk = runKeys.slice(i, i + KEYS_PER_QUERY);
      const used = await db(env.DB)
        .selectFrom("step_artifacts")
        .select("object_key")
        .where("run_id", "=", run)
        .where("object_key", "in", chunk)
        .execute();
      const kept = new Set(used.map((r) => r.object_key));
      gone.push(...chunk.filter((key) => !kept.has(key)));
    }
  }
  if (gone.length) await env.STEP_ARTIFACTS.delete(gone);
}
