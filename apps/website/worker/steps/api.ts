// Step context (CORE-231): what an agent attaches to a commit it makes at a
// meaningful step, stored per (change, commit) and read by anyone who can read
// the repository.
//
//   POST   /api/repos/:owner/:name/steps                       gm uploads one step (write access)
//   GET    /api/repos/:owner/:name/steps?timeline=&issue=&cursor=&limit=   newest first
//   GET    /api/repos/:owner/:name/steps/:changeId             every version of a change
//   DELETE /api/repos/:owner/:name/steps/:changeId/:commitOid  delete or redact (admins)
//
// A step is verified once a push has shown Gitmatrix its commit (here, at
// upload, or later in worker/ref-log/record.ts); until then it's reported as
// "local, unverified". Context is the agent's account, never rewritten: an
// amend or rebase is a new commit, so a new version of the change's context.

import { Hono, type Context } from "hono";
import type { Selectable } from "kysely";
import {
  EMPTY_CONTEXT,
  STEP_LIMITS,
  type ContextEntry,
  type ContextSource,
  type Step,
  type StepAuthor,
  type StepContextBody,
  type StepPage,
  type StepTest,
  type StepUpload,
  type StepVersions,
} from "../../shared/steps.ts";
import type { AppEnv } from "../auth.ts";
import { fail, requireActor } from "../api/http.ts";
import { loadRepo } from "../api/repos.ts";
import { avatarUrl } from "../avatars/api.ts";
import { sqlNow } from "../db.ts";
import { db, type Database } from "../schema.ts";

export const steps = new Hono<AppEnv>();

type Row = Selectable<Database["step_contexts"]>;

const CHANGE_ID = /^[a-z0-9]{8,64}$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;
const SOURCES: readonly ContextSource[] = ["hook", "agent", "person"];

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

function entries(value: unknown): ContextEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, STEP_LIMITS.entries).flatMap((entry): ContextEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const { text: body, source, at } = entry as Record<string, unknown>;
    if (typeof body !== "string" || !body.trim()) return [];
    return [
      {
        text: body,
        source: SOURCES.includes(source as ContextSource) ? (source as ContextSource) : "agent",
        ...(typeof at === "string" ? { at: at.slice(0, 40) } : {}),
      },
    ];
  });
}

function tests(value: unknown): StepTest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, STEP_LIMITS.entries).flatMap((test): StepTest[] => {
    if (!test || typeof test !== "object") return [];
    const t = test as Record<string, unknown>;
    if (typeof t.command !== "string" || typeof t.exit !== "number") return [];
    return [
      {
        command: t.command.slice(0, 1000),
        exit: Math.trunc(t.exit),
        summary: text(t.summary, 4000),
        ...(typeof t.durationMs === "number"
          ? { durationMs: Math.max(0, Math.trunc(t.durationMs)) }
          : {}),
        origin: t.origin === "local" ? "local" : "reported",
      },
    ];
  });
}

/** The context part of an upload, normalized; anything unexpected is dropped. */
export function normalizeContext(upload: Partial<StepContextBody>): StepContextBody {
  const coverage = (upload.coverage ?? {}) as Partial<StepContextBody["coverage"]>;
  return {
    instructions: entries(upload.instructions),
    steering: entries(upload.steering),
    why: text(upload.why, 20_000),
    challenges: text(upload.challenges, 20_000),
    tests: tests(upload.tests),
    coverage: {
      instructions: text(coverage.instructions, 100) || "none",
      steering: text(coverage.steering, 100) || "none",
    },
    harness: text(upload.harness, 100) || null,
    model: text(upload.model, 200) || null,
  };
}

