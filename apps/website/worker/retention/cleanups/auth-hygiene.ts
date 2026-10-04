// Auth hygiene (site category "auth-hygiene", CORE-206): sign-in state that
// ended more than `days` before the run's moment. Each table's own expiry:
// - auth_sessions (`expiresAt`): expired sign-in sessions;
// - auth_verifications (`expiresAt`): emailed sign-in codes;
// - auth_device_codes (`expiresAt`): `gm auth login` device codes;
// - auth_lockouts (`until`): lockouts after repeated failures;
// - ssh_challenges (`expires_at`): SSH sign-in challenges;
// - access_tokens (`expires_at`): expired tokens (a revoked token is deleted
//   when it's revoked; a token without an expiry never expires);
// - ci_job_tokens (`expires_at`): CI jobs' registry tokens.
// Never: anything still valid (the cutoff is at least a day in the past, so a
// live session, an unexpired token or an active lockout can't match).
//
// Tables in order; an item is one row. Cursor: "<table index> <key>". Each
// table's predicate serves both its select and its remove.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Table {
  name: string;
  key: string;
  ends: string;
  /** Estimated stored size of a row, its columns unqualified. */
  bytes: string;
}

export const AUTH_TABLES: readonly Table[] = [
  {
    name: "auth_sessions",
    key: "id",
    ends: "expiresAt",
    bytes: `120 + length(id) + length(token) + length(userId)
      + coalesce(length(ipAddress), 0) + coalesce(length(userAgent), 0)`,
  },
  {
    name: "auth_verifications",
    key: "id",
    ends: "expiresAt",
    bytes: "100 + length(id) + length(identifier) + length(value)",
  },
  {
    name: "auth_device_codes",
    key: "id",
    ends: "expiresAt",
    bytes: `100 + length(id) + length(deviceCode) + length(userCode)
      + coalesce(length(userId), 0) + coalesce(length(clientId), 0) + coalesce(length(scope), 0)`,
  },
  { name: "auth_lockouts", key: "key", ends: "until", bytes: "40 + length(key)" },
  {
    name: "ssh_challenges",
    key: "nonce",
    ends: "expires_at",
    bytes: "40 + length(nonce) + length(key_id) + length(origin)",
  },
  {
    name: "access_tokens",
    key: "id",
    ends: "expires_at",
    bytes: `120 + length(id) + length(user_id) + length(name) + length(token_hash)
      + coalesce(length(ssh_key_id), 0) + coalesce(length(agent_id), 0)`,
  },
  {
    name: "ci_job_tokens",
    key: "token_hash",
    ends: "expires_at",
    bytes: "40 + length(token_hash) + length(job_id)",
  },
];

interface Item {
  table: number;
  key: string;
  bytes: number;
}

function cutoff(ctx: CleanupContext): string {
  if (ctx.target.scope !== "site") throw new Error("auth-hygiene is a site category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("auth-hygiene needs its days threshold.");
  return daysBefore(ctx.now, days);
}

/** Rows of `t` that ended before the cutoff (the only parameter). */
const ended = (t: Table) => `${t.ends} IS NOT NULL AND ${t.ends} < ?`;

export const authHygiene: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const before = cutoff(ctx);
    const space = cursor?.indexOf(" ") ?? -1;
    const index = cursor ? Number(cursor.slice(0, space)) : 0;
    const after = cursor ? cursor.slice(space + 1) : "";
    const table = AUTH_TABLES[index];
    if (!table) return { items: [], next: null, bytes: 0 };
    const { results } = await ctx.env.DB.prepare(
      `SELECT ${table.key} AS key, ${table.bytes} AS bytes FROM ${table.name}
       WHERE ${ended(table)} AND ${table.key} > ? ORDER BY ${table.key} LIMIT ?`,
    )
      .bind(before, after, ctx.limit)
      .all<{ key: string; bytes: number }>();
    const last = results.at(-1);
    const next =
      results.length === ctx.limit && last
        ? `${index} ${last.key}`
        : index + 1 < AUTH_TABLES.length
          ? `${index + 1} `
          : null;
    return {
      items: results.map((r) => ({ table: index, ...r })),
      next,
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const before = cutoff(ctx);
    const rows: { bytes: number }[] = [];
    for (const [index, table] of AUTH_TABLES.entries()) {
      const keys = items.filter((i) => i.table === index).map((i) => i.key);
      if (!keys.length) continue;
      const { results } = await ctx.env.DB.prepare(
        `DELETE FROM ${table.name}
         WHERE ${table.key} IN (SELECT value FROM json_each(?)) AND ${ended(table)}
         RETURNING ${table.bytes} AS bytes`,
      )
        .bind(JSON.stringify(keys), before)
        .all<{ bytes: number }>();
      rows.push(...results);
    }
    return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
