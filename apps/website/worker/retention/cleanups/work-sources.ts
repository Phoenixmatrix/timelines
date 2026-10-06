import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";
import { expireArchivedSources, type SourceExpiryCutoffs } from "../work-sources.ts";
import { trackerObject } from "../../tracker/stub.ts";

function workSourceCutoffs(ctx: Pick<CleanupContext, "now" | "thresholds">): SourceExpiryCutoffs {
  const { landedDays, abandonedDays } = ctx.thresholds;
  if (landedDays === undefined || abandonedDays === undefined)
    throw new Error("timeline-work-sources needs landedDays and abandonedDays.");
  return { landed: daysBefore(ctx.now, landedDays), abandoned: daysBefore(ctx.now, abandonedDays) };
}

interface Candidate {
  timeline_id: string;
  source_id: string;
  state: string;
  archived_at: string | null;
  archive_disposition: "landed" | "abandoned" | null;
}

/** Owns only native work Git bytes; never consults rich Tracker retention pins. */
export const timelineWorkSources: CategoryCleanup<string> = {
  async select(ctx, cursor) {
    if (ctx.target.scope !== "account")
      throw new Error("timeline-work-sources is an account category.");
    const ownerId = ctx.target.accountId;
    const cutoffs = workSourceCutoffs(ctx);
    const page = await ctx.env.DB.prepare(`SELECT DISTINCT timeline_id FROM timeline_work_sources
      WHERE owner_id=? AND timeline_id>? AND state IN ('archived','purging')
      ORDER BY timeline_id LIMIT ?`)
      .bind(ownerId, cursor ?? "", ctx.limit)
      .all<{ timeline_id: string }>();
    if (!page.results.length) return { items: [], next: null, bytes: 0 };
    const ids = page.results.map((row) => row.timeline_id);
    const rows =
      await ctx.env.DB.prepare(`SELECT timeline_id,source_id,state,archived_at,archive_disposition
      FROM timeline_work_sources WHERE owner_id=? AND timeline_id IN (SELECT value FROM json_each(?))`)
        .bind(ownerId, JSON.stringify(ids))
        .all<Candidate>();
    const eligible = new Set(ids);
    let count = 0;
    const counts = new Map<string, number>();
    for (const source of rows.results) {
      if (source.state === "purged") continue;
      counts.set(source.timeline_id, (counts.get(source.timeline_id) ?? 0) + 1);
      if (source.state === "purging") continue;
      if (source.state !== "archived") {
        eligible.delete(source.timeline_id);
        continue;
      }
      // A dry run reads legacy evidence without projecting or fencing anything.
      if (!source.archive_disposition) {
        const reply = await trackerObject(ctx.env, ownerId).getWorkSource(source.source_id);
        if (!reply.ok) throw new Error(reply.error);
        if (reply.value.timeline_id !== source.timeline_id || reply.value.owner_id !== ownerId)
          throw new Error("Source archive ownership mismatch.");
        source.archive_disposition = reply.value.archive_disposition;
        source.archived_at = reply.value.archived_at;
      }
      if (
        !source.archive_disposition ||
        !source.archived_at ||
        source.archived_at >= cutoffs[source.archive_disposition]
      )
        eligible.delete(source.timeline_id);
    }
    const items = ids.filter((id) => eligible.has(id));
    for (const id of items) count += counts.get(id) ?? 0;
    return { items, next: ids.at(-1)!, count, bytes: 0 };
  },
  async remove(ctx, items) {
    if (ctx.target.scope !== "account")
      throw new Error("timeline-work-sources is an account category.");
    if (!items.length) return { count: 0, bytes: 0 };
    const ownerId = ctx.target.accountId;
    const remaining = async () =>
      (await ctx.env.DB.prepare(`SELECT count(*) AS n FROM timeline_work_sources
      WHERE owner_id=? AND timeline_id IN (SELECT value FROM json_each(?)) AND state!='purged'`)
        .bind(ownerId, JSON.stringify(items))
        .first<number>("n")) ?? 0;
    const before = await remaining();
    await expireArchivedSources(ctx.env, ownerId, workSourceCutoffs(ctx), items);
    return { count: before - (await remaining()), bytes: 0 };
  },
};