/** Authors for these rows: agents with their accountable person, or people. */
async function authorsOf(d1: D1Database, rows: Row[]): Promise<Map<string, StepAuthor>> {
  const ids = [...new Set(rows.map((row) => row.author_id))];
  const people = [...new Set(rows.map((row) => row.accountable_id))];
  const k = db(d1);
  const [agents, accounts] = await Promise.all([
    ids.length
      ? k.selectFrom("agents").select(["id", "name"]).where("id", "in", ids).execute()
      : [],
    people.length
      ? k
          .selectFrom("accounts")
          .select(["id", "slug", "display_name", "avatar_key"])
          .where("id", "in", people)
          .execute()
      : [],
  ]);
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const authors = new Map<string, StepAuthor>();
  for (const row of rows) {
    const key = `${row.author_id}\n${row.accountable_id}`;
    if (authors.has(key)) continue;
    const person = accountById.get(row.accountable_id);
    const accountable = {
      id: row.accountable_id,
      slug: person?.slug ?? row.accountable_id,
      displayName: person?.display_name ?? "Unknown",
      avatarUrl: avatarUrl(person?.avatar_key ?? null),
    };
    const agent = agentName.get(row.author_id);
    authors.set(key, {
      id: row.author_id,
      kind: agent !== undefined ? "agent" : "person",
      name: agent ?? accountable.displayName,
      accountable,
    });
  }
  return authors;
}

function toStep(row: Row, authors: Map<string, StepAuthor>): Step {
  let context = EMPTY_CONTEXT;
  try {
    context = { ...EMPTY_CONTEXT, ...(JSON.parse(row.context) as Partial<StepContextBody>) };
  } catch {
    // A row that predates a field keeps the defaults.
  }
  return {
    changeId: row.change_id,
    commitOid: row.commit_oid,
    summary: row.summary,
    timeline: row.timeline,
    issue: row.issue_key,
    author: authors.get(`${row.author_id}\n${row.accountable_id}`)!,
    committedAt: row.committed_at,
    verified: row.verified_at !== null,
    deleted: row.deleted_at !== null,
    context: row.deleted_at ? EMPTY_CONTEXT : context,
  };
}

async function present(c: Context<AppEnv>, rows: Row[]) {
  const authors = await authorsOf(c.env.DB, rows);
  return rows.map((row) => toStep(row, authors));
}

/** Whether a push has shown this commit as this change (worker/ref-log). */
async function seen(d1: D1Database, repoId: string, changeId: string, oid: string) {
  const row = await db(d1)
    .selectFrom("change_refs")
    .select("ref")
    .where("repo_id", "=", repoId)
    .where("change_id", "=", changeId)
    .where((eb) => eb.or([eb("first_commit_oid", "=", oid), eb("last_commit_oid", "=", oid)]))
    .executeTakeFirst();
  return row !== undefined;
}

steps.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const loaded = await loadRepo(c, "write");
  if (loaded instanceof Response) return loaded;
  const repoId = loaded.row.id;
  const raw = await c.req.text();
  if (raw.length > STEP_LIMITS.contextBytes * 2)
    return fail(c, 413, "Keep a step's context under 256 KiB.");
  let upload: Partial<StepUpload>;
  try {
    upload = JSON.parse(raw) as Partial<StepUpload>;
  } catch {
    return fail(c, 400, "Send the step as JSON.");
  }
  if (!CHANGE_ID.test(upload.changeId ?? "")) return fail(c, 400, "changeId is a gm change ID.");
  if (!COMMIT_OID.test(upload.commitOid ?? ""))
    return fail(c, 400, "commitOid is a full commit hash.");
  const committedAt = Date.parse(upload.committedAt ?? "");
  if (Number.isNaN(committedAt)) return fail(c, 400, "committedAt is an ISO timestamp.");
  const context = JSON.stringify(normalizeContext(upload));
  if (new TextEncoder().encode(context).byteLength > STEP_LIMITS.contextBytes)
    return fail(c, 413, "Keep a step's context under 256 KiB.");

  const authorId = actor.agent?.id ?? actor.id;
  const changeId = upload.changeId!;
  const commitOid = upload.commitOid!;
  const existing = await db(c.env.DB)
    .selectFrom("step_contexts")
    .select(["author_id", "deleted_at"])
    .where("repo_id", "=", repoId)
    .where("change_id", "=", changeId)
    .where("commit_oid", "=", commitOid)
    .executeTakeFirst();
  if (existing && existing.author_id !== authorId)
    return fail(c, 409, "This step's context belongs to whoever made the commit.");
  if (existing?.deleted_at) return fail(c, 410, "This step's context was deleted.");

  const verified = await seen(c.env.DB, repoId, changeId, commitOid);
  const values = {
    repo_id: repoId,
    change_id: changeId,
    commit_oid: commitOid,
    author_id: authorId,
    accountable_id: actor.id,
    timeline: text(upload.timeline, 100) || null,
    issue_key: text(upload.issue, 50) || null,
    summary: text(upload.summary, STEP_LIMITS.summary),
    context,
    committed_at: new Date(committedAt).toISOString(),
  };
  // Uploads are retried: the same author sending again replaces its record.
  await db(c.env.DB)
    .insertInto("step_contexts")
    .values({ ...values, verified_at: verified ? sqlNow : null })
    .onConflict((oc) =>
      oc.columns(["repo_id", "change_id", "commit_oid"]).doUpdateSet({
        timeline: values.timeline,
        issue_key: values.issue_key,
        summary: values.summary,
        context: values.context,
        committed_at: values.committed_at,
        ...(verified ? { verified_at: sqlNow } : {}),
      }),
    )
    .execute();
  const row = await db(c.env.DB)
    .selectFrom("step_contexts")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("change_id", "=", changeId)
    .where("commit_oid", "=", commitOid)
    .executeTakeFirstOrThrow();
  const [step] = await present(c, [row]);
  return c.json(step, existing ? 200 : 201);
});

