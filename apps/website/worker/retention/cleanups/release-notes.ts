// Release notes (category "release-notes", CORE-206): an account's release
// notes released more than `days` before the run's moment, with their entries
// and the issue mentions only they cited.
//
// Never: each repository's latest release (newest `released_at`, then name)
// of each kind, daily and tagged, whatever its age. Removing a repository's notes records the cutoff in
// `release_note_state.retained_from`, so the generator never writes notes for
// an older release again (it would pay a model to rebuild what the policy
// removed; worker/release-notes/generate.ts). A mention goes when no
// remaining entry cites its issue; the next generation recomputes the rest
// from the releases it keeps.
//
// An item is one release; its count is the note and its entries. One SQL
// predicate serves both select and remove. Cursor: "<repo id> <release>"
// (repository ids have no spaces).

import { DAILY_RELEASE_PREFIX } from "../../../shared/release-notes.ts";
import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  repo: string;
  release: string;
  rows: number;
  bytes: number;
}

/** Parameters: account id, cutoff. `r` is the release's note. */
const MATCHES = `r.repo_id IN (SELECT id FROM repos WHERE owner_id = ?)
  AND r.released_at < ?
  AND EXISTS (SELECT 1 FROM release_notes n WHERE n.repo_id = r.repo_id
              AND (n.release LIKE '${DAILY_RELEASE_PREFIX}%') = (r.release LIKE '${DAILY_RELEASE_PREFIX}%')
              AND (n.released_at > r.released_at
                   OR (n.released_at = r.released_at AND n.release > r.release)))`;

const ENTRIES = `FROM release_note_entries e WHERE e.repo_id = r.repo_id AND e.release = r.release`;

/** A release's rows (its note and entries) and their estimated bytes. */
const SIZE = `1 + (SELECT count(*) ${ENTRIES}) AS rows,
  200 + length(r.release) + length(r.intro) + length(r.intro_trackers)
    + coalesce((SELECT sum(200 + length(e.subject) + length(e.title) + length(e.summary)
                           + length(e.labels) + length(e.commits) + length(e.changes)) ${ENTRIES}), 0)
  AS bytes`;

/** The items of a `json_each` parameter that still match, as `r`. */
const CHOSEN = `FROM release_notes r
  WHERE (r.repo_id, r.release) IN
        (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
    AND ${MATCHES}`;

function scope(ctx: CleanupContext): [string, string] {
  if (ctx.target.scope !== "account") throw new Error("release-notes is an account category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("release-notes needs its days threshold.");
  return [ctx.target.accountId, daysBefore(ctx.now, days)];
}

export const releaseNotes: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx);
    const space = cursor?.indexOf(" ") ?? -1;
    const [repo, release] =
      cursor && space > 0 ? [cursor.slice(0, space), cursor.slice(space + 1)] : ["", ""];
    const { results } = await ctx.env.DB.prepare(
      `SELECT r.repo_id AS repo, r.release, ${SIZE} FROM release_notes r
       WHERE ${MATCHES} AND (r.repo_id, r.release) > (?, ?)
       ORDER BY r.repo_id, r.release LIMIT ?`,
    )
      .bind(account, cutoff, repo, release, ctx.limit)
      .all<Item>();
    const last = results.at(-1);
    return {
      items: results,
      next: results.length < ctx.limit || !last ? null : `${last.repo} ${last.release}`,
      count: results.reduce((sum, r) => sum + r.rows, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    if (!items.length) return { count: 0, bytes: 0 };
    const [account, cutoff] = scope(ctx);
    const keys = JSON.stringify(items.map((i) => [i.repo, i.release]));
    const bind = [keys, account, cutoff] as const;
    // One transaction: measure what still matches, remember the horizon,
    // drop mentions only those releases cite, then entries and notes.
    const [sizes, , , , deleted] = await ctx.env.DB.batch<{
      repo: string;
      release: string;
      rows: number;
      bytes: number;
    }>([
      ctx.env.DB.prepare(`SELECT r.repo_id AS repo, r.release, ${SIZE} ${CHOSEN}`).bind(...bind),
      ctx.env.DB.prepare(
        `INSERT INTO release_note_state (repo_id, retained_from)
         SELECT DISTINCT r.repo_id, ? ${CHOSEN}
         ON CONFLICT (repo_id) DO UPDATE SET retained_from =
           CASE WHEN retained_from IS NULL OR retained_from < excluded.retained_from
                THEN excluded.retained_from ELSE retained_from END`,
      ).bind(cutoff, ...bind),
      ctx.env.DB.prepare(
        `DELETE FROM release_note_mentions AS m
         WHERE EXISTS (SELECT 1 FROM release_note_entries e
                       WHERE e.repo_id = m.repo_id AND e.issue_key = m.issue_key
                         AND (e.repo_id, e.release) IN (SELECT r.repo_id, r.release ${CHOSEN}))
           AND NOT EXISTS (SELECT 1 FROM release_note_entries e
                           WHERE e.repo_id = m.repo_id AND e.issue_key = m.issue_key
                             AND (e.repo_id, e.release) NOT IN (SELECT r.repo_id, r.release ${CHOSEN}))`,
      ).bind(...bind, ...bind),
      ctx.env.DB.prepare(
        `DELETE FROM release_note_entries
         WHERE (repo_id, release) IN (SELECT r.repo_id, r.release ${CHOSEN})`,
      ).bind(...bind),
      ctx.env.DB.prepare(
        `DELETE FROM release_notes AS d
         WHERE (d.repo_id, d.release) IN (SELECT r.repo_id, r.release ${CHOSEN})
         RETURNING repo_id AS repo, release`,
      ).bind(...bind),
    ]);
    const gone = new Set((deleted?.results ?? []).map((r) => `${r.repo} ${r.release}`));
    const removed = (sizes?.results ?? []).filter((r) => gone.has(`${r.repo} ${r.release}`));
    return {
      count: removed.reduce((sum, r) => sum + r.rows, 0),
      bytes: removed.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
};
