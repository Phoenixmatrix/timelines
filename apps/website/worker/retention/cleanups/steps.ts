// Work context (CORE-244; PRD CORE-226, "Settings: retention").
//
// "step-steering": steps whose commit is more than `days` old keep their
// why, challenges, tests and coverage, but the text of their instructions and
// steering (the people's own words) becomes a placeholder, each entry's source
// kept. An item is a step still holding such text; its bytes are that text.
// Removing rewrites the context and marks it (`trimmedAt`), so a run again
// finds nothing. Deleted steps have no text to trim.
//
// "step-artifacts": what step runs produced (step_artifacts) more than `days`
// after the run. The step and the run stay. A screenshot's bytes are its stored
// image plus its row; removing it deletes the image from STEP_ARTIFACTS unless
// another artifact still shows it (CORE-383).
//
// Cursors: the last (repo, change, commit) key; the last artifact id.

import { TRIMMED_TEXT } from "../../../shared/steps.ts";
import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";
import { deleteUnreferenced } from "../../steps/objects.ts";

function scope(ctx: CleanupContext, id: string): [string, string] {
  if (ctx.target.kind !== "space") throw new Error(`${id} is a Space category.`);
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error(`${id} needs its days threshold.`);
  return [ctx.target.id, daysBefore(ctx.now, days)];
}

interface StepItem {
  key: string;
  repo_id: string;
  change_id: string;
  commit_oid: string;
  bytes: number;
}

/** Parameters: account, cutoff. `s` is the step. */
const STEERED = `s.repo_id IN (SELECT id FROM repos WHERE space_id = ?)
  AND s.committed_at < ? AND s.deleted_at IS NULL
  AND json_extract(s.context, '$.trimmedAt') IS NULL
  AND (coalesce(json_array_length(s.context, '$.instructions'), 0) > 0
       OR coalesce(json_array_length(s.context, '$.steering'), 0) > 0)`;

const KEY = `s.repo_id || ' ' || s.change_id || ' ' || s.commit_oid`;

export const stepSteering: CategoryCleanup<StepItem> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx, "step-steering");
    const { results } = await ctx.env.DB.prepare(
      `SELECT ${KEY} AS key, s.repo_id, s.change_id, s.commit_oid,
              length(CAST(coalesce(json_extract(s.context, '$.instructions'), '[]') AS BLOB))
            + length(CAST(coalesce(json_extract(s.context, '$.steering'), '[]') AS BLOB)) AS bytes
       FROM step_contexts s
       WHERE ${STEERED} AND ${KEY} > ? ORDER BY key LIMIT ?`,
    )
      .bind(account, cutoff, cursor ?? "", ctx.limit)
      .all<StepItem>();
    return {
      items: results,
      next: results.length < ctx.limit ? null : results.at(-1)!.key,
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx, "step-steering");
    const now = ctx.now.toISOString();
    // Each entry keeps its source and time; only its text goes.
    const trimmed = (path: string) =>
      `(SELECT json_group_array(json_set(value, '$.text', ?)) FROM json_each(s.context, '${path}'))`;
    const results = await ctx.env.DB.batch<{ bytes: number }>(
      items.map((item) =>
        ctx.env.DB.prepare(
          `UPDATE step_contexts AS s
           SET context = json_set(context,
             '$.instructions', json(${trimmed("$.instructions")}),
             '$.steering', json(${trimmed("$.steering")}),
             '$.trimmedAt', ?)
           WHERE s.repo_id = ? AND s.change_id = ? AND s.commit_oid = ? AND ${STEERED}
           RETURNING ? AS bytes`,
        ).bind(
          TRIMMED_TEXT,
          TRIMMED_TEXT,
          now,
          item.repo_id,
          item.change_id,
          item.commit_oid,
          account,
          cutoff,
          item.bytes,
        ),
      ),
    );
    const rows = results.flatMap((r) => r.results ?? []);
    return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  },
};

interface ArtifactItem {
  id: string;
  bytes: number;
}

/** Parameters: account, cutoff. `a` is the artifact. */
const OLD_ARTIFACT = `a.repo_id IN (SELECT id FROM repos WHERE space_id = ?) AND a.created_at < ?`;

export const stepArtifacts: CategoryCleanup<ArtifactItem> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx, "step-artifacts");
    const { results } = await ctx.env.DB.prepare(
      `SELECT a.id,
              length(CAST(a.data AS BLOB)) + iif(json_valid(a.data), coalesce(json_extract(a.data, '$.bytes'), 0), 0) AS bytes
       FROM step_artifacts a
       WHERE ${OLD_ARTIFACT} AND a.id > ? ORDER BY a.id LIMIT ?`,
    )
      .bind(account, cutoff, cursor ?? "", ctx.limit)
      .all<ArtifactItem>();
    return {
      items: results,
      next: results.length < ctx.limit ? null : results.at(-1)!.id,
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx, "step-artifacts");
    const { results } = await ctx.env.DB.prepare(
      `DELETE FROM step_artifacts AS a
       WHERE a.id IN (SELECT value FROM json_each(?)) AND ${OLD_ARTIFACT}
       RETURNING length(CAST(data AS BLOB)) + iif(json_valid(data), coalesce(json_extract(data, '$.bytes'), 0), 0) AS bytes,
                 object_key`,
    )
      .bind(JSON.stringify(items.map((i) => i.id)), account, cutoff)
      .all<{ bytes: number; object_key: string | null }>();
    const keys = results.flatMap((r) => (r.object_key ? [r.object_key] : []));
    // Rows go first (RETURNING hands back their keys in the same statement, so
    // there is no window to select them separately). If R2 then fails, the
    // images are orphaned: acceptable, because deleting the objects first
    // would leave rows pointing at nothing, and throwing here would rerun a
    // batch whose rows are already gone, wedging retention. The keys are logged.
    if (keys.length)
      try {
        await deleteUnreferenced(ctx.env, keys);
      } catch (error) {
        console.warn(
          `step-artifacts: ${keys.length} images left in the bucket (${String(error)}): ${keys.join(", ")}`,
        );
      }
    return { count: results.length, bytes: results.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