/** Opaque paging: the last step's (committedAt, changeId, commitOid). */
function encodeCursor(row: Row) {
  return btoa(JSON.stringify([row.committed_at, row.change_id, row.commit_oid]));
}
function decodeCursor(cursor: string): [string, string, string] | null {
  try {
    const value = JSON.parse(atob(cursor)) as unknown;
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "string")
      ? (value as [string, string, string])
      : null;
  } catch {
    return null;
  }
}

steps.get("/", async (c) => {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  const limitParam = c.req.query("limit");
  const limit = limitParam === undefined ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return fail(c, 400, "limit is a whole number from 1 to 100.");
  let query = db(c.env.DB)
    .selectFrom("step_contexts")
    .selectAll()
    .where("repo_id", "=", loaded.row.id);
  const timeline = c.req.query("timeline");
  if (timeline) query = query.where("timeline", "=", timeline);
  const issue = c.req.query("issue");
  if (issue) query = query.where("issue_key", "=", issue);
  const cursor = c.req.query("cursor");
  if (cursor) {
    const after = decodeCursor(cursor);
    if (!after) return fail(c, 400, "That cursor isn't one this list issued.");
    const [at, change, commit] = after;
    query = query.where((eb) =>
      eb.or([
        eb("committed_at", "<", at),
        eb.and([eb("committed_at", "=", at), eb("change_id", "<", change)]),
        eb.and([
          eb("committed_at", "=", at),
          eb("change_id", "=", change),
          eb("commit_oid", "<", commit),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy("committed_at", "desc")
    .orderBy("change_id", "desc")
    .orderBy("commit_oid", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const body: StepPage = {
    steps: await present(c, page),
    cursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
  };
  return c.json(body);
});

steps.get("/:changeId", async (c) => {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  const changeId = c.req.param("changeId");
  const rows = await db(c.env.DB)
    .selectFrom("step_contexts")
    .selectAll()
    .where("repo_id", "=", loaded.row.id)
    .where("change_id", "=", changeId)
    .orderBy("committed_at", "desc")
    .orderBy("commit_oid", "desc")
    .execute();
  if (!rows.length) return fail(c, 404, "No step for that change.");
  const body: StepVersions = { changeId, versions: await present(c, rows) };
  return c.json(body);
});

steps.delete("/:changeId/:commitOid", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { numUpdatedRows } = await db(c.env.DB)
    .updateTable("step_contexts")
    .set({ context: "{}", summary: "", deleted_at: sqlNow, deleted_by: actor.id })
    .where("repo_id", "=", loaded.row.id)
    .where("change_id", "=", c.req.param("changeId"))
    .where("commit_oid", "=", c.req.param("commitOid"))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!Number(numUpdatedRows)) return fail(c, 404, "No such step, or it's already deleted.");
  return c.body(null, 204);
});
