// The push log's API, per repository under /api/repos/:space/:name:
//   GET /ref-updates?ref=&before=   updates, newest first: one ref's (a full
//                                   name, or a branch or tag name) or all
//   GET /changes/:change            the refs a change reached, and when (a
//                                   change id, or an unambiguous prefix)

import { Hono } from "hono";
import type { InferResult } from "kysely";
import type { ChangeHistory, RefUpdate, RefUpdateList } from "../../shared/api.ts";
import { fail } from "../api/http.ts";
import { loadRepo, loadSourceRepo } from "../api/repos.ts";
import { isActorCredentialLive, type AppEnv } from "../auth.ts";
import { db, type DB } from "../schema.ts";
import { resumeMentionBackfill } from "../mentions/backfill.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";

const PAGE = 50;
const CHANGE_ID = /^[0-9a-z]{4,64}$/;

export const selectUpdates = (kdb: DB) =>
  kdb
    .selectFrom("ref_updates as u")
    .leftJoin("accounts as a", "a.id", "u.actor_id")
    .leftJoin("agents as g", "g.id", "u.agent_id")
    .selectAll("u")
    .select(["a.slug as actor", "g.name as agent"]);

type UpdateRow = InferResult<ReturnType<typeof selectUpdates>>[number];

export const toUpdate = (row: UpdateRow): RefUpdate => ({
  id: row.id,
  sourceId: row.source_id,
  ref: row.ref,
  old: row.old_oid,
  new: row.new_oid,
  forced: row.forced === null ? null : row.forced === 1,
  actor: row.actor,
  agent: row.agent,
  createdAt: row.created_at,
});

export const refLog = new Hono<AppEnv>();

refLog.get("/mention-backfill", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const actor = c.get("actor");
  if (!actor || !(await resolveSpaceAccess(c.env.DB, actor, repo.row.space_id)))
    return fail(c, 403, "Explicit Space access is required.");
  const k = db(c.env.DB);
  const done = await k
    .selectFrom("commit_mention_backfills")
    .select(["commits", "done_at"])
    .where("repo_id", "=", repo.row.id)
    .executeTakeFirst();
  if (done) return c.json({ state: "completed", ...done });
  const job = await k
    .selectFrom("mention_backfill_jobs")
    .select(["state", "error"])
    .where("repo_id", "=", repo.row.id)
    .executeTakeFirst();
  return c.json(job ?? { state: "blocked", error: "originating_authority_unavailable" });
});

refLog.post("/mention-backfill", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const actor = c.get("actor");
  if (!actor || !(await resolveSpaceAccess(c.env.DB, actor, repo.row.space_id)))
    return fail(c, 403, "Explicit Space access is required.");
  if (!(await isActorCredentialLive(c.env.DB, actor, "write")))
    return fail(c, 403, "A current write credential is required.");
  await resumeMentionBackfill(c.env, repo.row.id, actor);
  return c.json({ accepted: true }, 202);
});

refLog.get("/ref-updates", async (c) => {
  const repo = await loadSourceRepo(c, "read", true);
  if (repo instanceof Response) return repo;
  c.header("x-code-source-state", repo.expired ? "expired" : "available");
  const ref = c.req.query("ref")?.trim();
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  let query = selectUpdates(db(c.env.DB))
    .where("u.repo_id", "=", repo.row.id)
    .where("u.source_id", "=", repo.source.sourceId)
    .where("u.id", "<", before);
  if (ref) {
    query = query.where(
      "u.ref",
      "in",
      ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`],
    );
  }
  const rows = await query
    .orderBy("u.id", "desc")
    .limit(PAGE + 1)
    .execute();
  const updates = rows.slice(0, PAGE).map(toUpdate);
  return c.json<RefUpdateList>({
    updates,
    next: rows.length > PAGE ? (updates.at(-1)?.id ?? null) : null,
  });
});

refLog.get("/changes/:change", async (c) => {
  const repo = await loadSourceRepo(c, "read", true);
  if (repo instanceof Response) return repo;
  c.header("x-code-source-state", repo.expired ? "expired" : "available");
  const change = c.req.param("change").toLowerCase();
  if (!CHANGE_ID.test(change)) return fail(c, 400, "Invalid change id.");
  const rows = await selectUpdates(db(c.env.DB))
    .innerJoin("change_refs as m", "m.first_update_id", "u.id")
    .select([
      "m.change_id",
      "m.ref as reached_ref",
      "m.first_commit_oid",
      "m.first_seen_at",
      "m.last_commit_oid",
      "m.last_seen_at",
    ])
    .where("m.repo_id", "=", repo.row.id)
    .where("m.source_id", "=", repo.source.sourceId)
    // A prefix range the primary key serves ("{" sorts right after "z").
    .where("m.change_id", ">=", change)
    .where("m.change_id", "<", `${change}{`)
    .orderBy("m.first_seen_at")
    .orderBy("u.id")
    .execute();
  const ids = new Set(rows.map((r) => r.change_id));
  if (ids.size === 0) return fail(c, 404, `No change ${change} has reached a ref.`);
  if (ids.size > 1) return fail(c, 409, `${change} matches ${ids.size} changes; use more of it.`);
  return c.json<ChangeHistory>({
    sourceId: repo.source.sourceId,
    changeId: rows[0]!.change_id,
    refs: rows.map((row) => ({
      changeId: row.change_id,
      ref: row.reached_ref,
      firstCommit: row.first_commit_oid,
      firstSeenAt: row.first_seen_at,
      firstUpdate: toUpdate(row),
      lastCommit: row.last_commit_oid,
      lastSeenAt: row.last_seen_at,
    })),
  });
});
