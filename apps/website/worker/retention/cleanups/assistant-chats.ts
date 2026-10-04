// Assistant chats (category "assistant-chats", CORE-204). Chats are a
// person's own, so an account's policy covers the chats of that account's
// person (organizations have none).
//
// Selects chats unused for `days` (by `updated_at`, which every turn touches
// first), and, with `maxPerUser` above 0, every chat beyond the newest
// `maxPerUser`. Removing one deletes its directory row (`assistant_chats`) and
// purges its Durable Object through the registry (`purgeIdleChat`), never a
// chat being written to: the row's delete re-checks the predicate, and the
// object refuses while a turn is in progress, in which case the row is put
// back as it was and the chat counts as kept. Cursor: the last chat id.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";
import { purgeIdleChat } from "../../durable/registry.ts";

interface Item {
  id: string;
  bytes: number;
}

interface Row {
  id: string;
  user_id: string;
  title: string;
  source: string;
  created_at: string;
  updated_at: string;
  bytes: number;
}

/** The directory row and the chat's object, as the registry last sized it. */
const size = (c: string) => `(96 + length(${c}id) + length(${c}title) + coalesce((
  SELECT storage_bytes FROM do_instances
  WHERE class = 'Assistant' AND name = ${c}user_id || ':' || ${c}id), 0))`;

/** Parameters: ?1 user, ?2 cutoff, ?3 chats kept per person (0: no cap). */
const MATCHES = `c.user_id = ?1 AND (c.updated_at < ?2 OR (?3 > 0 AND (
  SELECT count(*) FROM assistant_chats n
  WHERE n.user_id = c.user_id
    AND (n.updated_at > c.updated_at OR (n.updated_at = c.updated_at AND n.id > c.id))) >= ?3))`;

function scope(ctx: CleanupContext): [string, string, number] {
  if (ctx.target.scope !== "account") throw new Error("assistant-chats is an account category.");
  const { days, maxPerUser } = ctx.thresholds;
  if (days === undefined || maxPerUser === undefined)
    throw new Error("assistant-chats needs its days and maxPerUser thresholds.");
  return [ctx.target.accountId, daysBefore(ctx.now, days), maxPerUser];
}

/** Put a chat's row back as it was (a turn may have recreated it meanwhile). */
async function restore(d1: D1Database, row: Row) {
  await d1
    .prepare(
      `INSERT INTO assistant_chats (id, user_id, title, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = CASE WHEN assistant_chats.title = '' THEN excluded.title ELSE assistant_chats.title END,
         created_at = min(assistant_chats.created_at, excluded.created_at),
         updated_at = max(assistant_chats.updated_at, excluded.updated_at)`,
    )
    .bind(row.id, row.user_id, row.title, row.source, row.created_at, row.updated_at)
    .run();
}

export const assistantChats: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [user, cutoff, cap] = scope(ctx);
    const { results } = await ctx.env.DB.prepare(
      `SELECT c.id, ${size("c.")} AS bytes FROM assistant_chats c
       WHERE ${MATCHES} AND c.id > ?4 ORDER BY c.id LIMIT ?5`,
    )
      .bind(user, cutoff, cap, cursor ?? "", ctx.limit)
      .all<Item>();
    return {
      items: results,
      next: results.length < ctx.limit ? null : results.at(-1)!.id,
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [user, cutoff, cap] = scope(ctx);
    const { results } = await ctx.env.DB.prepare(
      `DELETE FROM assistant_chats AS c
       WHERE c.id IN (SELECT value FROM json_each(?4)) AND ${MATCHES}
       RETURNING id, user_id, title, source, created_at, updated_at, ${size("")} AS bytes`,
    )
      .bind(user, cutoff, cap, JSON.stringify(items.map((i) => i.id)))
      .all<Row>();
    let count = 0;
    let bytes = 0;
    for (const [index, row] of results.entries()) {
      let purged;
      try {
        purged = await purgeIdleChat(
          ctx.env,
          `${row.user_id}:${row.id}`,
          `retention: assistant chat unused for ${ctx.thresholds.days} days or over the cap`,
        );
      } catch (error) {
        // This chat and the ones not reached yet stay, rows and all; the run retries.
        for (const left of results.slice(index)) await restore(ctx.env.DB, left);
        throw error;
      }
      if (!purged) {
        await restore(ctx.env.DB, row);
        continue;
      }
      count++;
      bytes += row.bytes;
    }
    return { count, bytes };
  },
};
